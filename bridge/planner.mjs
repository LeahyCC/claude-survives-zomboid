// The slow layer. Every so often a planner model writes a short day plan; the fast chooser
// reads it as one or two lines and the options builder uses its home building. Nothing here
// is on the path of a tactical turn: the bridge calls tick() on a timer and never awaits it.
//
//   events (start, dawn, dusk, searched, safehouse, every 2 game hours)
//        |
//   pending set --- wait: no model call in flight, no fight --->  planner model
//        |                                                            |
//        +--------------------- plan {goal, steps, home} <------------+

import { extractJSON } from './decide.mjs';
import { digest } from './digest.mjs';
import { holdReason } from './senses.mjs';
import { memoryStats, safehouseScore, baseTag } from './memory.mjs';
import { compass } from './geom.mjs';
import { tiles } from './words.mjs';

export const DAWN_HOUR = 6;
export const DUSK_HOUR = 18;
export const INTERVAL_HOURS = 2;
// Events can come in bursts (two houses searched in a minute). One plan answers them all.
export const MIN_GAP_MS = 30_000;
export const MAX_STEPS = 3;
export const GOAL_MAX = 90;
export const STEP_MAX = 80;
const MAX_FAILURES = 3;
const KNOWN_LIMIT = 8;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// True when the clock hour went forward past `at` between two looks. Going forward by up to a
// day covers a sleep fast-forward; the hour never counts backwards.
export function crossedHour(from, to, at) {
  const step = (to - from + 24) % 24;
  const off = (at - from + 24) % 24;
  return step > 0 && off > 0 && off <= step;
}

// In-game hours since this character started. A percept without it falls back to the clock.
function gameClock(p) {
  return p.hoursAlive != null && Number.isFinite(Number(p.hoursAlive)) ? Number(p.hoursAlive) : num(p.day) * 24 + num(p.hour);
}

export function emptyWatch() {
  return { live: false, hour: 0, clock: 0, lastEventClock: 0, searched: 0, safe: 0 };
}

// Compare this look with the last one and say what happened. Returns the next watch and the
// event names. Pure: the caller keeps the watch. mem may be null.
export function detectEvents(watch, p, mem) {
  if (!p || p.dead) return { watch: emptyWatch(), events: [] };
  const hour = num(p.hour, 12);
  const clock = gameClock(p);
  const stats = mem ? memoryStats(mem) : { searched: 0, safe: 0 };
  const next = { live: true, hour, clock, lastEventClock: watch.lastEventClock, searched: stats.searched, safe: stats.safe };
  // A clock that went backwards is a new character, or a different save.
  if (!watch.live || clock < watch.clock) {
    next.lastEventClock = clock;
    return { watch: next, events: ['start'] };
  }
  const events = [];
  if (crossedHour(watch.hour, hour, DAWN_HOUR)) events.push('dawn');
  if (crossedHour(watch.hour, hour, DUSK_HOUR)) events.push('dusk');
  if (stats.searched > watch.searched) events.push('searched');
  if (stats.safe > watch.safe) events.push('safehouse');
  if (!events.length && clock - watch.lastEventClock >= INTERVAL_HOURS) events.push('interval');
  if (events.length) next.lastEventClock = clock;
  return { watch: next, events };
}

function cleanLine(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u2014\u2013]/g, ', ').replace(/[|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Model output into a plan the bridge can trust. A goal is required. Steps are optional and
// cut to 3. `home` must be a building the bridge knows, or it is dropped to empty.
export function parsePlan(raw, knownIds = []) {
  const data = extractJSON(raw);
  const goal = cleanLine(data && data.goal, GOAL_MAX);
  if (goal.length < 3) throw new Error('plan has no goal');
  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .map((s) => cleanLine(s, STEP_MAX))
    .filter(Boolean)
    .slice(0, MAX_STEPS);
  const home = data.home == null ? '' : String(data.home).trim();
  return { goal, steps, home: knownIds.map(String).includes(home) ? home : '' };
}

export function planSchema() {
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', maxLength: GOAL_MAX },
      steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'string', maxLength: STEP_MAX } },
      home: { type: 'string' },
    },
    required: ['goal', 'steps', 'home'],
  };
}

export const PLAN_SYSTEM = `You plan the next few game hours for one survivor in Project Zomboid. A small fast model makes the moment-to-moment choices from a short menu. You set direction, rarely.

Reply with JSON only: {"goal": "...", "steps": ["...", "..."], "home": "..."}
- goal: one short sentence, under 90 characters.
- steps: up to 3 short lines in order, each under 80 characters. Plain jobs like "search the next two houses" or "fill bottles, then go home".
- home: the id of one known building to treat as home base, or an empty string if none is good yet. Only use an id from the list.

Plan around the time of day: look for supplies by day, be inside a secured house with water and a bed by dusk. Treat wounds, thirst and hunger before looting. Use the lessons if they apply.`;

// The known buildings as short lines, the likeliest homes first, so `home` is a real id.
export function knownBuildings(mem, p, limit = KNOWN_LIMIT) {
  if (!mem || !mem.buildings) return [];
  const rows = Object.values(mem.buildings).map((b) => {
    const dx = num(b.x, num(p && p.x)) - num(p && p.x);
    const dy = num(b.y, num(p && p.y)) - num(p && p.y);
    return { b, d: Math.hypot(dx, dy), dx, dy, score: safehouseScore(b) };
  });
  rows.sort((x, y) => y.score - x.score || x.d - y.d);
  return rows.slice(0, limit).map(({ b, d, dx, dy, score }) => {
    const kind = b.shop ? 'shop' : b.res ? 'house' : 'building';
    const tags = [b.visited ? 'visited' : 'not visited', b.searched ? 'searched' : '', b.water ? 'water' : '', b.bed ? 'bed' : '', score >= 5 ? 'safe house' : '', baseTag(mem, b.id)]
      .filter(Boolean).join(', ');
    return { id: String(b.id), text: `${b.id}: ${kind}, ${d < 1 ? 'here' : `${tiles(d)} ${compass(dx, dy)}`}, ${tags}` };
  });
}

export function planPrompt({ p, mem, reasons, plan, lessons }) {
  const parts = [`WHY NOW: ${reasons.join(', ')}.`, `SITUATION:\n${digest(p, memoryStats(mem))}`];
  const known = knownBuildings(mem, p);
  parts.push(`KNOWN BUILDINGS:\n${known.length ? known.map((k) => k.text).join('\n') : '(none yet)'}`);
  if (plan) parts.push(`LAST PLAN: ${plan.goal}${plan.steps.length ? ` (${plan.steps.join('; ')})` : ''}${plan.home ? ` Home: ${plan.home}.` : ''}`);
  if (lessons && lessons.length) parts.push(`LESSONS FROM PAST RUNS:\n${lessons.slice(0, 10).map((l) => `- (${l.when}) ${l.text}`).join('\n')}`);
  parts.push('Write the plan.');
  return parts.join('\n\n');
}

// The plan as the chooser reads it: one or two short lines.
export function planLines(plan) {
  if (!plan || !plan.goal) return '';
  const lines = [`PLAN: ${plan.goal}${plan.home ? ` (home: building ${plan.home})` : ''}`];
  if (plan.steps && plan.steps.length) lines.push(`NEXT: ${plan.steps.join('; ')}`);
  return lines.join('\n');
}

// deps:
//   ask({ system, user, schema })   async, returns { raw, ms }
//   busy()                          true while a tactical turn is waiting on the model
//   lessons()                       the stored lessons, for the prompt
//   now()                           wall clock ms
//   log(kind, text), onChange()     the bridge's logger and saver
export function createPlanner(deps) {
  const { ask, busy = () => false, lessons = () => [], now = Date.now, log = () => {}, onChange = () => {} } = deps;
  const self = {
    plan: deps.plan || null,
    watch: emptyWatch(),
    pending: new Set(),
    running: false,
    lastError: '',
    lastRunAt: 0,
    failures: 0,

    // Call about every 2 seconds with the latest percept. Returns the running promise when a
    // plan was started, so a test can await it. The bridge ignores it.
    tick(p, mem) {
      const seen = detectEvents(self.watch, p, mem);
      self.watch = seen.watch;
      if (!p || p.dead) {
        self.pending.clear();
        return null;
      }
      for (const e of seen.events) self.pending.add(e);
      return self.maybeRun(p, mem);
    },

    maybeRun(p, mem) {
      if (self.running || !self.pending.size) return null;
      if (now() - self.lastRunAt < MIN_GAP_MS) return null;
      // Waits its turn: a tactical turn on the model goes first, and a fight is no time to plan.
      if (busy() || holdReason(p)) return null;
      const reasons = [...self.pending];
      self.running = true;
      return self.run(p, mem, reasons).finally(() => { self.running = false; });
    },

    async run(p, mem, reasons) {
      const started = now();
      self.lastRunAt = started;
      try {
        const known = knownBuildings(mem, p, 50).map((k) => k.id);
        const reply = await ask({ system: PLAN_SYSTEM, user: planPrompt({ p, mem, reasons, plan: self.plan, lessons: lessons() }), schema: planSchema() });
        const next = parsePlan(reply.raw, known);
        self.plan = { ...next, at: now(), hours: gameClock(p), why: reasons.join(', '), ms: Number(reply.ms) || 0 };
        for (const r of reasons) self.pending.delete(r);
        self.failures = 0;
        self.lastError = '';
        log('plan', `${reasons.join(', ')}: ${next.goal}${next.home ? ` (home ${next.home})` : ''}`);
        onChange();
      } catch (err) {
        // A menu turn needed the model. Not a failure: the events stay pending for the next try.
        if (err && err.preempted) { log('plan', 'cut short by a menu turn, will ask again'); return; }
        self.lastError = String(err && err.message || err).slice(0, 200);
        log('error', `planner: ${self.lastError}`);
        self.failures += 1;
        // A broken planner must not retry every 30 seconds for good. After 3 tries the events
        // are let go; the next event or the 2 hour timer asks again.
        if (self.failures >= MAX_FAILURES) {
          self.pending.clear();
          self.failures = 0;
        }
      }
    },

    // A new character starts with no plan.
    reset() {
      self.plan = null;
      self.watch = emptyWatch();
      self.pending.clear();
      self.failures = 0;
      onChange();
    },
  };
  return self;
}
