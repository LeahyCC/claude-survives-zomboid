# Planner and lessons

The slow layer from step 6 of `docs/research.md`. Code is the truth: `bridge/planner.mjs`, `bridge/lessons.mjs`, and `callPlanner` in `bridge/llm.mjs`.

## Two speeds

```
slow   planner model   every few game hours, and after a death
       |  plan: goal, up to 3 steps, a home building
       |  lessons: up to 3 rules, each with a trigger tag
       v
fast   chooser         every few seconds, one menu id
       reads: situation, PLAN line, rules, lessons whose trigger is true
       v
body   Lua skills and the reflex
```

The slow layer holds up the fast one for 15 seconds at most. It runs in the background of the bridge. It only starts when no menu turn is waiting on Ollama and no fight is on. If a menu turn needs Ollama while a plan is being written, it waits up to `PZ_PLAN_GRACE` (default 15 seconds), then the plan is cancelled. A warm plan on gemma4:12b took 3.5 to 5.3 seconds on this PC, so most finish inside the grace. Cancelling at once would cut nearly every plan, since menu turns come every few seconds. A cancelled plan is not a planner failure: the events stay pending and the plan is asked again after the usual 30 second gap.

## The plan

Asked on these events. Several at once make one plan. At least 30 seconds pass between plans.

| Event | When |
|---|---|
| `start` | The first live percept after the bridge starts, after a death, or when the game clock goes backwards (another save). |
| `dawn` | The game hour crosses 06:00. |
| `dusk` | The game hour crosses 18:00. |
| `searched` | The count of searched buildings in map memory goes up. |
| `safehouse` | The count of buildings with a safe house score of 5 or more goes up. |
| `interval` | 2 game hours since the last event, when nothing else fired. |

The reply is checked before it is kept: `{goal, steps, home}`.

- `goal` is required, one line, cut to 90 characters.
- `steps` is a list cut to 3 lines of 80 characters. It may be empty.
- `home` must be a building id the map memory knows, or it becomes empty.
- Pipes, newlines and dashes in the text are cleaned.

A bad reply is logged and tried again after 30 seconds. After 3 failures the event is let go. The next event, or the 2 hour timer, asks again.

### What the plan changes

The chooser reads one or two lines after the situation:

```
PLAN: Search two more houses, be home by dusk. (home: building 4021)
NEXT: Search the house next door; Fill bottles at the tap
```

The home building gets the tag `your planned home` on the menu. It goes first in the building options when she needs shelter (night, tired, panicked) and from 17:00 to 21:00. The plan can only rank a building the percept lists (the 6 nearest within 40 tiles). The plan is dropped at death.

### Settings

| Variable | Default | Use |
|---|---|---|
| `PZ_PLANNER_MODEL` | `qwen3.6-35b_abliterated_pc:latest` | The model for plans and death reviews. If the default is not installed (Ollama says 404), the planner uses `PZ_MODEL` from then on. |
| `PZ_PLANNER_GPU_LAYERS` | `0` for the default model, else unset | Layers of the planner model kept on the GPU. `0` is all CPU. Unset or `auto` leaves it to Ollama. |
| `PZ_PLANNER_THINK` | `off` for the default model, else `auto` | `auto` asks Ollama to think and falls back once for a model that cannot. `off` never thinks. |
| `PZ_PLANNER_PREDICT` | `1500` | Token budget. Thinking uses it too. When thinking uses it all and no answer comes back, the plan is asked once more without thinking. |
| `PZ_PLANNER_TIMEOUT` | `120000` | Milliseconds before the call is given up. |

## Lessons

When the character dies, the bridge sends the planner model the last 5 minutes of the decision log (or the last 30 lines if it was quiet), the run stats, and the last live situation. It asks for at most 3 lessons, each `{when, text}`.

- `text` is one sentence under 140 characters.
- `when` is one trigger tag from the fixed list below. A lesson with any other tag is dropped, not repaired.
- A lesson that matches a stored one is dropped. That means the same text ignoring case and punctuation, or the same tag with 70 percent of the words shared.
- At most 20 are stored. A new one past 20 pushes out the oldest.

| Tag | True when |
|---|---|
| `night` | 21:00 to 06:00 |
| `outside` | not inside a building |
| `tired` | tiredness high |
| `panicked` | panic high |
| `wounded` | a wound needs treating |
| `bleeding` | a body part is bleeding |
| `thirsty` | thirst high |
| `hungry` | hunger high |
| `overloaded` | carrying too much |
| `chased` | 1 or more zombies chasing |
| `chased2plus` | 2 or more zombies chasing |
| `inside_unsecured` | inside, doors and curtains not shut yet |
| `no_weapon` | no weapon in hand or carried |
| `low_endurance` | endurance low |

In each menu turn the bridge adds the lessons whose tag is true, at most 3, newest first, to the rules list as `Lesson from a past run: ...`. They follow the playbook rules (at most 5).

### The file

`bridge/lessons.json`, ignored by git:

```
lessons: [{ id, when, text, created (ms), runs }]
runs:    [{ at, hours, kills, used: [lesson ids] }]     the last 50 deaths
```

`runs` on a lesson is how many runs it was active in. A lesson is active in a run when it went into at least one menu prompt. `hours` is `hoursAlive` from the last live percept.

### Is a lesson hurting?

A lesson is flagged on `/mind` when it was active in 3 or more runs and those runs lasted fewer game hours on average than the runs without it. The page shows both averages and run counts. Nothing is deleted for you.

Read the flag as a nudge, not proof. The runs are few, and the runs without the lesson include ones from before it existed. A lesson that only fires at night is compared with runs of every kind.

## `/mind`

- **Plan**: the goal, the steps, the home, why it was asked, how long ago in game hours, and the model that is really planning (the menu model after the default planner turned out to be missing). It says when the planner is thinking, what it is waiting to plan, and the last error.
- **Lessons**: each with its tag, runs active, and average hours with and without. A flagged one has an amber edge and a warning. Each has a delete button.
- **Playbook rules used**: also lists `lesson (tag): text` for the lessons in the last menu prompt.

Delete needs a custom `x-mind` header, so a page on another site cannot delete through your browser.

## How to wipe lessons

- One lesson: the delete button on `/mind`.
- All of them: stop the bridge and delete `bridge/lessons.json`. This also forgets the run record.
- The plan: delete `bridge/pz-state.json`, or let the next event replace it.

Deleting `pz-state.json` does not touch lessons. That is on purpose.

## Check it

`npm test` covers the events, plan parsing, lesson parsing, dedupe, the cap, trigger matching, the run flag, the planner's wait for a free model, a menu turn cutting a plan short, the warm-up and its fallback, and the JSON reader on fenced, prefixed and suffixed replies. The model is mocked. Nothing in it tests a real model's plans or lessons. `bridge/tools/planner-bench.mjs` runs the planner prompt against Ollama for timing and shape (see the last section). Read the first few plans from a live run before trusting them.

The last two defaults go with the default model only. Set `PZ_PLANNER_MODEL` and the planner runs as before: Ollama places the model and thinking is on auto. An explicit `PZ_PLANNER_GPU_LAYERS` or `PZ_PLANNER_THINK` always wins.

Every call to Ollama, menu turns and the planner alike, uses one context size, `PZ_NUM_CTX` (default 8192). Ollama reloads the model whenever `num_ctx` changes between requests, so two sizes would cost a reload at each switch.

## Which model plans

Measured with `node bridge/tools/planner-bench.mjs <model>` on 2026-11-04. The card is an RTX 5080 with 16 GB and the PC has 135 GB of RAM. **Project Zomboid was running** (ProjectZomboid64.exe up, the card at 14.7 to 15.7 GB used before any model). Other programs were calling Ollama for part of the time, so the slow outliers below are not clean.

### The risk was the wrong one

The worry was that a big planner would push the menu model out of VRAM, so the next menu turn would pay a load. It never happened. After every plan the menu model (`gemma4:12b`) was still loaded in `/api/ps`. The game already holds most of the card, so Ollama only gives a big model 4 to 5 GB of it and runs the rest on the CPU. `gemma4:12b` itself keeps only 8 of its 31 layers on the GPU while the game runs (Ollama's log), which is why a menu turn is 0.3 to 0.5 s here.

What does cost time is the planner sharing compute. A thinking plan on a model split across the GPU and CPU ran for over 2 minutes, and menu turns around it took up to 4.6 s. Putting the whole planner on the CPU with `num_gpu: 0` leaves the GPU to the menu model. A request with a different `num_gpu` reloads only the planner model. The shared `num_ctx` rule below is unchanged.

### Results

Each row is the real planner prompt, `PLAN_SYSTEM` and `planSchema()` through `callPlanner` on four fixtures (night outside, bleeding, searched house, fresh start). The baseline had 3 runs of each. The others had 1 to 3, because a thinking plan on a big model takes minutes. One menu turn on `gemma4:12b` is timed right after each plan. The menu baseline was 0.3 to 0.5 s when the machine was quiet. "Real home" is a plan whose `home` is a building id from that fixture. "Dropped" counts plans after which `gemma4:12b` was gone from `/api/ps`.

| planner | placement | thinking | plans | parsed | real home | plan time (cold / warm median) | menu after plan (median / max) | dropped |
|---|---|---|---|---|---|---|---|---|
| gemma4:12b (baseline) | Ollama | auto | 12 | 11 | 11 | - / 5.8 s | 0.8 s / 1.1 s | 0 of 12 |
| gemma4-26b | Ollama | auto | 5, one timed out at 200 s | 4 | 4 | over 200 s / 143 s | 2.9 s / 4.6 s | 0 of 5 |
| gemma4-26b | Ollama | off | 4 | 4 | 4 | 11 s / 4.9 s | 0.6 s / 0.8 s | 0 of 4 |
| gemma4-26b | num_gpu 0 | auto | 2 | 2 | 2 | - / 148 s | 0.4 s / 0.4 s | 0 of 2 |
| gemma4-26b | num_gpu 0 | off | 4 | 4 | 4 | - / 8.6 s | 0.4 s / 6.2 s | 0 of 4 |
| qwen3.6-35b | Ollama | off | 4 | 4 | 4 | - / 5.5 s | 0.4 s / 0.6 s | 0 of 4 |
| qwen3.6-35b | num_gpu 0 | auto | 2 | 2 | 2 | - / 115 s | 0.4 s / 0.4 s | 0 of 2 |
| **qwen3.6-35b** | **num_gpu 0** | **off** | 12 | 12 | 12 | 31 s / 6.2 s | 0.4 s / 0.4 s | 0 of 12 |
| qwen3.6-27b | num_gpu 0 | off | 4 | 4 | 4 | 54 s / 34 s | 0.5 s / 0.6 s | 0 of 4 |

Names are the installed tags without `_abliterated_pc:latest`. The 6.2 s menu turn in the `gemma4-26b` CPU row came while other programs were calling Ollama. It was not repeated. The menu turns in the 12B rows ran slower (0.8 s) than in the later rows (0.4 s) with nothing changed on the menu side, so part of that gap is the state of the PC and not the planner. The 12B's one parse failure was a reply the JSON reader could not find an object in. The reader has since been fixed (see JSON in replies).

The chosen row again, with a menu turn fired 1.5 s into each plan (8 plans): the menu turn during the plan took 0.46 to 0.48 s, and after it 0.37 to 0.44 s.

Cold start of the chosen model: the first plan after Ollama unloaded it took 31 s. That is longer than `PZ_PLAN_GRACE` (15 s), so a menu turn arriving meanwhile cuts the plan short. Ollama still finishes the load. In a test with a menu turn every 3 s, the first plan was cut at 18 s, the retry took 6 s, and menu turns stayed at 0.36 to 0.41 s during the load. Without a fix the first plan of a session is lost and the second works. With `keep_alive` at 30 minutes the model stays loaded between plans.

Not run: `qwen3.8-27b` (the same class as `qwen3.6-27b`, and another program had it loaded), `qwen3.8-27b-coder` (a coding model is not a sensible planner) and the small 4B to 12B variants.

### Warm-up at start

The bridge loads the planner model once when it starts, in the background. The request is one token with the same model, `num_ctx`, `num_gpu` and `keep_alive` as a real plan, so Ollama does not reload it later. The first real plan waits until the warm-up has finished or failed. A menu turn never waits for it and never cuts it off. It is not counted as a menu call and has no grace timer.

If Ollama says the default model is missing (404), the warm-up switches the planner to `PZ_MODEL` for good, the same fallback a real plan uses. Any other failure is logged and plans run as before. The log line is `planner model ready` or `planner warm-up failed`.

`/mind` shows the model in use, so it names `PZ_MODEL` after a fallback.

### JSON in replies

`extractJSON` in `bridge/decide.mjs` used to cut from the first `{` to the last `}`. Any text after the object that held a brace, or a second object, made the cut invalid JSON, and the reply was refused. It now reads the first balanced object, ignores braces inside strings, and tries the next `{` when one does not parse. It skips a think block, a code fence, text before, and text or a comment after. It still throws on anything that is not valid JSON, such as single quotes, trailing commas or a cut-off object.

### The rule

Pick the largest installed model that meets all of these:

1. A menu turn right after a plan, and during one, stays under about 1 second.
2. A plan takes under about 60 seconds when warm.
3. Every plan parses and names a real home.

Thinking is off for the pick. On the 35B it added about 110 seconds per plan on the CPU and the plans were no better. A reply that only has to fill a small schema does not need much thought.

Of the rows above, the 35B on the CPU with thinking off is the largest that passes. The 27B passes too, at 34 s warm. The 26B is a close second. A thinking plan on any of the big models fails rule 2.

### What the plans look like

`gemma4:12b` (thinking, 5 s) against `qwen3.6-35b` (CPU, no thinking, 6 s). Same fixture, one run each.

| fixture | gemma4:12b | qwen3.6-35b |
|---|---|---|
| night outside | Secure house 4060 and rest for the night. Move to house 4060 and enter; eat food, drink water; rest and treat wounds. | Drink water, eat food, and reach the nearby house before night fully sets in. Drink 0.5L water and eat a meal; walk north to house 4060 (9 tiles); enter and sleep in the bed. |
| bleeding | Treat hand wounds, hydrate, and find a can opener. Bandage the left hand; fill bottles at the tap; search the rest of 4021. | Treat hand, fill water, then search nearby house 4022. Treat the left hand bleed with a bandage; fill bottles at the kitchen tap; walk to 4022 and search. |
| searched house | Eat food and scavenge building 4022 for a can opener. Eat; travel to and search 4022; return to 4021. | Open the sealed can and eat lunch before heading to the nearby shop. Open the can with the knife; eat; travel to building 4022 (14 tiles east). |

Both are sound. The 35B uses more of the numbers in the situation (litres of water, tiles to walk). It also invents small things now and then ("equip bag", "ammo"). Over 12 plans it never missed the JSON, where the 12B gave one reply the parser could not read in 12. Four fixtures cannot show that it plays better. Read a few plans from a live run before believing it is smarter.

### Choice

Default: `qwen3.6-35b_abliterated_pc:latest`, `PZ_PLANNER_GPU_LAYERS=0`, thinking off. These are set in `bridge/llm.mjs` and apply while `PZ_PLANNER_MODEL` is unset. Menu turns stay at about 0.4 s next to it, and a warm plan takes about 6 s, the same as the 12B.

To go back to the old behaviour: `$env:PZ_PLANNER_MODEL = "gemma4:12b"`.

### Run it yourself

```
node bridge/tools/planner-bench.mjs qwen3.6-35b_abliterated_pc:latest --gpu 0 --runs 3
node bridge/tools/planner-bench.mjs gemma4:12b --during --out results.jsonl
```

`PZ_PLANNER_THINK=off` in the shell turns thinking off for the run. A big model can take minutes per plan with thinking on, so run one fixture at a time (`--fixtures bleeding --runs 1`). Without `--gpu` the bench lets Ollama place the model. It needs Ollama running and loads models, so it is not part of `npm test`.
