// The critic against the real bridge process and a fake Jev on this machine. A policy turn sends an
// order with no model; the critic reviews it in the background. The real API is never called, every
// file lives in a temp folder, and the model is pointed at a port nothing listens on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLog } from './jsonl.mjs';

const BRIDGE = fileURLToPath(new URL('./pz-bridge.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const KEY = 'tsk-http-secret-789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// A Jev that gives all its probability to the last option on the menu. hang: never answers.
async function startFakeJev({ hang = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (hang) return;
      const ids = Object.keys(body.questions.pick.criteria);
      const top = ids[ids.length - 1];
      const probabilities = Object.fromEntries(ids.map((id) => [id, id === top ? 1 - 0.02 * (ids.length - 1) : 0.02]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-1.14.0',
        answers: {
          pick: { type: 'choice', choice: top, confidence: 0.9, probabilities },
          danger: { type: 'noul', noul: 0.8 }, treat: { type: 'noul', noul: 0.1 }, mistake: { type: 'noul', noul: 0.7 },
        },
        usage: { input_tokens: 468, output_tokens: 12 },
      }));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${port}/v1/systemone`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// Starts the bridge on a night-outside percept (a policy turn) and returns handles on it.
async function startBridge(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-critic-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  const percept = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'v2-night-outside.json'), 'utf8'));
  fs.writeFileSync(path.join(lua, 'local_percept.txt'), JSON.stringify(percept));
  let out = '';
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: path.join(dir, 'decisions.jsonl'),
      PZ_NUDGES_FILE: path.join(dir, 'nudges.jsonl'), PZ_PEPE_FILE: path.join(dir, 'pepe.log'), PZ_PEPE: '0',
      OLLAMA_URL: 'http://127.0.0.1:9', TYPESAFE_API_KEY: '', PZ_CRITIC: '', PZ_CRITIC_URL: '', ...env,
    },
  });
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  return {
    dir, percept,
    output: () => out,
    state: () => get('/api/state'),
    html: async () => (await fetch(`http://127.0.0.1:${port}/mind`)).text(),
    intent: () => fs.readFileSync(path.join(lua, 'local_intent.txt'), 'utf8'),
    log: () => readLog(path.join(dir, 'decisions.jsonl')),
    stop: async () => {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('with a key the critic logs a line beside the decision and the strip shows it', async () => {
  const jev = await startFakeJev();
  const b = await startBridge({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_URL: jev.url });
  try {
    const s = await until(async () => {
      const st = await b.state();
      return st.reactions[0] && st.reactions[0].critic && st;
    }, 'the critic column to fill');
    const row = s.reactions[0];
    assert.equal(row.critic.flag, true, 'the brain\'s pick got 2%, under the 15% threshold');
    assert.equal(row.critic.pPick, 0.02);
    assert.ok(row.critic.top, 'Jev\'s own pick is shown when it differs');
    assert.equal(row.critic.danger, 0.8);
    assert.equal(s.critic.on, true);
    assert.equal(s.critic.ok, 1);
    assert.equal(s.critic.flagAt, 0.15);

    // What went out: one POST with the key in the header only, and game facts in the state.
    assert.equal(jev.seen.length, 1, 'one call for the one decision');
    const call = jev.seen[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.body.model, 'jev-latest');
    assert.deepEqual(Object.keys(call.body.questions), ['pick', 'danger', 'treat', 'mistake']);
    assert.match(call.body.state, /^Day \d+/);
    const sent = JSON.stringify(call.body) + call.url;
    assert.ok(!sent.includes(KEY), 'the key is not in the URL or the body');
    assert.ok(!sent.includes(b.dir) && !sent.includes(os.homedir()) && !sent.includes(os.userInfo().username), 'nothing from this PC');

    // The log: one decision, one critic line with the same id.
    const lines = b.log();
    const decision = lines.find((l) => l.t === 'decision');
    const critic = lines.filter((l) => l.t === 'critic');
    assert.equal(critic.length, 1);
    assert.equal(critic[0].id, decision.id);
    assert.equal(critic[0].pick, decision.choice);
    assert.equal(critic[0].flag, true);
    assert.deepEqual(Object.keys(call.body.questions.pick.criteria), decision.menu.map((m) => m.id), 'the exact menu the decision logged');

    // The page has the column, and the key is nowhere in what the bridge printed or served.
    const html = await b.html();
    assert.match(html, /<th>critic<\/th>/);
    assert.match(html, /function criticCell/);
    assert.ok(!html.includes(KEY));
    assert.ok(!JSON.stringify(s).includes(KEY));
    assert.ok(!b.output().includes(KEY), 'not in the console either');
  } finally {
    await b.stop();
    await jev.close();
  }
});

test('the critic changes nothing she does: the order line is the same with it on and off', async () => {
  const jev = await startFakeJev();
  const on = await startBridge({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_URL: jev.url });
  let withCritic;
  try {
    await until(async () => (await on.state()).critic.ok === 1, 'the critic to answer');
    withCritic = on.intent();
  } finally {
    await on.stop();
    await jev.close();
  }
  const off = await startBridge({ PZ_CRITIC: '0', TYPESAFE_API_KEY: KEY });
  try {
    await until(async () => (await off.state()).reactions.length, 'an order');
    assert.equal(off.intent(), withCritic);
    const s = await off.state();
    assert.equal(s.critic.on, false);
    assert.equal(s.critic.off, 'switched off with PZ_CRITIC=0');
    assert.equal(s.reactions[0].critic, null);
    assert.equal(off.log().filter((l) => l.t === 'critic').length, 0);
  } finally {
    await off.stop();
  }
});

test('no key: no request, no critic line, and /mind says why', async () => {
  const jev = await startFakeJev();
  const b = await startBridge({ PZ_CRITIC_URL: jev.url });
  try {
    const s = await until(async () => {
      const st = await b.state();
      return st.reactions.length && st;
    }, 'an order');
    assert.equal(s.critic.on, false);
    assert.equal(s.critic.off, 'no TYPESAFE_API_KEY set');
    await sleep(500);
    assert.equal(jev.seen.length, 0);
    assert.equal(b.log().filter((l) => l.t === 'critic').length, 0);
    assert.ok(b.log().some((l) => l.t === 'decision'), 'the decision is still logged');
  } finally {
    await b.stop();
    await jev.close();
  }
});

test('a Jev that never answers does not hold the order: it is written at once and the call times out', async () => {
  const jev = await startFakeJev({ hang: true });
  const b = await startBridge({ TYPESAFE_API_KEY: KEY, PZ_CRITIC_URL: jev.url, PZ_CRITIC_TIMEOUT: '300' });
  try {
    const s = await until(async () => {
      const st = await b.state();
      return st.reactions.length && st;
    }, 'an order');
    assert.match(b.intent(), /^\d+\|ENTER\|/, 'the order went out while Jev was still silent');
    assert.equal(s.reactions[0].critic, null);
    const later = await until(async () => {
      const st = await b.state();
      return st.critic.timeouts >= 1 && st;
    }, 'the call to time out');
    assert.match(later.critic.lastError, /timed out after 300 ms/);
    assert.equal(b.log().filter((l) => l.t === 'critic').length, 0);
  } finally {
    await b.stop();
    await jev.close();
  }
});
