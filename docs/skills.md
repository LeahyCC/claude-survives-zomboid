# Skills

What each order does, when it is done, and why it fails. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Act.lua` and `Move.lua`.

```
order line   SEQ|VERB|A|B|SAY|THOUGHT|GOAL|TARGET[|POSTURE]
result       res = {seq, verb, status, why, target} in the percept
status       running -> done | failed
```

Every order sets `running` when it starts. The verbs below then set `done` or `failed` with a short `why`. The older one-shot verbs (`EAT DRINK EQUIP CLOSEDOOR CONCEAL BREAKIN STOP WAIT`) stay `running` (`EQUIP` is `done` at once when the right weapon is already in hand), or `failed` with the old message like `eat: no food`.

`target` is what the order works on: the building id for ENTER, SEARCH and LOOT, `x,y` for GOTO. It is set when the order starts and kept on `done` or `failed` (`docs/percept.md`).

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
1  a locked door she has the key to
2  a door that is not locked
3  a window already open or broken
4  a shut window that is not locked
5  anything above with a zombie within 4 tiles of it
6  none left, or 4 quiet tries used: smash the nearest locked window
```

- Ways in are the building's exterior ground-floor doors (from the place scan) and windows (read from the footprint once).
- The order is strict (`Act.wayRank`). Distance only decides inside a rank, so she walks past a nearer window to a door. Before this a door had 2 tiles of credit and an open window had none: 19 doors, 55 windows and 5 smashes in the 2026-11-05 log (`docs/pro-rules.md`).
- Lock state is read from the door or window without walking there (`Act.wayFacts`). A locked or boarded way is marked tried and she does not go to it. A locked window stays a candidate for smashing. A square not loaded yet reads as closed and not locked, and is found out on arrival.
- At a door: an open door is walked through. A closed one is opened (`ISOpenCloseDoor`), then walked through. A locked door is unlocked first when he carries its key (see below). Any other locked or boarded door is skipped. Lock state is read again at the door, in case it changed.
- Keys: the test is the one vanilla makes in `ISLockDoor:isValid`, `getInventory():haveThisKeyId(door:checkKeyId())`. A door he holds the key to is tried before anything else, however far. At the door he queues `ISLockDoor:new(p, door, false)` (the vanilla unlock), then opens and walks in. If the door still does not let him in, the next way is tried.
- At a window: a smashed one has its glass cleared first (`ISRemoveBrokenGlass`), then climbed (`ISClimbThroughWindow`). If the game drops the clearing, she climbs anyway once `canClimbThrough` says she can, and there is no slower "careful" climb to ask for. A closed unlocked one is opened (`ISOpenCloseWindow`) and climbed. A locked one is noted for smashing.
- Opening, smashing, clearing glass and climbing all finish their action at once and do the work in the animation after it. So the climb is only queued once the game says the window can be climbed (`canClimbThrough`), and after a climb he gets `Act.ANIM_TICKS` (3 seconds) to land inside before the way counts as failed. A window that is still shut 3 seconds after the open is treated as locked and kept for smashing. Queuing open and climb together made the game drop the climb, so he opened windows he never used.
- He walks onto the exact square vanilla picks in front of the door or window (`AdjacentFreeTileFinder.FindWindowOrDoor`) before he works it (`Act.walkToSquare`). The climb is refused from the diagonal square, where opening still works. Before this, he opened windows he could not climb and ended up smashing one. SEARCH walks to a container's square the same way.
- Smashing (`ISSmashWindow`, then `ISRemoveBrokenGlass`, then the climb) happens only when no quiet way is left, or 4 quiet ways failed and a locked window is known.
- Done when the square under the survivor belongs to the building. `why` is `in by a door`, `in through a window`, `in through a smashed window (loud)` or `already inside`.
- Failed: `no target`, `unknown building` (not in the place scan's memory), `locked` (every way was locked or boarded), `unreachable`, `stuck`, `zombie`.

## SEARCH

No arguments. Searches the building the survivor stands in.

- Rooms nearest first, then containers in the room nearest first. Rooms on another floor count 4 tiles per floor.
- **With no good weapon the room order changes.** While the best weapon carried scores under 20 (`Act.HUNT_BELOW`, the same line as `WEAK_WEAPON` in `bridge/senses.mjs`), kitchens, garages, sheds and storage rooms come first, then closets, then everything else, and nearest first inside each group (`Act.weaponRoomRank`). The 42.21 loot tables are why: a kitchen rolls pans, saucepans, rolling pins and knives; a garage, shed or storage room rolls hammers, crowbars, planks and wrenches; a closet rolls bats and golf clubs; a bedroom or bathroom almost never rolls one. It is read again after every container, so the order goes back to the walk once a weapon scoring 20 or more is in the pack.
- Every container in the room is opened (`Act.roomContainers`). Three sources, each container kept once:
  - `IsoRoom:getContainer()`, the room's own list. It holds the first container of an object only, so a fridge's freezer or a stove's oven is missing from it.
  - Every container of every object on every square of the room (`getContainerCount`, `getContainerByIndex`), as the loot window reads them (`ISInventoryPage`). Counters, fridges, wardrobes, cupboards and crates all come in this way.
  - The floor of each square: the items lying there (`IsoGridSquare:getWorldObjects`), and the contents of a bag lying there. A floor container is a plain `ItemContainer.new("floor")` that holds those items, which is what the loot window builds and what `ISTransferAction` takes from. It is built again when she gets there, so what she has taken is gone. Items she dropped herself (DROP) are left out, or DROP and SEARCH would trade a spare weapon back and forth.
- The game rolls a container's loot the first time it is looked at, and only for squares next to the player. A container read before that is empty. So before it reads one, the skill does what `ISInventoryPage:checkExplored` does: `ItemPicker.fillContainer`, then `setExplored(true)`.
- Walks next to each container (`AdjacentFreeTileFinder.Find`) and takes what the loot table wants (below), inside the weight budget.
- **She stays in the house.** The pathfinder takes the shortest way, which can be out of one door and in by another. So a walk of more than 6 squares goes in legs along a way that stays on the building's own squares (`Move.insideRoute`, `Move.ROUTE_LEG`). A shut door counts as a way, a wall or a window does not, and stairs are not followed. With no inside way known she walks straight there and the next rule catches it.
- **A step outside stops the walk.** Every step of SEARCH checks she is still in the building. On the first square outside, the queue is cleared, that room's containers count as out of reach, and she walks back to the last square she stood on inside and shuts the door behind her. The room gets its one more try (`Act.ROOM_TRIES`) and is then done. So one step out is the most a walk can cost, not a way to prevent it. More than 4 tiles out, or more than 3 walks back in one SEARCH, it fails `not inside`.
- Items go into the worn back bag while it has room, otherwise the main inventory. A bag that is taken is worn (`ISWearClothing`), in place of a smaller one.
- A transfer that did not happen (the reflex clears the queue when it fights or flees) gets one more try.
- When the search took a weapon, the skill takes it up before it reports (see EQUIP below), unless the weapon in her hand is one Colin chose. It queues the equip, waits for it, and tries once more if the reflex cut it off. The `why` text stays `took 4: ...` because the bridge reads it. The percept's `weapon` and `weaponScore` show the result. A gun is never taken up.
- Finished rooms are kept in `LocalSurvivor.searched[buildingId][roomKey]`. The next SEARCH skips them. The percept shows how many are left as `inBldg.roomsLeft` (`Act.roomsLeft`).
- A container she could not reach (no free square beside it, or the walk failed) is skipped. The room is then not marked finished, so the next SEARCH tries it once more (`Act.ROOM_TRIES`, 2), and after that it counts as done so one blocked cupboard cannot keep a building open for ever.
- Done when every room is searched or the weight reaches the search line: 85% of `getMaxWeight()` with a back bag worn, 60% with none (`Act.searchLeft`). `why` is `took 4: Crowbar, Water Bottle, Beans, Bandage`, with ` (full)` when it stopped on weight, or `took nothing`.
- Failed: `not inside` (at the start, or carried out of the house, above), `nothing left` (every room was already searched), `full` (at the search line before starting), `zombie` (one within 8 tiles at the start, or the rule above), `stuck`.

A room that is not loaded is left for a later SEARCH.

What went wrong in the rich loot run (`tools/playtest.ps1 -RichLoot`): she took dye, perfume, ice cream and a plunger and left a pistol. The pistol had no row in the loot table at all (a gun is not a melee weapon, so it matched nothing). The dye and perfume matched the "any other drink" row, because every fluid container counted as a drink. And the plunger scored just over the weapon floor. The container walk itself was also thinner than it looked (the room list alone, loot rolled only for the 3 by 3 squares around her), which is fixed above. None of this was run in a live game yet.

## CLEAR

No arguments. Kills what is in the building she stands in. A job in `Needs.lua` (`docs/needs.md` has how a job runs and pauses). The house job sends it (`docs/brain.md`, "CLEAR").

```
walk     to a square next to the zombie, in legs of 6 along the inside way
         the square furthest behind it first (getForwardDirectionX, getForwardDirectionY)
reflex   from 2 tiles it swings, stomps and owns the fight. The job pauses
hit      next to it with the reflex standing aside, the job swings, or stomps one that is down
look     after every leg again, since an idle zombie wanders
done     nobody left in the building on her floor
```

- A square counts when it is inside the building, she can stand on it, and no wall or shut door is between it and the zombie (`Needs.clearSpots`). The first one with an inside way wins, so "from behind" holds only when there is a way round. No way is measured for length. A way that passes in front of it just starts the fight sooner, when the reflex takes over at 2 tiles.
- With two in the house she goes for a chaser first, then the nearest (`Needs.clearPick`). Once she is after one she stays with it.
- If the one she is after turns on her, she stops walking and the reflex has the fight. A fight is the point of this order, so the job's pause may last the whole of `CLEAR_MAX`, not the usual 20 seconds.
- Done: `cleared`, or `nobody inside` when there was nothing to go for.
- Failed: `another floor` (the only ones left are upstairs or below), `locked door` (every way goes through a locked or boarded door, and she does not unlock here, even with a key), `out of reach` (no inside way, or a wall on every side of it), `a second one woke` (anything but her target is after her, in the house, or within 15 tiles outside it), `no weapon` (it broke or left her hand), `not inside`, `stuck` (over 20 legs, or a walk that would not queue), `took too long` (a minute, `CLEAR_MAX`), `zombie` (a pause longer than that).

The game calls were checked against the 42.21 jar with `node tools/pz-api.mjs`: `IsoGameCharacter:getForwardDirectionX`, `getForwardDirectionY`, `IsoGridSquare:getDoorTo`, `isDoorTo`, `isBlockedTo`, `IsoDoor:isLocked`, `isLockedByKey`, `isBarricaded`, `IsOpen`. None of it has run in a live game. Check these first: whether the zombie stays idle for the walk (it may hear a shut door opened), whether `getForwardDirectionX` gives a real facing on an idle zombie, and how often a second one wakes.

## EQUIP

No arguments. Wields the best weapon he carries, one level into bags.

- Every melee weapon is scored (`Core.weaponScore`, see `docs/combat.md`). A pen, fork, spoon and a broken weapon score 0 and are never wielded.
- A swap needs a clear gain: the new weapon must score 25% more than the one in hand. Two close weapons never trade places as wear moves their scores.
- Empty hands or a pen in hand: any real weapon will do, the best one wins.
- A weapon in a bag is moved to the main inventory first, as vanilla's equip does, then `ISEquipWeaponAction` runs with both hands for a two-hander.
- Already holding the best: nothing is queued and the order is `done` with `already holding the best`.
- Failed: `equip: no weapon` (nothing carried scores above the floor).

A gun is a last resort, not a melee weapon, and EQUIP treats it so:

- A gun is never a candidate. `Core.isMeleeWeapon` leaves it out, so EQUIP never wields one, and a gun in the pack does not count as a weapon for `equip: no weapon`.
- A gun in her hand scores 0. EQUIP takes the best melee weapon up over it, and with no melee weapon it fails `equip: no weapon`. The bridge does not send this order for a gun in hand, because the reflex holsters a gun by itself and takes the melee weapon out (`docs/combat.md`, "Guns"). Only the reflex's fire rule ever draws one.

Her hands are filled without a brain turn (`Act.autoEquip`, from `Act.update`). Once a second, when her hands are empty or hold a pen, nothing is queued, no skill or need job is running, the reflex did not act this tick and she is awake, the best weapon she carries is queued, exactly as EQUIP would. It only fills empty hands: a swap for a better weapon stays with EQUIP and its 25% rule. A try is not repeated for 600 ticks (10 seconds), so an equip that never lands is not retried every second. A weapon Colin picked is left alone for the same reasons as below, and a pick that is out of her hand (she ate) is put back. A gun in hand is the reflex's to holster, not this rule's.

The weapon Colin put there himself is never swapped away (`Act.watchHand`, every tick and whenever the percept is built):

```
hand changes, the mod queued nothing   ->  Colin's pick, locked
hand changes to what EQUIP queued      ->  the mod's own, no lock
a gun in hand                          ->  no lock: the reflex holsters it, even one he put there
```

- Only a melee weapon over the score floor can be a pick. A gun drawn over a pick does not end it: holstering puts the pick back. Food, a bottle or a bandage in her hand while she eats or drinks is not a pick, and does not end one.
- The lock ends when the item breaks, leaves the pack (checked every 30 ticks while it is out of her hand), Colin puts another weapon in her hand, or the character dies (a new player object starts a fresh watch, and its first look only sets the baseline).
- While it is locked, EQUIP and the weapon step of SEARCH do nothing if it is in her hand. If it is out of her hand (she ate, she drank) EQUIP puts it back, not the best weapon.
- The percept shows it as `weaponByHand` and the HUD line says `(your pick)`.
- The mod marks its own equips with `Act.markModEquip` for 1800 ticks, so a slow equip animation is not taken for a pick.

## DROP

No arguments. Sheds weight until he is under the same line SEARCH stops at (`Act.searchLeft`: 85% of `getMaxWeight()` with a back bag, 60% with none). It used to shed only to 85%, so with no bag she could sit between the two lines, too full to search and not heavy enough to drop.

- Takes the least valuable items first, the heaviest first among equals. Junk goes before anything useful: a pen, spare clothes, toys, weights, food he cannot eat.
- After junk come tools, then a spare weapon, then sealed food, then empty bottles. Guns and ammo go last of all. DROP has its own scale (`keep` in `Act.LOOT`), not the loot value.
- Never dropped: the weapon in hand, the best weapon he carries, clothes he wears, any bag, water, food he can eat now, bandages and ripped sheets.
- Everything dropped is remembered (`Act.noteDropped`), so a later SEARCH does not pick it up from the floor again.
- Each item goes through the game's own drop (`ISInventoryPaneContextMenu.dropItem`). A held item is unequipped first. One in a bag comes out of the bag.
- It plans up to 3 passes, reading the weight again after each, because a bag softens the weight of what is inside. A pass that dropped nothing ends the skill.
- Done: `dropped 2: Dumb Bell, Spiffo`, with ` (still heavy)` when nothing more could go.
- Failed: `not heavy` (already under the line), `nothing to drop` (everything left is on the never list, or the game refused the drop).

## LOOT

No arguments. Kept for the v1 brain.

- Searches the room the survivor is in, with the same container walk and the same loot value. No junk pass.
- Outside, or in a room with no containers: the nearest container within 10 tiles, and the room it is in.
- Always looks again, even in a room a SEARCH finished. It marks the room searched too.
- Done and failed as SEARCH. With nothing in reach it fails `nothing left`, so `err` starts with `loot` and the bridge does not loot there again.

## Loot table

Every item gets one loot value, and SEARCH and LOOT take the highest first. The value is pure: plain item facts in, a number out (`Core.lootKinds(item, carried)` lists every way the item is worth taking, best first, and `Core.lootValue` is the best of them, 0 for junk). Which of them she may still take is a game rule and lives in `Act`: how many of a kind (`max` in `Act.LOOT`, counting what she carries, one level into bags), how much weight is left, and how much each kilo is worth. The take or leave step is the pure `Act.lootPick(desc, have)` and `Act.planTake(descs, have, budget, total)`. Tests: `test/lua-loot.test.mjs` and `test/lua-search.test.mjs`.

The order, best first:

```
bag          none worn, or one with 1.5 times the room of the worn one
melee        a weapon that scores 25% over the best carried and over 8
firearm      a gun, with the ammo for it: loose rounds, a magazine or a box of the right calibre
medical      bandages, disinfectant, antibiotics, painkillers, splints, ripped sheets
water        a litre of clean water, then an empty bottle, then another drink
food         food that keeps: dry, canned (with a can opener in mind)
fresh food   only when she is hungry now, or will be within the day
tools        can opener (above the rest), hammer, saw, screwdriver, lighter, flashlight, batteries
junk         worth nothing: dye, perfume, plungers, decorations, clothes, anything with no use
```

| Kind | Value | Max | Test |
|---|---|---|---|
| bag | 100 | 2 | `IsInventoryContainer`, `canBeEquipped` is `ItemBodyLocation.BACK`. The one worn counts, so a bigger one can still come |
| weapon | 90 and up | | over the loot floor (8, below) and 25% over the best carried: `Core.weaponScore` |
| gun | 86 with ammo, 56 without | 2 | `Core.isGun` (ranged or aimed firearm). With ammo means the ammo is carried, in the same container, or the gun is loaded |
| ammo, mag, box | 84, 84, 80 | 60 rounds, 3, 2 | rounds are tag `AMMO`, a magazine has an ammo type and a capacity, a box is the display category Ammo. Only for a gun she has or is taking |
| bandage | 78 | 6 | `isCanBandage`, not tag `CAN_BE_WASHED` |
| disinfectant | 76 | 2 | 40% alcohol over 0.15 L, or alcohol power 4 |
| antibiotic | 74 | 2 | `Base.Antibiotics` |
| painkiller | 72 | 2 | `Base.Pills` |
| splint | 70 | 2 | `Base.Splint` |
| water | 68 | 4 | `FluidContainer`, `Fluid.Water`, not tainted or poisonous |
| sheet | 64 | 6 | `Base.RippedSheets` |
| food | 60 | 12 | `Core.isEdible`, and it keeps: no shelf figure, or 14 days or more to go, and not frozen |
| can | 58 | 12 | `Core.isSealedFood` |
| opener | 58 | 1 | tag `CAN_OPENER` |
| bottle | 56 | 2 | `isEmpty`, not `isInputLocked`, a capacity from 0.5 to 2 L (a 0.1 L perfume flask is not a bottle) |
| fresh | 52 hungry now, 36 hungry within the day | 3 | edible but spoils soon (under 14 days to rot, or frozen). Hunger 0.25 or more; or 0.1 or more with a day or more left and under 3 food carried. Frozen food is only taken when hungry now |
| drink | 50 | 2 | a fluid in the Beverage category (`FluidCategory.Beverage`). Dye, perfume and fuel are fluids but not drinks |
| hammer, saw, screwdriver | 46, 45, 44 | 1 | tags `HAMMER` `SAW` `SCREWDRIVER` |
| lighter | 43 | 1 | tag `START_FIRE` |
| flashlight | 42 | 1 | tag `FLASHLIGHT` |
| battery | 40 | 2 | `Base.Battery` |

Clothes (`IsClothing`), broken items and anything that matches no kind are left. Hunger is read once at the start of the search.

How long food keeps is read from the item: `getOffAgeMax` (the days until it is totally rotten) minus `getAge`. A figure in the millions means it does not spoil. Frozen food counts as spoiling soon, since it melts when it leaves the freezer.

**Weapons.** A pen, pencil, fork or spoon is never taken. A weapon must score at least 8 (`Core.LOOT.WEAPON_MIN`) to be worth carrying, a little over the score floor of 5 that makes it a weapon for the reflex. A kitchen knife (9) and a saucepan (9 to 12) pass. A plunger (6) does not. With no real weapon in the pack (best carried under 5) the bar drops to 6.5 (`Core.LOOT.WEAPON_MIN_BARE`): a pan, rolling pin or kitchen knife scores about 9 new and falls under 8 at about 90% condition, so the normal bar left worn ones behind while she had bare hands. A plunger (6.3) and a screwdriver (6.1) are still left. A better weapon than the best carried is always taken ahead of everything else the room holds, if it fits. The weapon kind sorts by score, so an axe beats a crowbar when both are in the box. A second weapon that is no clear gain is left behind.

**Guns.** A pistol is taken whether or not ammo is known, since ammo is often in another room. With ammo it ranks above medicine, without it just under food that keeps. When a gun and its rounds lie in one container, the gun makes the rounds worth taking in the same stop. Rounds for a gun she does not have are left.

**Weight.** The weight budget is 85% of the carry limit with a back bag worn and 60% with none, so with no bag she stops well before she is overloaded (`Act.searchLeft`). Inside the budget a pick has to be worth its weight (`Core.lootWorth`): the bar is value per kilo, and it rises as the budget drains. An empty pack takes anything with a value. At 25% of the room left the bar is 34 per kilo: a litre of water (68) and a bandage pass, a 3 kg saw (15) stays.

The class comes from the item script's `Categories`, read with `Item:containsWeaponCategory(WeaponCategory.X)` the way `XpUpdate.lua` does.

## Checked and unchecked

Every Java method the skills call was checked against the 42.21 jar with `node tools/pz-api.mjs`, and every vanilla Lua function against `media/lua`. The tests drive each skill with stub squares and a stub queue. What the real pathfinder, doors, windows and containers do is only checked in a live game.

The loot value and the container walk use these, all found in the 42.21 jar with `node tools/pz-api.mjs`: `HandWeapon:isRanged`, `isAimedFirearm`, `getMagazineType`, `getAmmoBox`, `isContainsClip`, `isRoundChambered`; `InventoryItem:getAmmoType` (then `AmmoType:getItemKey`), `getCurrentAmmoCount`, `getMaxAmmo`, `getCount`, `getDisplayCategory`, `getOffAgeMax`, `getAge`; `Food:isFrozen`; `FluidContainer:isCategory` with `FluidCategory.Beverage`; `IsoObject:getContainerCount`, `getContainerByIndex`; `IsoGridSquare:getWorldObjects`; `IsoWorldInventoryObject:getItem`; `ItemContainer:isExplored`, `setExplored`, `AddItem`; `ItemPickerJava.fillContainer` (the Lua global `ItemPicker` is set to it in `server/Items/ItemPicker.lua`). None of it has run in a live game. The checks that matter most: that the floor container takes an item off the ground through `ISInventoryTransferAction`, that `ItemPicker.fillContainer` on a container she stands next to rolls the same loot the loot window would, that `getOffAgeMax` is in days, and that wearing a bigger bag over a smaller one works.

The weapon score, EQUIP and DROP use vanilla Lua that was read but not run live: `ISInventoryPaneContextMenu.dropItem(item, playerNum)`, `transferIfNeeded(player, item)`, and `ISEquipWeaponAction:new(player, item, time, primary, twoHands)`. The Java methods were checked with `node tools/pz-api.mjs`: `getCriticalChance`, `getSwingTime`, `getMaxDamage`, `getMaxRange`, `isTwoHandWeapon`, `isHandItem`, `isWorn`, `isEquippedClothing`. Whether a drop from inside a worn bag behaves in game is only checked live.
