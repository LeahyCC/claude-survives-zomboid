// The playtest helper mod raises the loot options only while Zomboid/Lua/ls_loot.txt exists.
// The game itself is stubbed: a fake sandbox option object stands in for the Java one, and
// ItemPickerJava.InitSandboxLootSettings records what the options held when it was called.
// Whether the refresh really reaches the loot rolls is a live check, see docs/playtest.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import luaparse from 'luaparse';
import { createHarness, REPO } from './lua-harness.mjs';

const DEV_CLIENT = path.join(REPO, 'tools/dev-mod/LocalSurvivorDev/42/media/lua/client');
const DEV_FILE = path.join(DEV_CLIENT, 'LocalSurvivorDev.lua');

const RAISED = [
  'WeaponLootNew', 'RangedWeaponLootNew', 'AmmoLootNew', 'FoodLootNew', 'CannedFoodLootNew',
  'MedicalLootNew', 'SurvivalGearsLootNew', 'ContainerLootNew', 'ToolLootNew',
];
const UNTOUCHED = ['LiteratureLootNew', 'ClothingLootNew', 'KeyLootNew', 'RollsMultiplier'];

// Every option starts at 0.6 (the game's default) except RollsMultiplier, which starts at 1.
function world({ flag = true, max = 4, without = [], picker = true } = {}) {
  const lua = createHarness({ root: DEV_CLIENT });
  lua.autoload();
  lua.run(
    `
    local names, flag, max, without, picker = ...
    __opts = {}
    SandboxVars = {}
    for _, name in ipairs(names) do
      local start = (name == "RollsMultiplier") and 1 or 0.6
      SandboxVars[name] = start
      __opts[name] = {
        v = start,
        getValue = function(self) return self.v end,
        getMax = function() return max end,
        -- The game clamps to the option's range, and so does this.
        setValue = function(self, x) if x > max then x = max end self.v = x end,
      }
    end
    for _, name in ipairs(without) do __opts[name] = nil end
    function getSandboxOptions()
      return { getOptionByName = function(_, name) return __opts[name] end }
    end
    __refresh = { calls = 0, seen = {} }
    if picker then
      ItemPickerJava = { InitSandboxLootSettings = function()
        __refresh.calls = __refresh.calls + 1
        for name, o in pairs(__opts) do __refresh.seen[name] = o.v end
      end }
    end
    __files["ls_loot.txt"] = flag and "1" or nil
    `,
    [...RAISED, ...UNTOUCHED],
    flag,
    max,
    without,
    picker,
  );
  return lua;
}

const value = (lua, name) => lua.run('return __opts[...].v', name);
const sandboxVar = (lua, name) => lua.run('return SandboxVars[...]', name);
const calls = (lua) => lua.run('return __refresh.calls');
const lootLines = (lua) => lua.printed().filter((l) => l.startsWith('LocalSurvivorDev loot'));

test('no flag file: the options are left alone and nothing is printed', () => {
  const lua = world({ flag: false });
  lua.fireEvent('OnInitWorld');
  lua.fireEvent('OnLoadedMapZones');
  lua.fireEvent('OnGameStart');
  for (const name of RAISED) assert.equal(value(lua, name), 0.6, name);
  assert.equal(calls(lua), 0);
  assert.equal(lootLines(lua).length, 0);
});

test('flag file: the nine loot options go to 4, the others stay', () => {
  const lua = world();
  lua.fireEvent('OnInitWorld');
  lua.fireEvent('OnLoadedMapZones');
  for (const name of RAISED) {
    assert.equal(value(lua, name), 4, name);
    assert.equal(sandboxVar(lua, name), 4, `SandboxVars.${name}`);
  }
  for (const name of UNTOUCHED) {
    assert.equal(value(lua, name), name === 'RollsMultiplier' ? 1 : 0.6, name);
  }
});

test('the refresh runs once, after the options changed', () => {
  const lua = world();
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(calls(lua), 1);
  for (const name of RAISED) assert.equal(lua.run('return __refresh.seen[...]', name), 4, name);
});

test('one console line lists the old and new values', () => {
  const lua = world();
  lua.fireEvent('OnLoadedMapZones');
  const lines = lootLines(lua);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^LocalSurvivorDev loot /);
  for (const name of RAISED) assert.ok(lines[0].includes(`${name} 0.6 to 4`), name);
  assert.ok(lines[0].includes('refreshed=true'));
  assert.ok(!lines[0].includes('RollsMultiplier'));
});

test('OnGameStart after OnLoadedMapZones does not apply a second time', () => {
  const lua = world();
  lua.fireEvent('OnLoadedMapZones');
  lua.fireEvent('OnGameStart');
  assert.equal(calls(lua), 1);
  assert.equal(lootLines(lua).length, 1);
});

test('OnGameStart alone also applies it', () => {
  const lua = world();
  lua.fireEvent('OnGameStart');
  assert.equal(value(lua, 'FoodLootNew'), 4);
  assert.equal(calls(lua), 1);
});

test('a value is clamped to the option maximum', () => {
  const lua = world({ max: 3 });
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(value(lua, 'WeaponLootNew'), 3);
  assert.ok(lootLines(lua)[0].includes('WeaponLootNew 0.6 to 3'));
});

test('saving puts the old values back, and the post-save step raises them again', () => {
  const lua = world();
  lua.fireEvent('OnLoadedMapZones');
  lua.fireEvent('OnSave');
  for (const name of RAISED) {
    assert.equal(value(lua, name), 0.6, name);
    assert.equal(sandboxVar(lua, name), 0.6, `SandboxVars.${name}`);
  }
  lua.fireEvent('OnPostSave');
  for (const name of RAISED) assert.equal(value(lua, name), 4, name);
  assert.equal(calls(lua), 1, 'saving must not refresh the loot copy again');
});

test('saving without the flag changes nothing', () => {
  const lua = world({ flag: false });
  lua.fireEvent('OnLoadedMapZones');
  lua.fireEvent('OnSave');
  lua.fireEvent('OnPostSave');
  for (const name of RAISED) assert.equal(value(lua, name), 0.6, name);
});

test('a second world in the same session is judged by the flag again', () => {
  const lua = world();
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(calls(lua), 1);
  // Back to the menu, the flag is gone, the next world reads its own sandbox file.
  lua.run('__files["ls_loot.txt"] = nil; for _, o in pairs(__opts) do o.v = 0.6 end');
  lua.fireEvent('OnInitWorld');
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(calls(lua), 1);
  assert.equal(value(lua, 'FoodLootNew'), 0.6);
  // And with the flag back it applies again.
  lua.run('__files["ls_loot.txt"] = "1"');
  lua.fireEvent('OnInitWorld');
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(calls(lua), 2);
  assert.equal(value(lua, 'FoodLootNew'), 4);
});

test('an option the game does not have is reported and the rest still change', () => {
  const lua = world({ without: ['AmmoLootNew'] });
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(value(lua, 'FoodLootNew'), 4);
  const line = lootLines(lua)[0];
  assert.ok(line.includes('missing=AmmoLootNew'));
  assert.ok(!line.includes('AmmoLootNew 0.6'));
});

test('no ItemPickerJava: the line says the refresh failed and nothing throws', () => {
  const lua = world({ picker: false });
  lua.fireEvent('OnLoadedMapZones');
  assert.equal(value(lua, 'FoodLootNew'), 4);
  assert.ok(lootLines(lua)[0].includes('refreshed=false'));
});

test('the helper parses as Lua 5.1 and has no em dash', () => {
  const source = fs.readFileSync(DEV_FILE, 'utf8');
  luaparse.parse(source, { luaVersion: '5.1' });
  assert.ok(!source.includes('—'));
});
