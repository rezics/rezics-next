# Retained count-free facet reader cost

The delivered path is `POST /v1/subjects:facets` → `discoverFacets` in
[facet-discovery-runtime.ts](facet-discovery-runtime.ts) → `captureFacet` / `pageFacets` in
[facet-discovery-operations.ts](facet-discovery-operations.ts) →
[facet-discovery-storage.ts](facet-discovery-storage.ts). This derivation concerns that composition, not the
sampled/count reader, Search hit facts, primitive relation-facet reads or expiry maintenance.

Decision: retain useful-page semantics and charge actual refill work; a population-independent whole-page bound
requires Search's scoped-facet successor to guard the existing loop before dispatching further work.

## Units and admitted constants

[facets.ts](facets.ts) admits `1 <= p <= 8` distinct properties, `1 <= s_i <= 20` values per property (default 10).
The fixed predicate has at most 32 leaves with at most 64 IN members per leaf (Search Cost). These are request
shape bounds, not catalogue bounds. Let `O <= p` be distinct captured observations, `S <= p` distinct admitted
scope identities, `V_i` the retained values after the cursor, `K_i` actual candidate seeks, `C_i` returned
candidates, and `R_i` candidates rejected by current disclosure. Let `A_i <= C_i` be candidates actually checked;
a seek can return unused rows after enough eligible values have been found. Charge all returned rows anyway.

`L(n)` denotes a B-tree descent, with logarithmic buffer growth in the relation's physical size. A unique probe
returns at most one row; a keyset seek returning `k` rows costs a descent plus `k` live entries on its ordered
index. This does not promise a particular PostgreSQL plan. Native plans must establish examined rows and buffers
separately. Under the adopted criterion, invisible multiversion tuples and vacuum/merge debt are excluded; visible
retired history is included. SQL LIMIT, counters and returned JSON lengths cannot establish examined work.

## Ready-page storage and currentness

Each `readFacetCandidates` first performs the immutable Source binding join. It checks the exact consumer,
observation and definition, meaning digest, property dependency and, for item values, labels dependency; it also
checks the captured filter/text against the plan. Call that native owner work `J`. Its returned cost is additive,
not permission to replace the join with a fixture assertion.

The subsequent single SQL statement has these complete equality prefixes:

| Operation | Equality prefix / ordered suffix | Live rows returned or changed per seek |
| --- | --- | --- |
| Ready generation and expiry refresh | `facet_generation` PK `(partition_no,definition,generation)`; `state='ready'`, `expires_at>now` | at most one UPDATE; zero rows means unavailable |
| Canonical values | `facet_value` PK `(partition_no,definition,generation,value)`; first three equal, `value>after`, ascending C collation | at most `s_i+1 <= 21` values |

The UPDATE CTE and lateral value seek share a statement snapshot. A valid empty range returns one outer row with
a null item, distinct from a missing/expired generation. Expiry refresh occurs on **every seek**, including
refills. No COUNT or scan of earlier cursor values is needed. Direct storage work is `K_i` statements,
`K_i` attempted ready-row probes/updates, and `C_i <= (s_i+1)K_i` returned values, with indexed buffer work
`O(K_i L(generations) + K_i L(values) + C_i)`. Native CTE plans may have accounting limitations; preserve them.

`current` reads the contributor original through the real Subject Source, validates its snapshot, and requires a
visible, nonredirected row whose ID equals the retained terminal. For items it then reads the target original and
requires that same currentness against the retained target terminal/value. It does not follow a newly installed
redirect or borrow permission from its survivor. Thus there are at most `2 A_i` Source calls (one for a rejected
contributor, two when the target is reached), each with **one** requested key. Original and terminal are compared,
not hydrated in two separate calls when equal. Duplicate contributors across values and the lookahead on the
next public page are reread; there is no cross-value or cross-page deduplication.

The Source accepts at most 256 keys per call, but this path does not use the separate 256-key/eight-home label
chunker in `discloseFacetValues`. Source itself reads current subject, redirect/revision heads, terms, compact
statement history, expanded adoption/statement and disclosure dependencies. Its point-key limit is not a finite
row cap for all those payloads. In particular `search-source-facts.sql` enumerates nonrelation statement history
under `(route,subject_id)` before selecting compact heads. Keep native Source work `H(id)` explicit; a fixed
number of UUID probes alone does not establish fixed rows as anchor history grows.

`pageFacets` brackets siblings with at most `2O` population reduction observations and, only with an installed
authenticated scope source, at most `2S` scope observations. In the delivered implementation both population
calls pass `start:null`: each performs a fresh observation/start write, not a final role using the earlier start
or a retained own-row execution. The HTTP ledger charges their returned units after the operation completes.
The population SQL binds `(partition_no,observation)` then exact registration, physical target, bootstrap,
read definition, Source configuration, owner epoch and immutable release. Pending coverage keys, fenced homes,
behind homes and changed generations have separate fail-fast indexed paths. Its native source reservation is
64 input keys, 32 dependency points and 32 rows per role before additional keyed work; those reservations do
not prove the composed page. See [public-filter-coverage-population.sql](../semantic/public-filter-coverage-population.sql)
and its [native caller](../semantic/public-filter-coverage-population.ts).

Capture, request authorization/current Access, active meaning, native index incarnation/settings and prepared
consumer custody also remain in the HTTP capture. They are separate from the candidate CTE. Ready capture still
calls `prepareFacetStep`: its binding join, two live-head expiry UPDATEs, INSERT conflict attempt, building lease
attempt and exact generation SELECT run even when the generation is already ready. The partial unique indexes
`facet_one_building` and `facet_one_ready` have equality prefix `(partition_no,definition)` and at most one live
row each; retired generations must not become a filtered historical scan. Do not attribute these five storage
statements to population preparation or omit them from a ready page.

Consequently a ready call has storage statements `5p + sum K_i`, plus capture/custody, `p` ready-step joins,
`sum K_i` candidate joins, reduction/scope observations, and `sum H(id)` for every actual Source read. Transaction
BEGIN/COMMIT/ROLLBACK and connection/session controls in those owners remain separate counted statements.
Ready canonical value seeks perform no OpenSearch text/posting iteration themselves. Capture can still contact
the native engine; absent transport/profile instrumentation is unmeasured engine work, not zero.

## Eligible-value refill has no request-size ceiling

In `pageFacets`, the unbounded `for (;;)` calls `readFacetCandidates` with the original `read.size`, checks every
row with `current`, and advances `after` to the last returned value. It stops only on `s_i+1` eligible values or
an exhausted seek. There is no round/candidate reservation before the next seek. Deadline checks bound elapsed
opportunity, not logical work. With no rejected candidates, `K_i=1`. With a rejected prefix of length `r`, work
can require `ceil((r+s_i+1)/(s_i+1))` seeks. If all `V_i` rows reject, there are `floor(V_i/(s_i+1))+1` seeks,
including the final empty seek when the population is an exact multiple. More generally `K_i <= floor(V_i/
(s_i+1))+1`; this is population-dependent, not the required admitted page bound.

A reduction present before START can withhold the page immediately. A reduction committed **after START and
after the first value SELECT** does not stop `current` from rejecting arbitrarily many retained rows. No new
reduction observation runs between refills. The later observation can withhold the result only after that work.
The diagnostic ledger's `sum(2s_i+2)` candidate ceiling is checked after `pageFacets` returns, so it cannot bound
work already dispatched. It also counts one access point per candidate despite up to two Source reads.

The [dedicated native case](../../test/search/growth-retained-facets.test.ts) prepares 64 distinct real author
values contributed by one real Book. With indexing paused, its pool response barrier holds the first ready-value
SELECT after native execution; an actual hide of that Book then commits, and the unmodified result resumes.
For size 2 all 64 original contributors are now unavailable: the existing loop can consume 22 seeks before
returning readiness/deadline failure. This is a reproducible schedule, not a claim that it has executed on a
particular source. The test retains native plans, returned candidates, control statements and concurrent hide
work, and rejects any disclosure of private labels/counts. Search owns the product repair; no output truncation,
second refill protocol, public DTO expansion or production change is introduced here.

## Preparation is separate

`captureFacet` performs genuine consumer capture (and a separate PIT capture for text). A request attempts at
most 256 `prepareFacetStep` calls per sibling. Each step performs one population input (`inputLimit:1`), one
projection input (`inputLimit:1`), one contribution chunk of at most 100 rows, or sealing. Never count repeated
503 preparation calls as one ready-page operation. A 202/503 is not an empty successful page.

Preparation uses `facet_stage` PK `(partition_no,definition,generation,subject,key)` with all but `key` equal,
`key>contribution_after`, ascending, LIMIT 100; the first four fields bind a single subject. Writes use that PK
and the `facet_value` PK above, including conflict attempts. Population/projection frontiers come from real
owner operations. Projection can stage at most one value per input; type completion can stage one type value.
Contribute performs at most 100 attempted value writes in one INSERT. The serialized staged/contribution/
projection/accumulator payload must be at most 4 MiB, with `staged+contributions+1 <= 1000`, before transaction
dispatch; this guard does not cap the preceding owner read.

A successful step has at most 11 direct storage SQL statements, including controls: four initial expiry/insert/
lease statements; in the largest (contribute) phase one stage SELECT; BEGIN, version/lease FOR UPDATE, one value
INSERT, generation/frontier UPDATE, COMMIT and final lease release. Projection substitutes at most one stage
INSERT for the contribution INSERT and omits the stage SELECT; seal substitutes the live-ready retirement UPDATE.
Rollback paths and failed owner calls remain charged. Binding joins, population/projection currentness, target
reads, privacy and optional scope checks are additional, never hidden in this 11. Sealing performs privacy,
scope and binding rechecks before publication. Per-step work is finite only with those owners' own bounds.

Complete preparation is proportional to all enumerated population inputs, all projected statement inputs and
all contribution chunks, plus sealing and retries/restarts. It is not a constant ready-page cost. For each
eligible subject with `t` projected inputs and `a` staged values, include population, projection completion,
`ceil(a/100)` contribution chunks and their final empty completion step. Rejected inputs, text misses, CAS
losses, discarded generations and repeated capture calls add work. Text preparation issues up to two native
searches per matching projection completion (version check and text predicate); posting/term work remains
match-dependent. Native profiles, not request count, must measure it.

## Evidence boundary

The dedicated fixture uses the released native default HTTP composition and real creation, acceptance,
adoption, grant, indexing and hide operations. No SQL mints readiness, bindings, population completion or ACKs.
Its initial campaign isolates the refill schedule and ordinary first/deep/terminal pages at 64 values. Kernel
pools supplied through the fixture seam are instrumented; isolated Auth pools and engine profiles remain
unmeasured. This is **not** complete three-scale composed growth acceptance.

Remaining acceptance must grow relevant values/population at 64/512/4096, independently grow unrelated and
retired history, verify physical source/engine identities and seed cardinalities, capture all reached pools and
native engine profiles, and separately measure preparation steps and complete preparation. Derive finite
whole-call row/statement ceilings before asserting them; until Search repairs the refill guard, no such
population-independent ceiling is established. Realm/Collection scope acceptance remains unavailable unless
the installed composition authenticates that source. Existing continuation, expiry and Semantic primitive
campaigns retain their own evidence and ownership.
