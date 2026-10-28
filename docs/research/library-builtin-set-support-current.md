# Bounded whole-state-set support: independent source review

Research evidence and a proposed protocol, not adopted product authority or a runtime success claim.
Reviewed 2026-10-28 against dev/worktree `cce6fd97ed7cb9c3389047ba5bce37a7e19523e6`.
The manager contract and its final reconciliation were read from the main checkout's temporary goal documents.
No sibling whole-set report was read. No vendor code was installed, built or executed; no native checks were run.

## Recommendation

Keep the existing opaque-ID directory, replace its entry-only support child with exact native-fact witnesses,
and add one inverse edge per **supported accepted release and sibling state**, rather than per fact and sibling.
Serialize first/last-support changes on the existing owner fact-source fence. A strict inverse-index `LIMIT 1`
proves first/last support without counting all facts. Directory rows have a derived live-release count solely
for bounded owner discovery. This needs two new relation shapes besides the existing directory and owner fence;
an additional owner/set count table is unnecessary unless another accepted API actually needs its count.

All these rows are disposable access paths. Permission, current fact membership and release interpretation remain
with their native owners. Incomplete producers or legacy coverage mean **not ready**, never an authoritative zero.

## Confirmed local facts and limits

- [Release schema](../../packages/definitions/schema/release.json), `$defs.libraryProfile.entryStateSet.states`,
  lines 267–273: **1..64 states**, not five and not an unbounded array. State/profile/set IDs are 1..64 ASCII
  identifier characters. `role` has a vocabulary; `id` does not. There is no `meaningRevision` field.
- [Validation and limits](../../packages/definitions/src/index.ts), `RELEASE_LIMITS`, `exceedsSize`, `semantics`:
  canonical release JSON <=4,194,304 bytes, <=1,024 types, <=4,096 properties. `libraryProfiles` has no separate
  count cap. These limits do not bound the number of accepted releases accumulated by an owner.
- [Profile types and validation](../../packages/definitions/src/library-profile.ts), `LibraryProfilePin`,
  `validateLibraryProfileSource`, `libraryProfileSemantics`, and
  [compiler](../../packages/definitions/src/compile-library-profiles.ts), `compileLibraryProfiles`:
  inheritance resolves a data reference; duplicate state IDs fail validation. Labels have eight permitted release
  locales, each 1..80 code points. This release constraint does not invent another public DTO locale vocabulary.
- Exact compact JSON upper bounds for the state-bearing projection are 4,017 bytes/state, 257,236 bytes/set,
  257,326 bytes for `{id,entryStateSet}`. Derivation: 64-byte IDs, eight 80-character labels at the worst JSON
  escaping cost of six bytes/character, optional longest role `completed`, punctuation and keys included.
  Other profile sections can make a full profile larger; its ultimate bound is the whole-release 4 MiB limit.
- [Pin resolution](../../services/kernel/src/library/profile.ts), `resolveLibraryProfilePin`, requires the exact
  digest and stored accepting type/profile reference. `acceptingType` is not a short UUID or fixed vocabulary;
  the [pin DDL](../../services/kernel/db/library/migrations/20261027184414_library_profile_pins.sql) accepts
  arbitrary nonempty text. Do not put it in a B-tree key, silently truncate it, or guess it from today's subject.
  Legacy provenance is an explicit migration to the declared legacy descriptor, never a default fresh-write profile.
- [Identity](../../services/kernel/src/library/builtin-identity.ts), `builtinCollectionId`, already uses
  `derivedId(owner, JSON.stringify(['library.collection.builtin',1,'state',profile,set,state]), ownerRoute)`.
  Everything uses its existing shorter tuple. Digest, accepting type, labels and time are excluded; inversion is impossible.
- [Directory DDL](../../services/kernel/db/library/migrations/20261028013901_builtin_tuple_references.sql):
  `(route,collection_id)` PK and unique `(route,account_id,profile_id,state_set_id,state_id)` exist.
  `builtin_state_reference_source` has only `(route,account,subject)` and one current entry state/release witness.
  [DAO](../../services/kernel/src/library/builtin-reference-store.ts) exports `readBuiltinStateReference`,
  `bindBuiltinStateReference`, `unbindBuiltinStateReference`; its comments assign authorization/fencing to callers.
  Binding checks the stored entry revision/transaction/pin; it does not establish copy/session or sibling completeness.
- [Owner hooks](../../services/kernel/db/library/migrations/20261028003557_owner_fact_source_hooks.sql) already
  advance `fact_source_head` for relevant entry/copy/session/assignment and label-parent mutations, and add
  `copy_raw_source` and `progress_session_raw_source`. Head existence/generation alone certifies no coverage.
  Parent label deletion invalidates one owner point, with no child fanout. Do not claim these hooks are missing.
- [Applied canonical DDL](../../services/kernel/db/library/migrations/20261028000646_canonical_collection_sources.sql)
  has **both** state and facts referencing Collection headers with `NO ACTION`.
  [Canonical ABI](../../services/kernel/src/library/canonical-source-store.ts) still throws `dependency_unavailable`
  at the inspected dev pin. Its fixture's `sourceFenceSQL` locks the header; its prospective cascade DDL is not
  the applied schema. A headerless proposal must change the storage boundary and build fence, not just omit an INSERT.

## Primary comparisons

Cached paths below are relative to the main checkout's `.reference/`; pins and licences are in its `INDEX.md`.
The linked upstream files are primary implementation evidence, not permission to copy their implementations.

| Source and inspected implementation | Finding and consequence |
| --- | --- |
| BookWyrm `shelves/bookwyrm`, `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`, Anti-Capitalist Software License 1.4, restricted source: [models/shelf.py](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/shelf.py), [shelf_actions.py](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/shelf/shelf_actions.py). | `ShelfBook` is exact membership, unique `(book,shelf)`; deletion protection uses membership existence. `shelve` is atomic and enforces exclusive read-status membership. Supports exact inverse witnesses; precreated permission-bearing shelves do not solve logical discovery here. |
| Bangumi `shelves/bangumi-server`, `1997713eafc51487cbea705b37011442f35539fa`, AGPL-3.0: [internal/collections/infra/mysql_repo.go](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/internal/collections/infra/mysql_repo.go). | `updateUserTags` materializes exact tag membership; `reCountSubjectTags` recomputes tag totals with correlated `count(1)`. Collection writes and later recounts are separate transactions; the inspected closure even uses `r.q` for the collection insert. Useful inverse/count distinction, not proof of atomic bounded support maintenance. Copy neither recount scans nor its transaction assumptions. |
| Nextcloud `library-entry-undo-independent-current/nextcloud-server`, `0e43b0a02d4ab36727ad121b6dc91238587b386c`: [Trashbin.php](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/apps/files_trashbin/lib/Trashbin.php), AGPL-3.0-only; [Trash/LegacyTrashBackend.php](https://github.com/nextcloud/server/blob/0e43b0a02d4ab36727ad121b6dc91238587b386c/apps/files_trashbin/lib/Trash/LegacyTrashBackend.php), AGPL-3.0-or-later. | `files_trash` retains original location/deletion timestamp separately from live files; restore checks the destination and moves the retained object. The backend separates trash listing/restoration/removal from live storage. Supports exact undo evidence, not treating retained snapshots as live support; its broad trash listings provide no bounded paging proof. |
| PostgreSQL `library-shelf-maintenance/postgres`, `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License: [ri_triggers.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/ri_triggers.c), [mvcc.sgml](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml). | `RI_FKey_check` uses key-share semantics; `RI_FKey_noaction_del` rejects orphaning children. FK existence probes are work even when instrumentation omits them. Consistent lock acquisition is part of correctness, not an optimizer promise. |

The shared pattern is exact child evidence plus a separate derived discovery/count path and explicit lifecycle handling.
None of these implementations proves our opaque lookup, native denial path or whole-set bounds automatically.

PostgreSQL's [partial-index documentation](https://www.postgresql.org/docs/current/indexes-partial.html) supports
uniqueness on a subset and requires the query predicate to imply the index predicate. Use literal `live_releases > 0`
for the owner directory index; a parameterized residual cannot stand in for that condition. A partial index cannot
encode another table's current parent liveness.
[Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) distinguish `NO ACTION` from cascading
child removal; index referencing columns for bounded parent checks. A partial unique index is not a general FK target.
[Locking](https://www.postgresql.org/docs/current/explicit-locking.html) documents row-lock conflicts, consistent
order and transaction advisory locks; advisory discipline does not enforce itself and locking expressions may run
before an outer LIMIT. [Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html) takes a new
statement snapshot: after waiting on a serialization row, read source/support in a subsequent statement.

## Alternatives and adversarial examples

Let F be live pinned facts, R supported `(owner,profile,set,digest)` groups, D distinct stable sibling identities,
and S(r)<=64 the siblings in one accepted group. D<=sum S(r)<=64R; neither F nor R has an owner-total cap.

| Representation | Storage/update/read cost before disclosure filters | Counterexample |
| --- | --- | --- |
| Exact per-fact/per-accepted-set witness; expand siblings at read time | F witnesses; indexed support point cheap; owner grouping/expansion needs another access path. | 4,096 facts all support one set: `DISTINCT ... LIMIT 20` can inspect all 4,096. Limiting facts first can return duplicates indefinitely and miss later sets. |
| Exact per-fact **per-sibling** rows | Up to 64F edges, plus D directory rows; indexed sibling discovery possible. | One copy with no entry needs 64 edges; changing the last fact between releases can remove/add 128. Charging one support write hides the actual fanout. Correct but unnecessarily large. |
| Owner/set and accepted-release counts plus exact fact witnesses | F witnesses + R release aggregates + set aggregates + up to 64R release/state edges + D rows. First/last count transitions bounded. | Count replay without exact witness replacement doubles support; a missing legacy producer leaves a plausible positive count with false completeness. A single set total cannot select historical release labels or prove a specific pin. |
| **Recommended:** exact witnesses + inverse support-existence seek + release/state edges | F witnesses + at most 64R edges + D directory rows. Owner fence serializes first/last tests; no per-set/release count table. | Without the owner fence two first supporters each create the same edges/counters, or the last remover races a new insertion. Without release/state edges, selecting a release containing a removed historical state scans arbitrarily many releases. |
| Existing `shelf_count`, `progress_head`, or canonical facts alone | Existing keys describe fixed legacy buckets, activity or subject evidence, not all accepted sibling sets. | A copy-only fact supplies no entry-state reference; an empty sibling has no member fact. Reusing these rows cannot invert a nonreversible Collection ID. |

A native count is useful when a count is required. Discovery here needs an existence boundary and unique indexed
identities; do not add an aggregate catalogue simply to make `DISTINCT` look cheap.

## Concrete relation protocol (proposed names)

`H` is the existing `(route,account)` `fact_source_head`, extended with producer-version/completeness, ready-fence,
repair token/phase/checkpoint metadata. Its generation is a source version, not authorization or an account generation.

`W = builtin_set_witness` replaces the entry-only child:

- PK `(route,account,driver,fact_id)`; driver is a smallint discriminant for entry/copy/session. Entry fact ID is its subject ID; copy/session
  use their native IDs. Store subject, exact native revision, transaction, available incarnation, digest, profile/set.
- Inverse B-tree `(route,account,profile COLLATE "C",set COLLATE "C",digest,driver,fact_id)`.
  Query the equality prefix, order by `(driver,fact_id)`, `LIMIT 1`; inspect <=1 row even for millions of supporters.
- Payload excluding tuple/varlena overhead <=289 bytes with one 16-byte incarnation and maximal metadata IDs;
  inverse key payload <=237 bytes. Do not copy acceptingType or a profile document into W.
  Native fact pins remain authoritative; full acceptingType validation may cost up to release-bounded bytes.

`E = builtin_set_state_support` is one row per supported accepted group and state:

- PK `(route,collection_id,digest)`; columns include account. FK `(route,collection_id)` to directory, `NO ACTION`.
  State/profile/set are obtained from the directory, not a second meaning registry. Logical payload <=107 bytes.
- Owner cleanup index `(route,account,collection_id,digest)`. One release's <=64 deterministic IDs permit exact
  removal; there is no enumeration of every release when one fact changes. PK also selects the first digest
  for a Collection with `ORDER BY digest LIMIT 1`, skipping no historical unsupported releases.

`D` remains `builtin_collection_reference`: add nonnegative bigint `live_releases`, maintained from E insert/delete
transitions, and partial owner index `(route,account,profile COLLATE "C",set COLLATE "C",state COLLATE "C")
WHERE live_releases > 0. Its two existing unique keys remain. Logical row payload <=236 bytes including the count.
A directory upsert verifies **all** tuple columns on collision; a conflicting ID fails closed.

H readiness gates these paths. During repair partial D/E/W are private, unready data; no count or FK makes them live.
E has at most one edge for a given digest/state, even with several accepting types and many facts sharing that profile.
The owner list seeks D directly with a strict `(profile,set,state)>after`, exact owner prefix, literal live predicate
and LIMIT before presentation/Access filtering. Many releases sharing the same stable state yield one row.
To page sets instead, repeated strict `(profile,set)>after LIMIT 1` seeks on that same index skip each entire prior
set range. Charge each seek; never GROUP BY all releases or expand an owner's full registry in memory.

## Accepted releases and meanings

Each fresh profiled write validates the actual current release/type once and stores its accepted pin. Reads, clear,
delete and undo use the stored pin, including retired releases. A copy/session pin whose profile declares no entry
state set contributes Everything but no state-set support. Labels store no pin under the pending interpretation below.

For a supported group, E includes **every** state in its accepted descriptor, even with zero matching entries.
Discovery is the union of these sibling identities. Membership of a state Collection uses actual live entry rows
whose exact accepted pins resolve to that profile/set/state; copy/session witnesses establish set use, not state members.

Several digests can share one stable Collection ID. Preserve all accepted pins independently; never rewrite old
values through the active release. Proposed deterministic **presentation** rule: select the lexicographically smallest
currently supported E digest for that state, validate its exact witness and fetch its immutable descriptor labels.
This is a recommendation requiring adoption, not a chronology inferred from digest order. Removed states remain
available while an older accepted pin supports them; dropping the last such pin removes logical discovery support.
Activation or label edits alone cannot create support, rewrite pins, rename IDs or allocate another Collection.

Do not infer semantic compatibility from equal IDs or equal labels. A release changing a role/meaning under the same
IDs remains a distinct immutable accepted interpretation. The proposed union preserves these interpretations without
claiming they are identical. If the product requires one immutable meaning/label set per stable ID, it must choose a
binding policy: the current ABI has neither a compatibility declaration nor an ordering of accepted releases.
A materialized header's single `builtin_release_digest` is an explicit accepted reference, not proof that no other
pins exist. Public completed output retains its published meaning/generation; never swap its labels to a private pin.
`CollectionSourceBasis.profilePins` is currently an unconstrained array: do not fill it with an owner's R pins.
Any bounded commitment/reference for that dependency set must be reconciled by the ABI owner, using the actual
source-fence/accepted-pin basis, not a fabricated `meaningRevision` or a new hash pretending to be definitions authority.

## Native writes, replay and lock order

Authorize the actual action at native T **before receipt lookup**, using existing `createLibraryCommandRunner` and
`runCommand`; replay cannot disclose a previous response after denial. Then `shareAccount` holds the actual account
against terminal deletion. A support DAO alone supplies neither authority nor a producer-completeness guarantee.

For all admitted writers/repair, acquire: account SHARE; owner H UPDATE; subject transaction-advisory guard where
native reservation rules need it; parent rows SHARE in sorted `(route,parent ID)` order; native fact rows UPDATE
in sorted `(driver,fact ID)` order; D rows sorted by `(route,Collection ID)`; E/W children by their primary keys.
Use the strongest needed lock initially, and serialize absent H creation only after account-share admission.
Existing AFTER hooks take H **after** the fact: they invalidate correctly but do not satisfy this proposed prelock
order. Complete the writer cutover before admitting ready support; mixing repair H→fact with old fact→H writers
can deadlock. Do not add a permanent per-fact lock/head to fix absent-row serialization.

After H lock, reread the fact in a new statement. CAS source PK + revision + transaction + native incarnation when
present, and compare the actual pin/state/liveness. Entry `incarnation_id` exists but is nullable for old rows;
uncertified rows remain unready until explicit incarnation migration (the pin-page helper does not supply it).
Copy/session IDs already distinguish recreations.
Never match a recreated revision-1 entry using revision alone. Undo binds the deletion locator and historic
incarnation/revision/transaction, requires no intervening replacement, and restores the exact historic pin.

Replace W exactly once with the source mutation. For each of at most two old/new accepted groups, seek W before/after
replacement. First support inserts all <=64 E edges and increments matching D counts; last support removes those
edges and decrements D. Unchanged group support changes only its exact witness. Replay hits the authorized receipt;
repair uses expected W revision/transaction/token and cannot repeat a counter delta from an old observation.
Even note/amount-only commands that change native revision/transaction must refresh W atomically; they need not
advance the membership fence when effective support is unchanged. Otherwise exact witness validation goes stale.
Commit native fact, W/E/D, H source/readiness transition and normal receipt/events together. A failed CAS rolls all back.

Clearing state removes only its live entry witness/membership. Live copy/session pins keep all accepted siblings in use.
Unassigning a label changes Everything only; current reserved assignment plus current live parent is required.
Parent hide/restore changes the one owner source fence, never scans state sets. Reclaimed assignments do not revive
with parent restoration. Soft-deleted entry snapshots in `entry_deleted` are undo evidence, not W candidates.
Ordinary record purge follows 720-hour undo; terminal account deletion begins bounded private purge immediately.
Restoration reacquires native capacity/current account authority and adds support for the historic pin, not today's type.
EOF from an entry scan says nothing about copy/session support or reserved labels needed for Everything.

## Read, repair, storage and cleanup boundaries

Opaque resolution uses exactly the existing `builtin-reference-read.sql` shape: one `(route,collection_id)` index
probe, <=1 row, no join or fallback scan. It returns private metadata internally. Apply current native owner/action
authorization before reading/disclosing support or descriptor contents. Denied and unknown take that same one-probe
concealed path; do not perform witness/release enumeration on denial. Authorized support validation is separately
charged native work. A stale reference can return not-ready/concealed, never permission. GET/follow does not create
D/H/grants/cache/work; only already authorized fact writes or durable native repair maintain derived references.

After authorization, require complete H at the current source fence, choose E by one indexed seek, choose W by one
inverse seek and revalidate its exact native fact/pin. A stale hint is not permission to scan until something passes:
return honest not-ready and let existing durable maintenance converge. Actual members still come from live entry,
copy, retained session and reserved assignment keys/current parents; D/E/W never become the member provider.
Only an owner's first authorized write needing a stored Collection materializes that ID with the existing creation
boundary and grants. Public output reads only its own completed published generation, never private source fallback.

Repair: establish the admitted producer version, mark support unready, allocate a repair token and captured H fence.
Page old E/W children and reset derived D counts with <=100 examined keys per transaction before rebuilding.
Scan entry/copy/session raw source indexes in fixed driver order, LIMIT before pin/pending/liveness filtering,
checkpoint the last **examined** key even for zero eligible rows. Resolve only actual stored pins; pin migration
uses existing `pinLegacyFactsPage`, not current-type guesses. At each step lock account/H and CAS token + phase +
prior checkpoint + captured source fence, then mutate derived rows/checkpoint atomically. A concurrent source change
invalidates this build in O(1); retire it and restart boundedly, with finite convergence only after finite quiescence.
Publish ready only after every required driver reaches EOF with no unresolved pins and the exact fence still matches.
No GET-triggered repair, synchronous owner count, fake EOF or partial-positive discovery masquerading as complete.

A headerless cache option is compatible: let canonical state be the derived `(route,Collection ID)` anchor; facts FK
NO ACTION to state, remove state→header only for the redesigned storage boundary, and preserve curated facts→header
NO ACTION as an additional protection. The build must lock actual owner H/native logical source for private builtins
and the real Collection source fence for curated/public authority; CAS the exact incarnation/basis/fence/checkpoint.
State ownership tags and cleanup locators confer no permissions. Old generations must be erased before state and
curated children before header; no cascading erasure shortcut. Changing just the current fixture or nullable header
check leaves the applied FKs/build protocol incompatible. This is a separate storage slice, not a support prerequisite.

Terminal purge: account denial at T is immediate and repair cannot pass `shareAccount` thereafter. Through existing
durable work, page all private canonical generations/checkpoints, E, W, old entry-only support, directory payload,
private headers/query state, entry snapshots, sessions/history/units, copies, assignments/labels and activity heads.
Erase child relations before their FK parents, including abandoned generations. Keep only the authorized completed
public output/deidentified contribution; never private predicates or pending generation B. Purge `fact_source_head`
**last**, because erasing native facts fires its upsert triggers. No eternal per-private-fact heads or witnesses remain.
Old shelf dictionaries also contain private data: remove `shelf_type_node` leaves before roots/values, `shelf_count`,
`progress_head` and `type_preparation_*` staging/headers via their actual FK order after their last consumer cutover.
Shared immutable definition releases are not owner payload; retain those still referenced by permitted public output.
Cleanup cost is linear in stored children across resumable bounded pages, never constant total work or a giant CASCADE.
EOF/cleanup intents are durable and token/fence guarded; delayed work cannot recreate a terminal owner's support.

## Cost derivation and required physical evidence

Costs below precede all Access, visibility, pin-validity, alias, localization or application filters. They describe
the proposed indexed protocol, not measurements. Index depth, dead tuples, uniqueness/FK probes and trigger SQL
need separate physical proof; payload sizes above exclude tuple headers, alignment, index duplication and WAL.

- One unchanged-pin fact write: one exact W replacement, <=2 support-existence seeks, one native source mutation
  and owner-fence work. A release crossing touches K=S(old)+S(new)<=128 sibling keys, **including all 64** on first use.
  D/E maintenance writes <=2K rows (<=256); a simple sorted per-key schedule pays one D lock, one edge mutation,
  one D delta per sibling: <=3K SQL calls, plus explicitly counted fixed source/W/H/receipt/Access calls.
  Batching reduces statements, not K or row/byte charges. First insertion uses a conditional D upsert before E;
  last removal locks D, deletes E then decrements D. Shared owner serialization makes each delta exactly once.
- The existing <=100 migration-fact page can therefore require 6,400 sibling directory writes plus 6,400 E writes.
  Do not charge it as 100 writes. One old/new release pair can cost two 257,326-byte state projections; full immutable
  release loading/validation instead costs up to two 4 MiB documents, plus actual native pin bytes (acceptingType has no smaller ABI bound).
- Owner discovery of b rows reads b D keys; choosing/validating one meaning adds <=b E keys + b W keys + b native
  fact points, plus owner readiness/auth metadata. Budget **4b encountered/internal keys conservatively**, not b
  returned Collections. SQL is one D range seek + <=3b indexed support/fact probes + fixed authorization/fence work;
  returned state-label JSON <=4,017b bytes before DTO envelopes, with native pin/release bytes charged separately.
  Exact-page EOF may need one more charged empty seek; use no hidden `+1`. Reduce b to the actual shared allowance.
- Opaque lookup itself is exactly one directory probe/<=1 directory row (<=228 logical payload bytes without count).
  Successful authorization then pays the same three support/fact probes and immutable meaning bytes; denial does not.
- Canonical owner raw-key allowance is <=100; shared Zone aggregate is <=256, including aliases, duplicates,
  lookahead/internal keys and final use. These are not a universal 100-row SQL-write limit: `nativeRows`, points,
  statements and bytes are separately reserved in `CanonicalAllowance`/`WorkAllowance`.
  No inspected ABI establishes a cheap constant sibling materialization allowance. If a caller's native-row budget
  cannot cover one 64-state insertion (128 D/E writes) or a 128-state transition (256), synchronous ready support
  is incompatible with that reservation. Keep the source write fenced/unready, durably enumerate siblings with
  `(driver,fact checkpoint,state offset)` and publish only after completion, or secure the larger reservation.
  Neither lower the definitions cap nor relax opaque lookup. This readiness/budget choice needs manager adoption.

At 64/512/4,096 scale, future native acceptance must independently vary: facts sharing one set; sets with unique
releases; many releases sharing IDs; 64 siblings with one occupied state; copy-only/session-only sets; retired pins;
interspersed missing legacy pins; unprofiled and profiled label-only subjects; long inactive same-subject history.
Measure first/deep/empty pages, stale source CAS, concurrent last removal/first insertion, clear/restore/recreate,
denied/unknown probes, delayed repair after terminal T, and complete private cleanup. Freeze unrelated dimensions
when scaling one axis. Show raw keys consumed, exact points/bytes/SQL and physical scan rows/loops/filter removals,
buffers and partitions for **every** pool. No DISTINCT/sort/aggregate/residual prefix before native LIMIT is admitted.
Use existing `openGrowthDatabase`, `capture(...,{includeBackends:true})`, `costOf`, `catalogStatementBound` and
`checkGrowth` from `services/kernel/test/support/growth.ts`/`growth-capture.ts`/`growth-cost.ts`; their classifier is
shared and all-pool. Match statements/plans by backend and include nested trigger/FK work or derive omitted unique
FK probes explicitly. Counts, `rowCount`, planner estimates and elapsed time cannot prove examined work.
The 8,192 metadata rows for each full Semantic identity-basis read remain a separate reserved dimension, not hidden
inside support points. None of this physical evidence was produced by this read-only research task.

## Pending interpretation and implementation handoff

The label interpretation is technically coherent: label-only subjects enter Everything; only genuine accepted
entry/copy/session pins establish state-set use. It preserves unprofiled labels without Global/profile reads.
It **contradicts** the existing frozen empty-owner outcome that adds only a profiled label and expects every sibling,
and `docs/dynamic-collections.md` statements that any retained personal fact/profile use includes labels.
The overlap outcome also reads a logical state page as empty after clearing its only pin while only a label remains;
without a materialized header or remaining accepted pin, a directory alone cannot prove that view is still supported.
Adoption must settle that read lifetime as well as discovery. Trash-as-undo-only also narrows that document's unqualified “retained personal fact” definition. Adoption must explicitly
reconcile those assertions; research changes none of them. Generic label commands cannot satisfy them by secretly
accepting profiles. This pending product decision does not prevent the technical comparison above.

Suggested slices, each <=400 changed production lines and <=8 total paths; proposed files are marked NEW.
Tests belong to the owning implementation contracts; this report does not create or weaken frozen acceptance.
Paths below are relative to `services/kernel/`; dependency work lands first, without imagined existing exports.

1. Support storage: existing `db/library/schema.sql`, NEW timestamped support migration, existing
   `src/library/builtin-reference-store.ts` and `builtin-reference-read.sql`, NEW `builtin-set-witness.sql`,
   NEW `builtin-set-support.sql`, NEW native support test: seven paths; retain the exact read export/probe.
2. One native producer at a time (split entry and copy store edits into sequential slices): existing `src/library/entries.ts`/`entry-store.ts` and their entry SQL, then
   `copies.ts`/copy SQL, then `sessions.ts`/`progress-store.ts`/session SQL; each slice includes the common proposed
   support-transition helper and its native tests within eight paths. Actual exports are `createEntryCommands`,
   `createCopyCommands`, `createSessionCommands`; do not claim existing profile writers already maintain whole sets.
3. Completeness/repair: existing `profile-migration-page.ts` (`pinLegacyFactsPage`), `work.ts`
   (`registerLibraryWork`), `work-module.ts` (`libraryWorkModule`), NEW support-repair TS and two SQL files,
   NEW repair test: seven paths. Add phase/cost checkpoints; split schema readiness and producer prelock work if needed.
4. Logical reader: existing `collections.ts`, `follows.ts`, `personal-routes.ts`, `builtin-reference-store.ts`,
   NEW owner-discovery SQL and logical-state resolver, NEW native reader test: seven paths. Reuse real action
   boundaries; no new Access/core/provider, eager grants or GET side effects. Resolve meaning selection with manager.
5. Headerless storage, only if adopted: existing `canonical-source-store.ts`, `db/library/schema.sql`, NEW migration
   and build-fence/anchor SQL, existing canonical fixture/store/schema tests: eight paths. Preserve applied NO ACTION
   protections and the `observeCanonicalSource`/`beginCanonicalSourceRepair`/`repairCanonicalSourceStep`/
   `publishCanonicalSourceRepair` export contract; implementing the throwing ABI requires separate bounded slices.
6. Cleanup/cutover in separate <=8-path batches: existing `work.ts`, NEW cleanup page TS/SQL and cleanup test,
   then dictionary/preparation schema and obsolete consumer retirement. Inventory each FK/index/receipt dependency;
   old receipt meanings remain readable. Never hide total cleanup behind the report's small-file estimate.

Only this evidence report is delivered. Recommendation, presentation selection, readiness amendments and pending
label/trash interpretation belong in their owning documents after adoption; no second product authority is created.
