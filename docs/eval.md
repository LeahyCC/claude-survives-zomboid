# Eval and run stats

A scoreboard for the brain. Change a prompt, a rule or a model, run the eval, and see if the survivor got better or worse.

## Run it

```
node bridge/eval/run.mjs                           default model, 3 runs per scenario
node bridge/eval/run.mjs --model llama3.1:8b --n 2
node bridge/eval/run.mjs --only bleeding
```

Needs Ollama on `http://127.0.0.1:11434` (or `OLLAMA_URL`). If it is not reachable the script says so and stops. The exit code is always 0: it is a report, not a test. A fast unit test (`bridge/eval/scenarios.test.mjs`, part of `npm test`) checks that every scenario file is valid and that its accepted ids exist on the menu the builder makes for it.

## What a scenario is

One JSON file in `bridge/eval/scenarios/`. It is a patch over `bridge/eval/base.json` (a healthy survivor outside by day, one unvisited house nine tiles north), plus map memory where the moment needs it.

```
name, note   what the moment is
patch        v2 percept fields that differ from the base
memory       map memory to seed: current building, buildings by id (door, searched, water, bed)
plan         the planner's day plan {goal, steps, home}, only where the moment depends on it
accept       option ids a good player would take
wrong        option ids that are clearly bad
```

The accepted ids come from "Pro play in Build 42" in `docs/research.md`: treat a bleed first, drink when water is here, be inside at night, go home when tired, search new houses, go round zombies that have not seen you.

## How a run works

Each scenario goes through the real turn path: `planTurn` builds the menu and decides who owns the turn. Then:

- **policy**: a need rule picked the option and the model is never asked. One run, counted `n` times, so the table shows what the rule does.
- **ask**: the model gets the real prompt and menu `n` times, with the same JSON schema as the game.
- **no order**: the reflex or a running skill owns the turn. No scenario should land here.

## How to read the table

| Column | Meaning |
|---|---|
| by | `policy (rule)` or `model` |
| accepted | picks in the scenario's `accept` list |
| wrong | picks in its `wrong` list |
| other | a legal pick that is neither. Not always bad, but not what a good player did. |
| bad reply | the call failed or the reply was not a menu id |
| mean ms, p90 ms | model latency per call, after one warm-up call so model loading is not counted |
| picks | what was chosen, one per run |

The summary line counts model turns only. Policy turns are listed separately because they cost nothing and never vary.

Two runs per scenario is a small sample. A single scenario flipping between runs is noise. A model that never picks the right id on a scenario is a finding.

## Latest run: gemma4:12b, 34 scenarios

After the brain began to read `asleep`, `res.target`, `inBldg.roomsLeft`, `inv.canRip` and the weapon scores, and gained the hunger, equip and overloaded policy rules, the DROP verb and the walk home. `--n 3`, default prompt, RTX 5080 with Ollama on the same PC.

```
Model turns: 52/57 accepted, 0 wrong, 5 other, 0 bad replies. Mean 269 ms, p90 311 ms.
Policy turns (no model): 15 scenarios, 15 accepted, 0 wrong.
```

| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |
|---|---|---|---|---|---|---|---|---|
| bag-not-worn | model | 3 | 0 | 0 | 0 | 275 | 305 | wearbag wearbag wearbag |
| better-weapon-in-bag | policy (equip) | 3 | 0 | 0 | 0 | - | - | equip |
| bitten-no-bleed | model | 3 | 0 | 0 | 0 | 269 | 296 | bandage bandage bandage |
| bleeding-no-bandage | policy (bleeding) | 3 | 0 | 0 | 0 | - | - | bandage |
| bleeding-no-kit | model | 3 | 0 | 0 | 0 | 270 | 313 | b1 b1 b1 |
| bleeding | policy (bleeding) | 3 | 0 | 0 | 0 | - | - | bandage |
| can-no-opener | model | 3 | 0 | 0 | 0 | 248 | 280 | b1 b1 b1 |
| can-with-opener | model | 1 | 0 | 2 | 0 | 260 | 292 | b1 eat b1 |
| carrying-a-weapon-not-held | policy (equip) | 3 | 0 | 0 | 0 | - | - | equip |
| empty-bottles-at-sink | model | 3 | 0 | 0 | 0 | 277 | 311 | fill fill fill |
| hungry-ready-food | policy (hunger) | 3 | 0 | 0 | 0 | - | - | eat |
| idle-zombie-near-door | model | 3 | 0 | 0 | 0 | 269 | 293 | away away away |
| night-inside-unsecured | policy (night-secure) | 3 | 0 | 0 | 0 | - | - | secure |
| night-outside-sleepy | policy (night-outside) | 3 | 0 | 0 | 0 | - | - | b1 |
| night-outside | policy (night-outside) | 3 | 0 | 0 | 0 | - | - | b1 |
| nothing-new-around | model | 3 | 0 | 0 | 0 | 249 | 281 | explore explore explore |
| overloaded-in-house | policy (overloaded) | 3 | 0 | 0 | 0 | - | - | drop |
| overloaded-outside-junk | policy (overloaded) | 3 | 0 | 0 | 0 | - | - | drop |
| panicked-outside | model | 3 | 0 | 0 | 0 | 309 | 338 | b1 b1 b1 |
| rooms-left-zero | model | 3 | 0 | 0 | 0 | 263 | 297 | b1 b1 b1 |
| searched-house-new-nearby | model | 3 | 0 | 0 | 0 | 277 | 310 | b1 b1 b1 |
| starving-ready-food-inside | policy (hunger) | 3 | 0 | 0 | 0 | - | - | eat |
| thirsty-bottle | policy (thirst) | 3 | 0 | 0 | 0 | - | - | drink |
| thirsty-sink-here | policy (thirst) | 3 | 0 | 0 | 0 | - | - | drink |
| tired-day-bed | model | 3 | 0 | 0 | 0 | 271 | 300 | sleep sleep sleep |
| tired-outside-safehouse-known | model | 3 | 0 | 0 | 0 | 246 | 278 | b1 b1 b1 |
| tired-safe-house-bed | policy (sleep) | 3 | 0 | 0 | 0 | - | - | sleep |
| two-chasers-house-close | model | 3 | 0 | 0 | 0 | 262 | 296 | away away away |
| unarmed-house-over-shop | model | 3 | 0 | 0 | 0 | 290 | 324 | b1 b1 b1 |
| unsearched-house-here | model | 3 | 0 | 0 | 0 | 275 | 310 | search search search |
| unsearched-house-no-weapon | model | 3 | 0 | 0 | 0 | 243 | 266 | b1 b1 b1 |
| walk-home-at-dusk | model | 3 | 0 | 0 | 0 | 276 | 306 | home home home |
| walk-home-night-closer-shelter | policy (night-outside) | 3 | 0 | 0 | 0 | - | - | b1 |
| winded-no-chase | model | 0 | 0 | 3 | 0 | 281 | 311 | b1 b1 b1 |

What it shows:

- Three scenarios that were model turns before are policy turns now, and all pass: `hungry-ready-food` (the hunger rule), `carrying-a-weapon-not-held` (the equip rule) and `overloaded-in-house` (the overloaded rule, DROP). The eight new scenarios cover hunger, a better weapon, empty hands, overload, the walk home (by day and at night with a closer shelter), a searched house, and bleeding with nothing to bandage with.
- `unarmed-house-over-shop` took work. With "no real weapon yet" on both buildings the model chose the nearer shop 3 times in 3. With the tag on the house only it chose the house once in 3. With "look here" added it chose the house 6 of 6, and 3 of 3 in the run above. The label is part of the prompt, so this is a prompt change, not a rule change.
- `winded-no-chase` (`b1` instead of `rest`) and `can-with-opener` (`b1` instead of `eat`) are the same small chores the model skips in the earlier tables. Neither has a policy rule.
- Run to run, a single scenario can flip. In an earlier run of the same code `panicked-outside` scored 2 accepted and 1 wrong, and here 3 accepted. Read the totals, not one row.

## Earlier results, 2026-11-05

Before the brain read the newer percept fields, 26 scenarios. All on Ollama with the default prompt, `--n 2`. Eight are policy turns (all eight accepted, for every model). Three of these scenarios have changed since (`hungry-ready-food`, `carrying-a-weapon-not-held` and `overloaded-in-house` are policy turns now; `bleeding-no-bandage` now sets `canRip`), so compare their rows with care.

| model | accepted | wrong | other | bad reply | mean ms | p90 ms |
|---|---|---|---|---|---|---|
| gemma4:12b | 27 / 36 | 2 | 7 | 0 | 355 | 378 |
| llama3.1:8b | 22 / 36 | 4 | 10 | 0 | 435 | 1068 |
| qwen3.5:9b | 27 / 36 | 2 | 7 | 0 | 675 | 2128 |

Scenarios where a model never took an accepted option:

```
gemma4:12b    can-with-opener (b1 instead of eat), carrying-a-weapon-not-held (b1 instead of equip),
              winded-no-chase (b1 instead of rest), panicked-outside (picked the new house, wrong)
llama3.1:8b   bag-not-worn, can-with-opener, carrying-a-weapon-not-held, hungry-ready-food,
              winded-no-chase, nothing-new-around (wrong), overloaded-in-house (wrong)
qwen3.5:9b    bag-not-worn, carrying-a-weapon-not-held, winded-no-chase, overloaded-in-house (wrong)
```

What this shows:

- All three prefer "walk into the house" over the small chores (equip, wear the bag, rest). Nothing makes those urgent in the prompt, so they never win.
- gemma4:12b answers in about 300 to 600 ms warm. llama3.1:8b and qwen3.5:9b have slow outliers of 1 to 5 seconds on some turns. The cause was not checked.
- gemma4:12b did the best on the hard judgement scenarios (two chasers, tired with a safe house known) but chose the new house when panicked.
- The policy layer does the bleeding, thirst and night turns alone, so those scores do not depend on the model.

### Full tables

#### gemma4:12b

| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |
|---|---|---|---|---|---|---|---|---|
| bag-not-worn | model | 2 | 0 | 0 | 0 | 572 | 795 | wearbag wearbag |
| bitten-no-bleed | model | 2 | 0 | 0 | 0 | 337 | 354 | bandage bandage |
| bleeding-no-bandage | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| bleeding | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| can-no-opener | model | 2 | 0 | 0 | 0 | 303 | 318 | b1 b1 |
| can-with-opener | model | 0 | 0 | 2 | 0 | 344 | 385 | b1 b1 |
| carrying-a-weapon-not-held | model | 0 | 0 | 2 | 0 | 312 | 338 | b1 b1 |
| empty-bottles-at-sink | model | 2 | 0 | 0 | 0 | 320 | 355 | fill fill |
| hungry-ready-food | model | 1 | 0 | 1 | 0 | 340 | 377 | b1 eat |
| idle-zombie-near-door | model | 2 | 0 | 0 | 0 | 312 | 348 | away away |
| night-inside-unsecured | policy (night-secure) | 2 | 0 | 0 | 0 | - | - | secure |
| night-outside-sleepy | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| night-outside | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| nothing-new-around | model | 2 | 0 | 0 | 0 | 306 | 340 | explore explore |
| overloaded-in-house | model | 2 | 0 | 0 | 0 | 336 | 372 | wait wait |
| panicked-outside | model | 0 | 2 | 0 | 0 | 347 | 378 | b2 b2 |
| searched-house-new-nearby | model | 2 | 0 | 0 | 0 | 337 | 371 | b1 b1 |
| thirsty-bottle | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| thirsty-sink-here | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| tired-day-bed | model | 2 | 0 | 0 | 0 | 325 | 362 | sleep sleep |
| tired-outside-safehouse-known | model | 2 | 0 | 0 | 0 | 298 | 335 | b1 b1 |
| tired-safe-house-bed | policy (sleep) | 2 | 0 | 0 | 0 | - | - | sleep |
| two-chasers-house-close | model | 2 | 0 | 0 | 0 | 624 | 894 | away away |
| unsearched-house-here | model | 2 | 0 | 0 | 0 | 342 | 377 | search search |
| unsearched-house-no-weapon | model | 2 | 0 | 0 | 0 | 319 | 340 | b1 b1 |
| winded-no-chase | model | 0 | 0 | 2 | 0 | 326 | 349 | b1 b1 |

#### llama3.1:8b

| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |
|---|---|---|---|---|---|---|---|---|
| bag-not-worn | model | 0 | 0 | 2 | 0 | 265 | 285 | b1 b1 |
| bitten-no-bleed | model | 2 | 0 | 0 | 0 | 1099 | 1897 | bandage bandage |
| bleeding-no-bandage | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| bleeding | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| can-no-opener | model | 2 | 0 | 0 | 0 | 980 | 1068 | b1 b1 |
| can-with-opener | model | 0 | 0 | 2 | 0 | 698 | 1126 | b1 b1 |
| carrying-a-weapon-not-held | model | 0 | 0 | 2 | 0 | 246 | 262 | b1 b1 |
| empty-bottles-at-sink | model | 2 | 0 | 0 | 0 | 218 | 246 | search search |
| hungry-ready-food | model | 0 | 0 | 2 | 0 | 278 | 283 | b1 b1 |
| idle-zombie-near-door | model | 2 | 0 | 0 | 0 | 228 | 245 | away away |
| night-inside-unsecured | policy (night-secure) | 2 | 0 | 0 | 0 | - | - | secure |
| night-outside-sleepy | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| night-outside | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| nothing-new-around | model | 0 | 2 | 0 | 0 | 254 | 265 | b1 b1 |
| overloaded-in-house | model | 0 | 2 | 0 | 0 | 253 | 274 | b1 b1 |
| panicked-outside | model | 2 | 0 | 0 | 0 | 1338 | 1705 | b1 b1 |
| searched-house-new-nearby | model | 2 | 0 | 0 | 0 | 488 | 749 | b1 b1 |
| thirsty-bottle | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| thirsty-sink-here | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| tired-day-bed | model | 2 | 0 | 0 | 0 | 251 | 274 | sleep sleep |
| tired-outside-safehouse-known | model | 2 | 0 | 0 | 0 | 276 | 300 | b1 b1 |
| tired-safe-house-bed | policy (sleep) | 2 | 0 | 0 | 0 | - | - | sleep |
| two-chasers-house-close | model | 2 | 0 | 0 | 0 | 245 | 260 | b1 b1 |
| unsearched-house-here | model | 2 | 0 | 0 | 0 | 219 | 236 | search search |
| unsearched-house-no-weapon | model | 2 | 0 | 0 | 0 | 251 | 276 | b1 b1 |
| winded-no-chase | model | 0 | 0 | 2 | 0 | 247 | 254 | b1 b1 |

#### qwen3.5:9b

| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |
|---|---|---|---|---|---|---|---|---|
| bag-not-worn | model | 0 | 0 | 2 | 0 | 1738 | 3076 | b1 b1 |
| bitten-no-bleed | model | 2 | 0 | 0 | 0 | 389 | 426 | bandage bandage |
| bleeding-no-bandage | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| bleeding | policy (bleeding) | 2 | 0 | 0 | 0 | - | - | bandage |
| can-no-opener | model | 2 | 0 | 0 | 0 | 389 | 474 | b1 b1 |
| can-with-opener | model | 2 | 0 | 0 | 0 | 332 | 369 | eat eat |
| carrying-a-weapon-not-held | model | 0 | 0 | 2 | 0 | 314 | 358 | b1 b1 |
| empty-bottles-at-sink | model | 2 | 0 | 0 | 0 | 1355 | 2359 | fill fill |
| hungry-ready-food | model | 1 | 0 | 1 | 0 | 369 | 414 | b1 eat |
| idle-zombie-near-door | model | 2 | 0 | 0 | 0 | 375 | 428 | away away |
| night-inside-unsecured | policy (night-secure) | 2 | 0 | 0 | 0 | - | - | secure |
| night-outside-sleepy | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| night-outside | policy (night-outside) | 2 | 0 | 0 | 0 | - | - | b1 |
| nothing-new-around | model | 2 | 0 | 0 | 0 | 347 | 380 | explore explore |
| overloaded-in-house | model | 0 | 2 | 0 | 0 | 333 | 369 | b1 b1 |
| panicked-outside | model | 2 | 0 | 0 | 0 | 357 | 390 | b1 b1 |
| searched-house-new-nearby | model | 2 | 0 | 0 | 0 | 327 | 347 | b1 b1 |
| thirsty-bottle | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| thirsty-sink-here | policy (thirst) | 2 | 0 | 0 | 0 | - | - | drink |
| tired-day-bed | model | 2 | 0 | 0 | 0 | 2807 | 5270 | sleep sleep |
| tired-outside-safehouse-known | model | 2 | 0 | 0 | 0 | 374 | 439 | b1 b1 |
| tired-safe-house-bed | policy (sleep) | 2 | 0 | 0 | 0 | - | - | sleep |
| two-chasers-house-close | model | 2 | 0 | 0 | 0 | 330 | 381 | away away |
| unsearched-house-here | model | 2 | 0 | 0 | 0 | 1289 | 2128 | search search |
| unsearched-house-no-weapon | model | 2 | 0 | 0 | 0 | 388 | 488 | b1 b1 |
| winded-no-chase | model | 0 | 0 | 2 | 0 | 346 | 401 | b1 b1 |

## Run stats

`bridge/stats.mjs` keeps one record per run (one character) from the percept stream. The last 20 are saved in `bridge/pz-state.json` under `stats.runs`. `/api/stats` returns them, newest first, with the live run as `current`. The `/mind` page shows the same as a table.

| Field | Meaning |
|---|---|
| `start`, `end` | Wall clock times, ISO. `end` is null while the run is live. |
| `hoursAlive` | The percept's `hoursAlive` at the end: in-game hours the character has lived. |
| `hoursSurvived` | `hoursAlive` minus its value when the bridge first saw the run. Differs only if the bridge joined late. |
| `kills` | Highest `kills` seen. |
| `day` | Highest `day` seen. |
| `damage` | Total hp lost. Every drop between two percepts counts. Healing is not subtracted. |
| `searched` | Buildings with a SEARCH that reported done, each counted once. |
| `cause` | A guess from the last ten percepts. |

Cause of death, in the order it is checked:

```
fell        z dropped and no zombie within 3 tiles
dehydrated  thirst 0.95 or more, no zombie within 3 tiles
starved     hunger 0.95 or more, no zombie within 3 tiles
bitten      a zombie within 3 tiles, or a bite wound
bled out    bleeding in the last ten percepts
unknown     none of the above, or the bridge was not watching
```

A run also ends when `hoursAlive` goes backwards by more than half an hour, which means a new character started while the bridge was not looking. Its cause is `unknown`.
