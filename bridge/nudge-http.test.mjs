// The nudge POST against the real bridge process: the x-mind header, both modes, and the refusal
// while the reflex owns the moment. The percept is a fixture on disk, the model is pointed at a port
// nothing listens on (a policy turn needs no model), and every file lives in a temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

async function withBridge(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-http-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  const files = {
    percept: path.join(lua, 'local_percept.txt'), intent: path.join(lua, 'local_intent.txt'),
    decisions: path.join(dir, 'decisions.jsonl'), nudges: path.join(dir, 'nudges.jsonl'),
  };
  const setPercept = (name) => fs.writeFileSync(files.percept, fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  setPercept('v2-night-outside.json');
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: files.decisions, PZ_NUDGES_FILE: files.nudges,
      OLLAMA_URL: 'http://127.0.0.1:9', PZ_EXAMPLES: '1',
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const post = (body, headers = { 'x-mind': '1', 'content-type': 'application/json' }) => fetch(`${base}/api/nudge`, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    await fn({ base, files, state, post, setPercept });
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the nudge POST: header, both modes, and the refusal while the reflex owns the moment', async () => {
  await withBridge(async ({ files, state, post, setPercept }) => {
    // The night-outside policy picks b1 with no model, and that turn's menu is what the page shows.
    const s0 = await until(async () => {
      const s = await state();
      return s.nudge && s.nudge.options.length && s;
    }, 'a menu on the page');
    const serial = s0.nudge.serial;
    assert.equal(s0.nudge.brain, 'b1');
    assert.match(s0.turn.decidedBy, /policy/);
    const intentBefore = fs.readFileSync(files.intent, 'utf8');
    assert.match(intentBefore, /\|ENTER\|/);

    // No x-mind header: refused before anything is read or written.
    const bare = await post({ mode: 'log', turn: serial, pick: 'b2' }, { 'content-type': 'application/json' });
    assert.equal(bare.status, 403);
    assert.equal(fs.existsSync(files.nudges), false);

    // Junk bodies are 400s and write nothing.
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post({ mode: 'log', turn: serial })).status, 400);
    assert.equal((await post({ mode: 'now', turn: serial, missing: 'a ladder' })).status, 400);
    assert.equal((await post({ mode: 'log', turn: serial, pick: 'nope' })).status, 400);
    assert.equal(fs.existsSync(files.nudges), false);

    // Just log it: a line in nudges.jsonl, and the order file is untouched.
    const logged = await post({ mode: 'log', turn: serial, pick: 'b2', why: 'the shop has food', missing: 'wait for dawn' });
    assert.equal(logged.status, 200);
    const loggedBody = await logged.json();
    assert.equal(loggedBody.ok, true);
    assert.equal(loggedBody.applied, false);
    assert.equal(fs.readFileSync(files.intent, 'utf8'), intentBefore);
    let lines = readLog(files.nudges);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].pick, 'b2');
    assert.equal(lines[0].pickVerb, 'ENTER');
    assert.equal(lines[0].why, 'the shop has food');
    assert.equal(lines[0].missing, 'wait for dawn');
    assert.equal(lines[0].brain.id, 'b1');
    assert.equal(lines[0].mode, 'log');
    assert.equal(lines[0].percept.hour, 22);
    assert.ok(lines[0].menu.length >= 2);
    assert.equal((await state()).nudges, 1);

    // Do it now: the order goes out as the next intent, through the same writer a policy order uses.
    const now = await post({ mode: 'now', turn: serial, pick: 'b2', why: 'the shop has food' });
    assert.equal(now.status, 200);
    assert.equal((await now.json()).applied, true);
    const intentAfter = fs.readFileSync(files.intent, 'utf8');
    assert.notEqual(intentAfter, intentBefore);
    const fields = intentAfter.trim().split('|');
    const firstSeq = Number(intentBefore.split('|')[0]);
    assert.equal(Number(fields[0]), firstSeq + 1, 'the next sequence number');
    assert.equal(fields[1], 'ENTER');
    assert.match(fields[5], /Colin picked this: the shop has food/);
    lines = readLog(files.nudges);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].applied, true);
    const s1 = await state();
    assert.equal(s1.turn.choice, 'b2');
    assert.match(s1.turn.decidedBy, /nudge/);

    // Both orders are in the decision log, the second one tagged as his.
    const decisions = readLog(files.decisions).filter((l) => l.t === 'decision');
    assert.deepEqual(decisions.map((d) => d.by), ['policy', 'nudge']);
    assert.equal(decisions[1].choice, 'b2');
    assert.equal(decisions[1].seq, firstSeq + 1);

    // A chaser walks in: the reflex owns the moment, so "Do it now" is refused and nothing is sent.
    setPercept('v2-outside-chased.json');
    await until(async () => (await state()).turn.kind === 'hold', 'the hold');
    const held = await post({ mode: 'now', turn: serial, pick: 'b2' });
    assert.equal(held.status, 409);
    const heldBody = await held.json();
    assert.equal(heldBody.ok, false);
    assert.match(heldBody.message, /reflex owns this moment/);
    assert.equal(fs.readFileSync(files.intent, 'utf8'), intentAfter);
    assert.equal(readLog(files.nudges).length, 2, 'a refused nudge is not logged');
    // Logging still works against the menu he was looking at.
    assert.equal((await post({ mode: 'log', turn: serial, pick: 'b1', why: 'still the better door' })).status, 200);
    assert.equal(readLog(files.nudges).length, 3);
  });
});
