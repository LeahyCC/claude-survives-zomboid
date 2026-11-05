// The situation in a few short lines, as a person would write it. Formatting only: it
// decides nothing, it turns percept numbers into words a small model reads well.

import { level, percent, tiles, clock, woundText, list, count } from './words.mjs';
import { compass } from './geom.mjs';
import { isNight, panic01, zombies } from './senses.mjs';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function place(p) {
  const time = `Day ${num(p.day)}, ${clock(p.hour)}, ${isNight(p) ? 'night' : 'daytime'}${p.dark ? ', dark' : ''}.`;
  if (p.inBldg && !p.outside) {
    const rooms = num(p.inBldg.rooms) ? `, ${count(p.inBldg.rooms, 'room')}` : '';
    return `${time} Inside building ${p.inBldg.id} (${p.inBldg.room || p.room || 'a room'}${rooms}).`;
  }
  return `${time} Outside.`;
}

function body(p) {
  return `Health ${Math.round(num(p.hp, 100))}. Thirst ${level(p.thirst)}. Hunger ${level(p.hunger)}. `
    + `Tiredness ${level(p.fatigue)}. Panic ${level(panic01(p))}. Endurance ${percent(num(p.endurance, 1))}.`;
}

function supplies(p) {
  const inv = p.inv || {};
  const water = num(inv.waterL) > 0 ? `${num(inv.waterL)} L of water carried` : 'No water carried';
  const tap = p.water ? `, a tap ${tiles(p.water.d)} away in this building` : '';
  const ready = num(inv.foodReady);
  const cans = num(inv.cans);
  const food = [ready ? `${ready} ready to eat` : 'no food ready', cans ? `${count(cans, 'sealed can')}${inv.canOpener ? ' and a can opener' : ', no can opener'}` : ''];
  const med = num(inv.bandages) ? count(inv.bandages, 'bandage') : 'no bandages';
  return `${water}${tap}. Food: ${list(food)}. ${med[0].toUpperCase()}${med.slice(1)}.`;
}

function gear(p) {
  const weapons = Array.isArray(p.weapons) ? p.weapons : [];
  const inHand = String(p.weapon || 'none');
  const w = weapons.find((x) => x.n === inHand);
  let weapon = 'No weapon.';
  if (inHand !== 'none') weapon = `Holding a ${inHand}${w ? ` (${percent(w.cond)})` : ''}.`;
  else if (weapons.length) weapon = `Nothing in hand, a ${weapons[0].n} in the bag.`;
  const bag = String(p.bag || 'none') === 'none' ? 'No bag worn.' : `Wearing a ${p.bag}.`;
  const load = num(p.maxWeight) ? ` Load ${num(p.weight).toFixed(1)} of ${num(p.maxWeight)}.` : '';
  return `${weapon} ${bag}${load}`;
}

function wounds(p) {
  const ws = Array.isArray(p.wounds) ? p.wounds : [];
  if (!ws.length) return '';
  return `Wounds: ${list(ws.map(woundText), 3)}.`;
}

function threat(p) {
  const zs = zombies(p);
  if (!zs.length) return 'No zombies in sight.';
  const chasing = zs.filter((z) => z.chase);
  const idle = zs.filter((z) => !z.chase);
  const parts = [];
  const where = (z) => `${tiles(z.d)} ${compass(z.dx, z.dy)}`;
  if (chasing.length) parts.push(`${chasing.length} chasing you, nearest ${where(chasing[0])}`);
  if (idle.length) {
    const lead = idle.length === 1 ? '1 has not seen you' : `${idle.length} have not seen you`;
    parts.push(`${lead}, nearest ${where(idle[0])}${idle[0].down ? ' (on the ground)' : ''}`);
  }
  return `Zombies: ${parts.join('. ')}.`;
}

function lastOrder(p) {
  const r = p.res;
  if (!r || !r.verb || r.status === 'idle') return '';
  const why = r.why ? ` (${String(r.why).slice(0, 80)})` : '';
  return `Last order: ${r.verb} ${r.status}${why}.`;
}

// stats is memoryStats(mem): counts only, so this stays a formatter.
export function digest(p, stats) {
  if (!p) return 'No senses yet.';
  const lines = [place(p), body(p), supplies(p), gear(p), wounds(p), threat(p), lastOrder(p)];
  if (stats && stats.buildings) {
    lines.push(`Map: ${count(stats.buildings, 'building')} known, ${stats.visited} visited, ${stats.searched} searched.`);
  }
  return lines.filter(Boolean).join('\n');
}
