# Zone TypeList native order with bounded membership residuals

Research evidence, 2026-10-28. This report proposes no adopted decision or runtime change.
The question is whether the existing native Search order can drive a Zone TypeList while
current Zone membership is a bounded residual, without changing the decided UUID order of
`GET /v1/zones/{id}/subjects`.

## Finding

The composition is sound **conditionally**, but no inspected production seam implements it.
Use the SAME Search compiler and native ordered candidates, then prove the TypeList predicate,
current Zone union membership and subject Access before committing each candidate. Preserve
the native tuple and stop before essential unknowns. This is a different traversal from the
canonical-UUID union endpoint; sorting its truncated output cannot implement TypeList.

Two additions require owner agreement before runtime: an internal, service-bound **ordered raw
candidate** operation, and an explicitly reviewed continuation layout/profile for that operation.
The existing UUID `prefix` contract must remain intact. Current canonical coverage, identity,
leaf and Collection contracts are prerequisites, not evidence of working native composition.
The shared encrypted codec can represent a carefully bounded proposed position using its
**Search profile**. The existing Zone default profile and existing eight-field UUID layout
cannot be reused unchanged. Neither profile selection nor the new layout is approved here.

## Inspected repository evidence

The worktree baseline is `d280a1f25d0cbf092428cb5b81e6b0599dd1c50a`.
Repository code is AGPL-3.0-only, as declared in [`package.json`](../../package.json).
Both [Zones](../zones.md) and [Zone membership](../zone-membership.md) were read in full.
Only implementation/contracts were inspected; no independent researcher's answer was read.
Additional committed owner snapshots were read with `git show`, without changing checkouts.
The following paths are relative to the repository root unless a different repository is named.

| Evidence | Actual observation and limit |
| --- | --- |
| [`packages/composition/src/registry.ts`](../../packages/composition/src/registry.ts), `TypeList` | Declares `sort: 'name' \| 'collections'`, 1–8 types and limit 1–24. Its descriptor is `kind:'search'`, a type filter and the declared sort. There is no Zone selector. |
| [`packages/composition/src/reads.ts`](../../packages/composition/src/reads.ts), `planReads` | Plans registry-owned reads, canonicalizes equal descriptors, maps nodes to read keys; maximum 16 distinct reads, page cost 128. It does not execute or restrict Search. |
| [`services/kernel/src/presentation/http/pages.ts`](../../services/kernel/src/presentation/http/pages.ts), `pageAnswer`; [`presentation/reads.ts`](../../services/kernel/src/presentation/reads.ts), `readPage/executeRead` | The page plans once, reuses probes and dispatches pending descriptors. Search dispatch is `POST /v1/subjects:search`; original authorization/session and selected languages are forwarded. Equal descriptors share results; statuses/bodies and session merging are preserved. There is no implicit Zone intersection. |
| [`search/service.ts`](../../services/kernel/src/search/service.ts), `search` | Admits the shared filter, uses `compileFilter`, native hits and `checkHits`, then projects public DTOs. Up to three rounds request `min(200, 2*remaining+1)` hits each. Rejected/unproven hits are consumed, including rejected lookahead. A public page hides the examined stream and unknowns. Its ceiling is not the Zone 256 ledger. |
| [`search/query.ts`](../../services/kernel/src/search/query.ts), `searchSubjects`; [`subjects-search-v2.json`](../../services/kernel/db/search/templates/subjects-search-v2.json) | Genuine hits retain `matched_queries`, concrete index, partition, security revision and raw sort tuple. Native tuples are `[name_sort,id]` or `[public_collection_count DESC, name_sort,id]`, with count missing as zero. The template currently requests totals up to 10,000. The baseline dispatch uses the alias even though `SearchPlan` exposes `generation`. |
| [`search/disclosure/check.ts`](../../services/kernel/src/search/disclosure/check.ts), [`current-filter-plan.ts`](../../services/kernel/src/search/current-filter-plan.ts), [`current-leaf.ts`](../../services/kernel/src/search/current-leaf.ts) | Existing shared Boolean evaluation preserves unknown under NOT and uses matched clauses only to prioritize current work. `checkHits` turns unresolved truth into a dropped public hit, rather than exposing a resumable residual verdict. It rejects redirected/current-revision-mismatched subjects. |
| [`search/scope-source.ts`](../../services/kernel/src/search/scope-source.ts) | `prepare/prefix/evaluate` are exported admission/reservation scaffolds. Prepare parses/admits the active release and calls the SAME compiler, then throws `semantic_not_ready`. Valid prefix/evaluate also throw. Prefix is specifically ascending canonical UUID, takes `afterSubject`, reserves quota plus lookahead and returns covered raw boundary/exhaustion. Evaluate takes explicit remaining raw keys and separate native axes. |
| [`search/service-scope.ts`](../../services/kernel/src/search/service-scope.ts) | `createSearchScopeForService(service, actualLeafOptions)` is the intended owner handoff, using actual Access/actor/route key/deadline/native time. Runtime registration is private to actual service construction. The inspected factory still throws `index_not_ready`; baseline `service.ts` does not register a runtime. A typed handoff is not delivered binding or execution. |
| [`search/coverage.ts`](../../services/kernel/src/search/coverage.ts), [Search README, canonical index coverage](../../services/kernel/src/search/README.md#canonical-index-coverage-producer) | Incarnation, population/coordinator/certification and reader APIs are real adopted contracts; their exported functions throw `index_not_ready`. A physical UUID, controlled writer lineage and complete missing/extra-key coverage are required. Equal counts, fresh partition checkpoints or Semantic readiness alone do not certify canonical index hits. |
| [Semantic README, identity and owner handoff](../../services/kernel/src/semantic/README.md#resumable-alias-groups-and-owner-handoff); [`semantic/scope-leaf-evidence.ts`](../../services/kernel/src/semantic/scope-leaf-evidence.ts) | Identity basis, terminal/original authorization and resumable alias enumeration are specified. Baseline has no `identity-basis.ts`, `terminal-identity.ts` or `alias-group.ts`; native fixtures resolve these only after command/Access baselines. The leaf producer validates reservations and returns `not_ready` with zero usage. It does not yet produce facts/coverage. |
| [`library/canonical-source-store.ts`](../../services/kernel/src/library/canonical-source-store.ts) and [`test/library/canonical-source-fixture.ts`](../../services/kernel/test/library/canonical-source-fixture.ts) | Derived-store contracts preserve native source/alias keysets and accounting. They do not establish the missing owner adapter. The fixture dynamically requires `src/library/collection-source.ts` after native setup. |

These are moving owner branches, so their committed states were inspected rather than assuming
that staging or a dependency's scheduling status means production:

- `077606f8f63b193240d05a731e35cdbfcf45de1a`: coverage storage contract now explicitly
  preserves verified same-basis coverage during ordinary enrollment; structural changes still
  invalidate it. Its `search/coverage-store.ts` factory remains an unavailable specification stub.
  The inspected coverage producer/native/growth branch tips at `69dfb104b8` add no production
  execution beyond the baseline. These are independent pending deliverables, not dev-only promises.
- `e9488b55fc936656f60e4198f09c16c7c61af8d0`: explicit shared remaining-key reservation,
  five native axes and one pending leaf were incorporated in the scope contract; still scaffold.
- `4970f37e0d6f7968633a2650e1042345303a428c`: service-bound factory contract, not runtime binding.
  `60256087ac7071cebac5f05dc2f68f20693a9e7b` adds built-in Collection identity storage,
  which does not make either service binding or Collection membership production-ready.
- `740b40d5f5`: the actual Commerce/Library owner ABI is
  [`services/kernel/src/library/collection-source.ts`](https://github.com/rezics/rezics-next/blob/740b40d5f5/services/kernel/src/library/collection-source.ts),
  with its [owner contract](https://github.com/rezics/rezics-next/blob/740b40d5f5/docs/collection-source.md).
  Its factory's every method throws `dependency_unavailable`. It is absent from this baseline;
  do not invent a second `src/commerce/collection-source.ts` from the older document shorthand.
- `c441ba446a` adds physical generation selection to `searchSubjects`. That useful additive
  query change is absent from baseline and alone does not verify physical UUID or completion.
- `3aef73ab31` adds `search/bounded-sort-keys.ts`, applying the real normalizer with singleton
  `_analyze` requests, concurrency 16, and full-result length checking. The inspected commit
  adds only that helper: it is not evidence that all writers/replay call it. The adopted README
  describes analysis chunks up to 256; actual helper dispatch must be measured, not inferred.

The Collection ABI is concrete: `createCollectionSource({pool,access,clock?})` has
`prepare`, canonical `prefix`, `containsSubject`, and a separate raw stored-ID prefix helper.
Every call requires actual `{actor,at,deadline}` and a pre-reserved multidimensional allowance.
`containsSubject` returns true with current evidence, false with complete negative evidence, or
`not_proven` with bounded progress/readiness. Its optional positive evidence is a recheck hint.
Curated, private built-in, activated and frozen output authorities remain with this one owner.
For TypeList residuals use `containsSubject`; do not prefetch every Collection or page public members.

## Established sort-and-residual patterns

Reference clones were reused read-only, through Git objects where sparse files were absent.
Nothing in them was installed, built or executed. Both source revisions and licences are recorded
in the reference cache's `INDEX.md`; recommendations concern designs, not copying source files.

| Primary source and licence | Finding relevant to this question |
| --- | --- |
| OpenSearch 3.9.0, `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`); cache `search-rating-populations/opensearch` | [`SearchAfterBuilder.java`, `buildFieldDoc`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L125-L155) checks tuple arity, converts values with each field's native format and preserves null. This is evidence for exact native continuation, not reconstructed display-name cursors. |
| Same OpenSearch revision, [`QueryPhase.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/QueryPhase.java#L225-L245), [`FilteredCollector.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/common/lucene/search/FilteredCollector.java#L67-L85) | Native post-filtering gates collection of each matching document into top hits; aggregation collectors have a different scope. This is inside engine collection, not filtering one already truncated output page. It provides neither distributed owner authorization nor resumable three-valued unknowns. |
| PostgreSQL current source snapshot `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`); cache `library-shelf-maintenance/postgres` | [`src/include/executor/execScan.h`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/executor/execScan.h#L180-L252) repeatedly fetches a candidate, applies residual quals and counts rejects. [`nodeIndexscan.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeIndexscan.c#L133-L155) separately rechecks lossy index candidates; [`nodeLimit.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeLimit.c#L89-L130) asks its child for output rows. A LIMIT on output is not a bound on examined candidates. |

[OpenSearch pagination documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)
requires a unique final sort field and the last native sort values for `search_after`.
It distinguishes live pagination from a PIT snapshot: changes can move records across a cursor.
[Sort documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/sort/#handling-missing-values)
specifies missing-last by default; [filter documentation](https://docs.opensearch.org/latest/search-plugins/filter-search/)
distinguishes hit filtering from aggregation scope. A native filter does not compute a Zone total.
[PostgreSQL EXPLAIN documentation](https://www.postgresql.org/docs/current/using-explain.html)
shows output rows alongside removed-filter/recheck rows and buffers; measure all of them.

**Shared pattern, inferred:** preserve the index's ordering and seek identity, separate discovery
from authoritative residual evaluation, and account for rejected work. Existing engines normally
continue internally until output LIMIT; Zone must instead interrupt at its explicit shared work
budget. None of these sources supplies the missing stop-before-unknown, cross-owner authorization
or compact pending-group protocol. Those are repository-specific obligations.

## Smallest honest composition: proposal, not an implemented port

Let `T(s)` be the current admitted TypeList filter and
`U(s) = scope1(s) OR ... OR mount1(s) OR ...`. The output condition is current
`T(s) AND U(s) AND subjectAccess(s)`, after current Zone admission. This uses the existing
Boolean machinery and actual owner policies; a mounted member is never manufactured into a Hit.

1. Obtain the service-bound Search owner with the actual `LeafOptions`. Prepare the TypeList
   query through existing release expansion/admission/compiler and verified canonical coverage.
   Pin the concrete generation/index UUID and sort-template/name-key compatibility basis,
   including zero-hit cases. Prepare at most 16 scopes and 16 mounts with charged native work.
2. Search supplies bounded raw candidates in the declared native tuple order. This is internal
   streaming of the admitted TypeList candidate superset, not a public global unfiltered list.
   The driver must retain real `matched`, partition, index, revision and exact tuple values;
   neither change names/ranking nor apply UUID paging first. No hidden drop/refill rounds.
3. For each candidate, Search proves its current TypeList predicate and owners prove current
   union membership. Search scopes use the existing bounded point `evaluate`; Collections use
   `containsSubject`, including original/terminal Access and built-in/public-output authority.
   One independent current true source settles OR even if another source is unknown. An
   unknown TypeList predicate still blocks when the remaining conjunction cannot settle false.
4. Commit only terminally decided candidates, including definitive rejects. A positive is
   projected through existing safe DTO/disclosure code after fresh positive/source/Zone checks.
   Do not rerank by current display labels or replace the native global public Collection count
   with a mount count. Do not serialize raw candidates, source identities, private facts or totals.
5. On essential unknown, retain the boundary before that candidate. Return an earlier settled
   subsequence, or actual advancing pending group/leaf progress; with no progress use existing
   retryable readiness. Retain ONE deterministic owner and group, and reread later sources as
   necessary, charging every reread. Reserve room for an independent decisive OR probe.
6. Resume the pending original/leaf before moving its alias/group keyset. Once fully settled,
   consume that candidate's native tuple. At EOF require definitive native range completion and
   no pending group. Underfill and advancing empty pages are legal; unchanged empty success is not.

**Required additive Search owner contract:** an ordered sibling to UUID `prefix`, on the SAME
prepared service runtime, selecting only `name|collections`, accepting exact native `after`, a
pre-reserved quota/remaining ledger and native axes, and returning genuine raw hits, pinned basis,
last covered native tuple, truthful exhaustion and actual work receipts. It must permit retaining
the predecessor tuple while one candidate is pending, and re-fetching that first unconsumed
candidate under the same plan. It must reject partial shards, timeouts, early termination and
malformed tuples even on empty results. Existing `query.ts` discards completion metadata; native
acceptance in `test/search/query-completeness.test.ts` already names this unfinished obligation.
An internal mode must suppress totals/count aggregation work that the existing public template
always requests. No restricted-total claim can be derived from public Search's totals.

This proposal requires no new owner membership language, Zone index, SQL authority, holder
directory, permission engine, cryptography or public HTTP decision. Commerce needs its agreed
adapter implemented, not an additional ordered Collection API. Canonical UUID union listing
continues using existing `prefix`; it is not a source of TypeList order.

### Canonical uniqueness is a prerequisite

Real canonical Search hits must exist before this argument establishes deduplication. Coverage
must prove that the physical controlled index contains canonical original IDs at the ready
structural basis, including removal of stale aliases and presence of the survivor. Each canonical
subject then has one unique native hit/tuple, while original aliases remain membership evidence.
Overlapping scopes/mounts merely yield multiple proofs for that hit; no seen set is needed.

If aliases `a,c` still occur as raw hits for survivor `z`, their different names/counts can put
them on different pages. Normalizing IDs afterward creates duplicates and may never find `z`'s
actual sort position. An arbitrary readable representative does not fix that. No certificate
may be inferred from direct bulk fixture setup, identical counts or a native ready identity basis.
The adopted coverage protocol requires controlled initialization/population, durable enrollment
before source/external I/O, real bulk visibility and checkpoint outcomes, writer exclusion,
bracketed native home comparisons, and lifecycle UUID/lineage checks. Ambiguous writes and
tombstone-pruning/name-reuse races cannot be repaired by filtering hits after paging.

### Accounting and finite progress

Every observed raw candidate, duplicate, alias/member key, internal leaf/fact-driver key,
lookahead, reread, final recheck and exhaustion-key probe debits the SAME aggregate 256 ledger.
Deduplication, a second pool, batching and lack of public output grant no exemption. Fetching 101
keys with only 100 reserved is invalid even when one is discarded. Concurrent reservations
cannot overlap. Native errors must settle actual work, not report zero by omission.

Independently reserve points, witnesses, rows, bytes, empty seeks and owner statements. Each
native leaf call has at most 101 keys/100 witnesses; the Collection source window caps all its
internal drivers at 100 keys, including lookahead. Convert owner receipts losslessly into the
same outer ledger. PostgreSQL rows/buffers and OpenSearch candidate instrumentation are both
needed; a 256-hit bound says nothing constant about physical postings or engine sort/count work.

Each full identity-basis read costs two 4096-home sweeps: **8192 metadata observations plus
Core home/epoch work**, at every required preparation, continuation and final observation.
The coverage reader brackets with TWO full bases (16,384 metadata observations plus Core),
adds 4096 native home comparisons, 4096 coverage points and physical incarnation reads.
Do not label this free metadata or bury it in per-leaf slack; avoid per-candidate global sweeps.
These are separate native costs, not a fictitious 8192-candidate debit or an exemption for facts.
If an owner probe invokes another full basis read, charge that occurrence too; naming a shared
phase cannot exempt actual per-probe work.

Finite completion requires fixed finite candidates/identity, ready complete owner indexes and
finite definitive native proofs/repair. A settled native tuple advances strictly; pending work
must advance a bounded alias/source/leaf keyset. Later candidates cannot pass an essential unknown.
Every such position is finite under that premise. Ordinary name/count/visibility or late candidate
changes can require fresh traversal under existing live-keyset semantics; no PIT is proposed.
Quiescence alone does not make an unsupported negative proof definitive.

One pending leaf does **not** prove that all admitted multi-leaf queries can terminate within
256 including final rereads. The shared evaluator requires a result for every deduplicated leaf;
the leaf contract allows sizeable selected/witness work. Recomputing earlier leaves may exhaust
the allowance repeatedly. Owners must demonstrate definitive resumable evaluation and a fitting
final revalidation unit, without serializing prior truth or witness vectors. If that fails for
an admitted plan, this design has a real unresolved owner contract, not permission to drop the
candidate, weaken admission silently or promise liveness from the cursor's small size.

## Cursor evidence and an explicitly conditional fit

[`tokens/list-cursor.ts`](../../services/kernel/src/tokens/list-cursor.ts) really exports
`encodeListCursor/decodeListCursor(..., {profile?: 'default'|'search'})`.
Profile defaults to `default`; Search selection adds `search` to authenticated associated data.
The binding authenticates route, viewer and canonical query; cross-profile decode fails.
Default anonymous sealing is deterministic/timeless, accounts expire after 15 minutes.
Search uses random salt and a 15-minute lifetime even anonymously, with 60 seconds future allowance.

| Authenticated profile | Keys | UTF-8 bytes/key | Aggregate string bytes | Plaintext bytes | Token characters |
| --- | ---: | ---: | ---: | ---: | ---: |
| Zone's agreed default | 8 | 256 | 2048 | 3038 envelope-derived ceiling | 4096 |
| Existing Search codec option | 8 | 2560 | 3072 | 3584 explicitly checked | 4864 |

The adopted native name bound is **512 UTF-16 code units after the real index normalizer**;
it permits 1536 UTF-8 bytes (512 three-byte BMP characters), or **1537** with the `s` tag.
A real 250-CJK-character name needs about 750 bytes before tagging. Default's 256-byte field
cannot hold it. Never truncate/hash, split a sort key to evade the agreed layout, or silently
raise Zone defaults. Oversized normalized names must become native null/missing-last at write
time, with full display/exact names retained and actual new-generation replay before readiness.

Runtime gap: baseline `search/cursor.ts` still calls `tokens/cursor.ts`, not the encrypted list
profile; baseline `document.ts/indexer.ts` still supplies raw names (and a missing-name sentinel)
directly to bulk. The mapping has a normalizer but no enforced normalized bound. Merely declaring
`MAX_NAME_SORT_CHARACTERS=512`, or adding the isolated helper, does not establish a production
1537-byte maximum. Arbitrary older raw keys therefore cannot be promised to fit either profile.
Null and the old sentinel are different native values; migration must establish the new contract.

The existing UUID position is exactly
`[basisDigest, settledCanonicalId, groupId, sourceOrdinal, aliasAfter, sourceAfter, ownerBasisDigest, formatVersion]`.
Its 18-byte Search leaf record is 24 base64url characters: version/leaf, phase/value and sequence
or full witness UUID. It encodes no name, ranking count, group, source ordinal, subject or basis.
It cannot simply absorb a native tuple. Collection progress instead has its reviewed 77-byte
`1:<driver>:<storedSubjectUUID>:<factUUID>` record. Both depend on independent outer identity.

**Sizing proposal only:** approve a separate ordered operation with the existing authenticated
Search profile, stable operation/version binding and a reviewed replacement eight-field layout:

`[traversalBasis, countTag, nameTag, idTag, pendingGroup, ownerOrdinal, aliasAfter, ownerRecord]`.

- Native tuple fields use exact `s` string, `n` finite-number and `z` null representations;
  `countTag` is absent for name order. Blank start is distinct from a native empty name.
  Preserve numbers/null and validate sort-specific arity before seeking. Epoch stays the real
  resource epoch; generation, UUID, order/query/release/profile and source descriptors enter
  the encrypted traversal basis. Stable Zone/viewer/body/language bindings are authenticated.
- `ownerRecord` is a **new reviewed fixed union**, e.g. `1:S:<64hex>:<24-character-leaf-record>`
  or `1:C:<64hex>:<77-character-Collection-record>` (maximum 146 ASCII bytes), not arbitrary JSON,
  nested tokens or a permission cache. One owner ordinal covers at most 32 sources, with an
  explicitly reserved phase/ordinal for the TypeList predicate itself. This is a protocol revision.
- The tuple is the last fully settled predecessor; pendingGroup is its first unconsumed native
  candidate. Resume re-fetches that candidate, charges it, compares current identity/bases and
  resumes its owner. No second full name tuple is serialized. Mutation that destroys this pending
  relationship requires a fresh traversal, not skipping the unresolved group.
- Preserve the owners' distinct alias semantics: Search's aliasAfter is the original currently
  under leaf evaluation and must be resumed FIRST; Commerce's is the last settled original,
  with its source tuple retaining unfinished evidence within the next alias. A union tag must
  dispatch correctly; treating both as an exclusive seek can skip the only readable alias.

Conservative JSON sizing was calculated locally with compact UTF-8 JSON, 16-digit epoch/time,
two UUID progress fields, tagged native ID, 64-hex basis, two-digit ordinal, 146-byte owner record
and a count tag as wide as a finite-double spelling. Results: 512 CJK gives max key **1537**,
aggregate strings **1880**, plaintext **1953**, token upper length **2650**. A synthetic 512-control-
unit name exercises JSON escaping: plaintext **3489**, token **4698**, within Search's limits.
The control case is a conservative serialization stress input, not a claim of a legal catalogue
name or normalized output. These are byte calculations, **not** encoder, native normalization or
end-to-end proof. The proposed grammar must bound all fields, including escaping, and real codec
tests must cover worst cases. Two independent maximum name tuples would already exceed 3072
aggregate string bytes after tags, before basis/progress; avoid claiming a dual-tuple fit.

Manager agreement is required from Search, Semantic/Zone and the codec owner on this operation's
eight-field meaning, pending replay/freshness rule, authenticated profile selection and anonymous
lifetime change. It must update the owning contracts while keeping UUID union defaults intact.
The profile API exists; that is not authorization to select it for Zone production.

## Counterexamples and independent native acceptance before runtime

These are required future owner outcomes, not tests executed or implemented by this report.
Existing frozen acceptance remains unchanged. Start from real commands/Access and pinned-engine
hits; instrumentation may observe work/completion, never fabricate hits, canonical certificates,
memberships or unknown business evidence.

| Counterexample | Required independent proof |
| --- | --- |
| UUID page post-sort | Eligible IDs `a<b<c`, names `Zulu,Yankee,Alpha`, limit 2. Sorting `[a,b]` misses the true first `c`. Counts `1,2,100` similarly defeat collections ranking. Concatenated native pages must equal the definitive restricted native order on a fixed small fixture, not each UUID page's local sort. |
| Unknown predecessor | Native `Alpha` is essential unknown, `Beta` is true. Emitting Beta and seeking after it permanently loses Alpha when native repair proves true. Assert boundary before Alpha, readiness or real pending progress, later repaired emission, and independent true OR-source settlement. Include NOT of real witness overflow, not a fake unknown flag. |
| 257 aliases, only last readable | Root absent from stored mount, all 257 original aliases present, only alias 257 authorized. First call cannot prove false/EOF or exceed 256; several paid pending steps must find it. Repeat at 4096, with a leaf that spans requests within alias 257, for listing and direct target eligibility; verify actual original plus terminal Access and one canonical emission. |
| Ties, nulls, long names and name change | Equal normalized names/counts require unique ID ties; equal count/name must not skip at page boundary. Test missing count=0, null name last, 250 CJK, maximum normalized size and normalization expansion to null. Change a name/count across the consumed tuple: verify exact tuple replay and documented fresh-traversal semantics, with no rerank or raw-ID relabel. |
| Canonical index coverage | Real population/certification before ordinary hide must still allow the genuine hidden raw hit and reject it currently. Merge to a larger survivor, repoint/unmerge, zero hits, wrong UUID, equal-count wrong keys, old writers past tombstone pruning and ambiguous bulk/checkpoint races must block/restart uncertified traversal. Exercise actual default worker separately from helpers. |
| Source revocation | Revoke Collection or saved-source authority after discovery and before final use, then resume the old cursor. No cached true, source ID/count or private fact can leak. Check deletion, withholding, subject denial and restoration independently. Earlier passed keys becoming eligible again require fresh traversal. |
| Cursor budget and identity | Real encode/decode with the explicitly chosen profile for both sorts, maximum name and each pending owner variant. Assert byte limits, exact null/number/string roundtrip, stable request/viewer/Zone/profile transfer rejection and stale-basis restart. Default must continue rejecting over-256-byte keys. Inspect public DTO/token confidentiality; no plaintext fallback. |
| Aggregate work and liveness | Capture all pools and native engine candidates, including duplicate lookahead, rejected windows, pending candidate rereads, internal fact keys, final checks and empty seeks. Exact budget exhaustion must never overspend or return unchanged empty success. Finite ready fixed fixtures must progress to EOF, including worst admitted multi-leaf final proof; otherwise the port is not ready. |

Retain and extend the real owner suites: Search `scope-prefix`, `scope-evaluate`, `service-scope`,
`query-completeness`, `canonical-coverage`, coverage writer/lifecycle/growth, and bounded-name cursor
outcomes; Semantic identity/terminal/alias/leaf composition; Collection source real-driver outcomes
and canonical-source growth. Add a separately named ordered-candidate contract/native suite and
Zone TypeList restricted-order traversal suite before runtime. Native growth must include unrelated
population, duplicate/alias degree and first/deep windows at 64/512/4096 through the unchanged
classifier, separate physical rows/blocks/bytes and fixed-home phases, never elapsed time alone.

## Recommended adoption boundary

The minimum design edits belong to `docs/zone-membership.md` (separate ordered composition and
profile decision), `docs/zones.md` (restricted presentation handoff), Search README plus
`search/scope-source.ts`/`service-scope.ts` (ordered raw sibling and actual service binding),
and `docs/collection-source.md` only if its existing residual ABI needs clarification. Keep
`registry.ts` TypeList declarations and UUID prefix semantics. Search's `query.ts` and existing
template own pinned native dispatch/completion/count suppression; `document.ts`, bounded sort
preparation, indexer/replay and coverage lifecycle own real bounded canonical hits. Semantic owns
actual identity/leaf proofs; Library's `collection-source.ts` owns actual Collection residuals.
`tokens/list-cursor.ts` already offers the proposed profile: no codec edit follows from this report.
Presentation's existing planning/dispatch should receive a trusted owner restriction handoff,
with no user-authored Zone query selector. Exact port signatures/HTTP/SQL/frontend changes remain
owner decisions after adoption, not implementations authorized by this evidence.

The recommendation is to adopt **native ordered candidate traversal with bounded owner residuals**
as the direction, conditional on canonical coverage, definitive bounded proof and an explicit
cross-owner cursor/profile agreement. Do not ship UUID post-sort, a public-Search black box,
drop/refill unknowns or an assumed default-profile fit while those prerequisites remain red.
