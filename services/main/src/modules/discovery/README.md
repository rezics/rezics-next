# Discovery projection

Discovery uses its own derived generation because recommendation scores sum
signals across a different population. `contract.ts` owns the typed browse
contract, `source.ts` verifies source records, and Access migration 315 owns the
projection and indexes. Existing phrase-query profiles are unchanged.

Top-rated uses the selected standing Context's arithmetic mean, with Work IRI
as the tie-breaker; unrated Works are excluded. An explicit Context avoids
silently combining questions or scales. Global is the independent Global
population, Realm uses that Realm's standing Context, and Mine uses only this
Account principal's standing Global slot. Mine contains only public Works the
principal has rated. Public/Realm recent browsing selects public Main Works;
it is not a Realm adoption shelf. A classification `term` is a Sense IRI.
Realm classification follows its existing resolver, including local rejection
and Global inheritance. Mine has no personal classification semantics.

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

Builds are explicit operations; GET never starts a build or aggregates ratings.
There is no automatic refresh scheduler in this implementation. Operators must
refresh shared generations after writes. Automatic scheduling and incremental
maintenance can later use these owner operations and checkpoints.

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

`DISCOVERY_COST` and the shared Work envelope bound output, fanout, graph calls,
bytes and deadlines. Builds reuse verified Work classification/rating reads;
more than 20 classification candidates or the rating owner's 100-slot ceiling
withholds the build rather than publishing an incomplete population. Graph
enumeration during a build can scan/sort the corpus and has no claimed indexed
seek bound. The Access invalidation row serializes source changes; hot-writer
capacity and large-corpus build duration remain unqualified. Existing restore
and erasure owners remain responsible for their authenticated recovery cuts.
