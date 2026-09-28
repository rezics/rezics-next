# Discovery projection

Discovery owns a separate generation because recommendation scores aggregate
different signals. Its population, ordering and response bounds live in
[`contract.ts`](contract.ts); source admission lives in [`source.ts`](source.ts).
The rating and classification owners retain their existing meaning, protection
checks and evidence limits. Display hydration belongs to the browse read, so a
build does not load titles, covers, metadata, language selections or serial counts
unless a classification owner needs them for its own verification.

## Operating a build

The typed `/v1/discovery` management operations require `work:read`. Shared builds
also require the Access recommendation-management grant. Mine always belongs to
the authenticated Account principal, independently of its acting Agent.

1. Register `generation-builds` with an idempotency key and a basis. Select an
   explicit standing rating Context for top-rated or Mine.
2. Advance the returned generation with its last checkpoint until complete.
   Management advances one candidate at a time; the scheduler uses bounded
   batches. A checkpoint race returns 409. A process lost during a step leaves a
   30-second lease, after which another process can resume.
3. Activate with the returned `activeHeadRevision` and a new idempotency key.
   Activation compares the head revision atomically. A completed generation
   retains its original source cut even when subsequent writes have occurred.
   Recovery boundaries and inactive Mine principals still prevent activation.

The scheduler enrolls public browse populations and standing Contexts after the
Main relay acknowledges the current graph cut. Existing operator-managed bases,
including Mine, enroll on activation. GET never starts a build. Check the queue's
`last_outcome`, `attempts` and `last_duration_ms` when diagnosing a delayed refresh;
timing and work limits are defined in [`refresh-store.ts`](refresh-store.ts).

## Why reuse is conservative

[`changes.ts`](changes.ts) requires contiguous outbox batches, complete event
counts and ordinals, and a known command whose discovery effects belong to one
Work. Gaps, unknown commands and cross-Work definition/protection changes cause
a full rebuild. Access source-fence changes also prevent reuse. A changed Work
that is no longer public is removed from the new generation.

Reuse copies unchanged SQL entries and hydrates only changed Works. The copy is
bounded by `DISCOVERY_COST.reuseEntries`; larger populations use resumable full
builds. This preserves the existing immutable generation and cursor semantics
without introducing chains of dependent projections. It saves graph work, but
still performs O(entries) SQL work within that fixed copy bound. Frequent writes
and five-minute row retention need separate storage-capacity qualification.

A partial build can survive new-Work creation: complete outbox coverage proves
that all intervening changes affect Works born after its cut, and enumeration
excludes those births. It restarts for changes to existing Works because separate
Fuseki HTTP queries do not share a retained transaction. This follows Jena's
[remote transaction boundary](https://jena.apache.org/documentation/rdfconnection/#remote-transactions)
(consulted 2026-09-28). Rows commit only after the read envelope validates its
graph, principal, Realm and source-attribution fences. A moved read releases its
own step lease and retries promptly; it cannot publish mixed-position rows.

Completed generations may activate while newer changes wait for the next job.
Browse responses mark old generations `stale`; current disclosure checks still
filter Works, and stale classification/credit payloads are withheld. An absent
generation returns 503. A retained cursor may continue through ordinary writes;
an expired or recovered basis requires a restart. These are retained projection
rows, not retained authorization.

## Measurements and limits

The G-362 pre-change refresh fixture (QA `20260928t031801-3bc7ce`) measured 40
ticks, at most 28 graph queries and 411 ms per measured tick, with one Work per
tick. After the change, the corresponding refresh fixture (QA
`20260928t033429-f9d5a9`) measured 14 ticks, at most 16 queries and 149 ms per
measured tick. It exercises real relay delivery, Context enrollment, ratings,
credits, Access invalidation, activation recovery and Mine isolation.

The native load probe (QA `20260928t034147-00045f`) rebuilt 10,000 public Works in
33.534 seconds (221 graph queries, 40 ticks) and refreshed one changed Work in
721 ms (five queries, including the scheduler delay). It asserts targets of
60 seconds and one second. That fixture uses one semantic type, no classification
or credit fanout and no rating Context; it qualifies this projection workload,
not dense rated/classified populations or the full retained medium corpus.
Fixture creation is outside the measurement. The executable probe and its
measurement artifact are owned by `tests/qa/load/discovery-build.test.ts`.

One-Work deltas embed their exact Work IRI in graph patterns: an outer `VALUES`
binding alone caused ARQ to traverse the public population before joining it,
taking about 765 ms for that single-Work query in the 10,000-Work fixture.
Candidate scans for full builds can still scan/sort the Work population and do
not claim indexed keyset complexity. The existing browse seek-plan test covers
both orders and all equality-filter combinations over 20,000 synthetic Works.
The graph read envelope and owner evidence limits remain enforced; a source
that exceeds them withholds the build instead of publishing a partial population.
