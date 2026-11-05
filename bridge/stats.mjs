// Per-run stats, read off the percept stream. A run is one character, from the first live
// percept to the death percept (or a new character starting). The last 20 are kept in
// pz-state.json. No I/O here: pz-bridge.mjs feeds percepts in and saves the store.
//
// The cause of death comes from death.mjs. The mod's death record is the good source: it holds the
// last 10 seconds and is written the moment she dies. When it did not reach the bridge, the cause
// is guessed from the bridge's own last percepts, which is thinner (docs/eval.md).

import { guessFrom, sampleFromPercept, describe, TAIL } from './death.mjs';

export const MAX_RUNS = 20;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function emptyStats() {
  // ended is the run that closed since the bridge last asked (takeEnded). It is never saved.
  return { run: null, runs: [], tail: [], lastDeathId: null, ended: null };
}

// An old or hand-edited pz-state.json must not crash the bridge.
export function loadStats(raw) {
  const s = emptyStats();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.run && typeof raw.run === 'object') s.run = raw.run;
  if (Array.isArray(raw.runs)) s.runs = raw.runs.slice(-MAX_RUNS);
  if (raw.lastDeathId != null) s.lastDeathId = String(raw.lastDeathId);
  return s;
}

// What gets saved. The tail is only for the next few seconds, so it stays in memory.
export function saveable(s) {
  return { run: s.run, runs: s.runs, lastDeathId: s.lastDeathId };
}

function newRun(p, now) {
  return {
    start: new Date(now).toISOString(), end: null,
    startHours: num(p.hoursAlive), hoursAlive: num(p.hoursAlive),
    kills: num(p.kills), day: num(p.day), damage: 0, lastHp: num(p.hp, 100),
    searched: 0, searchedIds: [], lastSearchSeq: -1,
    cause: null, death: null,
  };
}

// Put a guess on a run: the cause, and the facts behind it kept as a small object.
function stamp(r, guess, record) {
  r.cause = guess.cause;
  r.death = { ...guess.facts };
  if (isObj(record)) {
    r.hoursAlive = Math.max(num(r.hoursAlive), num(record.hours));
    r.kills = Math.max(num(r.kills), num(record.kills));
    r.day = Math.max(num(r.day), num(record.day));
  }
}

function finish(s, now, guess, record) {
  const r = s.run;
  if (!r) return;
  r.end = new Date(now).toISOString();
  stamp(r, guess, record);
  delete r.lastSearchSeq;
  s.runs = [...s.runs, r].slice(-MAX_RUNS);
  s.run = null;
  s.tail = [];
  s.ended = r;
}

// Feed one new percept. Returns true when a run started or ended, which is worth a save.
// Running totals are saved along with the next decision.
export function observe(s, p, now = Date.now()) {
  if (!p || typeof p !== 'object') return false;
  if (p.dead) {
    if (!s.run) return false;
    // The dead percept carries the mod's record. Remember its id so the file copy is not applied again.
    const record = isObj(p.death) ? p.death : null;
    if (record && record.id != null) s.lastDeathId = String(record.id);
    finish(s, now, guessFrom({ record, tail: s.tail }), record);
    return true;
  }
  let changed = false;
  // hoursAlive going backwards means a new character the bridge never saw die. What she was doing
  // in the last seconds is still in the tail.
  if (s.run && num(p.hoursAlive) < num(s.run.hoursAlive) - 0.5) {
    finish(s, now, guessFrom({ tail: s.tail }));
    changed = true;
  }
  if (!s.run) {
    s.run = newRun(p, now);
    changed = true;
  }
  const r = s.run;
  const hp = num(p.hp, r.lastHp);
  if (hp < r.lastHp) r.damage = Math.round((r.damage + (r.lastHp - hp)) * 10) / 10;
  r.lastHp = hp;
  r.hoursAlive = Math.max(num(r.hoursAlive), num(p.hoursAlive));
  r.kills = Math.max(num(r.kills), num(p.kills));
  r.day = Math.max(num(r.day), num(p.day));

  // A SEARCH that reported done, once per order, counted per building.
  const res = p.res;
  if (res && res.verb === 'SEARCH' && res.status === 'done' && num(res.seq) > num(r.lastSearchSeq, -1)) {
    r.lastSearchSeq = num(res.seq);
    const id = p.inBldg && p.inBldg.id != null ? String(p.inBldg.id) : null;
    if (id && !r.searchedIds.includes(id)) {
      r.searchedIds = [...r.searchedIds, id].slice(-100);
      r.searched = r.searchedIds.length;
    }
  }
  const g = sampleFromPercept(p);
  if (g) s.tail = [...s.tail, g].slice(-TAIL);
  return changed;
}

// The mod's death record, read from local_death.txt. fileMs is the file's modified time. The
// record ends the live run, or improves a run that ended a moment ago on thinner evidence.
// Returns true when something changed.
export function observeDeath(s, rec, fileMs, now = Date.now()) {
  if (!isObj(rec) || rec.id == null) return false;
  const id = String(rec.id);
  if (id === s.lastDeathId) return false;
  s.lastDeathId = id;
  const hours = num(rec.hours);
  const r = s.run;
  // A record from before this run started belongs to an earlier character (the file outlives the
  // game, and the bridge may have been off). The hours test is for a clock that jumped.
  if (r) {
    const started = Date.parse(r.start);
    if (Number.isFinite(started) && fileMs < started - 2000) return false;
    if (hours < num(r.hoursAlive) - 0.5) return false;
    finish(s, now, guessFrom({ record: rec, tail: s.tail }), rec);
    return true;
  }
  const prev = s.runs[s.runs.length - 1];
  if (prev && prev.end && Math.abs(num(prev.hoursAlive) - hours) <= 0.5
    && Date.parse(prev.start) <= fileMs && !(prev.death && prev.death.source === 'mod')) {
    stamp(prev, guessFrom({ record: rec }), rec);
    s.ended = prev;
    return true;
  }
  return false;
}

// The run that closed since the last call, or null. The bridge writes its death line to the log.
export function takeEnded(s) {
  const r = s.ended;
  s.ended = null;
  return r;
}

// The current run with its live length, for the /mind table.
export function summary(s, now = Date.now()) {
  const row = (r, live) => ({
    start: r.start, end: r.end, live,
    hoursSurvived: Math.round((num(r.hoursAlive) - num(r.startHours)) * 10) / 10,
    hoursAlive: num(r.hoursAlive), kills: num(r.kills), day: num(r.day), damage: num(r.damage),
    searched: num(r.searched), cause: r.cause || (live ? 'alive' : 'unknown'),
    death: !live && isObj(r.death) ? { ...r.death, summary: describe(r.death) } : null,
  });
  return {
    now: new Date(now).toISOString(),
    current: s.run ? row(s.run, true) : null,
    runs: s.runs.map((r) => row(r, false)).reverse(),
  };
}
