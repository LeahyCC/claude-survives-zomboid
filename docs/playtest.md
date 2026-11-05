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
5. Stops once `local_percept.txt` is fresh, and deletes the flag file so the next normal launch is not affected.

What to watch:

- `Zomboid/console.txt`: Lua errors and `LocalSurvivor` lines.
- `Zomboid/Lua/local_percept.txt`: the senses, once a second.
- `http://localhost:8799/mind`: what the brain chose and why.

The screenshot is taken from the screen, so anything on top of the game window shows up in it.
