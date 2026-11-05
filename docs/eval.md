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
memory       map memory to seed: current building, buildings by id (door, searched, water, bed),
             fails ({key: {why, ago}}, orders that failed `ago` seconds ago)
plan         the planner's day plan {goal, steps, home}, only where the moment depends on it
history      the orders she sent just before, oldest first: {verb, key, name, result, why, lost, chase, ago}.
             Only where the right pick depends on how they went (docs/brain.md, "Reactions")
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

## Latest run: gemma4:12b, 37 scenarios, with outcomes in the prompt

2026-11-04, after the brain began to tell the model how its last orders went (`docs/brain.md`, "Reactions"). Three scenarios are new: `retry-failed-house`, `flee-loop-quieter-house` and `two-houses-failed-pick-third`. In each one the nearest house just failed and is on the menu again, and the right pick is another house. `--n 2`, default prompt, RTX 5080 with Ollama on the same PC, game not running.

```
Model turns: 40/44 accepted, 1 wrong, 3 other, 0 bad replies. Mean 387 ms, p90 438 ms.
Policy turns (no model): 15 scenarios, 15 accepted, 0 wrong.
```

- The three new scenarios: 6 of 6 accepted (`b2 b2`, `b2 b2`, `b3 b3`). Asked six times each without the history, all three pick the failed house every time (0 of 18). The table is in `docs/brain.md`.
- The other misses are the ones seen before: `winded-no-chase` (0 of 2, `b1` instead of `rest`), `can-with-opener` (1 of 2) and `panicked-outside` (1 of 2, one wrong). The first run of the same code this day had `panicked-outside` 0 of 2 and `can-with-opener` 0 of 2. Read the totals.
- Latency is higher than the run below (mean 387 ms against 269 ms). Two scenarios had a slow call (`two-chasers-house-close` p90 941 ms, `unsearched-house-no-weapon` p90 904 ms). A run of the same code earlier the same hour had a mean of 340 ms. The cause of the gap was not checked. The prompt alone adds 16 ms a turn at its longest (`docs/brain.md`).

## Earlier run: gemma4:12b, 34 scenarios

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

## Decision log

`bridge/decisions.jsonl` gets one line for every turn the policy or the model decided. Turns that wait (the reflex, sleep, a running job) write nothing. The file is only ever appended to, and it is ignored by git. Past about 20 MB it moves to `decisions.jsonl.1` (the old `.1` is dropped) and a new file starts. `PZ_DECISIONS_FILE` and `PZ_LOG_MAX_BYTES` change the path and the cap.

Every line has `t` and `id`. The three kinds of line for one decision share the `id`.

| `t` | Written | Fields |
|---|---|---|
| `decision` | when the turn is decided | `at`, `run` (the stats run's start time), `day`, `hour`, `percept` (a small copy), `menu` (id, verb, key, label), `by` (`policy`, `model` or `nudge`), `rule` (the policy rule), `choice`, `verb`, `key`, `thought`, `sent`, `seq`, `rules` (playbook rule ids and `lesson:` ids), `ms` (model time) |
| `outcome` | when the order reports | `result` (`done` or `failed`), `why`, `verb`, `ms` (how long it ran), `hpDuring` (hp at the end minus hp at the start), `lostDuring` (hp lost along the way) |
| `after` | when the follow-up closes | `hpAfter` and `lostAfter` (the 60 seconds after the order finished), `chased` (a zombie started chasing since the order was sent), `died` (she died within 5 minutes of the choice) |

Notes:

- `sent` is false when the model chose `keep`. That line has no outcome.
- An order that a newer order cancelled gets `result: replaced`. One with no result after 5 minutes gets `unfinished`. Death closes every open order as `unfinished` with `why: died`.
- The windows use the wall clock, so fast-forward makes them longer in game time.
- Orders still open when the bridge stops have a decision line and no outcome.
- A new character that the bridge never saw die closes the open orders with `died: false`.

## Nudges

On `/mind`, the Nudge panel shows the current menu as buttons, with the brain's pick marked. Pick the option you would have chosen, add a short reason, or write what option is missing, then press one of two buttons:

- **Do it now** sends that option as the next order, through the same call a policy order uses. It is refused, with a message and nothing sent, while the reflex owns the moment, while she is asleep, with no live senses, when the menu changed since you looked, and for `keep` or the job already running.
- **Just log it** changes nothing in the game. It works on the last menu even while the reflex holds.

The page refreshes every two seconds. The buttons are rebuilt only when the menu changes, and the text boxes are never touched. The pick is kept across a new menu when the same job is still on it. A nudge that goes through clears the form, and a refused one keeps it.

Each nudge that goes through writes a line to `bridge/nudges.jsonl` (ignored by git, `PZ_NUDGES_FILE` moves it). The POST is `/api/nudge` with the `x-mind: 1` header, like the lesson delete, so another site cannot send it.

| Field | Meaning |
|---|---|
| `at`, `run`, `mode` | when, which run, `now` or `log` |
| `applied` | true when the order was sent |
| `pick`, `pickKey`, `pickVerb`, `pickLabel` | the option he picked. Null when he only noted a missing one |
| `missing`, `why` | his words |
| `brain` | the brain's pick when the menu was shown: `id`, `key`, `verb`, `by`, `rule`, `thought` |
| `situation` | place, time, chase and main need in words. The review groups on it |
| `menu` | the full menu he was looking at (with `a`, `b`, `target`, `key`) |
| `percept`, `memory`, `plan` | the whole percept, the map memory the menu read, the day plan |

The record is frozen from the menu he was looking at, not from whatever is on when the request arrives. The pick is matched by its `key`, because ids such as `b1` point at a different house each turn.

## Review report

```
node bridge/tools/review.mjs                      both logs, all of it
node bridge/tools/review.mjs --since 2026-11-04   from that date on
```

It prints, in a few lines each: how often the brain had your pick (overall and by situation), the missing-option notes grouped (notes that share half their words count as one), the verbs whose orders fail most with the reasons, and the choices most often followed by damage (5 hp or more, in the order or the minute after) or by death. `--decisions` and `--nudges` point at other files. The rotated `.1` file is read too.

## Nudges as scenarios

```
node bridge/tools/nudges-to-eval.mjs          writes bridge/eval/scenarios/nudge-<date>-<n>.json
node bridge/tools/nudges-to-eval.mjs --dry    says what it would write
```

Each nudge with a pick becomes a scenario whose `accept` is his pick, so `node bridge/eval/run.mjs` shows how often the brain now agrees with him. The scenario's `patch` is the frozen percept (only the keys that differ from `base.json`), with the memory and plan saved in the nudge. The pick is found again on the rebuilt menu by its key. `<n>` counts the day's nudges in file order, so a name does not move.

A nudge is skipped, with the reason printed, when it has no pick, was exported before (the scenario's `from` is the nudge time), matches a scenario already there, cannot be rebuilt with his pick on the menu, or the moment was not a choice (the reflex or a running job owned it). Generated scenarios are not committed. `bridge/fixtures/nudges-example.jsonl` is the one example the tests use.
