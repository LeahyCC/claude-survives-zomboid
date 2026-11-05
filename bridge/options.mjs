// The menu for one turn. Every option is an order the body can run right now, so the model
// only chooses, it never invents. An option is { id, verb, a, b, target, label, key }:
// verb, a, b and target go into the intent line (docs/architecture.md), label is what the
// model reads, key names the option in map memory so a failed one is not offered again.

import { dist, compass, segmentDistance, awayFrom } from './geom.mjs';
import { tiles, percent, woundText, count } from './words.mjs';
import { zombies, unaware, inside, heavy, untreated, isNight, running, panic01 } from './senses.mjs';
import { blockedWhy, building, securedThisVisit, safehouseScore } from './memory.mjs';

export const MAX_OPTIONS = 8;
const MAX_BUILDINGS = 3;
// A walk is refused if it passes this close to an idle zombie, or ends this close to one.
const PATH_CLEAR = 5;
const END_CLEAR = 6;
const SEARCH_ZOMBIE_R = 8;
const SLEEP_ZOMBIE_R = 15;
const AWAY_R = 12;
const AVOID_R = 20;
const INTERRUPTS = new Set(['bandage', 'drink', 'eat', 'away']);
const BAG_WORDS =/\b(bag|backpack|duffel|satchel|rucksack|hiking bag)\b/i;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// True when a walk from here to (tx, ty) keeps clear of every idle zombie in the list.
export function pathClear(tx, ty, avoid) {
  return avoid.every((z) => segmentDistance(z.dx, z.dy, 0, 0, tx, ty) >= PATH_CLEAR && dist(z.dx, z.dy, tx, ty) >= END_CLEAR);
}

function kindOf(b, seen) {
  if ((seen && seen.shop) || (b && b.shop)) return 'shop';
  if ((seen && seen.res) || (b && b.res)) return 'house';
  return 'building';
}

function buildingTags(b, planned) {
  const tags = [];
  if (planned) tags.push('your planned home');
  if (!b || !b.visited) tags.push('not visited');
  else if (b.searched) tags.push('searched');
  else if (b.partly) tags.push('partly searched');
  else tags.push('visited, not searched');
  if (b && safehouseScore(b) >= 5) tags.push('safe house');
  else {
    if (b && b.water) tags.push('has water');
    if (b && b.bed) tags.push('has a bed');
  }
  if (b && b.zombies >= 2) tags.push(`${b.zombies} zombies seen`);
  return tags.join(', ');
}

// Unsearched first, nearest first. A safe house is pulled to the front when she needs one,
// and the planner's home building ahead of that when it is time to go home.
function rankBuildings(cands, wantsHome, homeId) {
  const stage = (c) => (c.mem && c.mem.searched ? 2 : c.mem && (c.mem.visited || c.mem.partly) ? 1 : 0);
  const homeFirst = (c) => (homeId && String(c.seen.id) === homeId ? -1 : wantsHome && safehouseScore(c.mem) >= 5 ? 0 : 1);
  return cands.sort((x, y) => homeFirst(x) - homeFirst(y) || stage(x) - stage(y) || x.d - y.d);
}

// homeId is the planner's home building, or '' when it is not time to go there. plannedId
// is the same building at any hour, only to tag it for the model.
function buildingOptions(p, mem, now, avoid, wantsHome, homeId, plannedId) {
  const here = inside(p) ? String(p.inBldg.id) : null;
  const cands = [];
  for (const seen of Array.isArray(p.buildings) ? p.buildings : []) {
    if (!seen || seen.id == null || String(seen.id) === here) continue;
    const key = `ENTER:${seen.id}`;
    if (blockedWhy(mem, key, now)) continue;
    const tx = seen.door ? num(seen.door.x) - num(p.x) : num(seen.dx);
    const ty = seen.door ? num(seen.door.y) - num(p.y) : num(seen.dy);
    if (!pathClear(tx, ty, avoid)) continue;
    cands.push({ seen, key, tx, ty, d: Math.max(num(seen.d), 0), mem: building(mem, seen.id) });
  }
  return rankBuildings(cands, wantsHome, homeId).slice(0, MAX_BUILDINGS).map((c, i) => {
    const where = c.d < 1 ? 'right here' : `${tiles(c.d)} ${compass(c.tx, c.ty)}`;
    const tags = buildingTags(c.mem || { visited: !!c.seen.visited }, !!plannedId && String(c.seen.id) === plannedId);
    return {
      id: `b${i + 1}`, verb: 'ENTER', a: 0, b: 0, target: String(c.seen.id), key: c.key,
      label: `walk into ${kindOf(c.mem, c.seen)} ${where}, ${tags}`,
    };
  });
}

// A GOTO a fixed length away in the first heading that keeps clear of idle zombies.
function walkOption(p, avoid, heading, length) {
  const tries = heading ? [heading] : [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    tries.push({ dx: Math.round(Math.cos(a) * length), dy: Math.round(Math.sin(a) * length) });
  }
  const pick = tries.find((t) => pathClear(t.dx, t.dy, avoid));
  if (!pick) return null;
  return { dx: pick.dx, dy: pick.dy, a: Math.round(num(p.x) + pick.dx), b: Math.round(num(p.y) + pick.dy) };
}

const WOUND_ORDER = ['bite', 'bleed', 'deep', 'glass', 'lac', 'scratch'];

function worstWound(p) {
  const ws = untreated(p);
  const rank = (w) => {
    const i = WOUND_ORDER.findIndex((k) => w[k]);
    return i < 0 ? 99 : i;
  };
  return ws.sort((a, b) => rank(a) - rank(b))[0] || null;
}

function carriedBag(p) {
  if (String(p.bag || 'none') !== 'none') return null;
  const names = String(p.items || '').split(',').map((s) => s.trim());
  return names.find((n) => BAG_WORDS.test(n)) || null;
}

// Needs and in-place verbs, each only when the percept says it can work.
function needOptions(p, mem, now) {
  const out = [];
  const inv = p.inv || {};
  const moodle = p.moodle || {};
  const here = inside(p) ? String(p.inBldg.id) : null;
  const zs = zombies(p);
  const near = (r) => zs.some((z) => z.d <= r);
  const chased = num(p.zChasing) > 0 || zs.some((z) => z.chase);
  const add = (prio, opt) => { if (!blockedWhy(mem, opt.key, now)) out.push({ prio, a: 0, b: 0, target: '', ...opt }); };

  const wound = worstWound(p);
  if (wound && (num(inv.bandages) > 0 || num(p.bleeding) > 0)) {
    const tail = num(inv.bandages) > 0 ? '' : ' (no bandage: rip cloth)';
    add(1, { id: 'bandage', verb: 'BANDAGE', key: 'BANDAGE', label: `bandage the ${woundText(wound)}${tail}` });
  }
  const thirsty = num(p.thirst) >= 0.25 || num(moodle.thirsty) >= 1;
  if (thirsty && num(inv.waterL) > 0) {
    add(2, { id: 'drink', verb: 'DRINK', key: 'DRINK', label: `drink from your bottle (${num(inv.waterL)} L left)` });
  } else if (thirsty && here && p.water) {
    add(2, { id: 'drink', verb: 'DRINK', key: 'DRINK', label: `drink at the tap ${tiles(p.water.d)} away, in this building` });
  }
  const hungry = num(p.hunger) >= 0.25 || num(moodle.hungry) >= 1;
  if (hungry && num(inv.foodReady) > 0) {
    add(3, { id: 'eat', verb: 'EAT', key: 'EAT', label: `eat something (${num(inv.foodReady)} ready to eat)` });
  } else if (hungry && num(inv.cans) > 0 && inv.canOpener) {
    add(3, { id: 'eat', verb: 'EAT', key: 'EAT', label: 'open a can and eat it' });
  }
  if (String(p.weapon || 'none') === 'none' && Array.isArray(p.weapons) && p.weapons.length) {
    add(4, { id: 'equip', verb: 'EQUIP', key: 'EQUIP', label: `hold the ${p.weapons[0].n} you carry` });
  }
  if (here && !securedThisVisit(mem, here)) {
    add(isNight(p) ? 4 : 9, { id: 'secure', verb: 'SECURE', key: `SECURE:${here}`, label: 'close the doors, windows and curtains of this building' });
  }
  const sleepy = num(p.fatigue) >= 0.5;
  const sleepSafe = !chased && num(p.zVisible) === 0 && !near(SLEEP_ZOMBIE_R) && num(moodle.panic) === 0
    && (num(moodle.pain) < 2 || num(p.fatigue) > 0.85);
  if (here && sleepy && sleepSafe) {
    const where = p.bed ? `in the bed ${tiles(p.bed.d)} away` : 'on the floor here (no bed found)';
    add(5, { id: 'sleep', verb: 'SLEEP', key: 'SLEEP', label: `sleep ${where}` });
  }
  const bInfo = building(mem, here);
  if (here && !(bInfo && bInfo.searched) && !heavy(p) && !near(SEARCH_ZOMBIE_R)) {
    const rooms = num(p.inBldg.rooms);
    const state = bInfo && bInfo.partly ? 'partly searched' : 'not searched yet';
    const roomText = rooms > 0 ? `${count(rooms, 'room')}, ` : '';
    add(6, { id: 'search', verb: 'SEARCH', key: `SEARCH:${here}`, label: `search this building for supplies (${roomText}${state})` });
  }
  const bag = carriedBag(p);
  if (bag) add(7, { id: 'wearbag', verb: 'WEARBAG', key: 'WEARBAG', label: `put on the ${bag}` });
  if (here && p.water && num(inv.emptyBottles) > 0) {
    add(10, { id: 'fill', verb: 'FILL', key: 'FILL', label: `fill ${count(inv.emptyBottles, 'empty bottle')} at the tap` });
  }
  if (num(p.endurance, 1) < 0.6 && !chased) {
    add(11, { id: 'rest', verb: 'REST', key: 'REST', label: `sit and get your breath back (endurance ${percent(p.endurance)})` });
  }
  return out;
}

// Build the legal options for this moment, at most MAX_OPTIONS, most useful first.
// ctx.now is wall time in ms, for the retry timers in map memory.
export function buildOptions(p, mem, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (!p || p.dead) return [];
  // Walks keep clear of every standing zombie in range: idle ones, and chasers the reflex
  // does not own yet. A downed one is the reflex's free stomp, not a wall.
  const avoid = zombies(p).filter((z) => !z.down && !z.crawl && z.d <= AVOID_R);
  const chasers = avoid.filter((z) => z.chase);
  const out = needOptions(p, mem, now);
  const wantsHome = isNight(p) || num(p.fatigue) >= 0.6 || panic01(p) >= 0.3;
  const outdoors = !inside(p);
  // The plan's home building leads the list from dusk (17:00) or whenever she needs shelter.
  const plannedId = ctx.plan && ctx.plan.home ? String(ctx.plan.home) : '';
  const dusk = num(p.hour, 12) >= 17 && num(p.hour, 12) < 21;
  const homeId = wantsHome || dusk ? plannedId : '';
  for (const o of buildingOptions(p, mem, now, avoid, wantsHome, homeId, plannedId)) out.push({ prio: outdoors ? 2.5 : 8, ...o });

  const close = [...unaware(p).filter((z) => z.d <= AWAY_R), ...chasers];
  if (close.length && !blockedWhy(mem, 'AWAY', now)) {
    const w = walkOption(p, avoid, awayFrom(close, 15), 15);
    if (w) {
      const n = close.length === 1 ? 'the zombie' : `${close.length} zombies`;
      const seen = chasers.length ? 'coming for you' : close.length === 1 ? 'that has not seen you' : 'that have not seen you';
      out.push({ prio: 2.6, id: 'away', verb: 'GOTO', a: w.a, b: w.b, target: '', key: 'AWAY',
        label: `walk quietly ${tiles(15)} ${compass(w.dx, w.dy)}, away from ${n} ${seen}` });
    }
  }
  const newPlaces = out.some((o) => o.verb === 'ENTER' && /not visited|not searched/.test(o.label));
  if (outdoors && !newPlaces && !blockedWhy(mem, 'EXPLORE', now)) {
    const turn = Math.floor(num(p.hoursAlive)) % 8;
    const a = (turn * Math.PI) / 4;
    const w = walkOption(p, avoid, { dx: Math.round(Math.cos(a) * 25), dy: Math.round(Math.sin(a) * 25) }, 25);
    if (w) {
      out.push({ prio: 12, id: 'explore', verb: 'GOTO', a: w.a, b: w.b, target: '', key: 'EXPLORE',
        label: `walk ${tiles(25)} ${compass(w.dx, w.dy)} to look for new houses` });
    }
  }

  const busy = running(p);
  const job = busy ? runningKey(p, mem) : null;
  // Any new order cancels the running job. Mid-search or mid-drink only an urgent need or a
  // way around a zombie is worth that. A walk can still change its mind about where to go.
  const walking = busy && (busy.verb === 'GOTO' || busy.verb === 'ENTER');
  const worthIt = (o) => walking || INTERRUPTS.has(o.id) || (chasers.length > 0 && o.id === 'secure');
  const fresh = busy ? out.filter((o) => (job ? o.key !== job : o.verb !== busy.verb) && worthIt(o)) : out;
  fresh.sort((x, y) => x.prio - y.prio);
  const last = busy
    ? { id: 'keep', verb: null, a: 0, b: 0, target: '', key: 'KEEP', label: `keep going with ${busy.verb} (still running)` }
    : { id: 'wait', verb: 'WAIT', a: 0, b: 0, target: '', key: 'WAIT', label: 'wait here and watch' };
  return [...fresh.slice(0, MAX_OPTIONS - 1), last].map(({ prio, ...o }) => o);
}

// The option key of the job now running, if this bridge sent it. "keep" stands for it.
export function runningKey(p, mem) {
  const busy = running(p);
  if (!busy) return null;
  const order = (mem.orders || []).find((o) => o.seq === busy.seq);
  return order ? order.key : null;
}

export function optionLines(options) {
  return options.map((o) => `${o.id}: ${o.label}`).join('\n');
}
