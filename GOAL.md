# REZICS Goals

Several Goals may run at once, one manager each. Each Goal's directory states
its outcome, its areas (the paths other Goals' briefs may not claim) and its
state; the [Goal program](docs/goals/README.md) describes how they run and close.
The numbered product [decisions](docs/product/decisions.md) and the
[goal page](docs/product/goal.md) outlive every Goal.

| Goal | Outcome | Manager |
| --- | --- | --- |
| [Production readiness](docs/goals/production-readiness/GOAL.md) | Make REZICS complete and ready for production: milestones M4–M8. | Waiting for the maintainer to start one |

`task goal -- status` shows each running Goal's manager session and live tasks.

Main-wide regression ([practice](docs/goals/README.md#several-goals)): no Goal
is running, so nobody holds it; the next manager to start one takes it. The last
holder, write-concurrency, closed on 2026-10-06 after three full passes; open
items are listed in production readiness under "Inherited from write-concurrency".
