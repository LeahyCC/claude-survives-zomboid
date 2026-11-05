# Combat reflex

How the reflex decides to fight, hold, back off, run, hide, sneak or climb. Code is in `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/`: `Stance.lua` (the pure judgement), `Reflex.lua` (reading the game and acting) and `ReflexLog.lua` (the log). Tests are in `test/reflex-decide.test.mjs` and `test/reflex-log.test.mjs`. If this page and the code disagree, the code wins and this page gets fixed.

The plan behind it is "Pro play in Build 42" in `docs/research.md`: shove, stomp, step back. Fight one standing zombie at a time. Fight from a doorway or behind a fence. Never start a fight winded, panicked, overloaded or hurt. Break line of sight, then crouch: that is how players lose zombies.

## How it is built

Every 5 ticks `Reflex.survive(p)` runs four steps.

```
Reflex.snapshot(p)     reads the game into a plain table (snap), plus the zombie and barrier objects
Stance.choose(snap)    pure: snap in, one decision out (Reflex.decide is the same function)
Reflex.perform(...)    carries it out with the game's own actions and sets the HUD text
ReflexLog.note(...)    logs a new stance, and the outcome of one taken 5 seconds ago
```

`Stance.assess(snap)` is the threat assessment inside `choose`. Both are plain tables in and out, so every rule below has a test without the game.

## The stances

| stance | when | what she does (perform kinds) |
| --- | --- | --- |
| FIGHT | one standing zombie (two with a weapon scoring 30 or more), armed and fit | `swing` in reach, `close` to walk in (6 tiles at most), `stomp` a downed one |
| HOLD | inside with a chaser outside and a hold spot, or a low fence or window between her and up to 2 chasers, or a short blade | `hold`: stand at the spot (or where she is) facing it, swing when it is in reach |
| SHOVE | one on her while she cannot fight, two within 2 tiles, or unfit with a chaser within 4 | `shove` (it falls), `backoff` 3 tiles, `stomp` when it is down and she cannot fight |
| BREAK | getting away with endurance 0.5 or more and not overloaded | `break`: one 10 tile walk along the best open line, sprint asked for |
| HIDE | getting away, and every chaser has lost sight of her | `hide`: crouch, drop the walk and keep still (nearest chaser 7 or more tiles), or creep 4 tiles away (4 to 7) |
| SNEAK | unaware zombies about and nothing chasing | `sneak`: crouch and let the order walk on. An unaware group within 7 tiles: creep away from it |
| CLIMB | getting away, and a low fence or a climbable window within 4 tiles leads away from them | `climb`: walk to the square in front, the game's climb action, then `wait` out the animation |
| FLEE | getting away, and nothing better fits (winded, overloaded) | `flee`: one 10 tile walk along the best open line, no sprint |

"Getting away" is one function (`escape` in `Stance.choose`). It tries CLIMB, then HIDE, then BREAK, then FLEE.

## The rules, in order

The first rule that matches wins.

```
mid climb (the action has left the queue, the body is going over) .... CLIMB wait
nothing living within 11 tiles ......................................... SNEAK if an unaware one is within 14 and nothing chases, else none
a standing zombie on her (1.2 tiles) .................................. FIGHT swing if armed, fit and alone, else SHOVE shove
hp under 30 ............................................................ get away if one is within 8, else none
a pack: 3 or more living within 7 ...................................... SNEAK away if none is chasing, else get away
spacing off: two within 7 and one within 4 ............................. FLEE (the old rule)
a downed one within 1, nothing standing within 2.5 ..................... stomp (FIGHT, or SHOVE when she cannot fight)
a downed one within 4, nothing standing within 2.5 ..................... FIGHT close
inside, a chaser outside, a hold spot, nothing standing inside close ... HOLD the door (swing if it is already in reach)
armed and fit, 1 or 2 chasers within 6 all across a fence or window .... HOLD the fence (swing in reach)
no standing zombie worth fighting ...................................... SNEAK if an unaware one is about and nothing chases, else none
every chaser lost sight of her, the nearest beyond 4, and she was
  already getting away, or cannot fight ................................ get away (which picks HIDE)
she was getting away, more chasers than she takes on, one within 8 ..... get away (a strung out pack is still a pack)
unarmed ................................................................ get away if one is within 8, else none
she must not start a fight (see gates) ................................. SHOVE backoff within 4, get away within 8, else none
two standing within 2 .................................................. SHOVE backoff
more standing chasers within 7 than her weapon takes on ................ get away ("outnumbered")
posture avoid, a chaser 6 to 8 tiles off ............................... get away ("avoid")
short blade, zombie not yet within 1.5 ................................. HOLD where she stands ("short")
in reach, or within 1.5 ................................................ FIGHT swing
within 6 ............................................................... FIGHT close
otherwise .............................................................. none
```

"Worth fighting" means chasing her, or within 2 tiles, or within 4 tiles and in the way of her walk. An unaware zombie farther off is left to sneaking.

"On her" is within 1.2 tiles. Turning to walk away there gets her bitten, so she swings or shoves. This now comes before the pack and hp rules, which used to turn her away from one in reach.

**Gates.** She must not start a fight when any of these hold, in this order: endurance under 0.3 (`winded`), panic moodle 3 or more (`panic`), heavy load moodle 2 or more (`heavy`), tired moodle 3 or more (`tired`), a part bleeding (`bleeding`), hp under 50 (`hurt`). The `why` of the decision names the first one.

**How many she takes on.** A weapon scoring under 30 takes on one standing chaser within 7 tiles. 30 or more (a crowbar, a bat, an axe) takes on two. With no score in the snapshot an armed hand counts as 30, which is how the old rules behaved.

**Open lines.** The snapshot checks the 8 compass headings for 6 clear tiles (`Move.lineClear`). A run takes the line that points most away from them and has no standing zombie near it. A run that has not moved a tile in 60 ticks marks its line blocked for 300 ticks, and the next decision takes another. That is the flee that stood on one tile in the 2026-11-04 run. With no open line it runs straight away from them, as the old flee did.

**Barriers.** Low hoppable fences (`isHoppable`, not `isTallHoppable`) and windows or frames the game says she can climb through now (`canClimbThrough`) within 4 tiles. A climb must lead away from them (cosine 0.5 or more), have a chaser behind her, and no zombie waiting within 4 tiles on the far side. The same fence or window is not climbed again for 600 ticks, so she does not climb straight back.

**Across.** For each standing zombie within 6 tiles the snapshot walks the tiles between them and checks each edge for a low fence or a window (`IsoGridSquare:isHoppableTo`, `isWindowTo`). A zombie with one in the way is `across`.

## The threat assessment

`Stance.assess(snap)` gives the counts the rules use and one number for the log.

```
threat   sum over living zombies within 11 tiles of   base * nearness
           base       standing chaser 1, standing unaware 0.3, crawler 0.3, downed 0.15
           nearness   within 1.5: 2, within 4: 1.5, within 7: 1, farther: 0.5
power    armed: 1 + weapon score / 40, bare hands: 0.5
fit      1, times 0.4 winded (0.75 under 0.5 endurance), 0.3 hp under 30 (0.6 under 50),
         0.7 bleeding, 0.6 panic, 0.7 heavy, 0.7 tired
ratio    threat / (power * fit)
level    0 nothing in range, 1 ratio under 1, 2 under 2, 3 under 4, 4 above
```

The level and the ratio are logged with every call and the level is in the percept. The rules themselves use the counts, so each one can be read and tested on its own.

## Posture

The brain may send a fight posture as a ninth field on the order line (`docs/architecture.md`). It shifts the thresholds. A missing or unknown posture is `normal`, the thresholds as they always were.

| posture | for | changes |
| --- | --- | --- |
| `normal` | anything | none |
| `avoid` | looting, travelling | walks at most 2 tiles to a fight, leaves unaware zombies alone unless within 1.2, never fights one in the way of the walk, takes on one chaser whatever the weapon, holds a fence against one, and gets away from a chaser 6 to 8 tiles off |
| `clear` | clearing a house | walks up to 8 tiles to a fight, goes for unaware zombies within 4 (6 in the way), takes on two chasers, a pack is 4, holds a fence against three |

`Act.execIntent` reads it into `LocalSurvivor.posture`. The bridge writes it only when an option carries `posture` (`orderLine` in `bridge/brain.mjs`). No option does yet: choosing a posture for each job is a later card.

## Sneak and sprint

Sneak is a toggle in the game (`IsoPlayer.updateSneakKey` flips it only when the crouch key is pressed), so `setSneaking` stays as set. The reflex crouches for HIDE and SNEAK and stands for everything else. `Reflex.manageSneak` runs every 30 ticks and stands her up once neither has been chosen for 90 ticks. Before this she sneaked whenever a zombie was 6 to 25 tiles off, chasers included, which slowed every escape.

Sprint is a different story. Read from the 42.21 bytecode:

- `IsoPlayer.updateInternal2` sets running and sprinting false, then sets them from the input state (the run and sprint keys) on every frame.
- `UpdateInputState` reads the keys, and `isForceRun` and `isForceSprint`. Their setters are not public, so Lua cannot reach them.
- `OnTick` fires after `IsoWorld.update`, and `OnPlayerUpdate` fires before the reset. So a `setSprinting(true)` from the mod is wiped before her next move.
- `setPathfindRunning` exists but nothing in the jar or the vanilla Lua reads it.

So BREAK asks for a sprint (`setSprinting(true)` each time it acts, false when the stance changes), but it most likely does nothing and she walks. `survive` reads `isSprinting()` back and the log's `sprint` field says whether it ever held. If the first soak test shows `sprint: false` every time, BREAK and FLEE are the same walk and only the follow-up (HIDE) differs. `LocalSurvivor.combat.sprint = false` turns the call off.

## The snapshot

| field | what it is |
| --- | --- |
| `zombies` | living zombies within 22 tiles on her floor: `{ d, dx, dy, down, crawl, chase, sees, across, outside }` |
| `armed` | holding a real melee weapon (a pen, fork or anything else under the weapon score floor counts as bare hands) |
| `weaponScore` | `Core.weaponScore` of the weapon in hand, read again every 300 ticks or when the item changes |
| `reach` | weapon range, the same sum the game uses (`getMaxRange * getRangeMod`) |
| `shortBlade` | reach under 1 tile |
| `hp` | overall body health, 0 to 100 |
| `bleeding` | parts bleeding |
| `endurance` | 0 to 1 |
| `panic`, `heavy`, `tired` | moodle levels, 0 to 4 |
| `load` | carried weight over max weight |
| `inside` | not outside |
| `hold` | `{ dx, dy }` to a hold spot by a door or window, or nil |
| `heading` | the current walk direction, or nil |
| `lines` | open compass headings `{ dx, dy, dir, blocked }`, only with a zombie within 11 |
| `barriers` | fences and windows within 4: `{ kind, dx, dy, d, nx, ny, key, failed }`, `nx ny` the way across |
| `climbing` | a climb animation is running |
| `posture` | `normal`, `avoid` or `clear` |
| `prev` | the last stance taken |
| `kills` | `getZombieKills`, for the log only |

`down` is on the floor, knocked down or playing dead. `chase` is "this zombie's target is her". If the target cannot be read, `chase` is true, which is how the reflex treated every zombie before. `sees` is `isTargetVisible()` for a chaser. Unknown counts as seeing her. Lines and barriers are read at most every 30 ticks, or after she moves 2 tiles.

## The numbers

All in `Stance.N` (`Reflex.N` is the same table). Distances are in tiles.

| name | value | used for |
| --- | --- | --- |
| `RANGE` | 11 | the reflex looks no farther |
| `SWARM_R`, `SWARM_N` | 7, 3 | a pack |
| `HP_FLEE` | 30 | get away when hp is under this |
| `HP_FIGHT` | 50 | do not start a fight under this |
| `STOMP_REACH` | 1.0 | stomp a downed zombie this close |
| `STOMP_CLEAR` | 2.5 | no standing zombie this close before a stomp |
| `DOWN_CLOSE` | 4 | walk to a downed zombie this close |
| `SPACING_R` | 2 | a second standing zombie this close: back off |
| `ON_HIM` | 1.2 | swing or shove instead of turning away |
| `BITE` | 1.5 | swing even if the weapon is shorter |
| `CHASE_MAX` | 6 | never walk farther than this to a fight |
| `UNAWARE_R` | 2 | fight an unaware zombie only this close |
| `BLOCK_R` | 4 | or this close and in the way |
| `STEP_R` | 4 | unfit: back off from a chaser this close, get away from one farther |
| `FIGHT_MAX` | 1 | standing chasers a weak weapon takes on |
| `STRONG` | 30 | the weapon score that takes on two |
| `BARRIER_R` | 6 | a fence or window between them this close can be held |
| `HOLD_N` | 2 | hold a fence against this many at most |
| `CLIMB_R` | 4 | climb a fence or window this close |
| `CLIMB_AWAY` | 0.5 | the climb must point this much away (a cosine) |
| `END_SPRINT` | 0.5 | endurance for BREAK, under it FLEE |
| `SNEAK_R` | 14 | crouch while an unaware zombie is this close |
| `HIDE_NEAR` | 4 | a chaser this close is not hidden from |
| `HIDE_STILL` | 7 | nearer than this she creeps away, farther she keeps still |
| `RUN_STEP` | 10 | tiles per break or flee walk |
| `HIDE_STEP` | 4 | tiles per crouched creep |
| `BACKOFF` | 3 | tiles per back-off step |
| `HOLD_R` | 12 | hold for a chaser outside this close |
| `HOLD_SCAN` | 6 | look this far for a door or window |
| `HOLD_MAX` | 1800 ticks | give a hold spot up after 30 s with nothing within 3; stop taking the tick after 30 s of hiding |
| `END_LOW` | 0.3 | endurance gate |
| `PANIC_MAX` | 3 | panic gate (moodle level) |
| `HEAVY_MAX` | 2 | heavy load gate (moodle level) |
| `TIRED_MAX` | 3 | tired gate (moodle level) |

In `Reflex`: `LINE_LEN` 6, `TERRAIN_TICKS` 30, `BAD_LINE_TICKS` 300, `RUN_STUCK` 60, `CLIMB_ANIM` 120, `CLIMB_GIVEUP` 300, `CLIMB_AGAIN` 600, `WEAPON_TICKS` 300.

## The reflex log

Every stance and what came of it, so a soak test shows which escapes work. `ReflexLog.lua` keeps it.

```
Reflex.survive -> ReflexLog.note     a new stance: a call line; 300 ticks later: its out line
                  ReflexLog.flush    about once a second, appended to Zomboid/Lua/local_reflex.txt
bridge/reflexlog.mjs                 follows the file, appends each line to bridge/decisions.jsonl as t: reflex
node bridge/tools/review.mjs         "Reflex by stance": calls, escapes, hits, hp lost, kills
```

A call is written when the stance changes, or when the same stance comes back after 120 quiet ticks. The file starts again on the first write of a game session and past 256 KB. The bridge reads it from the end when it starts, and from 0 when the file gets shorter.

`call` line:

| field | meaning |
| --- | --- |
| `id` | session start (ms) and a counter, shared with its `out` line |
| `tick` | the mod's tick |
| `stance`, `act`, `why` | the decision |
| `threat`, `level` | the assessment |
| `f` | facts: `near`, `chasers` (within 10), `seen` (of those, the ones that see her), `standing` (within 7), `within3`, `downed`, `unaware`, `armed`, `score`, `endurance`, `hp`, `panic`, `bleeding`, `load`, `inside`, `door` (a hold spot), `barriers`, `lines`, `open`, `posture` |

`out` line, 5 seconds after the call:

| field | meaning |
| --- | --- |
| `escaped` | nothing chasing within 10 tiles and nothing standing within 3. The bridge's hold line, so it means the brain has her back. |
| `chased`, `near` | still chased, and the nearest zombie |
| `hpLost`, `hits` | hp lost in the window (drops only), and the drops over 0.2 in one tick |
| `kills` | zombies killed in the window |
| `next` | the stance at the end |
| `sprint` | BREAK only: did `isSprinting()` ever read true |

Windows of calls close together overlap, so a hit can count for two stances. With one call per stance change that is rare.

The percept's `reflex` field is a summary (`docs/percept.md`).

## Flags

```lua
LocalSurvivor.combat = { stomp = true, spacing = true, gates = true, doorHold = true, climb = true, hide = true, sprint = true }
```

Set one to `false` from the debug console to switch that part off. Nothing else changes.

| flag | off means |
| --- | --- |
| `stomp` | downed zombies are fought like standing ones (the weapon swing aims at the floor by itself) |
| `spacing` | the old rule: two zombies and one within 4 means flee |
| `gates` | endurance, panic, load, tiredness, bleeding and hp under 50 are ignored |
| `doorHold` | inside, she walks out to meet a zombie as before |
| `climb` | no fence or window scan, no CLIMB |
| `hide` | no HIDE: getting away is BREAK or FLEE |
| `sprint` | BREAK does not call `setSprinting` |

## Door and window hold

When she is inside and a zombie chasing her is outside, the snapshot looks for a door or window within 6 tiles that opens from a room to the outside. It picks the one nearest the zombie.

```
   outside      wall    inside
   zombie  -->   |W|   [fall]  [HOLD]
                        tile    she stands here
                        just
                        inside
```

She stands one tile in from the tile just inside the opening. A zombie that climbs in falls on that tile, next to her, and gets stomped. If it is in reach while still climbing, she swings. If a zombie is already inside and close, it is a normal fight. The spot is looked up again once a second. After 30 seconds with nothing within 3 tiles she gives the spot up for 30 seconds.

A fence hold is the same idea outside, with no spot to walk to: she stays where she is, on her side of the fence, and swings at what comes over.

## Climbing

```
CLIMB chosen      walk to AdjacentFreeTileFinder.FindWindowOrDoor (the square vanilla picks), then
                  ISClimbOverFence:new(p, fence, nil) or ISClimbThroughWindow:new(p, window, 0)
queue empties     the action ran; the body goes over in the animation. CLIMB_ANIM ticks of wait
current state     a state name with "Climb" in it (ClimbOverFenceState, ClimbThroughWindowState) is also a wait
not started       after CLIMB_GIVEUP ticks the queue is cleared and the climb dropped
```

The direction over a fence is left to `ISClimbOverFence:getFacingDirection`, which reads `HoppableN` on the fence's square the way vanilla does. A tall fence (`isTallHoppable`) is never picked: vanilla climbs those with `climbOverWall`, which is slower and can fail.

## Getting off a stuck door

A walk can stand on one tile and try the same door forever. `Reflex.releaseDoor` runs every tick (not in manual mode) and fires when all of these hold:

- A walk or pathfind action (`ISWalkToTimedAction`, `ISPathFindAction`) is at the head of the queue.
- She has stayed on one tile for 90 ticks.
- No zombie is within 2 tiles, and the last fire was more than 150 ticks ago.

It then clears the queue and queues a one-tile step to a neighbour that is not across a door. If every neighbour was tried, it opens an unlocked shut door next to her instead.

- Anything else at the head of the queue (eating, drinking, a transfer, bandaging, a window smash, sleeping) is never cleared, however long it takes. The 90 tick clock restarts when a walk begins.
- It never unlocks anything. A locked door she cannot open makes the walk fail, and the skill (ENTER) picks another way, a window if there is one.

## Game speed

`Reflex.manageSpeed` runs every 15 ticks and sets the game speed. `Reflex.pickSpeed` is the pure rule, `Reflex.speedFacts` gathers what it needs. G turns the whole thing off, and a pause (speed 0) is never touched.

- Speed 2 when no zombie is within 60 tiles, otherwise 1. Manual mode is always 1.
- **Night fast forward** is speed 3 (20 times). It needs every one of these:
  - `LS.nightFast` is on (K toggles it, default on) and it is night, 21:00 to 06:00, the same hours as `isNight` in the bridge.
  - She is inside a building, no zombie is within 8 tiles or in sight, nothing is chasing her and she is not bleeding.
  - It was 20 tiles at first. In town some zombie is almost always inside 20, so the night never sped up (8 of 101 samples in the first live night). One 15 tiles off outside a shut house is no threat.
  - The last order was WAIT, REST or SLEEP, or she is asleep. With the first three, no skill is running, no needs job other than REST, no momentum walk, and the queue is empty or only a sit.
  - No snap back in the last 600 ticks.
- Speed 4 is not used. Speed 3 is enough, and at 40 times the 5 tick checks have very little game time to react in.
- Asleep skips the order and queue checks, since she cannot walk. The game sets its own fast speed for sleep. The mod does not lower it to 3, and only slows it when one of the other conditions fails.

Vanilla `ISWalkToTimedAction:isValid` is false above speed 2, so a walk queued at 3 or 4 is dropped. Everything that could queue one slows the clock first with `Core.snapSpeed` (speed 1, and a 600 tick cool down):

- `Act.execIntent` for any order except WAIT and REST, and SLEEP unless she is already asleep (SLEEP walks to a bed and shuts the room first).
- `Reflex.perform` for any reflex action except a SNEAK that only crouches, and `Move.doMove` for every walk it starts.
- Pressing a movement key (manual mode), and turning night fast forward off with K.
- A hit: `Reflex.watchHealth` runs every tick and snaps when body health drops by more than 0.2. It also feeds the reflex log's hits and hp lost.
- A zombie inside 8 tiles or in sight, a chaser, bleeding or a new order that walks, found by `Reflex.guardSpeed` every 5 ticks while the speed is above 2.

`Core.snapSpeed` does nothing when auto speed is off (G) or the game is paused. The speed is in the percept as `speed`. The HUD title row shows "NIGHT FAST FORWARD" while it runs, and otherwise whether the K switch is on.

## Weapon score

`Core.weaponScore` gives every melee weapon one number, so the mod compares weapons the same way everywhere. EQUIP, LOOT, SEARCH, DROP, the percept and now the reflex all read it. It is pure: plain facts in, a number out. Tests are in `test/lua-loot.test.mjs`.

The facts come from the item (`Core.weaponFacts`): max damage, crit chance, max range, two-handed, weight, swing time, condition and the script category.

```
damage   max damage (capped at 3) * (1 + crit / 100)
reach    * (reach / 1.2), between 0.5 and 1.35
speed    * (1 + (3 - swing time) * 0.1), between 0.85 and 1.2
weight   / (1 + 0.08 * (weight - 2)), for weight over 2
two-hand * 1.05
class    axe 1.1, long blade 1.1, spear 1.05, blunt 1, short blunt 0.85, small blade 0.6, other 0.8
improvised * 0.85
wear     * (0.4 + 0.6 * condition)
score    that * 20
```

Under 0.5 max damage it is 0. A broken weapon, or one with no condition left, is 0. Under a score of 5 it is not a weapon: EQUIP, LOOT, the percept and the reflex leave it out (`Core.holdingMelee` reads a pen as bare hands).

| weapon | score |
|---|---|
| pen, pencil, fork, spoon | 0 |
| kitchen knife | 9 |
| hammer | 19 |
| crowbar | 30 |
| baseball bat | 34 |
| axe | 51 |
| machete | 73 |

These are the 42.21 item script numbers at full condition. A crowbar at 10% condition is under 20.

A swap needs the new weapon to score 25% over the one in hand (`Core.WEAPON.SWAP`). Without that, a bat and a crowbar would trade places as wear moved their scores. Which weapon to wield is `Act.chooseWeapon`, a game rule, and it lives in Act.

## HUD text

| action | HUD action | thought |
| --- | --- | --- |
| stomp | `STOMP (reflex)` | It's down. Boot to the head before it gets up. |
| stomp, shove call failed | `STOMP (reflex)` | It's down. Hitting it before it gets up. |
| shove | `SHOVE (reflex)` | Too close. Shove it off me. |
| shove, unarmed | `SHOVE (reflex)` | No weapon. Shove it down and stomp. |
| back off | `BACK OFF (reflex)` | one line per `why`: spacing, winded, panic, heavy, tired, bleeding, hurt |
| hold a door | `HOLD (reflex)` | Holding inside. Let it come through and fall. |
| hold a fence | `HOLD (reflex)` | Fence between us. Let it climb over and fall. |
| hold, short blade | `HOLD (reflex)` | Knife is short. Letting it come to me. |
| close in on a downed one | `ENGAGING` | One's down. Moving in to finish it. |
| break | `BREAK CONTACT (reflex)` | Running to get out of their sight. |
| flee | `FLEE (reflex)` | Too close, breaking away to open the gap. |
| hide | `HIDE (reflex)` | They lost me. Down low and still. / They lost me. Creeping away low. |
| sneak, creeping away | `SNEAK (reflex)` | A group that hasn't seen me. Creeping away. |
| sneak past | the order's own | It hasn't seen me. Keeping low. |
| climb | `CLIMB (reflex)` | Over the fence. They'll be slow on it. / Through the window. That slows them. |

Swing and close in keep their old text.

## How a shove and a stomp are started

No vanilla Lua starts a shove. The game does it in Java. This was read from the 42.21 bytecode in `projectzomboid.jar`.

- The shove key path (`IsoPlayer.updateInternal2`) calls `setDoShove(true)`, then `AttemptAttack(chargeTime)`.
- `IsoPlayer.DoAttack(f)` calls `CombatManager.pressedAttack`. That copies the player's `isDoShove()` into the attack, then `calculateAttackVars` picks the target. When the best target is lying down, it sets `aimAtFloor`.
- `isDoStomp()` is `isDoShove() and isAimAtFloor()`. So a stomp is a shove started next to a downed zombie. There is no `setDoStomp`.
- `SwipeStatePlayer.exit` clears `doShove` when the attack ends. The reflex also sets it false before every swing, so a leftover never turns a swing into a shove.
- Without a shove, the same auto aim makes a weapon swing hit a downed zombie (weapon wear). That is the fallback.

So the reflex does this:

```lua
p:setDoShove(true)   -- shove or stomp; false for a swing
p:DoAttack(0)
```

If `isAuthorizeShoveStomp()` says no (the tutorial switches it off), or `setDoShove` fails, it does a plain `DoAttack(0)` instead.

## Game calls and how sure they are

Every method was checked with `node tools/pz-api.mjs` against the 42.21 jar, and `IsoFlagType.HoppableN` with `node tools/pz-consts.mjs`.

| call | sure | why |
| --- | --- | --- |
| `IsoPlayer:DoAttack(0)` | high | already used, and vanilla `ISReloadWeaponAction.attackHook` calls it |
| `IsoLivingCharacter:setDoShove(bool)` | medium-high | the game's own shove key does exactly this before attacking. Not seen live yet. |
| a stomp from `setDoShove(true)` next to a downed zombie | medium | follows from the bytecode. The floor target range in `calculateAttackVars` (a 0.6 constant) was not fully read, so `STOMP_REACH` may need tuning. A sandbox option can switch stomping off (`SwipeStatePlayer.isStompingDisabled`), and then it is just a shove. |
| `IsoPlayer:isAuthorizeShoveStomp()` | high | exists, vanilla tutorial sets it |
| `isAttackStarted()`, `faceThisObject(z)` | high | already used |
| `getMoodles():getMoodleLevel(MoodleType.PANIC / HEAVY_LOAD / TIRED)` | high | vanilla Lua uses these exact names |
| `getStats():get(CharacterStat.ENDURANCE)` | high | already read by `Sense.lua`, vanilla uses it |
| `getBodyDamage():getNumPartsBleeding()`, `getInventoryWeight()`, `getMaxWeight()`, `getZombieKills()` | high | in the jar, already read by `Sense.lua` |
| zombie `isOnFloor()`, `isKnockedDown()`, `isFakeDead()`, `isCrawling()`, `isOutside()` | high | in the jar |
| zombie `getTarget() == p` | medium-high | `getTarget` is in the jar. Vanilla compares Java objects with `==` (inventories in `ISInventoryTransferAction`). |
| zombie `isTargetVisible()` | medium | in the jar (`IsoZombie`). What it returns while a zombie walks to where it last saw her is not seen live. |
| `setSneaking(bool)`, `isSneaking()` | high | already used; the bytecode shows sneak only flips on the crouch key |
| `setSprinting(bool)`, `isSprinting()` | low | in the jar, but the bytecode says the game resets sprint from the keys every frame (see Sneak and sprint) |
| `getCurrentStateName()` | medium | in the jar, `StateMachine.getCurrent().getName()`. That the name holds "Climb" during a climb is from the class names, not seen live. |
| `IsoGridSquare:isHoppableTo(sq)`, `isWindowTo(sq)`, `has(IsoFlagType.HoppableN)`, `getObjects()` | high | in the jar; vanilla `ISClimbOverFence` reads `HoppableN` the same way |
| `IsoObject:isHoppable()`, `isTallHoppable()` | high | in the jar; vanilla `ISClimbOverFence:new` reads `isTallHoppable` |
| `IsoWindow`, `IsoWindowFrame`, `IsoThumpable`: `canClimbThrough(p)`, `getNorth()`, `isWindow()` | high | in the jar; vanilla `ISClimbThroughWindow:isValid` uses `canClimbThrough` |
| `ISClimbOverFence:new(p, fence, nil)` | medium | vanilla passes a direction from the context menu. With nil, its own `getFacingDirection` picks it. Not seen live. |
| `ISClimbThroughWindow:new(p, window, 0)` | high | ENTER already climbs this way |
| `AdjacentFreeTileFinder.FindWindowOrDoor(sq, obj, p)` | high | ENTER already uses it, and vanilla `luautils.walkAdjFence` uses it for fences too |
| `IsoDoor:getNorth()`, `IsoWindow:getNorth()`, `IsoGridSquare:getRoom()` | high | in the jar, `instanceof(o, "IsoDoor")` was already used |
| which side of a door or fence is which | medium | the north or west edge rule is how the game lays out walls. Not seen live yet. |

## Not done

- Standing at the head end of a downed zombie. The snapshot cannot tell which end is the head, so she stomps from where she stands.
- Closing the door behind her when she disengages.
- Holding a window against a pack of 3 or more. That still gets away (CLIMB, BREAK or FLEE).
- Choosing a posture for each job in the bridge. The field and the Lua side are in.
- Real line of sight. HIDE trusts the zombie's own `isTargetVisible`. BREAK runs along open lines, not toward corners or doors that would break sight.
- A sprint that works. See Sneak and sprint.
