# Local survivor

A local model plays Project Zomboid. The body and the fight-or-flee reflex come from [claude-survives-zomboid](https://github.com/LeahyCC/claude-survives-zomboid). This project changes the brain: Ollama, a short prompt, and JSON mode, so an 8B model can answer before the reflex has to take over.

```
Project Zomboid (LocalSurvivor mod)
    writes  Zomboid/Lua/local_percept.txt     about once a second
    reads   Zomboid/Lua/local_intent.txt      ENTER, SEARCH, DRINK, SLEEP, ...
            |
            bridge/pz-bridge.mjs
            builds a menu, asks Ollama to pick one, writes the intent
            http://localhost:8799/mind
```

The model never swings. A zombie is faster than a local model. The Lua reflex fights one living zombie with a melee weapon, and runs from a pack. The model never steers either. Each turn the bridge builds a short menu of jobs that are legal right now ("walk into house 14 tiles E, not visited", "drink at the tap", "search this building") and the model picks one id. The JSON schema only allows this turn's ids. The body runs the job to the end and reports done or failed.

Needs that cannot wait skip the model: bleeding means bandage (when there is something to bandage with), thirst with water here means drink, hunger with food ready means eat, a clearly better weapon in the bag means hold it, night outside means the nearest house, then shut it, then sleep, and too heavy means drop the junk. While a job runs the model is not asked unless something changes. The brain writes no order while a zombie is chasing within 10 tiles or any zombie is within 3, and it drops a thought that finishes after one walks in. With idle zombies further off, it keeps going and walks around them. A map memory of buildings (visited, searched, water, beds, doors) steers her to new houses, to houses first when she has no real weapon, and back to the planned home when it is out of sight. How a turn works, and the live results, are in `docs/brain.md`.

The body will ignore a few bad orders. A move toward a zombie inside 12 tiles is turned around. A step shorter than 8 tiles is stretched. A light stays off when something is close at night. Rotten food is not eaten. A corpse is not a threat.

Build 42.20 and later only let a mod write `.ini`, `.cfg`, `.txt`, and `.log`. The senses file is JSON inside a `.txt` name for that reason.

## Run

Needs Project Zomboid Build 42, Node 18, and Ollama on `http://127.0.0.1:11434`.

```
pwsh ./install.ps1
cd bridge
node pz-bridge.mjs
```

Enable **Local Survivor**, start a sandbox game, take your hands off the keys. H hides the in-game panel. G toggles fast-forward. WASD takes over for about 10 seconds.

Default model is `gemma4:12b`. It fits the 16 GB card. `llama3.1:8b` is faster and weaker. Switch with the shell before you start the bridge:

```
$env:PZ_MODEL = "qwen3.5:9b"
node pz-bridge.mjs
```

`gemma4:12b` also fits. The 27B and 35B names on this machine only keep a few layers on the GPU, so a thought takes long enough that the reflex is doing all the surviving. Use those when you want a smarter plan and can stand the wait (`$env:PZ_TIMEOUT = "120000"`).

`bridge/pz-state.json` is the memory, the map memory and the current day plan included. Delete it for a fresh mind.

`bridge/lessons.json` holds the lessons written after each death, and the run record that checks them. It is kept apart so a fresh mind still remembers what past deaths taught. Delete it, or press delete on a lesson at `/mind`, to forget. Both files are ignored by git.

A slower planner writes a short day plan and a death review writes lessons (`docs/planner.md`). It uses `PZ_PLANNER_MODEL`, which defaults to `PZ_MODEL`.

`node bridge/tools/try-brain.mjs` runs the test percepts through the real model and prints each choice and its time.

`node bridge/eval/run.mjs --model gemma4:12b --n 3` scores the brain on 34 scenarios against Ollama and prints a table. See `docs/eval.md`.

## Check

```
npm install
npm test
```

It checks the Lua syntax (5.1), loads the whole mod in a Lua VM with the game stubbed, and runs the bridge tests. The layout of the mod is in `docs/architecture.md`.
