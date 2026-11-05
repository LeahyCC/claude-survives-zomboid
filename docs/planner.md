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
| `PZ_PLANNER_MODEL` | `PZ_MODEL` | The model for plans and death reviews. |
| `PZ_PLANNER_THINK` | `auto` | `auto` asks Ollama to think and falls back once for a model that cannot. `off` never thinks. |
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

- **Plan**: the goal, the steps, the home, why it was asked, how long ago in game hours, and the planner's model. It says when the planner is thinking, what it is waiting to plan, and the last error.
- **Lessons**: each with its tag, runs active, and average hours with and without. A flagged one has an amber edge and a warning. Each has a delete button.
- **Playbook rules used**: also lists `lesson (tag): text` for the lessons in the last menu prompt.

Delete needs a custom `x-mind` header, so a page on another site cannot delete through your browser.

## How to wipe lessons

- One lesson: the delete button on `/mind`.
- All of them: stop the bridge and delete `bridge/lessons.json`. This also forgets the run record.
- The plan: delete `bridge/pz-state.json`, or let the next event replace it.

Deleting `pz-state.json` does not touch lessons. That is on purpose.

## Check it

`npm test` covers the events, plan parsing, lesson parsing, dedupe, the cap, trigger matching, the run flag, the planner's wait for a free model, and a menu turn cutting a plan short. The model is mocked. Nothing tests a real model's plans or lessons yet. Read the first few from a live run before trusting them.

Every call to Ollama, menu turns and the planner alike, uses one context size, `PZ_NUM_CTX` (default 8192). Ollama reloads the model whenever `num_ctx` changes between requests, so two sizes would cost a reload at each switch.
