// The peanut gallery. A second local model (a meme model) reacts to what happens in the game, for fun.
// It is commentary only: nothing here decides anything, writes an order, or goes into the brain's
// prompt. Lines go to pepe.log and to the panel on /mind, and nowhere else.
//
//   percept + order history + plan --> detectMoments --> pending events
//        pending --- at most one per 30 s, never while the model is busy ---> ask --> line --> log + panel
//
// The only things this module is given are read-only copies of what the bridge already knows.
// Nothing it returns is read by brain.mjs, planner.mjs or the order line (commentator.test.mjs checks).

import { LOOP_MS } from './reactions.mjs';
import { isMissingModel } from './llm.mjs';

export const MIN_GAP_MS = 30_000;
// A moment that is not said within this long is stale, and the next one is more interesting.
export const EXPIRE_MS = 45_000;
// A death comment waits for a free model, but not forever.
export const DEATH_EXPIRE_MS = 10 * 60_000;
export const LINE_MAX = 240;
export const PANEL_LINES = 10;
export const HP_DROP = 8;
export const NEAR_DEATH_HP = 25;
const NEAR_DEATH_REARM = 50;
const MAX_PENDING = 12;
const MAX_EVENT_TEXT = 200;

// How much each kind of moment is worth saying. The heaviest pending one is spoken.
export const WEIGHT = {
  death: 100, nearDeath: 80, hpDrop: 70, bleeding: 60, loop: 55, failed: 45, kill: 40, weapon: 35,
  secured: 32, entered: 30, plan: 20,
};

export const SYSTEM = `You are Pepe, a shitposting meme goblin watching a livestream of one survivor in a zombie game (Project Zomboid). Each time something happens you get a short plain description of it and her state. React as yourself, in character, in one or two short sentences. Plain text only, no lists, no quotes around it. You only watch and joke; you cannot talk to her and she cannot hear you.`;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Control characters out and the length capped. Nothing else is touched: it is Colin's own model and log.
export function cleanLine(text, max = LINE_MAX) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// pepe.log lines back into panel rows, so the panel is full again after a restart.
export function linesFromLog(records) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => isObj(r) && typeof r.line === 'string' && r.line)
    .map((r) => ({ at: Date.parse(r.at) || 0, event: String(r.event || ''), kind: String(r.kind || ''), line: r.line }))
    .slice(-PANEL_LINES);
}

export function emptyWatch() {
  return { live: false, kills: 0, hp: 100, hours: 0, bleeding: false, weapon: 'none', score: null, inside: false, nearDeath: false, planAt: 0, loopArmed: true, results: {} };
}

const insideOf = (p) => !!(p && p.inBldg && p.inBldg.id != null && !p.outside);

// An order was flee then walk back in, twice in two minutes: the loop reactions.mjs also warns the brain about.
function fleeLoops(history, now, run) {
  const mine = history.filter((e) => isObj(e) && (run == null || e.run == null || e.run === run) && now - num(e.at) <= LOOP_MS);
  let loops = 0;
  for (let i = 0; i + 1 < mine.length; i++) if (mine[i].key === 'AWAY' && mine[i + 1].verb === 'ENTER') loops++;
  return loops;
}

// Compare this look with the last one and list what happened. Pure: the caller keeps the watch.
// ctx: { history (tracker.history()), plan (planner.plan), now, run }
export function detectMoments(watch, p, ctx = {}) {
  if (!isObj(p) || p.dead) return { watch: { ...emptyWatch(), results: watch.results }, events: [] };
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const now = num(ctx.now, Date.now());
  const hp = num(p.hp, 100);
  const kills = num(p.kills);
  const hours = num(p.hoursAlive);
  const weapon = String(p.weapon || 'none');
  const score = typeof p.weaponScore === 'number' && Number.isFinite(p.weaponScore) ? p.weaponScore : null;
  const results = {};
  for (const e of history) if (isObj(e) && e.id != null) results[e.id] = e.result || '';
  const planAt = ctx.plan && ctx.plan.at ? num(ctx.plan.at) : 0;
  const next = {
    live: true, kills, hp, hours, bleeding: num(p.bleeding) > 0, weapon, score, inside: insideOf(p),
    nearDeath: watch.nearDeath, planAt, loopArmed: watch.loopArmed, results,
  };
  // A first look, a new character (the hours or kills went back) or a restarted bridge: take the
  // state as it is and say nothing about the past.
  if (!watch.live || hours < watch.hours - 0.5 || kills < watch.kills) {
    next.nearDeath = hp <= NEAR_DEATH_HP;
    next.loopArmed = fleeLoops(history, now, ctx.run) < 2;
    return { watch: next, events: [] };
  }
  const events = [];
  const add = (kind, text) => events.push({ kind, text: text.slice(0, MAX_EVENT_TEXT), weight: WEIGHT[kind] || 10, at: now });

  if (kills > watch.kills) {
    const n = kills - watch.kills;
    add('kill', n === 1 ? `She killed a zombie (${kills} kills this run).` : `She killed ${n} zombies at once (${kills} kills this run).`);
  }
  if (watch.hp - hp >= HP_DROP) add('hpDrop', `She took ${Math.round(watch.hp - hp)} damage and is down to ${Math.round(hp)} HP.`);
  if (next.bleeding && !watch.bleeding) add('bleeding', 'She started bleeding.');

  if (hp <= NEAR_DEATH_HP && !watch.nearDeath) {
    next.nearDeath = true;
    add('nearDeath', `She is nearly dead, ${Math.round(hp)} HP left.`);
  } else if (hp >= NEAR_DEATH_REARM) {
    next.nearDeath = false;
  }

  // Hands empty to anything, or a weapon scoring SWAP_GAIN (1.25) times better, the mod's own swap rule.
  if (weapon !== watch.weapon && weapon !== 'none') {
    const gained = watch.weapon === 'none' || (score !== null && watch.score !== null && score >= 1.25 * watch.score);
    if (gained) add('weapon', `She is now holding a ${weapon}${watch.weapon === 'none' ? ' after having nothing in hand' : `, better than the ${watch.weapon}`}.`);
  }

  if (next.inside && !watch.inside) add('entered', 'She went into a building.');

  const loops = fleeLoops(history, now, ctx.run);
  if (loops >= 2 && watch.loopArmed) {
    next.loopArmed = false;
    add('loop', 'She keeps running from a house, then walking straight back into it. A loop.');
  } else if (loops < 2) {
    next.loopArmed = true;
  }

  // Orders that finished since the last look, including one that was sent and finished between two looks.
  for (const e of history) {
    if (!isObj(e) || e.id == null || !e.result) continue;
    if (watch.results[e.id] === e.result) continue;
    const name = typeof e.name === 'string' && e.name ? e.name : String(e.verb || 'order');
    if (e.result === 'failed') add('failed', `Her order "${name}" failed${e.why ? ` (${String(e.why).slice(0, 40)})` : ''}.`);
    else if (e.result === 'done' && e.verb === 'SECURE') add('secured', 'She finished locking up the building.');
  }

  if (planAt && planAt !== watch.planAt && ctx.plan && ctx.plan.goal) add('plan', `Her planner made a new plan: "${String(ctx.plan.goal).slice(0, 90)}".`);

  return { watch: next, events };
}

// The state line that goes with every event. Short on purpose: the model reads it on a CPU.
export function stateText(p) {
  if (!isObj(p)) return 'unknown';
  const bits = [`${Math.round(num(p.hp, 100))}/100 HP`];
  const chase = num(p.zChasing);
  const close = num(p.zClose);
  bits.push(chase > 0 ? `${chase} zombies chasing her` : close > 0 ? `${close} zombies close` : 'no zombies near');
  if (num(p.bleeding) > 0) bits.push('bleeding');
  bits.push(insideOf(p) ? 'inside a building' : 'outside');
  bits.push(String(p.weapon || 'none') === 'none' ? 'no weapon in hand' : `holding a ${String(p.weapon).slice(0, 30)}`);
  bits.push(`day ${num(p.day)}, ${num(p.kills)} kills`);
  return bits.join(', ');
}

export function userMessage(top, others, p, lastLine) {
  const parts = [`WHAT JUST HAPPENED: ${top.text}`];
  if (others.length) parts.push(`ALSO: ${others.map((e) => e.text).join(' ')}`);
  parts.push(`HER STATE: ${stateText(p)}.`);
  if (lastLine) parts.push(`YOUR LAST LINE (do not repeat it): ${lastLine}`);
  parts.push('React in one or two short sentences.');
  return parts.join('\n');
}

// deps:
//   ask({ system, user })   async, returns { raw, ms }. Throws { preempted } when cut short.
//   busy()                  true while a menu turn, a plan or a review needs the model
//   write(obj)              appends one line to pepe.log; returns false when it could not
//   now()                   wall clock ms
//   log(kind, text)         the bridge's logger (switch-off notices only)
//   lines                   the last lines from the log, oldest first, so the panel survives a restart
//   enabled                 false starts it off
export function createCommentator(deps) {
  const { ask, busy = () => false, write = () => true, now = Date.now, log = () => {}, enabled = true } = deps;
  const self = {
    enabled,
    offReason: enabled ? '' : 'switched off',
    watch: emptyWatch(),
    pending: [],
    running: false,
    lastAt: 0,
    lastError: '',
    errors: 0,
    spoken: 0,
    lines: (Array.isArray(deps.lines) ? deps.lines : []).filter((l) => isObj(l) && typeof l.line === 'string').slice(-PANEL_LINES),
    percept: null,

    disable(reason) {
      if (!self.enabled) return;
      self.enabled = false;
      self.offReason = reason;
      self.pending = [];
      log('pepe', `peanut gallery off: ${reason}`);
    },

    // Call with every new percept. Returns the running promise when a line was started (a test awaits it).
    observe(p, ctx = {}) {
      if (!self.enabled) return null;
      self.percept = isObj(p) && !p.dead ? p : self.percept;
      const t = now();
      const seen = detectMoments(self.watch, p, { ...ctx, now: t });
      self.watch = seen.watch;
      for (const e of seen.events) self.pending.push(e);
      return self.maybeRun();
    },

    // A run ended (stats.takeEnded). r.cause is the game's own word for it.
    death(r) {
      if (!self.enabled || !isObj(r)) return null;
      const hours = Math.max(0, num(r.hoursAlive) - num(r.startHours));
      const text = `She died${r.cause ? ` (${String(r.cause).slice(0, 40)})` : ''} after ${Math.round(hours * 10) / 10} game hours and ${num(r.kills)} kills.`;
      self.pending.push({ kind: 'death', text, weight: WEIGHT.death, at: now() });
      return self.maybeRun();
    },

    // Also called on a timer: an event can be waiting only because the model was busy.
    maybeRun() {
      if (!self.enabled || self.running) return null;
      const t = now();
      self.pending = self.pending
        .filter((e) => t - e.at <= (e.kind === 'death' ? DEATH_EXPIRE_MS : EXPIRE_MS))
        .slice(-MAX_PENDING);
      if (!self.pending.length) return null;
      const dying = self.pending.some((e) => e.kind === 'death');
      if (!dying && t - self.lastAt < MIN_GAP_MS) return null;
      if (busy()) return null;
      const ranked = [...self.pending].sort((a, b) => b.weight - a.weight || b.at - a.at);
      const top = ranked[0];
      const others = ranked.slice(1, 3);
      const events = self.pending;
      self.pending = [];
      self.running = true;
      return self.speak(top, others, events).finally(() => { self.running = false; });
    },

    async speak(top, others, events) {
      const started = now();
      const last = self.lines.length ? self.lines[self.lines.length - 1].line : '';
      try {
        const reply = await ask({ system: SYSTEM, user: userMessage(top, others, self.percept, last) });
        self.lastAt = started;
        const line = cleanLine(reply && reply.raw);
        if (!line) throw new Error('empty reply');
        self.errors = 0;
        self.lastError = '';
        const rec = { at: now(), event: top.text, kind: top.kind, line, ms: num(reply.ms) };
        self.lines = [...self.lines, rec].slice(-PANEL_LINES);
        self.spoken += 1;
        write({ at: new Date(rec.at).toISOString(), kind: rec.kind, event: rec.event, line, ms: rec.ms });
      } catch (err) {
        // A menu turn or a plan needed the model. Not a failure and not a turn used: the moment goes back.
        if (err && err.preempted) {
          self.pending = [...events, ...self.pending];
          return;
        }
        self.lastAt = started;
        const msg = String(err && err.message || err).slice(0, 200);
        if (isMissingModel(msg)) {
          self.disable('the model is not installed in Ollama (404)');
          return;
        }
        self.lastError = msg;
        self.errors += 1;
        if (self.errors === 1) log('pepe', `comment failed: ${msg}`);
      }
    },

    view() {
      return {
        on: self.enabled, off: self.offReason, running: self.running, lastError: self.lastError,
        lines: self.lines.map((l) => ({ at: l.at, event: l.event, line: l.line })),
      };
    },
  };
  return self;
}
