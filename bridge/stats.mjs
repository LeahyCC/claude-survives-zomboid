// Per-run stats, read off the percept stream. A run is one character, from the first live
// percept to the death percept (or a new character starting). The last 20 are kept in
// pz-state.json. No I/O here: pz-bridge.mjs feeds percepts in and saves the store.

export const MAX_RUNS = 20;
// How many recent percepts the death guess looks at. Percepts come about once a second.
const TAIL = 10;
const CRITICAL = 0.95;
// A zombie this close (tiles) at the end is taken as the one that killed her.
const BITE_R = 3;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function emptyStats() {
  return { run: null, runs: [], tail: [] };
}

// An old or hand-edited pz-state.json must not crash the bridge.
export function loadStats(raw) {
  const s = emptyStats();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.run && typeof raw.run === 'object') s.run = raw.run;
  if (Array.isArray(raw.runs)) s.runs = raw.runs.slice(-MAX_RUNS);
  return s;
}

// What gets saved. The tail is only for the next few seconds, so it stays in memory.
export function saveable(s) {
  return { run: s.run, runs: s.runs };
}

function newRun(p, now) {
  return {
    start: new Date(now).toISOString(), end: null,
    startHours: num(p.hoursAlive), hoursAlive: num(p.hoursAlive),
    kills: num(p.kills), day: num(p.day), damage: 0, lastHp: num(p.hp, 100),
    searched: 0, searchedIds: [], lastSearchSeq: -1,
    cause: null,
  };
}

function glance(p) {
  const zs = Array.isArray(p.zList) ? p.zList : [];
  return {
    hp: num(p.hp, 100), z: num(p.z), hunger: num(p.hunger), thirst: num(p.thirst), bleeding: num(p.bleeding),
    bite: (Array.isArray(p.wounds) ? p.wounds : []).some((w) => w && w.bite),
    nearest: zs.length ? Math.min(...zs.map((q) => num(q.d, 99))) : num(p.zDist, -1) >= 0 ? num(p.zDist) : 99,
  };
}

// Why she died, from the last few seconds. Order matters: a fall beats everything because
// it needs no zombie, a bite beats blood because most bleeding comes from the bite.
export function guessCause(tail) {
  if (!tail.length) return 'unknown';
  const last = tail[tail.length - 1];
  const nearZombie = tail.some((g) => g.nearest <= BITE_R);
  const fell = tail.some((g, i) => i > 0 && g.z < tail[i - 1].z) && !nearZombie;
  if (fell) return 'fell';
  if (last.thirst >= CRITICAL && !nearZombie) return 'dehydrated';
  if (last.hunger >= CRITICAL && !nearZombie) return 'starved';
  if (nearZombie || tail.some((g) => g.bite)) return 'bitten';
  if (tail.some((g) => g.bleeding > 0)) return 'bled out';
  return 'unknown';
}

function finish(s, now, cause) {
  const r = s.run;
  if (!r) return;
  r.end = new Date(now).toISOString();
  r.cause = cause;
  delete r.lastSearchSeq;
  s.runs = [...s.runs, r].slice(-MAX_RUNS);
  s.run = null;
  s.tail = [];
}

// Feed one new percept. Returns true when a run started or ended, which is worth a save.
// Running totals are saved along with the next decision.
export function observe(s, p, now = Date.now()) {
  if (!p || typeof p !== 'object') return false;
  if (p.dead) {
    if (!s.run) return false;
    finish(s, now, guessCause(s.tail));
    return true;
  }
  let changed = false;
  // hoursAlive going backwards means a new character the bridge never saw die.
  if (s.run && num(p.hoursAlive) < num(s.run.hoursAlive) - 0.5) {
    finish(s, now, 'unknown');
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
  s.tail = [...s.tail, glance(p)].slice(-TAIL);
  return changed;
}

// The current run with its live length, for the /mind table.
export function summary(s, now = Date.now()) {
  const row = (r, live) => ({
    start: r.start, end: r.end, live,
    hoursSurvived: Math.round((num(r.hoursAlive) - num(r.startHours)) * 10) / 10,
    hoursAlive: num(r.hoursAlive), kills: num(r.kills), day: num(r.day), damage: num(r.damage),
    searched: num(r.searched), cause: r.cause || (live ? 'alive' : 'unknown'),
  });
  return {
    now: new Date(now).toISOString(),
    current: s.run ? row(s.run, true) : null,
    runs: s.runs.map((r) => row(r, false)).reverse(),
  };
}
