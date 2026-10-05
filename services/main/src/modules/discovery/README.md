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
   Advances use bounded batches (250 candidates, or 64 with a rating Context).
   A checkpoint race returns 409. A process lost during a step leaves a
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

## Refresh effects and retained cuts

[`effects.ts`](effects.ts) classifies every owner relay action; a registry test
requires an explicit classification for newly registered actions. Both the
retained relay reader and graph fallback require contiguous batches, complete
event counts and ordinals. The fallback reads Work/Context identities from the
terminal receipt as well as the event, and rejects conflicting fields.

- Unrelated events advance the serving generation's coverage watermark without
  allocating a generation or hydrating Works. This includes follows, Zone/theme
  presentation, content bodies, staged structure projection, empty composition
  creation, sealing and measurement changes. Account creation/assertion refresh
  no longer advances the global Access fence.
- Work creation/editing, publication selection and classifications refresh their
  explicit Works. A rating observation affects only its standing Context;
  unranked bases ignore it, and Mine additionally matches its exact person slot.
  Mine ignores classification/semantic changes because it has no tag population.
- Named scope-wide changes include classification/semantic definition and rule
  changes, model cutovers, identity merge, source-conversion attribution,
  erasure, opaque composition changes/activation/restore and safety fences.
  Rating policy changes affect their Context; Realm policy changes affect their
  Realm. Gaps, unknown actions and exceeded delta budgets also require a full
  pass. Composition receipts do not yet prove a bounded membership delta, so
  even a harmless label/move inside `composition.change` uses that conservative
  fallback. This is a remaining owner-event precision limitation.

Access source writes (judgment votes and spoiler hints, moderation enforcement,
principal deactivation and rating inventory repairs) append one row per
transaction to `access.discovery_source_change` and never lock
`discovery_source_fence`. Registration folds the committed rows into the
revision its basis records; the basis stays current while that revision is
unchanged and no row remains. Batches and reads take no fence lock, so a vote
never waits for a build or a build for a vote. A change that commits during a
batch, including one from an older transaction, outdates the generation at the
next check (`tests/qa/integration/source-fence-concurrency.test.ts`).

[`versions.ts`](versions.ts) replaces only changed Work posting lists and affected
term/Concept counters. Logical generations share a storage root with validity
intervals; reads bind the storage root and immutable version already loaded with
their generation, without recursive generation chains or catalogue copies.
Logical-id SQL adapters resolve those fields together for other SQL consumers.
Work updates use partial live-row indexes; cursor reads retain the original version. Concept
counts reduce distinct Concepts per Work, including tags beyond the three-card
display limit. Cancelled staged deltas restore their older intervals before a
later delta can reuse the root.

A running scan keeps its population checkpoint when the graph moves. Later births
remain outside its pin, while a durable, bounded changed-Work journal records
every validated interval. On finishing the scan, it reconciles those Works at a
new fenced cut before becoming ready. A named scope-wide change finishes the
scan and then starts a full pass at the newer cut. Separate Fuseki HTTP queries
cannot retain the old mutable heads across batches; this follows Jena's
[remote transaction boundary](https://jena.apache.org/documentation/rdfconnection/#remote-transactions)
(reviewed 2026-10-04). The journal-and-reconcile approach is our consistency
strategy, not a retained remote transaction. Rows commit only after the read envelope validates its
graph, principal, Realm and source-attribution fences. A moved read releases its
own step lease and retries promptly; it cannot publish mixed-position rows.
Recovery, source-profile and Access safety invalidation still close obsolete
work that cannot safely activate.

Global browse/rating jobs use a separate indexed due lane. Eight foreground
claims alternate with one background opportunity; idle foreground jobs poll
after one second, background jobs after 30 seconds. Queue length does not add
idle Realm batches to a foreground claim. Every tick also purges at most 1,000
posting rows, 1,000 term rows and 1,000 Concept rows from one due retirement.
Six minutes cover cursor retention plus in-flight reads. Failed/cancelled,
expired and superseded projection metadata is removed when no longer referenced;
one storage root remains for its live logical generations. Immutable derived
activation/receipt records remain as the audit ledger.

Completed generations may activate while newer changes wait for the next job.
Browse responses mark old generations `stale`; current disclosure checks still
filter Works, and stale classification/credit payloads are withheld. An absent
generation returns 503. A retained cursor may continue through ordinary writes;
an expired or recovered basis requires a restart. These are retained projection
rows, not retained authorization.

## Measurements and limits

Measured on 2026-10-04, after versioned reads kept their bounded seeks: four
graph calls/46 SQL statements for irrelevant events and eight/126 for a rating
delta at 100, 1,000 and 10,000 Works, with zero and 1,000 idle scopes. Both
public and global-rating populations
rebuilt in 1.92, 14.20 and 141.34 seconds; the largest run again used 352 ticks
and 1,807 graph calls. The prior 10,000-Work measurement was 135.15 seconds.
These are repeated measurements on the shared host, within the five-minute
budget, rather than a claim that rebuild latency is identical between runs.

The read regression (`discovery-history-seeks.test.ts`, QA
`20261004t150839-f2576c`) captures actual owner statements over 20,000 Works and
four physical versions, including retired and future rows. It checks 79 plans
for pages, conditions, payloads, membership, counts, sections, cards and live
delta probes. Condition membership stays correlated per drive row; Concept
continuations seek the indexed negative-count/identity tuple, and popular terms
order by numeric counts. The history fixture keeps its posting orders and
counts fixed while versioning payloads; it does not qualify every distribution
of rating changes. Card probes separately preserve an unbounded logical-read
counterexample at 300 and 3,000 unrelated postings.

G-1063 (QA `20261004t124611-ff1da1`) refreshed both the public and global-rating
populations at 100, 1,000 and 10,000 Works in 1.90, 13.59 and 135.15 seconds,
respectively. The 10,000-Work run included 1,000 queued background scopes and
finished in 352 ticks/1,807 graph calls, below the five-minute owner budget.
At each scale, with both zero and 1,000 idle scopes, an irrelevant event used
exactly four graph calls/46 SQL statements, allocated no generation and took
36–85 ms. A real one-Work rating write refreshed with eight graph calls/126 SQL
statements, added one posting version and took 88–149 ms. Logical Work probes
used native PostgreSQL Index Scans. The executable G-1024 trace assertions and
SQL plans live in `tests/qa/integration/g-1063-cost.test.ts`; the run's complete
profiles are in `.temp/g-1063/cost-20261004t124611-ff1da1-1.json`.

The corpus isolates projection cost with native unrelated public Works; the
Context, target and rating writes use real commands. It is sparse (one standing
rating, no background classifications/credits), and does not qualify catalogue
write throughput, dense fanout or the medium fixture. The bounds are per serving
basis: actually affected Realm/Mine populations still incur their own delta work.
Background scope metadata is a queue/index probe, not Realm-policy acceptance.
The trace isolates an already enrolled serving basis; catalogue enrollment and
due retention cleanup retain their separate fixed batch limits.

The real-command regression verifies `rating-ready` within ten seconds after a
rating write and a follow, while `discovery-ready` remains available through both.
Discover readiness belongs to the separate retained public ranking; its 200
does not promise that every standing projection is fresh. Additional regressions
cover edits during a partial build, pruned graph outbox, moved reads, leases,
counter fanout, retained cursors and cancelled-version cleanup.

After migrations 1043–1044 and a Main restart, the shared stack resumes global
jobs ahead of its idle Realm backlog, finishes/reconciles graph-moved builds,
and drains old retirement rows in bounded chunks. An obsolete Access fence can
require one initial rebuild. Follow-only traffic creates no new generation;
rating writes update their Work in the matching Context. The shared stack has
not been changed by this worktree; its actual post-merge timing needs observation.

Earlier measurements below describe the previous implementation.

The G-362 pre-change refresh fixture (QA `20260928t031801-3bc7ce`) measured 40
ticks, at most 28 graph queries and 411 ms per measured tick, with one Work per
tick. After the change, the corresponding refresh fixture (QA
`20260928t033429-f9d5a9`) measured 14 ticks, at most 16 queries and 149 ms per
measured tick. It exercises real relay delivery, Context enrollment, ratings,
credits, Access invalidation, activation recovery and Mine isolation.

The native load probe (QA `20260928t034147-00045f`) rebuilt 10,000 public Works in
33.534 seconds (221 graph queries, 40 ticks) and refreshed one changed Work in
721 ms (five queries, including the scheduler delay). It asserts targets of
60 seconds and the current ten-second recovery budget. That fixture uses one semantic type, no classification
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
