# Needs

The verbs that keep the survivor alive between fights: water, food, sleep, wounds, a bag, a shut house and a rest. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Needs.lua`. Tests are in `test/lua-needs.test.mjs`.

## How a job runs

A verb starts a job. The job is a small state machine on `LocalSurvivor.needsJob`.

```
order line   ->  verb  ->  Needs.start   first step runs at once
every 5 ticks    onTick  ->  Needs.update(p, acted)
a step           read the world again
                 queue one vanilla action, wait for the queue to empty
                 or finish: done / failed
```

- Each step reads the world fresh. A paused job picks up where it is, not where it was.
- The result record goes `running`, then `done` or `failed` with a short `why`. The percept carries it as `res`.
- A new order with a different verb drops the job. The same verb again, as when the bridge repeats an order, keeps the job and takes the new seq.
- The vanilla menu handlers do the walking. A handler that finds no way there queues nothing, and the step reads that as a failure.

### Yielding to the reflex

- When the reflex acted on this tick, the job pauses. It does not touch the queue. The reflex owns it.
- It goes on once the reflex has been quiet for 30 ticks.
- An action the reflex may have cut off (its queue was empty when the job went on) is not counted. The step does it again. An action still queued after the pause counts when it ends.
- A pause longer than 1200 ticks fails the job with `zombie`.
- A job with no update for 600 ticks (manual mode) fails with `interrupted`.

`Reflex.releaseDoor` only acts on a stuck walk, so eating, bandaging and sleeping in place are never cut off by it.

### Shared fails

| why | when |
|---|---|
| `zombie` | paused by the reflex for too long |
| `interrupted` | no update for 600 ticks |
| `stuck` | the job queued more than 80 actions |
| `error: ...` | a step threw |

An action still queued after 1500 ticks is cut off and the step runs again.

## Verbs

None of the verbs read `A`, `B` or `TARGET` yet.

### DRINK

1. A carried bottle with clean water (bags too): drink with `ISDrinkFluidAction`. The amount is vanilla's thirst x 2 litres, rounded up to a quarter, half or all of the bottle. A face mask comes off first and goes back on after (`getEatingMask`).
2. No bottle: the nearest clean water source in this building, through `ISWorldObjectContextMenu.onDrink`. It walks there, takes the mask off and drinks with `ISTakeWaterAction`.

Sources come from the place scan (`bldgMemo[id].waterObjs`). Before the scan reaches the building, squares within 8 tiles in the same building are read. A source needs 1 unit or more and `isTaintedWater()` false. Tainted water is never used.

| status | why |
|---|---|
| done | `drank from <bottle>` or `drank from the tap` |
| failed | `no water`, `cannot reach water` |

### FILL

Fills every carried fluid container that is empty or holds only water and is not full, at the nearest clean source, through `ISWorldObjectContextMenu.onTakeWater`. It goes again while bottles are not full, up to 3 rounds.

| status | why |
|---|---|
| done | `filled N`, or `filled N, source dry` |
| failed | `no empty bottle`, `no water`, `cannot reach water` |

### EAT

The choice is `Needs.chooseFood`:

1. Ready food (`Core.isEdible`). Perishable before packaged, the one with the fewest days left first. Frozen last.
2. Only when nothing is ready: a sealed can whose opening recipe the game would allow now. The test is vanilla's own: `HandcraftLogic` with `canPerformCurrentRecipe()`.

It eats through `ISInventoryPaneContextMenu.eatItem`, which takes a mask off, moves the food out of a bag, and runs the opening recipe for a can. If vanilla queues nothing for an item, the next one is tried, up to 5.

| status | why |
|---|---|
| done | `ate <food>`, `opened and ate <food>` |
| failed | `no food`, `need can opener`, `too full` (moodle FOOD_EATEN 3 or more), `cannot eat` |

`need can opener` also covers a can that only opens with a knife: the can's own recipe is the one checked.

### SLEEP

1. Checks: fatigue over 0.3, more than an hour since the last sleep, no panic, no pain at level 2 or more (unless fatigue is over 0.85). These are vanilla's lines.
2. Walk next to the nearest bed in the building. Beds come from the place scan, or the current room. No bed, or no way to it: the floor.
3. Close the doors, windows and curtains of the room, lock its exterior doors if `needsOpts.lock` is on, and turn its lights off (the SECURE sweep, room only).
4. Walk back to the bed if the sweep moved him.
5. `ISWorldObjectContextMenu.onSleepWalkToComplete(playerIndex, bed)`. It runs vanilla's checks and sets the wake time.

| status | why |
|---|---|
| done | `asleep`, `asleep in bed`, `asleep on the floor` |
| failed | `not tired`, `too soon`, `unsafe: zombies`, `unsafe: panic`, `unsafe: pain`, `unsafe` |

### BANDAGE

One step per wound, worst first: bleeding, deep wound, bite, laceration, scratch, then glass alone (`Needs.worstWound`). A clean bandage over a wound is done. A dirty one is not.

For that wound (`Needs.treatStep`):

```
glass in it            remove it (ISRemoveGlass). Tweezers if carried, else by hand
dirty bandage          take it off if a clean one is carried, else leave it
not disinfected        disinfect if disinfectant is carried (ISDisinfect)
then                   the best bandage (ISApplyBandage)
no bandage             rip cotton clothing that is not worn, or a sheet, then bandage
```

- The best bandage is the highest `getBandagePower()` that is not tagged `base:canbewashed`. On a tie, an alcohol one.
- Disinfectant is vanilla's health panel rule (see `docs/percept.md`, inv). A part counts as disinfected when `getAlcoholLevel() > 0`.
- Ripping uses the craft recipes `RipClothing` (tag `base:ripclothingcotton`, not worn) and `RipSheets` (tag `base:sheet`), through `ISInventoryPaneContextMenu.OnNewCraft`. Only when the recipe check passes.
- The game lets glass come out by hand, with more pain. So it does, and says so.
- A step that does not change the wound twice is given up on that part.

| status | why |
|---|---|
| done | `treated N`, plus notes like `glass out by hand`; or `no wounds` |
| failed | `no bandage` (plus `treated N` if some were done) |

Deep wounds still need stitches. That is not done here.

### WEARBAG

Wears the best carried bag on the back through `ISInventoryPaneContextMenu.wearItem` (`ISWearClothing`). A back bag is an `InventoryContainer` whose `canBeEquipped()` is `ItemBodyLocation.BACK`. Best is `getCapacity()`, then `getWeightReduction()`. It must beat the bag already worn.

| status | why |
|---|---|
| done | `wearing <bag>`, `already wearing <bag>` |
| failed | `no bag`, `could not wear it` |

### SECURE

A sweep of the building: every room on his floor, or only the current room when the floor has more than 10 rooms. The squares one east and one south of each room square are read too, because a wall sits on the north or west edge of a square.

What it does, nearest first, a door before a window or curtain before a light (`Needs.pickTarget`):

| target | action |
|---|---|
| open door | close (`onOpenCloseDoor`) |
| door with an open curtain | close the curtain |
| closed exterior door | lock (`onLockDoor`) when his key fits or he stands indoors, as `ISLockDoor:isValid` checks |
| open window, not smashed or barricaded | close (`onOpenCloseWindow`) |
| open curtain | close (`onOpenCloseCurtain`) |
| light switch on | off (`onToggleLight`) |

A target that will not change after two tries, or that no walk reaches, counts as out of reach. Locking is off by default (`LocalSurvivor.needsOpts.lock = false`): zombies cannot open doors, and the pathfinder may not walk back out through a locked one. Set it to `true` to lock.

| status | why |
|---|---|
| done | what it did, like `closed 2 doors, 3 curtains; locked 1 door; 2 lights off; 1 out of reach`, or `nothing open` |
| failed | `not inside` |

### REST

Sits on the ground (`ISSitOnGround`) and waits.

| status | why |
|---|---|
| done | `rested` (endurance 0.8 or more), `zombie` (one started chasing), `rested a while` (7200 ticks) |
| failed | `not tired` (endurance already 0.8 or more), `zombie` (one is chasing at the start), `cannot sit` |

A chaser is `getNumChasingZombies() > 0`, or a living zombie within 20 tiles whose target is him.

## Pure functions

Tested with plain tables: `worstWound`, `treatStep`, `bestBandage`, `chooseFood`, `bestBag`, `pickTarget`, `secureSummary`, `drinkPercent`, `restCheck`.

## Checked and unchecked

Every Java method was checked against the 42.21 jar with `node tools/pz-api.mjs`, and enum names with `node tools/pz-consts.mjs`. The vanilla Lua handlers were read in the 42.21 install. What the queued actions do in a live game is not checked yet.
