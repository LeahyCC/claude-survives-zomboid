# Lua test harness

`lua-harness.mjs` runs the mod's Lua in fengari with Project Zomboid stubbed (`pz-stubs.lua`). A test calls Lua functions with plain JavaScript values and reads the result back.

```js
import { createHarness } from './lua-harness.mjs';

const lua = createHarness();
lua.autoload();                                    // load every file the way the game does

lua.call('LocalSurvivor.Core.split', 'a|b', '|');  // ['a', 'b']
lua.get('LocalSurvivor.result');                   // { seq: 0, verb: '', status: 'idle', why: '' }
lua.set('LocalSurvivor.lastSeq', 7);
lua.run('return LocalSurvivor.Core.n2(...)', 3.14159);   // '3.14'
```

Values:

- Objects and arrays go in as tables. `null` and `undefined` become nil.
- A table with keys `1..n` comes back as an array, an empty one as `[]`, anything else as an object. Functions come back as `undefined`.

Calls:

- `call(path, ...args)` returns the first result. `callMulti` returns all of them as an array.
- `run(code, ...args)` runs a chunk. `...` holds the args. It returns the first value of `return`.
- `get(path)` and `set(path, value)` read and write a global path like `LocalSurvivor.tick`.
- `fireEvent('OnTick')` calls every handler the mod registered. `eventCount(name)` counts them.
- `autoload()` runs every file under the client folder. `requireModule(name)` runs one, with its requires.
- A fake player is `__makePlayer({ x, y, items })`. Put it in `__players[0]` and the tick loop uses it. `__zombies`, `__squares` and `__files` are the fake world.

```js
lua.run('__players[0] = __makePlayer({ x = 10, y = 10 })');
lua.run('LocalSurvivor.Act.execIntent(__players[0], "1|STOP|0|0|||")');
lua.get('LocalSurvivor.result.status');            // 'running'
```

Limits:

- A missing stub method fails loudly. Add it to `pz-stubs.lua` when a card needs it.
- The VM is Lua 5.3, the game is 5.1. See the note in `docs/architecture.md`.
- `createHarness({ root, vanilla })` points it at another folder, which the tooling tests use for broken fixtures.
