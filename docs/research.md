# Playing like a pro: research and plan

Research done 2026-11-04 against this repo, Project Zomboid 42.21 (the install on pancakes), and published work on game-playing LLM agents. Read this before changing the brain or the body.

## The short version

```
today                                   pro target
model picks MOVE dx,dy (a raw vector)   model picks from a menu of named targets and skills
body walks into walls, loops unstick    game pathfinder walks to a door, a container, a bed
one loot grab, 6 random items           search the whole building, take only what matters
no water source, no sleep, no bandage   drink at sinks, sleep when safe, treat wounds
reflex swings or runs                   reflex spaces, stomps downed zombies, watches stamina
no memory of places                     map memory: buildings seen, looted, safe, has water
no learning                             lessons written after each death, read every turn
no score                                scenario tests and run stats show if a change helped
```

A pro is good at two things: **execution** (spacing, timing, never getting grabbed) and **judgement** (what to do next, when to stop). A local 12B model answering every few seconds can do judgement if the choices are small and clear. It cannot do execution. So the Lua body owns execution, the model owns judgement, and the menu between them is the most important design choice.

## What the last run shows

From `~/Zomboid/console.txt` and `local_percept.txt` (2026-11-04):

- Day 0, 22:00, still in the first house with no weapon, no food, no water.
- The bridge kept writing `MOVE 16,0` ("Nothing new here. Moving on.") into a wall. The unstick helper fired about every 2.5 seconds for minutes.
- The survivor wears a surgical mask and carries a key ring. Neither is used.

Bugs found while reading the code:

- `isEdible` counts unopened cans as food. In 42.21 a can is `CantEat = true` with `OpeningRecipe = OpenCannedFood`, so EAT fails on them. Vanilla's test is `item:getScriptItem():isCantEat()` (`ISInventoryPane.lua:987`).
- Drinking only works from a bottle. Sinks, toilets and tubs work until the water shuts off, and the body never uses them, so thirst ends the run.
- `doLoot` searches one container within 10 tiles and grabs three random extra items on its second pass (clothes, junk) whatever they weigh.
- Nothing sleeps. Fatigue only goes up.

## What the research says

### Game agents

| Work | What it found | What we take |
|---|---|---|
| Hierarchical Language Agent (Overcooked, [arXiv 2312.15224](https://arxiv.org/abs/2312.15224)) | Slow mind (big LLM, intent), fast mind (small LLM, macro actions), executor (reactive policy). Beat slow-only and fast-only agents. | Three layers: planner, chooser, Lua reflex. |
| The World Won't Wait / TORSI ([arXiv 2610.20665](https://arxiv.org/abs/2610.20665)) | When the game keeps running, a faster weaker model beats a slower stronger one. A slow teacher studies failures between attempts and writes rules for the fast student; two rounds nearly doubled the score. | Keep the in-game model fast. Do the deep thinking between runs. |
| GUIDE ([arXiv 2603.27306](https://arxiv.org/abs/2603.27306)) | A playbook of state-triggered rules, evolved offline from past runs, beats a fixed prompt for a small real-time actor. | Lessons file with trigger conditions, only the matching rules go in the prompt. |
| Voyager ([arXiv 2305.16291](https://arxiv.org/abs/2305.16291)) | A library of skills that run to completion and report success or the error. | Lua skills with a finish and a result code the model can read. |
| Reflexion ([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)) | The agent writes what went wrong after a failure and reads it on the next try. | Death review. |
| Ghost in the Minecraft ([arXiv 2305.17144](https://arxiv.org/abs/2305.17144)) | Text knowledge plus memory let the agent plan without seeing pixels. | Map memory of buildings, written as short text. |
| Mindcraft ([github](https://github.com/mindcraft-bots/mindcraft)) | Always-on "modes" (self_defense, cowardice, unstuck, self_preservation) run every tick outside the LLM. The LLM calls named commands (`!goToCoordinates`, `!takeFromChest`, `!goToBed`). | Our reflex is a mode. The model should call commands, not steer. |
| Claude / Gemini plays Pokemon | Spatial reasoning was the main weakness. Both harnesses leaned on a pathfinding tool and a memory of explored tiles. | Never ask a small model to steer with vectors. |
| BALROG ([arXiv 2411.13543](https://arxiv.org/abs/2411.13543)) | Small models fall apart on long-horizon, spatial, open-ended games. | Keep the horizon short (one skill) and the choice closed (a menu). |

### Pro play in Build 42

Sources: projectzomboid.wiki combat guide, gamers.wiki horde and first-30-days guides (Jul 2026, 42.20), plus the game's own Lua.

**Combat**
- The loop is shove, stomp, step back. Shove does no damage, the stomp kills, and it costs no weapon wear. Stomp at the head end; leg stomps never kill.
- Only fight one standing zombie at a time. Fight in a doorway or behind a low fence or window: a zombie climbing through falls over on your side, which is a free stomp.
- Fence lunge is on by default. Hit a zombie that just came over before it gets up, or stand back out of reach.
- Stamina runs out long before weapon condition. Low endurance widens swing gaps and raises misses. Stop and back off before it hits the red.
- Panic cuts accuracy and shove knockdown. Tired, panicked, hurt or overloaded: disengage through a door you can close.
- Weapons: long blunt (bat, crowbar) and axes first, spears are strong in 42, kitchen knives are a last resort.

**Noise and sight**
- Sneaking footsteps are 3.5, walking 7, sprinting 14, a shout 30, a car alarm 150, a house alarm 600.
- Zombies walk to the loudest thing they hear. Smashing a window is loud; climbing through broken glass cuts you, so clear it first.
- Close curtains before turning on a light. Darkness hides you; a lit window draws them.

**Priorities**
- Day one: water bottle, a real weapon and a spare, a bag, can opener, bandages, then hammer, saw, screwdriver.
- Pick a house with two exits. Close curtains. Sleep there.
- Stop rules: tired or panicked, go home. Overloaded, drop it. Wounded, treat it before the next door. No route home, turn round.
- Water and power shut off in the first weeks. Fill bottles while sinks run.

### Game API facts checked on 42.21

Run `node tools/pz-api.mjs <java.class> [regex]` to list what a class really exposes. Lua calls Java by name and a wrong name fails silently inside `pcall`.

- Buildings: `IsoBuilding:getDef()`, `getWaterSources()`, `hasWater()`, `getRandomRoom()`, `isAllExplored()`. `BuildingDef:getID()`, `getX() getY() getX2() getY2()`, `getRooms()`, `isResidential()`, `isShop()`, `isAlarmed()`. `IsoRoom:getContainer()`, `getWaterSources()`, `getWindows()`, `getRandomFreeSquare()`.
- Zombies: `getTarget()`, `isTargetVisible()`, `isOnFloor()`, `isKnockedDown()`, `isCrawling()`, `isFakeDead()`, `isUseless()`. The player's stats have `getNumVisibleZombies()`, `getNumChasingZombies()`, `getNumVeryCloseZombies()`.
- Combat: `IsoLivingCharacter:setDoShove(bool)`, `DoAttack(float)`, `isDoStomp()`.
- Sleep: `ISWorldObjectContextMenu.onSleepWalkToComplete(playerIndex, bed)` does the vanilla checks (no zombies visible, no panic) and sets the wake time.
- Drink from a sink: `ISTakeWaterAction:new(player, nil, waterObject, waterObject:isTaintedWater())` after `luautils.walkAdjObject` (see `ISWorldObjectContextMenu.onDrink`).
- Other timed actions in `media/lua/shared/TimedActions`: `ISApplyBandage`, `ISDisinfect`, `ISWearClothing`, `ISReadABook`, `ISRemoveBrokenGlass`, `ISBarricadeAction`, `ISOpenCloseCurtain`, `ISLockDoor`, `ISClimbOverFence` (client), `ISGetOnBedAction`, `ISRestAction`, `ISSitOnGround`.
- Body: `BodyPart:bleeding()`, `scratched()`, `bitten()`, `deepWounded()`, `bandaged()`, `haveGlass()`, `isInfectedWound()`.

## The plan

```
      slow planner (same or bigger model, rare, async)
        sets the day plan, writes lessons after a death
                      |
      fast chooser (gemma4:12b, every few seconds)
        picks ONE option id from a short menu built for this moment
                      |
      Lua skills (run to the end, report done or failed:<why>)
        GO_TO, SEARCH_BUILDING, DRINK_SINK, SLEEP, BANDAGE, SECURE, ...
                      |
      Lua reflex (every tick, never waits)
        fight one, stomp the downed, back off when tired, flee a pack
```

1. **Foundation.** Git, `npm test`, a Lua syntax and load check, and the mod split into modules so work can run in parallel.
2. **Senses v2.** Buildings with stable ids, water sources, beds, wounds, moodles, weight, zombie awareness (chasing or not), and the result of the last skill.
3. **Skills v2.** Pathfinder walks to targets, whole-building search with a priority list and a weight cap, sinks, sleep, bandages, bags, curtains.
4. **Combat micro.** Shove and stomp, spacing, endurance and panic gates, door fighting.
5. **Menu brain.** A per-turn list of legal options with ids, enforced through Ollama's JSON schema enum. A stable system prompt first so Ollama reuses its cache. A short situation digest instead of raw JSON. Needs that cannot wait (bleeding, thirst with a sink here, night outside) are handled before the model is asked.
6. **Planner and lessons.** Day plan on events. Death review writes up to a few lessons with triggers.
7. **Scoring.** Scenario fixtures run against a live model, and per-run stats (hours survived, kills, damage, buildings searched, cause of death).
