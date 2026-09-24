# Executable test harness

Tests are code. The target is one command, `yarn qa`, qualifying the implemented
scope in at most 30 minutes on the development host (64 cores, 62 GB RAM).
As of 2026-09-25, the root `qa` command runs static, unit and one shared-stack
integration smoke tier. It inventories 277 retained acceptance IDs, records
uncovered tiers, and supports selected-tier and failed-run diagnostics. The
remaining tiers, per-file isolation and final `--record` qualification are still
pending. This page owns how the acceptance
cases in this directory become executable tests, how they are isolated and run,
and how results are recorded. The meaning of each case stays on its owning page;
tools and versions come from the [toolchain lock](../development/toolchain.md).

## Commands

The table specifies the completed harness contract. Currently `yarn qa`,
`yarn qa --tier` and `yarn qa --only-failed` run the implemented tiers.
`yarn test` still serves the earlier research runner; the QA test selection,
`qa:replay` and successful `--record` path remain to be implemented.

| Command | Behavior |
| --- | --- |
| `yarn test <paths> [-t <ID>]` | Starts the QA stack if needed and runs the selected files or acceptance IDs. |
| `yarn qa` | Orchestrates all tiers, respecting dependencies and parallelizing isolated work. The exit code is non-zero if any test fails or any tier exceeds its budget. |
| `yarn qa --tier <name>` | Runs one tier with the same environment. |
| `yarn qa --only-failed <run-id>` | Diagnoses failed tests from an earlier run; this partial run cannot certify the whole changed tree. |
| `yarn qa:replay --seed <seed> <file> -t <ID>` | Reproduces one randomized failure exactly. |
| `yarn qa --record` | Runs full QA once on a clean source tree and, on a full test pass, generates the [qualification page](../plan/qualification.md) from that same run. No preceding `yarn qa` is needed. |

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
| unit | Pure domain rules against oracles, generated-arbitrary SHACL cases, fast-check properties | in-process | 3 min |
| integration | One behavior per test through in-process Main/Account app factories against real Fuseki and PostgreSQL | per file | 8 min |
| model | fast-check command sequences run against both the HTTP API and the oracle | per file | 5 min, time-boxed |
| fault/recovery | Toxiproxy faults, `docker kill -s KILL`, pause, stopped-state backup, isolated restore, mixed-cut replay | own Compose project | 6 min |
| e2e | Playwright journeys against the built web app on `wrangler dev`, host Main/Account and the stack | own stack | 3 min |
| load | k6 profile with thresholds, followed by an oracle invariant sample | own stack | 3 min |

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

Each file in the fault/recovery tier creates its own Compose project with named
volumes so it can stop, kill, copy and restore stores. At most six such files run
at once. Faults use Toxiproxy on the app-to-Fuseki and app-to-PostgreSQL links:

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

`tests/load/*.js` k6 scenarios use the synthetic corpus and the same command mix
as the model tier:

- Read-mostly public traffic: Work reads and search.
- Write traffic: edits, selections and ratings.

Thresholds are in the scripts: p95 latency per endpoint, error rate, and no 5xx
responses except injected faults. Target numbers come from
[workload budgets](../storage/workload-budgets.md) for the practical initial host.
After the run, an oracle comparison over sampled resources checks invariants. The
QA profile runs about 3 minutes; `yarn load --profile soak` runs longer outside
`yarn qa`.

## Frontend tests

- **Stories are component tests.** They run in Vitest 4.1 browser mode with
  Playwright Chromium, and MSW stands in for the Eden calls. They follow
  [component review](../development/storybook.md).
- **End-to-end tests** run the [experience](../experience/README.md) journeys
  against the built app on `wrangler dev` with the real stack. Screenshots are
  kept for failures and for the explicitly requested rendered review set.

## Recording

`acceptance.json` records the run ID, commit, source fingerprint, dirty flag, host,
run kind (full or selected), parent run for failure reruns, setup/per-tier timings,
and per-test ID, file, status, duration and seed. The harness extracts acceptance
IDs from the tables in `docs/testing/*.md`. An ID passes only if every test mapped
to it was selected and passed in the run. IDs with no test are listed as `uncovered`; they are
never counted as passes. Tests not selected in a partial run remain unverified
for that run; do not copy passes from an older source snapshot. Early batches
report future scope as uncovered; final Goal completion requires all retained IDs.

`yarn qa --record` runs all tiers once and regenerates the
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
- **Replace the Python model scripts.** `model/tests/verify_*.py` and
  `model/tools/validate_*.py` give way to generated-arbitrary cases through the
  command module.
- **Keep the host drill.** `scripts/operations/verify_graph_substrate.py` remains
  the host installation drill for [installation](../operations/installation.md);
  the recovery tier covers the containerized equivalent.
