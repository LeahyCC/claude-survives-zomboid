// How her last orders went, said back to her. The tracker (decisions.mjs) keeps one record per
// order sent; this turns those records and the map memory's failed orders into the few plain
// lines the prompt carries, spots a loop, and shapes the rows of the Reactions strip on /mind.
// No I/O. Wording is kept short because every line costs prompt time on a 12B model.

import { blockedWhy } from './memory.mjs';
import { compass } from './geom.mjs';
import { count } from './words.mjs';

export const MAX_RECENT = 3;
export const MAX_BLOCKED = 3;
export const STRIP_ROWS = 8;
const LINE_MAX = 90;
// A flee followed by walking back in, twice inside this long, is a loop.
export const LOOP_MS = 2 * 60_000;
// Failures older than this are history, not a pattern.
export const REPEAT_MS = 5 * 60_000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// What an order is called in a line: "ENTER house W", "GOTO away", "SEARCH". The option carries
// its own short name when it has one (a building walk); a GOTO falls back to its menu id.
export function shortName(option) {
  if (!isObj(option) || !option.verb) return 'order';
  const name = typeof option.name === 'string' && option.name ? option.name : option.verb === 'GOTO' ? String(option.id || '') : '';
  return name ? `${option.verb} ${name}` : String(option.verb);
}

// The mod's reason codes (docs/skills.md) in words a model can use. An unknown code is passed on as is.
export function reasonText(why, verb = '') {
  const w = String(why || '').trim();
  if (!w) return '';
  if (w === 'zombie') return verb === 'ENTER' ? 'zombies at the door' : 'zombies too close';
  if (w === 'stuck') return 'got stuck on the way';
  if (w === 'unreachable') return 'no way to get there';
  if (w === 'locked') return 'the door is locked';
  if (w === 'nothing left') return 'nothing left to take';
  return w.slice(0, 40);
}

const chaseText = (n) => (n > 0 ? `still chased by ${n}` : '');
const lostText = (e) => (num(e.lost) >= 1 ? `lost ${Math.round(num(e.lost))} HP` : '');

// The part of a line after the order's name. p is the newest percept: only the order still
// running reads it, for what the body says about the job right now.
export function outcomeText(e, p = null) {
  const bits = [];
  if (e.result === 'replaced') return 'cut off by a newer order';
  if (e.result === 'unfinished') {
    return e.why === 'died' ? 'she died before it finished' : 'no result in time';
  }
  if (!e.result) {
    bits.push('running');
    const res = isObj(p && p.res) ? p.res : null;
    const here = isObj(p && p.inBldg) ? p.inBldg : null;
    if (e.verb === 'SEARCH' && here && Number.isFinite(here.roomsLeft)) bits.push(`${count(here.roomsLeft, 'room')} left`);
    else if (res && num(res.seq) === num(e.seq) && res.status === 'running' && res.why) bits.push(String(res.why).slice(0, 40));
    else if (p && num(p.lastSeq) < num(e.seq)) bits[0] = 'sent, not started yet';
    return bits.join(', ');
  }
  bits.push(e.result);
  if (e.result === 'failed') {
    const r = reasonText(e.why, e.verb);
    if (r) bits.push(r);
  }
  const chase = chaseText(num(e.chase));
  if (chase) bits.push(chase);
  const lost = lostText(e);
  if (lost) bits.push(lost);
  return bits.join(', ');
}

// History records carry the name they were sent under. The verb alone is the fallback for a hand-made one.
const nameOf = (e) => (typeof e.name === 'string' && e.name ? e.name : String(e.verb || 'order'));
const sameRun = (e, run) => run == null || e.run == null || e.run === run;

// The last few orders with how each went, oldest first. Orders from another character are left out.
export function recentLines(history, p, run = null, max = MAX_RECENT) {
  const mine = (Array.isArray(history) ? history : []).filter((e) => isObj(e) && sameRun(e, run)).slice(-max);
  return mine.map((e) => `${nameOf(e)}: ${outcomeText(e, p)}`.slice(0, LINE_MAX));
}

function ago(ms) {
  if (ms < 45_000) return 'just now';
  return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
}

const KEY_WORDS = {
  AWAY: 'walking away', EXPLORE: 'looking for new houses', HOME: 'the walk home', SEARCH: 'searching this building',
  SECURE: 'closing up this building', WEARBAG: 'putting on the bag',
};

// Orders map memory is keeping off the menu after a failure, newest first. A walk into a building is
// named by where it is now, the way the menu names it, and only when the percept still lists it.
export function blockedLines(mem, p, now, max = MAX_BLOCKED) {
  const fails = mem && isObj(mem.fails) ? mem.fails : {};
  const out = [];
  for (const [key, f] of Object.entries(fails)) {
    // EQUIP is parked for 45 seconds after it is sent. That is not a failure.
    if (!isObj(f) || f.why === 'just sent' || !blockedWhy(mem, key, now)) continue;
    const [verb, id] = key.split(':');
    let name;
    if (verb === 'ENTER') {
      const seen = (Array.isArray(p && p.buildings) ? p.buildings : []).find((s) => s && String(s.id) === id);
      if (!seen) continue;
      const door = seen.door && Number.isFinite(seen.door.x) && Number.isFinite(seen.door.y) ? seen.door : null;
      const dx = door ? door.x - num(p.x) : num(seen.dx);
      const dy = door ? door.y - num(p.y) : num(seen.dy);
      const b = mem.buildings && mem.buildings[id];
      const kind = (seen.shop || (b && b.shop)) ? 'shop' : (seen.res || (b && b.res)) ? 'house' : 'building';
      name = `${kind} ${num(seen.d) < 1 ? 'here' : compass(dx, dy)}`;
    } else {
      name = KEY_WORDS[verb] || verb.toLowerCase();
    }
    const why = reasonText(f.why, verb) || 'failed';
    out.push({ at: num(f.at), line: `${name}: ${why}, ${ago(now - num(f.at))}`.slice(0, LINE_MAX) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max).map((x) => x.line);
}

const VERB_WORDS = {
  ENTER: 'Walking into a building', GOTO: 'Walking', SEARCH: 'Searching', SECURE: 'Closing up', DRINK: 'Drinking',
  EAT: 'Eating', SLEEP: 'Sleeping', BANDAGE: 'Bandaging', DROP: 'Dropping things', FILL: 'Filling bottles',
};

// One plain line when the last orders go round in a circle, or '' when they do not.
//   flee and go back in, twice in two minutes
//   the same kind of order failing again and again with nothing of that kind working in between
//   the order that just failed, back on the menu already (a short retry time can run out before the zombies leave)
// options is this turn's menu, used only for that last case.
export function findPattern(history, now, run = null, options = []) {
  const mine = (Array.isArray(history) ? history : []).filter((e) => isObj(e) && sameRun(e, run));
  const lately = mine.filter((e) => now - num(e.at) <= LOOP_MS);
  let loops = 0;
  for (let i = 0; i + 1 < lately.length; i++) {
    if (lately[i].key === 'AWAY' && lately[i + 1].verb === 'ENTER') loops++;
  }
  if (loops >= 2) return 'You keep getting chased off houses. Try a quieter house, or leave this street.';
  // The newest failed order decides which verb to look at.
  const failed = mine.filter((e) => e.result === 'failed' && now - num(e.at) <= REPEAT_MS);
  const last = failed[failed.length - 1];
  if (!last) return '';
  const newest = mine[mine.length - 1];
  let streak = 0;
  const same = mine.filter((e) => e.verb === last.verb && (e.result === 'done' || e.result === 'failed'));
  for (let i = same.length - 1; i >= 0 && same[i].result === 'failed' && now - num(same[i].at) <= REPEAT_MS; i--) streak++;
  if (streak < 2) {
    // Nothing newer was sent since, and the same job is offered again.
    const again = newest === last && Array.isArray(options) && options.some((o) => o && o.key && o.key === last.key);
    if (!again) return '';
    const why = reasonText(last.why, last.verb);
    return `Your last order, ${nameOf(last)}, failed${why ? ` (${why})` : ''}. It is on the menu again. Try something else first.`;
  }
  const times = streak === 2 ? 'twice' : `${streak} times`;
  return `${VERB_WORDS[last.verb] || last.verb} failed ${times} in a row. Try something else first.`;
}

// Everything the prompt needs from the order history and the map memory.
export function reactionContext({ history, mem, p, now, run = null, options = [] }) {
  return {
    recent: recentLines(history, p, run),
    blocked: blockedLines(mem, p, now),
    pattern: findPattern(history, now, run, options),
  };
}

// The rows of the Reactions strip on /mind: the last orders, oldest first, each with the one after it.
export function reactionRows(history, p = null, max = STRIP_ROWS) {
  const all = (Array.isArray(history) ? history : []).filter(isObj);
  const from = Math.max(0, all.length - max);
  return all.slice(from).map((e, i) => {
    const next = all[from + i + 1];
    return {
      at: num(e.at),
      choice: nameOf(e),
      result: outcomeText(e, p),
      status: e.result || 'running',
      hp: e.result && e.result !== 'replaced' ? num(e.hp) : null,
      lost: num(e.lost),
      next: next ? nameOf(next) : null,
    };
  });
}
