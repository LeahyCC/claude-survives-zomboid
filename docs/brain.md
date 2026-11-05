# Brain

How the bridge decides. Code is the truth: `bridge/brain.mjs` and the modules below. The plan behind it is step 5 of `docs/research.md`.

The model no longer steers. It reads a short menu of whole jobs and picks one id. Needs that cannot wait skip the model. The reflex still owns any fight.

## A turn

```
percept (once a second)
   |
   v
update map memory ---------------------------------- memory.mjs
   |
   v
dead? ........................... no order
chaser inside 10, or any zombie inside 3 ... hold, the reflex owns it
asleep? ......................... no order
last order not picked up yet? ... wait for the body
   |
build options (legal now, 8 or fewer) -------------- options.mjs
   |
skill or needs job running, nothing changed? ... no order, no model call
   |
policy rule fires? .............. send its option, no model call --- policy.mjs
   |
ask the model ---------------------------------------- llm.mjs
   system:  fixed instructions (cached by Ollama)
   user:    digest + plan + playbook rules and lessons + recent + voice + options
   reply:   {"thought": "...", "choice": "<one of this turn's ids>"}
   |
re-read the percept: a chaser walked in? drop the order
   |
"keep" or the job already running? no order
otherwise write SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET
```

A percept with no `v` field comes from an old mod. It gets the old prompt and the old rules in `bridge/decide.mjs`.

## Modules

| File | What it does | Kind |
|---|---|---|
| `brain.mjs` | One turn without I/O: `planTurn`, `resolveChoice`, `orderLine`, the user message. | service |
| `senses.mjs` | Reads a v2 percept: the hold rule, need flags, night, inside, busy. | service |
| `options.mjs` | The menu: `buildOptions(percept, memory)`. | service |
| `policy.mjs` | Needs that cannot wait: `decidePolicy`. | service |
| `playbook.mjs` | Pro rules with a condition each: `selectRules`. | service |
| `memory.mjs` | Map memory by building id, saved as `map` in `pz-state.json`. | service |
| `digest.mjs` | The situation in plain lines. | formatter |
| `words.mjs` `geom.mjs` | Words for numbers, compass, distances. | pure helpers |
| `planner.mjs` | The slow day plan: events, parsing, the background runner. See `docs/planner.md`. | service |
| `lessons.mjs` | Lessons from past deaths and their triggers. See `docs/planner.md`. | service |
| `llm.mjs` | Ollama calls, the fixed system message, the per-turn schema, the planner call. | I/O |
| `pz-bridge.mjs` | Reads the percept, runs the loop, writes the order, serves `/mind`. | I/O |
| `decide.mjs` | The v1 brain for old mods, and `intentLine`. | v1 |

## When an order is held

The reflex leaves an idle zombie alone unless it is within about 2 tiles (`docs/combat.md`). So the brain only goes quiet when the reflex will act:

- a zombie in `zList` with `chase` true and `d` 10 or less, or `zChasing > 0` with `zClose > 0` when `zList` is missing
- any zombie 3 tiles or closer

A thought that comes back after one of these starts is dropped. With idle zombies further out, orders go on. Walks keep 5 tiles clear of every standing zombie within 20 (idle ones, and chasers the reflex does not own yet), and end at least 6 tiles from one. A house whose door is past a zombie is left off the menu.

## Options

Each option is `{id, verb, a, b, target, label, key}`. The model reads `id: label`. `key` names it in map memory. The menu is sorted by need and cut to 8, with `wait` (or `keep`) always last.

| id | verb | offered when |
|---|---|---|
| `bandage` | BANDAGE | a wound is bleeding, deep, bitten, has glass, or is an unbandaged cut or scratch; and a bandage is carried or it bleeds (the job can rip cloth) |
| `drink` | DRINK | thirst 0.25 or more (or the moodle); water in a bottle, or a tap in this building |
| `eat` | EAT | hunger 0.25 or more (or the moodle); food ready, or a can and a can opener |
| `equip` | EQUIP | nothing in hand and a melee weapon carried |
| `secure` | SECURE | inside, not secured since entering. Night sorts it near the top |
| `sleep` | SLEEP | inside, fatigue 0.5 or more, no chaser, none visible, none within 15, no panic, pain under 2 (unless fatigue over 0.85) |
| `search` | SEARCH | inside, not searched (map memory), not overloaded, no zombie within 8 |
| `wearbag` | WEARBAG | no bag worn and a bag in the item names |
| `b1` `b2` `b3` | ENTER | buildings in the percept, not this one, not blocked, path clear. Unsearched first, then nearest. A safe house goes first at night, when tired or panicked. The plan's home building goes before that when she needs shelter and from 17:00 |
| `fill` | FILL | inside, a tap here, an empty bottle carried |
| `rest` | REST | endurance under 0.6, no chaser |
| `away` | GOTO | an idle zombie within 12, or a chaser: 15 tiles in the clearest direction away |
| `explore` | GOTO | outside with no new building on the menu: 25 tiles in a clear direction |
| `wait` | WAIT | nothing is running |
| `keep` | none | a skill or needs job is running. Picking it sends nothing |

While a skill or needs job runs, any new order cancels it. So the menu then has only `keep` and what is worth stopping for: `bandage`, `drink`, `eat`, `away`, and `secure` when a zombie is chasing. A walk (`GOTO`, `ENTER`) can still switch to another house. If `keep` is the only option, the model is not asked.

Building labels come from map memory: `not visited`, `visited, not searched`, `partly searched`, `searched`, `safe house` or `has water`, `has a bed`, and `N zombies seen`.

A failed order stays off the menu for a while, so `stuck` is not resent straight away. Most fails wait 45 seconds. `stuck` 60, `unreachable` 90, `locked` 20 minutes, `too soon` 5 minutes. A search that fails `nothing left` marks the building searched for good.

## Policy

Checked in this order. The first rule whose option is on the menu is sent, and the model is not called.

| Rule | When | Sends |
|---|---|---|
| `bleeding` | `bleeding > 0` | `bandage` |
| `thirst` | thirst 0.6 or more, or the moodle at 2 | `drink` |
| `night-outside` | 21:00 to 06:00 and outside | the nearest house on the menu (`ENTER`) |
| `night-secure` | night, inside, not secured since entering | `secure` |
| `sleep` | fatigue 0.8 or tired moodle 3; or night, tired, inside and secured | `sleep` |

If a voice line is waiting, the model is still called, with a menu of just the policy's option, so it can answer in its thought.

## Not asking while a job runs

`res.status` is `running` for a skill or needs verb (`GOTO ENTER SEARCH LOOT DRINK FILL EAT SLEEP BANDAGE WEARBAG SECURE REST`). MOVE and the old one-shot verbs stay `running` forever, so they do not count. While one runs, the brain sends nothing and asks nothing unless:

- a zombie starts chasing,
- a new need flag appears (bleeding, wounded, thirsty, hungry, tired, exhausted, winded, panicked, heavy, night outside),
- a voice line arrives,
- or 20 seconds passed.

After a chosen `wait` it rechecks after 8 seconds. After it writes an order, it waits until the percept's `lastSeq` reaches it (10 seconds at most). While he is asleep it sends nothing, so no MOVE or GOTO wakes him.

The percept has no asleep flag yet. The bridge counts him asleep after `SLEEP` reports `asleep...`, until fatigue drops under 0.1, he moves, a new order runs, or 12 game hours pass.

## The prompt

The system message never changes, so Ollama reuses its cache for it. The user message is the part that changes:

```
SITUATION:
Day 2, 11:00, daytime. Outside.
Health 100. Thirst low. Hunger low. Tiredness low. Panic none. Endurance 90%.
0.8 L of water carried. Food: 2 ready to eat, 3 sealed cans and a can opener. 2 bandages.
Holding a Baseball Bat (70%). Wearing a School Bag. Load 6.8 of 8.
Zombies: 1 has not seen you, nearest 7 tiles E.
Last order: ENTER done (in by a door).
Map: 2 buildings known, 0 visited, 0 searched.

RULES FOR NOW:
- Never fight more than one standing zombie. Go around ones that have not seen you.
- Enter quietly through a door. Smash a window only when there is no other way.

OPTIONS:
b1: walk into house 15 tiles SW, not visited
away: walk quietly 15 tiles W, away from the zombie that has not seen you
eat: eat something (2 ready to eat)
wait: wait here and watch

Pick one id: b1, away, eat, wait.
```

The reply format is a JSON schema in Ollama's `format`: `thought` (160 characters at most) first, then `choice` as an enum of this turn's ids. The model cannot pick an option that is not on the menu. `num_predict` is 96, `keep_alive` is `30m` (`PZ_KEEP_ALIVE`), `think` is off. `PZ_MODEL`, `OLLAMA_URL` and `PZ_TIMEOUT` work as before.

Panic is read from `panic01` (0 to 1). The raw `panic` is 0 to 100, which the old prompt got wrong.

## Playbook

At most 5 rules whose condition holds go into the user message, in this order:

| id | when |
|---|---|
| `wounded` | an untreated wound |
| `go-home` | outside and tired or panicked |
| `night` | 21:00 to 06:00 |
| `overloaded` | heavy moodle, or weight 85% of max |
| `one-at-a-time` | an idle zombie within 20, or more than one in sight |
| `no-weapon` | none in hand and none carried |
| `water` | no water carried |
| `quiet-entry` | outside with buildings in sight |
| `new-houses` | inside a searched building |
| `stay-safe` | inside a safe house at night or tired |

## Map memory

`state.map` in `bridge/pz-state.json`. Delete the file for a fresh mind.

Per building id: `firstSeen`, `lastSeen`, `visited`, `lastVisit`, `enteredAt` (game hours), `searched`, `partly`, `took` (from the search's `why`), `water`, `bed`, `res`, `shop`, `door`, `zombies` (within 15 at the last look inside), `securedAt`, and a rough position.

Safe house score: residential +2, water +2, bed +2, searched +1, shop -1, minus one per zombie seen (up to 4). 5 or more is a safe house.

It also keeps the last 12 orders sent (seq, verb, key, building), the fails with their time, and the sleep guess. Places stay known after a death. Orders, fails and sleep are cleared.

## /mind

`http://localhost:8799/mind` shows the options offered (the chosen one marked), the choice, who decided (policy and its rule, the model, waiting on a skill, the reflex, asleep), the model time, the playbook rules used, and the map memory size. `PZ_LUA_DIR` and `PZ_STATE_FILE` point the bridge at other files, for a page check without the game.

## Live check

`node bridge/tools/try-brain.mjs [model ...]` runs every `v2-*` fixture through the real model, twice, and through the old prompt on the same percept. `--dry` prints the plan, the menu and the user message without a model. Policy turns are also put to the model with the full menu, to show what it would pick.

Run on 2026-11-04, RTX 5080, game not running. "1st" is a new user message with the system prompt cached, which is what a real turn costs. "warm" is the same message again.

### gemma4:12b

| fixture | decided by | sent | model would pick | ms (1st / warm) | old brain | old ms |
|---|---|---|---|---|---|---|
| asleep | asleep | - | - | - | CONCEAL | 704 / 270 |
| bleeding | policy | bandage | bandage | 485 / 258 | LOOT | 510 / 334 |
| close-unaware | hold | - | - | - | MOVE -10,5 | 379 / 302 |
| day-searched-house | model | wearbag | wearbag | 498 / 286 | LOOT | 561 / 321 |
| indoors-thirsty-sink | policy | drink | drink | 471 / 265 | LOOT | 476 / 308 |
| night-outside | policy | b1 (ENTER house 9 N) | b1 | 476 / 277 | MOVE 0,20 | 500 / 318 |
| night-tired-bed | policy | secure | sleep | 459 / 235 | CONCEAL | 458 / 264 |
| outside-chased | hold | - | - | - | MOVE 15,-15 | 402 / 326 |
| outside-unaware-near | model | b1 (ENTER house 15 SW) | b1 | 509 / 304 | MOVE -15,3 | 492 / 310 |
| searching | skill | - | - | - | LOOT | 388 / 339 |

### llama3.1:8b

Rows with no model call are left out. Run before the busy menu was cut down to urgent options, so `searching` was still a model turn here.

| fixture | decided by | sent | model would pick | ms (1st / warm) | old brain | old ms |
|---|---|---|---|---|---|---|
| bleeding | policy | bandage | bandage | 270 / 183 | LOOT | 199 / 138 |
| day-searched-house | model | eat | eat | 221 / 172 | LOOT | 201 / 151 |
| indoors-thirsty-sink | policy | drink | drink | 222 / 210 | LOOT | 184 / 125 |
| night-outside | policy | b1 | b1 | 267 / 188 | CONCEAL | 173 / 126 |
| night-tired-bed | policy | secure | eat | 240 / 192 | CONCEAL | 173 / 125 |
| outside-unaware-near | model | b1 | b1 | 247 / 177 | MOVE 16,0 | 259 / 177 |
| searching | model | equip | equip | 297 / 182 | LOOT | 166 / 124 |

What it shows:

- A menu turn costs about half a second on gemma4:12b, about the same as the old prompt. The reply is 20 to 30 tokens.
- Every model pick was sensible. With the old prompt, gemma looted while bleeding and while thirsty at a sink, and walked south into the dark at night. llama3.1:8b walked `MOVE 16,0` straight at the idle zombie 7 tiles east.
- llama3.1:8b picked `equip` mid-search, which would cancel the search. That is why a busy menu now holds only urgent options.
- The first call after a model switch took 2.8 to 4 seconds to load it. `keep_alive` keeps it loaded.

### Before and after in a game

The old brain, 2026-11-04, 4 minutes in game: `MOVE -16,-16 Building is NW. Going there.` about every 5 seconds. She walked 36 tiles, never reached a building, the unstick helper fired hundreds of times, and a zombie got within 2 tiles while she was unarmed.

The new brain has not been run in a game yet. Its fixture turns go to a named building (`ENTER`) that the game's pathfinder walks to, and it sends nothing while that walk runs. Record the same numbers here after the first live run.

### First live run: what to watch

1. Day, outside, no zombies near: `/mind` shows `b1`..`b3` with `not visited`, and she walks into one with `ENTER`. The log shows no new order while the walk runs.
2. Inside a new house: `search` comes up. The search runs to `done`, `took N: ...` lands in the house's memory, and the next menu labels it `searched`.
3. An idle zombie 5 to 10 tiles off: orders keep coming, `away` is offered, and no `b` option leads past it.
4. A zombie starts chasing within 10: `/mind` says the reflex owns it, no order is written, and a thought that finishes late is dropped.
5. At a sink and thirsty: the policy sends `drink` with no model call.
6. After 21:00 outside: the policy sends her into the nearest house, then `secure`, then `sleep` once she is tired.
7. Asleep: no orders until she wakes.
8. Type in the voice box: the reply shows in the chat and over her head.
9. Count unstick fires in `console.txt` against the old run.
