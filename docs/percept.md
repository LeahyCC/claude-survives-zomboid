# Percept

One JSON line in `Zomboid/Lua/local_percept.txt`, written about once a second by `Sense.writePercept`. Code is the truth: `mods/LocalSurvivor/42/media/lua/client/LocalSurvivor/Sense.lua`. Samples are in `bridge/fixtures/v2-*.json`.

```
v1 fields   what the v1 brain (old mods) reads, unchanged
v2 fields   added after err, read by the v2 brain
```

The v2 brain (`docs/brain.md`) reads every field and gives the model a short digest, not the JSON. A percept without `v` gets the v1 brain, which sends only the v1 fields (`V1_FIELDS` in `bridge/decide.mjs`).

## v1 fields

| Field | Type | Meaning | Source |
|---|---|---|---|
| `dead` | bool | The survivor is dead. The dead percept also carries `death`, see "The death record". | `p:isDead()` |
| `x` `y` `z` | int | Tile position. | `p:getX()` `getY()` `getZ()` |
| `hour` | int | Hour of day, 0 to 23. | `getGameTime():getHour()` |
| `day` | int | Nights survived. | `getGameTime():getNightsSurvived()` |
| `outside` | bool | Standing outdoors. | `p:isOutside()` |
| `room` | string | Room name, or `outside`. | `p:getSquare():getRoom():getName()` |
| `hp` | number | Overall health, 0 to 100. | `getBodyDamage():getOverallBodyHealth()` |
| `hunger` `thirst` `fatigue` `endurance` | number | 0 to 1. 1 is the worst, except endurance where 1 is fresh. | `getStats():get(CharacterStat.X)` |
| `panic` | number | **0 to 100**, not 0 to 1. Kept raw because the v1 brain reads it. Use `panic01`. | `CharacterStat.PANIC` |
| `zTotal` | int | Living zombies in the loaded cell. | `getCell():getZombieList()` |
| `zNear` | int | Living zombies within 30 tiles. | same |
| `zClose` | int | Living zombies within 10 tiles. | same |
| `zDist` | number | Distance to the nearest living zombie, -1 if none. | same |
| `zDir` | string | Compass direction to it (`N`, `SE`, `HERE`, `-`). | same |
| `zdx` `zdy` | int | Offset to it. +x is east, +y is south. | same |
| `foods` | int | Edible food in the main inventory (not in bags). Sealed cans do not count. | `Core.isEdible` |
| `waters` | int | Containers holding at least 0.05 L of clean water in the main inventory. | `Core.isWaterItem` |
| `bldgDir` `bldgDist` | string, int | Direction and Manhattan distance to the nearest building square within 20 tiles. `none` and -1 if none. Refreshed every 120 ticks. | `Sense.scanBuildings` |
| `weapon` | string | Melee weapon in the main hand, or `none`. A pen, fork or broken weapon reads `none`: it is not a weapon. A gun reads `none` too, and is named in `heldGun`. | `p:getPrimaryHandItem()` |
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
| `asleep` | bool | The survivor is asleep, by the game's own state. | `p:isAsleep()` |
| `speed` | int | The game speed button: 0 paused, 1 normal, 2 to 4 fast forward. Night fast forward runs at 3. | `getGameSpeed()` |
| `kills` | int | Zombies killed. | `p:getZombieKills()` |
| `hoursAlive` | number | In-game hours survived. | `p:getHoursSurvived()` |
| `moodle` | object | Moodle levels 0 to 4: `endurance tired panic pain heavy hungry thirsty`. 0 is none. | `p:getMoodles():getMoodleLevel(MoodleType.X)` with `ENDURANCE TIRED PANIC PAIN HEAVY_LOAD HUNGRY THIRST` |
| `weight` `maxWeight` | number | Carried weight and the capacity before heavy load. | `p:getInventoryWeight()` `p:getMaxWeight()` |
| `bag` | string | Worn back item name, or `none`. | `p:getClothingItem_Back()` |
| `weapons` | list | Up to 4 melee weapons carried, best score first: `{n, dmg, cond, reach, score}`. `cond` is 0 to 1. Anything that scores under 5 (a pen, a fork, a broken bat) is left out. | `Core.weaponFacts`: `getMaxDamage()` `getCondition()/getConditionMax()` `getMaxRange()` |
| `weaponScore` | number | The score of the weapon in hand, 0 when `weapon` is `none`. Compare it with the `score` of the `weapons` entries: a carried weapon at 25% over it is worth swapping to. | `Core.weaponScore` |
| `guns` | list | Up to 2 firearms carried, one level into bags, the held one first, then the best supplied: `{n, ammo, loaded, held}`. `ammo` is the rounds carried for it outside the gun (loose rounds of its calibre plus rounds in spare magazines), `loaded` the rounds in it (magazine plus one chambered), `held` is true for the one in hand. A broken gun is left out. An empty list when none. | `Core.gunFacts`, `Core.ammoFacts`: `getAmmoType():getItemKey()` `getMagazineType()` `getCurrentAmmoCount()` `isRoundChambered()` |
| `heldGun` | string | The firearm in the main hand, or `none`. `weapon` reads `none` for a gun: it is not the melee weapon, the reflex cannot fire it. A bridge must read `heldGun` too before it decides she is unarmed. | `Core.isGun(p:getPrimaryHandItem())` |
| `weaponByHand` | bool | The weapon in her main hand is one the player put there himself, or a gun. The mod does not swap it away (`docs/skills.md`, EQUIP), so the bridge must not offer to. False when the mod equipped it, and when the hands are empty. | `Act.handChosen` |
| `inv` | object | Supplies, see below. | |
| `wounds` | list | Injured body parts only, worst first, up to 8. | see below |
| `bleeding` | int | Body parts bleeding now. | `BodyPart:bleeding()` |
| `zChasing` | int | Living zombies within 40 tiles whose target is the survivor. | `IsoZombie:getTarget() == p` |
| `zVisible` | int | Zombies the survivor can see. The game's own count. | `getStats():getNumVisibleZombies()` |
| `zDowned` | int | Living zombies within 3 tiles that are on the floor or knocked down. A free stomp. | `isOnFloor()` `isKnockedDown()` |
| `zList` | list | The 6 nearest living zombies within 25 tiles: `{dx, dy, d, chase, down, crawl}`. | `getTarget()` `isOnFloor()` `isKnockedDown()` `isCrawling()` |
| `inBldg` | object or null | The building the survivor stands in: `{id, rooms, roomsLeft, explored, water, room}`. | see below |
| `water` | object or null | Nearest clean water source in this building: `{x, y, z, d}`. | see below |
| `bed` | object or null | Nearest bed in this building: `{x, y, z, d}`. | see below |
| `buildings` | list | Up to 6 nearest buildings within 40 tiles. | see below |
| `dark` | bool | Night, or the square is darker than 0.43 (vanilla's too-dark-to-read line). | `getGameTime():isNight()` `square:getLightLevel(p:getPlayerNum())` |
| `reflex` | object | What the reflex has been doing, see below. | `ReflexLog.summary` |
| `res` | object | What the last order did: `{seq, verb, status, why, target}`. `status` is `idle`, `running`, `done` or `failed`. `target` is what the job works on, or `""` when there is none (see below). Each verb's reasons are in `docs/skills.md` and `docs/needs.md`. | `LocalSurvivor.result` |

Distances `d` are straight-line tiles. `dx` and `dy` are offsets, +x east and +y south. Object keys print in sorted order.

### reflex

A summary of the reflex log (`docs/combat.md`). The full calls and outcomes are in `Zomboid/Lua/local_reflex.txt`.

| Key | Type | Meaning |
|---|---|---|
| `stance` | string | The last stance taken: `FIGHT HOLD SHOVE BREAK HIDE SNEAK CLIMB FLEE`, or `NONE` before the first. |
| `why` | string | The reason it was first taken, like `pack`, `winded` or `door`. Empty for a plain fight. |
| `age` | int | Seconds since the reflex last took a stance, -1 if never. |
| `calls` | int | Stances taken this session. |
| `outcomes` | int | Of those, how many have had their 5 second outcome. |
| `escapes` | int | Outcomes where nothing chased her within 10 tiles and nothing stood within 3. |
| `hits60` | int | Hits taken in the last minute: body health drops over 0.2 in one tick. |
| `level` | int | The threat level of the last decision, 0 to 4. |
| `posture` | string | The fight posture from the last order: `normal`, `avoid` or `clear`. |
| `fails` | int | Escape tries in a row that ended with a chaser still there. Cleared after 3 seconds with nothing chasing. |
| `stuck` | bool | An escape loop hit its limit and the reflex has no way out of its own. The bridge hands the brain a turn while this is true (`docs/brain.md`, "When the hold ends"). |

### inv

Counts everything carried, one level into bags. `foods` above does not.

| Key | Type | Meaning |
|---|---|---|
| `foodReady` | int | Food that can be eaten now. Vanilla's double-click test (`ISInventoryPane.lua`): `IsFood`, hunger change below 0, script item not `CantEat`, not burnt, not rotten, not dangerous uncooked, not poisoned, not a known poison. |
| `cans` | int | Sealed food with an opening recipe, like `TinnedBeans` (`CantEat = true`, `OpeningRecipe = OpenCannedFood`). |
| `canOpener` | bool | An item tagged `base:canopener`. Some cans also open with a knife; this does not check that. |
| `waterL` | number | Litres of clean water in containers. Tainted or poisonous containers do not count. `FluidContainer:getSpecificFluidAmount(Fluid.Water)`. |
| `emptyBottles` | int | Empty fluid containers that take input. |
| `canRip` | bool | BANDAGE could rip a bandage from what he carries: a sheet, or cotton clothing that is not worn, with the craft recipe the game allows now. The same check as `kit.rip` in `Needs.medKit` (`Needs.ripSource`). Only asked when `bandages` is 0, otherwise false, as `medKit` does. Kept for 300 ticks because the recipe check is slow. BANDAGE with no bandage and `canRip` false fails `no bandage`. |
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

### res.target

Set when the order starts, kept when it ends `done` or `failed`, cleared by the next order. The same verb again keeps the job and puts its target back under the new seq. A brain that restarts mid-job reads it from here.

| Verb | `target` |
|---|---|
| `ENTER` | building id |
| `GOTO` | `x,y` in whole tiles |
| `SEARCH`, `LOOT` | building id of the place searched, empty for a loose container |
| `SECURE` | building id |
| `DRINK` | the bottle name, or `water x,y` for a tap |
| `FILL` | `water x,y` |
| `EAT` | the food name |
| `SLEEP` | `bed x,y`, or `floor` |
| `BANDAGE` | the body part being treated, like `Hand_L` |
| `WEARBAG` | the bag name |
| others | `""` |

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
- `inBldg.rooms` is `BuildingDef:getRoomsNumber()`. `explored` is `BuildingDef:isAllExplored()`: the game's flag that every room has had its loot spawned. It does not mean the survivor searched them. `water` is `IsoBuilding:hasWater()`. `room` is the room name, as in `room`. `roomsLeft` is how many of the building's rooms SEARCH has not finished: the rooms of `BuildingDef:getRooms()` that are not in `LocalSurvivor.searched[id]` (`Act.roomsLeft`). It equals `rooms` before any SEARCH and is 0 when every room is done. A room that was not loaded when SEARCH came by stays counted.
- `water` takes objects from `IsoRoom:getWaterSources()` plus any room object where `hasWater()` is true at scan time. It is offered when `getFluidAmount() >= 1` (the same line vanilla uses for water menus) and not `isTaintedWater()`. Once the water shuts off, sinks drop out.
- `bed` is an object whose properties have `IsoFlagType.bed`, as vanilla checks in `ISWorldObjectContextMenu`. A double bed shows as two squares.
- `buildings` entries are `{id, dx, dy, d, res, shop, door, visited}`. `dx dy d` go to the nearest wall, so 0 means inside. `res` is `isResidential()`, `shop` is `isShop()`. `door` is the nearest exterior ground-floor door `{x, y}`, or null before the door search reaches it or when none was found. `visited` means the survivor has stood inside it this session. Alarm flags and container contents are left out on purpose: a player cannot see them.

## The death record

The old dead percept carried only the vitals of a dead body, and often the bridge never saw it: the next character wrote over it first. The real runs saved so far all ended as `unknown` for that reason. `Death.lua` now keeps the last 10 seconds and writes them out when player 0 dies.

```
once a second   Sense.writePercept -> Death.sample -> ring of the last 10 samples (in memory)
on death        OnPlayerDeath, or the tick loop's dead check, whichever comes first
                  Death.onDeath: one last sample taken now, record built from the ring
                  -> Zomboid/Lua/local_death.txt   the record, kept until the next death
                  -> one final percept with dead: true and "death"
new character   a living player 0 more than 5 seconds after the death clears the ring
```

The bridge relies on `local_death.txt`, because the next character does not overwrite it. The copy in the percept is for a bridge that is watching.

Record (`death`):

| Field | Meaning |
|---|---|
| `id` | `getTimestampMs()` when she died, as a string. The bridge applies each id once. |
| `day` `hours` `kills` | `getNightsSurvived()`, `getHoursSurvived()`, `getZombieKills()`. |
| `x` `y` `z` | Where. |
| `text` | The game's own death line, `GameTime:getDeathString(p)`. A hint only. |
| `ring` | Up to 10 samples, oldest first, one a second. |
| `final` | One more sample, taken in the death handler. A key is missing when the game would not answer for a dead body. |

Sample. Every key is optional: a read that fails leaves its key out, and the bridge treats a missing key as not known.

| Key | Meaning | Source |
|---|---|---|
| `hp` | Overall health. | `getOverallBodyHealth()` |
| `bleeding` `wounds` | Parts bleeding, and parts hurt. | `Sense.bodyFacts` |
| `bite` `scratch` | Any bitten or scratched part. | same |
| `infected` | The zombie infection flag. | `BodyDamage:IsInfected()` |
| `infect` | Infection progress. Scale not checked. | `CharacterStat.ZOMBIE_INFECTION` |
| `hunger` `thirst` | 0 to 1, 1 is worst. | `CharacterStat` |
| `sick` `foodSick` `poison` `temp` | Sickness, food sickness, poison, body temperature. Kept in the record. Their scales are not checked, so the bridge does not guess a cause from them yet. | `CharacterStat.SICKNESS` `FOOD_SICKNESS` `POISON` `TEMPERATURE` |
| `zClose` | Living zombies within 10 tiles. | `Sense.zombieScan` |
| `zAdj` | Zombies within 3 tiles, among the nearest 6. | `Sense.zombieFacts` |
| `zChasing` | Zombies after her. | same |
| `nearest` | Distance to the nearest zombie. | same |
| `inside` | Under a roof. | `not isOutside()` |
| `z` | Floor. | `getZ()` |
| `job` | The running skill or need job, `LS.skill.verb` or `LS.needsJob.verb`. | |
| `order` `status` | The last order and its state. | `LS.result` |
| `reflex` | `fight`, `flee`, `hold`, `hide` or `none`, from what `Reflex.perform` did in the last 3 seconds (`LS.reflexKind`). `swing stomp shove close` count as a fight, `flee backoff break climb wait` as a flight, `hide sneak` as hiding. | |
| `stance` | The reflex stance behind it (`docs/combat.md`), like `BREAK`, when one was taken in the last 3 seconds. | `LS.reflexStance` |

A sample is about 230 bytes, so the record is near 3 KB. It is only in the dead percept. Which stat names, scales and `getDeathString` text the live game gives is not checked yet.

## Size

About 1.2 KB normally. The worst case in `test/lua-percept.test.mjs` (8 wounds, 6 zombies, 6 buildings, 4 weapons, long names) is under 3.5 KB. The `reflex` summary adds about 165 bytes and the gun fields under 100 bytes with one gun.

## The HUD weapon line

`LS.hudData.weapon` feeds the bottom line of the panel, `Inv N food, N water | <weapon>`. It shows the melee weapon, or the gun when one is held. When the weapon is the player's own pick (`weaponByHand`) the line adds `(your pick)`, for example `Baseball Bat (your pick)`.

## The voice files

The mod also reads `local_voice.txt` (the inner voice, one line, written by the bridge) and looks for two flag files, `ls_voice_off.txt` and `ls_voice_clean.txt`. They are all in the same folder as the percept. See "Inner voice on screen" in `docs/brain.md`. Nothing from them goes into the percept or an order.

## Checked and unchecked

The voice display calls (`addLineChatElement`, `getTextManager`, `MeasureStringX`, `getFontHeight`, `Keyboard.KEY_SEMICOLON`) were checked the same way. `getChatElement():IsSpeaking()` looked fine in the jar but throws in game: ChatElement is not exposed to Lua.

Every Java method above was checked against the 42.21 jar with `node tools/pz-api.mjs`, and enum names with `node tools/pz-consts.mjs`. What they return in a live game (for example whether `getBuildingList()` covers every loaded building, or whether `getWaterSources()` lists every sink) is not checked yet.
