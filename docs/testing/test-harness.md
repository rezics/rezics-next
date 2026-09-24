# Executable test harness

Tests are code. The target is one command, `yarn qa`, qualifying the implemented
scope in at most 30 minutes on the development host (64 cores, 62 GB RAM).
As of 2026-09-25, the root `qa` command runs static, unit, shared-stack
integration, an isolated model tier with the strict 66-case Jena matrix, an
isolated fault/recovery tier with a real Toxiproxy lost-response case, and a
bounded public-query load baseline, and a browser tier against the built Worker.
It inventories the retained acceptance IDs, records uncovered cases, and
supports selected-tier and failed-run diagnostics. Restore/crash coverage,
per-file isolation and final `--record` qualification are still pending. This page owns how the acceptance
cases in this directory become executable tests, how they are isolated and run,
and how results are recorded. The meaning of each case stays on its owning page;
tools and versions come from the [toolchain lock](../development/toolchain.md).

## Commands

The table specifies the completed harness contract. Currently `yarn qa`,
`yarn qa --tier` and `yarn qa --only-failed` run the implemented tiers.
`yarn test` accepts explicit unit files and routes registered QA integration,
model, fault/recovery, load and web e2e files through their stack harness; `qa:replay` and successful `--record`
remain to be implemented.

| Command | Behavior |
| --- | --- |
| `yarn test <paths> [-t <ID>]` | Runs explicit unit files through Bun. Registered stack-backed files, including `apps/web/tests/*.e2e.ts`, route through their isolated QA tier. A leading acceptance ID may select a named test; other legacy integration files still need their explicit environment until migrated. |
| `yarn qa` | Orchestrates all tiers, respecting dependencies and parallelizing isolated work. The exit code is non-zero if any test fails or any tier exceeds its budget. |
| `yarn qa --tier <name>` | Runs one tier with the same environment. |
| `yarn qa --only-failed <run-id>` | Diagnoses failed tests from an earlier run; this partial run cannot certify the whole changed tree. |
| `yarn qa:replay --seed <seed> <file> -t <ID>` | Reproduces one randomized failure exactly. |
| `yarn qa --record` | Currently blocked until every retained acceptance ID has declared and verified case coverage. The intended qualification workflow is described below. |

The coordinator owns batch execution under the
[execution workflow](../plan/execution-workflow.md#batch-cadence). Tests are
authored throughout implementation, then run centrally; targeted checks are for
blocking diagnosis and batched repairs. The harness must reject overlapping full
runs for the same checkout, retain the input source identity, and flag a run whose
source changes during execution as invalid for qualification. Internal worker
parallelism and isolated worktrees remain available.

Each run writes `.artifacts/qa/<run-id>/`, which contains a JUnit file per tier,
`acceptance.json`, `summary.md` and logs for failing files only. Agents read
`summary.md` and the failing logs, not full console output.

## Tiers and budgets

| Tier | Content | Isolation | Budget |
| --- | --- | --- | --- |
| static | `yarn check`: typechecks, Biome, dependency-cruiser, generated-artifact drift | none | 2 min |
| unit | Pure domain rules, command-client behavior and QA harness checks | in-process | 3 min |
| integration | In-process Main/Account behavior plus host Main `/health/ready` with work dependencies against real Fuseki and PostgreSQL | shared QA stack | 8 min |
| model | Reviewed shape generation, seeded node-local arbitraries and the strict 66-case Jena command matrix; broader command sequences pending | own QA Compose project | 3 min test budget |
| fault/recovery | Toxiproxy faults, `docker kill -s KILL`, pause, stopped-state backup, isolated restore, mixed-cut replay | own Compose project | 6 min |
| e2e | Playwright Chromium journeys against the built Worker on `wrangler dev`, host Main/Account and the stack | own QA Compose project | 3 min browser budget, after startup |
| load | k6 2.3.0 bounded public phrase query with thresholds and response snapshot checks; mixed workload pending | own Compose project | 3 min test budget |

Tiers run in parallel where their resources are disjoint. When a tier exceeds its
budget, the run fails and reports its slowest tests. Fix slow tests instead of
raising the budget. Changing a budget is an edit to this page with the measured
reason. The overall 30-minute budget includes setup and cleanup; tier ceilings
are not an allowance for extra unmeasured startup time.

## Environment and isolation

The harness lives in `tests/qa/` (Bun). For a run it:

1. Creates Compose project `rezics-qa-<run>` from `infra/dev/compose.yaml` with one
   PostgreSQL, RustFS, Toxiproxy, Mailpit and K Fuseki containers (`--workers`,
   default 16) on tmpfs.
2. Migrates template databases once (`account_tpl`, `access_tpl`, `content_tpl`,
   `relay_tpl`). Reuse this setup across the run's files; individual agents and
   test cases do not independently bootstrap the stack.
3. Runs `bun test --parallel=K`. Worker `BUN_TEST_WORKER_ID=k` uses Fuseki container
   k. The harness starts Fuseki outside Bun because `--parallel` implies
   `--isolate`, which kills a file's subprocesses between files.
4. Removes the project and its volumes unless `--keep` is set.

Each test file gets fresh state:

- **PostgreSQL:** `CREATE DATABASE ... TEMPLATE <owner>_tpl` per owner, named after
  the run and file.
- **Fuseki:** the worker's container is restarted on a fresh tmpfs dataset. The
  target is 5 seconds or less. If measurement shows this is slower, switch to a
  pre-created dataset pool reset with `DROP ALL` and a text-index probe, and
  record the change here.

Tests inside a file share that state. Every test creates its own identities
through builders and never depends on another test's data. `test.concurrent` is
allowed only in files whose tests are declared independent.

The implemented SYS02 lost-response case runs in a second disposable Compose
project with its own ports, secrets, bootstrap and cleanup. It uses the QA tmpfs
overlay because this case tests a transport failure without restarting or copying
storage. The tier saves a structured receipt/sequence/outbox trace and, on failure,
the Bun output and bounded Compose logs under the run artifacts. Future restore
and crash files need named volumes, stopped-state copies and per-file projects;
the tier does not yet claim those cases. Faults use Toxiproxy on the app-to-Fuseki
and app-to-PostgreSQL links:

- latency
- timeout
- reset after the request is sent (a lost response)
- bandwidth limits

Crashes use `docker kill -s KILL`, and stalls use `docker pause`.

## Writing tests

1. **One behavior per test.** Name the test `<ID>[/<ID>…]: <behavior>` with IDs from
   the owning case page, for example `WORK02: second Realm adoption keeps the first Realm body`.
2. **Set up through builders.** Builders in `tests/support/builders/` call the
   public commands. Seed the graph or SQL directly only for a named fault fixture.
3. **Compute expectations.** Expected values come from an oracle or from what the
   test itself created. Never hard-code aggregate counts, lengths of shared lists or
   absolute sequence numbers; assert deltas the test caused.
4. **Seed all randomness.** Every random input comes from fast-check with a logged
   seed, so `yarn qa:replay` reproduces it.
5. **Keep tests small.** Assert outcomes and invariants, not logs. A test over about
   60 lines extracts a builder. An integration test over 10 seconds fails the timing
   check unless it belongs to the recovery or load tier.
6. **Stay inside your isolation unit.** No test resets anything outside its file's
   databases and dataset.
7. **The run record is the evidence.** Do not commit hand-written evidence files.

## Oracles

`tests/oracle/` contains pure TypeScript reference models. They do no I/O and
import only generated model constants and types, never production modules. Each
model implements its contract text directly and prefers clarity over speed:

- Main Version default selection, Realm effective selection, fallback and rejection
  ([Main Version](../contracts/main-version.md), [context](../contracts/context.md)).
- Classification effective resolution with Global/Realm inheritance and isolation
  ([classification](../contracts/classification.md)).
- The rating latest-per-rater aggregate: sum, count, buckets and threshold
  ([ratings](../contracts/ratings.md)).
- Search visibility and phrase matching for public/private lanes, Realm and
  language, using the normalization in the [search contract](../contracts/search.md).
- Access admission, grants, fences and revocation
  ([identity and access](../contracts/identity-and-access.md)).
- Receipts: same key and digest replay; a different digest conflicts
  ([commands](../contracts/commands.md)).

Oracles are checked in three ways:

- **Differential.** Model-based fast-check runs (`fc.commands`, `fc.asyncModelRun`)
  mix create, publish, select, adopt, reject, classify, rate, revoke and edit
  commands. After each command, HTTP reads must equal the oracle state. Failing
  sequences shrink.
- **Metamorphic.** For search: adding unrelated documents, reordering inserts,
  and script or normalization variants the contract declares equivalent must not
  change the result.
- **Recovery.** State restored at cut C must equal the oracle's replay of the
  receipts committed up to C. Later commands must be reconciled or absent, as the
  [recovery contract](../operations/recovery.md) requires.

Changing an oracle requires rereading its contract; an oracle is never adjusted to
match an implementation's output.

## Generated data

- **Model arbitraries.** `packages/model/src/generated/arbitraries.ts` provides
  valid candidates and at least one invalid variant per constraint ID. Every
  constraint has a violating case that runs through the command module.
- **Synthetic corpus.** `tests/support/corpus.ts` is seeded and parameterized by
  Works, Realms, contributions, raters and languages. Its text is drawn from the
  remote fixture cache. The corpus is loaded through commands, never through
  direct store loads.

## Remote data

`yarn fixtures:pull [--source <name>]` runs adapters in `tests/fixtures/sources/`.
Each adapter declares its query set, rate limit and User-Agent:

| Source | Access |
| --- | --- |
| Wikidata | `Special:EntityData` JSON |
| Open Library | Low-volume JSON lookups at the published rate |
| MusicBrainz | WS/2 JSON at 1 request per second with an identifying User-Agent |
| Modrinth | API v2 at up to 300 requests per minute with a User-Agent |
| VNDB | The public API |

Payloads are stored content-addressed at `.cache/fixtures/<source>/<sha256>.json`.
The committed `tests/fixtures/fixtures.lock.json` records source, request URL,
fetch time, SHA-256, size and a reuse-basis note following
[source data rights](../research/source-data-rights.md). The CurseForge API is
excluded because its terms prohibit caching.

`REZICS_FIXTURES` selects the mode:

- `replay` (default) reads the cache. A missing entry is pulled when the network
  is available; otherwise the dependent tests fail with instructions, and are
  never skipped silently.
- `live` re-fetches and reports drift in the summary without failing.
  `--update-lock` rewrites the lock.

[Source conformance](source-conformance.md) cases use `live` mode in their own
tier once their stage starts.

## Load

`yarn qa --tier load` starts a disposable QA Compose project, bootstraps its real
graph and databases, starts Main as a host process, and runs the pinned
`grafana/k6:2.3.0` container against Main's `public-main-phrase-v1` query. The
current fixture has no published MatchUnits. A preflight request and every k6
response must contain a complete empty-corpus snapshot with a product source
position and text-index generation. The fixed profile uses two virtual users for
20 seconds, two alternating phrases, a 100 ms pause per iteration and no random data. It requires at least 20
requests, zero HTTP failures, all response checks passing and p95 below 1,500 ms.
The 3-minute test budget includes Main startup and k6 execution; Compose startup,
bootstrap and cleanup are recorded separately by the shared harness.

`.artifacts/qa/<run-id>/load/k6-summary.json` contains k6's reproducible
request, latency and check metrics; `evidence.json` records the preflight snapshot,
generator settings and selected metrics. Failed runs also keep `k6.log`,
`main.log`, the tier log and Compose logs. The own Compose project is reset by
default. `OPS05` remains a partial pass: zero-result queries do not exercise
representative corpus size, skew, edits, selections, ratings, relay lag or
recovery. The numeric practical workload objective is in
[initial host deployment](../operations/deployment.md#practical-load-objective).

## Frontend tests

- **Stories are component tests.** They run in Vitest 4.1 browser mode with
  Playwright Chromium, and MSW stands in for the Eden calls. They follow
  [component review](../development/storybook.md).
- **End-to-end tests** run the [experience](../experience/README.md) journeys
  against the built app on `wrangler dev` with the real stack. The current
  Playwright configuration records JUnit results and process logs; screenshot
  capture for failure review remains to be configured.
  The tier creates its own `rezics-qa-<run>-e` Compose project, runs the existing
  migrations and graph bootstrap, registers a local public OAuth client and Main
  introspection client, starts Account and Main, and waits for their ready
  then uses `yarn web:preview --profile qa --run-id <run>-e` to build
  and launch the Worker. It waits for the Worker search route before invoking
  `yarn web:e2e` with Playwright's JUnit reporter, then runs `yarn storybook:test`
  in Chromium. The tier saves `e2e.xml`, process logs and Playwright artifacts
  under the QA run directory. Host processes
  are stopped and the isolated project is reset after the run unless `--keep` is
  selected. The preview uses port 3003, so only one e2e tier may run per host.
  The current two public-search browser tests have no acceptance ID prefix; they
  exercise an empty corpus and a mobile filter disclosure, and a pass does not
  promote any SEARCH or VIEW case.

## Recording

`acceptance.json` records the run ID, commit, source fingerprint, dirty flag, host,
run kind (full or selected), parent run for failure reruns, setup/per-tier timings,
and per-test ID, file, status, duration and seed. The harness extracts acceptance
IDs from the tables in `docs/testing/*.md`. A named test supplies partial evidence;
a full run may promote an ID only after its complete case coverage is explicitly
declared and every mapped test passes. The current harness has no complete-case
declarations, so it cannot certify a case from a smoke test alone. IDs with no
test are listed as `uncovered`; they are never counted as passes. Tests not
selected in a partial run remain unverified
for that run; do not copy passes from an older source snapshot. Early batches
report future scope as uncovered; final Goal completion requires all retained IDs.

When complete case coverage exists, `yarn qa --record` will run all tiers once and regenerate the
[qualification page](../plan/qualification.md) from that same full passing run on
a clean source tree. Source identity is checked before writing the generated
page; that output is the only permitted tracked change made by recording. Commit
the page separately, preserving the tested source commit. A failed run keeps its
failure artifacts and does not replace the recorded qualification. The plan cites
that page instead of narrative evidence. Existing evidence files under `services/*/tests/evidence`,
`model/tests/evidence` and `tests/recovery/evidence` remain as history until the
qualification page covers their IDs. Add no new ones.

## Migrating the existing tests

- **Split the monolithic tests.** `full-work.integration.test.ts` (one test, 367
  assertions) and `recovery.integration.test.ts` (one test, 322 assertions) are
  split into behavior tests. Their shared flows become builders, and their
  assertions keep their acceptance IDs.
- **Use the harness environment.** Every integration test moves to it; no host
  `REZICS_*` paths remain, and no test spawns its own JVM or runs `initdb`.
- **Replace the Python model scripts.** The strict model tier runs the 66
  recorded candidates through the command module, alongside generated artifact
  and seeded-arbitrary tests. The Python validators are retired; broader model
  contract coverage remains in the acceptance inventory.
- **Keep the host drill.** `scripts/operations/verify_graph_substrate.py` remains
  the host installation drill for [installation](../operations/installation.md);
  the recovery tier covers the containerized equivalent.
