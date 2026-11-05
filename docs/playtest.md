# Unattended playtest

How to get a real in-game check without clicking through menus. Used to verify Lua changes that unit tests cannot reach.

```
pwsh tools/playtest.ps1 -Shot shot.png     install mods, start the game, continue the latest save, get in
cd bridge; node pz-bridge.mjs              start the brain
pwsh tools/screenshot.ps1 -Out shot.png    look at the game window any time
```

What `playtest.ps1` does:

1. Runs `install.ps1`, and copies the helper mod `tools/dev-mod/LocalSurvivorDev` to `Zomboid/mods`.
2. Adds `LocalSurvivorDev` to `Zomboid/mods/default.txt`. Main-menu Lua only runs for mods in that list.
3. Writes `Zomboid/Lua/ls_autoload.txt`. While that file exists, the helper continues the latest save from the main menu.
4. Starts the game through Steam if it is not running, then clicks the middle of the window every 8 seconds to get past "Click to Start".
5. The helper turns off the first-time survival guide for the session, since it pauses the game until closed.
6. Stops once `local_percept.txt` is fresh, and deletes the flag file so the next normal launch is not affected.

Tracing: create `Zomboid/Lua/ls_trace.txt` and the mod writes `LocalSurvivor trace` lines to `console.txt` (checked once a minute, no restart needed). It logs each reflex flee, each ENTER attempt and failure with the window's state, each SECURE walk, and every time she goes in or out of a building with the job that was running. Delete the file to stop.

Night fast forward: with a safe house and a WAIT, REST or SLEEP order at night, `speed` in the percept goes to 3 and the clock races. It drops to 1 on a new walking order, a zombie within 8 tiles or in sight, a chaser, bleeding or a hit. Run with `ls_trace.txt` on and check that no walk is dropped after the clock slows. The soak test reads `speed` to see how long she sat at 3.

## Rich loot

To watch how she picks gear when there is plenty to pick from:

```
pwsh tools/playtest.ps1 -RichLoot
```

This writes `Zomboid/Lua/ls_loot.txt` before launch. The helper reads it when the world loads, and the script deletes it once the game is in. Without `-RichLoot` the script removes the file, and the helper changes nothing. The `LocalSurvivor` mod and the bridge are not involved.

What it sets, all to 4 (the option's own maximum in Build 42.21; the sandbox screen stops at 3, "Abundant"; the default is 0.6):

| option | covers |
|---|---|
| `WeaponLootNew` | melee weapons |
| `RangedWeaponLootNew`, `AmmoLootNew` | guns and ammo |
| `FoodLootNew`, `CannedFoodLootNew` | perishable and non-perishable food |
| `MedicalLootNew` | medicine and bandages |
| `SurvivalGearsLootNew` | camping gear |
| `ContainerLootNew` | bags |
| `ToolLootNew` | tools |
| `KeyLootNew` | house keys, which ENTER can use |
| `LiteratureLootNew`, `CookwareLootNew`, `ClothingLootNew`, `MaterialLootNew`, `FarmingLootNew`, `GeneratorLootNew` | everything else |
| `RollsMultiplier` | how many times each container is rolled. Its tooltip warns a high value can cost performance, which is fine for a test run |

Also set to 0: `MaximumLooted` and `MaximumDiminishedLoot`. Build 42 empties a share of buildings that grows with the world's age, so an older save looked picked over even with every loot option at 4.

How it reaches loot generation:

- The loot rolls do not read the sandbox options. `IsoWorld.init` copies each option once into a static float on `ItemPickerJava`, right after it reads the save's sandbox file. Changing only `SandboxVars` or the option would do nothing.
- So the helper sets each option with `getSandboxOptions():getOptionByName(name):setValue(...)`, copies the value into `SandboxVars` too, then calls `ItemPickerJava.InitSandboxLootSettings()`. That is the same method `IsoWorld.init` calls, and it re-reads the options into the floats the rolls use.
- This was read from the game's class files, not run. The console line below shows `refreshed=true` when the call worked. Whether loot really comes out richer is the live check.
- The helper runs on `OnLoadedMapZones`, which fires inside `IsoWorld.init` after the first copy and before chunks load. `OnGameStart` is a second chance.

Console line, once per world:

```
LocalSurvivorDev loot WeaponLootNew 0.6 to 4, RangedWeaponLootNew 0.6 to 4, ...; refreshed=true
```

The save file: the game writes the sandbox options to `map_sand.bin` when it saves. The helper puts the old values back on `OnSave`, before that write, and sets the high ones again on `OnPostSave`. So the player's sandbox settings should not change. If `OnSave` ever does not run first, the high values would be saved with the world. To check, save and quit, then run again with `-RichLoot`: the `old` values in the console line should still be the ones you chose.

Loot is rolled when a container is first opened or its area first loads. Only buildings she has not opened yet get the new amounts. A save that was already explored will look the same, so use a new world or walk to fresh buildings.

What to watch:

- `Zomboid/console.txt`: Lua errors and `LocalSurvivor` lines.
- `Zomboid/Lua/local_percept.txt`: the senses, once a second.
- `http://localhost:8799/mind`: what the brain chose and why.
- `bridge/decisions.jsonl`: one line per decided turn and what came of it, and one `death` line per run. `node bridge/tools/review.mjs` summarizes it, deaths by cause first.
- `Zomboid/Lua/local_death.txt`: the last 10 seconds of the character that just died.
- `Zomboid/Lua/local_reflex.txt`: one line per reflex stance and one per outcome 5 seconds later (`docs/combat.md`). The bridge copies them into `decisions.jsonl` as `reflex` lines, and `review.mjs` prints "Reflex by stance".

## Checking the reflex

Turn tracing on (`ls_trace.txt`) so `console.txt` gets a `run` line for each break or flee walk and a `climb` line for each climb. Watch the HUD action and the percept's `reflex` field.

1. One zombie, a bat in hand, fresh: `FIGHT`, she walks in and swings. With a pen: no walk in, `BREAK CONTACT` or `FLEE`.
2. Three or more coming in the open: `BREAK CONTACT`. Check the walk heads away along open ground, not into a wall. If she stands on one tile, a `run-stuck` trace line should follow within about a second and the next walk should take another way.
3. In the log, look at the `out` lines for `BREAK`: `sprint` says whether the game kept her sprinting. Expect `false` (see `docs/combat.md`, Sneak and sprint).
4. After a break, once they lose her: `HIDE (reflex)`, crouched, not walking. She stands up again within a few seconds of nothing being about.
5. An unaware zombie 8 to 14 tiles off and nothing chasing: she crouches and the order keeps walking. A chaser anywhere: she stands.
6. A low fence between her and a pack chasing her: `CLIMB (reflex)`, she walks to the fence and goes over. She must not climb straight back. A tall fence is never picked.
7. Inside with two coming at a door: `HOLD (reflex)` at the spot one tile in. Outside with two coming over a low fence: `HOLD (reflex)` on her side, swings as each comes over.
8. Winded (endurance under 0.3) with one close: shoves and steps back, never walks in. Bleeding or hp under 50: the same.
9. An order line with `|avoid` as a ninth field (write it by hand into `local_intent.txt` with a higher seq): she gets away from a chaser at 5 tiles instead of walking to it. `|clear`: she walks to one at 7.
10. After a session, `node bridge/tools/review.mjs` prints "Reflex by stance" with calls, escapes, hits and hp lost.

## Checking a death

After she dies, three places should agree:

1. `Zomboid/Lua/local_death.txt` exists and is new. It holds the last 10 seconds as JSON (`docs/percept.md`). Open it and check `ring` has up to 10 samples with sensible `hp`, `zAdj`, `job` and `reflex`, and that `final` is there. Keys that are missing in `final` mean the game would not answer for a dead body.
2. `http://localhost:8799/mind`, Runs table: the "ended by" cell names a cause and "last seconds" says what she was doing, how many were close and chasing, and the hp lost.
3. `bridge/decisions.jsonl` ends with a `death` line. `node bridge/tools/review.mjs` prints it under "Deaths by cause".

The cause says `(from the bridge's own guess)` in the review when the mod's record did not arrive. That should not happen with the new mod. If it does, check that `OnPlayerDeath` fired: with `ls_trace.txt` on, nothing is logged for it yet, so look at whether `local_death.txt` was written at all.

Not checked in a live game yet: the stat names (`ZOMBIE_INFECTION`, `SICKNESS`, `TEMPERATURE`) and their scales, whether `getDeathString` works on a dead player, and whether `getSpecificPlayer(0)` still answers after death (the event is the main path, the tick loop's dead check is the backup).

## Nudging while you watch

When the brain picks something you would not, use the Nudge panel on `/mind` (`docs/eval.md` has the details):

1. Click the option you would have chosen. The brain's pick is marked.
2. Type a short why. If the right option is not on the menu, say what it should be in the second box.
3. **Do it now** sends it as the next order. **Just log it** only records it.

After a session:

```
node bridge/tools/review.mjs --since 2026-11-04     how often she agreed with you, what failed, what hurt
node bridge/tools/nudges-to-eval.mjs                make eval scenarios from the picks
node bridge/eval/run.mjs                            score the brain against them
```

With examples on (the default, `PZ_EXAMPLES=0` turns them off), up to two of your past picks from a similar spot go into the next prompt as "In a similar spot, the better pick was ..." lines.

The screenshot is taken from the screen, so anything on top of the game window shows up in it.

## Live runs, 2026-11-04

Four runs of about six minutes each with the menu brain on gemma4:12b. Same PC, frame cap 240.

| run | build | unstick fires | what happened |
|---|---|---|---|
| 1 | menu brain merged | 252 | ENTER, SEARCH and GOTO kept failing `stuck`. SECURE called 14 targets out of reach. |
| 2 | ticks at 60 a second | 13 | Walked every room, got in through a window. Then stood still for 2 minutes: a zombie 2 tiles away behind a wall held every order. |
| 3 | no hold for an unseen zombie | 16 | In by a door, searched (took 10 items), filled 2 bottles, bandaged. |
| 4 | planner and eval merged | 16 | Plans came back with sensible goals. Searched two houses and secured one at dusk. Two plans came back empty (fixed after the run). |

Still wrong in run 4: her weapon was a pen, BANDAGE was offered with no bandage and failed `no bandage`, and SECURE once walked outside. No locked door with a matching key came up, so ENTER's key use is still untested live.

Since run 4 the bridge reads the newer percept fields (`docs/brain.md`): BANDAGE is offered only with a bandage or `inv.canRip`, a pen reads as no weapon so houses come first, a better weapon in the bag is equipped by the policy, and `asleep`, `res.target` and `roomsLeft` replace guesses. None of that has been run live yet.

## Soak test

```
node tools/soak.mjs --hours 3
```

Runs unattended with normal loot. It launches the game through `playtest.ps1`, starts the bridge, and keeps the respawn flag (`ls_autoload.txt`) in place so the helper mod brings in a new random survivor after each death. Every 30 seconds it checks the game: if the game is gone, or no percept came for 4 minutes, it relaunches it. A bridge that exits is restarted. When the time is up it writes `bridge/soak-<start>.txt` with `bridge/tools/review.mjs --since <start>` (deaths by cause, reflex by stance, critic flags against outcomes), stops the bridge and leaves the game running. Its own log is `bridge/soak.log`, the bridge's is `bridge/soak-bridge.log`.

Set `TYPESAFE_API_KEY` for the critic. The PC must not sleep during the run.
