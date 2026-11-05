# Skills

What each order does, when it is done, and why it fails. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Act.lua` and `Move.lua`.

```
order line   SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET
result       res = {seq, verb, status, why} in the percept
status       running -> done | failed
```

Every order sets `running` when it starts. The verbs below then set `done` or `failed` with a short `why`. The older one-shot verbs (`EAT DRINK EQUIP CLOSEDOOR CONCEAL BREAKIN STOP WAIT`) stay `running` (`EQUIP` is `done` at once when the right weapon is already in hand), or `failed` with the old message like `eat: no food`.

A failure also sets `err` in the percept to `verb: why`, for example `enter: locked`. The v1 brain only reads `err`. The v2 brain reads `res` and keeps a failed order off its menu for a while (`docs/brain.md`).

## How a skill runs

`GOTO`, `ENTER`, `SEARCH`, `LOOT` and `DROP` are skills. One runs at a time, in `LocalSurvivor.skill`. `Act.update` moves it on every tick, called from the entry file right after the reflex.

```
reflex acted this tick      skill pauses, does not touch the queue
quiet for 30 ticks          skill resumes and queues its step again
zombie within 4 of target   on resume: failed "zombie"
paused over 1800 ticks      failed "zombie"
```

- A new order replaces the running skill and clears the queue. `WAIT` does not. The v2 brain sends nothing at all while a skill runs (`docs/brain.md`).
- A `MOVE` that arrives while `SEARCH` or `LOOT` still has item transfers queued waits for them, as `LOOT` always did.
- Each step reads the world again, so a resume just runs the step again.

Walking for a skill goes through the game's pathfinder (`ISWalkToTimedAction`). A leg fails in two ways:

- `unreachable`: the walk ends twice without getting a tile closer.
- `stuck`: a walk is queued but the body has not moved half a tile in 300 ticks (about 5 seconds).

The reflex's unstick helper (`Reflex.releaseDoor`) firing 3 times within 1800 ticks (about 30 seconds) on one tile is also `stuck`. The helper only fires on a stuck walk, so every fire counts. It never touches a transfer, a smash or any other action done in place (see `docs/combat.md`).

## MOVE

`A` = dx, `B` = dy, a heading in tiles, -40 to 40.

- Walks straight to the farthest loaded square along the heading when nothing blocks the line (`IsoGridSquare:isBlockedTo` on each step).
- A wall within 3 tiles: the pathfinder gets up to 7 squares fanned around the heading (0, 30, 60 and 90 degrees each side) and goes to the nearest it can reach (`ISPathFindAction:pathToNearest`).
- Keeps drifting the same way between orders (momentum), as before.
- Never reports `done`.
- Failed `stuck`: the unstick rule above.
- Failed `unreachable`: three steps in a row ended less than a tile from where they started.

A reflex flee also walks through `Move.doMove`. It walks the old way and never reports.

## GOTO

`A` = x, `B` = y, a tile on the survivor's floor.

- Walks to the square. If the square holds furniture, to a free square next to it (`AdjacentFreeTileFinder.Find`). If it is not loaded yet, it steps that way as MOVE does and tries again as squares load.
- Done `arrived` within 1.5 tiles.
- Failed: `no target` (A or B not a number), `unreachable`, `stuck`, `zombie`.

## ENTER

`TARGET` = a building `id` from the percept's `buildings` list.

```
nearest door  ->  locked?  ->  next door or window (quiet, up to 4 tries)
                                 -> none left: smash the nearest locked window
```

- Ways in are the building's exterior ground-floor doors (from the place scan) and windows (read from the footprint once).
- At a door: an open door is walked through. A closed one is opened (`ISOpenCloseDoor`), then walked through. A locked door is unlocked first when he carries its key (see below). Any other locked or boarded door is skipped. Lock state is only read once the body is at the door.
- Keys: the test is the one vanilla makes in `ISLockDoor:isValid`, `getInventory():haveThisKeyId(door:checkKeyId())`. A door he holds the key to is tried before any window, however far. At the door he queues `ISLockDoor:new(p, door, false)` (the vanilla unlock), then opens and walks in. If the door still does not let him in, the next way is tried.
- At a window: a smashed one has its glass cleared first (`ISRemoveBrokenGlass`), then climbed (`ISClimbThroughWindow`). A closed unlocked one is opened (`ISOpenCloseWindow`) and climbed. A locked one is noted for smashing.
- Smashing (`ISSmashWindow`, then `ISRemoveBrokenGlass`, then the climb) happens only when no quiet way is left, or 4 quiet ways failed and a locked window is known.
- Done when the square under the survivor belongs to the building. `why` is `in by a door`, `in through a window`, `in through a smashed window (loud)` or `already inside`.
- Failed: `no target`, `unknown building` (not in the place scan's memory), `locked` (every way was locked or boarded), `unreachable`, `stuck`, `zombie`.

## SEARCH

No arguments. Searches the building the survivor stands in.

- Rooms nearest first, then containers in the room nearest first. Rooms on another floor count 4 tiles per floor.
- Containers are `IsoRoom:getContainer()`. If that is empty, the room squares are read for objects with containers.
- Walks next to each container (`AdjacentFreeTileFinder.Find`) and takes what the loot table wants (below), inside the weight budget.
- Items go into the worn back bag while it has room, otherwise the main inventory. A bag that is taken is worn (`ISWearClothing`).
- A transfer that did not happen (the reflex clears the queue when it fights or flees) gets one more try.
- When the search took a weapon, the skill takes it up before it reports (see EQUIP below). It queues the equip, waits for it, and tries once more if the reflex cut it off. The `why` text stays `took 4: ...` because the bridge reads it. The percept's `weapon` and `weaponScore` show the result.
- Finished rooms are kept in `LocalSurvivor.searched[buildingId][roomKey]`. The next SEARCH skips them.
- Done when every room is searched or the weight reaches 85% of `getMaxWeight()`. `why` is `took 4: Crowbar, Water Bottle, Beans, Bandage`, with ` (full)` when it stopped on weight, or `took nothing`.
- Failed: `not inside`, `nothing left` (every room was already searched), `full` (at 85% before starting), `zombie` (one within 8 tiles at the start, or the rule above), `stuck`.

A container the body cannot reach is skipped, not a failure. A room that is not loaded is left for a later SEARCH.

## EQUIP

No arguments. Wields the best weapon he carries, one level into bags.

- Every melee weapon is scored (`Core.weaponScore`, see `docs/combat.md`). A pen, fork, spoon and a broken weapon score 0 and are never wielded.
- A swap needs a clear gain: the new weapon must score 25% more than the one in hand. Two close weapons never trade places as wear moves their scores.
- Empty hands or a pen in hand: any real weapon will do, the best one wins.
- A weapon in a bag is moved to the main inventory first, as vanilla's equip does, then `ISEquipWeaponAction` runs with both hands for a two-hander.
- Already holding the best: nothing is queued and the order is `done` with `already holding the best`.
- Failed: `equip: no weapon` (nothing carried scores above the floor).

## DROP

No arguments. Sheds weight until he is under the same line SEARCH stops at (85% of `getMaxWeight()`).

- Takes the least valuable items first, the heaviest first among equals. Junk goes before anything useful: a pen, spare clothes, toys, weights, food he cannot eat.
- After junk come tools, then a spare weapon, then sealed food, then empty bottles.
- Never dropped: the weapon in hand, the best weapon he carries, clothes he wears, any bag, water, food he can eat now, bandages and ripped sheets.
- Each item goes through the game's own drop (`ISInventoryPaneContextMenu.dropItem`). A held item is unequipped first. One in a bag comes out of the bag.
- It plans up to 3 passes, reading the weight again after each, because a bag softens the weight of what is inside. A pass that dropped nothing ends the skill.
- Done: `dropped 2: Dumb Bell, Spiffo`, with ` (still heavy)` when nothing more could go.
- Failed: `not heavy` (already under the line), `nothing to drop` (everything left is on the never list, or the game refused the drop).

## LOOT

No arguments. Kept for the v1 brain.

- Searches the room the survivor is in, with the same table. No junk pass.
- Outside, or in a room with no containers: the nearest container within 10 tiles, and the room it is in.
- Always looks again, even in a room a SEARCH finished. It marks the room searched too.
- Done and failed as SEARCH. With nothing in reach it fails `nothing left`, so `err` starts with `loot` and the bridge does not loot there again.

## Loot table

`Act.LOOT`, best first. `max` counts what is already carried, one level into bags. Scoring is the pure `Act.lootPick(desc, have)` and `Act.planTake(descs, have, budget)`, tested in `test/lua-loot.test.mjs`.

| Key | Takes | Max | Test |
|---|---|---|---|
| weapon | a real weapon when none is carried, or one that scores 25% over the best carried | | `Core.weaponScore` below |
| bag | a back bag, when none is worn | 1 | `IsInventoryContainer`, `canBeEquipped` is `ItemBodyLocation.BACK` |
| water | a container of clean water | 4 | `FluidContainer`, `Fluid.Water`, not tainted or poisonous |
| bottle | an empty bottle up to 2 L, or another drink | 2 | `isEmpty`, not `isInputLocked`, `getCapacity` |
| food | food that can be eaten now | 12 | `Core.isEdible` |
| can | sealed food | 12 | `Core.isSealedFood` |
| opener | a can opener, when none is carried | 1 | tag `CAN_OPENER` |
| bandage | a clean bandage | 6 | `isCanBandage`, not tag `CAN_BE_WASHED` |
| sheet | ripped sheets | 6 | `Base.RippedSheets` |
| disinfectant | disinfectant or alcohol wipes | 2 | 40% alcohol over 0.15 L, or alcohol power 4 |
| painkiller | pills | 2 | `Base.Pills` |
| hammer saw screwdriver | one each | 1 | tags `HAMMER` `SAW` `SCREWDRIVER` |
| lighter | a lighter or matches | 1 | tag `START_FIRE` |
| flashlight | a flashlight | 1 | tag `FLASHLIGHT` |

Clothes (`IsClothing`) and anything that matches no row are left. Broken items are left.

Weapons rank first, above water and food. A pen, pencil, fork or spoon is never taken. A weapon with a score under 5 is left too. The score is in `docs/combat.md`.

A better weapon than the best carried is always taken, ahead of everything else the room holds. It still has to fit in the weight left. The weapon row sorts by score, so an axe beats a crowbar when both are in the box. A second weapon that is no clear gain is left behind.

The class comes from the item script's `Categories`, read with `Item:containsWeaponCategory(WeaponCategory.X)` the way `XpUpdate.lua` does.

## Checked and unchecked

Every Java method the skills call was checked against the 42.21 jar with `node tools/pz-api.mjs`, and every vanilla Lua function against `media/lua`. The tests drive each skill with stub squares and a stub queue. What the real pathfinder, doors, windows and containers do is only checked in a live game.

The weapon score, EQUIP and DROP use vanilla Lua that was read but not run live: `ISInventoryPaneContextMenu.dropItem(item, playerNum)`, `transferIfNeeded(player, item)`, and `ISEquipWeaponAction:new(player, item, time, primary, twoHands)`. The Java methods were checked with `node tools/pz-api.mjs`: `getCriticalChance`, `getSwingTime`, `getMaxDamage`, `getMaxRange`, `isTwoHandWeapon`, `isHandItem`, `isWorn`, `isEquippedClothing`. Whether a drop from inside a worn bag behaves in game is only checked live.
