# Headerless native canonical caches

Research snapshot: 2026-10-28. This is implementation evidence and a proposal for adoption, not topic authority,
readiness evidence, or a runtime-success claim. No sibling cache or whole-state-set representation report was read.
The accepted logical-read/materialization and final DTO contract overrides the older lazy-GET wording in
[Dynamic Collections](../dynamic-collections.md). State-set support representation and label-pin selection are outside this report.

## Recommendation

Use `library.canonical_source_state` as the single derived-cache anchor, independent of header existence.
Make every canonical fact reference that anchor with immediate `NO ACTION`, retaining all generations independently
of ready/working pointers. Add an optional, sticky materialized-header witness on the anchor: NULL for a genuinely
headerless logical builtin, linked in the first actual materializing command. Preserve the existing curated native
header-delete `23503` assertion unchanged through that FK and automatic native linking on anchor insertion.
Add one private owner cleanup locator on this same row; it is neither a new resource nor an authorization registry.

This requires replacing the build DAO's mandatory header lock with native source-specific locking, not merely
dropping FKs. Logical source writes serialize on the existing `fact_source_head` owner point, under `shareAccount`;
curated writes retain their actual header/source-generation fence. Source selection, in-use evidence, accepted
meaning, current authorization, and completed published output remain independent prerequisites.
GET/read/follow-target lookup creates no anchor, header, grant, receipt, work intent, or repair.

| Native relation considered | Result |
| --- | --- |
| Universal state anchor; facts → state; no header relation | Represents logical sources and old generations, but permits deleting a curated header while cache children remain. Adoption would require an explicit erasure-contract amendment backed by equally strong native protection, not deleting the `23503` assertion. Application existence checks alone do not supply that protection. |
| Universal anchor plus nullable sticky header FK | Recommended: one conditional edge, O(1) first-write attachment, existing native header protection retained. NULL is absence of a materialized header, never an admission claim. |
| Nullable header witness on every fact, or conditional relation to existing owner head/tuple reference | Per-fact attachment touches unbounded history. A tuple-reference FK cannot represent fixed empty Everything or outlive disappearing support; an owner-head FK neither proves tuple admission nor represents retained output independently. Neither replaces the header erasure edge. |

## Evidence and implementation boundary

Inspected integration/source revision: `d06435e227fb60b27e18244850e1c1511438ab95` (worktree and `dev` agreed).
Paths below are relative to `services/kernel/` unless qualified; repository source licence is [MIT](../../LICENSE).

| Inspected source | Finding that affects the transition |
| --- | --- |
| `db/library/migrations/20261028000646_canonical_collection_sources.sql`, `db/library/schema.sql`, `test/library/canonical-source-schema.test.ts` | State and facts both reference headers directly; facts need not reference state. The native probe checks `23503`, unique original mapping, and facts → state → header erasure. |
| `src/library/canonical-source-store.ts`, `collection-source.ts`, `test/library/canonical-source-fixture.ts`, `canonical-source-store.test.ts`, `growth-canonical-source.test.ts` | Store/factory methods throw `dependency_unavailable`; their types and native tests specify behavior, not a working cache. |
| `db/library/migrations/20261028003557_owner_fact_source_hooks.sql`, `20261027234813_label_reservation_source.sql`, `test/library/owner-fact-source-hooks.test.ts` | The four fact families and label-parent liveness advance one owner generation transactionally. Generation is structural version, not presence, deletion generation, or readiness/count. Absent head is unbuilt. |
| `src/library/builtin-identity.ts`, `builtin-reference-store.ts`, its three SQL files, `db/library/migrations/20261028013901_builtin_tuple_references.sql` | `builtinCollectionId` uses existing `derivedId`; `readBuiltinStateReference` is a keyed tuple locator. Its entry witness is not all sibling-state support or permission. |
| `src/access/account-share.ts`, `account-share.sql`, `src/command/command.ts`, `src/library/command-support.ts`, `collections.ts`, `follows.ts` | `shareAccount` requires a live native command and locks the account `FOR SHARE`; `runCommand` authorizes before receipts. The generic Library runner currently reads account state without calling `shareAccount`; it cannot be cited as the required deletion barrier. |
| `src/library/collection-store-collection-member-{insert,delete}.sql`, `collection-store-collection-tombstone.sql` | Membership/delete changes advance header `source_generation` in their owning transaction; editorial revision/partition position is not the structural fence. |
| `src/library/work.ts`, `work-module.ts`, `listing-freshness-contract.ts`, `src/work/{registry,client}.ts` | Existing Library composition and shared DBOS client are real. Canonical registration and completed dynamic-output authority are not established by the current listing stubs. |
| `src/access/active-account-page.{ts,sql}`, `db/access/migrations/20261027183111_active_account_pages.sql` | `pageActiveAccounts` has a strict route/account keyset and limit ≤100, supported by the exact active/unfenced partial index `account_active_pages`; enumeration still requires per-owner admission and charged native work. |

Additional committed revisions inspected without importing their implementations:

- `51b6a5d386334c528b3136ac71f2e712d435f382`: `src/library/canonical-source-ranges.ts` and range SQL.
  `readCanonicalStorage` starts at the header and returns NULL without it; headerless support also needs this read seam fixed.
  `seekCanonicalGroup` and `pageCanonicalGroup` are raw, supplied-client range primitives, not readiness/Access.
- `fab8eadc7314a18903ac725307f8cb384202c8bc`: the build-write branch contains frozen acceptance, but no
  `canonical-source-writes.ts` or its proposed SQL. Its inspected write brief requires header `FOR UPDATE` in
  `readOrBeginCanonicalBuild`, `checkpointCanonicalBuild`, and `publishCanonicalBuild`; that is planned behavior only.
- `7c8163d450b79072a01e93f393039af565f2f46b`: native-provider branch has no proposed native/work modules yet.
- `330ea9444f35f5c4a37e926e6d18541039d29b5d`: actual `semantic/identity-basis.ts` exports
  `readIdentityBasis`/`readIdentityHome`; `identity-maintenance.ts` exports `readSealedSubjectIdentity`.
  The former performs two released observations; the latter reads original-home structural evidence without Access.
- `b07a80c783`: `docs/research/library-builtin-runtime-audit.md` was read as historical evidence only.
  Its older claim that the fact head/hooks are missing is superseded by the inspected integration source.

Also read: the current commerce manager brief; approved final logical identity/read DTO/lookup reconciliation;
source ABI and native access-path briefs; storage, range, build/CAS, repair, native-provider, and worker briefs;
[Collection source](../collection-source.md), [Library](../library-and-collections.md), and [Deletion](../deletion.md).
No absent module, stub, report, or brief is counted as a callable producer.

## Primary PostgreSQL findings

The cached PostgreSQL repository was reused at `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, under
`.reference/library-shelf-maintenance/postgres/` in the main checkout; licence: PostgreSQL License, `COPYRIGHT`.
Sparse checkout omissions were read with `git show`; no vendor code was installed, built, or executed.
`scripts/database.ts` pins PostgreSQL `19rc1` image digest `7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108`.
The official version-19 documentation below supplies the semantics; the pinned source identifies itself as
`20devel` in `configure.ac`, so its optimization details do not certify the exact deployed image's footprint.

- Nullable composite FKs use `MATCH SIMPLE`: `(route, NULL)` can omit the header relation. `MATCH FULL` would reject
  it. FK targets need a primary/unique key or non-partial unique index; a partial FK is not available. Referencing
  indexes are not created automatically. Immediate `NO ACTION` preserves explicit erasure ordering.
  [Constraints](https://www.postgresql.org/docs/19/ddl-constraints.html#DDL-CONSTRAINTS-FK);
  pinned [`doc/src/sgml/ddl.sgml`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/ddl.sgml).
- `FOR KEY SHARE` protects key existence, not non-key source-generation changes. Use `FOR UPDATE` for the chosen
  mutable fence; a missing row supplies no row lock. Advisory locks are cooperative and local to a server;
  a hash collision can only add contention when used correctly, but cannot replace owner/account authority.
  [Locking](https://www.postgresql.org/docs/19/explicit-locking.html).
- RR snapshots can predate a subsequently acquired lock; cross-table absence checks alone are not a concurrency
  proof. SERIALIZABLE transactions must retry the whole transaction after serialization failure, using the native
  executor. Do not catch a statement failure and continue using old observations.
  [Isolation](https://www.postgresql.org/docs/19/transaction-iso.html);
  pinned [`doc/src/sgml/mvcc.sgml`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml).
- Native RI performs key locking and current-snapshot/crosscheck handling, beyond an application `SELECT EXISTS`.
  `RI_FKey_check`, `RI_FKey_noaction_del`, `ri_restrict`, `ri_PerformCheck`, and fast-path `ri_LockPKTuple` in pinned
  [`src/backend/utils/adt/ri_triggers.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/ri_triggers.c)
  explain why replacing all FKs with ordinary trigger reads would weaken protection.
- PostgreSQL's materialized-view refresh builds replacement contents and installs them transactionally under a
  relation lock while retaining object identity. It does not provide this application's bounded checkpoint,
  authority, or cross-home identity proof: see `ExecRefreshMatView`/`RefreshMatViewByOid` in pinned
  [`src/backend/commands/matview.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/commands/matview.c).
  The shared pattern is stable anchor, separately completed contents, atomic installation, explicit reclamation.

## Exact proposed relation and forward migration

Keep all existing route/ID, driver, basis-byte, pointer-pair, checkpoint-nullability checks and indexes.
Keep state PK `(route,collection_id)`; keep fact PK
`(route,collection_id,generation,basis_digest,canonical_subject_id,stored_subject_id,driver,fact_id)` and UNIQUE
`(route,collection_id,generation,basis_digest,stored_subject_id,driver,fact_id)` unchanged. No FK references a
ready/working pointer: changing either pointer must leave old/abandoned generations intact.

The new relation is exactly:

```sql
-- On canonical_source_state, in addition to its existing columns:
materialized_header_id uuid NULL,
cleanup_account_id uuid NULL,
CHECK (materialized_header_id IS NULL OR materialized_header_id = collection_id),
CHECK (materialized_header_id IS NOT NULL OR cleanup_account_id IS NOT NULL),
CHECK (cleanup_account_id IS NULL OR route =
  get_byte(uuid_send(cleanup_account_id),10)*256 + get_byte(uuid_send(cleanup_account_id),11)),
CONSTRAINT canonical_source_header_witness
  FOREIGN KEY (route,materialized_header_id) REFERENCES library.collection(route,collection_id)
  MATCH SIMPLE ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE
-- Replace canonical_source_fact's direct header FK with:
CONSTRAINT canonical_source_fact_anchor
  FOREIGN KEY (route,collection_id) REFERENCES library.canonical_source_state(route,collection_id)
  ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE
```

Add `canonical_source_header_witness_idx ON library.canonical_source_state(route,materialized_header_id)
WHERE materialized_header_id IS NOT NULL` and `canonical_source_cleanup_account_idx ON
library.canonical_source_state(route,cleanup_account_id,collection_id) WHERE cleanup_account_id IS NOT NULL`.
The fact PK already supplies the anchor-reference prefix and all-generation cleanup order. No account/subject FK,
permission-bearing row, copied predicate, immutable-release registry, cascade, or new generation table is needed.

Forward migration, in one explicitly blocking maintenance transaction, with header → state → fact table locks:
add nullable columns; create empty/unbuilt state rows for existing fact-bearing headers lacking state; backfill
every state witness/cleanup owner from its actual header. Existing direct FKs make that backfill well-defined.
Install the native guards below; add checks and new FKs, validate existing rows, build both referencing indexes;
only then drop `canonical_source_fact_route_collection_id_fkey` and
`canonical_source_state_route_collection_id_fkey`. Do not edit the original migration or facts/pointers.
The backfill may scan existing headers/facts and indexes: it is offline migration work, never a bounded request
claim. Ordinary ALTER/index creation takes blocking locks; `NOT VALID` followed by validation can stage checks,
but is not an assertion that the whole migration is online.
[ALTER TABLE](https://www.postgresql.org/docs/19/sql-altertable.html).

Native compatibility guards, installed by that migration, must have these exact effects:

1. BEFORE state INSERT, point-read the matching header `FOR KEY SHARE`. If present, force witness = collection ID,
   fill cleanup owner from curator, and reject conflicting supplied ownership/identity. Thus old SQL inserting only
   `(route,collection_id)` still links automatically. Without a header require an explicit cleanup owner; only the
   admitted logical-maintenance command may reach this case. The locator itself proves no logical admission.
2. Preserve the frozen store's derived DAO probe, which inserts facts after real curated creation/add without
   first inserting state. A BEFORE fact INSERT compatibility guard creates a missing unbuilt anchor ONLY from the
   actual matching curated header (`FOR KEY SHARE`, keyed INSERT ON CONFLICT DO NOTHING); use guard 1 to link it.
   It must not initialize logical/dynamic sources, readiness, or grants. Normal build writes create state first.
   Charge every dispatched guard/RI point; do not add eager cache creation to header creation, reads, or membership.
3. Reject UPDATE changing a non-NULL header witness, including clearing it (`23514`); NULL → same-ID linkage is
   allowed only against the actual matching header. Native header INSERT links any existing anchor in that SAME
   command, using one keyed UPDATE, never updating all facts. A conflicting anchor/header fails atomically.
4. All logical anchor/header creation uses the owner fence described below. Trigger snapshots alone cannot close
   the simultaneous absent-header/absent-anchor race. Uncoordinated raw logical inserts are not an admitted API.
   A curated anchor without a header remains invalid; headerless admission must recompute `builtinCollectionId`
   and current native source evidence, not trust caller-supplied owner/tuple JSON.
5. The cleanup locator cannot be retargeted to another account by a checkpoint/pointer update. Its only clearing
   transition requires all private children gone and actual retained-output custody under its native fence;
   until that producer exists, keep this transition disabled. A generic caller flag is insufficient.

The existing native `23503` guarantee is retained declaratively after automatic linkage, not replaced by a weaker
assertion: facts prevent anchor deletion, and the sticky witness prevents header deletion. A linked anchor with
zero facts still blocks header erasure until state cleanup. Add tests for attempts to clear the witness and for
old generations after pointer changes; change no frozen test. A header that has no anchor remains deletable under
its other existing child constraints. No blanket assertion that every header needs a cache is introduced.

## Source admission, locks, and compare-and-publish

Proposal to the ABI owners: preserve existing curated DAO calls and add a discriminated native `SourceWitness`
for logical owner-fact sources, instead of interpreting the existing `sourceGeneration` argument as two authorities.
It names actual source family, owner/fact generation or header/source generation, expected header presence and
immutable identity, and actual meaning/output commitment. It is a comparison hint, NEVER an allow token.
Every mutating DAO rereads those native rows; no caller digest, previous witness, event payload, or cache row can
prove current source admission. Output witnesses require a real completed-output producer, otherwise not-ready.
The private comparison tuple is `(route,owner,derivedId,factGeneration,expectedHeaderPresence,meaning)`; curated
comparison is `(route,collectionId,incarnation,sourceGeneration)`. Bind these exact observations, selected authority
and identity digest into the existing `CanonicalBasis`; a cache-local digest or header revision cannot substitute.

| Native operation | Lock/CAS obligation |
| --- | --- |
| Curated begin/checkpoint/publish | Existing command partition gate; matching active header `FOR UPDATE`, exact source generation/incarnation/current authority; then anchor `FOR UPDATE`; then fact insert/delete. Reject dynamic-as-curated. |
| Logical/private builtin begin/checkpoint/publish | Owning native `runCommand`; `shareAccount` during authorization BEFORE receipt lookup; owner `fact_source_head(route,account_id) FOR UPDATE`; matching header if present `FOR UPDATE`; anchor `FOR UPDATE`; derived facts last. Check route/derived ID, current accepted in-use tuple, owner liveness and exact fact generation. |
| First materialization | Same account → fact-head → header → anchor order, including when both header and anchor are absent. Validate the actual owner write action/scope and expected logical revision 0. Insert same deterministic header at final revision 1, initialize grants through `parentCreationAuthorization`/`initializeResourceGrants`, and link existing anchor atomically. |
| Terminal private cleanup | Existing terminal-account native authority, not active-only `shareAccount`/`trustedAccount`; serialize account → owner head → header → anchor. Delete bounded private children under that authority. Output-only maintenance instead locks the actual retained publication/header fence and cannot read/recreate private facts. |

An absent owner head is not generation zero. Authorized maintenance or the first owner write may insert structural
generation 1 with `ON CONFLICT DO NOTHING`, then lock/reobserve it; reads never initialize it. This is a control
point, not empty proof. With current mutation hooks installed, a full rebuild observes actual raw source under a
matching source-home RR snapshot. Historical coverage/in-use readiness still comes from its owning producer.
The existing head closes the absent-header gap across both cache maintenance and materialization; an account share
alone is insufficient because two shares do not conflict. No new advisory lock or Access port is required here.

The fact hooks acquire their head during each relevant mutation; generation and fact commit together. Cache
maintenance must not lock source child rows after acquiring that head: source pages/metadata are released first,
and the derived write transaction only rechecks native authority/fences plus bounded indexed evidence. Otherwise
head-first maintenance versus child-first AFTER triggers can deadlock. Any required evidence lock needs a reviewed
common ordering before activation; ordinary predicate reads are not child row locks. Native executor retries cover
whole serialization/deadlock failures within the existing deadline, never renewed HTTP deadlines.

Observe source metadata/fence/raw page and partition stamp on the same released source RR client. Obtain actual
`readIdentityBasis` separately; map each examined original through `readSealedSubjectIdentity` on its original-home
RR client, including hidden originals. Missing/unsealed is pending, never self, skipped membership, or empty.
Release unrelated clients before the owning write. Immediately before checkpoint/publication independently
reobserve identity and source; then lock/recheck the actual selected source as above. Local locks do not freeze
Semantic homes: every read/continuation/final use independently re-admits current identity/source.

Begin resumes the exact compatible working generation/checkpoint; a different basis switches only the pointer,
with a fresh never-reused UUID. Same-basis EOF+pending can explicitly restart into a fresh generation after mapping
readiness recovers. Checkpoint requires exact working UUID/basis/source witness and NULL-safe expected previous
`(after_subject_id,after_driver,after_fact_id)` before any insert. Charge examined raw keys before filtering;
mapped rows must be a subset of examined keys. Insert immutable original mappings and advance to the last EXAMINED
key atomically; conflicting canonical remapping rolls back. Pending accumulates OR and cannot be cleared by a later page.
Only true source EOF across every driver, no pending mapping, unchanged actual source and independently matching
identity basis permits publication CAS. Source exhaustion is not inferred from zero mapped rows or quota exhaustion.

`readCanonicalStorage` cannot fabricate an active header for a logical anchor. Add an independent raw anchor point
export, retaining its existing stored-header projection for compatibility. Each admitted range call must compare
the current selected ready generation and basis on the SAME local RR snapshot as its fact query. This prevents
GC/replacement between separate reads from turning a collected generation into a false empty/negative, including
same-basis rebuilds. Raw `seekCanonicalGroup`/`pageCanonicalGroup` alone provide no such authority proof.
Positive use still reauthorizes the Collection, current native fact, original and terminal subjects at native T.
Old contents, an old SourceWitness, or old permissions never authorize current access.

## Races, erasure, recovery, and placement

- **Repair versus first write:** both lock the same owner head before checking header absence. Repair first may
  create an unlinked cache; materialization subsequently attaches it in O(1). Materialization first makes repair
  observe/recheck the stored header. A parked absent-header witness fails after linkage; reobserve/rebuild rather
  than treating revision 0 as a stored header. Ordinary title/note changes do not become source generations.
- **Clear/restore:** removing the last state/fact advances the owner fence; Everything remains logical even empty,
  while in-use state admission must be re-proven. A parked build fails CAS. Individual undo restores its identical
  accepted fact/pin under current authority and advances the structural fence; old cleanup binds exact generation
  and keys. No account restore or deletion-generation counter is introduced.
- **Terminal account deletion:** `shareAccount` drains admitted writes before terminal T and rejects later attempts,
  including delayed repair/replay before receipt lookup. Keep tombstoned account authority available to cleanup.
  Erase raw private children first; their delete hooks can advance/recreate the head, so remove that head LAST,
  after private cache generations/anchors and private tuple-reference children/parents. Cache cleanup locators must
  remain enumerable until that work settles; never purge the only locator first. Current runner checks without
  account sharing must be closed by their owners before this protocol can claim no resurrection.
- **Published A/private B:** distinguish actual published-output generation A from its derived canonical generation.
  Freeze selects completed A under actual publication authority; abandon private working B and erase all its old
  private generations. Never evaluate private facts at T, promote B, or regard an empty cache as revoked output.
  A basis change from activated to frozen may require a new canonical build from A; retaining A does not make an
  old basis ready. Retained public rows/header and deidentity are that producer's authority, not the cleanup locator.
  Clear the private locator only after all private generations are gone and actual retained-output custody permits;
  otherwise keep cleanup pending. Its current missing producer cannot be replaced by this proposed schema.
  Cold output-only maintenance must not initialize an owner head: lock retained custody/header then anchor, and
  clear any automatically filled private locator in that same transaction before commit when custody requires it.
- **Bounded reclamation:** under the selected source/anchor lock, enumerate obsolete `(generation,basis_digest)`
  prefixes using the existing fact PK. A LIMIT-1 prefix seek finds each scope; skip protected ready/working/current
  retained-output scopes by strict prefix seek, not by filtering through their entire contents. For an obsolete scope,
  select at most the remaining raw quota in full PK order, then delete those exact keys in the same transaction.
  Store the last examined scope/key in existing durable workflow continuation; do not reuse the build checkpoint.
  Recheck protection on every resumed page. Ordinary cache GC cannot remove current selected public output.
- **Parent erasure:** source authorization must first forbid resurrection; then erase ALL private/obsolete children,
  including abandoned generations; prove no remaining child by indexed point; delete anchor; only then delete header
  if its lifecycle permits. Facts → anchor → header has no cascade. Keep an anchor/header while actual retained
  output needs it; later output withdrawal follows the same child-before-parent order. Cache eviction may remove
  facts and anchor while keeping a header; subsequent maintenance recreates a linked unbuilt anchor, never a grant.
- **Crash/replay:** checkpoint and mappings commit together; crash before commit changes neither, crash after commit
  resumes the exact last-examined key. A stale delivery cannot overwrite a newer checkpoint/UUID. A deleted and
  recreated anchor always starts a new working UUID, closing ABA without an eternal owner generation allocator.
- **Movement:** route/Collection identity stays fixed. Anchor, all fact generations, owner head and existing source
  rows travel through native partition fencing/copy/catch-up; restore headers before linked anchors, anchors before
  facts. Source cleanup remains reverse order. Re-enter the current command gate/home on retry; local row/advisory
  locks do not survive a server move. Reobserve actual epoch/home/identity basis; ordinary position is not a source
  version. Verify the mover handles the added FK dependency before activation; no cross-home FK or distributed lock.

## Cost, growth, and concrete implementation slices

Each operation reserves and settles the existing single ledger, including constraint/guard/core/Access queries,
alternate pools, failed work, internal drivers, witnesses, aliases, rereads, and lookahead. Raw owner work ≤100 and
shared aggregate ≤256 include final rechecks; a smaller source page may be necessary. Every actual global basis
observation pays two 4096-home sweeps: 8192 identity metadata rows PLUS core-home observations in `nativeRows`,
points, statements, and bytes, separately on prepare/final/continuation as called. No per-candidate/free sweep.
Charge plan-proved operation row bounds before dispatch; result `rowCount` is not observed physical work.
`test/support/growth-capture.ts` notes that version-19 FK existence probes are omitted from capture; derive and
charge their bounded index/lock work too. Missing nested plans are not evidence of zero RI work.
Owner/head/header/anchor points and two extra index updates are finite additional costs, not zero-cost bookkeeping.
Large retained pin bytes require prior byte admission; no accepting-type cap or alternate private profile pool is added.

O(1) abandonment alone does not bound storage under churn. Gate another incompatible restart/publication behind
bounded obsolete-prefix cleanup when it would accumulate another abandoned scope; no history COUNT on mutation.
For example, require no obsolete scope before retiring another working/ready scope, detected by prefix seeks over
the bounded protected scopes. This bounds extra live garbage generations after backlog drains; it does not cap
source size or PostgreSQL dead tuples/WAL/index bloat. Cleanup throughput, autovacuum, retained public storage and
finite-quiescent convergence need independent growth evidence at 64/512/4096 and fixed quotas, including deep pages,
all pools/RI probes, rows/loops/filter-removals/buffers/bytes. No physical constant-row or perpetual-convergence claim.

The following are proposed implementation slices, each ≤400 production lines and ≤8 changed paths; generated
schema output is mechanical. They require actual exports, not report completion. Filenames not installed above are
explicitly proposed; this report adds none. Sibling filenames in each row share its first directory unless prefixed.
Existing frozen acceptance files remain unchanged and still run later.

| Slice / production estimate | Exact paths and callable dependency |
| --- | --- |
| Relations/guards / 240 | `db/library/migrations/20261028160000_headerless_canonical_cache.sql` (proposed timestamp), `db/library/schema.sql`, new `test/library/headerless-canonical-cache.test.ts`. Depends only on actual existing tables; retain `canonical-source-schema.test.ts` unchanged. |
| Source-aware build CAS / 350 | `src/library/canonical-source-writes.ts`, `canonical-source-lock.sql`, `canonical-source-begin.sql`, `canonical-source-map.sql`, `canonical-source-checkpoint.sql`, `canonical-source-publish.sql`, new `test/library/headerless-canonical-writes.test.ts`. After actual `readOrBeginCanonicalBuild`/`checkpointCanonicalBuild`/`publishCanonicalBuild` exist; preserve curated calls/tests. SourceWitness extension is an ABI-owner proposal. |
| Anchor projection / 120 | `src/library/canonical-source-ranges.ts`, new `canonical-source-anchor-state.sql`, new `test/library/headerless-canonical-ranges.test.ts`. Add `readCanonicalAnchor`; keep `readCanonicalStorage` and existing group exports compatible. Requires the relation slice, not the factory. |
| Native logical admission / 400 | `src/library/collection-source-native.ts`, `collection-source-work.ts`, `collection-source-native-{header,members,facts,probe}.sql` (four paths), new `test/library/headerless-native-source.test.ts`. Extend actual `readNativeCollectionMetadata`, `authorizeNativeCollectionMetadata`, `readNativeCollectionRawPage`, `probeNativeCollectionOriginal` only after their real implementations land; use actual `builtinCollectionId`, `readBuiltinStateReference`, accepted-support producer and current Access. Missing support/output remains not-ready. |
| Repair composition / 350 | `src/library/canonical-source-store.ts`, `canonical-source-repair.ts`, `events.ts`, new `test/library/headerless-canonical-repair.test.ts`. Implement existing observe/read/begin/step/publish exports through actual native admission, ranges, CAS, `readIdentityBasis`, `readSealedSubjectIdentity`; no dependency on `createCollectionSource` or HTTP factory acceptance. |
| Write materialization / 380 | `src/library/collections.ts`, `follows.ts`, new `builtin-materialize.ts`, `builtin-materialize.sql`, `collection-routes.ts`, `personal-routes.ts`, new `test/library/builtin-materialize-cache.test.ts`. Depends on actual parent-creation/grant APIs, `shareAccount`, owner fence and native logical admission; export proposed `materializeBuiltinCollection` for both actual write paths. No read override. |
| Reclamation / 360 | new `src/library/canonical-source-cleanup.ts`, `canonical-source-cleanup.sql`, `canonical-source-work.ts`, `canonical-source-sweep.sql`, `work-module.ts`, new `test/library/headerless-canonical-cleanup.test.ts`. Proposed `cleanupCanonicalSourceStep`; existing `WorkContext`, `createWorkClient`, `registerLibraryWork` composition. Terminal purge also requires its real owning callback/authority, not a fabricated active-account command. |
| Maintenance discovery / 160 | `src/library/canonical-source-work.ts`, `canonical-source-sweep.sql`, new `test/library/headerless-canonical-discovery.test.ts`. After actual store exports and `registerLibraryCanonicalWork`/`canonicalRepairWorkflowId` exist. Use actual `pageActiveAccounts`/`account_active_pages` for fixed empty Everything, plus header/reference keysets, bounded before residual filters. Verify index-backed row work rather than assuming returned limit bounds scans; never discover by GET or enumerate private profile history. |

Native implementation acceptance must additionally cover both orders of materialization/repair, head initialization
racing fact writes, clear and terminal erase while parked, conflicting derived IDs, empty Everything with no header,
all old-generation cleanup/restore races, retained A/private B, crash/replay, read-versus-GC same-basis replacement,
and movement dependency order. Keep the original schema/build/store/growth/privacy assertions; add new native tests
instead of lowering `23503`, readiness, quota, scale, or disclosure requirements.

Rejected: universal anchor plus dropping all header protection (loses the native erasure guarantee); facts FK to
current ready/working generations (invalidates abandoned-generation lifetime); mandatory header locks or shadow
headers (cannot represent logical sources safely); optional witness with no atomic linking/sticky guard (bypasses
header deletion protection); reference/head/cache presence as permission or in-use proof; GET repair; public output
from private fallback; cascade cleanup; and a new metadata/permission registry. The optional witness plus actual
source fence is the smallest transition found that preserves the current native guarantee and headerless identity.

Local acceptance for this evidence-only delivery: `test -s docs/research/library-headerless-cache-current.md`.
No native, root, typecheck, container, check-host, database experiment, or runtime-success check was run.
