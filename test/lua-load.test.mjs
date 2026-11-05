// Every Lua file has to load the way the game loads it: no error, each file runs once, the
// entry file registers its events once, and the namespace exposes every module.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, CLIENT_DIR } from './lua-harness.mjs';

const MODULE_DIR = path.join(CLIENT_DIR, 'LocalSurvivor');
const moduleNames = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith('.lua')).map((f) => f.slice(0, -4));

test('there are modules to check', () => {
  assert.ok(moduleNames.length >= 6, `found ${moduleNames.join(', ')}`);
});

for (const name of moduleNames) {
  test(`${name}.lua loads on its own`, () => {
    // Fresh state, so a module that forgot to require a dependency fails here.
    const lua = createHarness();
    lua.requireModule(`LocalSurvivor/${name}`);
    assert.equal(typeof lua.get(`LocalSurvivor.${name}`), 'object');
  });
}

test('the entry file loads on its own', () => {
  const lua = createHarness();
  lua.requireModule('LocalSurvivor');
  assert.equal(lua.eventCount('OnTick'), 1);
});

for (const reverse of [false, true]) {
  test(`auto-load in ${reverse ? 'reverse' : 'forward'} order runs each file once`, () => {
    const lua = createHarness();
    const names = lua.autoload({ reverse });
    assert.equal(names.length, moduleNames.length + 1);
    for (const [name, count] of lua.loadCounts) assert.equal(count, 1, `${name} ran ${count} times`);
    assert.equal(lua.loadCounts.size, names.length);
  });
}

test('the entry file registers an OnTick handler and the other events, once each', () => {
  const lua = createHarness();
  lua.autoload();
  assert.equal(lua.eventCount('OnTick'), 1);
  assert.equal(lua.eventCount('OnGameStart'), 1);
  assert.equal(lua.eventCount('OnCreatePlayer'), 1);
  assert.equal(lua.eventCount('OnKeyPressed'), 1);
});

test('the namespace exposes every module', () => {
  const lua = createHarness();
  lua.autoload();
  for (const name of moduleNames) {
    assert.equal(lua.run(`return type(LocalSurvivor.${name})`), 'table', `LocalSurvivor.${name}`);
  }
  assert.equal(lua.run('return type(LocalSurvivor.onTick)'), 'function');
  assert.equal(lua.run('return type(LocalSurvivor.verbs)'), 'table');
  assert.equal(lua.run('return type(LocalSurvivor.setResult)'), 'function');
});

test('running every file a second time keeps state and registers no event twice', () => {
  const lua = createHarness();
  lua.autoload();
  lua.set('LocalSurvivor.lastSeq', 7);
  lua.set('LocalSurvivor.tick', 123);
  lua.set('LocalSurvivor.travel.active', true);
  lua.set('LocalSurvivor.reflexState.closingIn', true);
  for (const name of lua.listModules()) lua.reloadModule(name);
  assert.equal(lua.get('LocalSurvivor.lastSeq'), 7);
  assert.equal(lua.get('LocalSurvivor.tick'), 123);
  assert.equal(lua.get('LocalSurvivor.travel.active'), true);
  assert.equal(lua.get('LocalSurvivor.reflexState.closingIn'), true);
  assert.equal(lua.eventCount('OnTick'), 1);
  assert.equal(lua.eventCount('OnKeyPressed'), 1);
});

test('the OnTick handler survives a tick with no player', () => {
  const lua = createHarness();
  lua.autoload();
  lua.fireEvent('OnTick');
  assert.equal(lua.get('LocalSurvivor.tick'), 1);
});
