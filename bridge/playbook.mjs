// Pro rules from docs/research.md. Only the ones whose condition holds go into this turn's
// message, so the prompt stays short and every line is about now.

import { needs, isNight, inside, unaware, untreated, zombies, heavy, canTreat, weaponPoor } from './senses.mjs';
import { safehouseScore, building } from './memory.mjs';

export const MAX_RULES = 5;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const PLAYBOOK = [
  {
    id: 'wounded',
    // With nothing to bandage with, "treat it first" is an order she cannot follow.
    when: (p) => untreated(p).length > 0 && canTreat(p),
    text: 'Wounded: treat it before the next door.',
  },
  {
    id: 'go-home',
    when: (p) => !inside(p) && (needs(p).has('tired') || needs(p).has('panicked')),
    text: 'Tired or panicked: go back to a safe house. Do not start a new building.',
  },
  {
    id: 'night',
    when: (p) => isNight(p),
    text: 'Night: stay inside with the curtains closed. Do not walk the streets in the dark.',
  },
  {
    id: 'overloaded',
    when: (p) => heavy(p),
    text: 'Overloaded: stop looting and drop the junk. Carrying more slows you and tires you.',
  },
  {
    id: 'one-at-a-time',
    when: (p) => unaware(p).length > 0 || zombies(p).length > 1,
    text: 'Never fight more than one standing zombie. Go around ones that have not seen you.',
  },
  {
    id: 'no-weapon',
    when: (p) => String(p.weapon || 'none') === 'none' && !(Array.isArray(p.weapons) && p.weapons.length),
    text: 'No weapon: search houses for one first and keep away from every zombie.',
  },
  {
    id: 'weak-weapon',
    // A knife or a hammer: better than bare hands, no match for a pack. The no-weapon rule covers empty hands.
    when: (p) => weaponPoor(p) && (String(p.weapon || 'none') !== 'none' || (Array.isArray(p.weapons) && p.weapons.length > 0)),
    text: 'Your weapon is weak: look for a better one in houses you have not searched.',
  },
  {
    id: 'water',
    when: (p) => num(p.inv && p.inv.waterL) === 0,
    text: 'No water carried: fill a bottle whenever you are at a working tap.',
  },
  {
    id: 'quiet-entry',
    when: (p) => !inside(p) && Array.isArray(p.buildings) && p.buildings.length > 0,
    text: 'Enter quietly through a door. Smash a window only when there is no other way.',
  },
  {
    id: 'new-houses',
    when: (p, mem) => inside(p) && !!(building(mem, p.inBldg.id) || {}).searched,
    text: 'This place is searched. New houses have the loot, searched ones do not.',
  },
  {
    id: 'stay-safe',
    when: (p, mem) => inside(p) && safehouseScore(building(mem, p.inBldg.id)) >= 5 && (isNight(p) || needs(p).has('tired')),
    text: 'This is a good safe house (water, bed). Rest here rather than leave.',
  },
];

export function selectRules(p, mem, max = MAX_RULES) {
  if (!p) return [];
  return PLAYBOOK.filter((r) => {
    try {
      return r.when(p, mem);
    } catch {
      return false;
    }
  }).slice(0, max);
}
