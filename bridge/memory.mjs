// Map memory by building id, kept in pz-state.json as state.map. The percept only knows the
// 6 nearest buildings and this session's visits. This remembers what was searched, what was
// taken, where water and beds are, and which orders failed and why.

const MAX_BUILDINGS = 300;
const MAX_ORDERS = 12;

// How long a failed order stays off the menu. "stuck" must not be resent straight away.
const RETRY_MS = {
  stuck: 60_000, unreachable: 90_000, zombie: 30_000, locked: 20 * 60_000, 'unknown building': 5 * 60_000,
  'too soon': 5 * 60_000, 'not tired': 3 * 60_000, full: 5 * 60_000, 'cannot reach water': 3 * 60_000,
  'no water': 3 * 60_000, 'no food': 3 * 60_000, 'need can opener': 10 * 60_000, 'too full': 5 * 60_000,
  'no bandage': 3 * 60_000, 'no bag': 5 * 60_000, 'could not wear it': 10 * 60_000, 'no empty bottle': 3 * 60_000,
  'not heavy': 3 * 60_000, 'nothing to drop': 10 * 60_000, 'equip: no weapon': 10 * 60_000,
};
const DEFAULT_RETRY_MS = 45_000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function emptyMemory() {
  return { buildings: {}, current: null, orders: [], fails: {}, handled: '', sleep: null };
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

function prune(mem) {
  const ids = Object.keys(mem.buildings);
  if (ids.length <= MAX_BUILDINGS) return;
  ids.sort((a, b) => num(mem.buildings[a].lastSeen) - num(mem.buildings[b].lastSeen));
  for (const id of ids.slice(0, ids.length - MAX_BUILDINGS)) delete mem.buildings[id];
}

export function recordOrder(mem, seq, option, p, now = Date.now()) {
  const key = option.key || option.verb;
  mem.orders.push({ seq, verb: option.verb, key, bldg: p && p.inBldg ? String(p.inBldg.id) : null });
  mem.orders = mem.orders.slice(-MAX_ORDERS);
  // EQUIP never reports done while the weapon is still being raised, so the policy would send
  // it again every look. Keep it off the menu for the default retry time, a done result lifts it.
  if (option.verb === 'EQUIP') mem.fails[key] = { why: 'just sent', at: now };
}

function applyResult(mem, p, now, hours) {
  const r = p.res;
  if (!r || (r.status !== 'done' && r.status !== 'failed')) return;
  const tag = `${r.seq}:${r.status}`;
  if (mem.handled === tag) return;
  mem.handled = tag;
  const order = mem.orders.find((o) => o.seq === num(r.seq));
  const why = String(r.why || '');
  const bldgId = (order && order.bldg) || (p.inBldg ? String(p.inBldg.id) : null);
  const b = bldgId ? entry(mem, bldgId, hours) : null;
  if (r.status === 'done') {
    if (order) delete mem.fails[order.key];
    if (r.verb === 'SEARCH' && b) {
      b.partly = true;
      b.searched = !why.includes('(full)');
      b.took = [...b.took, ...tookItems(why)].slice(-12);
    } else if (r.verb === 'LOOT' && b) {
      b.partly = true;
      b.took = [...b.took, ...tookItems(why)].slice(-12);
    } else if (r.verb === 'SECURE' && b) {
      b.securedAt = hours;
    } else if (r.verb === 'SLEEP' && /^asleep/.test(why)) {
      mem.sleep = { at: now, hours, x: num(p.x), y: num(p.y) };
    }
    return;
  }
  if ((r.verb === 'SEARCH' || r.verb === 'LOOT') && why === 'nothing left' && b) {
    b.searched = true;
    b.partly = true;
  }
  if (order) mem.fails[order.key] = { why, at: now };
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

export function updateMemory(mem, p, now = Date.now()) {
  if (!p || typeof p !== 'object' || p.dead) return mem;
  const hours = num(p.hoursAlive);
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
  const here = p.inBldg && p.inBldg.id != null && !p.outside ? String(p.inBldg.id) : null;
  if (here) {
    const b = entry(mem, here, hours);
    b.visited = true;
    b.lastVisit = hours;
    b.lastSeen = hours;
    b.rooms = num(p.inBldg.rooms);
    if (p.inBldg.water || p.water) b.water = true;
    if (p.bed) b.bed = true;
    b.zombies = (Array.isArray(p.zList) ? p.zList : []).filter((z) => num(z.d, 99) <= 15).length;
    if (mem.current !== here) b.enteredAt = hours;
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
  prune(mem);
  return mem;
}

export function blockedWhy(mem, key, now = Date.now()) {
  const f = mem.fails[key];
  if (!f) return '';
  // The mod names the container in this why ("nothing came out of Mug"), so match its start.
  const dry = String(f.why || '').startsWith('nothing came out') ? 5 * 60_000 : undefined;
  const wait = RETRY_MS[f.why] ?? dry ?? DEFAULT_RETRY_MS;
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
    };
  }
  return { current: mem.current || null, buildings };
}

export function memoryStats(mem) {
  const all = Object.values(mem.buildings);
  return {
    buildings: all.length,
    visited: all.filter((b) => b.visited).length,
    searched: all.filter((b) => b.searched).length,
    safe: all.filter((b) => safehouseScore(b) >= 5).length,
  };
}
