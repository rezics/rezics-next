# Executable test harness

Tests are code. The target is one command, `yarn qa`, qualifying the implemented
scope in at most 30 minutes on the development host (64 cores, 62 GB RAM).
As of 2026-09-25, the root `qa` command runs static, unit, shared-stack
integration, an isolated model tier with the strict 66-case Jena matrix, an
isolated fault/recovery tier with a real Toxiproxy lost-response case, a
bounded mixed public-query load probe, and a browser tier against the built Worker.
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
model, fault/recovery, load and web e2e files through their stack harness. `qa:replay`
selects a seeded test through the same routing; successful `--record` remains to be implemented.

| Command | Behavior |
| --- | --- |
| `yarn test <paths> [-t <ID>]` | Runs explicit unit files through Bun. Registered stack-backed files, including `apps/web/tests/*.e2e.ts`, route through their isolated QA tier. A leading acceptance ID may select a named test; other legacy integration files still need their explicit environment until migrated. |
| `yarn qa` | Orchestrates all tiers, respecting dependencies and parallelizing isolated work. The exit code is non-zero if any test fails or any tier exceeds its budget. |
| `yarn qa --tier <name>` | Runs one tier with the same environment. |
| `yarn qa --only-failed <run-id>` | Diagnoses failed tests from an earlier run; this partial run cannot certify the whole changed tree. |
| `yarn qa:replay --seed <seed> <file> -t <ID>` | Re-runs one fast-check test with its signed 32-bit seed through the unit or registered QA tier. The test must read `REZICS_QA_SEED`; a seed reproduces the same generated sequence and shrink. |
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
| model | Reviewed shape generation, seeded node-local arbitraries, native Jena command fixtures and the strict 66-case matrix; broader command sequences pending | own QA Compose project, isolated from product integration data | 3 min test budget |
| fault/recovery | Toxiproxy faults, `docker kill -s KILL`, pause, stopped-state backup, isolated restore, mixed-cut replay | own Compose project | 6 min |
| e2e | Playwright Chromium journeys against the built Worker on `wrangler dev`, host Main/Account and the stack | own QA Compose project | 3 min browser budget, after startup |
| load | k6 2.3.0 bounded skewed Main/Realm/Content phrase mix with thresholds and exact response snapshot checks | own Compose project | 3 min test budget |

Tiers run in parallel where their resources are disjoint. When a tier exceeds its
budget, the run fails and reports its slowest tests. Fix slow tests instead of
raising the budget. Changing a budget is an edit to this page with the measured
reason. The overall 30-minute budget includes setup and cleanup; tier ceilings
are not an allowance for extra unmeasured startup time.

The positive Content rebuild drill starts a nested QA project with
`yarn stack:up --profile qa --run-id <id> --persistent`. This chooses project
named volumes so `yarn search:rebuild --profile qa --run-id <id> --persistent`
can stop Fuseki, run the offline indexer on the retained TDB2 volume, and restart
it. The test resets that project with the same options. Other QA projects keep
their disposable tmpfs overlay; a saved project refuses a storage-mode switch.
The SEARCH17 raw-import drill uses a separate persistent QA project with
`--raw-update` on every stack and rebuild command. Its mounted QA assembler
adds a bare-TDB2 update alias after search quarantine; the ordinary QA and
product assemblers do not expose that alias. A saved project also refuses to
switch raw-update mode.

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
2. **Separate setup from the tested operation.** Use public-command builders for
   small command/receipt/authority fixtures. Background volume may use a verified
   compatible snapshot or validated bulk fixture under the
   [preparation policy](../storage/workload-budgets.md#data-preparation-and-import).
   Exercise the operation under test through its actual owner boundary; bypassed
   command paths receive no acceptance credit. Corrupt state is a named fault fixture.
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
- **Synthetic corpus.** Seed and parameterize Works, Realms, contributions, raters,
  languages and the independent cost dimensions in
  [complexity verification](complexity.md). Keep small command-created fixtures,
  reusable background generations and bulk-import tests as distinct paths.
  Validate bulk data against owner/model invariants and index frontiers before
  use; never fabricate receipts to imply that public commands were exercised.
- **Reuse and isolation.** A compatible schema alone is insufficient: fixture
  provenance also includes model/source digests, index/analyzer and engine format.
  Clone verified stopped/consistent generations into isolated QA projects and
  rebind run-local identities as needed. Rebuild only invalidated fixtures.
  Snapshot reuse and bulk preparation are required follow-up harness work, not
  capabilities supplied by the current command-only `yarn load` implementation.
- **Preparation budget.** Record generation/import/indexing/validation separately
  from operation time. Use bounded parallel preparation and batched owner writes
  where measured contention permits. Do not serialize every background record
  through online admission just to obtain test volume.

## Remote data

`yarn fixtures:pull [--source wikidata]` runs adapters in
`tests/fixtures/sources/`. The first registered query is Wikidata Q42 via
[`Special:EntityData` JSON](https://www.mediawiki.org/wiki/Wikibase/EntityData/en).
It retains only the entity ID, revision and three name labels. [Wikidata
structured data is CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); the
lock records this narrow reuse basis. The adapter sends an identifying
User-Agent, handles 429/503 `Retry-After`, and spaces multiple requests at least
one second apart, following [Wikidata access guidance](https://www.wikidata.org/wiki/Wikidata:Data_access).
It makes one request during a live refresh and none in routine QA.

Other planned provider adapters remain unregistered pending an access and
retention decision for this automated fixture use. [Open Library's API
guidance](https://openlibrary.org/developers/api) favors human-facing,
low-volume discovery and dumps for bulk use. [MusicBrainz's web service
guidance](https://musicbrainz.org/doc/MusicBrainz_API) says free API access is
noncommercial and limits callers to one request per second. [Modrinth's API
docs](https://docs.modrinth.com/api/) specify a User-Agent and 300 requests per
minute, while its [current terms](https://modrinth.com/legal/terms) add use and
automated-access restrictions. [VNDB's Kana terms](https://api.vndb.org/kana#usage-terms)
describe noncommercial service use. These API conditions do not decide rights
in individual factual fields; see [source data rights](../research/source-data-rights.md).
The CurseForge API is excluded because its terms prohibit caching.

Normalized payloads are stored content-addressed at
`.cache/fixtures/<source>/<sha256>.json`. Small, reviewed projections are also
committed under `tests/fixtures/seeds/` so a clean checkout can replay without
network access. The committed `tests/fixtures/fixtures.lock.json` records source,
request URL, fetch time, SHA-256, size, seed path and reuse-basis note. Every
cache or seed read checks the locked hash and size; a corrupt blob fails.
`tests/qa/unit/fixture-pull.test.ts` consumes the real Q42 multilingual
projection offline and verifies fixture behavior with mocked HTTP responses.

`REZICS_FIXTURES` selects the mode:

- `replay` (default) checks the locked cache, hydrates it from the committed seed
  if necessary, or restores the same locked bytes from the provider. Missing
  data with `REZICS_FIXTURES_OFFLINE=1` fails with a pull instruction; upstream
  drift during restoration fails explicitly.
- `live` re-fetches and reports each digest as unchanged or drifted without
  changing the lock. `REZICS_FIXTURES=live yarn fixtures:pull --update-lock`
  accepts the current normalized bytes and atomically rewrites the lock and
  committed seed. Review the diff and reuse note before committing a refresh.

[Source conformance](source-conformance.md) cases use `live` mode in their own
tier once their stage starts.

## Load

`yarn qa --tier load` starts a disposable QA Compose project, bootstraps its real
graph and databases, starts Main as a host process, and verifies the original
empty-corpus Main snapshot. It then creates 10 Works through product commands,
with 10 Main selections, one Realm adoption, one rejected Realm candidate and
one published and projected Content variant. English, Chinese and Japanese
texts are present. A preflight verifies exact nonempty Main and Realm results,
the rejected candidate's absence and the public Content phrase result through
Main's `/v1/queries` route. The test waits for Main's Content projection cursor
to catch up before measuring, then checks the real public route under load.

The pinned `grafana/k6:2.3.0` container runs two virtual users for 20 seconds
with a 100 ms pause. A fixed 20-step wheel directs 50% of offered requests to
one hot Work, 20% to other Main Works, 20% to Realm and 10% to Content. It
requires at least 20 requests, 10 Main reads, three Realm reads, one Content
read and eight hot-Work reads. Every response must be HTTP 200 with a complete
snapshot, the expected population and exact result identity, including Realm
fallback/adoption and rejected-candidate absence. Zero HTTP failures and 5xx,
all checks passing, global p95 below 2,500 ms, Main/Realm p95 below 1,500 ms
and Content p95 below 2,500 ms are enforced by k6 thresholds.
The 3-minute test budget includes Main startup and k6 execution; Compose startup,
bootstrap and cleanup are recorded separately by the shared harness.

`.artifacts/qa/<run-id>/load/k6-summary.json` contains k6's reproducible
request, latency and check metrics; `load-cases.json` records the generated
fixture identities; `evidence.json` records empty and mixed preflight snapshots,
generator settings and selected metrics. Failed runs also keep `k6.log`,
`main.log`, the tier log and Compose logs. The own Compose project is reset by
default. This remains a partial OPS05 and SEARCH18 probe: it does not run
concurrent writes, a 10,000-Work corpus, cold-cache repeats, relay-backlog or
memory measurements. The public phrase profiles now admit up to 20,000
MatchUnits and return a budget error at the 513th raw phrase candidate.
These temporary implementation limits do not define acceptable product scale.
The numeric practical
workload objective is in
[initial host deployment](../operations/deployment.md#practical-load-objective).

The separate `yarn load` command is the practical profile. It defaults to
`--works 10000 --duration 180` and uses its own persistent per-run QA stack,
resetting its named volumes after completion, and an
`.artifacts/load/<run-id>/` evidence directory; `--works 10 --duration 10` is a
small diagnostic of that profile. It registers, claims and seals real Access admissions
while creating each Work, public Contribution and Main selection through product
commands, then adds Realm adoption/rejection and one Content variant. It
checks complete Main, Realm and Content queries after a Main restart and on
warm repeats, measures Main's
Fuseki call and byte counts through a loopback meter, and runs eight k6 readers
alongside two admitted edit/selection/rating writers. It restarts Main and its
outbox relay with Fuseki and PostgreSQL from their retained volumes, then checks
cold and warm queries and sampled heads and receipts. It records relay lag, Main
process and Fuseki/PostgreSQL container memory peaks, graph triple counts,
TDB2/Lucene bytes, and the captured phrase SPARQL with Jena's optimized algebra
for representative Main, Realm and Content queries. The algebra is a query-plan
shape, not a runtime TDB2 cost estimate.
The mixed profile records p95/p99 separately for Main, Realm and Content reads
and requires each lane's p95 at or below 1,500 ms in the full profile;
container memory records anonymous pages, file cache, peak and configured limit.
Half of the writer requests target hot writable Works, so the hot tenth of the
corpus receives roughly half of all completed requests. The 10-Work diagnostic
has no writable Work in its one-Work hot cohort; its total hot share is recorded
but only the full profile enforces the 45–55% total-request range.
The profile retains zero-5xx and exact-result thresholds during writes; a
full run also requires every write family, numeric p95/p99 evidence, no
sustained rising relay backlog at the end, and all Access admissions sealed.
The trend allows two graph positions in flight from the two writers; a temporary
spike is recorded without failing the profile if it drains.
The relay checkpoint must catch up within two minutes before the retained-data
restart. A
failure is saved with its metrics. A smaller successful run cannot qualify the
named 10,000-Work host profile. It can supply evidence for the specific correctness
or cost cases it actually asserts; size alone does not decide acceptance.

The two 2026-09-25 10,000-Work runs failed: `load-20260925t002559-e525e2`
reported 26 mixed-read failures, and `load-20260925t040916-7656b1` reported two.
Their command-seeding stages took approximately 166 and 174 minutes respectively,
before the three-minute mixed phase. This is evidence of a preparation problem
and unresolved read failures, not a qualified host profile. Preserve those runs;
diagnose the smallest reproducer rather than repeatedly rebuilding that corpus.
The clean one-worker 100-Work diagnostic `load-20260925t103002-20ef8a` seeded
in 79 seconds; four workers in `load-20260925t103223-d4dbca` took 82 seconds,
so increased seed concurrency did not improve this graph-writer path. The clean
1,000-Work diagnostic `load-20260925t103528-5a70d1` seeded in 899 seconds and
passed its 30-second mix with 389 reads, 68 writes and no HTTP/check failures.
These earlier sizes did not reproduce or waive the two transient
`search_index_unavailable` Content reads in the second 10,000-Work mix.

The retained 10,000-Work mix has 20 Main-selection writes with P95 1,601 ms
and P99 1,670 ms; the two failing Content reads were 503
`search_index_unavailable` at the same second. The route has a 1,500 ms
whole-request deadline. A native writer overlap is a plausible explanation,
not a diagnosis from these response logs. A bounded 120 ms unit race now holds
the native writer state for 200 ms and proves that the retry wait ends in a
typed timeout. Load-only Main logs record the failed read and writer-wait
attempts, their elapsed times and the terminal cause without recording the
query phrase. Two later 100-Work, 10-second mixes reproduced the boundary:
`load-20260925t112243-a396dc` had five Main/Realm 503s after two relation
position movements and a third attempt during an active native writer;
`load-20260925t112646-7977c5` had one Content 503 after two audit position
movements and the same third-attempt overlap. These are live small-scale causes,
not retrospective proof of the earlier 10,000-Work failures. Simple Main/Realm
relations now accept a later coherent metadata graph cut if the native index
epoch stayed fixed. Content's complete audit may also use a later cut, then pins
its phrase relation to that audited sequence and still checks the Content source.
`load-20260925t113037-83d446` passed 129 reads and 22 writes with zero HTTP
or exactness failures; Content P95 was 291 ms. A single short pass does not
qualify the 10,000-Work profile or eliminate a rarer race. A later profile
`load-20260925t144930-fe506d` with a 9,900-Work stopped background reached
2,378 reads and 402 writes, then failed one Content read after three native
index movements (139, 124 and 97 ms). Its exact retained log showed the
third-attempt ceiling rejected a read inside the 1,500 ms wall budget. The
route now retries only proven movements until the shared wall and Fuseki call
and byte budgets expire. The clean merged `2f9a0ed` tree passed full `yarn qa`
`20260925t151147-02d115`, then the separate 10,000-Work practical profile
`load-20260925t160348-90e989` passed from the stopped 9,900-Work source and
100 fresh admitted Works. Its 180-second mix completed 2,376 reads and 394
writes at 15.39 requests/s with zero HTTP, exactness or writer errors; read
p95 was 154 ms and Content p95 was 316 ms. Zero relay lag, sampled exact
heads/receipts, cold and warm cases after storage restart, 10,004 MatchUnits,
and stable source and physical compatibility are retained in its run and
evidence files. This qualifies that host objective only.

For reusable background preparation, a stopped-state
clone of a command-seeded baseline preserves exact Work/Contribution
revisions, receipts, Access state, Content positions and the matching TDB2 and
Lucene bytes. A deterministic bulk importer remains an alternative if the
clone cannot be rebound safely or takes too long. The 100-Work falsifier stopped
the source and copied its whole PostgreSQL, Fuseki TDB2/Lucene and RustFS
volumes plus immutable objects into a distinct QA project. `stack:clone`
checked the retained source fingerprint, schema/model/analyzer inputs and
actual Fuseki image ID, kept owner credentials and graph lineage with fresh
loopback ports, and refused a live source or existing target.
`clone-image-b` passed seven cold query cases, nine sampled exact receipts and
an exact Content revision, then created ten disjoint-token Works in 12.4 seconds
through fresh Access admissions and product commands. Its 48 admissions sealed;
the clone had 114 MatchUnits and two Content search units after a cold storage
restart. The source remained at graph sequence 442 while the clone reached 493.
The retained probe is `.artifacts/load-clone/clone-image-b/evidence.json`;
the source read-only check is under the source run ID. An unrelated saved
Mailpit port collision prevented a complete `stack:up` of the source during the
isolation check, but its PostgreSQL/Fuseki services were running and all seven
source reads, receipts and exact Content bytes still passed. The source and
clone volumes were reset after this falsifier. Initial command seeding still
took 91 seconds for 100 Works; the runner has no preparation-only baseline or
clone-consumption path yet. Those must be added before a retained 10,000-Work
profile can benefit. Expired baseline grants, larger clone time and 10,000-Work
read/write behavior remain untested. [PostgreSQL 18 file-copy requirements](https://www.postgresql.org/docs/18/backup-file.html)
require a stopped whole cluster for an ordinary filesystem copy. [Jena TDB2
loader guidance](https://jena.apache.org/documentation/tdb2/tdb2_cmds.html)
and [jena-text index construction](https://jena.apache.org/documentation/query/text-query.html#building-a-text-index)
support the alternative offline import path but do not establish its speed or
REZICS semantic compatibility.

Routine performance verification follows [complexity verification](complexity.md):
derive costs, vary small independent dimensions and assert observed work in the
owning QA tiers. The existing load runner has only partial traffic/delta counters;
it does not yet enforce all cost contracts. The separate host profile is required
only when claiming its [deployment objective](../operations/deployment.md#practical-load-objective),
not before every backend batch. Reusable preparation must be implemented before
another large run is used as a routine gate. Actual production capacity remains
a separately scoped qualification; neither 10 nor 10,000 Works proves it.

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
declared and every mapped test passes. `SYS02` currently has a complete-case
declaration for its live lost-response fault test; other named tests remain partial
until their scenarios are reviewed and declared. IDs with no
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

The legacy `services/main/tests/{activate,edit,full-work,outbox,recovery}.integration.test.ts`
files still spawn a host Fuseki/JVM and require `REZICS_FUSEKI_HOME`,
`REZICS_JENA_HOME` and `REZICS_JAVA_HOME`. They remain runnable as owner tests
with those paths set, but are excluded from the QA tier registry until their
scenarios move to the containerized harness. Their historical partial assertions
do not certify acceptance IDs; the inventory continues to show the missing
complete-case evidence as partial or uncovered. The shared-stack integration
journey already exercises an authenticated Work edit through Main, but does not
replace the legacy race and restoration scenarios.

The shared-stack `coordinated-owner-cut` fault test splits out the signed
Account/Access/Content/graph capture and fail-closed mixed-cut gates with real
OAuth and exact Content bytes. It takes a physical backup after the held cut,
using local replication inside its disposable QA PostgreSQL container. It
replays the included WAL into a distinct PostgreSQL 18.6 instance, checks three
altered-owner cuts and releases the graph only against the matching replay copy.
The original QA PostgreSQL source stays fenced. The older owner's broader
post-cut receipt replay remains outside this split case.

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
