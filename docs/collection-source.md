# Collection source owner contract

[Filtered lists](filtered-lists.md) owns complete indexed observations, current disclosure, direct/prepared
admission, freshness, useful pages, canonical identity and cost. [Library and Collections](library-and-collections.md),
[Dynamic Collections](dynamic-collections.md) and [Deletion](deletion.md) retain native owner authority. This document
specializes Collection obligations for shared Search/Zone composition, not a new Collection model or filter language.

## Current implementation and superseded scaffolding

The exported `createCollectionSource` factory in
[`collection-source.ts`](../services/kernel/src/library/collection-source.ts) throws retryable
`ProblemError('dependency_unavailable')` from every method. It does no query, mutation, identity production or
readiness simulation. Its typed `prepare`, `prefix`, `containsSubject` and `readRawStoredPrefix` surface and outcome
driver interfaces do not establish native capability.

Old exported identity-basis, sealed-repair, alias-window and one-pending-group protocols are superseded list
scaffolding until replacement native acceptance permits removal. The universal 256 raw-key ledger, exhaustive
request-time alias recovery, repeated home sweeps and final leaf replay are no longer list requirements. Existing
code and frozen tests are unchanged by this prose adoption. Native batch, byte/string and cursor limits keep their
independent units and scope. No replacement executable signature, discriminant, counter ABI or schema is selected.

## Authority and source selection

One Library owner selects the same native truth:

| Source                        | Membership authority                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Curated                       | Native Collection and occurrence truth, never reverse public listing or counts               |
| Private built-in              | Authorized owner's native state/label/session/holding facts and accepted pins                |
| Public/unlisted dynamic       | Actual complete published output, never live private predicate evaluation for another reader |
| Frozen eligible public output | Last completely published generation retained under the same Collection ID                   |

Preserve stored subject and occurrence IDs, ordinals, notes, personal-fact keys and pins. Canonical browsing shows
one card per canonical subject; editing preserves occurrences and multiplicity, including `[x,y,x]`. Raw ordinal or
stored-ID paging remains an owner primitive, not a canonical prefix or proof of filtered-page completeness.
Catalogue predicates use the one released grammar with shared datatype/unit/same-statement qualifier and unknown
semantics. Private facts stay in the owner's PostgreSQL partition and never enter public Search or a holder directory.

Authorize the current source before candidate work, through ordinary native resource eligibility and grants.
Unknown, deleted, unreadable private and denied sources remain concealed `not_found`, with no metadata/candidate
leak. Essential unavailable evidence is preparation/readiness, not a false empty source or silently omitted mount.
Known unreadable mounts disclose no ID, label, description, count, source position or cursor-visible metadata.
Suspension advances the authentication floor and fences existing sessions before revocation. A pre-suspension bearer
is rejected before any Source actor is created with HTTP 401 `invalid_credentials` and
`WWW-Authenticate: Bearer error="invalid_token"`; revoked credentials also use 401 where required. Auth issues no
valid native suspended bearer: correct-password sign-in returns 403 `ACCOUNT_SUSPENDED` without a session, while a
wrong password remains ordinary 401. Kernel's verified-suspended 403 `account_suspended` branch is defensive only,
not a native fixture persona. Do not substitute anonymous access for a suspended bearer.

Every later call reauthorizes actor and source and checks actual current original AND terminal eligibility,
Access, consent, foreign targets and tuple fences. A Zone mount, terminal grant, prepared handle, indexed row or
earlier witness cannot replace these checks. Native read time is supplied by the actual owner/Core boundary,
not a client date or fabricated cast. Owners release a partition transaction before visiting another partition;
this does not promise a simultaneous cross-owner snapshot at network delivery.

## Admitted access and publication

Admission covers filter + Collection source + order. Commerce owns direct owner index and prepared owner result
plans; public result plans compose with Search under the shared contract. These are responsibility names, not new
executable discriminants. Use page-derived bounded indexed seeks; otherwise retain bounded preparation on existing
infrastructure, with finite progress, quota and expiry; otherwise reject 422 before enumeration. Typed parameterized
ranges/qualifiers may execute shared semantics. Neither a LIMIT nor a small result bounds examined engine work.

Successful pages fill the requested size or prove genuine final exhaustion. Sparse matches behind many nonmatches
must reach useful output after finite preparation. If admitted work cannot establish a useful page, return explicit
preparation/readiness; do not expose short/empty success chains over rejected raw windows. Unknown remains unknown
under NOT. A failed old positive is not complete negative evidence, and a stored-ID point miss is not canonical
absence. No fabricated Search Hit or Collection-local Boolean interpreter supplies evidence.

Public dynamic output discloses a subject selection, not private facts/predicates. Private changes that leave
published output unchanged cannot alter public fields, counts or cursor bases. Owner writes are reflected on the
owner's next read. Catalogue membership uses the shared 60-second healthy target and readiness beyond five minutes
of actual source-to-searchable lag; privacy reduction has no lag allowance.

Current candidate checks are necessary but insufficient. Query-level privacy invalidation/acknowledgement must also
cover exclusion, order, fields, source metadata and cursor-visible information. Local reductions invalidate public
use in the authoritative transaction. Foreign source-fence, target, consent and Collection reductions invalidate
affected use immediately. Acknowledgement covers actual refresh-visible repair including dependent foreign repair.
Observe safety before execution and revalidate before disclosure; unsafe, changed, missing or pending state means
preparation/readiness. A checkpoint, local security revision, complete ordinary generation, returned-ID check or
omitted count cannot certify safety. This is an abstract seam, not a certificate store or safety-token ABI.

A withheld harem tag cannot affect NOT harem exclusion or order merely because the returned subjects pass Access.
Paused-indexer negative/order/count cases remain preparing until local and all affected foreign repair are
acknowledged. Unsafe engine totals/facet counts over unchecked populations are omitted, with no approximate/as_of
exemption and no zero/row-length fallback.

At terminal account deletion, only eligible active public contributions and completed public generations survive
with de-identified attribution. Completed A survives pending B; never evaluate private facts to manufacture output
at deletion. Private/unlisted/deleted data and published reading logs do not survive. Durable freeze/revoke and
bounded cleanup handoff cannot wait for consumers; stale delivery cannot resurrect withdrawn output or facts.
[Deletion](deletion.md) and the native owner contracts own erasure, individual restore and takedown policy.

## Canonical access and continuation

Use maintained canonical-ID indexes and unique prepared result rows. One public terminal document is maintained by
Search; Commerce canonical access retains actual original support for current disclosure. Stored `[a,c,z]` with
`a → z` cannot be normalized after paging to certify canonical `[c,z]`. Dedup within a page alone cannot establish
cross-page uniqueness. An arbitrary representative cannot discard the only eligible original of a large group.

[Semantic identity](../services/kernel/src/semantic/README.md#identity) owns the serialized durable job and shared
catalogue identity epoch. Admit at most 4,096 originals per group before effects; publish only direct redirects to
active terminals after complete mapping/index maintenance. Lists prepare while the epoch is pending and restart
cursors after changes. No request-time 4,096-home sweep or exhaustive alias walk is required. Bounded preparation
and maintained access must support listing and direct targets when only the last original is eligible, and complete
negative outcomes on finite ready input. Stored personal originals, notes, copies/sessions and occurrence IDs remain.

Unmaterialized PRIVATE state-view presentation chooses the lexicographically smallest CURRENTLY SUPPORTED immutable
release digest CONTAINING THAT STATE. Digest order is neither chronology nor compatibility. Discovery unions
supported sibling state identities; facts retain their own accepted pins/meaning. Materialized headers and public
complete generations keep fixed accepted meaning; owner rename wins. Support/reader selection must use indexed
seeks, never all-release/history scans. This is presentation policy, not a replacement native fact authority or ABI.

Keep existing cursor ownership and `encodeListCursor`/`decodeListCursor`. GET retains its default limits/policy;
Zone POST uses the Search profile for all viewers. Stable route/viewer/request binding is authenticated; mutable
meaning/source/generation/epoch bases remain in the encrypted position. Reauthorize every continuation. Unusable
Zone POST progress starts fresh current authorization, rather than treating stale progress as permission.
Direct Zone targets share the existing optional cursor query transport: complete common page 200, retained
preparation 202 `{next}` private/no-store, or unavailable/no-progress 503 Problem + Retry-After without cursor.
No partial document or new HTTP schema. Web follows at most four 202 steps then retains continuation on a
private/no-store preparing page. Progress is retained preparation, not cached authority or endless final-leaf replay.

## Native delivery and acceptance

The actual factory, owner indexes, preparation, built-in discovery/materialization, complete public activation,
freeze/revoke, identity-epoch participation and default worker integration remain required. The Zone resource
substrate is integrated; actual membership/page/default execution and Zone-specific withholding/purge/account/
scheduler work are incomplete. Typed schemas, immutable loaders, cursor capacity and helper setup prove none of
those native outcomes. Old proof reports remain evidence, not gates for the replacement architecture.

Use the [shared acceptance matrix](filtered-lists.md#shared-acceptance-matrix): harem light novels, Book
wordCount > 1,000,000 (exact threshold and absent count excluded), and combined, in public Zone/Collection, own library and
own library with own state. Reviewed released Concepts, words versus characters and source mappings remain producer
prerequisites, not invented identifiers here. Also cover owner-only NOT state X including no entry, same-statement
qualifiers/units, compact/expanded conformance, two-release pins, current grant/source/fact revocation, foreign repair,
sparse matches, crash/replay, canonical cross-page order, last-eligible-original direct targets, epoch readiness and
native cursor restart/session/cache. Full persona/API/default/growth and unrelated owner acceptance remain required.

## Cost

### Direct and ready-result Collection pages

- Touches: named owner/catalogue index seeks, candidates including duplicate/rejected/lookahead rows, current
  Collection/source and original/terminal Access, complete disclosure dependencies, summaries and control/epoch reads.
- Bound: per-plan candidates/keys, native points, examined/removed rows, buffers, statements/connections, bytes,
  backend engine work and output slots. Compose within 16 reads and 128 TOTAL output slots. Each page/step supplies
  the internal cost object and separate shared harness evidence defined in [Filtered lists](filtered-lists.md#cost).
  Owner-native specifications must bind actual counters; no executable counter ABI is invented here.
- Growth check: real API/native first/deep/sparse pages at three geometric scales, all owner pools, unrelated
  history/population and alias/duplicate axes. Performance supplies numeric allowances and captures; old 256-proof
  or constant returned-row checks do not establish replacement acceptance.

### Preparation and canonical maintenance

- Touches: bounded input/frontier/result writes, actual source changes/dependencies, shared durable work/outbox and
  canonical mapping/index changes while the shared identity epoch is pending.
- Bound: each step admits keys/rows/points/bytes/statements/engine operations and retains settled work. Finite total
  work may follow relevant finite input and changed dependencies. No per-built-in witness mirror, whole-account
  synchronous fanout or permission-bearing result. No new service/scheduler.
- Growth check: three-scale native captures, interruption/replay, concurrent privacy reduction and terminal fencing;
  verify complete activation/catch-up and useful pages. Permanent preparing fails.
