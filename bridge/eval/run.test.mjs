// The eval's Jev backend against a fake fetch. The real API is never called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from './scenarios.mjs';
import { jevBackend, ollamaBackend, runScenario, formatRows, main } from './run.mjs';

const KEY = 'tsk-eval-secret-456';
const scenario = (name) => loadScenarios().find((s) => s.name === name);

// A fake Jev that picks `want(ids)` with 0.9 and spreads the rest.
function fakeJev(want, { fail = 0 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    if (calls.length <= fail) return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) };
    const ids = Object.keys(body.questions.pick.criteria);
    const choice = want(ids);
    const rest = ids.filter((i) => i !== choice);
    const probabilities = Object.fromEntries(ids.map((i) => [i, i === choice ? (rest.length ? 0.9 : 1) : 0.1 / rest.length]));
    const data = { model: 'jev-1.14.0', answers: { pick: { type: 'choice', choice, confidence: 0.9, probabilities } }, usage: { input_tokens: 400, output_tokens: 8 } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  };
  fn.calls = calls;
  return fn;
}

test('the backend refuses to start without a key and says how to set it', async () => {
  const b = jevBackend({ env: {}, fetch: fakeJev(() => 'x') });
  assert.match(await b.ready(), /TYPESAFE_API_KEY is not set/);
  assert.equal(await jevBackend({ env: { TYPESAFE_API_KEY: KEY } }).ready(), '');
});

test('a scenario is asked as one choice over its own menu, and the pick is scored like a model\'s', async () => {
  const s = scenario('unsearched-house-here');
  const f = fakeJev((ids) => (ids.includes('search') ? 'search' : ids[0]));
  const row = await runScenario(s, 3, jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: f }));
  assert.equal(row.kind, 'ask');
  assert.deepEqual([row.accepted, row.wrong, row.other, row.bad], [3, 0, 0, 0]);
  assert.deepEqual(row.picks, ['search', 'search', 'search']);
  assert.equal(row.ms.length, 3);
  assert.equal(f.calls.length, 3);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions), ['pick'], 'only the choice, so the eval costs the least it can');
  assert.equal(body.questions.pick.type, 'choice');
  assert.ok(Object.keys(body.questions.pick.criteria).includes('search'));
  assert.match(body.state, /^Day \d+/);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test('a wrong or other pick is counted as such, and a failed call is a bad reply', async () => {
  // The menu here is search, b1 and wait.
  const s = { ...scenario('unsearched-house-here'), accept: ['search'], wrong: ['b1'] };
  let n = 0;
  const f = fakeJev(() => {
    n += 1;
    return n === 1 ? 'b1' : n === 2 ? 'wait' : 'search';
  }, { fail: 1 });
  const row = await runScenario(s, 4, jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: f }));
  // Call 1 failed (bad), call 2 asked for b1 (wrong), call 3 for wait (other), call 4 search (accepted).
  assert.deepEqual([row.bad, row.wrong, row.other, row.accepted], [1, 1, 1, 1]);
  assert.equal(row.picks[0], 'error');
  assert.match(row.lastError, /http 500/);
});

test('a policy turn costs nothing: the rule decides, Jev is never asked', async () => {
  const f = fakeJev(() => 'x');
  const row = await runScenario(scenario('bleeding'), 3, jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: f }));
  assert.equal(row.kind, 'policy');
  assert.equal(row.accepted, 3);
  assert.equal(f.calls.length, 0);
});

test('--backend jev prints the same table and summary as the models, with Jev in the title', async () => {
  const f = fakeJev((ids) => ids[0]);
  const lines = [];
  const code = await main(['--backend', 'jev', '--only', 'unsearched-house-here', '--n', '2'], {
    out: (l) => lines.push(l), backend: jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: f }),
  });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /^# jev \(jev-latest\), 2 runs per scenario/);
  assert.match(text, /\| scenario \| by \| accepted \| wrong \| other \| bad reply \| mean ms \| p90 ms \| picks \|/);
  assert.match(text, /\| unsearched-house-here \| model \| \d \| \d \| \d \| 0 \| \d+ \| \d+ \| \S+ \S+ \|/);
  assert.match(text, /Model turns: \d\/2 accepted, \d wrong, \d other, 0 bad replies\. Mean \d+ ms, p90 \d+ ms\./);
  assert.match(text, /Policy turns \(no model\): 0 scenarios/);
  assert.equal(f.calls.length, 3, 'one warm-up and two scored calls');
});

test('--backend jev with no key stops with a message and exit code 0, calling nothing', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const lines = [];
    assert.equal(await main(['--backend', 'jev'], { out: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /TYPESAFE_API_KEY is not set/);
    assert.equal(lines.length, 1);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test('an unknown backend, or a scenario name that does not exist, is a message and not a crash', async () => {
  const lines = [];
  assert.equal(await main(['--backend', 'gpt'], { out: (l) => lines.push(l) }), 0);
  assert.match(lines[0], /Unknown backend "gpt"/);
  assert.equal(await main(['--only', 'nope'], { out: (l) => lines.push(l), backend: jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: fakeJev(() => 'x') }) }), 0);
  assert.match(lines[1], /No scenario named "nope"/);
});

test('a warm-up failure is reported and the run goes on', async () => {
  const lines = [];
  const f = fakeJev((ids) => ids[0], { fail: 1 });
  await main(['--only', 'unsearched-house-here', '--n', '1'], { out: (l) => lines.push(l), backend: jevBackend({ env: { TYPESAFE_API_KEY: KEY }, fetch: f }) });
  assert.match(lines.join('\n'), /Warm-up failed: http 500/);
  assert.match(lines.join('\n'), /Model turns: /);
});

test('the Ollama backend keeps the old output format', () => {
  const rows = [{ name: 's', kind: 'ask', rule: '', accepted: 2, wrong: 0, other: 1, bad: 0, ms: [300, 400, 500], picks: ['a', 'a', 'b'] }];
  const text = formatRows(rows).join('\n');
  assert.match(text, /\| s \| model \| 2 \| 0 \| 1 \| 0 \| 400 \| 500 \| a a b \|/);
  assert.match(text, /Model turns: 2\/3 accepted, 0 wrong, 1 other, 0 bad replies\. Mean 400 ms, p90 500 ms\./);
  assert.equal(ollamaBackend('m', () => 'http://127.0.0.1:9').label, 'm');
});
