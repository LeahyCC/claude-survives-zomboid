// Turns each nudge that has a pick into an eval scenario whose accepted answer is Colin's pick, so
// `node bridge/eval/run.mjs` scores how often the brain agrees with him.
//
//   node bridge/tools/nudges-to-eval.mjs                 reads bridge/nudges.jsonl, writes bridge/eval/scenarios/nudge-<date>-<n>.json
//   node bridge/tools/nudges-to-eval.mjs --dry           says what it would write
//   node bridge/tools/nudges-to-eval.mjs --nudges a.jsonl --out some/dir
//
// A nudge is skipped when it has no pick, was exported before, repeats another scenario, or the
// menu cannot be rebuilt with his pick on it. Generated files are not committed (docs/eval.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog } from '../jsonl.mjs';
import { readBase, buildScenario } from '../eval/scenarios.mjs';
import { buildOptions } from '../options.mjs';
import { planTurn } from '../brain.mjs';

const NOW = 1_000_000;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Only the keys that differ from base.json, so the file shows what is special about the moment.
// A key the base has and the percept lacks becomes null, because merge() would keep the base's.
export function patchFor(percept, base = readBase()) {
  const patch = {};
  for (const k of Object.keys(percept)) if (!same(percept[k], base[k])) patch[k] = percept[k];
  for (const k of Object.keys(base)) if (!(k in percept)) patch[k] = null;
  return patch;
}

const signature = (s) => JSON.stringify([s.patch, s.memory || null, s.plan || null, s.accept]);

// nudges: the log lines. existing: scenarios already on disk (with their `file`).
// Returns { made: [{ file, scenario }], skipped: [{ at, why }] }.
export function toScenarios(nudges, existing = []) {
  const made = [];
  const skipped = [];
  const taken = new Set(existing.map((s) => s.file || `${s.name}.json`));
  const known = new Map(existing.map((s) => [signature(s), s.name]));
  const exported = new Set(existing.map((s) => s.from).filter(Boolean));
  const perDay = new Map();
  const base = readBase();

  for (const n of nudges) {
    if (!isObj(n) || n.t !== 'nudge' || typeof n.at !== 'string') continue;
    const day = n.at.slice(0, 10);
    // Counted over every nudge of the day, so a name does not move when an earlier one is skipped.
    const idx = (perDay.get(day) || 0) + 1;
    perDay.set(day, idx);
    const skip = (why) => skipped.push({ at: n.at, why });

    if (!n.pickKey || !n.pick) { skip('no pick, only a missing-option note'); continue; }
    if (!isObj(n.percept)) { skip('no percept saved'); continue; }
    if (exported.has(n.at)) { skip('already exported'); continue; }

    const scenario = {
      name: '', note: '', from: n.at, patch: patchFor(n.percept, base),
      ...(isObj(n.memory) ? { memory: n.memory } : {}), ...(isObj(n.plan) ? { plan: n.plan } : {}),
      accept: [], wrong: [],
    };
    // The pick is found again by its key, because ids like b1 point at a different house each turn.
    let built;
    try {
      built = buildScenario(scenario, NOW);
    } catch {
      skip('the saved percept could not be rebuilt');
      continue;
    }
    const target = buildOptions(built.percept, built.memory, { now: NOW, plan: built.plan }).find((o) => o.key === n.pickKey && o.verb);
    if (!target) { skip(`${n.pick} is not on the menu when it is rebuilt`); continue; }
    const turn = planTurn(built.percept, built.memory, { now: NOW, plan: built.plan });
    if (!['ask', 'policy'].includes(turn.kind)) { skip(`the moment was "${turn.kind}", not a choice`); continue; }

    scenario.accept = [target.id];
    const dup = known.get(signature(scenario));
    if (dup) { skip(`same as ${dup}`); continue; }

    let k = idx;
    while (taken.has(`nudge-${day}-${k}.json`)) k += 1;
    scenario.name = `nudge-${day}-${k}`;
    const brain = n.brain && n.brain.id ? `The brain picked ${n.brain.id}.` : 'The brain had no pick.';
    scenario.note = `Colin's nudge, ${n.situation || 'a moment in play'}. He picked ${target.id}. ${brain}${n.why ? ` He said: ${n.why}` : ''}`.trim();
    taken.add(`${scenario.name}.json`);
    known.set(signature(scenario), scenario.name);
    made.push({ file: `${scenario.name}.json`, scenario });
  }
  return { made, skipped };
}

function readScenarios(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    try {
      return [{ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }];
    } catch {
      return [];
    }
  });
}

const flag = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export function main(args = process.argv.slice(2)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const nFile = flag(args, 'nudges') || process.env.PZ_NUDGES_FILE || path.join(here, '..', 'nudges.jsonl');
  const out = flag(args, 'out') || path.join(here, '..', 'eval', 'scenarios');
  const dry = args.includes('--dry');
  const nudges = readLog(nFile, { rotated: false });
  const { made, skipped } = toScenarios(nudges, readScenarios(out));
  if (!dry && made.length) {
    fs.mkdirSync(out, { recursive: true });
    for (const m of made) fs.writeFileSync(path.join(out, m.file), JSON.stringify(m.scenario, null, 2) + '\n');
  }
  console.log(`${nudges.length} nudge lines: ${dry ? 'would write' : 'wrote'} ${made.length}, skipped ${skipped.length}.`);
  for (const m of made) console.log(`  ${m.file}  accept ${m.scenario.accept.join(', ')}`);
  for (const s of skipped) console.log(`  skipped ${s.at}: ${s.why}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
