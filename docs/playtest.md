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

What to watch:

- `Zomboid/console.txt`: Lua errors and `LocalSurvivor` lines.
- `Zomboid/Lua/local_percept.txt`: the senses, once a second.
- `http://localhost:8799/mind`: what the brain chose and why.

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
