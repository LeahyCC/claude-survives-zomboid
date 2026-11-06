// Needs that cannot wait. When one of these rules fires, the bridge sends its option and the
// model is not asked. Each rule picks from the same option list the model would see, so the
// policy can never send an order the options builder thinks is illegal.

import { needs, isNight, inside, zombies, heavy, chasing, betterWeapon, bareHanded } from './senses.mjs';
import { securedThisVisit } from './memory.mjs';
import { DROP_MIN_HP, withoutGun } from './options.mjs';
import { jobPick } from './housejob.mjs';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Nearest unsearched house first, then any house, then anything with a door.
function bestShelter(options) {
  const ins = options.filter((o) => o.verb === 'ENTER');
  return ins.find((o) => /walk into house/.test(o.label)) || ins[0] || null;
}

// A zombie this close (and up) is on her. The same line as the reflex's contact range.
const ON_HER_R = 3;

function onHer(p) {
  return zombies(p).some((z) => !z.down && !z.crawl && z.d <= ON_HER_R);
}

export const POLICY_RULES = [
  {
    id: 'bleeding',
    pick(p, mem, opts) {
      // First in the list, so it beats DROP, SECURE, GOTO and ENTER. Two of the 2026-11-05 deaths were
      // bleed-outs (hp 63 to 0 in 4 minutes, hp 78 to 0 in 2) while she walked, waited and dropped
      // things. Not with a zombie on her: the reflex has that fight, and the wound is the second problem.
      if (num(p.bleeding) <= 0 || onHer(p)) return null;
      const tail = num(p.inv && p.inv.bandages) > 0 ? '' : ' No bandage, so ripping cloth.';
      return [opts.find((o) => o.id === 'bandage'), `Bleeding. Bandage it now.${tail}`];
    },
  },
  {
    id: 'thirst',
    pick(p, mem, opts) {
      if (!needs(p).has('thirsty')) return null;
      return [opts.find((o) => o.id === 'drink'), 'Thirsty and water is right here. Drinking.'];
    },
  },
  {
    id: 'hunger',
    pick(p, mem, opts) {
      // Only food that is ready: opening a can takes longer and is the model's call.
      if (!needs(p).has('hungry') || num(p.inv && p.inv.foodReady) <= 0) return null;
      return [opts.find((o) => o.id === 'eat'), 'Hungry and I have food. Eating.'];
    },
  },
  {
    id: 'equip',
    pick(p, mem, opts) {
      // Not for a weapon Colin put in her hand: betterWeapon says null, the same as the mod's own
      // EQUIP, which would turn the order down. Nor for a gun in hand: the reflex holsters it and
      // takes the melee weapon out by itself, or it is firing and the order would only get in the way.
      const better = betterWeapon(p);
      if (!better) return null;
      const thought = better.swap ? `The ${better.n} in my bag is clearly better. Swapping.` : `Nothing in my hands and a ${better.n} in the bag. Holding it.`;
      return [opts.find((o) => o.id === 'equip'), thought];
    },
  },
  {
    id: 'night-outside',
    pick(p, mem, opts) {
      if (!isNight(p) || inside(p)) return null;
      return [bestShelter(opts), 'Night and I am outside. Getting into the nearest house.'];
    },
  },
  {
    id: 'night-secure',
    pick(p, mem, opts) {
      if (!isNight(p) || !inside(p) || securedThisVisit(mem, p.inBldg.id)) return null;
      return [opts.find((o) => o.id === 'secure'), 'Night. Shutting the doors and curtains first.'];
    },
  },
  {
    id: 'sleep',
    pick(p, mem, opts) {
      const n = needs(p);
      const safeNight = isNight(p) && n.has('tired') && inside(p) && securedThisVisit(mem, p.inBldg.id);
      if (!n.has('exhausted') && !safeNight) return null;
      if (zombies(p).some((z) => z.chase)) return null;
      return [opts.find((o) => o.id === 'sleep'), 'Worn out and safe inside. Sleeping.'];
    },
  },
  {
    id: 'house-job',
    pick(p, mem, opts) {
      // Holds a house to the end: in, shut, look, search, leave. The rules above still come first, so
      // a wound, thirst, night and sleep each cut in, and the job picks up after. docs/brain.md.
      return jobPick(p, mem, opts);
    },
  },
  {
    id: 'find-weapon',
    pick(p, mem, opts) {
      // Bare hands are the top reason the reflex runs from a fight (soak 2026-11-05), and a brain
      // that says it needs a weapon still picks ENTER or WAIT. So inside a building with rooms
      // left, she searches. The SEARCH option is only on the menu when the building is not done,
      // she is not too heavy and no zombie is within 8 tiles, and the mod looks in the kitchen,
      // garage and sheds first. A gun does not count: only a melee weapon ends the search.
      if (!bareHanded(withoutGun(p)) || !inside(p) || chasing(p) > 0) return null;
      return [opts.find((o) => o.id === 'search'), 'No weapon yet. Searching this building, kitchen and garage first.'];
    },
  },
  {
    id: 'overloaded',
    pick(p, mem, opts) {
      // A drop takes a few passes. Not with something after her; the reflex has the fight.
      if (!heavy(p) || chasing(p) > 0 || num(p.hp, 100) < DROP_MIN_HP) return null;
      return [opts.find((o) => o.id === 'drop'), 'Too heavy. Dropping the junk.'];
    },
  },
];

// The first rule whose option is on the menu wins. Returns null when the model should choose.
export function decidePolicy(p, mem, options) {
  if (!p || p.dead) return null;
  for (const rule of POLICY_RULES) {
    const got = rule.pick(p, mem, options);
    if (got && got[0]) return { rule: rule.id, option: got[0], thought: got[1] };
  }
  return null;
}
