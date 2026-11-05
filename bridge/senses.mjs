// Game rules for reading a v2 percept: how close is too close, what counts as a need,
// when a skill is still busy. docs/brain.md has the thresholds in one table.

export const HOLD_CHASE_R = 10;
export const HOLD_ANY_R = 3;
// The skills and needs verbs report done or failed themselves. MOVE and the older one-shot
// verbs stay "running" forever, so they never count as busy.
export const LONG_VERBS = new Set(['GOTO', 'ENTER', 'SEARCH', 'LOOT', 'DRINK', 'FILL', 'EAT', 'SLEEP', 'BANDAGE', 'WEARBAG', 'SECURE', 'REST']);

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
      chase: !!z.chase, down: !!z.down, crawl: !!z.crawl,
    }));
  }
  const d = num(p.zDist, -1);
  if (d < 0) return [];
  return [{ dx: num(p.zdx), dy: num(p.zdy), d, chase: num(p.zChasing) > 0, down: false, crawl: false }];
}

// The reflex owns a chaser inside 10 tiles and anything inside 3 (docs/combat.md). An order
// then would pull her out of the fight or the flee. An idle zombie further off is the brain's.
export function holdReason(p) {
  if (!p || p.dead) return '';
  if (Array.isArray(p.zList)) {
    const chaser = p.zList.find((z) => z.chase && num(z.d, 99) <= HOLD_CHASE_R);
    if (chaser) return `zombie chasing ${Math.round(num(chaser.d))} tiles away`;
  } else if (num(p.zChasing) > 0 && num(p.zClose) > 0) {
    return 'zombie chasing inside 10 tiles';
  }
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

export function heavy(p) {
  const max = num(p && p.maxWeight);
  return moodle(p, 'heavy') >= 1 || (max > 0 && num(p.weight) >= 0.85 * max);
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

// The percept has no asleep flag yet. A SLEEP that reported "asleep" with fatigue still up
// is taken as asleep. The memory caps it so a missed wake does not freeze the brain.
export function sleptJustNow(p) {
  const r = p && p.res;
  return !!r && r.verb === 'SLEEP' && r.status === 'done' && /^asleep/.test(String(r.why || ''));
}
