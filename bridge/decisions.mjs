// The decision log: what the brain chose each turn, and what came of it. No I/O here. The bridge
// hands in a write function (jsonl.mjs appends the lines) and feeds every new percept to observe().
//
// Three kinds of line, all with the same id for one decision (docs/eval.md has the fields):
//   decision  written when the brain (policy or model) or a nudge sends or keeps something
//   outcome   written when the order reports done or failed (or is replaced by a newer one)
//   after     written when the follow-up window closes: the 60 seconds after it finished,
//             a zombie starting to chase, and whether she died within 5 minutes of the choice
//
// A fourth line, death, is written when a run ends (tracker.death), with the cause from death.mjs.
// A critic line (critic.mjs) can follow a decision a moment later, with the same id. It is not
// written here: joinRecords just attaches it.
//
// Clocks are wall clock, not game time, so fast-forward shortens the windows in game hours.

import { chasing, needs, inside, untreated, panic01 } from './senses.mjs';
import { shortName } from './reactions.mjs';

export const AFTER_MS = 60_000;
export const DEATH_MS = 5 * 60_000;
// Orders whose follow-up is still being watched. The game closing leaves some open, and they
// are forgotten rather than kept forever.
const MAX_OPEN = 20;
// Finished orders kept for the prompt and the Reactions strip on /mind. Memory only, not saved.
const MAX_HISTORY = 12;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, k = 2) => Math.round(num(v) * 10 ** k) / 10 ** k;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A small copy of the percept: enough to see the situation again, not the whole file. The
// nudge log keeps the full percept because it feeds the eval; this one is written every turn.
export function compactPercept(p) {
  if (!isObj(p)) return null;
  const inv = isObj(p.inv) ? p.inv : {};
  const zs = Array.isArray(p.zList) ? p.zList : [];
  const res = isObj(p.res) ? p.res : null;
  const here = isObj(p.inBldg) && p.inBldg.id != null ? p.inBldg : null;
  return {
    day: num(p.day), hour: num(p.hour), hoursAlive: round(p.hoursAlive, 1),
    x: num(p.x), y: num(p.y),
    hp: round(p.hp, 1), hunger: round(p.hunger), thirst: round(p.thirst), fatigue: round(p.fatigue),
    endurance: round(p.endurance, 2), panic: round(panic01(p)), bleeding: num(p.bleeding),
    inside: inside(p),
    bldg: here ? { id: String(here.id), roomsLeft: typeof here.roomsLeft === 'number' ? here.roomsLeft : null } : null,
    weapon: String(p.weapon || 'none').slice(0, 40),
    load: [round(p.weight, 1), round(p.maxWeight, 1)],
    inv: {
      bandages: num(inv.bandages), waterL: round(inv.waterL), foodReady: num(inv.foodReady),
      cans: num(inv.cans), emptyBottles: num(inv.emptyBottles),
    },
    wounds: untreated(p).length,
    needs: [...needs(p)],
    z: { close: num(p.zClose), near: num(p.zNear), chasing: chasing(p), visible: num(p.zVisible), nearest: round(p.zDist, 1) },
    zList: zs.slice(0, 4).map((z) => ({ d: round(z && z.d, 1), chase: !!(z && z.chase) })),
    res: res ? { verb: String(res.verb || '').slice(0, 12), status: String(res.status || '').slice(0, 10), why: String(res.why || '').slice(0, 80) } : null,
  };
}

const menuOf = (options) => (Array.isArray(options) ? options : []).map((o) => ({
  id: String(o.id), verb: o.verb || null, key: o.key || null, label: String(o.label || '').slice(0, 160),
}));

// write(obj) appends one line. Returns the tracker; its only state is the list of open orders.
export function createTracker({ write }) {
  let serial = 0;
  let open = [];
  let history = [];

  const idFor = (now) => `${now.toString(36)}-${(serial++).toString(36)}`;

  // chaseNow: how many zombies were chasing when it ended. Only the Reactions record keeps it.
  function finish(e, now, result, why, hp, chaseNow = 0) {
    if (e.done) return;
    e.done = true;
    e.doneAt = now;
    e.hpDone = hp;
    e.lostAtDone = e.lost;
    Object.assign(e.rec, { result, why: String(why || '').slice(0, 120), hp: round(hp - e.hp0, 1), lost: round(e.lost, 1), chase: chaseNow });
    write({
      t: 'outcome', id: e.id, at: new Date(now).toISOString(), verb: e.verb, result, why: String(why || '').slice(0, 120),
      ms: now - e.at, hpDuring: round(hp - e.hp0, 1), lostDuring: round(e.lost, 1),
    });
  }

  function close(e, now, died, hp) {
    if (!e.done) finish(e, now, 'unfinished', died ? 'died' : 'no result in time', hp);
    write({
      t: 'after', id: e.id, at: new Date(now).toISOString(), verb: e.verb,
      hpAfter: round(e.afterHp === undefined ? hp - e.hpDone : e.afterHp, 1),
      lostAfter: round((e.afterLost === undefined ? e.lost : e.afterLost) - e.lostAtDone, 1),
      chased: e.chased, died,
    });
    open = open.filter((x) => x !== e);
  }

  return {
    // d: { percept, run, menu (the full options), by, rule, choice, thought, rules (ids), ms,
    //      option (what was sent, or null for "keep"), seq }
    decide(d, now = Date.now()) {
      const p = d.percept;
      const id = idFor(now);
      const sent = !!d.option;
      const hp = num(p && p.hp, 100);
      // A newer order cancels the one before it, which then never reports.
      for (const e of [...open]) if (!e.done && sent) finish(e, now, 'replaced', 'a newer order was sent', e.lastHp, chasing(p));
      write({
        t: 'decision', id, at: new Date(now).toISOString(), run: d.run || null,
        day: num(p && p.day), hour: num(p && p.hour), percept: compactPercept(p), menu: menuOf(d.menu),
        by: String(d.by || ''), rule: d.rule ? String(d.rule) : null,
        choice: String(d.choice || ''), verb: d.option ? d.option.verb : null, key: d.option ? d.option.key || null : null,
        thought: String(d.thought || '').slice(0, 200), sent, seq: sent ? num(d.seq) : null,
        rules: (d.rules || []).map(String).slice(0, 8), ms: num(d.ms),
      });
      if (!sent) return id;
      // The record the prompt reads: name and key to say what it was, result and the rest filled in when it ends.
      const rec = { id, seq: num(d.seq), at: now, run: d.run || null, verb: d.option.verb, key: d.option.key || null,
        name: shortName(d.option), by: String(d.by || ''), result: null, why: '', hp: 0, lost: 0, chase: 0 };
      history = [...history, rec].slice(-MAX_HISTORY);
      open.push({
        id, seq: num(d.seq), verb: d.option.verb, at: now, hp0: hp, lastHp: hp, lost: 0, chase0: chasing(p),
        chased: false, hours0: num(p && p.hoursAlive), done: false, rec,
      });
      if (open.length > MAX_OPEN) open = open.slice(-MAX_OPEN);
      return id;
    },

    // One call per new percept. Cheap when nothing is open.
    observe(p, now = Date.now()) {
      if (!open.length || !isObj(p)) return;
      for (const e of [...open]) {
        if (p.dead) {
          close(e, now, true, e.lastHp);
          continue;
        }
        const hp = num(p.hp, e.lastHp);
        // The hours counter going back means a new character the bridge never saw die.
        if (num(p.hoursAlive) < e.hours0 - 0.5) {
          close(e, now, false, e.lastHp);
          continue;
        }
        const inWindow = !e.done || now - e.doneAt < AFTER_MS;
        if (inWindow) {
          e.lost += Math.max(0, e.lastHp - hp);
          if (chasing(p) > 0 && e.chase0 === 0) e.chased = true;
        }
        e.lastHp = hp;
        const r = isObj(p.res) ? p.res : null;
        if (!e.done && r && num(r.seq) === e.seq && (r.status === 'done' || r.status === 'failed')) {
          finish(e, now, r.status, r.why, hp, chasing(p));
        } else if (!e.done && now - e.at >= DEATH_MS) {
          finish(e, now, 'unfinished', 'no result in 5 minutes', hp);
        }
        if (e.done && e.afterHp === undefined && now - e.doneAt >= AFTER_MS) {
          e.afterHp = hp - e.hpDone;
          e.afterLost = e.lost;
        }
        if (e.afterHp !== undefined && now - e.at >= DEATH_MS) close(e, now, false, hp);
      }
    },

    // One line when a run ends: why, and what she was doing (death.mjs). A run is a character, so
    // run is its start time, the same key the decision lines carry. review.mjs counts these.
    death(r, now = Date.now()) {
      if (!isObj(r)) return;
      const f = isObj(r.death) ? r.death : {};
      write({
        t: 'death', id: `death-${idFor(now)}`, at: new Date(now).toISOString(), run: r.start || null,
        cause: String(r.cause || 'unknown'), day: num(r.day), hours: round(num(r.hoursAlive) - num(r.startHours), 1),
        kills: num(r.kills), job: f.job || null, order: f.order || null, status: f.status || null,
        zClose: num(f.zAdj), zNear: num(f.zClose), zChasing: num(f.zChasing), hpLost10: num(f.hpLost10),
        inside: f.inside === undefined ? null : !!f.inside, reflex: f.reflex || null, source: f.source || null,
        text: f.text ? String(f.text).slice(0, 120) : null,
      });
    },

    openCount: () => open.length,

    // Orders sent so far, oldest first, each with its result once it has one (docs/brain.md, Reactions).
    history: () => history.map((h) => ({ ...h })),
  };
}

// Decision lines with their outcome and after lines attached, in the order they were decided.
// A decision with no outcome yet (still running, or the bridge stopped) has outcome null.
export function joinRecords(lines) {
  const byId = new Map();
  const order = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!isObj(l) || typeof l.id !== 'string') continue;
    if (l.t === 'decision') {
      if (byId.has(l.id)) continue;
      const rec = { ...l, outcome: null, after: null, critic: null };
      byId.set(l.id, rec);
      order.push(rec);
    } else if (l.t === 'outcome' || l.t === 'after' || l.t === 'critic') {
      const rec = byId.get(l.id);
      if (rec) rec[l.t] = l;
    }
  }
  return order;
}

// Hit points lost during the order and in the minute after it.
export function harm(rec) {
  return num(rec.outcome && rec.outcome.lostDuring) + num(rec.after && rec.after.lostAfter);
}
