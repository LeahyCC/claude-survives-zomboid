# Roadmap

Agreed with Colin on 2026-11-04. The goal is a survivor that plays like a good player over hours, not one that looks good in a 6 minute clip.

## What we learned so far

- The biggest gains came from fixing the body, not the brain: the tick rate (timers counted frames at 240 fps), ENTER opening windows it could not climb, and a hold rule that froze her next to a zombie behind a wall. Each fixed more than any prompt change.
- The model makes about 1 decision in 5. Policy rules and skills make the rest.
- Plan quality is not what holds her back. The 12B planner writes sensible plans. 27B and 26B planners could not finish a plan inside the 15 second grace with the game on the GPU (`docs/planner.md`).
- We have only watched short runs. We do not yet know what kills her over hours.

## The loop

```
soak test: 2 to 3 hours unattended, auto respawn on death
   -> stats and the decision log record every death and its cause
   -> fix the top 2 killers
   -> run again
```

This loop comes first. Features we guess at come after it.

## Order of work

1. Decision log with outcomes, and the nudge panel on /mind (card in progress).
2. Night fast forward, so waiting out the dark costs seconds, not minutes (needed for long soak tests).
3. First soak test. Best run while Colin is not using the PC: it holds the GPU.
4. Fix the top killers from the soak test. Repeat 3 and 4.
5. Review pass: read the decision log and Colin's nudges, turn patterns into policy rules, better option labels and eval scenarios.
6. Later: traits and skills in the percept. Traits change rules and weapon scoring in code, and a one line persona in the prompt flavours the brain's own thought. No second model in the decisions: 16 GB is already full with the game and the 12B.

## Not doing

- A separate "thoughts" model that steers her. No room on the GPU, and the brain already writes a thought with each choice. The inner voice (pepe-8b) is different: first person commentary only, on the CPU, never in the prompt or the orders (`docs/brain.md`).
- Letting the critic (Jev's second opinion, `docs/brain.md`) steer her. It only logs. Whether its flags predict trouble is for the review to show first.
- Fine tuning. Too little data, and the menu still changes every week.
- A bigger planner on this PC, unless the planner benchmark finds a setup that keeps menu turns fast.
