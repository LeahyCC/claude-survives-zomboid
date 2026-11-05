// The death record end to end against the real bridge process: the mod's local_death.txt ends the
// live run, the cause and facts show in /api/stats and the /mind page source, and the decision log
// gets a death line that review.mjs counts. Same setup as nudge-http.test.mjs: a fixture percept, a
// model URL nothing listens on, every file in a temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLog } from './jsonl.mjs';
import { buildReport } from './tools/review.mjs';

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

// Ten samples ending in a SEARCH with two zombies on her and no reflex acting.
const RECORD = {
  id: 'game-1', day: 3, hours: 38.6, kills: 4, x: 10, y: 20, z: 0, text: 'You died.',
  ring: Array.from({ length: 9 }, (_, i) => ({
    hp: 90 - i * 10, zAdj: i > 5 ? 1 : 0, zChasing: 2, zClose: 3, job: 'SEARCH', order: 'SEARCH', status: 'running', reflex: 'none', inside: true,
  })),
  final: { hp: 0, zAdj: 2, zChasing: 2, zClose: 3, job: 'SEARCH', order: 'SEARCH', status: 'running', reflex: 'none', inside: true },
};

test('a death file from the mod ends the run with a cause, in the API, the page and the logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-death-'));
  const port = await freePort();
  const lua = path.join(dir, 'Lua');
  fs.mkdirSync(lua);
  const decisions = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(path.join(lua, 'local_percept.txt'), fs.readFileSync(path.join(FIXTURES, 'v2-night-outside.json'), 'utf8'));
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), PZ_LUA_DIR: lua, PZ_STATE_FILE: path.join(dir, 'state.json'),
      PZ_LESSONS_FILE: path.join(dir, 'lessons.json'), PZ_DECISIONS_FILE: decisions, PZ_NUDGES_FILE: path.join(dir, 'nudges.jsonl'),
      OLLAMA_URL: 'http://127.0.0.1:9',
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const stats = async () => (await fetch(`${base}/api/stats`)).json();
  try {
    await until(async () => (await stats()).current, 'a live run');
    fs.writeFileSync(path.join(lua, 'local_death.txt'), JSON.stringify(RECORD));
    const done = await until(async () => {
      const s = await stats();
      return s.runs.length && s;
    }, 'the run to end');
    assert.equal(done.current, null);
    const row = done.runs[0];
    assert.equal(row.cause, 'bitten while busy');
    assert.equal(row.death.job, 'SEARCH');
    assert.equal(row.death.zAdj, 2);
    assert.equal(row.death.source, 'mod');
    assert.match(row.death.summary, /^SEARCH, 2 close, 2 chasing, -90 hp in 10 s$/);

    const line = (await until(() => {
      const found = readLog(decisions).find((l) => l.t === 'death');
      return found || null;
    }, 'the death line'));
    assert.equal(line.cause, 'bitten while busy');
    assert.equal(line.job, 'SEARCH');
    assert.equal(line.zClose, 2);
    assert.equal(line.run, row.start);
    assert.match(buildReport({ decisions: readLog(decisions) }), /Deaths by cause\n {2}1x bitten while busy: doing SEARCH 1/);

    // The page has the column the table fills.
    const page = await (await fetch(`${base}/mind`)).text();
    assert.match(page, /<th>last seconds<\/th>/);
    // Reading the same file again does not end anything twice.
    fs.writeFileSync(path.join(lua, 'local_death.txt'), JSON.stringify(RECORD));
    await sleep(1500);
    assert.equal(readLog(decisions).filter((l) => l.t === 'death').length, 1);
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
