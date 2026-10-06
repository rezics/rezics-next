# REZICS Goals

Several Goals may run at once, one manager each. Each Goal's directory states
its outcome, its areas (the paths other Goals' briefs may not claim) and its
state; the [Goal program](docs/goals/README.md) describes how they run and close.
The numbered product [decisions](docs/product/decisions.md) and the
[goal page](docs/product/goal.md) outlive every Goal.

| Goal | Outcome | Manager |
| --- | --- | --- |
| [Program](docs/goals/program/GOAL.md) | Supermanager: contracts board, main-wide regression, shared resources, manager survival | tmux `goal-program` |
| [Kernel](docs/goals/kernel/GOAL.md) | Core contracts of the target architecture: one model source, local consistency, bounded template reads, one representation per meaning | tmux `goal-kernel` |
| [Trust and operations](docs/goals/trust-ops/GOAL.md) | Common admission, platform gates for gradual opening, accounts, safety, erasure, deployment preparation | tmux `goal-trust-ops` |
| [Launch](docs/goals/launch/GOAL.md) | The first public scope: book library, recipes, VNDB-like and Bangumi-like catalogues, most Realm and Zone capabilities | tmux `goal-launch` |

`task goal -- status` shows each running Goal's manager session and live tasks.

Main-wide regression ([practice](docs/goals/README.md#several-goals)): held by
the program Goal since 2026-10-07; it no longer rotates between managers.
