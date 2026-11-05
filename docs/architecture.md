# Architecture

How the mod is laid out, so work on separate files can run in parallel. Code is the truth. If this page and the code disagree, fix this page.

## How the game loads Lua

Checked against the 42.21 install (`media/lua/client`, `zombie.Lua.LuaManager`).

- The game runs every `.lua` file under `media/lua/client`, subfolders included, without being asked. Shared files load before client files.
- `require "ISUI/ISPanel"` takes the path under the `lua` root of that side, without `.lua`. A file in `client/ISUI/ISPanel.lua` is required as `ISUI/ISPanel`. Over 500 vanilla client files do this.
- A file runs once. `LuaManager` keeps a `loaded` list and a `loadedReturn` cache, so a file that is both auto-loaded and required does not run again. Vanilla relies on it: `ISPanel.lua` does `ISPanel = ISUIElement:derive("ISPanel")` with no guard and hundreds of files require it.
- A `require` loop is an error (`recursive require()`).
- So a module must `require` what it uses, because auto-load order is not a promise. The test harness copies all of the above.

## Module map

All code is in `mods/LocalSurvivor/42/media/lua/client/`. Every module hangs off one global table, `LocalSurvivor`.

```
LocalSurvivor.lua          entry: requires the modules, owns onTick, registers every event once
LocalSurvivor/
  Core.lua      LocalSurvivor.*   state, constants, hudData, verbs, result, setResult
                LocalSurvivor.Core  esc n2 json split queueLength, item classification
  Sense.lua     LocalSurvivor.Sense zombieScan scanBuildings step buildPercept writePercept,
                                    and pure summarisers (summarizeWounds, summarizeZombies, ...)
  Move.lua      LocalSurvivor.Move  canStand stepWalk queuedWalkOnly doMove momentum, lineClear,
                                    progress and the unstick watch the skills share
  Act.lua       LocalSurvivor.Act   the doEquip, doCloseDoor, doConceal and doBreakin actions, manageLight, execIntent, pollIntent, the verbs,
                                    the skills (GOTO ENTER SEARCH LOOT), update, the loot table
  Reflex.lua    LocalSurvivor.Reflex fleeVector nearestZombie engage reflex survive releaseDoor manageSpeed
  Needs.lua     LocalSurvivor.Needs start update, the needs verbs and their jobs (docs/needs.md)
  HUD.lua       LocalSurvivor.HUD   start, onKeyPressed (and the LocalHUD panel class)
```

Require order is `Core`, then `Sense`, then `Move`, then `Act` and `Reflex`. `Needs` needs `Core` and `Sense`. `HUD` needs only `Core`. Calls between modules go through the table at run time (`LocalSurvivor.Sense.zombieScan(...)`), so no module holds a stale copy of another's function.

Rules:

- Shared mutable state lives on `LocalSurvivor`, never in a file-local. State is set only when nil, so a second run of a file keeps the live values. Reflex-only state is `LocalSurvivor.reflexState`.
- Events are registered in `LocalSurvivor.lua` only, once, guarded by `LocalSurvivor.eventsRegistered`. The handlers call through the namespace.
- Every game call is in `pcall`. A failure in the mod must never stop the tick.
- Lua here is 5.1 (Kahlua): no `goto`, no `//`, no bitwise operators.

State on the namespace: `tick`, `lastSeq`, `lastError`, `announced`, `reflexTick`, `lastLootTick`, `travel`, `manualMode`, `lastHumanKeyTick`, `lastMoveTick`, `lastPX`, `lastPY`, `lastTickMs`, `observing`, `autoSpeed`, `hudData`, `bldgDir`, `bldgDist`, `verbs`, `result`, `reflexState`, `needsJob` (the running needs job, or false) and `needsOpts`. Act keeps `skill` (the long order running, or nil), `searched` (rooms finished, by building id) and `lootTypes` (loot facts per item type). Move keeps `unstickLog` and `moveWatch` (unstick fires it has seen). Sense also keeps `senseScan` (the place scan in progress), `seen` (what the last scan found), `bldgMemo` and `bldgMemoCount` (fixed facts per building), `visited`, and `itemTypes` (fixed facts per item type).

## Tick cadence

`LocalSurvivor.onTick` runs at a steady 60 ticks a second, whatever the frame rate: on a faster frame it returns early (`LS.TICK_MS`, timed with `getTimestampMs`). Every timer in the mod counts these ticks, so 90 ticks is 1.5 seconds. Order inside it is fixed.

```
every tick   track movement; Sense.step (one slice of the place scan); releaseDoor (not in manual mode;
             it acts only on a stuck walk)
             manual mode: write percept each 60, stand down until idle 600 ticks, return
%5           Reflex.survive          fight or flee; if it acted, skip momentum, glance and poll
every tick   Act.update              the running skill takes a step, or waits while the reflex acts
%5           Needs.update            step the needs job; it pauses when the reflex acted
%30          sneak toggle
%15          Reflex.manageSpeed
%90          Act.manageLight
%120         Sense.scanBuildings
%20          Move.momentum           (not when acted)
%30          look around while observing
%40          glance at the nearest zombie
%60          Sense.writePercept
%45          Act.pollIntent          (not when acted)
```

Dead: only a percept every 300 ticks.

## Percept

One JSON line in `Zomboid/Lua/local_percept.txt`, about once a second. Every field, its type and the game call behind it are in `docs/percept.md`.

The v1 fields, which the v1 brain for old mods reads, in order:

`dead x y z hour day outside room hp hunger thirst fatigue endurance panic zTotal zNear zClose zDist zDir zdx zdy foods waters bldgDir bldgDist weapon items qlen reflexed lastSeq err`

v2 puts `v` first and `panic01` after `panic`, and adds after `err`:

`kills hoursAlive moodle weight maxWeight bag weapons inv wounds bleeding zChasing zVisible zDowned zList inBldg water bed buildings dark res`

`panic` is 0 to 100, the other stats 0 to 1. The v2 brain turns the percept into a few plain lines (`bridge/digest.mjs`). The v1 brain sends only the v1 fields (`V1_FIELDS` in `bridge/decide.mjs`).

## Intent

One line in `Zomboid/Lua/local_intent.txt`, polled every 45 ticks. A line runs only if its `SEQ` is higher than the last one.

```
SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET
```

`A` and `B` are `dx` and `dy` for MOVE, and `x` and `y` for GOTO. `TARGET` is a building id for ENTER. The bridge always writes the eighth field, the mod reads a missing one as empty.

## Verb registry

`LocalSurvivor.verbs[VERB] = function(p, args) ... end`. `args` is a table of strings: `seq`, `action`, `a`, `b`, `say`, `thought`, `goal`, `target`. A verb fails by setting `LocalSurvivor.lastError`.

Today's verbs: `MOVE GOTO ENTER SEARCH LOOT DROP EQUIP CLOSEDOOR CONCEAL BREAKIN STOP WAIT` in `Act.lua`, and `DRINK FILL EAT SLEEP BANDAGE WEARBAG SECURE REST` in `Needs.lua`. An unknown verb runs as `WAIT`. `GOTO ENTER SEARCH LOOT DROP` are skills that run over many ticks (`docs/skills.md`). The needs verbs start a job that runs over many ticks and reports `done` or `failed` itself (`docs/needs.md`). The v2 brain sends `GOTO ENTER SEARCH EQUIP WAIT` and every needs verb, from its menu (`docs/brain.md`). The v1 brain for old mods sends only its `ACTIONS` list. A new verb is one assignment from its own file. `Act.execIntent` does not change.

## Result record

`LocalSurvivor.result = { seq, verb, status, why }`, set with `LocalSurvivor.setResult(seq, verb, status, why)`.

- `idle` at start.
- `running` when `execIntent` starts a verb.
- `done` or `failed` with a short `why` when a skill, a MOVE or a needs job finishes (`docs/skills.md`, `docs/needs.md`).
- `failed` with `why = lastError` when an older verb set `lastError` or threw.
- A `WAIT` during a skill leaves the record to the skill.

The percept carries it as `res`.

## Checking game names

Lua calls Java by name, and a wrong name fails silently inside `pcall`. Check before you call.

- `node tools/pz-api.mjs <java.class> [regex]` lists methods, walking the parent classes. The regex matches the bare name, so use `^name$`, not `name\(`.
- `node tools/pz-consts.mjs <java.class> [regex]` lists the names in a class, for enum values like `MoodleType.THIRST`, `ItemTag.CAN_OPENER` or `IsoFlagType.bed`.

## Tests

```
npm install
npm test
```

`npm test` runs, in order:

1. `tools/lua-check.mjs` parses every `.lua` under `mods/` as Lua 5.1 with luaparse. It prints `file:line: message` and exits 1 on any error.
2. Every `bridge/*.test.mjs` and `test/*.test.mjs` under `node --test`. That includes `test/lua-load.test.mjs`, which loads the mod in fengari with the game stubbed and checks that every file loads, runs once, and that the events and namespace are right. `bridge/brain.test.mjs` checks the v2 brain on the fixtures in `bridge/fixtures/` (`docs/brain.md`).

`test/lua-harness.mjs` lets a test call Lua from JavaScript. See `test/README.md`.

Fengari is Lua 5.3, the game is 5.1. The harness patches `tostring` for whole-number floats, but `1.0 .. ""` still gives `"1.0"` there and `"1"` in the game. Do not assert on that. Anything that needs the real Java side (pathfinding, containers, zombies) can only be checked in a live game.
