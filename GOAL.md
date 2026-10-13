# REZICS Goals

Running again since 2026-10-13 09:39 UTC: the maintainer started the
supermanager in termspaces, and the [program](docs/goals/program/GOAL.md) works
through its next tasks. The api and web Goals stay paused until the program's
tasks N1 to N4 are on `main`; each `state.md` is its checkpoint. The run of that
morning lasted about ninety minutes and was paused to plan again.
The way of working was redesigned on 2026-10-12 after the maintainer stopped
the run of 2026-10-07 to 2026-10-12.

Each Goal's directory states its outcome, its areas (the paths other Goals'
briefs may not claim) and its state. The [method](docs/goals/method.md) says how
work is defined, proved and landed; the [Goal program](docs/goals/README.md)
describes the tool. The numbered product [decisions](docs/product/decisions.md),
the [goal page](docs/product/goal.md) and the
[target architecture](docs/architecture/target-architecture.md) outlive every Goal.

| Goal | Outcome | Starts |
| --- | --- | --- |
| [Program](docs/goals/program/GOAL.md) | Supermanager: the scope, the method and the tool that enforces it, the shared host | Running since 2026-10-13 09:39 UTC |
| [API](docs/goals/api/GOAL.md) | Every row of the first public scope is proved through the API, for each persona | Paused; every row has its persona matrix, none is proved |
| [Web](docs/goals/web/GOAL.md) | Every proved row has its surface | Paused; three client-contract guards on `main`; surfaces when the first vertical's rows are proved |
| [Operations](docs/goals/operations/GOAL.md) | Erasure and restore proved on physical fixtures; deployment prepared | When the erasure and recovery contracts are stable |

`task goal -- status` shows each running Goal's manager session and live tasks.
The kernel, trust-ops and launch Goals of 2026-10-06 are archived on the local
branch `archive/goals`; what they left unfinished is listed in the new Goals'
`state.md` files.
