// Prove the checks fail on a broken file. A check that cannot fail is not a check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHarness, REPO } from './lua-harness.mjs';

const LUA_CHECK = path.join(REPO, 'tools/lua-check.mjs');

function withTree(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fixture-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function check(files) {
  return withTree(files, (dir) => spawnSync(process.execPath, [LUA_CHECK, dir], { encoding: 'utf8' }));
}

test('lua-check passes a good file', () => {
  const r = check({ 'ok.lua': 'local x = 1\nreturn x\n' });
  assert.equal(r.status, 0, r.stderr);
});

test('lua-check fails a syntax error and names the line', () => {
  const r = check({ 'bad.lua': 'local x = 1\nlocal y = = 2\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.lua|^.*:2:/m);
  assert.match(r.stderr, /:2:/);
});

for (const [label, source] of [
  ['goto', 'goto done\n::done::\n'],
  ['the // operator', 'local x = 7 // 2\n'],
  ['a bitwise operator', 'local x = 1 << 2\n'],
]) {
  test(`lua-check rejects ${label} (not Lua 5.1)`, () => {
    const r = check({ 'new.lua': source });
    assert.equal(r.status, 1, `${label} was accepted`);
  });
}

test('lua-check fails when there is nothing to check', () => {
  assert.equal(check({ 'readme.txt': 'no lua here' }).status, 1);
});

test('the load test fails on a file that errors while loading', () => {
  withTree({ 'LocalSurvivor/Boom.lua': 'LocalSurvivor = LocalSurvivor or {}\nthisFunctionDoesNotExist()\n' }, (root) => {
    const lua = createHarness({ root });
    assert.throws(() => lua.requireModule('LocalSurvivor/Boom'), /thisFunctionDoesNotExist/);
  });
});

test('the load test fails on a missing module', () => {
  withTree({ 'LocalSurvivor/A.lua': 'require "LocalSurvivor/Nope"\n' }, (root) => {
    const lua = createHarness({ root });
    assert.throws(() => lua.requireModule('LocalSurvivor/A'), /module not found: LocalSurvivor\/Nope/);
  });
});

test('the load test fails on a require loop, as the game does', () => {
  withTree({
    'LocalSurvivor/A.lua': 'require "LocalSurvivor/B"\n',
    'LocalSurvivor/B.lua': 'require "LocalSurvivor/A"\n',
  }, (root) => {
    const lua = createHarness({ root });
    assert.throws(() => lua.requireModule('LocalSurvivor/A'), /recursive require/);
  });
});

test('a file that is auto-loaded and also required runs once', () => {
  withTree({
    'Main.lua': 'require "LocalSurvivor/Dep"\n',
    'LocalSurvivor/Dep.lua': 'count = (count or 0) + 1\n',
  }, (root) => {
    const lua = createHarness({ root });
    lua.autoload();
    assert.equal(lua.get('count'), 1);
  });
});
