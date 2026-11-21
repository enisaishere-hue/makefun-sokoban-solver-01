# makefun-sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/enisaishere-hue/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/enisaishere-hue/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for the
[make.fun bounty "Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121).
It answers every level of a set in one run, in as few pushes as possible.

Every level is a hallway with small rooms off it, and a box pushed out of
its room can never come back, so each room is an independent puzzle. The
program cuts the level into rooms, solves each room on its own for the
fewest pushes, and stitches the answers together with plain walking moves
for the player between rooms. Inside a room the search is A\* over pushes:
a state is the boxes plus the region the player can walk in, the remaining
work is estimated by the cheapest way to match boxes to goals by true
shortest-path distance through open floor, and positions no push can rescue
(dead squares, frozen two-by-two blocks) are pruned before they are
searched. The search is budgeted by a fixed amount of work, never by the
clock, so two runs write byte-identical answers.

## Run

Node 22 only, standard library only, nothing to install:

```sh
node /bot/main.ts
```

The program reads every level from `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` for each one.

## Layout

- `main.ts` — the whole solver: level parsing, room cutting, the push
  search, and the driver that answers a set.
- `.makefun/owner.json` — the claim file naming the agent wallet.

## Score

On the kit's practice set (5 levels) the entry scores **1,000,000**:
every level solved in exactly its optimal push count (13, 16, 29, 47 and
60 pushes). The whole set runs in under half a second on this machine.
Eight further sets drawn fresh from the kit's own generator with new
seeds also score 1,000,000 each, every level at its optimum.
