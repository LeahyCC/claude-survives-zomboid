// Game rules for reading a v2 percept: how close is too close, what counts as a need,
// when a skill is still busy. docs/brain.md has the thresholds in one table.

export const HOLD_CHASE_R = 10;
export const HOLD_ANY_R = 3;
// The skills and needs verbs report done or failed themselves. MOVE and the older one-shot
// verbs stay "running" forever, so they never count as busy.
export const LONG_VERBS = new Set(['GOTO', 'ENTER', 'SEARCH', 'LOOT', 'DRINK', 'FILL', 'EAT', 'SLEEP', 'BANDAGE', 'WEARBAG', 'SECURE', 'REST', 'DROP']);
// Weapon scores come from Core.weaponScore (docs/combat.md): a kitchen knife is 9 and a hammer
// 19, a crowbar 30. Under 20 is a weapon only in name. SWAP_GAIN is the mod's own swap rule.
export const WEAK_WEAPON = 20;
export const SWAP_GAIN = 1.25;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function isV2(p) {
  return !!p && typeof p === 'object' && num(p.v) >= 2;
}

export function panic01(p) {
  if (p && p.panic01 != null) return num(p.panic01);
  return num(p && p.panic) / 100;
}

function moodle(p, key) {
  return num(p && p.moodle && p.moodle[key]);
}

// zList when the mod sent it. Without it, only the nearest zombie is known, and chase is
// a guess from zChasing.
export function zombies(p) {
  if (!p) return [];
  if (Array.isArray(p.zList)) {
    return p.zList.map((z) => ({
      dx: num(z.dx), dy: num(z.dy), d: num(z.d, Math.hypot(num(z.dx), num(z.dy))),
      chase: !!z.chase, down: !!z.down, crawl: !!z.crawl, wall: !!z.wall, inside: !!z.inside,
    }));
  }
  const d = num(p.zDist, -1);
  if (d < 0) return [];
  return [{ dx: num(p.zdx), dy: num(p.zdy), d, chase: num(p.zChasing) > 0, down: false, crawl: false, wall: false, inside: false }];
}

// A zombie that can get to her soon: it is after her, it is in her building, or it is closer than
// r tiles with no wall or closed door between. A zombie behind a wall that has not noticed her
// does not count, however close. An older mod sends no wall field, and then only distance counts.
// A chaser counts only inside REACH_CHASE_R: zList runs to 25 tiles, and a chaser that far off
// would keep her from searching for the whole of a long chase she has already broken.
export const REACH_CHASE_R = 15;
export function reaches(z, r) {
  return !!z && ((z.chase && z.d <= REACH_CHASE_R) || z.inside || (z.d <= r && !z.wall));
}

// Zombies after her. The list when the mod sent one, else the game's own count.
export function chasing(p) {
  return zombies(p).filter((z) => z.chase).length || num(p && p.zChasing);
}

// The reflex owns a chaser inside 10 tiles and anything it can see inside 3 (docs/combat.md). An order
// then would pull her out of the fight or the flee. An idle zombie further off is the brain's.
export function holdReason(p) {
  if (!p || p.dead) return '';
  if (Array.isArray(p.zList)) {
    const chaser = p.zList.find((z) => z.chase && num(z.d, 99) <= HOLD_CHASE_R);
    if (chaser) return `zombie chasing ${Math.round(num(chaser.d))} tiles away`;
  } else if (num(p.zChasing) > 0 && num(p.zClose) > 0) {
    return 'zombie chasing inside 10 tiles';
  }
  // A close zombie she cannot see and that is not chasing is behind a wall. The reflex leaves it
  // alone, so holding for it froze her for minutes in the live run. Let the brain move her on.
  if (p.zVisible !== undefined && num(p.zVisible) === 0) return '';
  const d = num(p.zDist, -1);
  const close = zombies(p).some((z) => z.d <= HOLD_ANY_R) || (d >= 0 && d <= HOLD_ANY_R);
  return close ? 'zombie inside 3 tiles' : '';
}

// Standing zombies that are not after her. Options walk around these.
export function unaware(p, radius = 20) {
  return zombies(p).filter((z) => !z.chase && !z.down && !z.crawl && z.d <= radius);
}

export function isNight(p) {
  const h = num(p && p.hour, 12);
  return h >= 21 || h < 6;
}

export function inside(p) {
  return !!(p && p.inBldg && p.inBldg.id != null && !p.outside);
}

// Too full to search: the same line the mod's SEARCH and DROP use (Act.searchLeft), 60% of the
// carry limit with no bag and 85% with one. With 85% here and 60% in the mod she could neither
// search nor drop, and waited.
export function heavy(p) {
  const max = num(p && p.maxWeight);
  const share = p && typeof p.bag === 'string' && p.bag !== 'none' && p.bag !== '' ? 0.85 : 0.6;
  return moodle(p, 'heavy') >= 1 || (max > 0 && num(p.weight) >= share * max);
}

export function untreated(p) {
  const ws = (p && Array.isArray(p.wounds)) ? p.wounds : [];
  return ws.filter((w) => w.bleed || w.deep || w.glass || w.bite || ((w.scratch || w.lac) && (!w.bandaged || w.dirty)));
}

// Need flags. The policy acts on the urgent ones. Busy turns re-ask when a new one appears.
export function needs(p) {
  const out = new Set();
  if (!p) return out;
  if (num(p.bleeding) > 0) out.add('bleeding');
  if (untreated(p).length) out.add('wounded');
  if (num(p.thirst) >= 0.6 || moodle(p, 'thirsty') >= 2) out.add('thirsty');
  if (num(p.hunger) >= 0.6 || moodle(p, 'hungry') >= 2) out.add('hungry');
  if (num(p.fatigue) >= 0.6 || moodle(p, 'tired') >= 2) out.add('tired');
  if (num(p.fatigue) >= 0.8 || moodle(p, 'tired') >= 3) out.add('exhausted');
  if (num(p.endurance, 1) < 0.4 || moodle(p, 'endurance') >= 2) out.add('winded');
  if (panic01(p) >= 0.3 || moodle(p, 'panic') >= 2) out.add('panicked');
  if (heavy(p)) out.add('heavy');
  if (isNight(p) && !inside(p)) out.add('night outside');
  return out;
}

export function running(p) {
  const r = p && p.res;
  if (!r || r.status !== 'running' || !LONG_VERBS.has(String(r.verb))) return null;
  return { seq: num(r.seq), verb: String(r.verb) };
}

// The game's own flag when the percept carries one. Only an older mod sends none, and then
// the memory's guess stands in (memory.mjs, updateSleep).
export function isAsleep(p, mem) {
  if (p && typeof p.asleep === 'boolean') return p.asleep;
  return !!(mem && mem.sleep);
}

// Bandaging works when a bandage is carried or the mod says it could rip one. A percept from
// before inv.canRip existed gets the old rule: anyone bleeding may try.
export function canTreat(p) {
  const inv = (p && p.inv) || {};
  if (num(inv.bandages) > 0) return true;
  if (typeof inv.canRip === 'boolean') return inv.canRip;
  return num(p && p.bleeding) > 0;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A firearm in her hand. The mod names it in heldGun and leaves weapon at "none": the reflex
// cannot fire a gun, so it is not the melee weapon. But it is not bare hands either.
export function heldGun(p) {
  const g = p && p.heldGun;
  return typeof g === 'string' && g !== '' && g !== 'none' ? g : null;
}

// True when what is in her hand is Colin's own pick (he equipped it), or a gun, which the mod
// never equips. The mod does not swap either away, so the policy must not ask it to.
export function weaponByHand(p) {
  return !!p && (p.weaponByHand === true || heldGun(p) !== null);
}

// The carried weapon with the best score, or null when the mod sent no scores.
function bestCarried(p) {
  const list = Array.isArray(p && p.weapons) ? p.weapons : [];
  let best = null;
  for (const w of list) {
    const s = finite(w && w.score);
    if (s !== null && (!best || s > best.score)) best = { n: String(w.n || 'weapon'), score: s };
  }
  return best;
}

// A carried weapon worth holding: any real one when the hands are empty, else one that scores
// SWAP_GAIN times the weapon in hand. { n, swap } or null. An older mod sends no scores, and
// then only empty hands count.
export function betterWeapon(p) {
  const list = Array.isArray(p && p.weapons) ? p.weapons : [];
  if (!list.length) return null;
  // Colin's pick, or a gun in hand: nothing is better than that, so nothing is offered. The mod
  // would refuse the order anyway, and a refused EQUIP would only sit on the menu.
  if (weaponByHand(p)) return null;
  const unarmed = String((p && p.weapon) || 'none') === 'none';
  const best = bestCarried(p);
  if (unarmed) return { n: String((best && best.n) || (list[0] && list[0].n) || 'weapon'), swap: false };
  const hand = finite(p.weaponScore);
  if (!best || hand === null || best.score <= hand || best.score < SWAP_GAIN * hand) return null;
  return { n: best.n, swap: true };
}

// True when nothing in hand or in the bag is a real weapon yet, so houses are worth looking in.
export function weaponPoor(p) {
  if (!p) return false;
  // A gun in hand is an armed survivor, not one that needs a house to find a weapon in.
  if (heldGun(p)) return false;
  const list = Array.isArray(p.weapons) ? p.weapons : [];
  if (String(p.weapon || 'none') === 'none' && !list.length) return true;
  const known = [finite(p.weaponScore), (bestCarried(p) || {}).score].filter((s) => s !== undefined && s !== null);
  return known.length > 0 && Math.max(...known) < WEAK_WEAPON;
}

// True when she has nothing to fight with at all: empty hands, no gun, nothing real in the bag.
// A saucepan is a weak weapon (weaponPoor) but not this. The policy only takes the choice away from
// the model for this case.
export function bareHanded(p) {
  if (!p || heldGun(p)) return false;
  const list = Array.isArray(p.weapons) ? p.weapons : [];
  return String(p.weapon || 'none') === 'none' && !list.length;
}

// Used only when the percept has no asleep flag. A SLEEP that reported "asleep" with fatigue
// still up is taken as asleep. The memory caps it so a missed wake does not freeze the brain.
export function sleptJustNow(p) {
  const r = p && p.res;
  return !!r && r.verb === 'SLEEP' && r.status === 'done' && /^asleep/.test(String(r.why || ''));
}
