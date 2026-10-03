# Complexity verification

The [workload policy](../storage/workload-budgets.md#complexity-contracts)
defines cost contracts. This guide describes how to challenge a bound with
real work measurements. Passing scales can falsify a bound, not prove capacity.

## Inventory and coverage

For each changed API operation, job, import, rebuild or recovery path, identify
its cost contract, alternate branches and measurement test. Compose helper
costs with caller loops, fanout and retries. Record missing contracts or
unobserved costs; neither a route count nor a mock counter closes the gap.
The first backend phase measured selected OPS05,
SEARCH18 and REC02 paths; remaining paths rely on written derivations. A full
executable inventory, complete performance verification and the 500-million
entity boundary remain later work.

## Observe work before timing

Derive expected growth by input dimension before measuring. Count application
visits, comparisons, bytes, retries and scheduled effects; remote attempts and
bytes; changed rows, triples and index units; and worker progress and backlog.
Use test-only PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON,
TIMING OFF)` on isolated data. Interpret loops and inclusive counters without
double counting. Inspect native Jena/Lucene scans, candidates and updates;
ARQ algebra, HTTP size and latency do not expose physical work. Prove a counter
detects a known expensive case before trusting its zeros.

The [Fuseki load meter](../../scripts/load/measurement.ts) observes HTTP calls,
body bytes and selected inventory/delta requests. It does not observe native
Jena operators, SQL plan rows or traffic through other owners. These remain
unobserved even when a logical request budget passes. Extend the operation's
owner instrumentation and tests when claiming those physical bounds.

## API request work profiles

Decision, maintainer, 2026-10-03: qualify the API's own work first. Page rendering
and the web server's fan-out remain a separate follow-up; this method does not
instrument the web application.

[`profileRequest`](../../tests/qa/support/work-profile.ts) assigns a fresh sampled
W3C parent, consumes the operation through a caller callback, and collects its
server span and descendants. Assert the correct response in that callback.
The profile counts Fuseki attempts, PostgreSQL query spans, Account calls, Main
calls and other outbound fetches, and reports server and caller latency. It
also retains each Fuseki call's bytes, headers/body-consumption timing and
optional engine time, and each PostgreSQL statement's operation and duration.
It deduplicates exporter retries and excludes sibling requests sharing a trace.
Latency is not a sum of overlapping child spans.

For isolated integration tests, start `startWorkProfileSink`, pass its `env` to
each process, and initialize telemetry before importing `pg`. An in-process app
must import its database/application modules dynamically after `startTelemetry`;
`flushTelemetryTraces` drains completed spans without stopping that app. Existing
QA files often import `pg` before test setup: use a child process, as the
[calibration probe](../../packages/observability/tests/work-profile-child.ts)
does, rather than trust a zero statement count. The sink requires a loopback
bearer header, retains bounded data and fails on overflow or absent exports.
Each request waits for its server span and a quiet export interval; this is a
bounded collection window, not proof that a producer never dropped a span.
Keep the calibration probe in the owning qualification run.

Against a running stack,
[`aspireWorkProfileSource`](../../tests/qa/support/work-profile-aspire.ts) reads
the dashboard's [whole-trace API](https://github.com/microsoft/aspire/blob/main/docs/specs/dashboard-http-api.md),
including Account descendants. Supply the discovered dashboard origin and API
key through local configuration. It refuses truncated responses, missing traces,
authentication errors and TLS failures; do not disable certificate verification.
No live Aspire run has been qualified by the helper's wire-contract tests alone.
Old producers without peer tags require the explicit `peers` origin map;
unclassified fetches cannot pass a storage-call assertion. Missing Account/Main
server descendants also invalidate an asserted aggregate statement bound.

Fuseki response bytes are counted as the consumer reads, with no tee or eager
drain. These are decoded body bytes; HTTP headers, compression and TLS bytes
are outside the count. An unread, cancelled or failed stream is not a complete
byte measurement. Unknown lengths and absent engine timers become `null`.
`assertWorkCost` rejects unknown measurements for an asserted field, and accepts
successful HTTP responses by default; pass explicit `statuses` when measuring
a denied/unavailable branch. `assertWorkCostAtScales` applies the same absolute
caps to at least three profiles. Result correctness, completeness and declared
partial outcomes remain the operation owner's assertions.

The runtime and [meter](../../scripts/load/measurement.ts) accept only a numeric
`Server-Timing: jena;dur=<milliseconds>` as native engine timing; no description
is exported. The current pinned Fuseki does not supply that timer. Engine time
therefore remains unobserved, even when HTTP time and byte measurements pass.
Adding a native timing producer belongs to the Jena owner. The meter's
`beginTraceCapture`/`endTraceCapture` groups buffered request observations by
W3C trace/span IDs; `timingSnapshot` keeps HTTP time separate from engine time
and returns an unknown aggregate if any timer is absent.

[`captureFusekiPlan`](../../scripts/load/fuseki-plan.ts) reuses the practical
load runner's pinned `arq.qparse --explain` path in an offline container, with
no live database mount. It retains the captured query, digest and optimized
algebra in explicit local diagnostic files. Jena's
[explanation facility](https://jena.apache.org/documentation/query/explain.html)
describes query preparation; this is not a runtime TDB2/Lucene physical-cost
plan. Query literals stay out of OTLP and routine logs. Native operator visits,
SQL rows/buffers/WAL and work outside the request's trace remain unobserved.
`captureFusekiQueryPlan` pairs a captured query with its original SPARQL JSON
response and retains its reported `candidateCount` values and returned binding
count. Repeated metadata counts once. Missing counters remain unknown; an empty
page does not imply zero text-index work. These counters describe the query's
reported candidates, including any probe cap, rather than native Lucene visits.
The meter retains that response only when explicit query capture is enabled.

[`work-profile-corpus`](../../scripts/load/work-profile-corpus.ts) defines three
diagnostic scales for unrelated Works, unrelated posts, follows, memberships,
history depth, Realm size and Concept vocabulary. Change one dimension and hold
the others fixed.
Scenario owners supply their existing public command flows and read-back
verification, including publication, membership consent and expected heads.
History revisions run serially; independent entities use two seed workers.
Stable dataset identities include the recipe version and every dimension;
retained manifests also check the existing load model/schema/engine compatibility.
Preparation verifies all dimensions before retaining a stopped backup; later
runs restore distinct writable copies. Bind the backup driver to the existing
fixture/load backup and restore workflow, never copy live storage. Include
startup/readiness in `startedAt`; preparation and restore each abort at 600
seconds. The scale constants are diagnostic recipes, not evidence that every
owner's command corpus already prepares under that ceiling. Qualify the actual
recipe's preparation time and isolated restore before retaining its dataset.

Large command corpora use `REZICS_QA_STACK_MODE=scale`: one setting chooses
persistent disk volumes, a 1,536 MiB JVM heap, a 512 MiB direct-memory cap and
a 7 GiB Fuseki container limit. Ordinary integration shards retain tmpfs,
512 MiB heap, 128 MiB direct memory and a 2 GiB container limit. The
[catalogue recipe registry](../../scripts/qa/stack-environment.ts) selects scale
mode before starting the G-1031 write probe and G-1032 preparation probe;
the shard planner gives these recipes separate projects. Other scale probes
can select it explicitly:

```sh
REZICS_QA_STACK_MODE=scale bun scripts/goal/goalctl.ts test tests/qa/integration/g-1032-query-cost.test.ts
G1031_SCALES=100,1000,10000 bun scripts/goal/goalctl.ts test tests/qa/integration/g-1031-catalogue-write.test.ts
```

[`task load`](../../scripts/load/cli.ts) always selects the same scale allocation.
`REZICS_QA_FUSEKI_MEMORY_LIMIT` and `REZICS_QA_FUSEKI_JVM_ARGS` override its
allocation; new persistent projects save those settings, and later process
environments cannot replace the saved project allocation. Use a new run ID
when changing storage mode. Scale fixture stacks retain QA mutation endpoints;
command-only native qualification retains the product assembler instead.

Disk backing addresses a specific resource defect:
[Docker tmpfs data counts against the container memory limit](https://docs.docker.com/engine/storage/tmpfs/),
while [TDB2 grows between compactions](https://jena.apache.org/documentation/tdb2/tdb2_admin.html).
Increasing tmpfs capacity cannot supply additional RAM. The selected allocation
is a local diagnostic recipe, not a production capacity qualification or an
extension of the 600-second preparation ceiling.

The [catalogue write probe](../../tests/qa/integration/g-1031-catalogue-write.test.ts)
profiles each of the four public Work commands and a classification decision.
Unparented preparation is unsampled; measured requests carry sampled parents,
and PostgreSQL loads after telemetry. It keeps real command retries, relay
settlement and exact selected-content checks. The larger requested scales fail
on the preparation deadline rather than substituting raw background rows.
Its command allowance is at most 400 seconds, reduced by startup/bootstrap
time when needed to leave 60 seconds for shutdown within the 600-second total.
Relay settlement time is recorded separately from the sampled API requests.
[`qaTdbStorage`](../../scripts/load/tdb-growth.ts) observes logical file sizes,
allocated filesystem blocks, Lucene files and cgroup memory around separate
32-write cohorts, without another JVM opening the live database. Logical sizes
alone can miss updates within preallocated files; allocated-block deltas are
also coarse and include retained generations. Lucene merges can reduce its
cohort delta. Native validation, indexing and commit phase times remain
unobserved until the engine supplies their timers. Filesystem growth and HTTP
duration cannot establish those phase costs.

[`seedPublicProfileWork`](../../scripts/load/work-profile-work.ts) provides the
Work dimension's real authoring, publication and selection sequence. The
integration calibration grows 4, 16 and 64 public selected Works, checks every
selected body and the real text-index candidate count, and records preparation
time separately. It does not qualify physical backup/restore or the other axes.

The [unit calibration](../../tests/qa/unit/g-1024-work-profile.test.ts) and
[real-engine calibration](../../tests/qa/integration/g-1024-work-profile.test.ts)
deliberately execute 1, 4 and 9 Fuseki queries and PostgreSQL statements, assert
the returned rows, and verify that a three-call cap fails. Run both through
`bun scripts/goal/goalctl.ts test <file>`; the integration file uses isolated
real PostgreSQL/Fuseki. These are counter checks, not feed/search qualification.

## Small multi-scale experiments

1. Hold other dimensions fixed while varying unrelated corpus size, affected
   set, hot-node degree, common rejected candidates, history and body size.
2. Include empty and boundary inputs, cold and warm plans, invalidated caches,
   skew and concurrent contention where the operation admits them.
3. Assert correct results alongside work counters. A blanket rejection,
   truncation or temporary corpus cap cannot pass a valid-input growth check.
4. Compare measured work to the derived bound and declared slack; use absolute
   caps for fixed limits. Seed generated sequences and retain the smallest
   counterexample, source, dimensions, plan and oracle in QA artifacts.

## Execution and failure handling

Run the owning tests through `task test`; engine claims need the real engine.
The load tier checks latency and contention, not every cost. Restore background
data under the [preparation policy](../storage/workload-budgets.md#data-preparation-and-import)
and measure setup, operation and cleanup separately. On a growth failure,
reproduce the smallest case, inspect actual plan work and repair neighboring
cases. Preserve explicit unavailable outcomes and safe receipts when a budget
expires. Changes to cost constants need a measured reason; do not rewrite a
failing baseline to match current output.

Logical bounds live with the owners: [public search](../../services/main/src/modules/work/search-readiness.ts),
[Statement batches](../../services/main/src/modules/statement/read.ts),
[media downloads](../../services/main/src/modules/access/download-cost-contract.md)
and [Structure activation](../../tests/qa/integration/structure-stage.test.ts).
The [revocation fault test](../../tests/qa/fault-recovery/sys-revocation.test.ts)
checks fixed Access lookup counts, not SQL or latency. SEARCH07 native work,
title-index fanout, SQL plans and cross-owner remote bytes still need measured
qualification. [Deployment](../operations/deployment.md#practical-load-objective) has a separate capacity gate.
