# Percept

One JSON line in `Zomboid/Lua/local_percept.txt`, written about once a second by `Sense.writePercept`. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Sense.lua`. Samples are in `bridge/fixtures/v2-*.json`.

```
v1 fields   what the current bridge reads, unchanged
v2 fields   added after err, for the next brain
```

The current brain sends only the v1 fields to the model (`V1_FIELDS` in `bridge/decide.mjs`). The v2 fields reach the bridge but not the prompt.

## v1 fields

| Field | Type | Meaning | Source |
|---|---|---|---|
| `dead` | bool | The survivor is dead. | `p:isDead()` |
| `x` `y` `z` | int | Tile position. | `p:getX()` `getY()` `getZ()` |
| `hour` | int | Hour of day, 0 to 23. | `getGameTime():getHour()` |
| `day` | int | Nights survived. | `getGameTime():getNightsSurvived()` |
| `outside` | bool | Standing outdoors. | `p:isOutside()` |
| `room` | string | Room name, or `outside`. | `p:getSquare():getRoom():getName()` |
| `hp` | number | Overall health, 0 to 100. | `getBodyDamage():getOverallBodyHealth()` |
| `hunger` `thirst` `fatigue` `endurance` | number | 0 to 1. 1 is the worst, except endurance where 1 is fresh. | `getStats():get(CharacterStat.X)` |
| `panic` | number | **0 to 100**, not 0 to 1. Kept raw because the current bridge reads it. Use `panic01`. | `CharacterStat.PANIC` |
| `zTotal` | int | Living zombies in the loaded cell. | `getCell():getZombieList()` |
| `zNear` | int | Living zombies within 30 tiles. | same |
| `zClose` | int | Living zombies within 10 tiles. | same |
| `zDist` | number | Distance to the nearest living zombie, -1 if none. | same |
| `zDir` | string | Compass direction to it (`N`, `SE`, `HERE`, `-`). | same |
| `zdx` `zdy` | int | Offset to it. +x is east, +y is south. | same |
| `foods` | int | Edible food in the main inventory (not in bags). Sealed cans do not count. | `Core.isEdible` |
| `waters` | int | Containers of clean water in the main inventory. | `Core.isWaterItem` |
| `bldgDir` `bldgDist` | string, int | Direction and Manhattan distance to the nearest building square within 20 tiles. `none` and -1 if none. Refreshed every 120 ticks. | `Sense.scanBuildings` |
| `weapon` | string | Melee weapon in the main hand, or `none`. | `p:getPrimaryHandItem()` |
| `items` | string | Names of the first 12 inventory items. | `getDisplayName()` |
| `qlen` | int | Timed actions queued. | `ISTimedActionQueue` |
| `reflexed` | bool | The reflex acted in the last 600 ticks. | `LocalSurvivor.reflexTick` |
| `lastSeq` | int | Last order seq the body ran. | `LocalSurvivor.lastSeq` |
| `err` | string | Last error, empty if none. | `LocalSurvivor.lastError` |

## v2 fields

| Field | Type | Meaning | Source |
|---|---|---|---|
| `v` | int | Percept version, 2. | |
| `panic01` | number | Panic on 0 to 1, so it matches the other stats. | `PANIC / 100` |
| `kills` | int | Zombies killed. | `p:getZombieKills()` |
| `hoursAlive` | number | In-game hours survived. | `p:getHoursSurvived()` |
| `moodle` | object | Moodle levels 0 to 4: `endurance tired panic pain heavy hungry thirsty`. 0 is none. | `p:getMoodles():getMoodleLevel(MoodleType.X)` with `ENDURANCE TIRED PANIC PAIN HEAVY_LOAD HUNGRY THIRST` |
| `weight` `maxWeight` | number | Carried weight and the capacity before heavy load. | `p:getInventoryWeight()` `p:getMaxWeight()` |
| `bag` | string | Worn back item name, or `none`. | `p:getClothingItem_Back()` |
| `weapons` | list | Up to 4 melee weapons carried, best damage first: `{n, dmg, cond, reach}`. `cond` is 0 to 1. | `getMaxDamage()` `getCondition()/getConditionMax()` `getMaxRange()` |
| `inv` | object | Supplies, see below. | |
| `wounds` | list | Injured body parts only, worst first, up to 8. | see below |
| `bleeding` | int | Body parts bleeding now. | `BodyPart:bleeding()` |
| `zChasing` | int | Living zombies within 40 tiles whose target is the survivor. | `IsoZombie:getTarget() == p` |
| `zVisible` | int | Zombies the survivor can see. The game's own count. | `getStats():getNumVisibleZombies()` |
| `zDowned` | int | Living zombies within 3 tiles that are on the floor or knocked down. A free stomp. | `isOnFloor()` `isKnockedDown()` |
| `zList` | list | The 6 nearest living zombies within 25 tiles: `{dx, dy, d, chase, down, crawl}`. | `getTarget()` `isOnFloor()` `isKnockedDown()` `isCrawling()` |
| `inBldg` | object or null | The building the survivor stands in: `{id, rooms, explored, water, room}`. | see below |
| `water` | object or null | Nearest clean water source in this building: `{x, y, z, d}`. | see below |
| `bed` | object or null | Nearest bed in this building: `{x, y, z, d}`. | see below |
| `buildings` | list | Up to 6 nearest buildings within 40 tiles. | see below |
| `dark` | bool | Night, or the square is darker than 0.43 (vanilla's too-dark-to-read line). | `getGameTime():isNight()` `square:getLightLevel(p:getPlayerNum())` |
| `res` | object | What the last order did: `{seq, verb, status, why}`. `status` is `idle`, `running`, `done` or `failed`. Each verb's reasons are in `docs/skills.md` and `docs/needs.md`. | `LocalSurvivor.result` |

Distances `d` are straight-line tiles. `dx` and `dy` are offsets, +x east and +y south. Object keys print in sorted order.

### inv

Counts everything carried, one level into bags. `foods` above does not.

| Key | Type | Meaning |
|---|---|---|
| `foodReady` | int | Food that can be eaten now. Vanilla's double-click test (`ISInventoryPane.lua`): `IsFood`, hunger change below 0, script item not `CantEat`, not burnt, not rotten, not dangerous uncooked, not poisoned, not a known poison. |
| `cans` | int | Sealed food with an opening recipe, like `TinnedBeans` (`CantEat = true`, `OpeningRecipe = OpenCannedFood`). |
| `canOpener` | bool | An item tagged `base:canopener`. Some cans also open with a knife; this does not check that. |
| `waterL` | number | Litres of clean water in containers. Tainted or poisonous containers do not count. `FluidContainer:getSpecificFluidAmount(Fluid.Water)`. |
| `emptyBottles` | int | Empty fluid containers that take input. |
| `bandages` | int | `isCanBandage()` items that are not tagged `base:canbewashed`. Bandages and ripped sheets count, dirty ones do not. |
| `disinfectant` | int | Vanilla's health panel rule: a fluid container over 0.15 L that is at least 40% alcohol, or a drainable with alcohol power 4 (alcohol wipes). |
| `painkillers` | int | `Base.Pills`. There is no tag for it. |
| `hammer` `saw` `screwdriver` | bool | Tags `base:hammer`, `base:saw`, `base:screwdriver`. |
| `lighter` | bool | Tag `base:startfire`, so matches count too. |

### wounds

Each entry has `part` (`BodyPartType.ToString`, like `Hand_L`) and only the flags that are true. A part is listed if any of the first seven is true.

| Flag | Source |
|---|---|
| `bleed` | `bleeding()` |
| `scratch` | `scratched()` |
| `lac` | `isCut()` (laceration) |
| `bite` | `bitten()` |
| `deep` | `deepWounded()` |
| `glass` | `haveGlass()` |
| `bandaged` | `bandaged()` |
| `dirty` | `isBandageDirty()` |

Worst first: bite, then bleeding, deep, glass, then cuts and scratches.

### Buildings, water and beds

A place scan runs in slices, one per tick, from `Sense.step` in the tick loop. It starts every 120 ticks, after the survivor moves 4 tiles, or when the building underfoot changes. A scan takes about 10 to 20 ticks.

```
list    getCell():getBuildingList()  (fallback: sample squares every 4 tiles)
defs    30 buildings a tick: BuildingDef bounds, residential, shop
rank    keep the 6 nearest within 40 tiles
doors   200 ground-floor squares a tick: IsoGridSquare:getIsoDoor(), IsoDoor:isExterior()
rooms   one room a tick of the current building: beds and water sources
publish copy into LocalSurvivor.seen
```

Facts that do not change (bounds, doors, beds) are kept by building id in `LocalSurvivor.bldgMemo`. Water amounts are read again on every scan.

- `id` is `BuildingDef:getIDString()`. `getID()` is a Java long, which Lua holds as a double.
- `inBldg.rooms` is `BuildingDef:getRoomsNumber()`. `explored` is `BuildingDef:isAllExplored()`: the game's flag that every room has had its loot spawned. It does not mean the survivor searched them. `water` is `IsoBuilding:hasWater()`. `room` is the room name, as in `room`.
- `water` takes objects from `IsoRoom:getWaterSources()` plus any room object where `hasWater()` is true at scan time. It is offered when `getFluidAmount() >= 1` (the same line vanilla uses for water menus) and not `isTaintedWater()`. Once the water shuts off, sinks drop out.
- `bed` is an object whose properties have `IsoFlagType.bed`, as vanilla checks in `ISWorldObjectContextMenu`. A double bed shows as two squares.
- `buildings` entries are `{id, dx, dy, d, res, shop, door, visited}`. `dx dy d` go to the nearest wall, so 0 means inside. `res` is `isResidential()`, `shop` is `isShop()`. `door` is the nearest exterior ground-floor door `{x, y}`, or null before the door search reaches it or when none was found. `visited` means the survivor has stood inside it this session. Alarm flags and container contents are left out on purpose: a player cannot see them.

## Size

About 1 KB normally. The worst case in `test/lua-percept.test.mjs` (8 wounds, 6 zombies, 6 buildings, 4 weapons, long names) is under 3.1 KB.

## Checked and unchecked

Every Java method above was checked against the 42.21 jar with `node tools/pz-api.mjs`, and enum names with `node tools/pz-consts.mjs`. What they return in a live game (for example whether `getBuildingList()` covers every loaded building, or whether `getWaterSources()` lists every sink) is not checked yet.
