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
chaser inside 10, or a zombie she can see inside 3 ... hold, the reflex owns it
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
   user:    digest + plan + playbook rules and lessons + recent choices with outcomes
            + orders kept off the menu + pattern note + voice + options
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
| `reactions.mjs` | How the last orders went: the outcome lines, the blocked list, loop detection, the rows of the strip. See "Reactions". | service |
| `digest.mjs` | The situation in plain lines. | formatter |
| `words.mjs` `geom.mjs` | Words for numbers, compass, distances. | pure helpers |
| `planner.mjs` | The slow day plan: events, parsing, the background runner. See `docs/planner.md`. | service |
| `lessons.mjs` | Lessons from past deaths and their triggers. See `docs/planner.md`. | service |
| `decisions.mjs` | The decision log: decision, outcome and after lines, and the join between them. It also keeps the last 12 orders with their results in memory (`history()`). See `docs/eval.md`. | service |
| `death.mjs` | Why she died: the cause and its facts, from the mod's death record. See `docs/eval.md`. | service |
| `nudges.mjs` | Whether a nudge may go ahead, the frozen record, and the example lines for the prompt. | service |
| `commentator.mjs` | The peanut gallery: spots moments, rate limits, asks the meme model for a line. Commentary only. See "Peanut gallery". | service |
| `jsonl.mjs` | Append-only log files with rotation, and a reader that skips bad lines. | I/O |
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
| `bandage` | BANDAGE | a wound is bleeding, deep, bitten, has glass, or is an unbandaged cut or scratch; and `inv.bandages` is above 0 or `inv.canRip` is true (the job rips cloth). A percept with no `canRip` gets the old test: she is bleeding |
| `drink` | DRINK | thirst 0.25 or more (or the moodle); water in a bottle, or a tap in this building |
| `eat` | EAT | hunger 0.25 or more (or the moodle); food ready, or a can and a can opener |
| `equip` | EQUIP | nothing in hand and a melee weapon carried; or a carried weapon whose `score` is 1.25 times the `weaponScore` of the one in hand or more (the mod's own swap line). With no scores in the percept, only the empty hands count |
| `drop` | DROP | heavy (moodle, or weight 85% of the maximum), no chaser, no zombie within 8 |
| `secure` | SECURE | inside, not secured since entering. Night sorts it near the top |
| `sleep` | SLEEP | inside, fatigue 0.5 or more, no chaser, none visible, none within 15, no panic, pain under 2 (unless fatigue over 0.85) |
| `search` | SEARCH | inside, not searched (map memory), `inBldg.roomsLeft` not 0, not overloaded, no zombie within 8. The label counts the rooms left: "2 rooms left, partly searched" |
| `wearbag` | WEARBAG | no bag worn and a bag in the item names |
| `b1` `b2` `b3` | ENTER | buildings in the percept, not this one, not blocked, path clear. Unsearched first, then nearest. A safe house goes first at night, when tired or panicked. The plan's home building goes before that when she needs shelter and from 17:00. With no real weapon, houses come before shops and an unsearched house says "no real weapon yet, look here" |
| `home` | GOTO | the plan's home is a building the map knows, with a door on record, but the percept does not list it, within 120 tiles, path clear. It goes to that door, and ENTER takes over once the building is listed. It leads the menu from 17:00 or when she needs shelter, and sits low by day. At night outside it is left off when a listed house is nearer |
| `fill` | FILL | inside, a tap here, an empty bottle carried |
| `rest` | REST | endurance under 0.6, no chaser |
| `away` | GOTO | an idle zombie within 12, or a chaser: 15 tiles in the clearest direction away |
| `explore` | GOTO | outside with no new building on the menu: 25 tiles in a clear direction |
| `wait` | WAIT | nothing is running |
| `keep` | none | a skill or needs job is running. Picking it sends nothing |

While a skill or needs job runs, any new order cancels it. So the menu then has only `keep` and what is worth stopping for: `bandage`, `drink`, `eat`, `away`, and `secure` when a zombie is chasing. A walk (`GOTO`, `ENTER`) can still switch to another house. If `keep` is the only option, the model is not asked.

Building labels come from map memory: `not visited`, `visited, not searched`, `partly searched`, `searched`, `safe house` or `has water`, `has a bed`, and `N zombies seen`.

"No real weapon" means nothing in hand or in the bag scores 20 or more. A kitchen knife scores 9 and a hammer 19, a crowbar 30 (`docs/combat.md`). An older percept with no scores counts only empty hands and an empty bag.

`res.target` says what the running job works on, so a restart of the bridge mid-job still knows. If the bridge has no record of the order, `ENTER`, `SEARCH` and `SECURE` use the building id in it as their option key, and a `GOTO` is matched by its `x,y` against this turn's walks. Otherwise the verb alone stands for the job, as before.

A failed order stays off the menu for a while, so `stuck` is not resent straight away. Most fails wait 45 seconds. `stuck` 60, `unreachable` 90, `locked` 20 minutes, `too soon` 5 minutes. A search that fails `nothing left` marks the building searched for good.

## Policy

Checked in this order. The first rule whose option is on the menu is sent, and the model is not called.

| Rule | When | Sends |
|---|---|---|
| `bleeding` | `bleeding > 0`. Steps aside when `bandage` is not on the menu (no bandage, nothing to rip) | `bandage` |
| `thirst` | thirst 0.6 or more, or the moodle at 2 | `drink` |
| `hunger` | hunger 0.6 or more, or the moodle at 2, and `inv.foodReady` above 0. A can that needs opening is the model's call | `eat` |
| `equip` | a carried weapon is clearly better than the one in hand, or the hands are empty | `equip` |
| `night-outside` | 21:00 to 06:00 and outside | the nearest house on the menu (`ENTER`) |
| `night-secure` | night, inside, not secured since entering | `secure` |
| `sleep` | fatigue 0.8 or tired moodle 3; or night, tired, inside and secured | `sleep` |
| `overloaded` | heavy, no chaser (and `drop` is on the menu, so no zombie within 8) | `drop` |

`equip` is kept off the menu for 45 seconds after it is sent. EQUIP never reports done while the weapon is still being raised, so without that the rule would send it again on every look. A `done` result lifts the block at once, and a failed `drop` or `equip` stays off longer (`not heavy` 3 minutes, `nothing to drop` and `equip: no weapon` 10).

If a voice line is waiting, the model is still called, with a menu of just the policy's option, so it can answer in its thought.

## Not asking while a job runs

`res.status` is `running` for a skill or needs verb (`GOTO ENTER SEARCH LOOT DROP DRINK FILL EAT SLEEP BANDAGE WEARBAG SECURE REST`). MOVE and the old one-shot verbs stay `running` forever, so they do not count. While one runs, the brain sends nothing and asks nothing unless:

- a zombie starts chasing,
- a new need flag appears (bleeding, wounded, thirsty, hungry, tired, exhausted, winded, panicked, heavy, night outside),
- a voice line arrives,
- or 20 seconds passed.

After a chosen `wait` it rechecks after 8 seconds. After it writes an order, it waits until the percept's `lastSeq` reaches it (10 seconds at most). While he is asleep it sends nothing, so no MOVE or GOTO wakes him.

Asleep is the percept's `asleep` flag, the game's own state. It is trusted when it is a boolean. A percept without it (an older mod) gets the old guess: the bridge counts him asleep after `SLEEP` reports `asleep...`, until fatigue drops under 0.1, he moves, a new order runs, or 12 game hours pass.

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

RECENT CHOICES:
- ENTER house W: failed, zombies at the door, lost 20 HP
- GOTO away: done, still chased by 2

NOT ON THE MENU NOW:
- house W: zombies at the door, 1 min ago

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
| `wounded` | an untreated wound, and a bandage carried or one she could rip |
| `go-home` | outside and tired or panicked |
| `night` | 21:00 to 06:00 |
| `overloaded` | heavy moodle, or weight 85% of max |
| `one-at-a-time` | an idle zombie within 20, or more than one in sight |
| `no-weapon` | none in hand and none carried |
| `weak-weapon` | a weapon in hand or bag, but nothing scores 20 or more |
| `water` | no water carried |
| `quiet-entry` | outside with buildings in sight |
| `new-houses` | inside a searched building |
| `stay-safe` | inside a safe house at night or tired |

## Reactions

The model used to see only what was chosen. Now it also sees how each choice went. Code: `bridge/reactions.mjs`. The data comes from the tracker in `decisions.mjs`, which keeps the last 12 orders in memory (not saved), and from map memory `fails`.

Three parts go into the prompt, each only when it has something to say:

| Part | What it holds |
|---|---|
| `RECENT CHOICES` | The last 3 orders of this run, oldest first, one line each, under 90 characters. Name, then what happened. |
| `NOT ON THE MENU NOW` | Up to 3 orders map memory is keeping off the menu after a failure, newest first: name, why, how long ago. A house is named by where it is now (`house W`) and only while the percept still lists it. |
| A pattern line | One plain sentence when the orders go in circles. |

How a recent line reads:

| Case | Line |
|---|---|
| failed | `ENTER house W: failed, zombies at the door, lost 20 HP` |
| done | `GOTO away: done, still chased by 2` (the chase count is read when it ended; `lost N HP` is added at 1 HP or more) |
| newer order sent first | `ENTER house W: cut off by a newer order` |
| still going | `SEARCH: running, 2 rooms left` (rooms left from `inBldg.roomsLeft`, otherwise the body's `res.why`, otherwise `sent, not started yet`) |
| no result | `no result in time`, or `she died before it finished` |

An order is named by its verb and, for a walk into a building, by kind and side (`ENTER house W`, from the option's `name`), or by its menu id for a `GOTO` (`GOTO away`). The mod's reason codes are put into words (`zombie` on an ENTER is `zombies at the door`); an unknown one is passed on as it is, cut to 40 characters. Orders from an earlier character are left out (matched by the stats run id).

The pattern line is the first of these that holds:

1. Flee and walk back in, twice in two minutes (`GOTO away` then an `ENTER`, two times): `You keep getting chased off houses. Try a quieter house, or leave this street.`
2. The same kind of order failed twice in a row or more within 5 minutes, with nothing of that kind working in between: `Walking into a building failed twice in a row. Try something else first.`
3. The last order failed (within 5 minutes), nothing newer was sent, and the same job is on the menu again: `Your last order, ENTER house N, failed (zombies at the door). It is on the menu again. Try something else first.` A failed walk into a building stays off the menu for 30 seconds and then comes back, usually with the zombies still there.

The line only says what happened. It does not tell her to fight: the model never swings, the reflex does.

### The Reactions strip on /mind

The last 8 orders as rows: time, choice, result, HP change (the order's start to its end; hover for HP lost on the way), and the choice that came next. A failed row is red, a running one teal, a cut-off one grey. The page refreshes every two seconds but rebuilds the strip only when a row changed, so a selection or a hover on it stays put. `/api/state` carries the rows as `reactions`.

### What it costs and what it changes

Measured on 2026-11-04 with `node bridge/tools/try-brain.mjs --reactions --n 10 gemma4:12b` (RTX 5080, six fixtures that call the model, best of 10 per turn). The added text is the worst case: 3 outcome lines, 3 blocked lines and a pattern line.

| | plain | with reactions | added |
|---|---|---|---|
| turn time, mean of the six best-of-10 | 393 ms | 409 ms | 16 ms |
| prompt tokens | 559 | 673 | 114 |
| time reading the prompt | 204 ms | 243 ms | 39 ms |

The prompt grows by about 600 characters at most. Most turns carry far less: no history means no section.

Whether it changes a pick, from three eval scenarios where the right pick depends on a recent outcome (gemma4:12b, 6 runs each, with the history in the prompt and without):

| scenario | without | with |
|---|---|---|
| `retry-failed-house` | 0 of 6 accepted | 6 of 6 |
| `flee-loop-quieter-house` | 0 of 6 | 6 of 6 |
| `two-houses-failed-pick-third` | 0 of 6 | 6 of 6 |

Without the history it picks the nearest house, the one that just failed, every time. The first version of this change had only the recent line for the one-failure case, and `retry-failed-house` scored 0 of 2. The third pattern line is what fixed it.

## Map memory

`state.map` in `bridge/pz-state.json`. Delete the file for a fresh mind.

Per building id: `firstSeen`, `lastSeen`, `visited`, `lastVisit`, `enteredAt` (game hours), `searched`, `partly`, `took` (from the search's `why`), `water`, `bed`, `res`, `shop`, `door`, `zombies` (within 15 at the last look inside), `securedAt`, and a rough position.

`door` is the exterior door `{x, y}` the percept listed, kept after the building drops out of the 6 nearest. It is what the `home` walk goes to. A door that is not a pair of numbers is ignored. `searched` is also set when the building the survivor stands in reports `roomsLeft` 0.

Safe house score: residential +2, water +2, bed +2, searched +1, shop -1, minus one per zombie seen (up to 4). 5 or more is a safe house.

It also keeps the last 12 orders sent (seq, verb, key, building), the fails with their time, and the sleep guess. Places stay known after a death. Orders, fails and sleep are cleared.

## /mind

`http://localhost:8799/mind` shows the options offered (the chosen one marked), the choice, who decided (policy and its rule, the model, waiting on a skill, the reflex, asleep), the model time, the playbook rules used, the map memory size, and the Reactions strip (see "Reactions"). `PZ_LUA_DIR` and `PZ_STATE_FILE` point the bridge at other files, for a page check without the game.

The Nudge panel on the same page lets you pick the option you would have chosen. See "Nudges" in `docs/eval.md`. A model thought that was still running when you pressed "Do it now" is dropped when it finishes, so it cannot overwrite your order.

## Peanut gallery

A second local model, `pepe-8b_abliterated_pc:latest`, reacts to what happens, for fun. It is commentary only. It never decides anything, never writes an order, and nothing it says goes into the brain's prompt, the planner's prompt or the order line. Its lines go to `bridge/pepe.log` and to the Peanut gallery panel on /mind, which shows the last 10, newest first. The panel is filled from the log when the bridge starts, so it survives a page refresh and a restart.

```
percept, order history, plan --> moments --> pending
pending --> one line at most every 30 s, only when nothing else needs Ollama --> pepe.log + panel
```

What it notices: a kill, losing 8 or more HP at once, starting to bleed, HP falling to 25 or below, a clearly better weapon in hand (hands empty to anything, or a score 1.25 times higher), walking into a building, locking one up, a failed order, a flee and re-enter loop, the planner's new plan, and death. When several land together the heaviest is spoken and up to two others ride along in the prompt. A moment older than 45 seconds is dropped. Death is always spoken, never rate limited, and waits for a free model.

How it stays out of the way:

- CPU only (`num_gpu` 0), the shared `num_ctx`, `num_predict` 80, thinking off. It takes no VRAM and does not make Ollama reload the menu model.
- It does not start while a menu turn, a plan, the death review or a menu turn's whole think-and-send is running.
- A menu turn or a plan that starts while it is writing cancels it at once. The moment goes back in the queue and does not use up the 30 seconds.
- One comment at a time. A moment that arrives during one waits for the next slot.

The only changes to what the model says are a length cap (240 characters) and control characters turned into spaces. The log is capped at 1 MB and rolls to `pepe.log.1`.

Switches: `PZ_PEPE=0` turns it off. `PZ_PEPE_MODEL` picks another model. `PZ_PEPE_GPU_LAYERS` (default 0), `PZ_PEPE_PREDICT` (80), `PZ_PEPE_TIMEOUT`, `PZ_PEPE_KEEP_ALIVE` (10m), `PZ_PEPE_FILE` and `PZ_PEPE_LOG_MAX` (bytes) tune it. It is on by default when Ollama lists the model. If the model is not installed, or a call gets a 404, it logs one line and turns itself off for the session.

Measured on this PC on 2026-11-05 with the game running (`node bridge/tools/try-pepe.mjs`, `gemma4:12b` as the menu model, 5 runs):

| | time |
|---|---|
| first line, model loading | 11.7 s |
| warm line | 1.8 to 4.0 s, median 2.7 s |
| menu turn alone | 355 to 485 ms, median 392 ms |
| menu turn fired 0.7 s into a comment | 471 to 552 ms, median 518 ms, the comment cut every time |
| lines through the real bridge, with its own menu turns and plans running | 2.2 s, 4.2 s, 11.8 s |

A menu turn that lands in the middle of a comment costs about 120 ms more than one on a quiet model, because the CPU is still winding down. It stayed under 600 ms in all five runs.

## Examples from your nudges

With `PZ_EXAMPLES` on, the user message gets up to two lines from your past nudges, after the rules:

```
EXAMPLES:
- In a similar spot, the better pick was away (walk quietly 15 tiles W, away from the zombie that has not seen you) because the zombie is too close to walk past.
```

A nudge counts as similar when she was in the same place (inside or outside), at the same time of day (night is 21:00 to 06:00), chased or not, and at least half of the needs match (thirsty, tired, heavy and so on). Its pick has to be on today's menu, matched by key, and the line quotes today's id. Picks where you disagreed with the brain come first, then ones with a reason, then the newest. Only the last 200 nudges are looked at. The lines are left out when none fit, so a bridge with no nudge file sends the same prompt as before.

`PZ_EXAMPLES=0` turns them off, `1` on. It is on by default.

Why on: measured with `node bridge/tools/try-brain.mjs --examples --n 10` on 2026-11-04 (gemma4:12b, RTX 5080, six fixtures with a model call, two stand-in example lines of the usual length, best of 10 per turn):

| | plain | with examples | added |
|---|---|---|---|
| turn time, best of 10 | 437 ms | 454 ms | 17 ms |
| turn time, median of 10 | 456 ms | 483 ms | 27 ms |
| prompt tokens | 559 | 627 | 68 |
| time reading the prompt | 230 ms | 256 ms | 26 ms |

That is far under the 150 ms line, so it is on. Both numbers come from the same message asked alternately, so a slow GPU moment hits both. A first try of the same command, while two other large models were using the GPU, gave 3.8 s against 4.6 s with a spread of seconds per fixture, so it showed nothing. The best-of number is the one to trust, and the command prints the median beside it.

## Live check

`node bridge/tools/try-brain.mjs [model ...]` runs every `v2-*` fixture through the real model, twice, and through the old prompt on the same percept. `--dry` prints the plan, the menu and the user message without a model. Policy turns are also put to the model with the full menu, to show what it would pick. `--examples [--n 5]` times each turn with and without the example lines instead.

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
