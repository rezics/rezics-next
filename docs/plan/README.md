# Plan

The active [Goals](../../GOAL.md) state the outcomes and milestones; the
[goal page](../product/goal.md) states what REZICS is for. This page keeps the
current state, where a task starts reading, and the acceptance gates. It was
shortened on 2026-09-30 at the Goal's restart: the stage A–G sequence, the S0–S3
fast-start milestones and the 2026-09-23/24 documentation verification narrative
described backend phase 1, which finished on 2026-09-27 (history on
`archive/goals`; the recorded run is the baseline below).

## Current state

| Field | Selection |
| --- | --- |
| Scope | The active [Goals](../../GOAL.md): production readiness (M4–M8), restarted on 2026-09-30 after the documentation discussion that settled decisions 39–50, and since 2026-10-04 addresses, relationships and discovery as a Goal of its own. |
| Goals | Each Goal keeps its checkpoint in its own `state.md` (`docs/goals/<goal>/state.md`); live tasks: `task goal -- status`. |
| Model allocation | Standing direction 5 in the [manager charter](../goals/manager.md#standing-directions): Sonnet 5.5 frontend, GPT-6.1 Sol backend, Grok 4.7 simple bounded tasks, Opus 5.5 and Sol first-of-kind design, Opus review. |
| Baseline | Backend phase 1 passed all 276 retained backend acceptance IDs on 2026-09-27 (run `20260927t101230-1616d8`, tag `goal/backend-phase1`). The frontend-centred Goal paused after M3 at `59a85a96`. |

## Task reading routes

Start from intent, then the owner, then the code:

1. [Goal page](../product/goal.md): mission, the three values, backend one and
   frontend free, Wiki+ and how success is judged.
2. [Platform thesis](../product/platform-thesis.md): the abstraction base,
   capabilities, Zones as routed sites, the relation lexicon and expansion
   acceptance; [markets and growth](../product/markets-and-growth.md) for launch
   order and revenue.
3. The owner contract the brief names, found through the [contracts index](../contracts/README.md).
   Work levels, realizations
   and the catalogue fixtures live in [Work and release](../contracts/work-and-release.md);
   merge and split in [identity correction](../contracts/identity-correction.md).
4. The code, types, schemas, stories and tests of the affected owner. They own
   executable behaviour; documents own intent, reasons and procedures.

Frontend tasks also load the [frontend direction](frontend.md) and the affected
feature's stories and browser tests. [Low-priority work](low-priority/README.md)
lists deferred acquisitions. A wording or link fix needs only the
affected document and its consumers.

## Acceptance gates

[Backend scope](../../scripts/qa/backend-scope.ts) details integration
obligations; web stories and browser tests carry the experience.

| Gate | Meaning |
| --- | --- |
| G1 Design | Owners, state transitions, identities, authority, failures and required tests are specified. |
| G2 Persistence | Actual Jena, PostgreSQL and object bindings pass positive, rejected, concurrent and recovery cases. |
| G3 API | Stateful HTTP, SDK and MCP flows preserve the same contracts. |
| G4 Integration | Cross-owner source, publication, search and revocation journeys pass. |
| G5 Experience | The same journeys pass in a real browser on phone and desktop, with accessibility checks. |
| G6 Operations | Fresh installation, backup restoration and measured practical workload meet elected objectives. |

## Completion boundary

New-system integrity, source fidelity and recoverability are required. Old-system
schema, API and data compatibility and migration-only dual writes are not.
Current-site inputs refresh each live-source run; verified captures reproduce
one run. The current baseline is 500M business entities and documents; 3B is a
future scenario. Keep derived complexity, executed growth checks and measured
rollout capacity separate. No small-data pass certifies that all existing data
fits.
