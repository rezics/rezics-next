# Discovery projection

Discovery uses its own derived generation because recommendation scores sum
signals across a different population. `contract.ts` owns the typed browse
contract, `source.ts` verifies source records, and Access migrations 315 and 380
own the projection, indexes and refresh queue. Existing phrase-query profiles
are unchanged.

Top-rated uses the selected standing Context's arithmetic mean, with Work IRI
as the tie-breaker; unrated Works are excluded. An explicit Context avoids
silently combining questions or scales. Global is the independent Global
population, Realm uses that Realm's standing Context, and Mine uses only this
Account principal's standing Global slot. Mine contains only public Works the
principal has rated. Public/Realm recent browsing selects public Main Works;
it is not a Realm adoption shelf. A classification `term` is a Sense IRI.
Realm classification follows its existing resolver, including local rejection
and Global inheritance. Mine has no personal classification semantics.

`GET /v1/rating-contexts` lists standing Contexts for Global or a public Realm,
without requiring a Work. Each result includes its question, recorded language,
revision and scale. Questions currently come from the Context owner's English
creation profile. Clients select a listed Context rather than combining scales.
The collection uses the same graph-position cursor fence as Work reads.

Cards include the first three author credits in ordinal/IRI order and up to
three accepted classifications in Sense IRI order. Public native Agent credits
resolve their current display name and handle when the card is read. External
Open Library references retain null names because the source conversion records
only author keys. Concept names are hydrated in the requested language with the
existing summary fallback policy. A term match includes its localized name;
page-level `matchedTerm` is null when no admitted item matches.

`GET /v1/discovery/popular-terms` reads the current generation's materialized
Work counts by accepted Sense, optionally selecting a Realm and standing rating
Context. It seeks at most 20 terms and hydrates Concept names in the requested
language. Counts are built with the generation; a stale generation is withheld.

The read chooses a bounded index page before hydrating current summaries. It
returns an exact page count and a cumulative match count: a lower bound while
continuation remains, exact when the generation's admitted population is
exhausted. Suppressed candidate counts and private principal identities are
never returned. Source positions, filter bindings and the active generation
fence every cursor. An Access protection change or graph write requires a fresh
build; this deliberately trades availability during writes for a simple current
disclosure proof. An absent generation returns 503, a stale one 409.

## Build and refresh

Use the typed `/v1/discovery` operations in `management.ts`, with `work:read`
OAuth scope. Shared builds require the existing Access recommendation-management
grant. Anyone may build their own Mine population; an acting Agent cannot
select another Account's population.

1. Register `generation-builds` with an idempotency key and the desired basis.
   The basis includes a Context for top-rated or Mine; recent may omit it.
2. Call the generation's `advance` operation with the last returned checkpoint
   until `complete`. Each call verifies at most one Work. A checkpoint race
   returns 409; read the generation before continuing. A crashed step's lease
   expires after 30 seconds, so another process can resume it.
3. Activate using the generation view's `activeHeadRevision` as the expected
   revision and a new idempotency key. Activation is an exact-head CAS. A source
   change prevents activation; cancel the building generation and register a
   fresh snapshot. Cancel is repeatable and cannot cancel an active generation.

Main also runs `DiscoveryRefreshWorker` when its Main relay connection is
configured. It waits for the acknowledged relay epoch/sequence to equal the
current graph cut. Access-only changes are detected through the existing source
fence even when that relay position stays unchanged. GET never starts a build or
aggregates ratings.

The scheduler enrolls Global browse, public Realms and standing rating Contexts
through a resumable catalog scan. Activation enrolls existing operator-managed
bases, including Mine with its exact Account owner. Each tick claims at most one
due population and advances at most one Work, reusing management leases,
checkpoints and activation CAS. A ready generation remains attached to its job
before activation, so a restart resumes it. Obsolete builds are cancelled and
replaced. Job claims expire after 30 seconds; concurrent Main processes cannot
finish an older claim. An inactive Mine owner or unavailable source defers the
job without relaxing disclosure.

The due queue records attempts, last outcome and elapsed milliseconds for
operations diagnosis. Polling runs every second; current populations and catalog
pages are revisited after five seconds, failures after 30 seconds. Each tick
also removes at most 1,000 entries from one terminal generation. Immutable
generation/activation receipts remain retained. A full rebuild was chosen over
incremental deltas because the current source fence covers graph writes and
cross-Work Access protection changes; a changed Work event alone cannot prove
the rest of the population remains admissible.

## Cost evidence and limits

The fanout materializes each type/term combination, including wildcards. This
lets both orders use leading equality keys followed by a tuple continuation,
as described by PostgreSQL's [multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html)
and [row comparisons](https://www.postgresql.org/docs/18/functions-comparisons.html#ROW-WISE-COMPARISON)
(consulted 2026-09-28). The native discovery test measures first and deep pages
for all four filter combinations under both orders, with 20,000 synthetic Works
and 80,000 index entries. Each plan must use one index search, at most 21 rows,
no separate sort or sequential scan, and no rows discarded by a residual filter.
This qualifies the seek shape on that fixture, not deployment capacity.

The native refresh test runs actual outbox delivery, automatic Global/Realm
enrollment, Access invalidation, source restart, lease replacement, activation
outage recovery and Mine isolation. QA `20260927t175547-c48e4c` measured 40 ticks
over three public Works, a private Work, two public Realms, two standing Contexts
and one Mine population: at most one projected Work, 25 graph queries and 348 ms
per measured tick. The test writes its measurements under `.temp/` and asserts
the logical ceilings in `DISCOVERY_REFRESH_COST`. It also checks the current
generation is reused when nothing changes. These small-fixture measurements do
not qualify large-corpus refresh latency. Sustained writes can restart full
builds indefinitely; reads continue to return 409 until a current build activates.

`DISCOVERY_COST` and the shared Work envelope bound output, fanout, graph calls,
bytes and deadlines. Builds reuse verified Work classification/rating reads;
more than 20 classification candidates or the rating owner's 100-slot ceiling
withholds the build rather than publishing an incomplete population. Graph
enumeration during a build can scan/sort the corpus and has no claimed indexed
seek bound. The Access invalidation row serializes source changes; hot-writer
capacity and large-corpus build duration remain unqualified. Existing restore
and erasure owners remain responsible for their authenticated recovery cuts.
