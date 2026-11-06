# Pro rules: what already exists, and what to borrow

Written 2026-11-05. It answers one question before the next features: are we reinventing the wheel?

```
looting        no. Bandits does not judge loot. Our loot table is ahead of it.
task order     yes. Bandits has the same cascade as ours, plus stages that hold a job to the end.
doors, walls   yes. Its door checks and wall checks are worth borrowing. Its flee is close to ours.
house craft    partly. The guides have a clear order. We have the parts but not the loop.
```

The biggest finding is in our own log, not in a mod. She rarely gets to loot, because the menu keeps taking SEARCH away.

Evidence:

- `bridge/decisions.jsonl`, one copy taken 2026-11-05 22:07 UTC: 1163 decisions over about 296 minutes (gaps over 10 minutes left out), 07:03 to 22:07 UTC.
- `bridge/soak-2026-11-05-10-18.txt` covers 10:18 to 13:18 UTC: 557 of these decisions and 3 of the deaths below. Only the last three lives ran the weapon and chase merges (21:14 and 21:23 UTC).
- `node bridge/tools/review.mjs --decisions <that file>` gives the deaths, stances and failure counts. The other counts came from one-off scripts over the same copy. They are not in the repo.
- Bandits: `PAVE44/Bandits`, commit `36111fc`, folder `42.21/media/lua/`. No license file, so this doc takes ideas and game calls only. No code.

## Read first: what the numbers hide

**1. The review's best escapes are not escapes.** It says SNEAK escapes 81% and CLIMB 64%. No SNEAK call had a chaser at the time. 202 of the 311 CLIMB calls are the wait during a climb with nothing chasing, most of them ENTER's own window climb. "Escaped" also means free 5 seconds later, while guides say sight must be broken for 3 to 10 seconds or more. Counting only calls with a chaser, without the climb waits:

| stance | escaped within 5 s | hp lost, kills (all calls) |
|---|---|---|
| SHOVE | 35 of 111 (32%) | 142 hp, 11 kills |
| BREAK | 41 of 199 (21%) | 78 hp, 3 kills |
| FIGHT | 16 of 92 (17%) | 168 hp, 23 kills |
| CLIMB | 16 of 96 (17%) | 94 hp, 1 kill |
| HOLD | 9 of 85 (11%) | 5 hp, 0 kills |
| FLEE | 6 of 53 (11%) | 29 hp, 0 kills |
| HIDE | 4 of 42 (10%) | 2 hp, 0 kills |

Do not judge HIDE or BREAK until the review also checks at 30 seconds.

Fixed in `review.mjs`: it now counts only calls with a chaser, leaves out climb waits and shows both counts, checks escaped at 5 s and 30 s, and prints a session end apart from deaths. The table above is the old script's.

**2. "Infection" is not the top killer.** The review shows 3 infection deaths, and one of those is real. `guessDeath` in `bridge/death.mjs` tests the infected flag before bleeding, so a fresh bite that bleeds out reads as infection. The "unknown" death is not a death: hp was 100 at 12:44, then the log stops for 9 hours.

| life began (UTC) | game hours | review says | what the log shows |
|---|---|---|---|
| 09:01 | 86.6 | infection | Real. 23 hp in one hit inside a house, one on one, with a worn pan (score 7.7). Dead about 48 real minutes later. |
| 10:38 | 7.7 | overrun while fleeing | Frozen first. 98 WAITs in 22 minutes, inside, a zombie under 8 tiles on every turn and none chasing, menu only WAIT or EAT. Load 22 of 12. Then one ENTER took her out and she was overrun. |
| 11:07 | 2.8 | infection | Reads as a bleed-out. Hit inside during SEARCH by a zombie 0.7 tiles off, hp 63 to 0 in under 4 minutes, 3 wounds. BANDAGE on the menu in 1 of 21 turns. |
| 11:17 | 34.6 | unknown | No death. Session ended. |
| 21:33 | 3.5 | infection | Reads as a bleed-out. 3 standing inside a house, hp 78 to 0 in 2 minutes, no bandages, BANDAGE on the menu in 0 of 7 turns. |
| 21:46 | 12.3 | bitten in a fight | Colin's "fought 3". ENTER with 11 near and 4 chasing. Swing at hp 100 with 2 standing. Next line 35 seconds on: hp 26, 3 standing. |

Four of the five real deaths began inside a house. Hit moments (10 second groups): 9 inside cost 130 hp, 11 outside cost 13 hp.

**3. She spends 3% of her time searching.**

```
WAIT     80 min  27%  ###########################
ENTER    75 min  25%  #########################
keep     31 min  10%  ##########
SECURE   30 min  10%  ##########
DRINK    23 min   8%  ########
GOTO     22 min   8%  ########
SEARCH   10 min   3%  ###
```

79 entries, 38 buildings, 41 of them re-entries. Only 14 of the 79 got a SEARCH before she left.

**4. The model is not the cause of that.** 63 of 168 ENTER orders were sent from inside another building, all by the model, and 46 of those had rooms left. SEARCH was on the menu for only 5 of the 63. It was missing because of the gates in `needOptions` (`bridge/options.mjs`):

```
WAIT inside, rooms left, no SEARCH on the menu: 268 turns, 41 minutes
  112  a zombie under 8 tiles (only 1 was chasing). 97 of these were also heavy.
    5  heavy only
   66  already searched this life
   85  not explained by the log (map memory from an earlier life, a retry timer, or
       the 60% no-bag weight line: the log has no bag field, and this count used 85%)
```

The 8 tile test ignores walls. `zList` has no wall field. The roadmap names the same bug class: "a hold rule that froze her next to a zombie behind a wall". The hold was fixed. These gates were not.

**5. Source quality is thin.** The fan guides give numbers with no source, and many disagree. Steam threads are mostly Build 41. The Reddit mirrors returned 403, so r/projectzomboid was not read. Take the order of things from the guides, and test any number in game first.

## 1. From Bandits

Bandits drives zombie bodies as NPCs. Doors toggle with no timed action, items teleport, a bandage sets health to full (`ZombieActions.Bandage.onComplete`), and "Run" is an animation variable. So actions do not port. Nothing here helps the sprint problem in `docs/combat.md`.

### How it picks a task

`GenerateTask` (`client/BanditUpdate.lua`) runs a cascade and the first non-empty answer wins:

```
ManageEndurance -> ManageHealth -> ManageCombat -> ManageCollisions -> program stage
```

The program only runs with no task queued. A program is a small state machine: `ZombiePrograms.<Name>.<Stage>` returns `{status, next, tasks}` (`shared/ZombiePrograms/`).

- **We have the cascade**: reflex, then policy, then the menu.
- **We lack stages.** Our menu asks afresh each turn, so nothing holds "finish this house". This is the most useful idea in the mod.
- **Exit rules are explicit.** `ZombiePrograms.Thief.Operate` goes to `Escape` at over 10 items, or when no container is left (`ZPThief.lua`).
- **Stay until something changes.** `ZombiePrograms.Defend.Wait` stays put and only changes program when the bandit is outside or a player comes in (`ZPDefend.lua`). It sleeps 00:00 to 07:00 and 13:00 to 14:00, and notices at 30 tiles awake, 10 asleep, 3 less for a sneaking player.
- **Dark is a light reading, not an hour.** `ZombiePrograms.Thief.Operate` uses `getClimateManager():getDayLightStrength() < 0.3` to choose a sneak walk at night (`ZPThief.lua`). Our dusk is a fixed hour.
- **Run when hurt.** `ZombiePrograms.Bandit.Main` goes to `Escape` under 70% health, if that sandbox option is on (`ZPBandit.lua`).

### How it loots

Do not expect a loot brain here.

- `ZombiePrograms.Looter` has no looting in it. It walks to a target, or shrugs (`ZPLooter.lua`).
- `BanditLoot.lua` is a table of what bandits spawn carrying, not a rule for what is worth taking.
- `ZombiePrograms.Thief.Operate` takes the first item type from the closest non-empty container with no value test.
- `ZombieActions.LootItems` takes everything in a container.
- `BanditPrograms.Weapon.Resupply` is the closest to judgement, and it is switched off (`elseif false and resupply` in `ManageCombat`).
- `lootContainer` in `ZALootWeapons.lua` takes a gun only if its ammo is in the same container, and melee only with bare hands. Our loot table already does better.

Worth taking:

- **Corpses.** `Resupply` scans 3 tiles around her with `getDeadBody` and `getStaticMovingObjects`, then reads `getContainer` on the `IsoDeadBody`. Our open item "corpses are not searched" needs just this.
- **A base index.** `BanditPlayerBase.Regenerate` (`client/BanditPlayerBase.lua`) scans a base 10 tiles square at a time so it costs little. `ReindexItems` builds item to containers. `GetContainerWithItem` returns the closest holding enough. `RegisterBase` adds 20 tiles of padding. This is the shape for a stash.

### How it moves, opens and climbs

`ManageCollisions` (`client/BanditUpdate.lua`) acts when the walk bumps something. It checks her square and the 4 next to it.

- **Windows:** barricaded (break it, if hostile), closed (smash if hostile, else open unless `isPermaLocked`), then `canClimbThrough` means climb.
- **Doors:** a double door (`IsoDoor.getDoubleDoorIndex`, `toggleDoubleDoor`) and a garage door (`getGarageDoorIndex`, `toggleGarageDoor`) have their own branches. A locked door is tested with `isLocked`, `isLockedByKey` and also `isObstructed`.
- **Fences:** low fence (`FenceTypeLow` or `isHoppable`), tall fence (`FenceTypeHigh` or `isTallHoppable`).
- **Reaching a thing:** `AdjacentFreeTileFinder.Find`, which we use too. `BanditUtils.GetAccessSquare` is its own version: a free neighbour with no wall in between, nearest first.
- **Walk type by distance:** `Bandit.GetCombatWalktype` uses run over 7 tiles, walk over 4, aim walk closer, limp under 80% health.
- **A warning, not a tool:** `RemoveWindowFromPathing` unsets `canPathN` and `canPathW` on a window, and is switched off with `if true then return end`. The author hit pathing through windows too and did not keep that fix. Changing shared map flags is not safe for us either.

### How it handles zombies

`ManageCombat` (`client/BanditUpdate.lua`), in order:

| rule | number | ours |
|---|---|---|
| Shove what is on you, armed or not | within 1 tile | Swing first if armed, fit and alone within 2 (`Stance.lua:347`) |
| Stomp what is down | within 1 tile | Same idea |
| Swing only in weapon reach | melee range 1.2 inside, 2.6 outside | Similar |
| Run from a group | 2 or more within 10, and not in melee range | 3 within 7, or more chasers than the weapon takes on |
| Step back from a close group | 2 or more within 2.8, one tile backward | `SPACING_R` 2 |
| Only count what can reach you | `banditSquare:isSomethingTo(enemySquare)` skips zombies behind something | Not in the menu gates |
| Bandage | under 40% health, and low priority | Policy, first in line, but only if on the menu |

**The flee direction.** Each zombie within 10 tiles pushes the bandit away with force 1 over distance squared, so the near ones dominate. A sideways nudge of 0.25 stops two zombies cancelling out. The new heading is 70% new and 30% last, so it does not jitter. The walk is 6 tiles plus 1.5 for each threat, up to 5. Ours is already close: `Stance.pickLine` scores 8 compass lines and marks down any line with a near zombie on it. The two things to take are the memory of the last heading and the walk that grows with the threat. It is a tweak, not a rewrite, and it will not fix a chase at walking speed.

`CalcSpottedScore` is how bandits spot players. It is not how zombies see, so do not read it as a game rule.

### Game calls we do not use yet

Each name was checked with `node tools/pz-api.mjs`. A grep of the mod's Lua finds none of them. None has run live here.

| call | use |
|---|---|
| `LosUtil.lineClear(cell, x1, y1, z1, x2, y2, z2, false)` | Is there a wall between her and a zombie. Bandits compares the result's text to `Blocked` (`BanditUtils.LineClear`) |
| `IsoGameCharacter:CanSee(obj)` | Can this zombie see her |
| `IsoGridSquare:isSomethingTo(sq)` | Something on the edge between squares. Bandits uses it at any range. What it returns for squares that are not neighbours is unknown, so prefer `lineClear` |
| zombie `getSquare():getBuilding()` | Is this zombie in this house. Count them before searching, or before entering |
| zombie `getThumpTarget()` | It is beating on something. The nearest thing to "listen for thumps". Found in the jar, not used by Bandits |
| zombie `getTargetSeenTime()` | May tell how long since it saw her. Meaning unverified. Found in the jar |
| `IsoDoor:isObstructed()`, `getDoubleDoorIndex`, `getGarageDoorIndex` | Why a door will not open |
| `IsoGridSquare:getDeadBody()`, `getDeadBodys()`, `getStaticMovingObjects()`, then `IsoObject:getContainer()` | Search corpses |
| `ClimateManager:getDayLightStrength()`, `getFogIntensity()`, `getRainIntensity()` | Dusk by light, and weather |
| `ItemContainer:getAllEvalRecurse(fn, list)`, `getItemCountFromTypeRecurse(type)` | Count what a stash holds |
| `IsoRoom:getLightSwitches()` | Lights in a room without a scan |

The game's own path follower also climbs. `zombie/pathfind/PathFindBehavior2.class` holds the names `checkDoorHoppableWindow`, `climbThroughWindow` and `climbOverFence`. That fits the log, and it explains part of Colin's note on windows. It is not proven at runtime for a player's walk.

## 2. From the guides

Read 2026-11-05. Tags:

```
PF42.20  pzfans day-one checklist, verified 42.20.4
PF42.19  pzfans, verified 42.19
BG42.20  build42guide.wiki, verified 42.20
WK       projectzomboid.wiki, 2026 pages, Build 42 era, names no build, mostly unsourced
ZP42     zomboidpro.it.com, May 2026, "written for Build 42", unsourced
ST41     Steam threads 2021 to 2023, Build 41 or older, player opinion
RS       already in docs/research.md
```

Rules we already follow are not listed unless a conflict needs them.

### Loot

- Take the first bag of any size. PF42.20. We do.
- By room: kitchen for food and bottles, bathroom for meds and rags, closets for clothes and a bag. PF42.20. Ours only reorders rooms when she lacks a weapon. **Gap: order rooms by what she lacks.**
- Leave extra weapons, perishables on long routes, and anything you would drop to run. BG42.20.
- Ignore fishing rods, most books, exotic weapons, furniture, heavy ammo, and clothes past one warm layer. WK.
- Rip clothes into rags when bandages are short, and prefer real bandages. PF42.20. **Gap: our loot table leaves all clothes, and DROP throws dirty rags away.**
- No guns on day one. Think about them once food, water and bandages have been stable for five days. WK. **Conflict with our loot table, which ranks a gun with ammo above medicine, for what is now a last resort (`docs/combat.md`, "Guns").**
- Keep runs short: "two hours of looting, not twelve". BG42.20. **Gap: no time limit.**
- The first days: day 0 a two-story house with exits, bag, melee weapon, water. Day 1 bandages, disinfectant, painkillers, tinned food, can opener. Day 2 hammer, nails, saw, screwdriver. Day 3 a second food cache in another building. WK.

### House loop

```
noise off -> listen -> look -> way in -> close it -> search room by room -> leave quiet
```

- Turn off TVs and radios first. PF42.20. **Gap: SECURE handles lights, not these.**
- Listen for thumps before opening a door. Peek through windows. PF42.20.
- If the front is stacked, use the back door or the fenced yard. PF42.20. Enter on the side away from the street. WK.
- Close interior doors behind you and clear room by room. WK.
- After a fight, leave for 10 to 15 game minutes. Do not keep looting there. WK.
- Expand only to adjacent houses or a quiet shop. PF42.20.
- Leave by a loop with an exit. BG42.20.

### Base and stash

- Day one needs a safe room, not a fortress: one room with a door that closes, a bed or seat, water and food. PF42.20.
- Pick two floors, several exits, near water. WK. Upstairs beats the ground floor. WK.
- Within walking distance of food, water and a hardware store. WK.
- Barricade after clearing, not before. WK. Leave one exit open until there is a sheet rope. WK.
- A base has no attraction score. Only sound, sight, scripted events and population moves draw zombies. PF42.19.
- Keep outer doors closed when not moving loot. PF42.19.
- Keep a second food cache in another building. WK.
- Empty areas refill on a default 12 game hour timer. PF42.19, BG42.20. **So "cleared" and crowd notes should expire.**

### Entry

- Door first. Breaking a window is noise, so prefer unlocking. WK, RS.
- Clear glass before climbing. RS. We do.
- `Act.chooseWay` is not door first. A door only gets 2 tiles of credit, so a window 3 tiles closer wins, and an open window gets no credit. In the log: 19 doors, 55 windows, 5 smashed. Locked doors are not logged, so some of this is fair.

### Fight or run

- Never more than 2 standing in the open without a clear way out. WK.
- Run at 4 or more, or a triggered horde. With stamina over 50%, just leave. ZP42.
- Draw at most 2 if poorly armed. ST41.
- When panic redlines, leave through a door you can close. WK.
- Hit standing zombies before stomping downed ones, unless the downed one blocks the way out. WK.
- Our log agrees. FIGHT with 1 standing: 81 calls, 35 hp, 15 kills. With 2 standing: 23 calls, 95 hp, 3 kills. Windows overlap, so read the shape, not the exact sum.

### Losing chasers

| claim | source |
|---|---|
| Followers go to where she was for 1 to 2 s after a corner. Turn one corner, then get out of view fast, say in a window and out the front | ST41 |
| 90 degree turn past a window or door, then stop at least 3 s | ST41, 2024 reply, second hand |
| Out of sight 5 to 10 s, and not heard | ST41 |
| Zombies have a 6 s memory. With a door there, they attack the door | ST41 |
| Keep awareness 60 to 90 s after losing sight | WK |
| Break sight and silence is not enough, they home in | ST41 |
| Lose all of them. If one still knows, all may follow | ST41, marked unsure |
| Crouch behind a car or low fence and you drop off pursuit | WK |
| Stand up and walk once seen. Crouch only slows you | ST41 |
| Walking outpaces them, and running is loud | ST41 |
| Through a house by its windows, and trees also shake them | ST41 |

The first three point to one rule: **corner, then a second corner, then stop.** Our HIDE trusts `isTargetVisible` and BREAK runs open lines, not corners, as `docs/combat.md` says under "Not done". Note also: that page says walking does not gain on a walker, yet the case it quotes went from 5 tiles to 8 in 5 seconds. Check this before building on it.

### Noise and night

- Rough order: crouch, walk, doors, shove, swing, sprint, gun, alarm. Exact numbers disagree (see below).
- Indoors halves the sound radius. BG42.20.
- Curtains block sight, not noise. PF42.19.
- Fog and dark cut sight. BG42.20, WK. Storms dampen hearing. BG42.20.
- Guns: pistols about 60 to 120 tiles, shotguns about 200. PF42.19. A house alarm about 600. WK, RS.
- Never loot a new, dense area at night. BG42.20. "Night looting doubles bite risk". WK, no source.
- Lanterns and torches draw zombies at night. BG42.20.

### Day-one order

PF42.20: noise off, weapon and shoes, scan exits and zombies, loot the spawn house, fill water, set up a closed safe room, then adjacent houses, then a pharmacy or hardware store only with a weapon, water and a way back. Leaving the spawn house empty-handed to rush a pharmacy is called a common mistake.

WK: bag, weapon, water, tinned food, bandages and disinfectant, then sheet rope and hammer.

### Conflicts

| topic | one says | another says | use |
|---|---|---|---|
| Doorways | Fight one at a time in a doorframe (WK combat, RS) | Never fight in doorframes (WK stealth) | Keep HOLD: 85 chased calls cost 5 hp, though it made no kills |
| Curtains | First thing on street windows (PF42.20) | After looting a room (WK) | At night, or when she stays. Not per room by day |
| Night | Suits cleared low density areas (BG42.20) | Do not loot (WK) | Only in places already cleared |
| Crouch | Hides you (WK) | Slows you once seen (ST41) | Crouch before being seen, stand after |
| Time out of sight | 1 to 2, 3, 5 to 10, 6 s (ST41) | 60 to 90 s (WK) | Measure it. See read first, point 1 |
| Noise radius | Walk 7 (RS), 8 to 20 tiles (WK) | Walk heard only next door (ZP42) | Order only, no numbers |
| Windows | Rarely spotted through one (ST41) | If you see it, it sees you (ZP42) | Treat as seen |
| First item | Weapon (PF42.20) | Bag (WK) | Whichever comes first. Weapon if a zombie is near |
| Guns | None early (WK), a shot pulls zombies from far off (PF42.19) | Our table ranks them high | The reflex fires only as a last resort, then leaves and marks the area (`docs/combat.md`, "Guns"). The loot rank above medicine is not changed yet: Colin's call |

## 3. Colin's notes against the evidence

Ordered by deaths, then wasted time.

| # | note | evidence | have now | borrow | card idea |
|---|---|---|---|---|---|
| 1 | Fought 3 instead of running | 2 deaths. 95 hp per 3 kills at 2 standing, 35 hp per 15 at 1. Hit moments inside cost 130 hp, outside 13 | `Stance.lua:347` swings while one is on her and only one is within 2, before the pack rule and the weapon limit are read. Runs are walks | Bandits `ManageCombat`: shove within 1 tile, run at 2 or more, flee by weighted push. WK: max 2 | With 2 or more standing and a weapon under 30: shove, then leave. Never a stand-and-swing |
| 2 | House loop | 1 death (the freeze). 14 of 79 entries searched. 41 min of WAIT with rooms left, 63 ENTERs out of a house | `Act.lua` skills, `options.mjs` gates, `policy.mjs` find-weapon. No stage, no time limit | Bandits program stages and exit rules. `lineClear`, `getBuilding`. PF42.20 order | A house job the bridge holds: in, shut, look, search, leave. Menu only at stage ends. Walls count in the gates |
| 3 | Memory of crowds, searched houses | Part of the last death: ENTER with 11 near. 35 ENTER failed "zombie", 45 sent again after a failure. 42 of 80 tries never got in. ENTER is 75 min | `memory.mjs`: visited, searched, took. `zombies` only updates while she stands inside. Retry after a zombie failure is 30 s | `getBuilding` count. Refill timer 12 game hours (PF42.19) | Crowd map by building and by area, from every percept, fading over about 12 game hours. ENTER blocked while crowded |
| 4 | In by broken windows, out an open door, back in | 41 re-entries, 9 A-B-A bounces. 15 of 38 SECURE fail "not inside". Mid-climb log lines with no chaser during SECURE 15, GOTO 9, SLEEP 5. 5 loud smashes | `Act.chooseWay` gives a door only 2 tiles of credit. SECURE walks with vanilla handlers | Path follower names in the jar. Bandits warning on `RemoveWindowFromPathing`. Door order from WK, RS | Door first, then open window, then glass. Shut the window she used. A SECURE or SLEEP walk stops if it leaves the house |
| 5 | Phase plan | Bare hands in 231 of 267 turns in one life, first weapon at hour 13. Since the weapon merge, first weapon by hour 2.1 or less. 53 night turns outside in that same life. 30 night-outside orders, 11 chased. Still dying in 3 to 12 hours with a weapon, so gear alone does not save her | `planner.mjs` writes text. `policy.mjs` night rules. `options.mjs` dusk at 17:00 | Thief's `getDayLightStrength() < 0.3`. PF42.20 order, WK day 0 to 3 | Phases in code, not planner text: gear out when weapon 20+, bag, water, 2 bandages. Dusk by light |
| 6 | Base and stash, moving when a better one is found | No death traced. Of the 268 frozen WAITs above, 102 were at 85% load or more, and 97 of those were also behind the 8 tile gate. DROP threw out a closed umbrella, painkillers, a tin, rags | `safehouseScore`, `plan.home`, `homeOption`. DROP goes to the floor. No stash | `BanditPlayerBase` index, padding 20. PF42.20 safe room. WK second cache | Later. First: DROP goes in a container at home. Then a stash index |

**One place I disagree with the note: SECURE before loot.** A whole-house SECURE costs three times the time of all SEARCH (30 minutes against 10), and 26 of 38 failed. Doors are also noise, and the guides close the door behind you, not the house. By day I would do: in, shut that door, count zombies in the house, search, leave. Keep full SECURE for the room she sleeps in. Colin's call.

**A caveat on note 1.** "Running" is not a real sprint for her (`docs/combat.md`), and turning away with one on her gets her bitten. So the rule is a shove first and then a walk, not just run. Stand-and-shove escaped 3 of 4 in the loop rule, and SHOVE has the best real escape rate above.

## 4. Top 5 cards

**1. Two on her: shove and leave.** Fixes 2 of 5 real deaths and the most hp. Reflex only. Source: Bandits `ManageCombat`, WK max 2, our FIGHT counts. Also log a line when the standing count rises in a fight, because 35 seconds of that fight had no line at all.

**2. Walls count.** Add to `zList` whether a wall is between (`LosUtil.lineClear`) and whether the zombie is in her building (`getBuilding`). SEARCH and DROP gate only on zombies that can reach her soon. Fixes the 22 minute freeze before a death, and much of the 41 minutes of WAIT. Source: Bandits `isSomethingTo` filter and `BanditUtils.LineClear`.

**3. A house job with stages.** In, shut, look, search, leave, held by the bridge. No ENTER elsewhere while rooms are left and nothing threatens. Door-first order in `Act.chooseWay`. Time limit on a house. Fixes 63 ENTERs out of a house, 41 re-entries and the 3% search time. Source: Bandits program stages and Thief exit rules, PF42.20 and BG42.20 for the order.

**4. Stop the bleeding first.** Bleeding beats DROP, SECURE, GOTO and ENTER when nothing is on her. Fall back to ripping cloth, and do not drop rags. Under 30 hp, no DROP. Fix the `guessDeath` order so a bleed-out reads as one. Fixes 2 deaths and about 200 hp lost while bleeding during GOTO, ENTER and WAIT. Source: PF42.20 rags, Bandits' health-before-program cascade.

**5. Crowd map.** Zombie counts by building and area from every percept, fading over 12 game hours. Failed "zombie" blocks ENTER for minutes, not 30 seconds. Fixes 35 failures, 45 repeats, part of 75 minutes of ENTER, and the walk into 11 zombies. Source: PF42.19 and BG42.20 refill timer. `BanditPlayerBase` for gradual scanning.

**Small and worth doing first:** the review should count only calls with a chaser, skip climb waits, and also check at 30 seconds. Every later card is judged by this.

## Sources

- Bandits: https://github.com/PAVE44/Bandits (commit `36111fc`, folder `42.21/media/lua/`)
- pzfans: https://pzfans.com/what-should-i-do-first-in-project-zomboid/ , https://pzfans.com/what-attracts-zombies-to-bases/ , https://pzfans.com/how-to-crouch-in-project-zomboid/
- build42guide: https://build42guide.wiki/survival/build-42-loot-routes , https://build42guide.wiki/survival/build-42-stealth-noise
- projectzomboid.wiki: https://projectzomboid.wiki/guides/stealth-mechanics/ , https://projectzomboid.wiki/guides/stealth-noise/ , https://projectzomboid.wiki/guides/combat-basics/ , https://projectzomboid.wiki/items/early-loot/ , https://projectzomboid.wiki/guides/getting-started/
- zomboidpro: https://zomboidpro.it.com/post-zombie-behavior.html
- Steam: https://steamcommunity.com/app/108600/discussions/0/2958293022040232182 , https://steamcommunity.com/app/108600/discussions/0/3198117849826832802 , https://steamcommunity.com/app/108600/discussions/0/3823036151095135723 , https://steamcommunity.com/app/108600/discussions/0/3198118671859516481 , https://steamcommunity.com/app/108600/discussions/0/3493131640467957685

Could not read: two pzfans pages (404), two Reddit mirrors (403). pzwiki.net was skipped as the card asked.
