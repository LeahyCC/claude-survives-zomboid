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
   ... an idle one in her house past 2 tiles does not hold: the reflex leaves those alone
   ... unless handed back (60 s of it, or reflex.stuck): ask with the escape menu, below
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
otherwise write SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET[|POSTURE]
```

A percept with no `v` field comes from an old mod. It gets the old prompt and the old rules in `bridge/decide.mjs`.

## Modules

| File | What it does | Kind |
|---|---|---|
| `brain.mjs` | One turn without I/O: `planTurn`, `resolveChoice`, `orderLine`, the user message. | service |
| `senses.mjs` | Reads a v2 percept: the hold rule, need flags, night, inside, busy. | service |
| `options.mjs` | The menu: `buildOptions(percept, memory)`, and the short escape menu for a handed-back turn, `escapeOptions`. | service |
| `chase.mjs` | How long the reflex has had a chase to itself, and when the brain gets a turn anyway. See "When the hold ends". | service |
| `policy.mjs` | Needs that cannot wait: `decidePolicy`. | service |
| `housejob.mjs` | The house job the bridge holds across turns: its stages, what it takes off the menu, the next house. See "House job". | service |
| `playbook.mjs` | Pro rules with a condition each: `selectRules`. | service |
| `memory.mjs` | Map memory by building id, saved as `map` in `pz-state.json`. | service |
| `crowd.mjs` | The crowd map: zombies seen by building and by area, fading over 12 game hours. See "Crowd map". | service |
| `reactions.mjs` | How the last orders went: the outcome lines, the blocked list, loop detection, the rows of the strip. See "Reactions". | service |
| `digest.mjs` | The situation in plain lines. | formatter |
| `words.mjs` `geom.mjs` | Words for numbers, compass, distances. | pure helpers |
| `planner.mjs` | The slow day plan: events, parsing, the background runner. See `docs/planner.md`. | service |
| `lessons.mjs` | Lessons from past deaths and their triggers. See `docs/planner.md`. | service |
| `decisions.mjs` | The decision log: decision, outcome and after lines, and the join between them. It also keeps the last 12 orders with their results in memory (`history()`). See `docs/eval.md`. | service |
| `death.mjs` | Why she died: the cause and its facts, from the mod's death record. See `docs/eval.md`. | service |
| `nudges.mjs` | Whether a nudge may go ahead, the frozen record, and the example lines for the prompt. | service |
| `commentator.mjs` | The inner voice: spots moments, keeps a summary of the run, rate limits, asks the meme model for a first person line. Commentary only. See "Inner voice". | service |
| `critic.mjs` | The second opinion: builds the request for Jev, checks the reply, writes the `critic` log line, keeps the pause and the one-call limit. Logging only. See "Critic". | service |
| `jsonl.mjs` | Append-only log files with rotation, and a reader that skips bad lines. | I/O |
| `reflexlog.mjs` | Follows the mod's reflex log and copies each stance and outcome into the decision log. See `docs/combat.md`. | I/O |
| `llm.mjs` | Ollama calls, the fixed system message, the per-turn schema, the planner call. | I/O |
| `pz-bridge.mjs` | Reads the percept, runs the loop, writes the order, serves `/mind`. | I/O |
| `decide.mjs` | The v1 brain for old mods, and `intentLine`. | v1 |

## When an order is held

The reflex leaves an idle zombie alone unless it is within about 2 tiles (`docs/combat.md`). So the brain only goes quiet when the reflex will act:

- a zombie in `zList` with `chase` true and `d` 10 or less, or `zChasing > 0` with `zClose > 0` when `zList` is missing
- any zombie 3 tiles or closer

A thought that comes back after one of these starts is dropped. With idle zombies further out, orders go on. Walks keep 5 tiles clear of every standing zombie within 20 (idle ones, and chasers the reflex does not own yet), and end at least 6 tiles from one. A house whose door is past a zombie is left off the menu.

## When the hold ends

The hold is a loan. In the 2026-11-05 soak one zombie held the brain off for 33 minutes: the reflex fled every minute, never got away, and no order was ever written. `chase.mjs` keeps a clock of how long the hold has been on (it ends when the hold has been off for 15 seconds) and says when the brain gets a turn anyway:

- the percept's `reflex.stuck` is true: an escape loop hit its limit and the reflex has nothing of its own left (`docs/combat.md`, "Stuck in a chase"), or
- the hold has been on for 60 seconds with at most two standing zombies inside 10, nothing has hurt her in the last minute (`reflex.hits60` is 0), and the reflex is not in a fresh FIGHT or SHOVE.

A second hand-back waits 45 seconds after the last. Asleep and a pending order still come first.

A handed-back turn skips the policy, the usual menu and the "keep" rule, and the prompt says the reflex has had the chase for N seconds and running is not shaking it. The menu is `escapeOptions` in `options.mjs`, at most 5:

| id | verb | offered when | posture |
|---|---|---|---|
| `secure` | SECURE | inside, doors not shut this visit | |
| `b1`, `b2` | ENTER | the two nearest houses or buildings whose door she can reach clear of the zombies | `avoid` |
| `away` | GOTO | a walk 15 tiles out of sight of the zombie, clear of the others | `avoid` |
| `fight` | WAIT | a weapon, hp 50+, endurance 0.3+, not heavy, not panicking, not bleeding, one or two chasing | `clear` |
| `wait` | WAIT | only when nothing else is offered | |

A pick that is the job already running is sent again (`resolveChoice(..., force)`), because that job is what the flee keeps cancelling. The order line carries the posture as its ninth field, which sets `LocalSurvivor.posture` for the reflex. On the mod side a new GOTO, ENTER, SECURE or MOVE order with a chaser in range makes the reflex stand aside for 20 seconds (`Reflex.HANDBACK_TICKS`), or the flee would cancel the walk at once. It never starts for a pack or a hit, and ends if one comes (`docs/combat.md`).

The decision line gets `handback: { why, ms }`, so `node bridge/tools/review.mjs` prints "Stuck in a chase": loop limits by what she did next, and the turns handed back with how those orders went. The bridge also prints `Reflex hands the turn back: ...`.

## House job

The menu asks afresh every turn, so nothing held "finish this house". 63 of 168 ENTER orders came from inside another house, only 14 of 79 entries got a SEARCH, and she spent 3% of her time searching (`docs/pro-rules.md`). The idea of stages comes from the Bandits mod's programs, not its code. The bridge now holds one job in map memory (`map.job`, `bridge/housejob.mjs`):

```
IN      ENTER, until she stands in the house
SHUT    SECURE: doors, windows, curtains, lights
LOOK    WAIT, at least 2 game minutes, reading who is in the house
CLEAR   CLEAR, when one idle zombie is in the house and she is fit to kill it, then LOOK again
SEARCH  SEARCH, until no room is left
LEAVE   fill and rest if on the menu, walk to the door, then the next house
```

**How one opens.** An ENTER order opens it at IN. Coming into a house any other way (the spawn house, a flee through a door) opens it at SHUT. A house already searched, or with `roomsLeft` 0, gets no job.

**What it does to the menu.** While a job is open and nothing threatens her:

| stage | taken off the menu |
|---|---|
| IN | other houses, `explore`, `home`. Not `away`, since she is outside and may need it. If her house is off the menu (a zombie by the door), nothing is taken off |
| SHUT, LOOK, CLEAR, SEARCH | every ENTER and every GOTO. `clear` is added at CLEAR |
| LEAVE | this house, `home`, `away`. `leave` is added. `explore` is offered inside too, when no next house fits |

**Who sends the orders.** The policy rule `house-job` sends the stage's order, so a house is mostly not a model turn. It comes after the urgent rules, so a wound, thirst, hunger, a better weapon, night and sleep each cut in and the job picks up after. It sends nothing while a job is running. Between stages it does the small things first, while it is quiet: `bandage`, `drink`, `eat`, `wearbag`. If she is too heavy to search, it leaves the turn to `overloaded`. When SEARCH cannot be sent, the model picks from what is left, and the prompt says `HOUSE JOB: searching this house, 4 rooms left. Finish it before going anywhere else.`

**What ends or pauses it.**

| what | then |
|---|---|
| chased within 15 tiles, 3 standing that can reach her, bleeding, night outside | paused: the menu is the full one and the rule stays quiet. It picks up when that passes. The reflex owns the danger either way |
| 3 standing in the house | as above, and the house is over: LEAVE when it passes |
| out of the house with a threat, or after one | over (`threat`). She does not walk back into it |
| out of the house with no threat | back to IN, then to the stage she left, not to SHUT. Twice at most (`MAX_REENTRIES`), then over (`walked out`). A SEARCH or SECURE still running is left alone, since it is on its way back in |
| a zombie in the house at LOOK that CLEAR will not take on | wait up to 10 game minutes for it to go or the reflex to deal with it, then LEAVE |
| CLEAR done | LOOK (`cleared`), then SEARCH |
| CLEAR failed | LEAVE (`clear failed: another floor`, and so on) |
| CLEAR not sent yet, and the gate shuts or 20 game minutes pass | LEAVE (`clear called off: hurt`, `clear called off: time`). With the zombie gone, LOOK (`zombie gone`) |
| SEARCH cannot run for 10 game minutes (a zombie close, too heavy, a retry timer) | LEAVE (`blocked`) |
| too heavy with a base elsewhere in reach | LEAVE (`full`), and the load goes home (see "Base and stash"). The house stays unsearched, is marked `fullAt`, and is first on the menu after |
| SEARCH failed `full`, or too heavy with DROP off the menu and no stash here | LEAVE (`full`), marked the same way |
| too heavy, in her base | stays at SEARCH: the stash goes first, then the search goes on |
| ENTER failed | over (`no way in`) |
| time limit | LEAVE (`time`) |
| LEAVE at dusk (17:00) or night | over, and she stays. The usual menu leads with home |
| LEAVE after 15 game minutes | over (`time`) |

**CLEAR.** The 2026-11-06 soak had 32 of 43 houses with no room searched, and 7 of them went from LOOK to LEAVE with `zombie inside`. A good player does not walk away from one shambler. At LOOK, and at SEARCH with nothing running (a zombie in the house holds SEARCH, `reaches` in `senses.mjs`), the job goes to CLEAR when `clearBlock` finds nothing against it:

| she needs | or the gate says |
|---|---|
| a zombie in the house (a downed one or a crawler counts, it holds SEARCH too) | `nobody inside` |
| nothing after her, in the house or out of it | `chased` |
| a melee weapon in hand | `no melee weapon` |
| reach of 1 or more | `weapon too short` |
| 1 in the house, or 2 with a weapon scoring 30 or more (`STRONG_WEAPON`, the reflex's line) | `too many inside` |
| hp 70 or more | `hurt` |
| not bleeding | `bleeding` |
| endurance 0.3 or more, panic moodle under 3, heavy moodle under 2, and with 2 in the house tired moodle under 3 | `not fit to fight` |

The reach line and the last line are the reflex's own. With a blade under reach 1 it stands and waits for the zombie to come, and an idle one never does, so a kitchen knife does not clear. Past its fight gates it would walk her up and back her off again. A failed CLEAR stays off for the usual retry time, so she does not go straight back to it. The order comes ahead of `bandage`, `drink`, `eat` and `wearbag`. What the order does is in `docs/skills.md`, CLEAR.

**The time limit** is 30 game minutes a room, at least 60, at most 240 (BG42.20 says "two hours of looting, not twelve"; the card started at 15 a room, which is about 37 real seconds, too short for a full kitchen). Sleep and gaps in the clock over half an hour do not count. It is a number from the card, not a measurement: at the default day length 30 game minutes is about 75 real seconds. Check it against the review, because a limit that cuts searches short reads as `time` under "How they ended".

**LEAVE.** A load run comes first, if there is one (`haul`, or `stash` when she is home). Then she walks to the door she came in by, or if she came by a window, the door the map knows (`b.door`). A door whose walk passes a zombie is no way out, and she goes straight on (`leaveExit`). The next house is the nearest on the menu that is not searched, not given up on in the last 12 game hours, and not crowded, a house before a shop (`nextHouse`). Crowded means the old `b.zombies` is 3 or more, or the crowd map holds 3 or more for that house, or 5 or more for its area (see "Crowd map"). With none she walks out to explore.

**The log.** Each change is a `house` line in `decisions.jsonl` (`docs/eval.md`), and the bridge prints it. `node bridge/tools/review.mjs` has a "House jobs" section: started, finished, rooms searched per house, re-entries, houses cleared of a zombie, how they ended.

A `searched` flag now needs SEARCH to have got as far as it could. A SEARCH that finished rooms and left some stays `partly`, and the next SEARCH goes on. One that got no further than the last marks the house searched, or she would loop on a room that is not loaded.

## Base and stash

Soak 3 (`bridge/soak-2026-11-06-00-09.txt`): 9 of the 32 houses with nothing searched went SEARCH to LEAVE `full`, and DROP failed 5 of 13 times `nothing to drop`, because what she carries is all worth keeping. Colin, 2026-11-05: she should "remember ... which is the best base for putting gear, but should be dynamic if finding a new one".

```
too full to search -- base known, not chased --> haul: ENTER the base, or GOTO its door until it is listed
       |                                                  |
       |                                                  v
       |                                         inside the base --> STASH --> back to the house left full
       '-- no base, or no way there -----------> DROP (its own gates, as before)
```

**Which building.** `map.base` (`pickBase` in `memory.mjs`) is looked at on every percept:

| case | base |
|---|---|
| none yet | the planner's home, else the best `safehouseScore` she has been in, 2 or more (a house counts, a shop does not) |
| the planner's home differs, nothing stashed yet | the home, unless the base scores 2 or more above it |
| anything else, once gear is there | stays, until a building scores 2 higher (`BASE_MOVE`). A new plan is no reason to scatter her gear |
| the base is over 120 tiles off | anything in reach beats it. If nothing does, it stays, and the walk is not offered |

`b.zombies` is in the score, so zombies seen at the base can move it. The digest has one line for it: `Base: house 14 tiles N, 6 things stashed there, 2 more at an old base.`, and the planner sees `your base` on its list of known buildings. When the base moves, the old one's count stays in `map.stashes`. It goes when a SEARCH there finishes.

**Too full** is `heavy`, or `map.haul`: a house job went to LEAVE `full`, which a meal since then does not undo. `map.haul` is cleared by a STASH, a DROP or a new character.

**On the menu.**

| what | offered when |
|---|---|
| `stash` | too full, inside the base, not chased, no zombie that can reach her soon, hp 30 or more, STASH not failed lately |
| `haul` | too full, the base is elsewhere, not chased, hp 30 or more, a clear way there, not crowded, not night indoors |
| `drop` | as before, but not with `stash` or `haul` on the menu, and not waiting indoors for morning with a base to go to |
| `oldbase` | an old base with a stash, by day, not too full, a clear way there, low on the menu and the model's call |

**Who sends it.** `jobPick` in `housejob.mjs`, so it logs as the `house-job` rule, ahead of `overloaded`. It has no rule of its own in `policy.mjs` only because another card held that file when this was written. Move it when that is merged. Being chased takes both `haul` and `stash` off. DROP's own gate also shuts for any chaser, so while she is chased nothing sheds the load. The reflex has the chase.

**Coming back.** A house left full is not "given up on": it gets `fullAt`, not `leftAt`, so the 12 hour wait does not apply. It ranks ahead of houses she has never seen, says `you left it full, more to take`, and the mark goes when she walks back in. A stash lifts any `full` failure on SEARCH, or she could not search it on arrival.

**Not done.** Nothing takes gear back out of the stash at her current base, so food put away there is not eaten. Only an old base gives things back, through SEARCH.

## Options

Each option is `{id, verb, a, b, target, label, key}`. The model reads `id: label`. `key` names it in map memory. The menu is sorted by need and cut to 8, with `wait` (or `keep`) always last.

| id | verb | offered when |
|---|---|---|
| `bandage` | BANDAGE | a wound is bleeding, deep, bitten, has glass, or is an unbandaged cut or scratch; and `inv.bandages` is above 0 or `inv.canRip` is true (the job rips cloth). A percept with no `canRip` gets the old test: she is bleeding. A "no bandage" failure keeps it off for 3 minutes, but a bandage in the bag lifts that at once |
| `drink` | DRINK | thirst 0.25 or more (or the moodle); water in a bottle, or a tap in this building |
| `eat` | EAT | hunger 0.25 or more (or the moodle); food ready, or a can and a can opener |
| `equip` | EQUIP | nothing in hand and a melee weapon carried; or a carried weapon whose `score` is 1.25 times the `weaponScore` of the one in hand or more (the mod's own swap line). With no scores in the percept, only the empty hands count. Never with a gun in hand (`heldGun`), and never when the weapon in hand is the player's own pick (`weaponByHand`) |
| `stash` | STASH | too full, inside her base. See "Base and stash" |
| `haul` | ENTER or GOTO | too full, with a base elsewhere to take it to. See "Base and stash" |
| `drop` | DROP | heavy (moodle, or weight at the search line: 60% of the maximum with no bag, 85% with one), no chaser, no zombie that can reach her soon (see below), hp 30 or more. Not with `stash` or `haul` on the menu |
| `oldbase` | ENTER or GOTO | an old base with a stash in it. See "Base and stash" |
| `secure` | SECURE | inside, not secured since entering. Night sorts it near the top |
| `sleep` | SLEEP | inside, fatigue 0.5 or more, no chaser, none visible, none within 15, no panic, pain under 2 (unless fatigue over 0.85) |
| `search` | SEARCH | inside, not searched (map memory), `inBldg.roomsLeft` not 0, not overloaded, no zombie that can reach her soon (see below). The label counts the rooms left: "2 rooms left, partly searched". While `weaponPoor` it ends with ", no real weapon yet: kitchen and garage first". Also offered at an old base with a stash in it, searched or not, and it says so. The order carries her base as its target, so the search leaves her own stash alone |
| `wearbag` | WEARBAG | no bag worn and a bag in the item names |
| `b1` `b2` `b3` | ENTER | buildings in the percept, not this one, not blocked, path clear. Unsearched first, then nearest. A safe house goes first at night, when tired or panicked. The plan's home building goes before that when she needs shelter and from 17:00. With no real weapon, houses come before shops and an unsearched house says "no real weapon yet, look here". After an A, B, A, B run in her last 4 ENTERs (`bouncing`) both buildings stay off until she enters a third, unless she is chased or one is the plan's home and she needs shelter |
| `home` | GOTO | the plan's home is a building the map knows, with a door on record, but the percept does not list it, within 120 tiles, path clear. It goes to that door, and ENTER takes over once the building is listed. It leads the menu from 17:00 or when she needs shelter, and sits low by day. At night outside it is left off when a listed house is nearer |
| `fill` | FILL | inside, a tap here, an empty bottle carried |
| `rest` | REST | endurance under 0.6, no chaser |
| `away` | GOTO | an idle zombie within 12, or a chaser: 15 tiles in the clearest direction away |
| `explore` | GOTO | no new building on the menu, and outside or inside a searched building: 25 tiles in a clear direction. From inside it sits above walking into a house she has already searched. At the LEAVE stage of a house job it is on the menu when no next house fits, searched or not |
| `leave` | GOTO | the LEAVE stage of a house job: to the door she came in by or the nearest door the map knows, if the walk is clear |
| `clear` | CLEAR | the CLEAR stage of a house job, unless a CLEAR just failed |
| `wait` | WAIT | nothing is running |
| `keep` | none | a skill or needs job is running. Picking it sends nothing |

An open house job takes options off this table (see "House job"). A place given up on in the last 12 game hours ranks with the searched ones. A building with 3 or more zombies in the crowd map is not offered at all. One in an area with 5 or more, or with 3 or more in the old `b.zombies`, comes after the rest of its kind.

While a skill or needs job runs, any new order cancels it. So the menu then has only `keep` and what is worth stopping for: `bandage`, `drink`, `eat`, `away`, and `secure` when a zombie is chasing. A walk (`GOTO`, `ENTER`) can still switch to another house. If `keep` is the only option, the model is not asked.

**A zombie that can reach her soon.** `search` and `drop` wait only for these (`reaches` in `bridge/senses.mjs`). A zombie in `zList` counts when it is chasing her within 15 tiles (`REACH_CHASE_R`), or it is in her building (`inside`), or it is under 8 tiles away with no wall or closed door between (`wall` false). A zombie outside behind a wall that is not chasing does not block. Before this the test was 8 tiles and nothing else, and she sat in houses with rooms left for 41 minutes (`docs/pro-rules.md`). The weight gates are unchanged. An older mod sends no `wall` or `inside`, and then only the 8 tiles count, as before.

When `search` is off the menu with her inside and rooms left, `options.mjs` prints one line to the bridge console: `[hh:mm:ss] menu: no SEARCH, too heavy, zombie close, no wall 5 tiles (3 rooms left)`. The reasons are `already searched`, `too heavy`, `zombie chasing|in the building|close, no wall N tiles` and `retry timer after a fail`, all that apply. It prints once per menu built, so a review can count them. It is not in the page's log yet: the bridge log is not reachable from the menu code.

Building labels come from map memory: `not visited`, `visited, not searched`, `partly searched`, `searched`, `safe house` or `has water`, `has a bed`, and from the crowd map `N zombies seen here lately` (this building), `a gunshot in this area lately` (a shot went off there, see "Crowd map"), or `N zombies seen in this area lately` (only when the area holds 5 or more). When the map says nothing, the old `N zombies seen` shows for a house where 2 or more were counted from inside.

"No real weapon" means nothing in hand or in the bag scores 20 or more. A kitchen knife scores 9 and a hammer 19, a crowbar 30 (`docs/combat.md`). An older percept with no scores counts only empty hands and an empty bag. A gun does not count: only a melee weapon does (`withoutGun` in `options.mjs`). The playbook's `no-weapon` and `weak-weapon` rules read `senses.mjs`, which still takes a gun in hand as armed. That only matters for the second or so before the reflex holsters it.

A gun is not a melee weapon. The percept names the one in her hand in `heldGun` and leaves `weapon` at `none`, and `guns` lists what she carries with its ammo. The bridge reads `heldGun` and `weaponByHand` through `heldGun(p)` and `weaponByHand(p)` in `senses.mjs`, so the digest and the inner voice can name what is in her hand. The digest says `Holding a Pistol (a gun, 8 loaded and 12 spare rounds).` and `Holding a Crowbar (100%), your own pick.`. The inner voice reads the hand the same way (`handName` in `commentator.mjs`), so picking up a pistol is a "better weapon" moment and a held gun is never "no weapon in hand". For the weapon rules a gun is not armed (above), and it is rarely in her hand: the reflex holsters it unless the fire rule holds (`docs/combat.md`, "Guns").

`res.target` says what the running job works on, so a restart of the bridge mid-job still knows. If the bridge has no record of the order, `ENTER`, `SEARCH` and `SECURE` use the building id in it as their option key, and a `GOTO` is matched by its `x,y` against this turn's walks. Otherwise the verb alone stands for the job, as before.

A failed order stays off the menu for a while, so `stuck` is not resent straight away. Most fails wait 45 seconds. `stuck` 60, `unreachable` 90, `locked` 20 minutes, `too soon` 5 minutes. A search that fails `nothing left` marks the building searched for good.

## Policy

Checked in this order. The first rule whose option is on the menu is sent, and the model is not called.

| Rule | When | Sends |
|---|---|---|
| `bleeding` | `bleeding > 0` and no standing zombie within 3 tiles (the reflex owns that fight). First in the list, so it beats DROP, SECURE, GOTO and ENTER, and it can interrupt a running walk. Steps aside when `bandage` is not on the menu (no bandage, nothing to rip, not even a shirt she wears) | `bandage` |
| `thirst` | thirst 0.6 or more, or the moodle at 2 | `drink` |
| `hunger` | hunger 0.6 or more, or the moodle at 2, and `inv.foodReady` above 0. A can that needs opening is the model's call | `eat` |
| `equip` | a carried weapon is clearly better than the one in hand, or the hands are empty. Not with a gun in hand: the reflex holsters it and takes the melee weapon out by itself. Not when the weapon in hand is the player's own pick (`weaponByHand`): the mod would turn the order down, and the player's choice stands | `equip` |
| `night-outside` | 21:00 to 06:00 and outside | the nearest house on the menu (`ENTER`) |
| `night-secure` | night, inside, not secured since entering | `secure` |
| `sleep` | fatigue 0.8 or tired moodle 3; or night, tired, inside and secured | `sleep` |
| `house-job` | a house job is open, nothing threatens her and no job is running (see "House job"). Also, with no job open, a load run: `stash` or `haul` is on the menu (see "Base and stash") | the order of the stage, or the load run |
| `find-weapon` | bare hands (weapon `none`, no real weapon in the `weapons` list; a gun does not count), inside, no chaser, and `search` is on the menu (so the building is not done, she is not heavy and no zombie can reach her soon) | `search` |
| `overloaded` | heavy, no chaser, hp 30 or more (and `drop` is on the menu, so no zombie can reach her soon) | `drop` |

`equip` is kept off the menu for 45 seconds after it is sent. EQUIP never reports done while the weapon is still being raised, so without that the rule would send it again on every look. A `done` result lifts the block at once, and a failed `drop` or `equip` stays off longer (`not heavy` 3 minutes, `nothing to drop` and `equip: no weapon` 10).

If a voice line is waiting, the model is still called, with a menu of just the policy's option, so it can answer in its thought.

## Not asking while a job runs

`res.status` is `running` for a skill or needs verb (`GOTO ENTER SEARCH LOOT DROP DRINK FILL EAT SLEEP BANDAGE WEARBAG SECURE REST CLEAR STASH`). MOVE and the old one-shot verbs stay `running` forever, so they do not count. While one runs, the brain sends nothing and asks nothing unless:

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
| `overloaded` | heavy moodle, or weight at the search line (60% of max with no bag, 85% with one) |
| `one-at-a-time` | an idle zombie within 20, or more than one in sight |
| `no-weapon` | none in hand and none carried, and no gun in hand |
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
3. The last order failed (within 5 minutes), nothing newer was sent, and the same job is on the menu again: `Your last order, ENTER house N, failed (zombies at the door). It is on the menu again. Try something else first.` A failed walk into a building with `zombie` stays off the menu for 5 minutes (see "Crowd map"); other failed walks keep their own timers.

The line only says what happened. It does not tell her to fight: the model never swings, the reflex does.

### The Reactions strip on /mind

The last 8 orders as rows: time, choice, result, HP change (the order's start to its end; hover for HP lost on the way), and the choice that came next. A failed row is red, a running one teal, a cut-off one grey. The page refreshes every two seconds but rebuilds the strip only when a row changed, so a selection or a hover on it stays put. `/api/state` carries the rows as `reactions`. With the critic on, each row also has a Critic column (see "Critic").

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

Per building id: `firstSeen`, `lastSeen`, `visited`, `lastVisit`, `enteredAt` (game hours), `searched`, `partly`, `took` (from the search's `why`), `water`, `bed`, `res`, `shop`, `door`, `zombies` (within 15 at the last look inside, never faded), `securedAt`, `leftAt` (when a house job ended with rooms in it), `fullAt` (when it ended because she was too full, so she comes back), and a rough position. `map.job` is the open house job. A saved one that does not read as a job is dropped. `map.crowd` is the crowd map and `map.strikes` the ENTER failure counts (see "Crowd map"). `map.base`, `map.stashes` and `map.haul` are the base, what is stashed by building (`{ n, at }`), and a load run owed (see "Base and stash").

`door` is the exterior door `{x, y}` the percept listed, kept after the building drops out of the 6 nearest. It is what the `home` walk goes to. A door that is not a pair of numbers is ignored. `searched` is also set when the building the survivor stands in reports `roomsLeft` 0.

Safe house score: residential +2, water +2, bed +2, searched +1, shop -1, minus one per zombie seen (up to 4). 5 or more is a safe house.

It also keeps the last 12 orders sent (seq, verb, key, building, rooms left when sent), the fails with their time, and the sleep guess. Places stay known after a death, and the base and its stash with them, since the gear is still in the world. Orders, fails, sleep, the load run and the house job are cleared. The crowd map is kept, and cleared only for a new character who spawns more than 150 tiles from where the last one was.

## Crowd map

`bridge/crowd.mjs`, saved as `map.crowd`. The first soak showed 35 ENTER orders failing with `zombie`, 45 sent again after a failure and one life walking into 11 zombies (`docs/pro-rules.md`, card 5). `b.zombies` only counted while she stood inside, so a house she had not entered said nothing.

```
every percept     zList (6 nearest within 25 tiles)
                  |-- in her building ----------> that building
                  |-- else within 10 tiles of a known wall point or door -> that building
                  '-- every one -----------------> its 20 by 20 area
entry             { n, at }   n zombies seen at crowd clock `at`
fade              n x (1 - age / 12 game hours), gone at 12
```

- **A floor, not a head count.** The list holds 6, so one look names 6 at most, and an area never reads over 6. A full list only raises an entry (`max` of the new count and the faded old one). A list of fewer than 6 is every zombie within 25 tiles, so then a house within 15 tiles with none in it is cleared at once, and so is an area whose four corners are all within 25.
- **The clock** adds up the rise in `hoursAlive`, so it keeps going when a new character starts. A new character who spawns within 150 tiles of the last one keeps the map. One further off starts clean. Time between lives is not counted.
- **Crowded** is 3 or more for a building and 5 or more for an area, after the fade. A 3 reads as crowded for about 2 hours, a 6 for about 7. That is a guide number, not a measure: take the fade from the soak.
- **On the menu.** A crowded building is not offered as ENTER or as the `home` walk. A crowded area ranks after the rest of its kind (the sort is home, searched or not, crowd, house first, distance). The label gives the count. The escape menu (`escapeOptions`) does not use the map: when something is after her, any door is a door.
- **Next house.** `nextHouse` skips a crowded building and a crowded area, and then she explores.
- **A gunshot.** The reflex log's `shot` line (`docs/combat.md`, "Guns") marks its 20 by 20 area through `markShot`. It counts for 10, so that area is crowded for about 6.6 game hours. It is kept in `crowd.shots`, apart from `areas`, because a complete list sets an area to what she can see and would wipe the mark on the next percept. The label says `a gunshot in this area lately`, since nobody counted those zombies. Only that one cell is marked, though a pistol carries 100 tiles. The eval's memory slice does not carry `shots`.
- **A failed ENTER with `zombie`** is off the menu for 5 minutes, then 10, 20 and at most 30, each time it fails again within an hour of the last (`map.strikes`, wall clock). A strike goes after an hour of quiet or when she gets in. Other reasons keep their timers (`locked` 20 minutes, a `zombie` on any other order 30 seconds).
- **Not done:** the guides' base scan (`BanditPlayerBase.Regenerate` reads 10 tiles at a time) is not copied: a percept already gives the 25 tile list for free. Zombies behind a wall in a house she has never been near are not seen at all until the list reaches them.

## /mind

`http://localhost:8799/mind` shows the options offered (the chosen one marked), the choice, who decided (policy and its rule, the model, waiting on a skill, the reflex, asleep), the model time, the playbook rules used, the map memory size, and the Reactions strip (see "Reactions"). `PZ_LUA_DIR` and `PZ_STATE_FILE` point the bridge at other files, for a page check without the game.

The Nudge panel on the same page lets you pick the option you would have chosen. See "Nudges" in `docs/eval.md`. A model thought that was still running when you pressed "Do it now" is dropped when it finishes, so it cannot overwrite your order.

## Inner voice

A second local model, `pepe-8b_abliterated_pc:latest`, is the voice in her head. It speaks as her ("I", "me"), in its own style, one or two short sentences, and it knows what has happened so far this run. It is commentary only. It never decides anything, never writes an order, and nothing it says goes into the brain's prompt, the planner's prompt or the order line. (The code and logs still call it pepe.)

Each line is a pair. The brain decides an action with its own short thought, and the voice answers right after with how she feels and how she reads the situation:

```
ENTER house W  "I need to hide out before dark"
  -> I'm feeling tense, the situation is that the light is going, and this better have a door that locks.
```

```
each order sent (policy or model) -----------> pending, only the latest kept
percept, order history, plan --> moments ----> pending
quiet for 60 to 90 s ------------------------> an idle thought
pending --> one line at most every 30 s, only when nothing else needs Ollama
        --> pepe.log + Inner voice panel + Lua/local_voice.txt
```

Where the lines go:

- `bridge/pepe.log`: one JSON line each, with `action`, `thought` and `line`.
- The Inner voice panel on /mind: the last 10, newest first, with the brain's half above the voice's half. It is filled from the log when the bridge starts, so it survives a refresh and a restart.
- `Zomboid/Lua/local_voice.txt`: the latest line only, one line, overwritten, in the same folder as `local_intent.txt`. The format is `ACTION "thought" | the voice's line`, or just the line for an idle thought. The mod reads it (see "Inner voice on screen" below).

What triggers a line:

- **An order.** Each order the brain sends, from the policy or the model. When orders come faster than the 30 s gap, the line pairs with the latest one and the older ones are dropped.
- **A moment.** A kill, losing 8 or more HP at once, starting to bleed, HP falling to 25 or below, a clearly better weapon in hand (hands empty to anything, or a score 1.25 times higher), walking into a building, locking one up, a failed order, a flee and re-enter loop, the planner's new plan, and death. When an order is waiting, the line answers the order and up to two moments ride along. A moment alone gets its own line, with no action beside it. A moment older than 45 seconds is dropped.
- **Death** is always spoken, never rate limited, and waits for a free model.
- **An idle thought** about every 60 to 90 seconds when nothing has happened (waiting out the night, walking, searching). Any order, moment or line pushes the next one back. It only runs while the game is sending percepts.

What the model is sent each time, kept small because it runs on a CPU:

- A running summary of this character, at most 6 lines of 150 characters: game hours alive, kills and where she is now, the weapon she started with and the one in hand, buildings entered and searched, what she found, big hits, bleeding and close calls, and the planner's goal. It comes from the percept, the stats run, the order history and the plan, not from the model.
- The voice's own last 4 lines, so the thought carries on.
- The order or the moment, and her state line.

The summary and the 4 lines are cleared when the stats run id changes (a new character), or when the hours or kills counter goes back. The moment watcher starts over too, and the old character's finds are not counted again for the new one. A death line said after the respawn speaks from the dead character's last look and lines, takes along only what happened before the death, and is not kept as the new character's memory.

How it stays out of the way:

- CPU only (`num_gpu` 0), the shared `num_ctx`, `num_predict` 120, thinking off. A reply cut by the budget is trimmed back to its last full sentence. It takes no VRAM and does not make Ollama reload the menu model.
- It does not start while a menu turn, a plan, the death review or a menu turn's whole think-and-send is running. That includes idle thoughts.
- A menu turn or a plan that starts while it is writing cancels it at once. An order or moment goes back in the queue and does not use up the 30 seconds. An idle thought is just asked again later.
- One line at a time. Anything that arrives during one waits for the next slot.

The only changes to what the model says are a length cap (240 characters), trimming a cut reply to its last full sentence, and control characters turned into spaces. The log is capped at 1 MB and rolls to `pepe.log.1`.

Switches: `PZ_PEPE=0` turns it off. `PZ_PEPE_MODEL` picks another model. `PZ_PEPE_GPU_LAYERS` (default 0), `PZ_PEPE_PREDICT` (120), `PZ_PEPE_TIMEOUT`, `PZ_PEPE_KEEP_ALIVE` (10m), `PZ_PEPE_FILE` and `PZ_PEPE_LOG_MAX` (bytes) tune it. It is on by default when Ollama lists the model. If the model is not installed, or a call gets a 404, it logs one line and turns itself off for the session.

Measured on this PC on 2026-11-04 (`node bridge/tools/try-pepe.mjs`, `gemma4:12b` as the menu model). The script plays seven lines of one short run through the real commentator, so the prompt grows from 383 to about 1330 characters:

| | time |
|---|---|
| first line, model loading | 8.2 s |
| warm line, longer prompt | 5.3 to 9.6 s, median 6.8 s |
| menu turn alone | 406 to 428 ms, median 414 ms |
| menu turn fired 0.7 s into a thought | 526 to 613 ms, median 577 ms, the thought cut every time |

The longer prompt makes a line slower than before the summary (1.8 to 4.0 s). That is fine for commentary that speaks at most every 30 s. A menu turn that lands in the middle of a thought costs about 160 ms more than one on a quiet model, because the CPU is still winding down. It stayed under 650 ms in all five runs.

## Inner voice on screen

```
bridge --> Lua/local_voice.txt --> Voice.lua (twice a second, only when the text changed)
                                     |-- bubble over her head, about 7 s
                                     `-- "Inner voice" panel, top right, last 3 lines, newest on top
```

The mod shows the voice's half of the line (after the bar). The brain's half stays on /mind and in the HUD.

- **Bubble.** `addLineChatElement` on the player, in teal. It is overhead text only: no chat window entry and no world sound. Shout and Callout are never used, those draw zombies. Each line is said once and the game decides how long the bubble stays (ChatElement is not open to Lua in 42.21, so it cannot be asked); the panel keeps the line on screen. Lines over 140 characters are cut for the bubble. No bubble once she is dead.
- **Panel.** Titled "Inner voice", top right, medium font, a dark half clear background, word wrapped, the newest line white and the older two dimmer. It draws nothing until the first line arrives. The HUD is bottom left, so they do not overlap.
- **First read.** The first read only learns what the file already held, so a line left from the last run is not shown.
- **Off.** `;` toggles both. A file named `Zomboid/Lua/ls_voice_off.txt` (any content) turns both off and wins over the key. Default on. The HUD key line shows the state.
- **Stream filter.** Off by default. A file named `Zomboid/Lua/ls_voice_clean.txt` turns it on. Then a short list of slurs and the words that get Twitch channels banned (`ENCODED` in `Voice.lua`, ROT13 so the source holds none in the clear) is starred out, whole words only, same length. It changes the game display only. `/mind`, `pepe.log` and the history in the mod stay unfiltered. It does not catch leetspeak, so keep an eye on chat anyway. To add a word, ROT13 it and add it to the list.
- The flag files are looked for at every read, so you can switch them on or off while the game runs.

## Critic

A sober second opinion on each choice. The local model picks one id from a menu. The critic sends the same situation and the same menu to Jev, TypeSafe's hosted "System One" model, and logs how much Jev agrees. It never steers her. Nothing it says reaches the brain's prompt, the planner, or the order line. A test fails if any brain module imports it.

It is not the inner voice. The inner voice is a meme model that talks. The critic is a calibrated outside view, kept as numbers so the review can check it against what happened.

```
decision made, order sent
   |                                  (the bridge goes on at once)
   +--> critic.review()  one call at a time, 3 s limit
          |
          v   POST https://api.typesafe.ai/v1/systemone
          state      the digest she saw + how her last 3 orders went
          pick       choice over this turn's menu: option id -> its label
          danger     noul: is she in serious danger right now
          treat      noul: should she treat wounds before anything else
          mistake    noul: is the brain's pick a mistake here
          |
          v
   one `critic` line in decisions.jsonl, same id as the decision
```

A `choice` answer gives a probability for every option. A `noul` answer is a yes probability from 0 to 1. Jev gives no reasons, only numbers.

The log line (`t: critic`) has: `pick` (the brain's), `top` (Jev's), `pPick` and `pTop` (their probabilities), `confidence`, `danger`, `treat`, `mistake`, `agree` (top equals pick), `flag`, `flagAt`, `ms`, `inTokens`, `outTokens`, `model`.

**The flag rule.** A decision is flagged when the brain's pick got less than 15% of Jev's probability. Exactly 15% is not a flag. `PZ_CRITIC_FLAG` changes the threshold (0 to 1). `agree` is separate: Jev can prefer another option and still give the brain's pick 40%, which is not a flag. The threshold is saved on each line, so the review reads old lines by the rule they were judged with.

**How it stays out of her way.**

- Fire and forget. The order is sent first. The critic runs after, in the background.
- Short timeout: `PZ_CRITIC_TIMEOUT`, in milliseconds, default 3000. The request is aborted and also raced, so a hung socket cannot keep a call open.
- At most one call in flight. A turn that finds one running is not reviewed. That is counted, not queued.
- A failed call (network, 4xx, 5xx, a reply that fails validation) is skipped, with one log line per kind of trouble.
- `429` and `529` pause the critic: 15 seconds, doubling on each repeat, up to 5 minutes. A `Retry-After` header is honored up to the same cap. A good answer resets it.
- `401` turns it off for the session.
- Every field of a reply is checked: the pick is on the menu, every option has a probability from 0 to 1 that sum to about 1, and each yes/no value is a number from 0 to 1. A reply that fails any check writes nothing.
- Colin's own nudges are not reviewed. The critic looks at the brain.

**What leaves this PC.** The situation text (the same digest the brain reads, plus up to three lines about her last orders) and the labels of this turn's options. Game facts only. No names, no paths. The key goes in the `Authorization` header and nowhere else: not the URL, not a log line (a server that echoed it back would be scrubbed), not a file.

**Switches.** It is off until `TYPESAFE_API_KEY` is set. `PZ_CRITIC=0` turns it off even with a key. `PZ_CRITIC_FLAG` (default 0.15) and `PZ_CRITIC_TIMEOUT` (default 3000 ms) tune it. `PZ_CRITIC_URL` points it at another server and is only for tests.

**Cost.** $0.042 per million input tokens, output free. A turn is about 470 input tokens, so a thousand reviewed decisions cost about 2 cents. A live test of the API on this PC took about 100 to 110 ms a call warm and 330 ms the first time, for a short state with two questions. Those are the API's numbers. They have not been measured through the bridge with the game running.

**On /mind.** The Reactions strip has a Critic column: `agree` or `flag`, the probability Jev gave the brain's pick, Jev's own pick when it differs, and how much danger it sees. Hover for the wound and mistake numbers, confidence and time. A line above the strip says whether the critic is on, how many calls answered, failed or were skipped, and any pause. It is rebuilt only when a row changes, so a selection survives the two second refresh. The order of the strip is the orders sent, so a turn that kept the running job has a log line but no row.

**What the review does with it.** `node bridge/tools/review.mjs` has a Critic section: how often Jev's top pick matched, flags by situation and by who decided, and how flagged and unflagged orders went (failed, lost 5 HP or more, a zombie started chasing, died within 5 minutes). That is how to find out whether a flag predicts trouble. Nothing here says yet that it does. A flag can also be Jev being wrong, which is why the first thing to read is the unflagged row beside the flagged one.

`node bridge/eval/run.mjs --backend jev` scores Jev's choice on the eval scenarios (`docs/eval.md`).

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
