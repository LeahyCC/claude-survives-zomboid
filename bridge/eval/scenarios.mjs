// Scenario files for the eval (docs/eval.md). Each is a patch over base.json, so a file only
// says what is different about that moment.
//
//   { name, note, patch, memory: { current, buildings, fails }, plan: { goal, steps, home }, history: [orders], accept: [ids], wrong: [ids] }
//
// plan is the planner's day plan, only for a moment that depends on it (the walk home).
// memory.fails is { key: { why, ago } }: orders that failed `ago` seconds ago (they stay off the menu while
// their retry time lasts). history is the orders she sent just before, oldest first, each
// { verb, key, name, result, why, lost, chase, ago }, for a moment that depends on how they went.
//
// accept: option ids a good player would take. wrong: ids that are clearly bad. Any other
// id counts as "other". An id that is not on the menu this turn is simply never picked.

import fs from 'node:fs';
import { emptyMemory, updateMemory } from '../memory.mjs';

const DIR = new URL('./', import.meta.url);

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key. Arrays and null replace, so a patch can empty a list.
export function merge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function readBase() {
  return JSON.parse(fs.readFileSync(new URL('base.json', DIR), 'utf8'));
}

export function loadScenarios() {
  const dir = new URL('scenarios/', DIR);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const s = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
    return { file: f, ...s };
  });
}

export function buildScenario(s, now = 1_000_000) {
  const percept = merge(readBase(), s.patch || {});
  const memory = emptyMemory();
  const seed = s.memory || {};
  if (seed.current) memory.current = String(seed.current);
  if (seed.job) memory.job = seed.job;
  for (const [id, b] of Object.entries(seed.buildings || {})) {
    memory.buildings[id] = { id, firstSeen: 0, lastSeen: 0, lastVisit: 0, visited: false, searched: false, partly: false,
      took: [], water: false, bed: false, res: false, shop: false, zombies: 0, securedAt: null, enteredAt: null, ...b };
  }
  for (const [key, f] of Object.entries(seed.fails || {})) memory.fails[key] = { why: String(f.why || ''), at: now - 1000 * Number(f.ago || 0) };
  updateMemory(memory, percept, now);
  const history = (s.history || []).map((h, i) => ({
    id: `h${i}`, seq: i + 1, at: now - 1000 * Number(h.ago || 0), run: null, by: 'model', result: null, why: '', hp: 0, lost: 0, chase: 0, ...h,
  }));
  return { percept, memory, plan: s.plan || null, history };
}
