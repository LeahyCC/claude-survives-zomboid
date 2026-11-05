# Combat reflex

How the reflex fights. Code is in `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Reflex.lua`. Tests are in `test/reflex-decide.test.mjs`. If this page and the code disagree, the code wins and this page gets fixed.

The plan behind it is "Pro play in Build 42" in `docs/research.md`: shove, stomp, step back. Fight one standing zombie at a time. Stop when winded, panicked, overloaded or hurt.

## How it is built

Every 5 ticks `Reflex.survive(p)` runs three steps.

```
Reflex.snapshot(p)   reads the game into a plain table (snap), plus the zombie objects
Reflex.decide(snap)  pure: snap in, one action out, touches nothing in the game
Reflex.perform(...)  carries the action out and sets the HUD text
```

`decide` can be tested with plain tables, so every rule below has a test.

## The snapshot

| field | what it is |
| --- | --- |
| `zombies` | living zombies within 22 tiles on his floor: `{ d, dx, dy, down, crawl, chase, outside }` |
| `armed` | holding a melee weapon |
| `reach` | weapon range, the same sum the game uses (`getMaxRange * getRangeMod`) |
| `shortBlade` | reach under 1 tile |
| `hp` | overall body health, 0 to 100 |
| `endurance` | 0 to 1 |
| `panic`, `heavy`, `tired` | moodle levels, 0 to 4 |
| `inside` | not outside |
| `hold` | `{ dx, dy }` to a hold spot by a door or window, or nil |
| `heading` | the current walk direction, or nil |

`down` is on the floor, knocked down or playing dead. `chase` is "this zombie's target is him". If the target cannot be read, `chase` is true, which is how the reflex treated every zombie before.

## The rules, in order

The first rule that matches wins.

```
nothing within 11 tiles ............................ none
hp under 30 ........................................ flee (if one is within 8), else none
3 or more living within 7 .......................... flee
a downed one within 1, nothing standing within 2.5 . stomp
a downed one within 4, nothing standing within 2.5 . close in on it
inside, one chasing from outside, a hold spot ...... hold (swing if it is already in reach)
no standing zombie worth fighting .................. none
unarmed ............................................ shove if one is on him alone, flee if within 8
tired, panicked, overloaded or winded .............. shove if one is on him, else back off
two standing within 2 .............................. shove if one is on him, else back off
short blade, zombie not yet on him ................. flee (open the gap)
in reach, or within 1.5 ............................ swing
within 6 ........................................... close in
otherwise .......................................... none
```

"Worth fighting" means chasing him, or within 2 tiles, or within 4 tiles and in the way of his walk. An unaware zombie farther off is left to sneaking.

"On him" is within 1.2 tiles. Turning to walk away there gets him bitten, so he shoves instead. A shoved zombie falls, and the next tick stomps it.

## The numbers

All in `Reflex.N`. Distances are in tiles.

| name | value | used for |
| --- | --- | --- |
| `RANGE` | 11 | the reflex looks no farther |
| `SWARM_R`, `SWARM_N` | 7, 3 | a pack: flee |
| `HP_FLEE` | 30 | flee when hp is under this |
| `STOMP_REACH` | 1.0 | stomp a downed zombie this close |
| `STOMP_CLEAR` | 2.5 | no standing zombie this close before a stomp |
| `DOWN_CLOSE` | 4 | walk to a downed zombie this close |
| `SPACING_R` | 2 | a second standing zombie this close: back off |
| `ON_HIM` | 1.2 | shove instead of turning away |
| `BITE` | 1.5 | swing even if the weapon is shorter |
| `CHASE_MAX` | 6 | never walk farther than this to a fight |
| `UNAWARE_R` | 2 | fight an unaware zombie only this close |
| `BLOCK_R` | 4 | or this close and in the way |
| `BACKOFF` | 3 | tiles per back-off step |
| `HOLD_R` | 12 | hold for a chaser outside this close |
| `HOLD_SCAN` | 6 | look this far for a door or window |
| `HOLD_MAX` | 1800 ticks | give the spot up after 30 s with nothing within 3 |
| `END_LOW` | 0.3 | endurance gate |
| `PANIC_MAX` | 3 | panic gate (moodle level) |
| `HEAVY_MAX` | 2 | heavy load gate (moodle level) |
| `TIRED_MAX` | 3 | tired gate (moodle level) |

## Flags

```lua
LocalSurvivor.combat = { stomp = true, spacing = true, gates = true, doorHold = true }
```

Set one to `false` from the debug console to switch that part off. Nothing else changes.

| flag | off means |
| --- | --- |
| `stomp` | downed zombies are fought like standing ones (the weapon swing aims at the floor by itself) |
| `spacing` | the old rule: two zombies and one within 4 means flee |
| `gates` | endurance, panic, load and tiredness are ignored |
| `doorHold` | inside, he walks out to meet a zombie as before |

## Door and window hold

When he is inside and a zombie chasing him is outside, the snapshot looks for a door or window within 6 tiles that opens from a room to the outside. It picks the one nearest the zombie.

```
   outside      wall    inside
   zombie  -->   |W|   [fall]  [HOLD]
                        tile    he stands here
                        just
                        inside
```

He stands one tile in from the tile just inside the opening. A zombie that climbs in falls on that tile, next to him, and gets stomped. If it is in reach while still climbing, he swings. If a zombie is already inside and close, it is a normal fight. The spot is looked up again once a second. After 30 seconds with nothing within 3 tiles he gives the spot up for 30 seconds.

## Getting off a stuck door

A walk can stand on one tile and try the same door forever. `Reflex.releaseDoor` runs every tick (not in manual mode) and fires when all of these hold:

- A walk or pathfind action (`ISWalkToTimedAction`, `ISPathFindAction`) is at the head of the queue.
- He has stayed on one tile for 90 ticks.
- No zombie is within 2 tiles, and the last fire was more than 150 ticks ago.

It then clears the queue and queues a one-tile step to a neighbour that is not across a door. If every neighbour was tried, it opens an unlocked shut door next to him instead.

- Anything else at the head of the queue (eating, drinking, a transfer, bandaging, a window smash, sleeping) is never cleared, however long it takes. The 90 tick clock restarts when a walk begins.
- It never unlocks anything. A locked door he cannot open makes the walk fail, and the skill (ENTER) picks another way, a window if there is one.

## HUD text

| action | HUD action | thought |
| --- | --- | --- |
| stomp | `STOMP (reflex)` | It's down. Boot to the head before it gets up. |
| stomp, shove call failed | `STOMP (reflex)` | It's down. Hitting it before it gets up. |
| shove | `SHOVE (reflex)` | Too close. Shove it off me. |
| shove, unarmed | `SHOVE (reflex)` | No weapon. Shove it down and stomp. |
| back off, spacing | `BACK OFF (reflex)` | Two on me. Stepping back to take them one at a time. |
| back off, winded | `BACK OFF (reflex)` | Out of breath. Backing off before the swings go slow. |
| back off, panic | `BACK OFF (reflex)` | Hands are shaking. Backing off, I'll miss like this. |
| back off, heavy | `BACK OFF (reflex)` | Carrying too much to fight. Backing off. |
| back off, tired | `BACK OFF (reflex)` | Too tired to fight well. Backing off. |
| hold | `HOLD (reflex)` | Holding inside. Let it come through and fall. |
| close in on a downed one | `ENGAGING` | One's down. Moving in to finish it. |

Swing, close in, flee and the short blade keep their old text.

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

Every method was checked with `node tools/pz-api.mjs` against the 42.21 jar.

| call | sure | why |
| --- | --- | --- |
| `IsoPlayer:DoAttack(0)` | high | already used, and vanilla `ISReloadWeaponAction.attackHook` calls it |
| `IsoLivingCharacter:setDoShove(bool)` | medium-high | the game's own shove key does exactly this before attacking. Not seen live yet. |
| a stomp from `setDoShove(true)` next to a downed zombie | medium | follows from the bytecode. The floor target range in `calculateAttackVars` (a 0.6 constant) was not fully read, so `STOMP_REACH` may need tuning. A sandbox option can switch stomping off (`SwipeStatePlayer.isStompingDisabled`), and then it is just a shove. |
| `IsoPlayer:isAuthorizeShoveStomp()` | high | exists, vanilla tutorial sets it |
| `isAttackStarted()`, `faceThisObject(z)` | high | already used |
| `getMoodles():getMoodleLevel(MoodleType.PANIC / HEAVY_LOAD / TIRED)` | high | vanilla Lua uses these exact names |
| `getStats():get(CharacterStat.ENDURANCE)` | high | already read by `Sense.lua`, vanilla uses it |
| zombie `isOnFloor()`, `isKnockedDown()`, `isFakeDead()`, `isCrawling()`, `isOutside()` | high | in the jar |
| zombie `getTarget() == p` | medium-high | `getTarget` is in the jar. Vanilla compares Java objects with `==` (inventories in `ISInventoryTransferAction`). |
| `IsoDoor:getNorth()`, `IsoWindow:getNorth()`, `IsoGridSquare:getRoom()`, `getObjects()` | high | in the jar, `instanceof(o, "IsoDoor")` was already used |
| which side of a door is inside | medium | the north or west edge rule is how the game lays out walls. Not seen live yet. |

## Not done

- Standing at the head end of a downed zombie. The snapshot cannot tell which end is the head, so he stomps from where he stands.
- Closing the door behind him when he disengages.
- Holding a window against a pack of 3 or more. That still flees.
