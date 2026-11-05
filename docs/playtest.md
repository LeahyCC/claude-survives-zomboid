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

Night fast forward: with a safe house and a WAIT, REST or SLEEP order at night, `speed` in the percept goes to 3 and the clock races. It drops to 1 on a new walking order, a zombie within 20 tiles, a chaser, bleeding or a hit. Run with `ls_trace.txt` on and check that no walk is dropped after the clock slows. The soak test reads `speed` to see how long she sat at 3.

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

`RollsMultiplier` is left alone. Its tooltip warns that a high value can hurt performance.

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
- `bridge/decisions.jsonl`: one line per decided turn and what came of it. `node bridge/tools/review.mjs` summarizes it.

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
