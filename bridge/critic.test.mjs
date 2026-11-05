import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  settingsFromEnv, situationText, cleanMenu, buildRequest, parseReply, isFlag, criticLine, createCritic,
  API_URL, MODEL, FLAG_DEFAULT, TIMEOUT_DEFAULT, BACKOFF_FIRST_MS, BACKOFF_MAX_MS,
} from './critic.mjs';
import { readFixture } from './fixtures/load.mjs';

const KEY = 'tsk-test-secret-123';
const MENU = [
  { id: 'b1', label: 'walk into house 9 tiles N, not visited' },
  { id: 'away', label: 'walk quietly 15 tiles W' },
  { id: 'keep', label: 'keep doing what she is doing' },
];

// A reply in the documented shape. p is the pick's probabilities by id.
const reply = (o = {}) => ({
  model: 'jev-1.14.0',
  answers: {
    pick: { type: 'choice', choice: 'away', confidence: 0.8, probabilities: { b1: 0.05, away: 0.9, keep: 0.05 }, ...(o.pick || {}) },
    danger: { type: 'noul', noul: 0.7, ...(o.danger || {}) },
    treat: { type: 'noul', noul: 0.1, ...(o.treat || {}) },
    mistake: { type: 'noul', noul: 0.9, ...(o.mistake || {}) },
  },
  usage: { input_tokens: 468, output_tokens: 12 },
});

// A stand-in for fetch. `answer` is the body, a status, or a function that gets the call.
function fakeFetch(answer = reply()) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = typeof answer === 'function' ? await answer(calls.length, url, init) : answer;
    if (a && a.status) {
      return { ok: false, status: a.status, headers: { get: (k) => (a.headers || {})[k] ?? null }, text: async () => a.text || '', json: async () => { throw new Error('no json'); } };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => a, text: async () => JSON.stringify(a) };
  };
  fn.calls = calls;
  return fn;
}

function make(fetch, env = {}, extra = {}) {
  const lines = [];
  const logs = [];
  const clock = { t: 1_000_000 };
  const critic = createCritic({
    env: { TYPESAFE_API_KEY: KEY, ...env }, fetch, write: (l) => { lines.push(l); return true; },
    now: () => clock.t, log: (k, t) => logs.push(`${k}: ${t}`), ...extra,
  });
  return { critic, lines, logs, clock };
}

const review = (critic, o = {}) => critic.review({ id: 'id-1', state: 'Day 1.', menu: MENU, choice: 'b1', ...o });

test('settings: the key, the switches and the numbers', () => {
  assert.equal(settingsFromEnv({}).off, 'no TYPESAFE_API_KEY set');
  assert.equal(settingsFromEnv({ TYPESAFE_API_KEY: '  ' }).off, 'no TYPESAFE_API_KEY set');
  assert.equal(settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC: '0' }).off, 'switched off with PZ_CRITIC=0');
  const on = settingsFromEnv({ TYPESAFE_API_KEY: KEY });
  assert.deepEqual([on.off, on.flag, on.timeout, on.url], ['', FLAG_DEFAULT, TIMEOUT_DEFAULT, API_URL]);
  assert.equal(FLAG_DEFAULT, 0.15);
  assert.equal(TIMEOUT_DEFAULT, 3000);
  const set = settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_FLAG: '0.3', PZ_CRITIC_TIMEOUT: '1500' });
  assert.deepEqual([set.flag, set.timeout], [0.3, 1500]);
  // A bad number falls back instead of turning the critic into a flag-everything machine.
  const bad = settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_FLAG: 'lots', PZ_CRITIC_TIMEOUT: '-5' });
  assert.deepEqual([bad.flag, bad.timeout], [FLAG_DEFAULT, TIMEOUT_DEFAULT]);
  assert.equal(settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_FLAG: '7' }).flag, FLAG_DEFAULT);
  assert.equal(settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_FLAG: '' }).flag, FLAG_DEFAULT);
  assert.equal(settingsFromEnv({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_FLAG: '0' }).flag, 0, '0 is a real value: never flag');
});

test('the situation is the digest plus how her last orders went, and only game facts', () => {
  const p = readFixture('v2-night-outside.json');
  const text = situationText(p, { buildings: 3, visited: 1, searched: 1 }, [
    { id: 'a', seq: 1, at: 1, run: null, verb: 'ENTER', name: 'ENTER house N', result: 'failed', why: 'zombie', hp: -5, lost: 5, chase: 1 },
  ]);
  assert.match(text, /^Day \d+, /);
  assert.match(text, /Health \d+/);
  assert.match(text, /Her last orders:\n- ENTER house N: failed, zombies at the door/);
  assert.equal(situationText(p, null, []).includes('Her last orders'), false, 'no history, no section');
  assert.doesNotMatch(text, /[A-Z]:[\\/]|Users|@/, 'no paths and no addresses');
});

test('the request: model, state, a choice over the exact menu and three yes/no questions', () => {
  const req = buildRequest({ state: 'Day 1.', menu: MENU, choice: 'b1' });
  assert.equal(req.model, 'jev-latest');
  assert.equal(MODEL, 'jev-latest');
  assert.equal(req.state, 'Day 1.');
  assert.deepEqual(Object.keys(req.questions), ['pick', 'danger', 'treat', 'mistake']);
  assert.equal(req.questions.pick.type, 'choice');
  assert.deepEqual(req.questions.pick.criteria, {
    b1: 'walk into house 9 tiles N, not visited', away: 'walk quietly 15 tiles W', keep: 'keep doing what she is doing',
  });
  assert.ok(req.questions.pick.instructions.length > 20);
  for (const k of ['danger', 'treat', 'mistake']) {
    assert.equal(req.questions[k].type, 'noul');
    assert.equal(typeof req.questions[k].instructions, 'string');
  }
  assert.match(req.questions.danger.instructions, /serious danger right now/);
  assert.match(req.questions.treat.instructions, /treat her wounds before doing anything else/);
  assert.match(req.questions.mistake.instructions, /walk into house 9 tiles N, not visited/, 'names the brain\'s pick');
  assert.deepEqual(Object.keys(buildRequest({ state: 's', menu: MENU, choice: '', only: 'pick' }).questions), ['pick']);
  assert.equal(buildRequest({ state: 's', menu: [], choice: 'x' }), null);
});

test('the menu is cleaned: ids as strings, labels on one line and clipped, repeats and junk dropped', () => {
  const menu = cleanMenu([{ id: 'a', label: 'one\n  two' }, { id: 'a', label: 'again' }, null, 'x', { label: 'no id' }, { id: 7 }, { id: 'long', label: 'x'.repeat(400) }]);
  assert.deepEqual(menu.map((o) => o.id), ['a', '7', 'long']);
  assert.equal(menu[0].label, 'one two');
  assert.equal(menu[1].label, '7', 'no label falls back to the id');
  assert.equal(menu[2].label.length, 160);
  assert.deepEqual(cleanMenu(null), []);
});

test('the call: POST to the System One endpoint with the bearer key and a JSON body', async () => {
  const f = fakeFetch();
  const { critic } = make(f);
  await review(critic);
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal, 'it can be cut short');
  assert.equal(body.model, 'jev-latest');
  assert.ok(!url.includes(KEY), 'the key is never in the URL');
  assert.ok(!init.body.includes(KEY), 'nor in the body');
});

test('a good reply is written as one critic line with the same id and every field', async () => {
  const { critic, lines } = make(fakeFetch());
  const done = review(critic);
  assert.equal(lines.length, 0, 'fire and forget: review() returns before the answer is in');
  await done;
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.t, 'critic');
  assert.equal(l.id, 'id-1');
  assert.equal(l.pick, 'b1');
  assert.equal(l.top, 'away');
  assert.equal(l.pPick, 0.05);
  assert.equal(l.pTop, 0.9);
  assert.equal(l.confidence, 0.8);
  assert.deepEqual([l.danger, l.treat, l.mistake], [0.7, 0.1, 0.9]);
  assert.deepEqual([l.agree, l.flag, l.flagAt], [false, true, 0.15]);
  assert.deepEqual([l.inTokens, l.outTokens, l.model], [468, 12, 'jev-1.14.0']);
  assert.equal(typeof l.ms, 'number');
  assert.equal(new Date(l.at).toISOString(), l.at);
  assert.ok(!JSON.stringify(l).includes(KEY));
});

test('the flag rule: the brain pick under the threshold of Jev\'s probability', async () => {
  assert.equal(isFlag(0.149, 0.15), true);
  assert.equal(isFlag(0.15, 0.15), false, 'exactly at the threshold is not a flag');
  assert.equal(isFlag(0.9, 0.15), false);
  const answer = (pPick) => reply({ pick: { choice: 'away', probabilities: { b1: pPick, away: 1 - pPick, keep: 0 } } });
  const run = async (p, env) => { const m = make(fakeFetch(answer(p)), env); await review(m.critic); return m.lines[0]; };
  assert.equal((await run(0.14)).flag, true);
  assert.equal((await run(0.16)).flag, false);
  assert.equal((await run(0.16)).agree, false, 'a different top pick is not a flag by itself');
  assert.equal((await run(0.3, { PZ_CRITIC_FLAG: '0.5' })).flag, true, 'the threshold comes from PZ_CRITIC_FLAG');
  assert.equal((await run(0.3, { PZ_CRITIC_FLAG: '0.5' })).flagAt, 0.5);
  const same = make(fakeFetch(reply({ pick: { choice: 'b1', probabilities: { b1: 0.8, away: 0.1, keep: 0.1 } } })));
  await review(same.critic);
  assert.deepEqual([same.lines[0].agree, same.lines[0].flag], [true, false]);
});

test('reply validation: every field is checked and a bad reply writes nothing', async () => {
  const ids = ['b1', 'away', 'keep'];
  assert.equal(parseReply(reply(), ids).top, 'away');
  const bad = [
    ['not an object', null],
    ['no answers', {}],
    ['answers is a list', { answers: [] }],
    ['no pick', { answers: { danger: { noul: 0.1 } } }],
    ['pick off the menu', reply({ pick: { choice: 'sleep' } })],
    ['pick not a string', reply({ pick: { choice: 3 } })],
    ['no probabilities', reply({ pick: { probabilities: undefined } })],
    ['a menu id missing from the probabilities', reply({ pick: { probabilities: { b1: 0.5, away: 0.5 } } })],
    ['a probability that is a string', reply({ pick: { probabilities: { b1: '0.05', away: 0.9, keep: 0.05 } } })],
    ['a probability over 1', reply({ pick: { probabilities: { b1: 0.1, away: 1.4, keep: 0 } } })],
    ['a negative probability', reply({ pick: { probabilities: { b1: -0.2, away: 1.1, keep: 0.1 } } })],
    ['probabilities that do not sum to 1', reply({ pick: { probabilities: { b1: 0.1, away: 0.1, keep: 0.1 } } })],
    ['NaN confidence', reply({ pick: { confidence: NaN } })],
    ['no confidence', reply({ pick: { confidence: undefined } })],
    ['no danger answer', { ...reply(), answers: { ...reply().answers, danger: undefined } }],
    ['a danger that is not a number', reply({ danger: { noul: 'yes' } })],
    ['a treat over 1', reply({ treat: { noul: 1.5 } })],
    ['no mistake value', reply({ mistake: { noul: undefined } })],
  ];
  for (const [what, data] of bad) {
    assert.throws(() => parseReply(data, ids), Error, what);
    const m = make(fakeFetch(data));
    await review(m.critic);
    assert.equal(m.lines.length, 0, what);
    assert.equal(m.critic.view().ok, 0, what);
  }
  // Rounding on their side is not a fault.
  assert.equal(parseReply(reply({ danger: { noul: 1.0000001 } }), ids).danger, 1);
  // Bad usage numbers only cost the token counts, not the opinion.
  const odd = parseReply({ ...reply(), usage: { input_tokens: 'many', output_tokens: -3 } }, ids);
  assert.deepEqual([odd.inTokens, odd.outTokens], [0, 0]);
  assert.equal(parseReply({ ...reply(), usage: undefined, model: 7 }, ids).model, '');
  assert.equal(parseReply(reply(), ids, { only: 'pick' }).danger, undefined);
  assert.equal(parseReply({ answers: { pick: reply().answers.pick } }, ids, { only: 'pick' }).top, 'away');
});

test('at most one call in flight: a turn that finds one running is not reviewed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fakeFetch(async () => { await gate; return reply(); });
  const { critic, lines } = make(f);
  const first = review(critic, { id: 'a' });
  assert.ok(first);
  assert.equal(review(critic, { id: 'b' }), null);
  assert.equal(review(critic, { id: 'c' }), null);
  assert.equal(critic.view().busy, 2);
  release();
  await first;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(lines.map((l) => l.id), ['a']);
  assert.ok(review(critic, { id: 'd' }), 'free again once the call is done');
});

test('a slow answer is cut at the timeout, even if the fetch ignores the abort', async () => {
  const f = fakeFetch(() => new Promise(() => {}));
  const { critic, lines, logs } = make(f, { PZ_CRITIC_TIMEOUT: '40' });
  const started = Date.now();
  await review(critic);
  assert.ok(Date.now() - started < 1500, 'did not hang');
  assert.equal(lines.length, 0);
  assert.equal(critic.view().timeouts, 1);
  assert.match(critic.view().lastError, /timed out after 40 ms/);
  assert.equal(logs.length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true, 'the request was aborted');
  assert.ok(review(critic, { id: 'next' }), 'the slot is free again');
  assert.equal(critic.view().backoff, 0, 'a timeout is not a pause');
});

test('429 and 529 pause the critic, doubling each time, and a good answer resets it', async () => {
  let n = 0;
  const f = fakeFetch(() => (n++ < 3 ? { status: n === 2 ? 529 : 429 } : reply()));
  const { critic, lines, clock, logs } = make(f);
  await review(critic, { id: 'a' });
  assert.equal(critic.view().pausedMs, BACKOFF_FIRST_MS);
  assert.equal(review(critic, { id: 'skipped' }), null, 'paused');
  assert.equal(f.calls.length, 1);
  assert.equal(critic.view().backoff, 1);
  clock.t += BACKOFF_FIRST_MS - 1;
  assert.equal(review(critic, { id: 'still paused' }), null);
  clock.t += 1;
  await review(critic, { id: 'b' });
  assert.equal(critic.view().pausedMs, 2 * BACKOFF_FIRST_MS, 'second strike doubles it');
  clock.t += 2 * BACKOFF_FIRST_MS;
  await review(critic, { id: 'c' });
  assert.equal(critic.view().pausedMs, 4 * BACKOFF_FIRST_MS);
  clock.t += 4 * BACKOFF_FIRST_MS;
  await review(critic, { id: 'd' });
  assert.deepEqual(lines.map((l) => l.id), ['d']);
  assert.equal(critic.view().pausedMs, 0);
  // Strikes start over after a success.
  n = 0;
  await review(critic, { id: 'e' });
  assert.equal(critic.view().pausedMs, BACKOFF_FIRST_MS);
  assert.ok(logs.some((l) => /rate limited/.test(l)) && logs.some((l) => /overloaded/.test(l)));
});

test('the pause honors Retry-After and never goes past the cap', async () => {
  const slow = make(fakeFetch({ status: 429, headers: { 'retry-after': '90' } }));
  await review(slow.critic);
  assert.equal(slow.critic.view().pausedMs, 90_000);
  const huge = make(fakeFetch({ status: 429, headers: { 'retry-after': '99999' } }));
  await review(huge.critic);
  assert.equal(huge.critic.view().pausedMs, BACKOFF_MAX_MS);
  const many = make(fakeFetch({ status: 529 }));
  for (let i = 0; i < 12; i++) {
    many.clock.t += BACKOFF_MAX_MS;
    await review(many.critic, { id: `x${i}` });
  }
  assert.equal(many.critic.view().pausedMs, BACKOFF_MAX_MS);
});

test('other errors skip the turn quietly, and never throw', async () => {
  const cases = [
    () => ({ status: 500, text: 'boom' }),
    () => ({ status: 422, text: '{"detail":"bad question"}' }),
    () => ({ status: 400 }),
    () => ({ status: 413 }),
    () => { throw new TypeError('fetch failed'); },
    () => 'not json at all',
  ];
  for (const c of cases) {
    const f = fakeFetch(c);
    const { critic, lines, logs } = make(f);
    await assert.doesNotReject(review(critic));
    assert.equal(lines.length, 0);
    assert.equal(critic.view().ok, 0);
    assert.ok(critic.view().errors >= 1);
    assert.equal(logs.length, 1);
    assert.equal(critic.view().pausedMs, 0, 'no pause for these');
    assert.ok(review(critic, { id: 'again' }), 'the next turn is still reviewed');
  }
  // The same trouble twice is one log line, not one per turn.
  const m = make(fakeFetch({ status: 500 }));
  await review(m.critic);
  await review(m.critic, { id: 'two' });
  assert.equal(m.logs.length, 1);
});

test('a refused key (401) turns the critic off for the session, and the key is never logged', async () => {
  const echo = fakeFetch({ status: 401, text: `bad key ${KEY}` });
  const { critic, logs } = make(echo);
  await review(critic);
  assert.equal(critic.enabled, false);
  assert.match(critic.view().off, /401/);
  assert.equal(review(critic, { id: 'x' }), null);
  assert.equal(echo.calls.length, 1);
  const seen = JSON.stringify([logs, critic.view()]);
  assert.ok(!seen.includes(KEY), 'the key is scrubbed from every message');
  assert.ok(seen.includes('***'));
});

test('off: no key, or PZ_CRITIC=0, means no request at all', async () => {
  for (const env of [{ TYPESAFE_API_KEY: '' }, { PZ_CRITIC: '0' }]) {
    const f = fakeFetch();
    const { critic, lines } = make(f, env);
    assert.equal(critic.enabled, false);
    assert.equal(review(critic), null);
    assert.equal(f.calls.length, 0);
    assert.equal(lines.length, 0);
    assert.equal(critic.view().on, false);
    assert.ok(critic.view().off);
  }
  // No env key at all, even with a real-looking default environment.
  const f = fakeFetch();
  const bare = createCritic({ env: {}, fetch: f });
  assert.equal(bare.review({ id: 'x', state: 's', menu: MENU, choice: 'b1' }), null);
  assert.equal(f.calls.length, 0);
});

test('a turn without an id, or a pick that is not on the menu, is not reviewed', () => {
  const f = fakeFetch();
  const { critic } = make(f);
  assert.equal(critic.review({ state: 's', menu: MENU, choice: 'b1' }), null);
  assert.equal(critic.review({ id: 'x', state: 's', menu: MENU, choice: 'sleep' }), null);
  assert.equal(critic.review({ id: 'x', state: 's', menu: [], choice: 'b1' }), null);
  assert.equal(critic.review(), null);
  assert.equal(f.calls.length, 0);
});

test('the Critic column reads from rowFor: flag or agree, the pick\'s probability, Jev\'s pick when different', async () => {
  const { critic } = make(fakeFetch());
  assert.equal(critic.rowFor('id-1'), null);
  await review(critic);
  assert.deepEqual(critic.rowFor('id-1'), { agree: false, flag: true, pPick: 0.05, top: 'away', danger: 0.7, treat: 0.1, mistake: 0.9, confidence: 0.8, ms: critic.rowFor('id-1').ms });
  const same = make(fakeFetch(reply({ pick: { choice: 'b1', probabilities: { b1: 0.9, away: 0.05, keep: 0.05 } } })));
  await review(same.critic);
  assert.equal(same.critic.rowFor('id-1').top, null, 'nothing to show when Jev agrees');
  assert.equal(same.critic.view().ok, 1);
  assert.equal(JSON.stringify(same.critic.view()).includes(KEY), false);
});

test('only the latest rows are kept', async () => {
  const { critic } = make(fakeFetch());
  for (let i = 0; i < 45; i++) await review(critic, { id: `r${i}` });
  assert.equal(critic.rowFor('r0'), null);
  assert.ok(critic.rowFor('r44'));
});

test('criticLine rounds the numbers and carries the threshold it was judged by', () => {
  const parsed = parseReply(reply({ pick: { choice: 'away', probabilities: { b1: 0.123456, away: 0.8, keep: 0.076544 } } }), ['b1', 'away', 'keep']);
  const l = criticLine({ id: 'z', choice: 'b1', parsed, flagAt: 0.15, ms: 120, at: 0 });
  assert.equal(l.pPick, 0.123);
  assert.equal(l.flag, true);
  assert.equal(l.at, '1970-01-01T00:00:00.000Z');
});

test('nothing the critic says can reach the prompt or the order line: no brain module even imports it', () => {
  const dir = fileURLToPath(new URL('./', import.meta.url));
  for (const f of ['brain.mjs', 'llm.mjs', 'options.mjs', 'policy.mjs', 'playbook.mjs', 'planner.mjs', 'lessons.mjs', 'nudges.mjs', 'decide.mjs', 'commentator.mjs', 'digest.mjs', 'memory.mjs']) {
    // "critical" is a word the prompts use; the module is the whole word.
    assert.doesNotMatch(fs.readFileSync(dir + f, 'utf8'), /\bcritic\b|createCritic|critic\.mjs/i, `${f} knows nothing about the critic`);
  }
  // The bridge reads only the log-side calls: review() and the two views.
  const bridge = fs.readFileSync(dir + 'pz-bridge.mjs', 'utf8');
  const uses = [...bridge.matchAll(/(?<![.\w])critic\.(\w+)/g)].map((m) => m[1]).filter((u) => u !== 'mjs');
  assert.deepEqual([...new Set(uses)].sort(), ['enabled', 'review', 'rowFor', 'view']);
  assert.doesNotMatch(bridge, /plan\.user[^\n]*critic|orderLine\([^\n]*critic|send\([^\n]*critic/);
});

test('the numbers the docs quote', () => {
  assert.equal(BACKOFF_FIRST_MS, 15_000);
  assert.equal(BACKOFF_MAX_MS, 300_000);
});
