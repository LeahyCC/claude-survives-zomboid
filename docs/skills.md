# Skills

What each order does, when it is done, and why it fails. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Act.lua` and `Move.lua`.

```
order line   SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET
result       res = {seq, verb, status, why} in the percept
status       running -> done | failed
```

Every order sets `running` when it starts. The verbs below then set `done` or `failed` with a short `why`. The older one-shot verbs (`EAT DRINK EQUIP CLOSEDOOR CONCEAL BREAKIN STOP WAIT`) stay `running`, or `failed` with the old message like `eat: no food`.

A failure also sets `err` in the percept to `verb: why`, for example `enter: locked`. The v1 brain only reads `err`. The v2 brain reads `res` and keeps a failed order off its menu for a while (`docs/brain.md`).

## How a skill runs

`GOTO`, `ENTER`, `SEARCH` and `LOOT` are skills. One runs at a time, in `LocalSurvivor.skill`. `Act.update` moves it on every tick, called from the entry file right after the reflex.

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

The reflex's unstick helper (`Reflex.releaseDoor`) firing 3 times within 1800 ticks (about 30 seconds) on one tile, while a walk was queued, is also `stuck`. Fires that cut something other than a walk (a transfer, a smash) do not count.

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
- At a door: an open door is walked through. A closed one is opened (`ISOpenCloseDoor`), then walked through. A locked or boarded door is skipped. Lock state is only read once the body is at the door.
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
- A transfer that did not happen (the unstick helper clears the queue) gets one more try.
- Finished rooms are kept in `LocalSurvivor.searched[buildingId][roomKey]`. The next SEARCH skips them.
- Done when every room is searched or the weight reaches 85% of `getMaxWeight()`. `why` is `took 4: Crowbar, Water Bottle, Beans, Bandage`, with ` (full)` when it stopped on weight, or `took nothing`.
- Failed: `not inside`, `nothing left` (every room was already searched), `full` (at 85% before starting), `zombie` (one within 8 tiles at the start, or the rule above), `stuck`.

A container the body cannot reach is skipped, not a failure. A room that is not loaded is left for a later SEARCH.

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
| weapon | a melee weapon better than the best carried | | `Act.weaponValue` below |
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

Weapon value: class first, then damage, then condition.

```
axe, spear, long blade, long blunt (two-handed or reach 1.2+)   3
short blunt (hammer)                                            1.5
small blade (kitchen knife, screwdriver)                        0.5
improvised (plank, crafted spear)                               1 less
value = (class * 10 + max damage, capped at 5) * (0.5 + 0.5 * condition)
```

A small blade is only taken when no weapon is carried. The class comes from the item script's `Categories`, read with `Item:containsWeaponCategory(WeaponCategory.X)` the way `XpUpdate.lua` does.

## Checked and unchecked

Every Java method the skills call was checked against the 42.21 jar with `node tools/pz-api.mjs`, and every vanilla Lua function against `media/lua`. The tests drive each skill with stub squares and a stub queue. What the real pathfinder, doors, windows and containers do is only checked in a live game.
