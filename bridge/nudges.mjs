// Nudges: Colin watches a turn and picks the option he would have chosen. This module decides
// whether a nudge may go ahead, freezes the moment it was made in, and finds past nudges that
// look like the current situation so they can go into the prompt. No I/O: pz-bridge.mjs reads the
// request, calls planNudge, and writes the record. docs/brain.md and docs/eval.md describe it.

import { needs, isNight, inside, chasing, holdReason, isAsleep } from './senses.mjs';

export const MAX_WHY = 300;
export const MAX_MISSING = 300;
export const MAX_BODY = 16 * 1024;
export const MAX_FRESH_MS = 15_000;
// Past nudges kept in memory for the prompt examples. The file keeps all of them.
export const MAX_INDEX = 200;
export const MAX_EXAMPLES = 2;
const MAX_EXAMPLE_WHY = 120;
const MAX_EXAMPLE_LABEL = 70;
// A past nudge is only an example when its needs overlap this much with now.
const MIN_NEED_OVERLAP = 0.5;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Whatever the person typed, on one line and no longer than max.
const tidy = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The most pressing need names the situation in reports. 'night outside' is left out of the
// need list because the place and the time already say it.
const NEED_ORDER = ['bleeding', 'wounded', 'thirsty', 'hungry', 'exhausted', 'tired', 'panicked', 'winded', 'heavy'];

export function situationOf(p) {
  const list = [...needs(p)].filter((n) => n !== 'night outside');
  list.sort((a, b) => NEED_ORDER.indexOf(a) - NEED_ORDER.indexOf(b));
  return {
    where: inside(p) ? 'inside' : 'outside',
    time: isNight(p) ? 'night' : 'day',
    chased: chasing(p) > 0,
    needs: list,
  };
}

// The same, from the small percept copy the decision log keeps (decisions.mjs compactPercept).
export function situationOfCompact(cp) {
  const c = cp && typeof cp === 'object' ? cp : {};
  const hour = Number(c.hour);
  const list = (Array.isArray(c.needs) ? c.needs : []).filter((n) => n !== 'night outside');
  list.sort((a, b) => NEED_ORDER.indexOf(a) - NEED_ORDER.indexOf(b));
  return {
    where: c.inside ? 'inside' : 'outside',
    time: Number.isFinite(hour) && (hour >= 21 || hour < 6) ? 'night' : 'day',
    chased: !!(c.z && Number(c.z.chasing) > 0),
    needs: list,
  };
}

export function situationLabel(s) {
  return [s.where, s.time, s.chased ? 'chased' : 'not chased', s.needs[0] || 'no urgent need'].join(', ');
}

// ---- the request ----

// text is the raw request body. Returns { ok: true, mode, turn, pick, missing, why } or { ok: false, message }.
export function parseNudgeBody(text) {
  let b;
  try {
    b = JSON.parse(String(text));
  } catch {
    return { ok: false, message: 'The request was not JSON.' };
  }
  if (!isObj(b)) return { ok: false, message: 'The request was not an object.' };
  if (b.mode !== 'now' && b.mode !== 'log') return { ok: false, message: 'Mode must be "now" or "log".' };
  if (b.pick != null && typeof b.pick !== 'string') return { ok: false, message: 'The pick must be an option id.' };
  const pick = tidy(b.pick, 24);
  const missing = tidy(b.missing, MAX_MISSING);
  const why = tidy(b.why, MAX_WHY);
  const turn = typeof b.turn === 'number' && Number.isInteger(b.turn) ? b.turn : null;
  if (!pick && !missing) return { ok: false, message: 'Pick an option, or say what is missing.' };
  if (b.mode === 'now' && !pick) return { ok: false, message: '"Do it now" needs an option from the menu.' };
  return { ok: true, mode: b.mode, turn, pick, missing, why };
}

const refuse = (status, message) => ({ ok: false, status, message });

// body: what parseNudgeBody returned. ctx:
//   snapshots   recent menus the page could have shown, newest last: { serial, percept, menu, choice,
//               by, rule, thought, kind, memory, plan }
//   percept, perceptAt, map   the live senses and map memory, for the checks "Do it now" needs
//   now, run    wall clock and the run id from stats
//   resolve     (menu, id) => the option to send, or null when that job is already running
// Returns { ok: false, status, message } to refuse, or { ok: true, record, order } where order is the
// option to send (mode "now") or null (mode "log"). The decision belongs here, not in the HTTP code.
export function planNudge(body, ctx) {
  const snaps = Array.isArray(ctx.snapshots) ? ctx.snapshots : [];
  const latest = snaps[snaps.length - 1];
  if (!latest) return refuse(409, 'No menu has been offered yet. Wait for her next turn.');
  const snap = body.turn === null ? latest : snaps.find((s) => s.serial === body.turn);
  if (!snap) return refuse(409, 'That menu is gone. Look at the new one and pick again.');
  const option = body.pick ? snap.menu.find((o) => o.id === body.pick) : null;
  if (body.pick && !option) return refuse(400, `"${body.pick}" is not on that menu.`);

  if (body.mode === 'now') {
    const p = ctx.percept;
    if (!isObj(p) || p.dead || ctx.now - ctx.perceptAt > MAX_FRESH_MS) return refuse(409, 'No live senses from the game. Nothing was sent.');
    if (snap !== latest) return refuse(409, 'The menu changed since you looked. Pick again.');
    const hold = holdReason(p);
    if (hold) return refuse(409, `The reflex owns this moment (${hold}). Nothing was sent.`);
    if (isAsleep(p, ctx.map)) return refuse(409, 'She is asleep, and an order would wake her. Nothing was sent.');
    if (!option.verb) return refuse(400, '"keep" sends nothing. Use "Just log it" to record it.');
    // Sending the job that is already running would restart it.
    if (ctx.resolve && !ctx.resolve(snap.menu, option.id)) return refuse(409, 'She is already doing that. Nothing was sent.');
  }

  const brain = snap.menu.find((o) => o.id === snap.choice) || null;
  const record = {
    t: 'nudge', at: new Date(ctx.now).toISOString(), run: ctx.run || null, mode: body.mode, applied: body.mode === 'now',
    pick: option ? option.id : null, pickKey: option ? option.key || null : null, pickVerb: option ? option.verb || null : null,
    pickLabel: option ? String(option.label || '').slice(0, 160) : null,
    missing: body.missing, why: body.why,
    brain: { id: snap.choice || null, key: brain ? brain.key || null : null, verb: brain ? brain.verb || null : null, by: snap.by || '', rule: snap.rule || null, thought: String(snap.thought || '').slice(0, 200) },
    situation: situationLabel(situationOf(snap.percept)),
    menu: snap.menu, percept: snap.percept, memory: snap.memory || null, plan: snap.plan || null,
  };
  return { ok: true, record, order: body.mode === 'now' ? option : null };
}

// The day plan, cut down to what the menu builder reads.
export function planSlice(plan) {
  if (!isObj(plan) || typeof plan.goal !== 'string') return null;
  return {
    goal: plan.goal.slice(0, 200),
    steps: (Array.isArray(plan.steps) ? plan.steps : []).filter((s) => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 200)),
    home: plan.home == null ? null : String(plan.home),
  };
}

// ---- examples for the prompt ----

// On by default only if it costs under 150 ms a turn (docs/brain.md has the measurement).
export const EXAMPLES_DEFAULT = true;

export function examplesEnabled(env = process.env) {
  const v = String(env.PZ_EXAMPLES ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return EXAMPLES_DEFAULT;
}

// The nudges worth quoting: a real pick, with a percept to compare against. The situation is
// worked out once here, so choosing examples each turn is a short loop.
export function indexNudges(records) {
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObj(r) || r.t !== 'nudge' || !r.pickKey || !isObj(r.percept)) continue;
    out.push(indexOne(r));
  }
  return out.slice(-MAX_INDEX);
}

export function indexOne(r) {
  return {
    key: String(r.pickKey), why: tidy(r.why, MAX_EXAMPLE_WHY), at: String(r.at || ''),
    agreed: !!(r.brain && r.brain.key && r.brain.key === r.pickKey), sit: situationOf(r.percept),
  };
}

// Share of needs in common, 1 when neither has any.
function overlap(a, b) {
  if (!a.length && !b.length) return 1;
  const set = new Set(a);
  const shared = b.filter((n) => set.has(n)).length;
  return shared / (a.length + b.length - shared);
}

// Up to `limit` past nudges for a situation like this one: same place (inside or out), same time
// of day, same chased or not, and needs that mostly match. Only a pick that is on today's menu
// can be quoted. Ones where Colin disagreed with the brain come first, then ones with a reason,
// then the newest.
export function pickExamples(index, p, options, limit = MAX_EXAMPLES) {
  if (!Array.isArray(index) || !index.length || !Array.isArray(options) || !isObj(p)) return [];
  const now = situationOf(p);
  const scored = [];
  for (const n of index) {
    const s = n.sit;
    if (s.where !== now.where || s.time !== now.time || s.chased !== now.chased) continue;
    const near = overlap(s.needs, now.needs);
    if (near < MIN_NEED_OVERLAP) continue;
    const option = options.find((o) => o.key === n.key && o.verb);
    if (!option) continue;
    scored.push({ option, why: n.why, agreed: n.agreed, at: n.at, score: near + (n.agreed ? 0 : 0.5) + (n.why ? 0.1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const seen = new Set();
  const out = [];
  for (const c of scored) {
    const dedupe = `${c.option.id}|${c.why}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

export function exampleLines(picks) {
  return picks.map((c) => {
    const label = String(c.option.label || '').slice(0, MAX_EXAMPLE_LABEL);
    return `In a similar spot, the better pick was ${c.option.id} (${label})${c.why ? ` because ${c.why.replace(/[.!?]+$/, '')}` : ''}.`;
  });
}
