# Handoff: where we left off

Written 2026-11-05 at the end of the first long session, so a fresh session can pick up. Read this, then `docs/roadmap.md`. Code beats docs when they disagree.

## Right now

```
soak test   node tools/soak.mjs --hours 3, started 2026-11-05 10:18 UTC, ends about 13:18 UTC
            normal loot, respawn on death, relaunch on crash or freeze, critic and inner voice on
report      bridge/soak-2026-11-05-10-18.txt when it ends (review.mjs --since the start)
logs        bridge/soak.log (runner), bridge/soak-bridge.log (bridge), bridge/decisions.jsonl
feature     frozen until the soak report is read
```

Two fixes went in during the first hour of the soak, with the game and bridge relaunched by the runner: any safe wait runs at speed 3 (not only at night), and DROP and the brain's heavy test now use the same weight line as SEARCH (she had been stuck waiting in a kitchen, too full to search and not heavy enough to drop). Deaths and decisions before 10:32 UTC ran the older build.

The character playing at the start of the soak kept gear from a rich-loot run, so her stats are flattered. Every character after her is a fair test. The best run so far reached day 6.

## First thing next session

1. Read the soak report and the death lines in `bridge/decisions.jsonl`: deaths by cause, reflex by stance, critic flags against outcomes.
2. Pick the top 2 killers and fix them (cards, see below). Run another soak.
3. Then the review pass: Colin's nudges and the critic flags into policy rules, labels and eval scenarios.

## Where the code lives

- Local repo: `H:\Git\local-survives-zomboid`, branch `main`.
- Pushed to `LeahyCC/claude-survives-zomboid`, branch **`local-survivor`** (`git push origin main:local-survivor`). That repo's `main` is the original July project with unrelated history: never push or merge into it.
- `origin/HEAD` is set to `local-survivor` on this PC, so board worktrees start from this work. If a card's worktree ever starts from the old project, reset its branch to the local `main` (recent cards carry that line in their ground rules).
- Commits are Colin's name, plain sentences, no trailer, no mention of AI.

## Running it

```
pwsh tools/playtest.ps1 [-RichLoot]   install the mod, start the game, continue the save
cd bridge; node pz-bridge.mjs         the brain, http://localhost:8799/mind
node tools/soak.mjs --hours 3         unattended run with a report
npm test                              Lua check, Lua tests, bridge tests (761 at handoff, 806 after the escape loop fix)
node bridge/eval/run.mjs --n 2        brain eval; --backend jev for Jev
node bridge/tools/review.mjs          decisions, nudges, reflex, critic, deaths
```

- The critic needs `TYPESAFE_API_KEY`. It is a Windows user variable. A bash shell started before it was set does not have it: read it with `powershell -NoProfile -Command '[Environment]::GetEnvironmentVariable("TYPESAFE_API_KEY","User")'` and never print it.
- Tracing: create `Zomboid/Lua/ls_trace.txt` for `LocalSurvivor trace` lines in `console.txt`. Off during soak runs.
- A Lua change needs a game restart. During a soak, just close the game: the runner relaunches it with the new mod.

## How the work was run

Colin's Kungfu board (`http://localhost:4747`, Claude Code only). Each change is a card written to `H:\Git\kungfu-kanban\data\inbox\zomboid-pro-<name>-<yyyymmdd-hhmm>.md` with `cwd: H:/Git/local-survives-zomboid`, `worktree: true`, `openPr: false`, `queue: true`, `group: zomboid-pro`, and self-contained ground rules (copy them from a recent card in `inbox/imported/`).

```
before a run   Sensei off (enabled false) and PR auto-fixers off; restore after
watch          node tools/board/watch.mjs            exits when a card needs review or stalls
status         node tools/board/status.mjs [id8 n]   cards, or one card's transcript
fix a prompt   node tools/board/patch-prompt.mjs <id8> <note.txt>   (stop the card first)
review         read resultText, run npm test in its worktree, read the risky code
merge          in the worktree: git merge main; resolve; npm test
               in the repo: git merge --no-ff worktree-kanban-<id8>; npm test
cleanup        git worktree remove --force --force .claude/worktrees/kanban-<id8>
               git branch -D worktree-kanban-<id8>; PATCH the card status to done
push           git push origin main:local-survivor
```

At handoff the board is back to normal: Sensei on in suggest mode, auto-fixers on. No card is running.

## Open items

From the cards' "New tasks" and live play, roughly by value:

- **House job (card 3 of `docs/pro-rules.md`):** the bridge holds in, shut, look, search, leave, with door-first entry and walks that stay in the house (`docs/brain.md`, "House job"; `docs/skills.md`, ENTER and SEARCH). Tested with stubs only, not seen live. On the next soak read "House jobs" in the review against the old numbers: 14 of 79 entries searched, 41 re-entries, 63 ENTERs from inside a house, 15 of 38 SECUREs failed `not inside`, 3% of time searching. Check these live: `isDoorTo` and `isBlockedTo` give a real inside way through shut doors (if not, every long walk goes straight and relies on the step-outside stop); no indoor square lacks a room (one would read as outside, so she would skip a room and walk back); reading `isLocked` from afar matches what the door does on arrival; the 15 minute per room limit is not cutting searches short (`time` under "How they ended"); and whether SECURE first is worth its cost. `docs/pro-rules.md` argues it is not by day, and Colin chose it, so it stays until the numbers say otherwise.
- **Clear a house (`docs/brain.md`, "CLEAR"; `docs/skills.md`, CLEAR):** one idle zombie inside no longer sends her away if she is fit to fight. Tests only, not seen live. On the next soak read "Houses cleared of a zombie" in the review, the `clear failed` and `clear called off` reasons in the `house` lines, and hp lost around them. A kitchen knife does not clear (`weapon too short`), since the reflex stands and waits with one. Letting it would mean a change in `Stance.choose`.
- **Crowd map (card 5 of `docs/pro-rules.md`):** zombie counts by building and 20 by 20 area from every percept, fading over 12 game hours, saved in `map.crowd`. A crowded building is off the ENTER menu, a crowded area ranks last, and a failed ENTER with `zombie` is off for 5 minutes, doubling to 30 (`docs/brain.md`, "Crowd map"). Tests only, not seen live. On the next soak compare with the old numbers: 35 ENTER failures with `zombie`, 45 sent again after a failure, 75 minutes in ENTER. Check: how often `zombies seen here lately` shows on an option and whether the thresholds (3 for a building, 5 for an area) cut too many houses (a menu with no ENTER and only `explore` while she is outside); the straight-line fade (a 3 stops counting as crowded after about 2 hours); and that the 10 tile building match does not put a street crowd on the wrong house. The list holds 6 zombies, so the area count never passes 6.
- **Reflex:** sprint does not hold (2 of 143 BREAK outcomes in the first soak), so BREAK and FLEE are the same walk and neither gains ground on a walker. The escape loop is handled (see "Escape loop" below); watch "Stuck in a chase" in the review on the next soak. The posture field (`avoid`, `clear`) is now set by the escape menu only; the usual menu still sets none. HIDE's line of sight and the fence side rule are unverified live. Nothing yet gets her inside and shuts a door from the reflex: that is the brain's escape menu.
- **Escape loop:** in the first soak the last 33 minutes were one unarmed zombie chase at endurance 0, 35 FLEEs, 0 escaped, no brain turn. Fixed in two places: after 3 failed tries a small chase gets a climb, a stand-and-shove, or a different heading plus a brain turn (`docs/combat.md`, "Stuck in a chase"), and the bridge hands the brain a turn after 60 seconds of reflex hold (`docs/brain.md`, "When the hold ends"). Not yet tried live: the stand-and-shove at endurance 0.3 to 0.5 (does an unarmed shove drop a zombie often enough?), the 20 second window where the reflex stands aside for the brain's walk (see "Stand-aside death"), and the escape menu's picks with a real model. Her load was 70 to 80 percent too, so she is also slow; DROP never ran in that loop because it is not offered while chased.
- **Stand-aside death:** the second soak's first life died at 21:45:52Z on an ENTER walk with the reflex off (hp 12, bleeding, 2 chasing at 7 tiles, 4 at death, 17 quiet seconds). Fixed: the window never starts, and ends, for a pack (3 inside 7, 2 inside 3) or a hit, and it does not start for a chaser past 10 tiles (`docs/combat.md`, "When the stand-aside ends"). Check the next soak: any `death` after an ENTER or GOTO with chasers close and no reflex line in the 20 seconds before. The stand-aside itself is still not seen working live.
- **Guns:** the reflex cannot fire. The calls it needs are listed in `docs/combat.md`. Shots draw zombies, so it needs a noise rule.
- **Loot:** corpses are not searched. Floor pickups and the freezer and container walk are unverified live.
- **Bare hands (card "weapon in hand"):** in the first soak she had no weapon in 275 of 482 decisions (57%). Fixed in code, not yet seen live: she holds a carried weapon on her own (`Act.autoEquip`), a bare pack takes a worn pan or knife (`WEAPON_MIN_BARE`), SEARCH looks in kitchens, garages and sheds first, and the `find-weapon` policy rule searches when she is inside with bare hands. Check the next soak: share of decisions with `weapon` none, and how long into each life the first weapon shows up.
- **Outdoor stall:** one character spent about 18 minutes of wall clock (game 11:47 to 12:01 UTC log time, 100+ turns) on WAIT outside with 13 zombies near and a menu of only `WAIT` and `EAT`. Nothing offers a way out when every building and walk is blocked by idle zombies.
- **Weapon lost overnight:** the Umbrella (Closed) she held at game hour 18 was gone by hour 27. No decision rows cover the sleep, so the cause (broke in a fight, or something else) is unknown. A closed umbrella has 7 condition and scores 14.6.
- **Brain misses** in the eval: `panicked-outside`, `winded-no-chase` (rest), `can-with-opener` (eat). Jev gets the last two right.
- **Death causes:** sickness, poison and cold are recorded but not used to guess a cause. The `infected` flag is set by the first bite and stays set, so it is not a cause by itself: two short lives read `infection` (at 2.8 and 3.5 game hours; a third at 3.6 days may be real), the flag set by a bite while a bleed or a chase did the killing. In the 3.5 hour record `infected`, `bite` and `bleeding` 2 were all set and hp fell 0.6 a second with four chasing 7 tiles off. `infection` now needs no bleeding at the end, and chasers close with 5 hp lost reads as overrun (`docs/eval.md`). The scale of `infect` (`ZOMBIE_INFECTION`) is still unchecked, so it is not used.
- **Inner voice:** a moment seen just before its order speaks alone; it can drift to the third person.
- **Not tested live:** whether her key ring opens a locked door.
- **Vault:** `LocalSurvivor/local-survivor-todo.md` (notes for Co to fill in) has not been started.
- **Colin:** delete `Desktop\key.txt` (the key is already in the user variable).

## Models

| role | model | where | speed |
|---|---|---|---|
| brain | gemma4:12b | GPU, Ollama | about 0.4 s a turn |
| planner | qwen3.6-35b | CPU (`num_gpu` 0), thinking off | about 6 s a plan |
| inner voice | pepe-8b | CPU | 4 to 11 s a line |
| critic | Jev 1.14 (TypeSafe, hosted) | API | about 0.15 s |

16 GB of GPU is shared with the game. Every Ollama call uses one `num_ctx` (8192): a different size makes Ollama reload the model.
