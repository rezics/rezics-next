# Universal search conditions

This document owns the adopted universal search contract. [Filtered lists](filtered-lists.md) owns shared
admission, useful pages, disclosure, identity and numerical ceilings; [Search](../services/kernel/src/search/README.md)
owns execution. [Universal search research](research/universal-search.md) supplies evidence, not runtime proof.
This adoption does not deliver native producers, change a frozen ABI or certify unmeasured bounds.

## One request and configured kinds

One request searches all admitted kinds, mixed by default, with one condition tree, ranked sequence and opaque
continuation. Kind is a condition like scope or tags; multiple selected kinds are OR within that dimension.
Today's `POST /v1/subjects:search` already spans configured subject types and is the first producer of this
capability. New catalogue verticals add definitions and presentation configuration, not per-kind endpoints,
per-vertical indexes/queries or client federation. Preserve the existing catalogue `type` condition and its
released subtype meaning; each configured catalogue type is a kind, not one hardcoded subject category.

A configured registry declares canonical kind identity, producer, condition domains, localized label/icon and
summary capability. Deduplicate by kind plus canonical identity, never title, handle or supporting occurrence.
Catalogue Person/Organisation and a verified account are distinct kind hits: neither merges with nor suppresses
the other. A Realm's backing Space does not create a second hit. Undefined future identities stay unenabled.

Use a hybrid topology: shared derived public projection plus native private producers at actual authority
boundaries. Private Library/Collection facts and protected associations never enter the public
index, including hidden filter fields. A public resource's metadata and its private membership are different
capabilities. New account, Realm, thread, post, Collection or Zone kinds need their owner's actual native
projection, sorted result producer, current disclosure, explicit condition domain and Cost proof before going
live. Content owns Realm, thread and post producers; community is under Content. A label in the registry is
not a producer, and a resource point read does not establish search enumeration.

## Conditions and resource meaning

Use the one released Boolean grammar, typed properties, units and same-statement qualifiers. Expand user,
saved and authorized private predicates together, then exact-deduplicate and admit the whole tree: at most
32 leaves, depth 4, OR 16, `in` 64 and qualifiers 4. Never truncate expansion or drop an OR branch to fit.
An unsupported condition is an admission error. A recognized condition outside a kind's declared domain is
not-applicable/unknown, including under NOT; only proven true selects a hit. Withheld or incomplete evidence
cannot become false under NOT. True OR cannot bypass authorization of any referenced resource.

Resolve and authorize every resource leaf, including under NOT or an independently true OR, before candidates.
Unknown and not-visible resources retain their owner's concealed outcome; they are never Boolean false.
Collection, Zone and Realm resource references are request-only closed UUID operands. Stored saved/dynamic
resource references remain rejected, without recursion. No query-time account selector is added.

- Library uses existing viewer-self `owner.presence`, with the existing qualifying union in
  [owner queries](library-owner-queries.md#presence), not all curated occurrences or an implicit account selector.
- Collection is `{collection:{id:UUID}}`, with no other selector. Manual membership is canonical eligible-occurrence
  EXISTS, unique despite duplicates; curated-only members absent Everything still match. Own dynamic reads use
  current authorized private facts and pins; another reader uses the complete currently disclosed published
  output, never curator-private predicate expansion. Own combined expansion consumes the same grammar limits.
- Agent uses the literal OR over the pinned release's actual `relation.group` credit roster, currently twelve
  roles. There is no family leaf. Its twelve leaves count in full admission. The captured literal OR is unchanged
  on continuation; a later release must not silently recompute that subtree.
- Zone is `{zone:{id:UUID}}`: only actual configured readable PAGE-LIST predicates at current head/release.
  It is not all membership, mounts, starter scope IDs or rendered samples. `TypeList` uses its actual type
  predicate; `SubjectList` uses its bound inverse links predicate, and a null page subject remains `subject:null`.
  Do not invent a generic filter for a nonrepresentable list. Unsupported unions return 422 before enumeration.
  Semantic maintains head/release-keyed compiled page predicates on configuration change: head plus at most
  sixteen compiled rows, not up to 256 raw descriptors re-derived on each request.
- Realm is `{realm:{id:UUID}}`: subjects discussed by currently readable linked discussion or review threads
  on its boards (both kinds participate), including granted protected boards natively. Raw `subject_thread` presence is not listing truth.
  Content checks current thread, opening post, board, place, subject reference and Access disclosure. Every Realm
  leaf requires current Realm read and ban checks, including under NOT. Ban is not a public-index predicate or
  public privacy-head fanout. A known-candidate batch alone is not a Realm-to-subject enumeration anchor.

Subject scope meanings do not automatically apply to non-subject kinds. Collection metadata is not its own
member, Realm/thread/post containment is not the subjects-discussed relation, and Zone metadata is not its page
population. Each future owner declares applicability before admission; undefined capabilities cannot broaden NOT.

## Text and order

Keep actual `body.text` and [parseText](../services/kernel/src/search/text.ts): 512 UTF-8 bytes, group depth 4,
64 leaves, phrases of at most 32 counted tokens, implicit AND, `|` OR, unary `-` and quoted phrases. Escapes are
closed to backslash, quote, pipe, parentheses and hyphen. Empty/whitespace-only input is typed 422 at `/text`;
omitted text differs. Bind raw validated text to the cursor without transport trimming, NFC or casefolding.

Catalogue text includes complete public labels, aliases AND descriptions. Keep `cjk_bigram_v2`: ICU NFKC_CF,
standard tokenization, Traditional/Simplified and Hiragana/Katakana folding, CJK bigrams and stopwords within
analysis. Preserve multivalue phrase boundaries and description-only matches. Native owner evaluation must
preserve this text, analyzer, phrase/Boolean meaning and ranking, not title-only, substring/ILIKE or private-corpus
scores. Private notes, progress and label names add no public text fields.

Default remains relevance with text and name without text. Preserve today's relevance `_score DESC, id ASC`,
exact-name/phrase boosts, name, ID, public-Collection-count and both rating phases with their existing ties,
missing treatment and guards. Ordinary mixed Library/scope, tag, quantity over one million words and text
queries remain required; missing native text support does not make normal search permanently unsupported.

Every participating source must natively sort AND seek a versioned comparable PER-HIT total-order key from the
hit, query and identified ranking context. Include kind and canonical identity as deterministic global ties;
today's catalogue producer preserves its existing ordering. Equivalent owner ranking uses the same public text
and ranking context/statistics, not its private corpus. No raw BM25 versus PostgreSQL `ts_rank` comparison,
rank/set-dependent RRF, min/max or z-score direct keyset, per-kind round-robin or quotas. A formula without native
seek/equivalence evidence is insufficient. Complete authorized retained evaluation may supply the same order.

## Current authority and preparation

[Library preparation admission](library-owner-queries.md#native-preparation-admission) is the sole existing
owner exception: exactly ONE viewer-owned `collection.id` OR one positive viewer-self presence, never both or
several, may reuse Members GET derived preparation. The complete Boolean population must be eligible; a presence
inside OR does not authorize dropping the outside branch or constraining it to Everything.

Use the actual verifiedActor, `principalCommandIdentity`, native eligibility and `accessCommandAuthorization`
for `collection:read` on the ACTUAL resource and source home, including routing beyond four homes. Preserve same
viewer/source-home locality, own fences on viewer and at most two Accounts participants. Endpoint `subject:readGlobal`
admission is independent operationally; it grants no private preparation authority. A viewer string or an
Actor reconstructed from `account:ID` is insufficient; the verified request/deadline bridge remains missing.

Positive presence uses the REAL [Everything identity helper](../services/kernel/src/library/builtin-identity.ts),
owner namespace/route and `['library.collection.builtin', 1, 'everything']`. Never fake an ID, materialize a
Collection or override Access. Native logical-owner read authorization as an operational input remains missing;
the derived ID supplies no permission. Presence, explicit Everything and Members GET reuse the same preparation
basis, quota, rate, dedupe and fences. Locators plus basis fit 4096 UTF-8 JSON bytes with no raw text. Retained
text enters shared-history custody/minimization and viewer erasure.

Foreign Collections NEVER prepare, even when co-located. Other shapes, negative presence, anonymous or string
viewers use direct admission and write ZERO derived rows/workflows. No new operational executor, queue, grant,
receipt, event, outbox, position advance or write permission follows. Admit a bounded direct plan, else an actually
authorized finite preparation, else 422 BEFORE enumeration. Missing producers and honest admission rejection do
not complete ordinary query capability. Successful pages fill the requested size or prove final exhaustion;
unchanged finite input must progress to useful pages, never endless preparation or empty successful continuation.

Public anonymous direct reads do not require authentication. Missing required credentials give
`401 authentication_required` with bare `WWW-Authenticate: Bearer`. Invalid, expired, revoked and pre-suspension
bearers give `401 invalid_credentials` with `Bearer error="invalid_token"` BEFORE route execution, without
anonymous downgrade. Verified suspended 403 is defensive only. Keep existing native suspension personas; do not
fabricate a valid suspended bearer.

## Whole-query disclosure and Accounts discovery

Current authority protects the full query: membership, NOT, exclusion, order, zero-hit populations, counts,
labels/images/URL inputs and cursor information. Check original AND terminal eligibility, source/Collection
Access, consent, foreign dependencies and tuple fences. A returned-ID check cannot certify excluded rows.
Observe safety before execution and revalidate after all query/count/summary work, including a reduction that
arrives and is ACKed during execution. An old PIT plus a live repair ACK is not a safe queried observation.

Content reductions originate in Content's OWN authoritative transaction and register shared heads. Semantic
owns its selected-public-facet reduction log; Search owns refresh-visible dependent repair/ACK. The literal
Semantic-log port is not frozen for Content pending its actual native plan. Protection, unlink, move, removal,
takedown/lift and erasure cover every query dependency, including local/foreign and original/terminal support.
Protected associations stay native even when the Realm is public. Current Realm read/ban checks are separately
charged within existing work, not extra public privacy probes. Whole-query privacy producers remain missing.
Ordinary public lag remains 60 seconds healthy, readiness beyond five minutes; owner writes affect next read,
while privacy reductions are immediate.

Accounts discovery hits AND counts use exactly `state = 'active' AND NOT authn_fenced`. Any authentication fence,
including suspension, removes discovery from T; no field, reason or order reveals WHICH fence. Attribution by
`ids` presenting suspended as ACTIVE is separate. Pending, deleted and erased identities are not discovered.
Lifting a fence is ordinary publication; verification reversal is a field reduction.

First account text is ONLY handle and displayName; biography/links require a later Accounts decision. Catalogue
descriptions remain searchable. Account summary preserves the exact public `ids` identity item (`id`, `kind`,
`handle`, `displayName`, active public `state`, `automated`, `operatorId`), avatar under the profile guard and
verification while the actual agent read still returns that account. Exact handle treatment uses only the
ACTIVE claim, case-insensitively under the owner rule. Former-handle forwarding/`movedTo` serves direct lookup,
not search alias ranking. Copies enter shared-history custody/minimization through the existing fixed identity
participant; fence, deletion and erasure remove discovery immediately, without ordinary projection lag.

## Global consumed frontier

Use ONE opaque last-CONSUMED frontier F. Seek every source strictly after F in the common order. Before consuming
or emitting the next candidate, every source supplies its next head or proves EOF; an unresolved source cannot
be omitted. Deduplicate canonical hits with equal keys while charging every supporting candidate. Prefetch does
not consume: discard unused buffers and re-seek F on the next request, never each buffer's last fetched key.
Consume rejected lookahead only when it reaches the global head, stopping before the next eligible unreturned
head. Unconsumed prefetched hits remain reachable. No false exhaustion or empty successful continuation.

For an unchanged identified observation, every unconsumed head is after F, so seeking after F loses no hit.
Live keysets do not promise a cross-database snapshot under arbitrary edits. Ordinary row writes do not change
order meaning or trigger registry-wide restart. Actual physical generation, comparator/producer-set or published
identity meaning changes retain `409 search_restart_required`; pending identity/currentness requires readiness.
Re-resolve current resource heads, release and authority on every continuation within the fixed budget.

Preserve the confidential [Search cursor profile](../services/kernel/src/search/README.md#confidential-cursor-and-bounded-name-sort):
8 keys, 2560 UTF-8 bytes/key, 3072 aggregate string bytes, 3584 serialized bytes and 4864 token characters,
15-minute expiry, constant decode attempts (currently two compatibility bindings), length rejection before decrypt
and zero-I/O decode. Bind raw request, viewer, languages, sort, release and static meaning; authenticate before
dynamic checks. Malformed/tampered/mismatched cursors retain 400; authenticated expired/changed context restarts.
Preserve all rating phase/question/population/prior guards. Hashes do not recover authoritative guards or PITs.

Research's compact six-plus-two keys at proposed Smax=2 derive 1877 aggregate bytes, 3536 plaintext bytes and
4760 token characters; these are capacity PROPOSALS, not native codec proof. Today's rating already uses eight
keys. Actual maximal control/non-BMP/score forms, observation recovery and current privacy must be measured.
No free public retained observation store follows: principal-class quota, global cap, expiry, custody and erasure
need actual authority before writes, including anonymous requests.

## Kind facets and generic hits

[Search facets](search-facets.md#kind-count-exception) owns the narrow count exception. Disjunctive counts remove
ONLY the designated kind leaf directly under top-level AND. Nested OR/NOT kind leaves and ALL other predicates
remain untouched; without a designated leaf the count query is unchanged. Authorize and budget that potentially
broader population separately. There is no AST distribution or removal of every kind predicate.

`{value, exact:true}` requires certified complete canonical membership. `exact:false` means ONLY a certified
positive lower bound displayed `N+`; unknown/unavailable is omitted or marked unavailable, never zero. No zero
lower-bound badge. Exact zero requires authorized complete absence. Count logical hits, not occurrences,
unchecked engine buckets, page length or estimates. Fixed maintained counters must match the exact population
and change atomically with membership/privacy; checked enumeration is exact only on complete exhaustion.

Metadata is a fixed bounded PAGE in configured order, never count order: data kind ID, localized label and icon.
One More kinds control uses metadata continuation without excluding unshown kinds from hit search. Counts are
attempted once on the initial query and retained across hit continuation; changed conditions start a new query.
Later metadata can have unavailable counts. K_page=8 is a research proposal pending first native measurement,
not a frozen output/engine allowance. Existing property/value facets and public totals remain count-free.

Every hit has a generic base sufficient to render/link without an additional read: canonical ID, registry kind
and localized kind label, title label with actual BCP47 language, optional currently public image plus aspect
class, and public canonical URL inputs. Kind summary extends this with approved catalogue description/type,
Collection description, Realm/Zone context or readable thread/post excerpt and context. Unknown newly configured
kinds render the generic base. Inaccessible parents, erased text and private counts cannot supply fields.

## Cost

Every operation uses [Filtered lists budgets](filtered-lists.md#budgets), without per-source/kind/leaf allowances.
Charge fixed metadata, authorization, counts, cursor, failed/rejected/duplicate/lookahead/discarded work and rereads.
These are acceptance obligations; native SQL, Access and engine feasibility are not established by this adoption.

### Condition admission and resource resolution

- Touches: complete text/condition trees, pinned credit roster, resource identities/heads/release, current Access,
  own private expansion or foreign published output, compiled Zone pages/readability, Realm read and ban.
- Bound: parsing is linear in bounded request bytes; expanded 32 leaves/depth 4/OR 16/in 64/qualifiers 4 apply.
  Resolution shares 16 fixed points, 64 fixed examined rows and the page statement ceiling with ALL fixed work.
  Zone head plus at most 16 compiled page rows replaces raw descriptor enumeration. Overflow returns 422 before
  candidate enumeration, without truncation. Re-resolution on continuation has the same budget.
- Growth check: 64/512/4096 catalogue, owner history, Collection, mount, board/thread and configuration populations;
  fixed rows/points/statements, logarithmic blocks, expanded 32 admitted and 33 rejected with zero candidates.
  Maximal supported compiled Zone and changing current authority must fit the same fixed terms.

### Mixed subject read

- Touches: native positive anchor and remaining predicates, complete text, Collection membership, compiled Zone,
  Content candidate disclosure, original/terminal eligibility, source/viewer Access and summaries.
- Bound: direct candidates `c <= min(600,6s+3)`, three rounds, `2*remaining+1` candidates/round; six engine searches
  including counts, at most two/round; three owner seeks, at most one/round. Points `16+8c`, SQL rows `64+16c`,
  six blocks/budgeted row, response `16KiB+4KiB*c`, request `64KiB+1KiB*c`. One read uses at most 12 SQL statements
  per backend; composed pages use `8+4R_reads`, `R_reads<=16`, sum slots<=128 and ONE caller connection/backend.
  Composed maxima remain 816 candidates/6784 points/14080 rows/96 searches. Each distinct other-reader Collection
  output is a ready-result read: `2s+2` candidates/two index reads. Agent is ONE indexed EXISTS per candidate over
  the pinned roster, not twelve probes or a statement-list scan. Realm requires one multi-home batch/backend/round
  on the PAGE's caller connection: at most 201 candidates TOTAL across homes and both kinds, within 256/call,
  at most four thread checks TOTAL/subject INSIDE eight points and at most three rounds. Unknown remains unknown
  under NOT. A real Realm-only anchor requires public prepared listed projection or actually authorized native
  enumeration; a known-candidate batch cannot substitute. These Realm native producers remain undelivered.
- Growth check: 64/512/4096 credit/noncredit statements, manual/dynamic/published members, compiled lists and Realm
  boards/threads/homes/backends, including granted protected boards. Measure large-owner/sparse-text AND
  many-text/small-owner, full scope/tag/quantity/text, descriptions/aliases/phrases/default order, all sorts/depth,
  unknown OR/NOT and full/final pages. Prove bounded advancing progress when the first four threads fail and the
  fifth is eligible, without silently declaring absence or returning endless unknown.

### Realm projection and drain

- Touches: public listed subject/Realm/thread associations; link/unlink, revise, move, protection, removal,
  takedown/lift, erasure and visibility reductions originating in Content's authoritative transaction/shared heads.
- Bound: thread changes follow the owner's bounded linked subjects; board/Realm fanout uses paged retained
  frontiers, linear total in affected threads, never synchronous request fanout. The SAME whole-query privacy
  observation covers 4096 homes once/page: two SQL statements, `64+2*(behind homes+changed homes)` rows. No head
  vector or per-Realm/board/thread safety probe. Separately charge native membership/current read/ban; bans do
  not fan out public heads. Projection/dependency rows enter erasure inventory and bounded reclamation.
- Growth check: 64/512/4096 boards, threads, linked subjects and Realms; bounded steps/linear total, crash/replay,
  local/foreign original/terminal dependencies, NOT/exclusion/order/zero-hit populations, old PIT after live repair
  and reductions arriving/ACKed during execution. Actual served share must not fall as reduction rate grows.

### Preparation and maintenance

- Touches: authorized complete public/owner evaluation, structural owner directory, text positions/provenance/rank
  input, compiled Zone predicates, dependency indexes, activation/catch-up, retained frontiers, erasure/reclaim.
- Bound: existing step ceilings: 1000 input keys/candidates, 1000 result writes, one frontier write, eight points/input,
  `64+16*input` rows, 16 SQL statements/backend, four searches, one connection/backend, four MiB response. Stronger
  Library 100-row steps still apply. Total is linear in finite relevant input; replay rereads at most one step.
  At most 32 live owner outputs, 24-hour idle expiry; public one current/one building generation per admitted
  definition, not permission for a per-request public store. Only the exact authorized one-owner exception above
  may prepare. Config changes maintain compiled Zone rows; new-query release admission resolves Agent roster,
  never mutating captured literal OR. Subject text copies update holders in paged steps; changed dependencies
  locate affected definitions through indexes. Storage includes heap/TOAST, all indexes/positions, MVCC/WAL,
  abandoned generations and cleanup; directory/result/frontier/intent copies require custody and viewer erasure.
- Growth check: 64/512/4096 inputs, holders and dependencies; bounded steps, linear total, interruption/replay,
  coherent complete activation, source withdrawal and behind-frontier changes. Verify same-basis dedupe, actual
  routing beyond four homes, native eligibility/fences and zero writes for unauthorized shapes. Fixed finite input
  must settle useful pages without skipping unexamined potentially better-ranked hits.

### Mixed-kind ranked page and kind counts

- Touches: actual physical read inventory, comparable native seek streams, global frontier/dedup, whole-query
  privacy, summaries, configured metadata and initial broader disjunctive count evidence.
- Bound: no new allowance. Native composition must fit 12 SQL/backend for one read or `8+4R_reads` composed,
  16 reads/128 total slots, existing round/candidate/engine/Access/byte ceilings and one connection/backend.
  Each independent Collection output consumes actual reads/slots even on the same database. Research Smax=2,
  C=2 and K_page=8 remain PROPOSALS until first implementation measures the complete envelope. Proposed staged
  `n+1,n+1`, then competitive third-round `2r+1`, derives `H<=4n+3` for n=1..100; it proves candidate algebra,
  not native SQL/Access/engine bounds. All heads/EOF are required before consumption. Count enumeration runs only
  when the third round is spare, at most `min(C,2r+1)` raw candidates: a full page permits ONE, not two. Hit refill
  makes C=0/unavailable. Count source/SQL/engine/privacy work must fit the same envelope; no match-linear direct
  aggregation, repeated continuation counts or `terminate_after` fiction about sparse/shard iterator work.
- Growth check: Search owns the merged-page native capture using Performance's harness at 64/512/4096. Measure
  actual S=1 and proposed Smax, n=1/2/20/100, dominant kinds, overlap/rejects, all sorts/phases/depth, Collection OR
  read multiplication, source failure and broader count authorization/privacy. Include common-page 16 reads/128
  slots. Grow matches/corpus/history/configured kinds independently; record iterator steps, raw candidates,
  SQL examined/removed rows, blocks, Access, bytes, retention and cleanup. At logical ten million matches only
  exact fixed maintained evidence, capped fully checked witnesses or unavailable counts are admissible. Rare
  unseen kinds are unavailable, never zero. Measure cursor maximum/recovery and prefetch continuity too.

## First implementation slice and native delivery gaps

Implement today's `subjects:search` kinds through the existing type condition, kind facets and generic base,
with growth proof. This document does not change runtime, types, routes, tests or immutable templates. The first
S=1 producer must stop discarded `track_total_hits:10000` via a NEW versioned hit template/parser with total
tracking disabled and omitted-total handling; immutable v2 stays unchanged. Preserve complete payload validation,
shards, final generation/privacy checks and separately measure overflow aggregation. Disabling totals alone
establishes no iterator bound. Capture whole-tree/all-shard `next_doc_count+advance_count` for relevance, name,
ID, Collection count and both rating phases, first/deep/sparse pages, with matches, corpus and history independent
at 64/512/4096. Actual native contradiction reopens the precise Cost decision, not another prose review round.

Required missing producers and their native failing/unsupported cases are:

- Search: versioned count-free hit producer, comparable multi-source planner, global cursor and merged-page capture;
  currently no heterogeneous stream proves dominant-source top n+1, exact ties, rejects/refill or maximal recovery.
- Semantic with Search: complete public text/rank/currentness and whole-query reduction/repair seam; description/
  alias/CJK/phrase/default-rank conformance, exclusions and an old PIT after repair remain required native cases.
- Commerce with Search/Semantic: structural directory, equivalent owner text/rank, finite complete evaluation and
  activation/custody; both sparsity axes, manual-only members, label/history-only presence, original/survivor
  disclosure, interrupted activation and paged text-holder updates remain required.
- Accounts/Access with Commerce: actual logical Everything operational authorization/native source eligibility;
  more-than-four-home routing, same-viewer fences and OR branches outside Everything must be tested. Search with
  HTTP/Access owns the verified request bridge; anonymous/string/foreign cases must write zero.
- Content: multi-home Realm batch, real Realm-only subject anchor and Realm/thread/post result/count producers;
  201 total candidates, both kinds, four checks inside eight points, fifth-eligible progress, protected grants,
  unlink/move/takedown/erasure and ban under NOT are still native requirements, not delivered bounds.
- Accounts: account discovery text/result/count producer; active/unfenced hit-count equality, every fence at T,
  pending/deleted/erased absence, active exact handle, avatar/verification guards, distinct Person/account hits
  and shared-history erasure need native cases. Attribution reads do not supply discovery enumeration.
- Search with Semantic/Commerce/Content and Zone owners: configured registry/summary/metadata and truthful count
  evidence. Grow kinds without per-kind queries, render unknown configured kinds without extra reads, prove
  designated-leaf removal, exact/lower-bound/unavailable evidence and whole broader population privacy.

These cases are future native delivery requirements, not tests supplied or passed by this documentation change.
No invented callable ABI closes them. Full Scope, original Goal acceptance and main/root gates remain unchanged.
