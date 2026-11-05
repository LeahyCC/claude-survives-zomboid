// The Reactions strip against the real bridge process. A policy turn sends an order with no model,
// then the percept reports the order failed, and /api/state must show the row change. Every file
// lives in a temp folder and the model is pointed at a port nothing listens on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('the strip shows an order running, then failed with the hp it cost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-react-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  const perceptFile = path.join(lua, 'local_percept.txt');
  const intentFile = path.join(lua, 'local_intent.txt');
  const percept = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'v2-night-outside.json'), 'utf8'));
  const put = (o) => fs.writeFileSync(perceptFile, JSON.stringify(o));
  put(percept);
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: path.join(dir, 'decisions.jsonl'),
      PZ_NUDGES_FILE: path.join(dir, 'nudges.jsonl'), OLLAMA_URL: 'http://127.0.0.1:9',
    },
  });
  const state = async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  try {
    const first = await until(async () => {
      const s = await state();
      return s.reactions && s.reactions.length && s;
    }, 'a first row in the strip');
    assert.equal(first.reactions.length, 1);
    assert.match(first.reactions[0].choice, /^ENTER (house|shop|building) [NESW]+$/);
    assert.equal(first.reactions[0].status, 'running');
    assert.equal(first.reactions[0].hp, null);
    assert.equal(first.reactions[0].next, null);

    // The body reports the walk failed, after a zombie cost her 20 HP.
    const seq = Number(fs.readFileSync(intentFile, 'utf8').split('|')[0]);
    put({ ...percept, hp: percept.hp - 20, lastSeq: seq, res: { seq, status: 'failed', verb: 'ENTER', why: 'zombie', target: '' } });
    const failed = await until(async () => {
      const s = await state();
      return s.reactions[0] && s.reactions[0].status === 'failed' && s;
    }, 'the row to read failed');
    const row = failed.reactions[0];
    assert.equal(row.result, 'failed, zombies at the door, lost 20 HP');
    assert.equal(row.hp, -20);
    assert.ok(row.at > 0);
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
