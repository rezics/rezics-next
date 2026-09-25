# Complexity verification

The [workload policy](../storage/workload-budgets.md#complexity-contracts) owns
the cost contract. This page owns its test method. Use the existing Bun,
fast-check, native database and QA tools; no new benchmark platform or language
migration is selected. The method is required for implementation but is not yet
a complete executable gate. Extend the harness alongside each affected operation.

## Inventory and coverage

Map API route profiles and registered jobs/import/rebuild/recovery entry points
to their owning acceptance cases and cost contracts. Add coverage for new entries
and for alternate execution branches, including no-match, denial, stale state,
retries, cache misses and error recovery. A route count or code-coverage percentage
does not demonstrate cost coverage. Shared helpers can reuse a reviewed bound,
but callers must compose it with loop counts, fanout and retry limits.

Extend the existing QA inventory to report missing contracts, unobserved costs
and failed bounds. Until this check is implemented, the batch review records
those gaps explicitly; no automatic coverage is claimed. New/changed operations
need their cost checks with their implementation. Review unchanged legacy paths
incrementally; remaining required gaps block final qualification, not unrelated
scoped work. A missing estimate must never become an assumed constant-cost pass.

## Observe work before timing

Prefer counters independent of machine speed. Use shared adapters and native
instrumentation, with import-boundary checks preventing unmetered bypasses.
Verify observation with a known expensive counterexample; a counter that always
reads zero cannot certify an operation. Counters in mocks do not measure engines.

| Boundary | Observation and limits |
| --- | --- |
| Application | Elements traversed, comparisons, input/output bytes, allocations where observable, retries and scheduled effects. Shared request budgets include nested calls. |
| PostgreSQL | Test-only EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON, TIMING OFF), actual rows/filtering and loops, buffer traffic and temporary spill. Interpret per-node averages and inclusive counters; do not sum parent/child work twice. Run mutations only on isolated fixtures. |
| Jena/Lucene | Native execution plan/order plus counts at the relevant scan, candidate, expansion and index-update boundaries. ARQ algebra and HTTP result size alone do not expose all physical work. Uninstrumented internal work remains unknown. |
| Remote calls | Actual attempts and bytes across Account, Access, Content, graph and objects, including retries. Fixed HTTP count is only one bound. |
| Writes and workers | Modified rows/triples/index units, events and bytes per changed object; batch progress, repeated reads, service rate and backlog age. Separate ingestion from downstream cost. |

The current Fuseki adapter has call/byte/deadline budgets, and the load meter
counts Main-to-Fuseki traffic and some full-inventory/delta operations. SQL/native
operator coverage and operation-wide enforcement remain incomplete. Extend those
owners rather than creating a separate tracing service for this gate.

## Small multi-scale experiments

1. Derive the bound and its assumptions before choosing fixtures or thresholds.
2. Use geometric scales such as 100, 1,000 and 10,000, chosen to expose the path
   cheaply. Vary one dimension while fixing the others. Add unrelated corpus
   growth, hot-node degree, common-term candidates rejected by eligibility,
   history length and body size where relevant.
3. Include skew, empty/missing matches, first/last pages, cold/warm caches,
   invalidated caches and values around algorithm, budget and plan boundaries.
   Prepared/custom SQL plans and changed selectivity may need separate cases.
4. Assert correct results as well as costs. Ordinary valid cases must succeed;
   blanket rejection, truncation or a temporary corpus cap cannot pass a growth
   test. Separately verify explicit unsupported-input/budget outcomes.
5. Compare work to the declared bound with justified constants and slack. Use
   absolute caps for fixed counts; inspect growth across scales for variable
   work. Do not classify Big-O from a few latency ratios or planner cost units.
6. Use seeded fast-check data and operation sequences to find counterexamples
   and shrink them. Retain the dimensions, seed, source, counters, relevant plan
   and result oracle in the existing QA artifacts.

For example, with result count and body size fixed, increasing unrelated N must
not cause a historical-version loop or one remote call per unrelated record.
Growing a result batch k may legitimately increase serialization by O(k); a
sort may require O(k log k). A full import grows with total input, but each
bounded batch must not restart from the beginning of the corpus.

Small experiments can falsify a claimed bound; passing them is not a proof for
all inputs. Review the derivation and access paths, and keep black-box assumptions
visible. Plan changes, disk spills and contention need selected larger or
concurrent probes when small cases cannot expose them. Physical capacity and
recovery time remain a separate [deployment gate](../operations/deployment.md#practical-load-objective).

## Execution and failure handling

Run these cases in existing unit/integration/model/fault tiers through `yarn qa`;
there is no new standalone command. Pure algorithm counters belong in unit tests;
engine claims require the real engine. The load tier remains a bounded latency
and contention check, not the sole complexity test.

Reuse compatible fixtures under the [data preparation policy](../storage/workload-budgets.md#data-preparation-and-import).
Measure preparation, operation and cleanup separately. Slow setup needs diagnosis:
distinguish fixture orchestration, online command cost and native engine work
before attributing it to the runtime or raising a timeout. For a growth failure,
reproduce the smallest counterexample,
repair it and its neighboring cases, then use the normal merged QA cadence.
Do not rerun a full 10,000-Work command seed to diagnose a local cost regression.

Inspect plan properties and work, not an exact serialized-plan snapshot: a small
table scan can be appropriate, while an index scan over most entries can be
expensive. Reject unexplained growth, not every plan-name change. Cost constants
and guard changes need a reviewed rationale; never regenerate a failing baseline
to match the implementation. Exceeding a runtime budget must preserve safe
transaction/receipt outcomes and explicit incomplete/unavailable responses.

## Tool evidence

Reviewed 2026-09-25: [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html)
provides machine-readable plans and executed metrics;
[Jena explain](https://jena.apache.org/documentation/query/explain.html) distinguishes
algebra rewrites from runtime optimization and warns about logging overhead;
[ARQ execution extension points](https://jena.apache.org/documentation/query/arq-query-eval.html)
are candidate instrumentation boundaries, not an implemented counter suite.
[fast-check](https://fast-check.dev/docs/introduction/why-property-based/) supports
generated counterexamples and shrinking.

[Infer Cost](https://fbinfer.com/docs/checker-cost/) can infer symbolic bounds for
supported Java and C-family code, but unknown calls and recursion limit it; it
does not verify the TS-to-database path. It is not adopted. There is no selected
tool that automatically proves end-to-end asymptotic complexity. Keep derivation,
executed counterexamples and production capacity claims separate.
