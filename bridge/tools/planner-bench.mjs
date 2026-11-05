// Measure a model as the planner, and what it does to the menu model next to it.
//
//   node bridge/tools/planner-bench.mjs <planner model> [options]
//
//   --runs 3            plans per fixture
//   --fixtures a,b      fixture names without v2- and .json (default: the four below)
//   --gpu 20            num_gpu for the planner request only (layers kept on the GPU)
//   --menu gemma4:12b   the menu model that is timed after each plan
//   --timeout 300000    ms before a plan is given up
//   --during            also fire a menu turn 1.5 s into each plan and time it
//   --out file.jsonl    append one JSON line per plan
//
// Each plan uses the real prompt, schema and callPlanner. Right after it, one menu turn is put
// to the menu model. If the planner pushed the menu model out of VRAM, that turn pays a load
// and takes seconds instead of a third of a second. /api/ps is read before and after to show
// what is loaded and where.

import fs from 'node:fs';
import { loadFixture } from '../fixtures/load.mjs';
import { planTurn, userMessage } from '../brain.mjs';
import { selectRules } from '../playbook.mjs';
import { callChoice, callPlanner, parseGpuLayers } from '../llm.mjs';
import { planPrompt, parsePlan, planSchema, knownBuildings, PLAN_SYSTEM } from '../planner.mjs';

// Fixture name, and the reason the bridge would ask for a plan in that moment.
export const CASES = {
  'night-outside': ['dusk'],
  bleeding: ['interval'],
  'day-searched-house': ['searched'],
  'outside-unaware-near': ['start'],
};

const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const planner = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const runs = Number(flag('runs', 3));
const menuModel = flag('menu', 'gemma4:12b');
const timeout = Number(flag('timeout', 300000));
const out = flag('out', '');
const during = args.includes('--during');
const gpu = parseGpuLayers(flag('gpu', ''));
const names = flag('fixtures', Object.keys(CASES).join(',')).split(',');
const BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

async function loaded() {
  const res = await fetch(`${BASE}/api/ps`);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    gb: +(m.size / 1e9).toFixed(1),
    vramGb: +((m.size_vram || 0) / 1e9).toFixed(1),
    where: !m.size_vram ? 'cpu' : m.size_vram >= m.size ? 'gpu' : 'split',
  }));
}
const show = (ps) => ps.map((m) => `${m.name} ${m.where} ${m.vramGb}/${m.gb}GB`).join(', ') || 'nothing';
const has = (ps, name) => ps.some((m) => m.name === name || m.name === `${name}:latest`);

// The menu turn timed after each plan. It is the same prompt every time so only the model
// state changes between samples.
function menuProbe() {
  for (const name of ['v2-outside-unaware-near.json', 'v2-day-searched-house.json', 'v2-night-outside.json']) {
    const { percept, memory } = loadFixture(name);
    const plan = planTurn(percept, memory, { now: 1_000_000 });
    if (plan.options && plan.options.length) {
      const user = plan.user || userMessage(percept, memory, plan.options, selectRules(percept, memory), [], []);
      return { user, ids: plan.options.map((o) => o.id) };
    }
  }
  throw new Error('no fixture gives a menu to time');
}

if (!planner) {
  console.error('usage: node bridge/tools/planner-bench.mjs <planner model> [--runs 3] [--gpu N] [--out file.jsonl]');
  process.exit(2);
}

const probe = menuProbe();

// Put the menu model in memory and time two warm turns, so the baseline is the real one.
async function baseline() {
  await callChoice(probe.user, probe.ids, menuModel);
  const a = await callChoice(probe.user, probe.ids, menuModel);
  const b = await callChoice(probe.user, probe.ids, menuModel);
  return Math.round((a.ms + b.ms) / 2);
}

console.log(`# planner ${planner}${gpu != null ? ` num_gpu=${gpu}` : ''}, menu ${menuModel}`);
const before0 = await loaded();
console.log(`loaded at start: ${show(before0)}`);
const base = await baseline();
console.log(`menu baseline (warm, nothing else running): ${base} ms`);

const rows = [];
for (let r = 1; r <= runs; r++) {
  for (const name of names) {
    const { percept, memory } = loadFixture(`v2-${name}.json`);
    const reasons = CASES[name] || ['interval'];
    const user = planPrompt({ p: percept, mem: memory, reasons, plan: null, lessons: [] });
    const known = knownBuildings(memory, percept, 50).map((k) => k.id);
    const psBefore = await loaded();
    const row = {
      planner, gpu, fixture: name, run: r, plannerLoaded: has(psBefore, planner), menuLoaded: has(psBefore, menuModel),
      planMs: 0, parsed: false, homeOk: false, home: '', known, think: null, plan: null, error: '', menuMs: 0, menuOk: false, duringMs: null,
      baseMs: base, psAfterPlan: [],
    };
    try {
      const planCall = callPlanner({ system: PLAN_SYSTEM, user, schema: planSchema(), model: planner, timeout, gpuLayers: gpu });
      // A menu turn that arrives while the plan runs. It does not wait for the plan; it shares the machine with it.
      const mid = during ? new Promise((r) => setTimeout(r, 1500)).then(() => callChoice(probe.user, probe.ids, menuModel)).then((m) => { row.duringMs = m.ms; }, () => { row.duringMs = -1; }) : null;
      const reply = await planCall;
      if (mid) await mid;
      row.planMs = reply.ms;
      row.think = reply.think;
      try {
        const plan = parsePlan(reply.raw, known);
        row.parsed = true;
        row.plan = plan;
        row.home = plan.home;
        // parsePlan blanks a home that is not a known id, so an empty home on a fixture with
        // buildings means the model named something that does not exist (or named none).
        row.homeOk = known.length > 0 && plan.home !== '';
      } catch (err) {
        row.error = `parse: ${err.message}; raw: ${String(reply.raw).slice(0, 160)}`;
      }
    } catch (err) {
      row.error = String(err.message).slice(0, 200);
    }
    row.psAfterPlan = await loaded();
    const t = Date.now();
    try {
      const m = await callChoice(probe.user, probe.ids, menuModel);
      row.menuMs = m.ms;
      row.menuOk = true;
    } catch (err) {
      row.menuMs = Date.now() - t;
      row.error += ` menu: ${err.message}`;
    }
    row.psAfterMenu = await loaded();
    rows.push(row);
    if (out) fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.log(
      `${name.padEnd(22)} run ${r}  plan ${String(row.planMs).padStart(6)} ms${row.plannerLoaded ? '' : ' (cold)'}  parsed=${row.parsed}  home=${row.home || '-'}${row.homeOk ? '' : ' (not a known id)'}  menu ${String(row.menuMs).padStart(5)} ms${row.menuLoaded ? '' : ' (was unloaded)'}${row.duringMs != null ? `  during plan ${row.duringMs} ms` : ''}`,
    );
    if (row.plan) console.log(`    goal: ${row.plan.goal} | ${row.plan.steps.join('; ')}`);
    if (row.error) console.log(`    error: ${row.error}`);
    console.log(`    after plan: ${show(row.psAfterPlan)}`);
    console.log(`    after menu: ${show(row.psAfterMenu)}`);
  }
}

const ok = rows.filter((x) => x.planMs && !x.error.startsWith('parse') && x.parsed);
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const warm = rows.filter((x) => x.plannerLoaded && x.planMs).map((x) => x.planMs);
const cold = rows.filter((x) => !x.plannerLoaded && x.planMs).map((x) => x.planMs);
const menus = rows.filter((x) => x.menuOk).map((x) => x.menuMs);
console.log(`\nsummary ${planner}${gpu != null ? ` num_gpu=${gpu}` : ''}: ${rows.length} plans, parsed ${ok.length}, home ok ${rows.filter((x) => x.homeOk).length}`);
console.log(`plan ms: cold ${cold.join('/') || '-'}  warm median ${med(warm)}  max ${Math.max(0, ...warm, ...cold)}`);
const mids = rows.filter((x) => x.duringMs > 0).map((x) => x.duringMs);
if (mids.length) console.log(`menu ms during plan: median ${med(mids)}  max ${Math.max(...mids)}`);
console.log(`menu ms after plan: median ${med(menus)}  max ${Math.max(0, ...menus)}  slow (>1000) ${menus.filter((m) => m > 1000).length}/${menus.length}  baseline ${base}`);
