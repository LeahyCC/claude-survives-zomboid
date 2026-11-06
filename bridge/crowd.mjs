// The crowd map. Zombies seen by building and by area (a 20 by 20 tile grid), from every percept,
// fading back over 12 game hours. docs/pro-rules.md, card 5: 35 ENTER orders failed "zombie", 45
// were sent again after a failure, and one life walked into 11. The old count (b.zombies) only
// updated while she stood inside a house, so it said nothing about the houses she had not entered.
// Guides (pzfans 42.19, build42guide 42.20): an emptied area refills on about a 12 game hour timer.
//
// The percept lists the 6 nearest zombies within 25 tiles. So one look can name 6 at most, and an
// entry only goes up by seeing more at once. It is a floor, not a head count. When the list holds
// fewer than 6 it is the whole truth for those 25 tiles, and then a house in view with none in it is
// cleared at once instead of waiting out the timer.
//
// Entries are { n, at }: n zombies at crowd clock `at`. The clock is game hours added up from
// hoursAlive, so it survives a new character in the same world (hoursAlive starts again at 0).

import { zombies } from './senses.mjs';

export const FADE_HOURS = 12;
export const CELL = 20;
// A building with this many zombies seen is crowded: left off the ENTER menu. An area with this many
// ranks after the rest. The list holds 6, so an area can never read more than 6.
export const CROWD_BUILDING = 3;
export const CROWD_AREA = 5;
// A zombie belongs to the building whose wall (or door) is this close, or the one she is standing in.
const BUILDING_R = 10;
// Close enough that all zombies inside would be inside the 25 tile list.
const VIEW_R = 15;
const LIST_R = 25;
const LIST_MAX = 6;
// A new character this far from where the last one was is a new world, so the old map is wrong.
export const FAR_JUMP = 150;
const MAX_ENTRIES = 300;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function emptyCrowd() {
  return { clock: 0, last: null, buildings: {}, areas: {} };
}

function loadEntries(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, e] of Object.entries(raw)) {
    if (e && Number.isFinite(Number(e.n)) && Number.isFinite(Number(e.at)) && Number(e.n) > 0) out[k] = { n: Number(e.n), at: Number(e.at) };
  }
  return out;
}

// An old or hand-edited pz-state.json must not crash the bridge.
export function loadCrowd(raw) {
  const c = emptyCrowd();
  if (!raw || typeof raw !== 'object') return c;
  c.clock = Math.max(0, num(raw.clock));
  const l = raw.last;
  if (l && Number.isFinite(Number(l.hours)) && Number.isFinite(Number(l.x)) && Number.isFinite(Number(l.y))) {
    c.last = { hours: Number(l.hours), x: Number(l.x), y: Number(l.y) };
  }
  c.buildings = loadEntries(raw.buildings);
  c.areas = loadEntries(raw.areas);
  return c;
}

// Zombies still thought to be there: n fades in a straight line to nothing over FADE_HOURS.
function faded(e, clock) {
  if (!e) return 0;
  const age = Math.max(0, clock - num(e.at));
  return num(e.n) * Math.max(0, 1 - age / FADE_HOURS);
}

export const areaKey = (wx, wy) => `${Math.floor(num(wx) / CELL)},${Math.floor(num(wy) / CELL)}`;

export function buildingCrowd(mem, id) {
  const c = mem && mem.crowd;
  return c && id != null ? Math.round(faded(c.buildings[String(id)], c.clock)) : 0;
}

export function areaCrowd(mem, wx, wy) {
  const c = mem && mem.crowd;
  return c ? Math.round(faded(c.areas[areaKey(wx, wy)], c.clock)) : 0;
}

// Both numbers for one building: its own, and its area's. wx, wy is where its door (or wall) is.
export function crowdFor(mem, id, wx, wy) {
  return { building: buildingCrowd(mem, id), area: areaCrowd(mem, wx, wy) };
}

// The same from map memory alone, for a building that is not in this percept's list.
export function crowdOfBuilding(mem, id) {
  const b = mem && mem.buildings ? mem.buildings[String(id)] : null;
  const at = refs(b)[1] || refs(b)[0] || null;
  return at ? crowdFor(mem, id, at.x, at.y) : { building: buildingCrowd(mem, id), area: 0 };
}

export const isCrowded =(cr) => cr.building >= CROWD_BUILDING;
export const areaCrowded = (cr) => cr.area >= CROWD_AREA;

// The words on an ENTER option. Empty when nothing was seen.
export function crowdText(cr) {
  const z = (n) => (n === 1 ? '1 zombie' : `${n} zombies`);
  if (cr.building > 0) return `${z(cr.building)} seen here lately`;
  if (areaCrowded(cr)) return `${z(cr.area)} seen in this area lately`;
  return '';
}

// Where a remembered building is: the reference points the zombie test measures to.
function refs(b) {
  const out = [];
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) out.push({ x: b.x, y: b.y });
  if (b && b.door && Number.isFinite(b.door.x) && Number.isFinite(b.door.y)) out.push({ x: b.door.x, y: b.door.y });
  return out;
}

function nearestBuilding(mem, wx, wy) {
  let best = null;
  let bestD = BUILDING_R;
  for (const [id, b] of Object.entries(mem.buildings)) {
    for (const r of refs(b)) {
      const d = Math.hypot(r.x - wx, r.y - wy);
      if (d <= bestD) { best = id; bestD = d; }
    }
  }
  return best;
}

// The clock moves with the character. A new character (hoursAlive went back) near the last one
// keeps the map; a far spawn is another place and starts clean.
function tick(c, hours, x, y) {
  const l = c.last;
  if (l) {
    const dh = hours - l.hours;
    if (dh < -0.05) {
      if (Math.hypot(x - l.x, y - l.y) > FAR_JUMP) {
        c.buildings = {};
        c.areas = {};
      }
    } else if (dh > 0) {
      c.clock += dh;
    }
  }
  c.last = { hours, x, y };
}

function merge(entries, counts, clock, sure) {
  for (const [k, n] of counts) {
    // A complete list is the truth: set it. A partial one only raises what was already there.
    entries[k] = { n: sure(k) ? n : Math.max(n, faded(entries[k], clock)), at: clock };
  }
}

function prune(entries, clock) {
  const keys = Object.keys(entries);
  for (const k of keys) if (faded(entries[k], clock) <= 0) delete entries[k];
  const left = Object.keys(entries);
  if (left.length > MAX_ENTRIES) {
    left.sort((a, b) => entries[a].at - entries[b].at);
    for (const k of left.slice(0, left.length - MAX_ENTRIES)) delete entries[k];
  }
}

// Reads one percept into the map. Calling it twice on one percept changes nothing. Called from
// updateMemory after the buildings list has been read, so each building has its place.
export function updateCrowd(mem, p) {
  if (!mem.crowd) mem.crowd = emptyCrowd();
  const c = mem.crowd;
  const hours = num(p.hoursAlive, NaN);
  const x = num(p.x, NaN);
  const y = num(p.y, NaN);
  if (!Number.isFinite(hours) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  tick(c, hours, x, y);

  const here = p.inBldg && p.inBldg.id != null && !p.outside ? String(p.inBldg.id) : null;
  const complete = Array.isArray(p.zList) && p.zList.length < LIST_MAX;
  const inBuilding = new Map();
  const inArea = new Map();
  for (const z of zombies(p)) {
    const wx = x + z.dx;
    const wy = y + z.dy;
    const id = z.inside && here ? here : nearestBuilding(mem, wx, wy);
    if (id) inBuilding.set(id, (inBuilding.get(id) || 0) + 1);
    const k = areaKey(wx, wy);
    inArea.set(k, (inArea.get(k) || 0) + 1);
  }

  merge(c.buildings, inBuilding, c.clock, () => complete);
  if (complete) {
    // A house in view with nobody in it any more.
    for (const id of Object.keys(c.buildings)) {
      if (inBuilding.has(id)) continue;
      const near = refs(mem.buildings[id]).some((r) => Math.hypot(r.x - x, r.y - y) <= VIEW_R);
      if (near) delete c.buildings[id];
    }
  }

  // A cell whose four corners are all in the 25 tile list is fully seen.
  const seen = (k) => {
    const [gx, gy] = k.split(',').map(Number);
    return [[0, 0], [1, 0], [0, 1], [1, 1]].every(([ox, oy]) => Math.hypot((gx + ox) * CELL - x, (gy + oy) * CELL - y) <= LIST_R);
  };
  merge(c.areas, inArea, c.clock, (k) => complete && seen(k));
  if (complete) {
    for (let gx = Math.floor((x - LIST_R) / CELL); gx <= Math.floor((x + LIST_R) / CELL); gx++) {
      for (let gy = Math.floor((y - LIST_R) / CELL); gy <= Math.floor((y + LIST_R) / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!inArea.has(k) && c.areas[k] && seen(k)) delete c.areas[k];
      }
    }
  }
  prune(c.buildings, c.clock);
  prune(c.areas, c.clock);
}
