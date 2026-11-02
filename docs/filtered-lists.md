# Filtered lists

This document owns the shared membership, freshness, disclosure, admission, identity-list and cost contract for
Zone pages, TypeLists, Collection browsing and the library. Owner documents specify their obligations and native
integration. This is required behavior, not a claim that the existing stubs, helpers or native ports implement it.
[Scope](scope.md) includes the architectural capability wherever these abstractions appear.

## Meaning and indexed observations

Membership is evaluated against a **complete, identified index observation** for the admitted predicate and
population. Meaning, indexed observation and current disclosure are separate. Catalogue facts use the existing
OpenSearch/PostgreSQL machinery. State, labels, progress and holdings stay in the owner's PostgreSQL partition;
private facts never enter a public index or a public holder directory.

Use the one [filter grammar](../packages/filter/README.md), immutable release pins, datatypes and units. All
qualifiers on a statement must match that same statement. Unknown remains unknown under NOT; incomplete coverage,
a failed dependency, a timeout or partial shards cannot establish absence. Complete indexed negatives do not
require request-time reconstruction of every raw selected fact. The Search pure matcher is the conformance
reference, not mandatory request-time raw-fact replay. Typed, parameterized range and qualifier SQL is permitted
where admitted with the same meaning. This does not admit arbitrary SQL or enlarge the grammar.

Semantic supplies complete selected-public-facet projections and their disclosure dependencies, covering compact
and expanded storage, rank, adoption, suppression, retraction, consent and foreign dependencies. A relation sample,
possible-witness hint or overflow marker alone is not complete coverage for exact membership or negatives. Use a
complete access path or preparation. Search owns compilation, preparation and freshness; Commerce owns owner-local
plans; Performance owns numeric budgets and native cost verification. No new engine, service or scheduler is needed.

## Current disclosure and query privacy

Everything disclosed must satisfy current native authority: membership, exclusion, order, fields, source metadata
and cursor-visible information. Current Access, original **and** terminal eligibility, source consent, foreign
target restrictions and tuple fences remain required. A public page uses public facts even for an editor who can
inspect private facts. A Zone or Collection grant never grants rights in its sources or subjects.

An index revision, complete ordinary generation, identity epoch or prepared result is never a grant or cached
permission. Plans require complete disclosure dependencies and fail closed when essential observations are missing,
unavailable or unsafe. Candidate checks alone cannot protect a query's exclusions and order.

For example, withholding a harem tag must prevent disclosure through a positive harem result **and NOT harem**.
A stale index can exclude a readable book using the withheld tag. Checking only the returned subjects never checks
that excluded book. The same problem applies to ordering, counts and source metadata.

Semantic produces a complete selected-public-facet projection and a per-home privacy-reduction log. Each
reduction appends a bounded cause, affected property/order dependency keys and subject-wide scope at a monotonic
lossless position in the **same authoritative native transaction**. Rollback leaves neither reduction nor log
advance; receipt replay and genuine noEffect do not append. Foreign tuple, target, consent and Collection
reductions record their actual home immediately, independently of ordinary relay delivery.

A public filtered read waits only for **unacknowledged reductions whose affected property keys occur in its
filter or order**. Every returned row is additionally checked against unacknowledged reductions of **its own
subject**. Subject-wide reductions, including takedown, affect every key of that subject. Excluded subjects'
matching-key reductions remain covered, preserving NOT and order safety. Keys come from the actual shared
filter/plan/sort declarations. Foreign dependencies map to affected **source** property/order keys; the foreign
target's own property name cannot establish irrelevance. Unknown or incomplete routing stays preparing. Internal
repair locators include selected but currently ineligible inputs so restoration remains discoverable; private or
withheld values and IDs never enter the public index.

Search acknowledges a contiguous log prefix only after actual refresh-visible local **and all dependent foreign**
repair and complete dependency registration/routing. ACK belongs to the actual physical target/incarnation and
consumer/projection generation, plus meaning/read definition where relevant. Aliases, ordinary delivery/checkpoints
and local repair alone cannot transfer or advance it. Late registration, old snapshots, ambiguous sink failure,
lost CAS and delete-version pruning must not permit ACK or resurrect unsafe data. Source/sink version fencing
remains required; a foreign privacy position is not a subject's anchored external version.

Observe current required safety before execution and revalidate immediately before disclosure. Logical coverage
includes all 4,096 homes, including excluded subjects and foreign dependencies, through the indexed behind/changed
path in [Cost](#cost), not start/final head vectors or a scan hidden in an aggregate/hash/JSON. Native start evidence
must detect a reduction committed during execution **even if repaired and ACKed before final observation**; current
clean/dirty state alone is insufficient. Missing, moved or unavailable owners cannot become pristine zero homes.
Changed relevant safety, incomplete coverage, pending ACK or pending identity work within the ACTUAL source's complete query dependencies yields
preparation. Current Access, source/population authorization and candidate/field checks remain independently
required. Neither an index nor key narrowing can supply that authority.

This is a required future native boundary; current ports do not establish it. The
[native producer contract](../services/kernel/src/semantic/public-filter-source-contract.md) records exact future
operations, missing primitives and pending integration scenarios. It adds no permission certificate or identity
basis sweep. Coarse global blocking may be an initial launch slice, but completion requires native 64/512/4,096
checks with reduction arrival rate rising with population, actual repair/ACK latency, and served share that does
not fall between scales. This privacy rollout allowance does not permit a global identity marker or universal
identity page gate. Permanent preparation or absent native data cannot satisfy that gate.

Native feasibility remains unproved. The inspected PostgreSQL and OpenSearch primitives reject specific shortcuts,
not every possible native layout; neither report ran a native probe or captured rows, blocks, bytes, or served share.
Top-level snapshot visibility can find a lower-allocated XID that commits late, but an XIP split copies, sorts,
enumerates and probes active XIDs even when no home changed; packing or retaining that snapshot does not remove
its work. An xmin scan can read many committed unchanged heads. Last-key-only change tracking loses an earlier
relevant reduction, while key/history scans and per-definition summaries must prove their K/L read cost or
registration fanout and atomic completion. A transactional global stamp would be a separate cross-home placement
and serialization choice, not an adopted design. See the [current](research/public-filter-native-cut-current.md)
and [deep](research/public-filter-native-cut-deep.md) native feasibility reports for the counterexamples and
evidence still required.

An execution checks both its original covered cut and its retained start using the same canonical PIT or prepared
observation. A reduction remains detectable after repair and ACK before final observation; a new execution on an
already unsafe older observation also remains unsafe. Native write-block verification can drain admitted shard
writes while blocked, but cannot identify a delayed old request or prevent it after unblock. External versioning,
refresh, checkpoint CAS and finite delete retention do not prove physical absence after an old write resumes.
Physical no-resurrection and retained-copy custody remain mandatory; no permanent soft tombstone or independent
fence is selected. Foreign repair must advance the dependent source's own anchored version and establish the
repaired winner's visibility; a same-version 409 alone is not repair proof.

Omit unsafe engine totals and facet counts over unchecked populations. Approximate or `as_of` labels give no privacy
exemption. Do not substitute zero or returned-row length for an unavailable safe aggregate. No new common list DTO
is selected: owners preserve their envelopes and provide concrete execution through reviewed native contracts.

Native suspension revokes pre-existing bearers: held-token requests return `401 invalid_credentials` and
`WWW-Authenticate: Bearer error="invalid_token"`, including public/unlisted requests with those credentials.
Auth cannot mint a valid suspended bearer; suspended correct-password sign-in is `403 {"error":"account_suspended"}` without
a session. Kernel `403 account_suspended` is defensive only. Missing/invalid/revoked required credentials retain
native 401, insufficient scope retains `403 insufficient_scope`, and invalid credentials never downgrade to anonymous.

## Freshness

Ordinary catalogue edits become filterable within **60 seconds** in healthy operation. More than **5 minutes of
actual source-to-searchable lag** yields readiness. Measure relay, dependent projection, preparation and searchable
visibility, not engine refresh alone or a document timestamp. Privacy reductions, takedowns, withdrawn consent and
revoked sources apply immediately with no lag allowance. Owner writes are reflected on that owner's next read;
a private prepared result cannot conceal a committed state change behind catalogue freshness.

A public dynamic Collection exposes its last completely published output, never its owner's predicates or facts.
Private changes that do not change that output cannot change public fields or public cursor bases. At terminal
account deletion, only eligible public contributions and completed public generations survive, with de-identified
attribution under [erasure policy](deletion.md) and the relevant owner contract. Private/unlisted data and published
reading logs do not survive. This document does not implement erasure or duplicate its workflow.

## Admission and useful pages

Admit **filter + source + order together**. Grammar admission alone does not admit execution. The responsibility
names are direct catalogue index, direct owner index, prepared public result and prepared owner result. These are
prose names, not new executable discriminants. A composed Zone page combines admitted plans and requires its own
aggregate admission.

A direct plan must have a page-derived bound in actual work units, including backend engine work. Otherwise prepare
an indexed result in bounded background steps retaining settled work. If neither is supported, reject with
`422 unsupported_query` before enumeration. A LIMIT, timeout or small response does not prove bounded engine work.
Do not accept a shape that can only remain permanently preparing.

Prepared state is disposable derived data on existing owner infrastructure. Admission, quota and expiry bound it;
steps retain committed frontier and settled results, and total progress follows relevant finite input and changed
dependencies. No repeated restart from zero, per-built-in witness mirror, unbounded synchronous fanout or reusable
permission result is allowed. Crash/replay and concurrent privacy changes must preserve progress and safety.

A successful list fills the requested page or returns a genuinely exhausted final page. If admitted work cannot
establish either, return explicit preparation/readiness. Readers never walk a chain of short or empty successful
pages over raw nonmatches. Sparse matches behind many nonmatches must produce useful pages after finite preparation
on fixed finite ready input with eventually successful I/O and fair durable progress. Permanent preparing fails.
An essential unknown cannot become false, be skipped forever or manufacture exhaustion.

## Canonical identity and personal references

Use maintained canonical-ID indexes: one public terminal document and unique prepared result rows per generation
and canonical subject. Collection browsing shows one card per canonical subject; editing preserves stored occurrence
IDs, original subject IDs, notes, order and multiplicity. Do not canonicalize after paging in stored-ID order:
`[a,c,z]` with `a → z` would produce `[z,c,z]`, not canonical `[c,z]`.

Changed disjoint identity group sets run concurrently under local fixed symbolic capacity P. PREPARING is affected
pending/overlap-busy; capacity/reclaim pressure is local. There is no global active marker, sole pending job or
universal canonical-page gate. Each resulting group has at most **4,096 originals**, checked from a coherent
immutable non-ABA double collection before ALL new admission effects. Missing/moved/incomplete state is unavailable,
never zero/self. Durable preparation followed by drift/cancellation retains recovery, never effect-free overflow.

Canonical preparation/publication/cursor currentness follows the ACTUAL source and its COMPLETE expanded query
dependencies, including excluded/NOT/order-only originals, source population, pins/meaning and physical-query
privacy dependencies. A finite unchanged owner source must settle and return useful pages under continuous disjoint
jobs. A genuinely all-group catalogue can have broad dependencies without blocking that owner source. Partition
summaries carry committed SCOPED reader revisions; lower-job publication after higher publication/cancellation must
still change the current source basis. No max allocated epoch, per-job global history, cursor vector/crypto or
hidden source-wide global marker is allowed. Start/final validation and cursor currentness use the same complete
source observation. Returned hits or per-ID positive samples cannot prove completeness.

The [identity owner](../services/kernel/src/semantic/identity-epoch-contract.md#scoped-reader-publication-and-complete-query-dependencies)
derives required native dependency registration/arm/finish/repair custody from actual Collection/Library structural
keys and Search producer observations. Complete native owner/Collection/Search Source bindings and summary consumption
are still missing; this adoption does not invent them or freeze the old global TypeScript sketches. Missing binding
means honest unavailable/preparation, not ready-empty. Full excluded/order/FOREIGN physical-query safety and current
ORIGINAL AND terminal admission remain independent. A public terminal cannot expose a withheld original; maintained
support must find the last eligible original in a large group without an alias walk, 4,096-home sweep or arbitrary
representative. No mapping provides SourceAccess or a reusable permission certificate.

The SAME fixed version-1 `library-private-follow-counts` identity participant covers ALL six canonical drivers,
structural directory/candidates/support, first apply, follows/totals, OLD withdrawal/NEW addition, pending/published
fences and prior custody. One `(owner,canonical)` candidate plus structural `(original,scope)` existence/extrema
is the directory plan; a million same-original/profile/lifecycle sessions cannot create a million directory rows.
No per-fact witness/copy or required canonical_source_fact write proves this directory. Actual follow ACK with
directory incomplete refuses publication; no third identity participant or A5 ownership transfer is introduced.

Standalone mapping routes ONE relevant current control home from source basis, not a guessed terminal or remote
admission query. Same backend uses one RR/eight statements; cross-backend releases source/control/source visits,
source<=10/control<=6,total16 or11 pending. Inside a filtered page mapping rides existing shared batched owner/epoch
observations plus TWO probes and source candidate points, with NO extra snapshot/client/control statement or per-ID
loop: direct<=12 statements/backend or composed8+4R and one connection/backend remain unchanged. Raw100 is a durable
job-step bound only; public raw work derives from its operation class, decision 5 and actual Source plan allowance.
No separate two-probe public raw100 allowance is adopted.

The [native cutover owner](../services/kernel/src/semantic/identity-epoch-contract.md#native-cutover-adoption)
requires all-home bootstrap/writer closure, immutable flat inputs and exact native custody. Each partition q retains
Gq+4P full generations and Aq+4P·4096 memberships at EVERY durable/crash/replay/abandon step, including bootstrap,
unsealed/export/partial-deleted/abandoned copies. Local unreclaimed copies block new local admission until locked
native empty proof; other partitions progress. Live undo/reversal/move/cursor obligations need actual minimizer
custody, not hidden full groups. Accounts uses actual Core runOperationalTransaction/enqueueIntent for derived
owner work/DBOS intent; Core adds no event/receipt/outbox/write-basis/position/intent table/relay. Its DBOS history
belongs to shared-history and Library derived data to Library A5. Missing owner producers cannot manufacture ACKs.
This specification integration needs full coowner and ALL-nine-item Performance confirmation before types or runtime.
Stored personal originals are not rewritten. Canonical personal views select the highest live native
`owner_write_seq` while keeping conflict visible, union labels, and keep copies and sessions separate. The
[delivered sequence primitive](../services/kernel/src/library/owner-write-sequence.md) does not make legacy null
values ordered or complete production set/clear/Undo integration. Those writers and bounded legacy readiness
remain required; Undo gets a new sequence despite restored dates, and archives never compete as live state.
New writes address current terminals.

A required native page race holds source-arm delivery after a relevant claim commits, with positive returned
IDs and the broad fact mutation alarm unchanged. Excluded/NOT/order-only dependencies must still invalidate
start/final validation and old cursors. A clean-to-clean arm/effect/finish between probes must change the scoped
committed revision. Neither case receives an extra statement, connection, remote admission read or public raw
allowance; actual complete native bindings and inclusive cost capture must prove both before readiness.

[Semantic](../services/kernel/src/semantic/README.md#identity) owns creation and durable identity publication;
this list contract does not invent its native command ABI.

## Built-in presentation and accepted meaning

For an **unmaterialized private** state view, presentation uses the lexicographically smallest **currently supported
immutable release digest containing that state**. This chooses presentation only; digest order means neither
chronology nor compatibility. Discovery unions supported sibling state identities. Each contributing fact keeps its
own accepted pin and meaning. A materialized header's accepted meaning and a public complete generation's accepted
meaning stay fixed; an owner's rename wins. Later support and reader selection use indexed seeks, never a scan of
all supported releases or release history. Native owner facts remain authoritative; no new runtime ABI is selected.

## Zone transport and cursors

`POST /v1/zones/{id}:readPage` preserves its existing optional opaque cursor query parameter and transport:

| Response                                 | Meaning                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `200` common page plus safe Zone shell   | Complete common page; no partial document                                      |
| `202 {next}`                             | Explicit retained preparation with an opaque continuation, `private, no-store` |
| `503` Problem + `Retry-After`, no cursor | Unavailable or no progress                                                     |

Web follows at most four 202 steps per render, then renders a private/no-store preparing page retaining the usable
continuation. A 202 is not an empty successful list and never authorizes endless final-leaf replay. Its progress
refers to retained preparation/current generation, not cached authority, per-leaf verdicts or a client result vector.

Preserve cursor ownership and codecs. POST uses the existing Search cursor profile for every viewer: timed,
confidential, bound to stable operation/route, Zone, viewer and request; mutable bases belong inside the encrypted
position. Valid-shaped unusable progress starts fresh current authorization and returns preparation or a complete
page; invalid body/query and current denial retain their existing outcomes. GET keeps its existing default profile.
Search retains native tuple types, stable binding and principal reauthorization. No schema, status/body or codec
change is authorized here. Current source/fact/grant revocation applies on every continuation.

## Shared acceptance matrix

One shared acceptance matrix varies definitions, visibility and fixtures, rather than surface-specific engines:

| Surface                            | Catalogue filters                                   | Owner predicates                                      | Identity and publication                                             |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Curated Collections                | Shared released predicates                          | Owner-only personalized filtering                     | Canonical browsing; occurrence editor preserves duplicates and notes |
| Everything                         | Same predicates, including a library without state  | Own state/labels/progress/holdings in owner partition | Empty entry shells do not invent presence or a state                 |
| State Collections                  | Same predicates over accepted pinned state identity | Owner-only state filtering                            | Supported sibling discovery and fixed accepted meaning               |
| Public/unlisted/private visibility | Same admitted meaning                               | Never borrow curator authority                        | Current source and original/terminal disclosure                      |
| Mounted Zones and TypeLists        | Same predicates intersect eligible source union     | Private personalized view only where admitted         | Canonical cross-page order, complete common page, no union total     |

Required user outcomes are light novels tagged harem; Book wordCount > 1,000,000; and both combined, each in a
public Zone, public Collection, own library and own library with own state. Exactly 1,000,000 and absent word counts
are excluded from the positive threshold. Words and characters are different quantities; incompatible units never
match. Harem/work-form Concepts, genuine word-count data and reviewed source mappings have a separate released-data
producer. Do not invent CURIEs or source keys to imply those prerequisites exist.

Owner-only NOT state X includes subjects with no live state X, including no entry, within the admitted owner
population. Missing catalogue evidence does not become a positive catalogue classification.

Native acceptance must also cover same-statement qualifiers, compact/expanded conformance, healthy/max catalogue
lag, owner read-after-write, foreign fences and targets, sparse matches, finite preparation after crash/replay,
direct-target disclosure, canonical cross-page uniqueness, pending-epoch readiness and current cursor reauthorization.
With the indexer paused, positive, NOT harem, order and count cases remain preparing/readiness until query-level
privacy acknowledgement covers the local reduction **and all affected foreign repair**. Returned-ID checks or
omitted counts alone cannot pass those cases; an ordinary freshness checkpoint cannot certify pending repair.

Preserve the existing unrelated semantic core, graph, history, command and lifecycle acceptance and bounds. These
list decisions do not weaken those native operations. Old proof reports are evidence, not replacement acceptance
gates. Two-release pins, real shared Search runtime, full persona/API/default composition and growth proof remain
required; typed schemas, immutable loaders and cursor-capacity helpers prove only their own boundaries.

## Cost

### Direct and ready-result pages

- Touches: named catalogue/owner index seeks; actual candidates including duplicate, rejected and lookahead rows;
  original/terminal, source and viewer Access points; complete disclosure dependencies; summaries; result/control
  and epoch reads.
- Bound: derive separately per plan in candidates/keys, native points, examined rows including removed rows,
  buffers, statements/connections, bytes, backend engine work and output slots. The whole common page stays at most
  16 distinct reads and 128 TOTAL output slots. Each page or preparation step supplies one INTERNAL cost object
  with named actual candidates (including duplicates/rejects/lookahead), Access/dependency points, backend engine
  work and output-slot counters. These are not public fields or private-count disclosure. The shared harness
  separately captures examined/removed rows, buffers, statements, connections per backend and request/response bytes.
  No executable counter ABI is selected here; native owner specifications must bind actual counters before acceptance.
- Growth check: real API/native captures meet [Budgets](#budgets) and [Three-scale checks](#three-scale-checks),
  including first/deep pages, sparse matches, owner pools, unrelated history/population and alias/duplicate axes.

### Preparation and index maintenance

- Touches: bounded input/frontier/result writes on existing owner stores; source changes and current foreign
  dependencies; shared outbox/durable work; canonical mapping/index maintenance while the identity epoch is pending.
- Bound: finite total work may follow relevant finite input and changed dependencies. Each step separately admits
  rows, keys, points, bytes, statements and engine operations and retains progress. Charge failures, discarded work
  and rereads. Derived results never store reusable permission. No new scheduler or unbounded synchronous fanout.
- Growth check: [Three-scale checks](#three-scale-checks) enforce the step and total-work limits in
  [Budgets](#budgets), with interruption/replay, concurrent privacy change and terminal fencing. Verify complete
  activation/catch-up and useful pages; permanent preparation is failure.

### Budgets

Let `s` be the output slots of one read (`1 ≤ s ≤ 100`), `R` the distinct reads of one common page
(`R ≤ 16`, with `Σs ≤ 128`), `c` the candidates a read actually examined, and `ℓ` the admitted filter leaves
(`ℓ ≤ 32`). Count duplicates, rejected rows and lookahead as candidates, including discarded work and rereads.

1. **Direct plans: direct catalogue index and direct owner index.** Each read within a page has these ceilings:

   | Unit                                             | Per-read ceiling                                                               |
   | ------------------------------------------------ | ------------------------------------------------------------------------------ |
   | Candidates                                       | `min(600, 6s + 3)`                                                             |
   | Catalogue index reads                            | 6 engine searches, including count-only searches; at most two per refill round |
   | Owner index reads                                | 3 keyset seeks; at most one per refill round                                   |
   | Access and dependency points                     | `16 + 8c`                                                                      |
   | PostgreSQL examined rows, including removed rows | `64 + 16c`                                                                     |
   | Shared blocks                                    | Six per budgeted examined row                                                  |
   | Response bytes, PostgreSQL and engine together   | `16 KiB + 4 KiB × c`                                                           |
   | Request bytes, PostgreSQL and engine together    | `64 KiB + 1 KiB × c`                                                           |

   Use at most three refill rounds, each asking for at most `2 × remaining slots + 1`, the existing Search refill
   quota. A read that neither fills its page nor proves exhaustion within these ceilings returns preparation,
   never a short page. Per-candidate points cover original and terminal eligibility, source Access and tuple fence,
   viewer Access, consent and foreign target; per-read points cover the Zone or Collection, source, epoch and
   safety state. A one-read page uses at most 12 statements per PostgreSQL backend. Each page uses one connection
   per backend, shared by all its reads.

   Catalogue engine work is measured in checks as iterator steps: sum `next_doc_count` and `advance_count` from
   the query profile over the whole query tree and all shards. These are the pinned OpenSearch 3.9.0 breakdown
   field names, as verified in its
   [query timing types](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/query/QueryTimingType.java)
   and [timer serialization](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/Timer.java).
   This work has a growth bound only: constant or logarithmic in the population and in the number of matching
   documents for fixed `s` and `ℓ`. Sorting or counting every match fails that bound; such a plan is prepared,
   not direct.

2. **Ready-result plans: prepared public result and prepared owner result.** Each read within a page examines at
   most `2s + 2` candidates and performs at most 2 index reads. Ready rows are already filtered and canonical;
   rejects arise only from disclosure changes since preparation, plus one lookahead. Beyond this budget the read
   returns preparation and the result is repaired, never a short page. Points, examined rows, blocks, bytes,
   statements and connections have the same ceilings as direct plans, using the read's actual `c`.

3. **Composed common page.** Sum the per-read budgets using each read's actual `s`. Share fixed per-page work:
   epoch and control read, safety observation before execution and revalidation before disclosure, one disclosure
   batch per round across reads, and one summaries read. Statements per PostgreSQL backend are at most `8 + 4R`.
   At the limits of 16 reads and 128 slots, all direct, the page ceilings are:

   | Unit                              | Composed-page ceiling |
   | --------------------------------- | --------------------- |
   | Candidates                        | 816                   |
   | Access and dependency points      | 6,784                 |
   | PostgreSQL examined rows          | 14,080                |
   | Statements per PostgreSQL backend | 72                    |
   | Engine searches                   | 96                    |
   | Connections per backend           | 1                     |

   Reject a page whose summed budget exceeds these ceilings at admission with `422 unsupported_query`, or
   prepare the reads that put it over. Sixteen reads at 100 slots each are never admitted: slots, not reads,
   carry the per-slot budgets.

   Charge the query-level privacy observation once per page, shared by all reads: record the privacy-reduction
   heads a public read starts from and revalidate them before disclosure. Coverage includes every home across the
   fixed 4,096 partitions, never only homes of returned candidates. Its ceiling is 2 statements and
   `64 + 2 × (homes with an unacknowledged reduction + homes whose head changed since the start)` examined rows.
   Reading all 4,096 heads at each observation (8,192 rows per page) is not admitted. Complete coverage must use
   an access path proportional to homes that are behind or changed.

   Decision17 capture is inclusive of query plus `readStatus`; report the privacy-coverage subset and whole-page
   totals. Role SQL starts exactly with `/* semantic.privacy-start */` or `/* semantic.privacy-final */`;
   separate keyed own-row SQL starts with `/* semantic.own-rows */`. Missing role attribution fails measurement,
   not zero. If own-row work is merged into final, its full coverage work counts. Keep the existing one-read
   12-statement and composed `8 + 4R` limits, with own-row work inside whole-page cost.

   If a selected final split reads or probes active XIDs, independently hold 1, 8 and 64 native transactions
   with allocated `pg_current_xact_id()` across the inclusive measured read at fixed data scale. Judge examined
   rows, blocks and statements by series. The adopted bound has no active-XID term, so growth on this axis fails
   the bound; this is not a new allowance or a concurrency requirement for layouts independent of active XIDs.

4. **Preparation.** Each durable step has these ceilings:

   | Unit                                             | Per-step ceiling      |
   | ------------------------------------------------ | --------------------- |
   | Input candidates or keys read                    | 1,000                 |
   | Result rows written                              | 1,000                 |
   | Retained-frontier writes                         | 1                     |
   | Access and dependency points                     | 8 per input candidate |
   | PostgreSQL examined rows, including removed rows | `64 + 16 × input`     |
   | Statements per backend                           | 16                    |
   | Engine searches                                  | 4                     |
   | Connections per backend                          | 1                     |
   | Response bytes                                   | 4 MiB                 |

   In total, read each relevant input item once per build; replay rereads at most one step's input. A source
   change touches only prepared results whose admitted leaves it affects, found through an index, never by
   scanning results or definitions. Admit at most 32 live prepared owner results per owner, evicting the least
   recently read first. An idle prepared result expires after 24 hours. A public prepared result keeps one
   current and one building generation per admitted read definition.

   Members preparation transfers all disjoint child reservations from one finite parent before checkout;
   each child's unused capacity stays held until the whole group finishes. Missing declarations remain
   unavailable. Its native History adapter consumes registration, receiving and transfer prices from those
   children, with repeated phases charged to the original finite retry child under the unchanged deadline.
   Accounting completion alone establishes neither current Source authority nor a prepared result; the complete
   Source producer and bounded result/readback integration remain required before mounting the runtime.

5. **Authority.** These numbers are ceilings for admission and checks. Performance changes a number only from
   capture evidence; an owner needing more sends Performance the capture.

### Three-scale checks

Use three geometric scales, **64, 512 and 4,096** (ratio 8; 4,096 is the growth harness cap). Seed growing relations
with production-shaped rows as the kernel README's [Growth checks](../services/kernel/README.md#growth-checks)
describes. Keep the page's own neighbourhood fixed and write one check per axis:

- Catalogue population.
- Matching population: matches grow while `s` stays fixed.
- Sparse matches: `s + 1` matches behind growing non-matches.
- Unrelated history: revisions, retractions and suppressions.
- Owner pools: owners, and one owner's entries, states, labels and holdings.
- Aliases and duplicates: canonical groups up to 4,096 originals at the largest scale (the group admission limit),
  and duplicates on the page.
- Page depth: a deep page reached by cursor.
- Privacy reductions arriving at a rate that grows with population, each acknowledged after its actual repair.

Cover first, deep and sparse pages for each plan kind, plus one composed page with 16 reads and 128 slots.
Every counted unit (candidates, points, index reads, statements, connections, output slots and bytes) must stay
within its number at every scale, with **no slack**. Examined rows must be constant, shared blocks logarithmic,
statements constant, bytes constant in the population, and engine work constant or logarithmic. Each preparation
step must fit its step budget, total preparation work must be linear in relevant input, and an interrupted build
must resume from its retained frontier, rereading at most one step's input. The sparse case must end in a useful
page.

Under the growing privacy-reduction rate, the share of public reads served rather than answered with preparation
must not fall from one scale to the next. If every unacknowledged reduction anywhere blocks every public read,
the served share is about `e^(-λτ)` for reduction rate `λ` and acknowledgement time `τ`; it tends toward zero as
`λ` grows. That is permanent preparation and fails this contract.

Search writes the direct catalogue and prepared public checks; Commerce writes the direct owner and prepared
owner checks; the owner of `POST /v1/zones/{id}:readPage` writes the composed-page check, each using its native
plan. Performance owns the harness enforcing these counted-unit ceilings and reviews the checks. The old
256-proof tests do not count.
