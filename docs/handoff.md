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
npm test                              Lua check, Lua tests, bridge tests (761 at handoff)
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

- **Reflex:** sprint probably never holds (the game resets it from the keyboard every frame); check the `sprint` field in BREAK outcomes. The posture field (`avoid`, `clear`) exists end to end but no menu option sets it. HIDE's line of sight and the fence side rule are unverified live.
- **Guns:** the reflex cannot fire. The calls it needs are listed in `docs/combat.md`. Shots draw zombies, so it needs a noise rule.
- **Loot:** corpses are not searched. Floor pickups and the freezer and container walk are unverified live.
- **Brain misses** in the eval: `panicked-outside`, `winded-no-chase` (rest), `can-with-opener` (eat). Jev gets the last two right.
- **Death causes:** sickness, poison and cold are recorded but not used to guess a cause.
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
