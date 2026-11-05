# Local survivor

A local model plays Project Zomboid. The body and the fight-or-flee reflex come from [claude-survives-zomboid](https://github.com/LeahyCC/claude-survives-zomboid). This project changes the brain: Ollama, a short prompt, and JSON mode, so an 8B model can answer before the reflex has to take over.

```
Project Zomboid (LocalSurvivor mod)
    writes  Zomboid/Lua/local_percept.txt     about once a second
    reads   Zomboid/Lua/local_intent.txt      MOVE, LOOT, EAT, ...
            |
            bridge/pz-bridge.mjs
            asks Ollama, checks the action, writes the intent
            http://localhost:8799/mind
```

The model never swings. A zombie is faster than a local model. The Lua reflex fights one living zombie with a melee weapon, and runs from a pack. The model decides where to go, what to loot, and when to hide. It answers with one action and one short thought. A longer reply was getting cut off at subtask, so that turn never landed.

The brain writes no order while a zombie is inside 10 tiles, and it drops a thought that finishes after one walks in. The flee is already the right move. With a clear patch of ground, no weapon, and a building nearby, the bridge walks her there and loots. That job replaces the model's action. It does not ask the model to invent the walk.

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

`bridge/pz-state.json` is the memory. Delete it for a fresh mind.

## Check

```
node bridge/decide.test.mjs
```
