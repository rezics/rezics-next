# Plan

The [active Goals](../../GOAL.md) own delivery scope and current work. The
[method](../goals/method.md) defines outcome proof; the [manager charter](../goals/manager.md)
owns task allocation. The routes below locate contracts and checks without
requiring the entire documentation set.

## Current state

Use the Goal ledger and [scope registry](../../scripts/qa/cases/launch-coverage.ts)
for current progress. An archived backend acceptance run or frontend milestone
does not qualify the current product.

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
