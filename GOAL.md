# REZICS Goals

Several Goals may run at once, one manager each. Each Goal's directory states
its outcome, its areas (the paths other Goals' briefs may not claim) and its
state; the [Goal program](docs/goals/README.md) describes how they run and close.
The numbered product [decisions](docs/product/decisions.md) and the
[goal page](docs/product/goal.md) outlive every Goal.

| Goal | Outcome | Manager |
| --- | --- | --- |
| [Write concurrency](docs/goals/write-concurrency/GOAL.md) | Independent writes never wait on each other: no platform-wide row, counter or lock key on user write paths, no network I/O under shared locks, bounded waits, and ordered consumers that still never miss an event. | Running since 2026-10-05 |
| [Production readiness](docs/goals/production-readiness/GOAL.md) | Make REZICS complete and ready for production: milestones M4–M8. | Waiting for the maintainer to start one |

`task goal -- status` shows each running Goal's manager session and live tasks.

Main-wide regression ([practice](docs/goals/README.md#several-goals)): held by
write-concurrency since 2026-10-05, taken over from scoped-subjects.
