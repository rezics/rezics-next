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

The Event observation command bounds each graph update to one event-time slot
and one receipt/outbox effect. The Event query has a structural synchronous
contract: 2,000 source slots, 50 returned events, eight topic Statements and
732 emitted histogram buckets maximum. `services/main/tests/event-time.test.ts`
checks those caps and the precision algorithm. Real-owner integration and
recovery probes exercise Account, Access, Content, Main and Jena outcomes,
including concurrent corrections; they do not meter remote attempts and bytes,
Jena physical work, Access SQL plans or concurrent write costs. The query still
reads the bounded source corpus for a stale generation and re-verifies immutable
manifests. These static bounds and selected probes are not measured-cost
qualification.

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

### Public Work search hydration and title conjunction

The public Work title/body profile has two independent Lucene probes capped at
513 raw hits each, one joined ARQ relation capped by the same one MiB response
limit, at most 512 accepted units, and the shared 1,500 ms, 72 Fuseki-call,
8 MiB request ceilings. The title field lives on an already eligible public
MatchUnit; unrelated label resources cannot grow its candidate population.
The exact supporting-Statement hydration uses one bounded decision/support
association read and one owner `VALUES` batch read for at most 512 active public
IDs, plus the owner's graph-admission guard. Both reads have a one MiB response
ceiling; a 513th support is a typed budget outcome. At most 512 Access judgment
checks run in batches of 16 under the same request deadline. A bearer read
does two bounded Access mute-list reads (at most 256 rows each), one graph author
batch for at most 512 Contributions when author facts are needed, and one
bounded Access membership batch for only the active muted Realms and returned
authors. The final mute-list read rejects a concurrent revision change.
These are logical limits; native Jena work, SQL plan rows and title-index update
fanout still need measured qualification across unrelated corpus, affected units,
author membership degree and common rejected terms.

Context interpretation takes two graph-position reads around at most one
speaker-selection read, one Global-head read and one bounded inherited-chain
read. A changed graph position makes the resolution unavailable rather than
returning a mixed semantic basis. The public Statement owner reads at most 512
exact IDs in one query, with at most eight interpretation definitions and eight
applicability values per Statement; an absent or Private basis invalidates the
batch. Graph relation reads check up to eight explicit participant constraints
with Access before their role/text match, in addition to the anchor and at most
65 discovered occurrence/target candidate proofs. Discovery of unknown
occurrences still precedes their Access proof; the bounded frontier must not be
presented as an exact complete count. The relation response labels its count
`lower-bound` whenever a raw candidate page reaches the 65-row probe or more
visible edges need another page; only an exhausted admitted page is `exact`.

The public disclosed-field phrase profile accepts at most eight Contexts, 16
Statements and 32 Resources. Its owner permits at most 64 summary targets, 32
judgment checks, two media batches and one MiB of admitted field output. The
route composes those bounds with the shared public search limit of 72 Fuseki
calls, 8 MiB read bytes and 1,500 ms; an over-budget owner read is unavailable,
not an exact empty relation. Matching and the three facet counts scan only the
admitted field list once. The public route integration checks that adding a
Private Context changes none of the hit, score or facet values; native owner
tests cover protected Statements, restricted names, avatars and recovery.

The grouped Statement phrase profile accepts at most two Context-resolved
conditions, 20 discovered occurrence/Statement pairs, 40 occurrence/participant
Access proofs, 20 distinct direct acceptance reads, 20 protection checks and one
owner batch of at most 20 public Statements. The 21st raw pair returns 422
without a count or facet. One full selected-body relation and one bounded
structural discovery query precede admission; one final graph-position read
fences the result. The shared route budget is 72 Fuseki calls, 8 MiB read bytes
and 1,500 ms, with typed budget/deadline outcomes. After hydration, grouping is
at most 20 rows; two facet passes compare at most 2 × 20² rows and return at
most 20 values per facet. The native fixture verifies one owner batch, exact
Work/fact/support counts, default and self-filter facets, qualification changes
and the 21st-row budget. Independent corpus, affected-set and degree variation
and native engine work measurements remain SEARCH07 qualification work.

### IAM07 media download stream

`GET /v1/media/assets/{asset}/bytes` is bounded to one current avatar-slot basis,
one Access admission/revalidation, and at most 8 MiB of verified object bytes.
The media body emits 64 KiB chunks. Access admits no more than 256 pending reads
per scope or principal, and strong revocation rejects drain lists above 256.
`tests/qa/integration/access-download-api.test.ts` checks overlapping streams,
terminal outcomes, and the pending/revocation indexes; the operation's SQL and
application bounds are recorded in `services/main/src/modules/access/download-cost-contract.md`.

### SYS06 revocation fences

Each source-acquisition request performs one indexed active-principal lookup
before the bounded run and one after it, independent of capture count; an exact
replay makes no provider call. A protected source-run read performs one active
principal lookup before returning its bounded result. The export read and
package-install activation each make one initial lookup and one final fence
lookup. The export's final lookup follows exact source and disclosure
revalidation, immediately before the saved manifest is returned.
`tests/qa/fault-recovery/sys-revocation.test.ts` instruments the real
Access registry around the QA database and asserts those fixed lookup counts,
while barriers revoke the principal during provider I/O, export source
revalidation and an installation hook. It also checks that export bytes are
withheld, a staged package remains unmounted, and authorized recovery reuses the
same acquisition receipt or installation generation. This bounds added Access
checks independently of provider or package input size; it is not a latency or
database-plan measurement.

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


### COMP03 staged Structure activation

`POST /v1/compositions/{structure}/stages/{stage}/activate` materializes at most
4,096 records, reads the immutable record/order trees once per activation attempt,
checks distinct resource targets in pages of at most 100, and writes at most 30
placements per graph receipt. Each receipt validates at most 92 Structure focuses
(generation/revision on the first batch, occurrence and placement per record,
and one segment per touched segment). Content advances a monotone projection
checkpoint only after a committed graph receipt. A retry may replay the receipt at
the current checkpoint; it must not duplicate triples or advance twice. The final
head switch is one guarded graph receipt after all pages, so partial projection is
never visible through the selected generation. `GET` returns `projectionBatches`
and the final command cost; the COMP03 integration test injects a second-batch
failure after one committed page, resumes it, checks all 64 placements, and then
cancels a second partially projected stage while asserting the prior head remains.
