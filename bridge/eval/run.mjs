// The scoreboard. Runs every scenario through the real turn path (options, policy, prompt,
// model) and counts how often the pick is one a good player would accept.
//
//   node bridge/eval/run.mjs                      default model, 3 runs each
//   node bridge/eval/run.mjs --model llama3.1:8b --n 2
//   node bridge/eval/run.mjs --only bleeding      one scenario
//   node bridge/eval/run.mjs --backend jev        Jev's choice over the same menus (needs TYPESAFE_API_KEY)
//
// A report, not a test: the exit code is always 0. The default backend needs Ollama on OLLAMA_URL.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadScenarios, buildScenario } from './scenarios.mjs';
import { planTurn } from '../brain.mjs';
import { callChoice, parseChoice, MODEL } from '../llm.mjs';
import { memoryStats } from '../memory.mjs';
import { MODEL as JEV_MODEL, settingsFromEnv, situationText, buildRequest, parseReply, postJev } from '../critic.mjs';

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
// Nearest-rank percentile. With a handful of samples p90 is the slowest or second slowest.
const p90 = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
};

function grade(s, id) {
  if ((s.accept || []).includes(id)) return 'accepted';
  if ((s.wrong || []).includes(id)) return 'wrong';
  return 'other';
}

// A backend answers one menu turn. Each has: label, ready() (an empty string, or why it cannot run),
// warm() (one throwaway call so loading is not counted), pick(plan, built) -> { choice, ms }.
export function ollamaBackend(model = MODEL, base = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434') {
  return {
    label: model,
    async ready() {
      try {
        return (await fetch(base() + '/api/tags')).ok ? '' : 'Ollama is not reachable. Start it, or set OLLAMA_URL, then run this again.';
      } catch {
        return 'Ollama is not reachable. Start it, or set OLLAMA_URL, then run this again.';
      }
    },
    // The first call loads the model, which would sit in the first scenario's latency.
    async warm() {
      await callChoice('SITUATION:\nwarm up\n\nOPTIONS:\nwait: wait\n\nPick one id: wait.', ['wait'], model);
    },
    async pick(plan) {
      const ids = plan.options.map((o) => o.id);
      const r = await callChoice(plan.user, ids, model);
      return { choice: parseChoice(r.raw, ids).choice, ms: r.ms };
    },
  };
}

// Jev's choice question over the scenario's menu, scored like a model. It is shown the same
// situation text the critic sends (the digest and the last orders), not the playbook rules, the
// plan or the lessons, so this measures the outside view and not the full prompt.
export function jevBackend({ env = process.env, fetch: doFetch = globalThis.fetch } = {}) {
  const cfg = settingsFromEnv(env);
  const timeout = Math.max(cfg.timeout, 10_000);
  const ask = async (body, ids) => {
    const { data, ms } = await postJev({ key: cfg.key, body, timeout, fetch: doFetch, url: cfg.url });
    return { parsed: parseReply(data, ids, { only: 'pick' }), ms };
  };
  return {
    label: `jev (${JEV_MODEL})`,
    async ready() {
      return cfg.key ? '' : 'TYPESAFE_API_KEY is not set. Set it in this shell, then run this again.';
    },
    async warm() {
      await ask(buildRequest({ state: 'warm up', menu: [{ id: 'wait', label: 'wait' }], choice: 'wait', only: 'pick' }), ['wait']);
    },
    async pick(plan, built) {
      const state = situationText(built.percept, memoryStats(built.memory), built.history, null);
      const { parsed, ms } = await ask(buildRequest({ state, menu: plan.options, choice: '', only: 'pick' }), plan.options.map((o) => o.id));
      return { choice: parsed.top, ms };
    },
  };
}

// One scenario, n times. A policy turn is deterministic, so it runs once and counts n times.
export async function runScenario(s, n, backend) {
  const built = buildScenario(s);
  const { percept, memory, plan: dayPlan, history } = built;
  const plan = planTurn(percept, memory, { now: 1_000_000, plan: dayPlan, history });
  const row = { name: s.name, kind: plan.kind, rule: plan.rule || (plan.policy && plan.policy.rule) || '',
    accepted: 0, wrong: 0, other: 0, bad: 0, ms: [], picks: [] };
  if (plan.kind === 'policy') {
    const g = grade(s, plan.policy.option.id);
    row[g] = n;
    row.picks.push(plan.policy.option.id);
    return row;
  }
  if (plan.kind !== 'ask') {
    row.skipped = true;
    return row;
  }
  for (let i = 0; i < n; i++) {
    try {
      const r = await backend.pick(plan, built);
      row.ms.push(r.ms);
      row[grade(s, r.choice)] += 1;
      row.picks.push(r.choice);
    } catch (err) {
      row.bad += 1;
      row.picks.push('error');
      row.lastError = String(err && err.message || err).slice(0, 80);
    }
  }
  return row;
}

// The table and the summary, one string per line.
export function formatRows(rows) {
  const out = ['\n| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const by = r.skipped ? `no order (${r.kind})` : r.kind === 'policy' ? `policy (${r.rule})` : 'model';
    out.push(`| ${r.name} | ${by} | ${r.accepted} | ${r.wrong} | ${r.other} | ${r.bad} | ${r.ms.length ? mean(r.ms) : '-'} | ${r.ms.length ? p90(r.ms) : '-'} | ${r.picks.join(' ')} |`);
  }

  const model_ = rows.filter((r) => r.kind === 'ask');
  const policy = rows.filter((r) => r.kind === 'policy');
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const all = model_.flatMap((r) => r.ms);
  const total = sum(model_, 'accepted') + sum(model_, 'wrong') + sum(model_, 'other') + sum(model_, 'bad');
  out.push(`\nModel turns: ${sum(model_, 'accepted')}/${total} accepted, ${sum(model_, 'wrong')} wrong, ${sum(model_, 'other')} other, ${sum(model_, 'bad')} bad replies. Mean ${mean(all)} ms, p90 ${p90(all)} ms.`);
  out.push(`Policy turns (no model): ${policy.length} scenarios, ${policy.filter((r) => r.accepted).length} accepted, ${policy.filter((r) => r.wrong).length} wrong.`);
  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) out.push(`No order at all: ${skipped.map((r) => r.name).join(', ')}.`);
  for (const r of rows.filter((x) => x.lastError)) out.push(`Error in ${r.name}: ${r.lastError}`);
  return out;
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

// out: where lines go (console.log, or a test's collector). backend can be passed in by a test.
export async function main(args = process.argv.slice(2), { out = console.log, backend: given = null } = {}) {
  const model = flag(args, 'model', MODEL);
  const n = Math.max(1, Number(flag(args, 'n', 3)) || 3);
  const only = flag(args, 'only', '');
  const which = flag(args, 'backend', 'ollama');
  if (!given && which !== 'ollama' && which !== 'jev') {
    out(`Unknown backend "${which}". Use ollama or jev.`);
    return 0;
  }
  const backend = given || (which === 'jev' ? jevBackend() : ollamaBackend(model));

  const scenarios = loadScenarios().filter((s) => !only || s.name === only);
  if (!scenarios.length) {
    out(`No scenario named "${only}".`);
    return 0;
  }
  const why = await backend.ready();
  if (why) {
    out(why);
    return 0;
  }
  out(`# ${backend.label}, ${n} run${n === 1 ? '' : 's'} per scenario`);
  try {
    await backend.warm();
  } catch (err) {
    out(`Warm-up failed: ${String(err && err.message || err).slice(0, 120)}`);
  }
  const rows = [];
  for (const s of scenarios) rows.push(await runScenario(s, n, backend));
  for (const line of formatRows(rows)) out(line);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
