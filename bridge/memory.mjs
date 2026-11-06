// Map memory by building id, kept in pz-state.json as state.map. The percept only knows the
// 6 nearest buildings and this session's visits. This remembers what was searched, what was
// taken, where water and beds are, and which orders failed and why.

import { stepHouseJob, noteJobOrder, validJob } from './housejob.mjs';
import { emptyCrowd, loadCrowd, updateCrowd, areaKey } from './crowd.mjs';

const MAX_BUILDINGS = 300;
const MAX_ORDERS = 12;
// The base: one building for her gear. Colin, 2026-11-05: "which is the best base for putting gear,
// but should be dynamic if finding a new one". Clearly better is a guide number from the card.
export const BASE_MOVE = 2;
// A house counts from the start (residential is 2). A shop or a house full of zombies does not.
export const BASE_MIN_SCORE = 2;
// The same reach as the walk to the plan's home. A base further off than this is no use to her.
export const MAX_BASE_WALK = 120;

// How long a failed order stays off the menu. "stuck" must not be resent straight away.
const RETRY_MS = {
  stuck: 60_000, unreachable: 90_000, zombie: 30_000, locked: 20 * 60_000, 'unknown building': 5 * 60_000,
  'too soon': 5 * 60_000, 'not tired': 3 * 60_000, full: 5 * 60_000, 'cannot reach water': 3 * 60_000,
  'no water': 3 * 60_000, 'no food': 3 * 60_000, 'need can opener': 10 * 60_000, 'too full': 5 * 60_000,
  'no bandage': 3 * 60_000, 'no bag': 5 * 60_000, 'could not wear it': 10 * 60_000, 'no empty bottle': 3 * 60_000,
  'not heavy': 3 * 60_000, 'nothing to drop': 10 * 60_000, 'equip: no weapon': 10 * 60_000,
  'not at base': 60_000, 'nothing to stash': 10 * 60_000, 'nothing left': 10 * 60_000,
};
const DEFAULT_RETRY_MS = 45_000;
// A failed ENTER with "zombie" means the way in is not clear. Thirty seconds sent her straight back
// to it (docs/pro-rules.md: 45 repeats). Five minutes, then double for each failure again within an
// hour, to half an hour at most. A strike is forgotten after an hour of quiet, or when she gets in.
export const ENTER_ZOMBIE_MS = 5 * 60_000;
export const ENTER_ZOMBIE_MAX_MS = 30 * 60_000;
export const STRIKE_MEMORY_MS = 60 * 60_000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function emptyMemory() {
  return { buildings: {}, current: null, orders: [], fails: {}, handled: '', sleep: null, job: null, jobEvents: [], crowd: emptyCrowd(), strikes: {}, base: null, stashes: {}, haul: null, explored: [] };
}

// An old or hand-edited pz-state.json must not crash the bridge.
export function loadMemory(raw) {
  const m = emptyMemory();
  if (!raw || typeof raw !== 'object') return m;
  if (raw.buildings && typeof raw.buildings === 'object') m.buildings = raw.buildings;
  if (typeof raw.current === 'string') m.current = raw.current;
  if (Array.isArray(raw.orders)) m.orders = raw.orders.slice(-MAX_ORDERS);
  if (raw.fails && typeof raw.fails === 'object') m.fails = raw.fails;
  if (typeof raw.handled === 'string') m.handled = raw.handled;
  if (raw.sleep && typeof raw.sleep === 'object') m.sleep = raw.sleep;
  if (validJob(raw.job)) m.job = raw.job;
  m.crowd = loadCrowd(raw.crowd);
  if (raw.strikes && typeof raw.strikes === 'object') {
    for (const [k, v] of Object.entries(raw.strikes)) {
      if (v && Number.isFinite(Number(v.n)) && Number.isFinite(Number(v.at))) m.strikes[k] = { n: Number(v.n), at: Number(v.at) };
    }
  }
  if (Array.isArray(raw.explored)) {
    m.explored = raw.explored.filter((e) => e && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y))).slice(-MAX_EXPLORED);
  }
  if (raw.base && typeof raw.base.id === 'string') m.base = { id: raw.base.id, at: num(raw.base.at) };
  if (raw.stashes && typeof raw.stashes === 'object') {
    for (const [k, v] of Object.entries(raw.stashes)) {
      if (v && Number(v.n) > 0) m.stashes[k] = { n: Number(v.n), at: num(v.at) };
    }
  }
  if (raw.haul && typeof raw.haul === 'object') m.haul = raw.haul;
  return m;
}

function entry(mem, id, hours) {
  const key = String(id);
  let b = mem.buildings[key];
  if (!b) {
    b = { id: key, firstSeen: hours, lastSeen: hours, visited: false, lastVisit: null, searched: false, partly: false,
      took: [], water: false, bed: false, res: false, shop: false, zombies: 0, securedAt: null, enteredAt: null };
    mem.buildings[key] = b;
  }
  return b;
}

export function tookItems(why) {
  const m = /^took \d+: (.*?)( \(full\))?$/.exec(String(why || ''));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function prune(mem, now) {
  for (const [k, s] of Object.entries(mem.strikes || {})) if (now - num(s.at) > STRIKE_MEMORY_MS) delete mem.strikes[k];
  const ids = Object.keys(mem.buildings);
  if (ids.length <= MAX_BUILDINGS) return;
  ids.sort((a, b) => num(mem.buildings[a].lastSeen) - num(mem.buildings[b].lastSeen));
  for (const id of ids.slice(0, ids.length - MAX_BUILDINGS)) delete mem.buildings[id];
}

export function recordOrder(mem, seq, option, p, now = Date.now()) {
  const key = option.key || option.verb;
  const left = p && p.inBldg && typeof p.inBldg.roomsLeft === 'number' ? p.inBldg.roomsLeft : null;
  mem.orders.push({ seq, verb: option.verb, key, bldg: p && p.inBldg ? String(p.inBldg.id) : null, left });
  mem.orders = mem.orders.slice(-MAX_ORDERS);
  noteJobOrder(mem, option, p);
  // EQUIP never reports done while the weapon is still being raised, so the policy would send
  // it again every look. Keep it off the menu for the default retry time, a done result lifts it.
  if (option.verb === 'EQUIP') mem.fails[key] = { why: 'just sent', at: now };
}

// A trip to her own stash. It is not a search of the house, so the house's marks stay as they are.
// Empty when it came back with nothing: the stash count on the map only ever guessed.
function applyRestock(mem, order, r, why, now) {
  const id = order.key.slice('RESTOCK:'.length);
  const st = mem.stashes[id];
  if (r.status === 'failed') {
    mem.fails[order.key] = { why, at: now };
    if (why === 'nothing left') delete mem.stashes[id];
    return;
  }
  const m = /^took (\d+)/.exec(why);
  const took = m ? Number(m[1]) : 0;
  if (st) st.n = Math.max(0, num(st.n) - took);
  // Nothing fit the kit, so asking again straight away would only walk the same crates.
  if (!took) mem.fails[order.key] = { why: 'nothing left', at: now };
  else delete mem.fails[order.key];
}

function applyResult(mem, p, now, hours) {
  const r = p.res;
  if (!r || (r.status !== 'done' && r.status !== 'failed')) return;
  const tag = `${r.seq}:${r.status}`;
  if (mem.handled === tag) return;
  mem.handled = tag;
  const order = mem.orders.find((o) => o.seq === num(r.seq));
  const why = String(r.why || '');
  if (order && String(order.key).startsWith('RESTOCK:')) return applyRestock(mem, order, r, why, now);
  const bldgId = (order && order.bldg) || (p.inBldg ? String(p.inBldg.id) : null);
  const b = bldgId ? entry(mem, bldgId, hours) : null;
  if (r.status === 'done') {
    if (order) {
      delete mem.fails[order.key];
      delete mem.strikes[order.key];
    }
    if (r.verb === 'SEARCH' && b) {
      b.partly = true;
      // A SEARCH that finished rooms and left some (a room not loaded, a way that led outside) is
      // not the end of the house. One that got no further than the last is, or she would loop.
      const left = p.inBldg && typeof p.inBldg.roomsLeft === 'number' ? p.inBldg.roomsLeft : null;
      const moreToDo = left > 0 && order && order.left != null && left < order.left;
      b.searched = !why.includes('(full)') && !moreToDo;
      b.took = [...b.took, ...tookItems(why)].slice(-12);
      if (!why.includes('(full)')) forgetOldStash(mem, b.id);
      // Left things behind for weight, or stopped on the line. Either way the load goes home first:
      // the house job reads this and leaves full, and a STASH lifts it (noteStash).
      else if (order) {
        mem.fails[order.key] = { why: 'full', at: now };
        mem.haul = { from: b.id, at: hours };
      }
    } else if (r.verb === 'LOOT' && b) {
      b.partly = true;
      b.took = [...b.took, ...tookItems(why)].slice(-12);
    } else if (r.verb === 'SECURE' && b) {
      b.securedAt = hours;
    } else if (r.verb === 'SLEEP' && /^asleep/.test(why)) {
      mem.sleep = { at: now, hours, x: num(p.x), y: num(p.y) };
    } else if (r.verb === 'STASH' && b) {
      noteStash(mem, b.id, why, hours);
    } else if (r.verb === 'DROP') {
      mem.haul = null;
    } else if (r.verb === 'GOTO' && order && order.key === 'EXPLORE') {
      noteExplored(mem, num(p.x), num(p.y));
    }
    return;
  }
  if ((r.verb === 'SEARCH' || r.verb === 'LOOT') && why === 'nothing left' && b) {
    b.searched = true;
    b.partly = true;
    forgetOldStash(mem, b.id);
  }
  if (r.verb === 'STASH' && why === 'nothing to stash') mem.haul = null;
  if (order) {
    mem.fails[order.key] = { why, at: now };
    // A way in that is not clear (a zombie) or not there at all (unreachable: a house with no door
    // she can path to) both wait longer each time. At 90 s flat she walked back to the same
    // doorless house every other order (2026-11-06).
    if (r.verb === 'ENTER' && (why === 'zombie' || why === 'unreachable')) {
      const old = mem.strikes[order.key];
      mem.strikes[order.key] = { n: (old && now - num(old.at) < STRIKE_MEMORY_MS ? old.n : 0) + 1, at: now };
    }
  }
}

// With the game's asleep flag there is nothing to guess, so a guess left from a SLEEP result
// is dropped. Without it (an older mod), wake is a guess: low fatigue, a long sleep, or he moved.
function updateSleep(mem, p, hours) {
  if (typeof p.asleep === 'boolean') {
    mem.sleep = null;
    return;
  }
  const s = mem.sleep;
  if (!s) return;
  const r = p.res || {};
  const stillSleepResult = r.verb === 'SLEEP' && r.status === 'done';
  const moved = Math.hypot(num(p.x) - num(s.x), num(p.y) - num(s.y)) > 2;
  if (!stillSleepResult || moved || num(p.fatigue) < 0.1 || hours - num(s.hours) > 12) mem.sleep = null;
}

// What went in stays on the map. The load is off her, so a SEARCH that stopped on "full" may go again.
function noteStash(mem, id, why, hours) {
  const m = /^stashed (\d+)/.exec(why);
  mem.haul = null;
  if (!m) return;
  const old = mem.stashes[id];
  mem.stashes[id] = { n: num(old && old.n) + Number(m[1]), at: hours };
  for (const [k, f] of Object.entries(mem.fails)) {
    if (k.startsWith('SEARCH:') && f && f.why === 'full') delete mem.fails[k];
  }
}

// She has been back through an old base and taken what she could. Her own base keeps its count.
function forgetOldStash(mem, id) {
  if (mem.stashes[id] && !(mem.base && mem.base.id === id)) delete mem.stashes[id];
}

const baseSpot = (b) => (b.door && Number.isFinite(b.door.x) ? b.door : Number.isFinite(b.x) && Number.isFinite(b.y) ? b : null);

// True when the walk to b is one she could make from where she stands. A building with no position
// on record is given the benefit of the doubt, and the walk itself is what fails.
export function withinBaseWalk(b, p) {
  const at = baseSpot(b);
  return !at || Math.hypot(at.x - num(p.x), at.y - num(p.y)) <= MAX_BASE_WALK;
}

// Which building is the base now, or null. The planner's home leads while nothing is stashed in the
// old one, unless the old one is clearly the better. Once gear is there it takes a clearly better
// house to move: the planner writes a new plan every couple of hours, and a base that followed each
// one would scatter her gear over the map. A base out of reach loses to anything in reach.
export function pickBase(mem, p, home = '') {
  const planned = home ? building(mem, home) : null;
  const usable = (b) => !!b && withinBaseWalk(b, p);
  let best = null;
  for (const b of Object.values(mem.buildings)) {
    if (!b.visited || !usable(b) || safehouseScore(b) < BASE_MIN_SCORE) continue;
    if (!best || safehouseScore(b) > safehouseScore(best)) best = b;
  }
  const cur = mem.base ? building(mem, mem.base.id) : null;
  if (!usable(cur)) return usable(planned) ? planned.id : best ? best.id : cur ? cur.id : null;
  const score = safehouseScore(cur);
  if (usable(planned) && planned !== cur) {
    if (!(num(mem.stashes[cur.id] && mem.stashes[cur.id].n) > 0) && safehouseScore(planned) + BASE_MOVE > score) return planned.id;
    if (safehouseScore(planned) >= score + BASE_MOVE) return planned.id;
  }
  return best && safehouseScore(best) >= score + BASE_MOVE ? best.id : cur.id;
}

function updateBase(mem, p, home, hours) {
  const id = pickBase(mem, p, home);
  if (!id) return;
  if (!mem.base || mem.base.id !== id) mem.base = { id: String(id), at: hours };
}

// The building her gear goes to, or null.
export function baseBuilding(mem) {
  return mem && mem.base ? building(mem, mem.base.id) : null;
}

// ctx.home is the planner's home building, when there is a plan.
export function updateMemory(mem, p, now = Date.now(), ctx = {}) {
  if (!p || typeof p !== 'object' || p.dead) return mem;
  const hours = num(p.hoursAlive);
  if (!mem.strikes) mem.strikes = {};
  if (!mem.stashes) mem.stashes = {};
  const here = p.inBldg && p.inBldg.id != null && !p.outside ? String(p.inBldg.id) : null;
  // Read before the list below marks it: the job log counts walking back into a house.
  const wasVisited = !!(here && mem.buildings[here] && mem.buildings[here].visited);
  const entered = !!here && mem.current !== here;
  for (const seen of Array.isArray(p.buildings) ? p.buildings : []) {
    if (seen == null || seen.id == null) continue;
    const b = entry(mem, seen.id, hours);
    b.lastSeen = hours;
    b.res = !!seen.res;
    b.shop = !!seen.shop;
    if (seen.visited) b.visited = true;
    // Kept after the building drops out of the 6 nearest, so she can walk back to it.
    if (seen.door && Number.isFinite(seen.door.x) && Number.isFinite(seen.door.y)) b.door = { x: seen.door.x, y: seen.door.y };
    b.x = num(p.x) + num(seen.dx);
    b.y = num(p.y) + num(seen.dy);
  }
  if (here) {
    const b = entry(mem, here, hours);
    b.visited = true;
    b.lastVisit = hours;
    b.lastSeen = hours;
    b.rooms = num(p.inBldg.rooms);
    if (p.inBldg.water || p.water) b.water = true;
    if (p.bed) b.bed = true;
    b.zombies = (Array.isArray(p.zList) ? p.zList : []).filter((z) => num(z.d, 99) <= 15).length;
    if (mem.current !== here) {
      b.enteredAt = hours;
      delete b.fullAt;
    }
  }
  mem.current = here;
  applyResult(mem, p, now, hours);
  // Every room done is the body's own word that the place is searched, even when this bridge
  // missed the SEARCH result (a restart). After applyResult, which reads "(full)" as not done.
  if (here && mem.buildings[here].rooms > 0 && p.inBldg.roomsLeft === 0) {
    mem.buildings[here].partly = true;
    mem.buildings[here].searched = true;
  }
  updateSleep(mem, p, hours);
  updateCrowd(mem, p);
  updateBase(mem, p, ctx.home, hours);
  stepHouseJob(mem, p, now, { entered, wasVisited });
  prune(mem, now);
  return mem;
}

function enterZombieWait(mem, key) {
  const n = Math.max(1, num(mem.strikes && mem.strikes[key] && mem.strikes[key].n, 1));
  return Math.min(ENTER_ZOMBIE_MAX_MS, ENTER_ZOMBIE_MS * 2 ** (n - 1));
}

// Where her explore walks ended. The next walk heads for ground none of them covered, so she
// works outward instead of walking the same 25 tiles north and back (2026-11-06).
export const MAX_EXPLORED = 40;
export function noteExplored(mem, x, y) {
  if (!Array.isArray(mem.explored)) mem.explored = [];
  mem.explored.push({ x: Math.round(x), y: Math.round(y) });
  mem.explored = mem.explored.slice(-MAX_EXPLORED);
}

export function blockedWhy(mem, key, now = Date.now()) {
  const f = mem.fails[key];
  if (!f) return '';
  // The mod names the container in this why ("nothing came out of Mug"), so match its start.
  const dry = String(f.why || '').startsWith('nothing came out') ? 5 * 60_000 : undefined;
  const strike = (f.why === 'zombie' || f.why === 'unreachable') && String(key).startsWith('ENTER:');
  const wait = strike ? enterZombieWait(mem, key) : RETRY_MS[f.why] ?? dry ?? DEFAULT_RETRY_MS;
  if (now - num(f.at) < wait) return f.why || 'failed';
  delete mem.fails[key];
  return '';
}

export function building(mem, id) {
  return id == null ? null : mem.buildings[String(id)] || null;
}

export function securedThisVisit(mem, id) {
  const b = building(mem, id);
  return !!b && b.securedAt != null && b.enteredAt != null && b.securedAt >= b.enteredAt;
}

// A home worth walking back to: lived-in, water, a bed, few zombies around.
export function safehouseScore(b) {
  if (!b) return 0;
  let s = 0;
  if (b.res) s += 2;
  if (b.water) s += 2;
  if (b.bed) s += 2;
  if (b.searched) s += 1;
  if (b.shop) s -= 1;
  s -= Math.min(4, num(b.zombies));
  return s;
}

// The map memory the menu builder read for this percept: the building she is in and the ones the
// percept lists. A nudge keeps it so the eval can rebuild the same menu later.
export function memorySlice(mem, p) {
  const ids = new Set();
  if (mem.current) ids.add(String(mem.current));
  for (const seen of Array.isArray(p && p.buildings) ? p.buildings : []) if (seen && seen.id != null) ids.add(String(seen.id));
  const buildings = {};
  for (const id of ids) {
    const b = mem.buildings[id];
    if (!b) continue;
    buildings[id] = {
      visited: !!b.visited, searched: !!b.searched, partly: !!b.partly, took: (b.took || []).slice(-12),
      water: !!b.water, bed: !!b.bed, res: !!b.res, shop: !!b.shop, zombies: num(b.zombies),
      securedAt: b.securedAt ?? null, enteredAt: b.enteredAt ?? null,
      ...(b.door ? { door: b.door } : {}),
      ...(b.leftAt != null ? { leftAt: b.leftAt } : {}),
      ...(b.fullAt != null ? { fullAt: b.fullAt } : {}),
    };
  }
  // The crowd entries for these buildings and their areas, so the eval rebuilds the same labels.
  const c = mem.crowd;
  const crowd = { clock: c ? c.clock : 0, buildings: {}, areas: {} };
  for (const id of Object.keys(buildings)) {
    const b = mem.buildings[id];
    if (c && c.buildings[id]) crowd.buildings[id] = c.buildings[id];
    const at = b.door || (Number.isFinite(b.x) && Number.isFinite(b.y) ? b : null);
    const k = at ? areaKey(at.x, at.y) : null;
    if (c && k && c.areas[k]) crowd.areas[k] = c.areas[k];
  }
  const hasCrowd = Object.keys(crowd.buildings).length || Object.keys(crowd.areas).length;
  return {
    current: mem.current || null, buildings, ...(hasCrowd ? { crowd } : {}), ...(mem.job ? { job: mem.job } : {}),
    ...(mem.base ? { base: mem.base, stashes: mem.stashes } : {}), ...(mem.haul ? { haul: mem.haul } : {}),
  };
}

// What the map says about a building as her base or an old one, for a menu label. '' for any other.
export function baseTag(mem, id) {
  const n = num(mem.stashes && mem.stashes[String(id)] && mem.stashes[String(id)].n);
  const things = n === 1 ? '1 thing stashed' : `${n} things stashed`;
  if (mem.base && mem.base.id === String(id)) return n > 0 ? `your base, ${things}` : 'your base';
  return n > 0 ? `your old base, ${things}` : '';
}

export function memoryStats(mem) {
  const all = Object.values(mem.buildings);
  const base = baseBuilding(mem);
  const stashed = (id) => num(mem.stashes && mem.stashes[id] && mem.stashes[id].n);
  const spot = base ? baseSpot(base) : null;
  return {
    buildings: all.length,
    visited: all.filter((b) => b.visited).length,
    searched: all.filter((b) => b.searched).length,
    safe: all.filter((b) => safehouseScore(b) >= 5).length,
    // For the digest's one line, which only formats.
    base: base ? {
      id: base.id, kind: base.shop ? 'shop' : base.res ? 'house' : 'building', x: spot ? spot.x : null, y: spot ? spot.y : null,
      stashed: stashed(base.id),
      old: Object.keys(mem.stashes || {}).filter((id) => id !== base.id).reduce((sum, id) => sum + stashed(id), 0),
    } : null,
  };
}
