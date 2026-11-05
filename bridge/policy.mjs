// Needs that cannot wait. When one of these rules fires, the bridge sends its option and the
// model is not asked. Each rule picks from the same option list the model would see, so the
// policy can never send an order the options builder thinks is illegal.

import { needs, isNight, inside, zombies, heavy, chasing, betterWeapon } from './senses.mjs';
import { securedThisVisit } from './memory.mjs';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Nearest unsearched house first, then any house, then anything with a door.
function bestShelter(options) {
  const ins = options.filter((o) => o.verb === 'ENTER');
  return ins.find((o) => /walk into house/.test(o.label)) || ins[0] || null;
}

export const POLICY_RULES = [
  {
    id: 'bleeding',
    pick(p, mem, opts) {
      if (num(p.bleeding) <= 0) return null;
      return [opts.find((o) => o.id === 'bandage'), 'Bleeding. Bandage it now.'];
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
    id: 'overloaded',
    pick(p, mem, opts) {
      // A drop takes a few passes. Not with something after her; the reflex has the fight.
      if (!heavy(p) || chasing(p) > 0) return null;
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
