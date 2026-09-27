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
