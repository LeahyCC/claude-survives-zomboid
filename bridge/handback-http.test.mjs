// The hand-back against the real bridge process and a fake Ollama on this machine. One zombie
// chases her and the reflex owns it, as in the 2026-11-05 soak. When the mod says the reflex has
// no way out (percept reflex.stuck) the bridge gives the model the escape menu and writes the
// order, and the decision line says it was handed back. Without that flag, nothing is written.
// Every file lives in a temp folder, and the real Ollama is never called.

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

// An Ollama that picks the first id of any menu it is asked about and records what it was asked.
async function startFakeOllama() {
  const asked = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* not ours */ }
      const ids = body.format && body.format.properties && body.format.properties.choice ? body.format.properties.choice.enum : null;
      if (ids) asked.push({ ids, user: (body.messages || []).map((m) => m.content).join('\n') });
      const content = ids ? JSON.stringify({ thought: 'Into the house and shut the door.', choice: ids[0] }) : '{}';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { asked, url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// The soak's character: unarmed, no breath, one chaser 8.4 tiles off, houses 12 and 28 tiles away.
function soakPercept(reflex) {
  const p = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'v2-outside-chased.json'), 'utf8'));
  return {
    ...p, weapon: 'none', weapons: [], endurance: 0, hp: 100, panic: 0, panic01: 0, bleeding: 0, wounds: [], weight: 2,
    moodle: { endurance: 3, heavy: 0, panic: 0, thirsty: 0, hungry: 0, tired: 0, pain: 0 },
    zChasing: 1, zClose: 1, zDist: 8.4, zVisible: 1, res: { seq: 31, status: 'running', verb: 'MOVE', why: '' },
    zList: [{ chase: true, crawl: false, d: 8.4, down: false, dx: 8, dy: 3 }],
    reflex,
  };
}

async function startBridge(percept, ollamaUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-handback-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  fs.writeFileSync(path.join(lua, 'local_percept.txt'), JSON.stringify(percept));
  let out = '';
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: path.join(dir, 'decisions.jsonl'),
      PZ_NUDGES_FILE: path.join(dir, 'nudges.jsonl'), PZ_PEPE_FILE: path.join(dir, 'pepe.log'), PZ_PEPE: '0',
      OLLAMA_URL: ollamaUrl, TYPESAFE_API_KEY: '', PZ_CRITIC: '0',
    },
  });
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const intentFile = path.join(lua, 'local_intent.txt');
  return {
    output: () => out,
    intent: () => (fs.existsSync(intentFile) ? fs.readFileSync(intentFile, 'utf8') : ''),
    log: () => readLog(path.join(dir, 'decisions.jsonl')),
    stop: async () => {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the reflex has no way out: the model gets the escape menu and the order goes out with a posture', async () => {
  const ollama = await startFakeOllama();
  const b = await startBridge(soakPercept({ stance: 'FLEE', why: 'stuck:unarmed', age: 1, hits60: 0, fails: 3, stuck: true }), ollama.url);
  try {
    await until(() => b.intent(), 'an order');
    assert.match(b.intent(), /^\d+\|ENTER\|0\|0\|\|Into the house and shut the door\.\|.+\|4031\|avoid\s*$/);
    const menu = ollama.asked.find((a) => a.ids.includes('away'));
    assert.deepEqual(menu.ids, ['b1', 'b2', 'away'], 'the short escape menu, not the usual one');
    assert.match(menu.user, /running is not shaking it/);
    const lines = await until(() => {
      const l = b.log();
      return l.some((x) => x.t === 'decision') && l;
    }, 'the decision line');
    const decision = lines.find((l) => l.t === 'decision');
    assert.equal(decision.handback.ms >= 0, true);
    assert.match(decision.handback.why, /no way out/);
    assert.equal(decision.sent, true);
    assert.match(b.output(), /Reflex hands the turn back/);
  } finally {
    await b.stop();
    await ollama.close();
  }
});

test('walking into a new house: the real bridge opens the house job, sends SECURE, and logs it', async () => {
  const ollama = await startFakeOllama();
  const quiet = {
    ...soakPercept(null), zList: [], zChasing: 0, zClose: 0, zDist: -1, zVisible: 0, endurance: 1, thirst: 0, hunger: 0, fatigue: 0, items: '',
    outside: false, inBldg: { id: '4031', room: 'kitchen', rooms: 3, roomsLeft: 3 }, res: null,
    moodle: { endurance: 0, heavy: 0, panic: 0, thirsty: 0, hungry: 0, tired: 0, pain: 0 },
  };
  const b = await startBridge(quiet, ollama.url);
  try {
    await until(() => b.intent(), 'an order');
    assert.match(b.intent(), /^\d+\|SECURE\|/);
    const lines = await until(() => {
      const l = b.log();
      return l.some((x) => x.t === 'house') && l.some((x) => x.t === 'decision') && l;
    }, 'the house line');
    const open = lines.find((l) => l.t === 'house');
    assert.equal(open.kind, 'open');
    assert.equal(open.bldg, '4031');
    assert.equal(open.stage, 'SHUT');
    assert.equal(lines.find((l) => l.t === 'decision').rule, 'house-job');
    // The child's stdout can land after the log file does, so this one waits too.
    await until(() => /house 4031: open at SHUT/.test(b.output()), 'the printed house line');
  } finally {
    await b.stop();
    await ollama.close();
  }
});

test('without the flag, and well inside the minute, the reflex keeps the chase and nothing is written', async () => {
  const ollama = await startFakeOllama();
  const b = await startBridge(soakPercept({ stance: 'FLEE', why: 'unarmed', age: 1, hits60: 0, fails: 1, stuck: false }), ollama.url);
  try {
    await sleep(3500);
    assert.equal(b.intent(), '');
    assert.equal(b.log().filter((l) => l.t === 'decision').length, 0);
    assert.equal(ollama.asked.filter((a) => a.ids.includes('away')).length, 0);
    assert.match(b.output(), /reflex owns it/);
  } finally {
    await b.stop();
    await ollama.close();
  }
});
