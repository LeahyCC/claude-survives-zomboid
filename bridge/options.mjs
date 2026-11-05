// The menu for one turn. Every option is an order the body can run right now, so the model
// only chooses, it never invents. An option is { id, verb, a, b, target, label, key }:
// verb, a, b and target go into the intent line (docs/architecture.md), label is what the
// model reads, key names the option in map memory so a failed one is not offered again.

import { dist, compass, segmentDistance, awayFrom } from './geom.mjs';
import { tiles, percent, woundText, count } from './words.mjs';
import { zombies, unaware, inside, heavy, untreated, isNight, running, panic01, canTreat, betterWeapon, weaponPoor } from './senses.mjs';
import { blockedWhy, building, securedThisVisit, safehouseScore } from './memory.mjs';

export const MAX_OPTIONS = 8;
const MAX_BUILDINGS = 3;
// A remembered home further off than this is not worth a walk the pathfinder may refuse.
const MAX_HOME_WALK = 120;
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

const stageOf = (c) => (c.mem && c.mem.searched ? 2 : c.mem && (c.mem.visited || c.mem.partly) ? 1 : 0);

// Unsearched first, nearest first. A safe house is pulled to the front when she needs one,
// and the planner's home building ahead of that when it is time to go home. With no real
// weapon, houses come before shops and other buildings: that is where a bat or a knife is.
function rankBuildings(cands, wantsHome, homeId, poor) {
  const homeFirst = (c) => (homeId && String(c.seen.id) === homeId ? -1 : wantsHome && safehouseScore(c.mem) >= 5 ? 0 : 1);
  const houseFirst = (c) => (poor && kindOf(c.mem, c.seen) !== 'house' ? 1 : 0);
  return cands.sort((x, y) => homeFirst(x) - homeFirst(y) || stageOf(x) - stageOf(y) || houseFirst(x) - houseFirst(y) || x.d - y.d);
}

// homeId is the planner's home building, or '' when it is not time to go there. plannedId
// is the same building at any hour, only to tag it for the model. poor is true when she has
// no real weapon.
function buildingOptions(p, mem, now, avoid, wantsHome, homeId, plannedId, poor) {
  const here = inside(p) ? String(p.inBldg.id) : null;
  const cands = [];
  for (const seen of Array.isArray(p.buildings) ? p.buildings : []) {
    if (!seen || seen.id == null || String(seen.id) === here) continue;
    const key = `ENTER:${seen.id}`;
    if (blockedWhy(mem, key, now)) continue;
    // A door that is not a pair of numbers is no door: fall back to the offset to the wall.
    const door = seen.door && Number.isFinite(seen.door.x) && Number.isFinite(seen.door.y) ? seen.door : null;
    const tx = door ? door.x - num(p.x) : num(seen.dx);
    const ty = door ? door.y - num(p.y) : num(seen.dy);
    if (!pathClear(tx, ty, avoid)) continue;
    cands.push({ seen, key, tx, ty, d: Math.max(num(seen.d), 0), mem: building(mem, seen.id) });
  }
  return rankBuildings(cands, wantsHome, homeId, poor).slice(0, MAX_BUILDINGS).map((c, i) => {
    const where = c.d < 1 ? 'right here' : `${tiles(c.d)} ${compass(c.tx, c.ty)}`;
    const tags = buildingTags(c.mem || { visited: !!c.seen.visited }, !!plannedId && String(c.seen.id) === plannedId);
    // Said only of a house not yet searched, the place to look. A shop or a searched house is not sold as one.
    const hunt = poor && stageOf(c) < 2 && kindOf(c.mem, c.seen) === 'house' ? ', no real weapon yet, look here' : '';
    return {
      // name is how the order is called in the recent-choices lines (reactions.mjs), since b1 means another house next turn.
      id: `b${i + 1}`, verb: 'ENTER', a: 0, b: 0, target: String(c.seen.id), key: c.key, d: c.d,
      name: `${kindOf(c.mem, c.seen)} ${c.d < 1 ? 'here' : compass(c.tx, c.ty)}`,
      label: `walk into ${kindOf(c.mem, c.seen)} ${where}, ${tags}${hunt}`,
    };
  });
}

// The planner's home when it is a building the map knows, with a door on record, but the
// percept no longer lists it (only the 6 nearest within 40 tiles are listed). A walk to that
// door brings it back into the list, and ENTER takes over. shelters are the ENTER options
// already on the menu: at night outside a closer one is the better walk.
function homeOption(p, mem, now, avoid, plannedId, shelters) {
  if (!plannedId) return null;
  const key = `HOME:${plannedId}`;
  if (blockedWhy(mem, key, now)) return null;
  if (inside(p) && String(p.inBldg.id) === plannedId) return null;
  if ((Array.isArray(p.buildings) ? p.buildings : []).some((s) => s && String(s.id) === plannedId)) return null;
  const b = building(mem, plannedId);
  if (!b || !b.door || !Number.isFinite(b.door.x) || !Number.isFinite(b.door.y)) return null;
  const tx = b.door.x - num(p.x);
  const ty = b.door.y - num(p.y);
  const d = Math.hypot(tx, ty);
  if (d > MAX_HOME_WALK || !pathClear(tx, ty, avoid)) return null;
  if (isNight(p) && !inside(p) && shelters.some((s) => s.d < d)) return null;
  return {
    id: 'home', verb: 'GOTO', a: b.door.x, b: b.door.y, target: '', key,
    label: `walk back toward ${kindOf(b, null)} ${tiles(d)} ${compass(tx, ty)}, ${buildingTags(b, true)}`,
  };
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
  if (wound && canTreat(p)) {
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
  const better = betterWeapon(p);
  if (better) {
    const label = better.swap ? `swap to the ${better.n} you carry, it is clearly better than your ${String(p.weapon)}` : `hold the ${better.n} you carry`;
    add(4, { id: 'equip', verb: 'EQUIP', key: 'EQUIP', label });
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
  // A drop takes a few passes, so not with a zombie after her or close enough to hear it.
  if (heavy(p) && !chased && !near(SEARCH_ZOMBIE_R)) {
    const load = num(p.maxWeight) > 0 ? ` (carrying ${num(p.weight).toFixed(1)} of ${num(p.maxWeight)})` : '';
    add(5.5, { id: 'drop', verb: 'DROP', key: 'DROP', label: `drop the junk you carry to lighten the load${load}` });
  }
  const bInfo = building(mem, here);
  // roomsLeft is the body's count of rooms SEARCH has not finished. Only a real number counts:
  // an older mod sends none, and then the map memory alone decides.
  const left = here && typeof p.inBldg.roomsLeft === 'number' && Number.isFinite(p.inBldg.roomsLeft) ? Math.max(0, Math.floor(p.inBldg.roomsLeft)) : null;
  if (here && left !== 0 && !(bInfo && bInfo.searched) && !heavy(p) && !near(SEARCH_ZOMBIE_R)) {
    const rooms = num(p.inBldg.rooms);
    const started = (bInfo && bInfo.partly) || (left !== null && rooms > left);
    const state = started ? 'partly searched' : 'not searched yet';
    const roomText = left !== null ? `${count(left, 'room')} left, ` : rooms > 0 ? `${count(rooms, 'room')}, ` : '';
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
  const shelters = buildingOptions(p, mem, now, avoid, wantsHome, homeId, plannedId, weaponPoor(p));
  for (const o of shelters) out.push({ prio: outdoors ? 2.5 : 8, ...o });
  const home = homeOption(p, mem, now, avoid, plannedId, shelters);
  if (home) out.push({ prio: homeId ? (outdoors ? 2.4 : 8.5) : 9.5, a: 0, b: 0, target: '', ...home });

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
  const job = busy ? runningKey(p, mem, out) : null;
  // Any new order cancels the running job. Mid-search or mid-drink only an urgent need or a
  // way around a zombie is worth that. A walk can still change its mind about where to go.
  const walking = busy && (busy.verb === 'GOTO' || busy.verb === 'ENTER');
  const worthIt = (o) => walking || INTERRUPTS.has(o.id) || (chasers.length > 0 && o.id === 'secure');
  const fresh = busy ? out.filter((o) => (job ? o.key !== job : o.verb !== busy.verb) && worthIt(o)) : out;
  fresh.sort((x, y) => x.prio - y.prio);
  const last = busy
    ? { id: 'keep', verb: null, a: 0, b: 0, target: '', key: 'KEEP', label: `keep going with ${busy.verb} (still running)` }
    : { id: 'wait', verb: 'WAIT', a: 0, b: 0, target: '', key: 'WAIT', label: 'wait here and watch' };
  return [...fresh.slice(0, MAX_OPTIONS - 1), last].map(({ prio, d, ...o }) => o);
}

// The option key of the job now running. "keep" stands for it. The bridge's own record of the
// order answers first. After a restart that record may be gone, and res.target says what the
// body is working on: a building id for ENTER, SEARCH and SECURE, "x,y" for GOTO, which
// has to match the end of one of this turn's walks. Otherwise null, and the verb alone is used.
export function runningKey(p, mem, options = []) {
  const busy = running(p);
  if (!busy) return null;
  const order = (mem.orders || []).find((o) => o.seq === busy.seq);
  if (order) return order.key;
  const target = typeof p.res.target === 'string' ? p.res.target.trim() : '';
  if (!target) return null;
  if (busy.verb === 'ENTER' || busy.verb === 'SEARCH' || busy.verb === 'SECURE') return `${busy.verb}:${target}`;
  if (busy.verb === 'GOTO') {
    const walk = options.find((o) => o.verb === 'GOTO' && `${o.a},${o.b}` === target);
    return walk ? walk.key : null;
  }
  return null;
}

export function optionLines(options) {
  return options.map((o) => `${o.id}: ${o.label}`).join('\n');
}
