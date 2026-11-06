# Local survivor

A local model plays Project Zomboid. The body and the fight-or-flee reflex come from [claude-survives-zomboid](https://github.com/LeahyCC/claude-survives-zomboid). This project changes the brain: Ollama, a short prompt, and JSON mode, so an 8B model can answer before the reflex has to take over.

What comes next, and why, is in `docs/roadmap.md`. Where the last session stopped is in `docs/handoff.md`. What we borrow from the Bandits mod and the guides, set against the soak evidence, is in `docs/pro-rules.md`.

```
Project Zomboid (LocalSurvivor mod)
    writes  Zomboid/Lua/local_percept.txt     about once a second
    reads   Zomboid/Lua/local_intent.txt      ENTER, SEARCH, DRINK, SLEEP, ...
            |
            bridge/pz-bridge.mjs
            builds a menu, asks Ollama to pick one, writes the intent
            http://localhost:8799/mind
```

The model never swings. A zombie is faster than a local model. The Lua reflex sizes up the threat and picks a stance: fight one with a real weapon, hold a door or a fence, shove and step back when winded or hurt, run out of sight of a pack and then crouch, sneak past ones that have not seen her, or climb a fence to slow them. A gun is a last resort: holstered by default, drawn and fired only when she is cornered or a small group blocks the only way out, then put away while she leaves. Every stance and what came of it goes in a log (`docs/combat.md`). The model never steers either. Each turn the bridge builds a short menu of jobs that are legal right now ("walk into house 14 tiles E, not visited", "drink at the tap", "search this building") and the model picks one id. The JSON schema only allows this turn's ids. The body runs the job to the end and reports done or failed.

Needs that cannot wait skip the model: bleeding means bandage (when there is something to bandage with), thirst with water here means drink, hunger with food ready means eat, a clearly better weapon in the bag means hold it, night outside means the nearest house, then shut it, then sleep, and too heavy means drop the junk. While a job runs the model is not asked unless something changes. The brain writes no order while a zombie is chasing within 10 tiles or any zombie is within 3, and it drops a thought that finishes after one walks in. That hold is a loan: after a minute of the reflex fleeing a small chase without getting away, or as soon as its escape stops working, the model gets one turn with a short escape menu (a house to go into, a walk away, a stand). With idle zombies further off, it keeps going and walks around them. A map memory of buildings (visited, searched, water, beds, doors) steers her to new houses, to houses first when she has no real weapon, and back to the planned home when it is out of sight. Once she goes for a house the bridge holds her to it: in, shut it, listen, search it, leave for the next one. A real threat pauses that or ends it. How a turn works, and the live results, are in `docs/brain.md`.

The body will ignore a few bad orders. A move toward a zombie inside 12 tiles is turned around. A step shorter than 8 tiles is stretched. A light stays off when something is close at night. Rotten food is not eaten. A corpse is not a threat.

Build 42.20 and later only let a mod write `.ini`, `.cfg`, `.txt`, and `.log`. The senses file is JSON inside a `.txt` name for that reason.

## Run

Needs Project Zomboid Build 42, Node 18, and Ollama on `http://127.0.0.1:11434`.

```
pwsh ./install.ps1
cd bridge
node pz-bridge.mjs
```

Enable **Local Survivor**, start a sandbox game, take your hands off the keys. H hides the in-game panel. G toggles fast-forward. K toggles the night fast forward. `;` hides the inner voice bubble and panel. WASD takes over for about 10 seconds.

Default model is `gemma4:12b`. It fits the 16 GB card. `llama3.1:8b` is faster and weaker. Switch with the shell before you start the bridge:

```
$env:PZ_MODEL = "qwen3.5:9b"
node pz-bridge.mjs
```

`gemma4:12b` also fits. As the menu model, the bigger names on this machine only keep a few layers on the GPU, so each turn takes long enough that the reflex is doing all the surviving. The planner is different: it runs rarely, so a big model is fine there (see below).

`bridge/pz-state.json` is the memory, the map memory and the current day plan included. Delete it for a fresh mind.

`bridge/lessons.json` holds the lessons written after each death, and the run record that checks them. It is kept apart so a fresh mind still remembers what past deaths taught. Delete it, or press delete on a lesson at `/mind`, to forget. Both files are ignored by git.

`bridge/decisions.jsonl` records every decided turn and what came of it. `bridge/nudges.jsonl` holds the picks you make in the Nudge panel on `/mind`. Both are ignored by git and only ever appended to. `node bridge/tools/review.mjs` prints a short report from them, and `node bridge/tools/nudges-to-eval.mjs` turns your picks into eval scenarios. See `docs/eval.md`.

A slower planner writes a short day plan and a death review writes lessons (`docs/planner.md`). It uses `PZ_PLANNER_MODEL`. On this PC the default is `qwen3.6-35b_abliterated_pc:latest`, run on the CPU with thinking off: a plan takes about 6 seconds and the menu model stays fast beside it, game running or not. If that model is not installed the planner falls back to `PZ_MODEL`. Set `PZ_PLANNER_MODEL` to pick your own, which then runs the old way (Ollama places it, thinking on auto). `PZ_PLANNER_GPU_LAYERS` sets how many layers go on the GPU, and `node bridge/tools/planner-bench.mjs <model>` measures a planner. The table is in `docs/planner.md`.

A hosted second opinion is optional. Set `TYPESAFE_API_KEY` before you start the bridge and every choice is sent, with the same menu, to Jev (TypeSafe's System One model). Its view is logged next to the decision and shown in the Critic column on `/mind`. It never changes what she does, and with no key nothing is sent. `PZ_CRITIC=0` turns it off, `PZ_CRITIC_FLAG` and `PZ_CRITIC_TIMEOUT` tune it. Only game facts leave the PC. See "Critic" in `docs/brain.md`. `node bridge/eval/run.mjs --backend jev` scores Jev on the eval scenarios.

```
$env:TYPESAFE_API_KEY = "<your key>"
node pz-bridge.mjs
```

`node bridge/tools/try-brain.mjs` runs the test percepts through the real model and prints each choice and its time.

`node bridge/eval/run.mjs --model gemma4:12b --n 3` scores the brain on 39 scenarios against Ollama and prints a table. See `docs/eval.md`.

The prompt tells her how her last orders went (done, failed and why, HP lost, still chased), which houses are off the menu after a failure, and a plain warning when she goes in circles. The `/mind` page has a Reactions strip with the same data. See "Reactions" in `docs/brain.md`.

## Streaming

The inner voice shows in the game: a bubble over her head and an "Inner voice" panel in the top right with the last 3 lines. `Zomboid/Lua/ls_voice_off.txt` turns it off for good. `Zomboid/Lua/ls_voice_clean.txt` stars out slurs in the game display only, so make it before going live. `/mind` and `pepe.log` are never filtered. Setup is in `docs/playtest.md`, the details in `docs/brain.md`.

## Check

```
npm install
npm test
```

It checks the Lua syntax (5.1), loads the whole mod in a Lua VM with the game stubbed, and runs the bridge tests. The layout of the mod is in `docs/architecture.md`.
