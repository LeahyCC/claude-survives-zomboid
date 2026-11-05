// Run the mod's Lua in fengari (a Lua VM in JavaScript) with Project Zomboid stubbed out.
//
//   const lua = createHarness();
//   lua.requireModule('LocalSurvivor/Core');
//   lua.call('LocalSurvivor.Core.split', 'a|b', '|');   // ['a', 'b']
//
// Plain JS values go in as Lua values and come back out as JS values. Objects and arrays become
// tables, null and undefined become nil. A Lua table with keys 1..n comes back as an array,
// anything else as an object. Functions and userdata come back as undefined.
//
// fengari is Lua 5.3 and the game is Lua 5.1 (Kahlua). tools/lua-check.mjs enforces 5.1 syntax.
// What it cannot enforce: `1.0 .. ""` is "1.0" here and "1" in the game. tostring() is patched to
// match 5.1, concatenation is not.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const CLIENT_DIR = path.join(REPO, 'mods/LocalSurvivor/42/media/lua/client');
const STUBS = path.join(HERE, 'pz-stubs.lua');

// Vanilla modules the mod may require. The harness treats them as already loaded, because the
// stubs stand in for them. Any other name that is not a file under the mod's root is an error,
// the way the game reports it.
const DEFAULT_VANILLA = ['ISUI/ISUIElement'];

const ls = (s) => to_luastring(s);

export function createHarness(options = {}) {
  const root = options.root ?? CLIENT_DIR;
  const vanilla = new Set(options.vanilla ?? DEFAULT_VANILLA);
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // The game's Kahlua has no global next (a live run died on it, 2026-11-04), and none of the
  // 5.3 libraries. Remove them so a call fails the tests instead of the game. table.unpack and
  // math.type stay: pz-stubs.lua uses them to make fengari print and unpack like 5.1.
  lauxlib.luaL_dostring(
    L,
    ls('next = nil; table.pack = nil; table.move = nil; utf8 = nil; math.tointeger = nil; ' +
      'string.pack = nil; string.unpack = nil; string.packsize = nil'),
  );

  const loaded = new Map(); // module name -> returned value is on the Lua side, here just a marker
  const loading = new Set();
  const loadCounts = new Map(); // module name -> times its file ran

  // ---------- JS <-> Lua ----------
  function pushJS(value, depth = 0) {
    if (depth > 12) throw new Error('value nested too deeply to pass to Lua');
    if (value === null || value === undefined) lua.lua_pushnil(L);
    else if (typeof value === 'boolean') lua.lua_pushboolean(L, value);
    else if (typeof value === 'number') {
      if (Number.isInteger(value)) lua.lua_pushinteger(L, value);
      else lua.lua_pushnumber(L, value);
    } else if (typeof value === 'string') lua.lua_pushstring(L, ls(value));
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((item, i) => {
        pushJS(item, depth + 1);
        lua.lua_rawseti(L, -2, i + 1);
      });
    } else if (typeof value === 'object') {
      lua.lua_createtable(L, 0, 0);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        pushJS(item, depth + 1);
        lua.lua_setfield(L, -2, ls(key));
      }
    } else throw new Error(`cannot pass a ${typeof value} to Lua`);
  }

  function toJS(index, depth = 0, seen = new Set()) {
    const abs = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, abs)) {
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, abs);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, abs);
      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tostring(L, abs));
      case lua.LUA_TTABLE: {
        const id = lua.lua_topointer(L, abs);
        if (depth > 12 || seen.has(id)) return undefined; // a cycle or a runaway: drop it
        seen.add(id);
        const entries = [];
        lua.lua_pushnil(L);
        while (lua.lua_next(L, abs) !== 0) {
          // The key stays on the stack for lua_next. Read it without converting it in place.
          const keyType = lua.lua_type(L, -2);
          const key = keyType === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -2) : keyType === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -2)) : undefined;
          const val = toJS(-1, depth + 1, seen);
          if (key !== undefined && val !== undefined) entries.push([key, val]);
          lua.lua_pop(L, 1);
        }
        seen.delete(id);
        if (entries.length === 0) return [];
        const isArray = entries.every(([k]) => Number.isInteger(k) && k >= 1 && k <= entries.length);
        if (isArray) {
          const out = new Array(entries.length);
          for (const [k, v] of entries) out[k - 1] = v;
          return out;
        }
        return Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
      }
      default:
        return undefined;
    }
  }

  // ---------- running Lua ----------
  function traceback(state) {
    const msg = lua.lua_tostring(state, 1);
    lauxlib.luaL_traceback(state, state, msg, 1);
    return 1;
  }

  // Call the function and `nargs` arguments already on the stack. Returns the results as JS.
  function protectedCall(nargs, nresults) {
    const base = lua.lua_gettop(L) - nargs - 1;
    lua.lua_pushjsfunction(L, traceback);
    lua.lua_insert(L, base + 1);
    const status = lua.lua_pcall(L, nargs, nresults, base + 1);
    if (status !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, base);
      throw new Error(message);
    }
    lua.lua_remove(L, base + 1);
    const count = lua.lua_gettop(L) - base;
    const results = [];
    for (let i = 0; i < count; i++) results.push(toJS(base + 1 + i));
    lua.lua_settop(L, base);
    return results;
  }

  function loadChunk(source, chunkName) {
    const bytes = typeof source === 'string' ? ls(source) : source;
    const status = lauxlib.luaL_loadbuffer(L, bytes, bytes.length, ls(chunkName));
    if (status !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      throw new Error(message);
    }
  }

  function run(code, ...args) {
    loadChunk(code, '=harness');
    args.forEach((a) => pushJS(a));
    return protectedCall(args.length, 1)[0];
  }

  const assertPath = (p) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(p)) throw new Error(`bad Lua path: ${p}`);
  };

  function callMulti(fnPath, ...args) {
    assertPath(fnPath);
    loadChunk(`return ${fnPath}`, '=harness');
    pushFunctionFromChunk();
    args.forEach((a) => pushJS(a));
    return protectedCall(args.length, lua.LUA_MULTRET);
  }
  // Run the loaded `return path` chunk and leave the function it returns on the stack.
  function pushFunctionFromChunk() {
    const base = lua.lua_gettop(L) - 1;
    const status = lua.lua_pcall(L, 0, 1, 0);
    if (status !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, base);
      throw new Error(message);
    }
    if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_settop(L, base);
      throw new Error('not a function');
    }
  }

  // ---------- require, the way the game does it ----------
  // The game runs a file once and hands every later require the same result. A require that
  // loops back on itself is an error. Both are reproduced here.
  function moduleFile(name) {
    return path.join(root, ...name.split('/')) + '.lua';
  }

  function runModule(name) {
    const file = moduleFile(name);
    if (!fs.existsSync(file)) throw new Error(`module not found: ${name}`);
    loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
    loadChunk(fs.readFileSync(file), '@' + name + '.lua');
    // Like the game's loader, call with no arguments and keep the first result. Protected, so a
    // failure in a nested require reaches the test as an ordinary Error with the Lua message.
    const top = lua.lua_gettop(L) - 1;
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, top);
      throw new Error(message);
    }
    return true;
  }

  function requireModule(name) {
    if (loaded.has(name)) return;
    if (vanilla.has(name)) { loaded.set(name, true); return; }
    if (loading.has(name)) throw new Error(`recursive require(): ${name}`);
    loading.add(name);
    try {
      runModule(name);
      lua.lua_pop(L, 1);
      loaded.set(name, true);
    } finally {
      loading.delete(name);
    }
  }

  // Lua-side require: runs requireModule and returns nothing useful (the mod ignores the value).
  lua.lua_pushjsfunction(L, (state) => {
    const name = to_jsstring(lauxlib.luaL_checkstring(state, 1));
    try {
      requireModule(name);
    } catch (err) {
      return lauxlib.luaL_error(state, ls(`%s`), ls(String(err.message)));
    }
    lua.lua_pushboolean(state, true);
    return 1;
  });
  lua.lua_setglobal(L, ls('require'));

  // The game runs every .lua file under media/lua/client, subfolders included, without being
  // asked. A file that was already required is skipped.
  function listModules() {
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), prefix + entry.name + '/');
        else if (entry.name.endsWith('.lua')) out.push(prefix + entry.name.slice(0, -4));
      }
    };
    walk(root, '');
    return out.sort();
  }

  function autoload({ reverse = false } = {}) {
    const names = listModules();
    if (reverse) names.reverse();
    for (const name of names) requireModule(name);
    return names;
  }

  // Run a module's file again, bypassing the cache. The game never does this, but a hot reload
  // in the debugger does, and every module has to survive it.
  function reloadModule(name) {
    runModule(name);
    lua.lua_pop(L, 1);
  }

  // ---------- stubs ----------
  loadChunk(fs.readFileSync(STUBS), '@pz-stubs.lua');
  protectedCall(0, 0);

  return {
    run,
    call: (fnPath, ...args) => callMulti(fnPath, ...args)[0],
    callMulti,
    get(valuePath) {
      assertPath(valuePath);
      return run(`return ${valuePath}`);
    },
    set(valuePath, value) {
      assertPath(valuePath);
      run(`${valuePath} = ...`, value);
    },
    requireModule,
    reloadModule,
    autoload,
    listModules,
    loadCounts,
    // Handlers a file registered with Events.<name>.Add.
    eventCount: (name) => run('return #(__events[...] or {})', name),
    fireEvent: (name, ...args) => run(`for _, fn in ipairs(__events[select(1, ...)] or {}) do fn(select(2, ...)) end`, name, ...args),
    // Everything the mod passed to print().
    printed: () => run('return __printed'),
    close: () => lua.lua_close(L),
  };
}
