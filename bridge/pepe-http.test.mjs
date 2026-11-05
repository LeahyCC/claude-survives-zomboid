// The Peanut gallery panel against the real bridge process: lines saved in pepe.log come back after
// a restart, PZ_PEPE=0 turns it off, and the page has the panel. Every file lives in a temp folder
// and Ollama is pointed at a port nothing listens on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('./pz-bridge.mjs', import.meta.url));
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

async function withBridge(env, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-pepe-http-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  const pepeFile = path.join(dir, 'pepe.log');
  const rows = Array.from({ length: 12 }, (_, i) => JSON.stringify({ at: new Date(1_700_000_000_000 + i * 60_000).toISOString(), kind: 'kill', event: `event ${i}`, line: `saved line ${i}` }));
  fs.writeFileSync(pepeFile, rows.join('\n') + '\n');
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: path.join(dir, 'decisions.jsonl'),
      PZ_NUDGES_FILE: path.join(dir, 'nudges.jsonl'), PZ_PEPE_FILE: pepeFile, OLLAMA_URL: 'http://127.0.0.1:9', ...env,
    },
  });
  try {
    const state = await until(async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json(), 'the bridge');
    const page = await (await fetch(`http://127.0.0.1:${port}/mind`)).text();
    await check({ state, page });
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the last 10 saved lines are on /api/state after a restart, and the page has the panel', async () => {
  await withBridge({ PZ_PEPE: '1' }, ({ state, page }) => {
    assert.equal(state.pepe.on, true);
    assert.equal(state.pepe.lines.length, 10);
    assert.equal(state.pepe.lines[0].line, 'saved line 2');
    assert.equal(state.pepe.lines[9].line, 'saved line 11');
    assert.match(page, /<h2>Peanut gallery<\/h2>/);
    assert.match(page, /id="pepe"/);
  });
});

test('PZ_PEPE=0 turns it off but the saved lines still show', async () => {
  await withBridge({ PZ_PEPE: '0' }, ({ state }) => {
    assert.equal(state.pepe.on, false);
    assert.equal(state.pepe.lines.length, 10);
  });
});
