// Fixtures for the tests and tools/try-brain.mjs: a percept plus the map memory it needs.

import fs from 'node:fs';
import { emptyMemory, updateMemory } from '../memory.mjs';

const DIR = new URL('./', import.meta.url);

// What the bridge would already remember when each percept arrives.
const SEEDS = {
  'v2-day-searched-house.json': {
    buildings: {
      4021: { id: '4021', visited: true, searched: true, partly: true, res: true, water: true, bed: true, took: ['Kitchen Knife'] },
    },
  },
};

export function fixtureNames(prefix = 'v2-') {
  return fs.readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
}

export function readFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(name, DIR), 'utf8'));
}

export function loadFixture(name, now = 1_000_000) {
  const percept = readFixture(name);
  const memory = emptyMemory();
  for (const [id, b] of Object.entries((SEEDS[name] || {}).buildings || {})) {
    memory.buildings[id] = { firstSeen: 0, lastSeen: 0, lastVisit: 0, took: [], zombies: 0, securedAt: null, enteredAt: null, ...b };
  }
  updateMemory(memory, percept, now);
  return { percept, memory };
}
