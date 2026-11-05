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
| `armed` | holding a real melee weapon (a pen, fork or anything else under the weapon score floor counts as bare hands) |
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

## Weapon score

`Core.weaponScore` gives every melee weapon one number, so the mod compares weapons the same way everywhere. EQUIP, LOOT, SEARCH, DROP and the percept all read it. It is pure: plain facts in, a number out. Tests are in `test/lua-loot.test.mjs`.

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

Under 0.5 max damage it is 0. A broken weapon, or one with no condition left, is 0. Under a score of 5 it is not a weapon: EQUIP, LOOT and the percept leave it out.

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

The reflex does not read the score yet. It still counts a pen as an armed hand (`Reflex.snapshot`).

Loot has a higher floor than the reflex. A weapon is only worth carrying at a score of 8 (`Core.LOOT.WEAPON_MIN`): a kitchen knife (9) and a saucepan pass, a plunger (6.3) does not. See "Loot table" in `docs/skills.md`.

## Guns

A firearm is gear, not the melee weapon. `Core.isMeleeWeapon` leaves it out (`isRanged()` or `isAimedFirearm()`), so it has no weapon score and never enters the list of melee weapons.

- The mod carries one, takes one in a search (with its ammo), and reports it in the percept: `guns`, `heldGun` (`docs/percept.md`).
- EQUIP never wields a gun, and never swaps a gun in hand for a melee weapon (`docs/skills.md`).
- A gun in hand is armed for the equip rule and for the bridge (`weaponPoor` is false, the equip rule does not fire).
- **The reflex does not fire it.** `Reflex.snapshot` sets `armed` from `Core.holdingMelee`, which is false for a gun, so a survivor with a pistol in hand shoves and stomps as if unarmed, and flees from a pack. Firing is the reflex card's follow-up. It needs, found in the jar and the vanilla Lua but not run: aim (`setIsAiming`, `isAimingFirearmEquipped`) and fire with `IsoPlayer:DoAttack` while a ranged weapon is in the main hand and a round is chambered or loaded (`isRangedWeaponEmpty`, `HandWeapon:isRoundChambered`, `getCurrentAmmoCount`); rack with `ISRackFirearm`; reload with `ISReloadWeaponAction` (a magazine gun takes `getBestMagazine` through `ISInsertMagazine`, an empty magazine fills through `ISLoadBulletsInMagazine`, loose rounds go in through `ISInventoryPaneContextMenu.onLoadBulletsIntoFirearm`; `ISReloadWeaponAction.attackHook` already calls `DoAttack`); `getMinRangeRanged()` and `getMaxRange()` for the distance; and the per-gun ammo facts the percept now carries (`guns[i].ammo`, `guns[i].loaded`). A noise rule is also needed, since a shot is loud and pulls zombies from far off.

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
- `Reflex.perform` for any reflex action, and `Move.doMove` for every walk it starts.
- Pressing a movement key (manual mode), and turning night fast forward off with K.
- A hit: `Reflex.watchHealth` runs every tick and snaps when body health drops by more than 0.2.
- A zombie inside 8 tiles or in sight, a chaser, bleeding or a new order that walks, found by `Reflex.guardSpeed` every 5 ticks while the speed is above 2.

`Core.snapSpeed` does nothing when auto speed is off (G) or the game is paused. The speed is in the percept as `speed`. The HUD title row shows "NIGHT FAST FORWARD" while it runs, and otherwise whether the K switch is on.

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
