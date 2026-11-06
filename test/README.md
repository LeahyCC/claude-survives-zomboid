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
- A fake player is `__makePlayer({ x, y, items })`. Put it in `__players[0]` and the tick loop uses it. With `live = true` its square follows `x` and `y` through `__squares`. `__zombies`, `__squares` and `__files` are the fake world.
- Skills: `__makeContainer({ items, square })` is a container. `__take(p, c)` finishes the queued transfers out of it. `__queueTypes(p)` lists the queued action types. `__adjacent(sq, p)`, when set, is what `AdjacentFreeTileFinder` returns. A square takes `blocked`, `walls` (a set of `"x,y"` neighbours behind a wall), `door` and `window`. A walk never runs: a test moves the player and empties the queue. See `lua-skills.test.mjs`.
- The vanilla menu handlers (`ISWorldObjectContextMenu.onDrink`, `ISInventoryPaneContextMenu.eatItem`, ...) record each call in `__menuCalls` and queue a stand-in action. `__recipes[name]` and `__canCraft[name]` stand in for craft recipes and the game's "can do it now" check. `__sleepAllowed = true` lets `onSleepWalkToComplete` put the player to sleep.
- A zombie stub takes `fx` and `fy`, the way it faces. A square's `doorObjs` maps a `"x,y"` neighbour to the door between, for a test that reads its lock. `lua-clear.test.mjs` uses both.
- `P.keys = { [7] = true }` makes `getInventory():haveThisKeyId(7)` find a key. `lua-unstick.test.mjs` drives `Reflex.releaseDoor` one call per tick.
- `instanceof(o, "IsoDoor")` is true for a stub table with `__class = "IsoDoor"`.
- `__finishStash(p)` finishes a queued put-away: the item leaves her and lands in the container, and `p.weight` falls with it. A container's `full` field makes `hasRoomFor` say no. `lua-stash.test.mjs` uses both.

```js
lua.run('__players[0] = __makePlayer({ x = 10, y = 10 })');
lua.run('LocalSurvivor.Act.execIntent(__players[0], "1|STOP|0|0|||")');
lua.get('LocalSurvivor.result.status');            // 'running'
```

Limits:

- A missing stub method fails loudly. Add it to `pz-stubs.lua` when a card needs it.
- The VM is Lua 5.3, the game is 5.1. See the note in `docs/architecture.md`.
- `createHarness({ root, vanilla })` points it at another folder, which the tooling tests use for broken fixtures.
