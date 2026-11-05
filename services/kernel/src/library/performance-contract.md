# Private physical-copy loans

Decision: Preserve authenticated generation-bound cursor meaning by resolving legacy sentinel cursors against
their exact retained loan; newly emitted cursors carry an explicit due-state discriminator and seek raw dated/null
index branches.

`loan-operation-bounds.ts` owns immutable declarations for copy and loan locks, loan-to-copy location, open-copy
uniqueness, generation read/advance, writes, copy/loan point reads, ambiguous legacy-cursor resolution and all
first/continuation pages. It freezes the exact scalar bind array used on the caller's live client. The public
`declareBound`, `sumBounds` and `repeatBound` arithmetic includes literal SQL bytes, JSON-serialized original
binds and schema-valid returned projections. When the existing command work association is active, it consumes
each declaration before dispatch; the charge remains on misses, negative probes, failed CAS and rollback. No
production HTTP path currently creates that association or supplies its original funded envelope for these loan
routes; the manager-owned root composition is recorded in the continuation. These leaves do not establish
authority, receipt success or a new allowance. Their eight-axis `WorkDimensions` translation explicitly drops only
`engineRequests`, which is zero for SQL-only leaves, from the declared public nine-axis vector.

Copy and joined-copy projection widths come from the existing admitted copy writer: kind and status IDs are
1–64 ASCII characters. The schema has no maximum width, so bounds use the writer's admitted vocabulary and do
not truncate stored text. Private names keep their exact Unicode and whitespace and admit at most 300 Unicode
scalars; the projection example uses four UTF-8 bytes per scalar. Loan dates, IDs and revisions use the existing
date-only Gregorian, UUID and int32 contracts. Original command SQL operands include the original name, dates,
revision, command time and transaction ID. No name lookup is performed.

The open-copy probe counts the partial unique-index result and the separate LIMIT node. Fresh insert work counts
the heap row and primary/open-copy/due/owner index entries; extension counts old and new heap/index tuples; return
replaces the open-copy and due entries with history. Generation upsert includes both the conflicting old tuple
and inserted/updated tuple. These relations have no foreign keys, deferred constraints or mutation triggers.
The local leaf formulas keep logical rows, examined candidates, points, statements and bytes separate; empty
seeks retain the bounded miss slot. No leaf builds an identity witness or invokes Search.

Open pages are capped at 100, history pages at 50, and presentation at 100. First-page and history continuation
use their existing partial ordered indexes. Open continuation uses raw `(due_on, loan_id)` seeks for dated rows
and a separate bounded null-due seek. Each branch reads at most `page limit + 1` candidates, the union is ordered
and limited again, and current copies are joined by their exact routed primary keys only after the page is chosen.
The branch candidates, final page, copy probes, sentinel and repeated page reads are all charged. `LIMIT` is not
treated as an examined-row bound. History continuation uses the raw descending `(returned_on, loan_id)` key.

New open cursors retain the same account/filter/order binding, generation and 15-minute lifetime, with a third
`dated`/`undated` field to distinguish a real `9999-12-31` due date from NULL. Existing two-field tokens remain
valid. A sentinel token is normalized with one exact loan point read after the existing generation check; a
missing generation-current loan is an internal invariant error, not a new stale-cursor refusal. The resulting
raw index branches preserve due-ascending/nulls-last order without a restart or wider page. History order stays
returned-date descending then loan ID. Listing captures the supplied token before awaiting and revalidates the
same generation at each mounted presentation read.

The surrounding journey keeps its current owners: account/action/group and Entry admission, original/current
Library profile/source and copy revision evidence, Person mapping-before/after plus summary disclosure, command
receipt lookup/write/replay, partition/floor/epoch, Shelf effects, History/outbox events, native transaction,
checkout, time and terminal cleanup, and HTTP serialization. Person IDs are deduplicated only where the caller
already coalesces them; raw loan and current-copy page projections remain separately bounded. Current Person
disclosure can conceal `semantic_not_ready` or semantic `dependency_unavailable` while preserving the loan, but
overload, partition, retry-exhaustion and deadline failures retain their classification. Authorization precedes
receipt replay; replaying a return receipt remains distinct
from issuing a fresh return against an already-returned loan. Original parsed operands and the one absolute
request/attempt deadline survive retries and uncertain outcomes. Native composition remains at existing command
and source roots, not in an alternate scheduler or a receipt-derived plan.

Choice summary: The only cursor normalization change is the exact due-state discriminator and point lookup needed
to preserve the existing signed cursor while making dated-sentinel and null-due traversal complete.

# Native Entry operation bounds

Decision: this attempt delivers immutable direct SQL plans for Entry point reads, lists, history pages and reviews;
the Entry mutation lifecycle composition continues separately. Keep SQL plans on the existing native association and
preserve authorization, exact receipts, source fences, deadlines and transaction custody.

## Read operations

`entry-operation-bounds.ts` declares the direct Entry SQL work for point reads, lists, state-history pages and
reviews. `entries.ts` reserves each declaration before its existing snapshot dispatch. Point reads include both
possible Entry lookups and the legacy profile-migration phase probes. Lists include their actual page branches,
partition epoch lookup and legacy phase probe. Cursor limits include the sentinel; a cursor can dispatch both Entry
page branches. The state-history caller validates the public 1–50 limit and adds one sentinel before constructing
the plan. Its frozen operands are the same operands dispatched by `pageEntryStateChanges` on the authorized snapshot
client. Review includes the current Entry point and selected transition projection.

History page work can examine all 64 retained transitions, including discarded revisions and other incarnations;
the requested result limit does not bound those rows. Its direct SQL declaration charges the sentinel and all
projected rows. States use the existing 64-character vocabulary limit, command kind uses the longest native writer
name, JSON escaping uses six bytes per character, and timestamp projection reserves 64 characters for the
PostgreSQL range and timezone representation. The Entry cursor routes now select only the integer partition epoch
they consume. The pre-profile read gate selects only its checked migration phase, avoiding the unbounded cursor and
digest columns. No profile-pin JSON is selected by the history page.

The plan's zero identity metadata, witnesses and engine requests apply to these local SQL statements only. It is not
the complete Entry command journey or a native grant. Mutation preparation/currentness, action/group admission,
command receipts and retries, transaction controls, history append/prune/coverage, Shelf work, events/outbox,
rollback and response serialization still need composition at their existing owners. The command runner continues
to own execution and replay. Read-only history cannot repair an Entry; no-op and exact receipt replay cannot append a
transition. Retention and the public history/page limits are unchanged.

## Copy SQL leaves

Decision: Commerce keeps the copy journey in its existing command and inventory owners; immutable operation declarations derive complete finite nine-axis costs from actual SQL, serialized binds, schema widths and current ceilings, then bind through existing native roots.

`copy-operation-bounds.ts` binds exact compiled statements to their original operands at the existing EntryStore and
copy-inventory execution owners. The declaration keeps SQL text, serialized bind bytes and projected result bytes
separate, with a fixed zero for engine requests on these SQL-only leaves. Profile pin Type/Profile IDs use the
immutable Definitions release byte ceiling and JSON's six-byte escape maximum; copy text fields use the existing
HTTP and database limits. No result row count reprices a dispatched statement.

Each filtered page plan selects the same one of nine SQL statements used by `pageCopies`. Its route/account,
optional subject/kind/status predicates and `(created_at, copy_id)` frontier match the existing full-key indexes.
The maximum page remains 100. Because the page helper clamps its own limit to 100, the maximum list branch retains
the separate one-row sentinel query; its candidate and output work is charged as its own plan. Inventory options
use the actual recursive kind/status query and its 65-value limit per dimension. The 65th raw value still makes an
oversized facet unavailable. Both page observations, each raw option and the sentinel are physical work even when
their visible result is filtered, suppressed or unchanged.

The same leaf plans bind copy insert/read/update/delete, detail presentation reads, and the retained source/read,
locked retention read and exact restore CAS. Restore preparation now requires the currently resolved subject to
remain the retained row's original subject; a redirect cannot restore that exact row under a replacement source.
The existing revision, deletion ID, expiry, profile pin, account route, owner authorization, command receipt,
Shelf, History, loan/archive, and retention-worker owners keep their current semantics.

These declarations cover the actual Library SQL leaves and their output projections. The enclosing command and
observation composition still needs to sum account/action/group admission, original/current Source and profile
reads, partition/floor/epoch checks, transaction and receipt paths, triggers, Shelf/History effects, and response
serialization from their current owners. That completion is tracked in
[the continuation brief](../../../../.temp/continuation/copy-operation-composition.md); this leaf set does not claim
a complete end-to-end copy operation bound.

# Progress session operations

The existing Progress and Continue descriptors retain their native session commands and response contracts.
An operation declaration describes work; it supplies neither owner authority nor evidence of execution.
Native owner admission still precedes receipt lookup. A completed mutation receipt and its current presentation
are independent: failure to present current source evidence cannot erase or acknowledge a mutation.

## Journal command identity

`patchSessionJournal` retains the principal, command kind, request key, session ID and normalized patch, including
the expected journal revision. Its receipt input retains the public `admission: null` member. Private import
admission identity never enters that digest. Consequently changing an import review cannot change the identity
of an already acknowledged journal command. A different patch with the same key remains a conflict.

Private admission runs inside the fresh mutation transaction after the session lock and owner check. Failure
rolls back the mutation and creates no successful receipt. Replay returns the original result under current
owner authorization without reasserting an obsolete import review or overwriting later journal edits. Private
admission does not grant public command authority.

Decision: retain the public journal digest shape and exclude private admission identity; two causal additions to
the existing native session suite cover replay after a later clear and rollback followed by retry.

## Operation derivation boundary

Closed session plans must compose preparation, original and current profile reads, owner/partition fences,
receipt replay, shelf head/activity, mutation, triggers, History and terminal presentation work through the
existing native ports. Keep logical results, examined rows, points, serialized bytes and engine requests as
separate axes. SQL-only terms can declare zero engine requests; nested native calls need their own declarations.
The ordinary session/unit/change limits remain default 20 and maximum 100; owner discovery remains maximum 50.
Raw sentinels and discarded candidates consume work and retain their original keyset frontier. No declaration
permits refill, account-history scans, cap increases or a second native admission.

# Shelf rebuild invocation custody

Decision: snapshot the rebuild request before authorization and retain one absolute page deadline through
preparation and the existing conflict reconciliation. Extend the native journey rather than add a plan-only suite.

`shelf-maintenance-runtime.ts` retains the original owner, kind and request key for both the receipt digest and
the native body. Reusing a caller's request container during authorization cannot change the requested generation
kind. Request authorization and command execution share the same absolute deadline. A page captures its locator
once; its one idempotency-conflict retry reloads the winner's header within the original five-second budget.
Already advanced pages still reach ordinary Core replay without another source preparation. Current authorization,
the original Pool, native account/gate/run locks and transaction cleanup remain with their existing owners.

This custody boundary does not supply complete nine-axis rebuild operation plans. Those plans must include released
source/type preparation, account/action/group checks, command and receipt work, phase SQL and repeated native points,
validation, publication, bounded old-generation retirement, response serialization and successor/ack controls.
Page and segment limits bound finite invocations; they do not bound the number of future durable pages. A completed
phase or count cannot establish completed publication and retirement.

# Library performance contract

Decision: preserve the existing private editor and history journey while landing immutable schema-bounded metadata-journal SQL plans at their current DAO owner. The full create/edit/reopen/HTTP operation composition remains a continuation; the journal plans do not claim parent-command admission or execution evidence.

This leaf owns Collection operation bounds and custody across Library consumers. The detailed SQL derivations and
operation-specific growth suites remain in the [Library Cost sections](README.md#cost); this contract does not claim
those suites have passed. Shared native bounds and evidence are owned by the [Kernel performance contract](../../performance-contract.md).

## Collection operation costs

Decision: keep each native repair page at 128 raw original occurrences, independently of Source's 100-key ceiling; charge the failed edit, separately authorized begin, each outbox/DBOS continuation, and deliberate retry as separate stages.

Price the complete operation: request and status reads, checkpoints, activation, preparation, authorization, locks,
serialization, receipt and effect work, source fences, negative or discarded candidates, and every nested disclosure.
A short returned page, deduplicated terminal set or fixed candidate declaration does not reduce physical work already
performed. Apply the existing 100 raw-key and 262,144-row native ceilings and the published Search maxima. Producer
declarations describe admissible work; they are not native grants, pagination evidence or funding.

Library owns one immutable closed nine-axis operation set: `candidateKeys`, `nativeRows`,
`identityMetadataRows`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, `emptySeeks` and `engineRequests`.
Use overflow-safe sums, complete nested costs, explicit aliases and deterministic conflict resolution. Actual
Progress/Continue and Content Feed callers consume these descriptors.

`collection-history-bounds.ts` now binds each metadata-history SQL leaf to its exact stored operands and bounded
projection. Capture composes curator reconciliation, transition append, the 129-row prune scan and partial-coverage
update once; the snapshot projection reserves escaped schema maxima for both sides of all five metadata fields.
First/next page, empty page, state and exact-revision leaves retain the 128-entry journal bound and 51-row page
sentinel. These are DAO declarations only. The dense-order journey keeps the failed add/move command and the
separately authorized repair-begin command in their existing `runCommand` transactions. A failed edit commits no
receipt and returns dependency-unavailable; the original request body and key remain available for a deliberate,
currently authorized retry after repair. Each committed page writes its next exact locator to the existing outbox in
the same fence transaction. The existing outbox effect then enqueues that locator through the DBOS client with the
current workflow name, maintenance queue, step identity and return-existing policy. Page SQL and event-fence bytes
are charged in the page declaration; the enqueue is a separate `engineRequests: 1` continuation term and is not
double-counted in the event fence. The page wrapper preserves the existing one-command-attempt-per-DBOS-attempt
retry composition. Full actor Access/receipt/History/result-envelope cost derivation remains in
`.temp/continuation/dense-collection-edit-costs.md`.

## Whole-query publication

The 50-original branch is inadmissible. Its two `resolveSubject` disclosure passes alone require
`50 × 2 × 8,192 = 819,200` native rows before settlement, above the retained 262,144-row ceiling. This is a necessary
lower bound, not the completed operation derivation or native execution evidence. Refuse before useful staging and
preserve output A, the original client and owner, deadline, current authorization, drain and rollback behavior.
Do not create a refused frontier, checkpoint, seal, activation, partial disclosure, smaller-prefix workaround or
larger ceiling.

The whole-query branch remains separate from ordinary member-page planning, directory `listCuratorPage` and
read-only previews. Its existing [Cost entry](README.md#whole-query-collection-publication) owns operation-specific
SQL detail. The [ordinary member-page entry](README.md#members-page) owns canonical store/fence behavior, owner-filter
HTTP, plan and growth evidence, BASIC/FULL continuation, and final owner/source currentness. Search receiving keeps
its five existing suites: `scoped-work-context`, `members-native-scope`,
`scope-members-source-declaration`, `scope-kind-work-context` and `publication-work-context`.

## Descriptor custody

Preserve original opaque evidence, one original client, current owner and deadline, the three-attempt limit,
current authorization and source checks, and native consumption before the tracked transaction. Drain and release
exactly once, including terminal release after useful-work expiry; preserve same-client rollback and native caps.
History and Work bind their execution adapters at service roots ([History](../history/README.md#selected-native-executor-binding),
[Work](../work/README.md#selected-execution-producer)). This documentation does not authorize cross-owner mutable
quotes or funding, refill, price profiles, another admission protocol, a second consumer or a new writer.

The [architecture](../../../../docs/architecture.md#modules-and-boundaries) owns permission-core purity, public
edges and adapter direction; [verification](../../../../docs/development/verification.md#capability-evidence)
owns the limits of native, browser and finite-execution evidence.

## Native identity scope planning and current seals

The plan-specific SQL and projections below refine the shared [Collection operation cost declarations](#collection-operation-costs).

`createLibraryIdentityNativePlanner` in `module.ts` exposes the default native `advance`, `readPage` and
same-command `verifySeal` ports. The exact key is `{job, sourceIdentity, scope: 'collection-source'}`.
This is an explicitly funded native maintenance entry point; ordinary Source capture does not gain an
unfunded mapping-discovery pass. The admitted saved `IdentityJob` and Library's bounded native
`pageLibraryIdentityEpochChanges` projection transform immutable input-generation originals on the same snapshot.
Ordinary `identityEpochStore.pageChanges` and `readJob` remain unchanged. Ordinary pending mappings never supply a guessed destination. Metadata, raw capture and raw
planning are independent of ordinary Source readiness. Supported placement is a genuine same-home account,
Source and admitted job: curated members, private built-in entry/label/session/copy, and committed active
account-backed explicit output. Private built-in Sources traverse the independent four-family owner ranges, including
excluded originals and unreserved label keys. Public-output, frozen and foreign-home authority stays unavailable.

The native `identity_scope_plan` IS the expected manifest. It retains capture, writer/prearm fences,
source/owner incarnation and OLD head/ready/working references. OLD withdrawal traverses retained derived
references even when the original native fact was removed. The distinct working generation stores structural
canonical references; original values, pins, occurrence IDs/order/notes/duplicates and immutable output are
untouched. Original owner state and its conflicts remain with the existing owner-index writer and
`currentOwnerState`'s highest live `owner_write_seq`; planning creates no timestamp-based winner. Raw work
enrolls deterministic collision-checked OLD, NEW and first-apply operations, plus handoff when retained old
state exists, in the same transaction as derived writes/frontier advancement. Invalidation retains its separate
meaning. Neither this generation nor its seal publishes a ready query, applies receiving work, or acknowledges
ALL-Library/follow work.

Every applicable driver must exhaust before the final locked source/capture/current-job/prearm comparison.
The seal retains the executor-native commit receipt for that exact generation/version/frontier. The page API
uses the effect-key/disposition tuple, limits 1..100 and returns pending for an unfinished or changed plan.
A sealed full page is not caller exhaustion; callers continue until `exhausted` and verify the same current seal
on their genuine Source-home Core client. Zero follows exactly the same complete raw capture/traversal,
committed receipt and current fence path. Native collection/account writer triggers serialize with these
locks: births, rekeys, changes and late writes invalidate prior currentness before commit. Admission input,
claim, prearm bridge/directory, cancellation/release and owner/capture changes also fail current verification.

Plan/effect/seal evidence keeps native custody. Foreign keys retain the raw capture and derived generations;
immutable effects/seals cannot be silently pruned. Native capture retirement checks the indexed plan hold
before deleting any child receipt. Missing real control handoff stays a retained Source in the existing terminal
inventory/minimizer, never `nativeNoData` or erasure success. The native implementation does not release old
physical custody or infer destination erasure.

### Cost

- Touches: exact route/collection/plan primary keys; one bounded effect or retained OLD range; the existing
  native raw driver and custody SQL; admitted saved job/input-generation pages; native local mapping claims;
  current account/Collection/Core owner, capture and commit receipt; prearm input/group/bridge/directory locks;
  derived references; and the actual command event/native receipt/COMMIT or ROLLBACK. No receiving SQL is
  dispatched by this producer; the receiving owner must price its own reached bodies.
- Bound: `identity-native-bounds.ts` owns one immutable set of Library SQL, Source-basis and selected-plan
  declarations. `identity-native-planner-statements.ts` retains the exact planner SQL text;
  `libraryIdentityFootprint` dispatches from the same declarations that original composition reads. Each internal
  term is a complete nine-axis `@rezics/bounds` value (`candidateKeys`, `nativeRows`, `identityMetadataRows`,
  `emptySeeks`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, `engineRequests`); SQL terms explicitly set
  `engineRequests=0`, then adapters project the existing eight-axis native receipt. A point term is exact SQL
  UTF-8 bytes plus JSON-serialized original bind bytes plus its closed schema/native projection bound. Repeats and
  page ranges use `sumBounds`, `repeatBound` and `withinCeiling`; overflow and unrecognized SQL remain refused.
  Native Source basis declarations take each imported query's own `params`, so arity and serialized bind bytes
  track the actual query owner.
  A range admits LIMIT plus one indexed EOF slot, not result count. Effects page: `n` candidate keys,
  `n+1` native rows, zero identity metadata, one native point, zero witnesses, one statement,
  SQL+serialized binds+`512n` bytes, one empty seek. The native page projects only the producer's
  `library-native:SHA256(operation)` effect key; malformed retained keys refuse without truncation.
  Locked plan: one native row/point, zero identity metadata, one statement,
  SQL+binds+`LIBRARY_IDENTITY_PLAN_RESULT_BYTES`, one empty seek. That result bound is derived from
  four schema-bounded JSON values, UUID/decimal widths, scope and the four native retained-state fields.
  SQL validates the SHA256 scope digest and retained UUID/<=256-byte basis shape before projecting it;
  invalid state returns a bounded rejection marker. Actual original bind bytes are bounded before dispatch. Current capture: seven joined native
  rows/points, one identity metadata row, one statement, SQL+binds+64 bytes, one empty seek. Current
  admitted job: admission/owner, at most two inputs plus EOF, group/bridge/directory and bounded CTE
  revisits plus the actual claim admit 16 native/identity rows, 13 points, one statement, SQL+binds+2048 bytes, four possible
  empty seeks. Seal receipt: five native rows/points, two identity metadata rows, one statement,
  SQL+binds+256 bytes, one empty seek. Generation insertion charges its Collection FK point;
  insert-plan additionally charges all three possible FK points. Native mutations reserve an indexed
  miss slot too, including failed foreign-key probes; an empty or failed dispatch never refunds it.
  Known transaction controls have zero rows/points/metadata/candidates/witnesses/seeks but one statement
  and their actual SQL bytes; native checkout charges one point. No witnesses are constructed anywhere.
  Unknown statements remain unknown. Library's native transform reads only closed kind and four
  UUID-or-null fields through `identity-epoch-store-library-transform.sql`: three native rows/points,
  two identity metadata rows, one statement, SQL+binds+256 result bytes, three possible misses. It
  validates the native job/epoch/pending-or-published state and current admission owner before use.
  The input query pays for a third rejection sentinel and refuses more than two generations before
  original seeks. One input reads <=100 originals; two read <=50 each. The minimum full-page cutoff,
  ordering, deduplication, original-generation filter and immutable transform remain intact. No whole
  intent/release/undoJob/verificationReceipt is projected, capped or truncated. This plan uses the bounded
  input-generation transform rather than the full saved-job result. The retained `savedJob` compatibility literal
  requires `NativeCollectionWork.resultByteBound` for the same job/epoch on the same work object and adds that paid
  result bound to its SQL, original binds and row framing; missing or overflowing evidence stays unavailable. A
  selected prepaid path also refuses the full Core partition projection because it has no same-snapshot size
  evidence. The ordinary store counterpart is unaffected. Native metadata
  now reads only partition state/epoch/position, paying its fixed point rather than projecting unused
  node or move addresses. Native metadata,
  raw and custody descendants now execute on the exact supplied ledger, including their own checkouts,
  explicit native statement reservations and terminal controls. Their SQL/projection bounds remain in
  `collection-source-native.ts` and `native-source-custody.ts`, including capture/receipt/retention. Custody reserves point-miss slots even for a positive outer result;
  native Core ownership/publication/proof controls also declare their identity-metadata row.
- Growth check: `test/library/identity-scope-effects.test.ts` covers all six drivers, bounded positive pages,
  interrupted-plan resume, final writer-fence refusal, omitted enrollment/rollback, genuine exhaustive zero,
  late first apply, rekey/prearm changes, repeat and failure accounting. `identity-original-work.test.ts` pins
  same-work saved-job result-byte evidence. Native acceptance includes integrated receiving and the five Search receiving suites named above; focused
  declaration checks do not substitute for that evidence.

The real `NativeCollectionWork` reservation is cumulative. Its original ID, Pool, deadline and command resources
are retained; dispatched misses, SQL failures, repeated calls, rollbacks and settlement cannot refill native rows.
Command cleanup is reserved before BEGIN. Custody holds distinct COMMIT and ROLLBACK slots; a failed COMMIT
still dispatches the separately paid ROLLBACK. Standalone planning and page reads retain their independent
admission; standalone discovery remains sixteen route-leading indexed seeks and page limits remain 1..100.
Selected Source maintenance consumes its existing original and irreversible schedule, with no discovery or planner
steps and one effect page at limit 1. `advancePrepaid`,
`advanceLibraryIdentityNativePlanWithWork`, `readLibraryScopeEffectsPageWithWork` and
`nextLibraryIdentityNativePlanWithWork` use the existing live Source Library partition in place. The prepaid page
input omits allowance and retains the source-discriminant generic seal/page union. Library rechecks the exact
owner ledger, Pool, unchanged owner deadline and live callback before dispatch and after awaited work; a copied
ledger, changed deadline or escaped callback cannot become independent funding. Planner metadata/raw/capture
and finish descendants no longer construct a second ledger or transfer a fresh allowance. A historical capture
allowance cannot fund a continuation. Verification resolves the already-live allocation before any SQL, meters
its exact command query surface on that same ledger and performs no checkout or foreign IO. Positive and genuine
sealed-zero verification both retain the native current/receipt/job checks, including a repeated final recheck.
Normal Semantic receiving recognizes the concrete exported `libraryIdentityFootprint` declaration; unknown reached
bodies remain refused until their SQL owner declares them. The local 512-row/32-point/16-statement/262144-byte cap
is not additional Source funding. The whole authentic parent reserves disjoint Accounts-local, every reached
Source/History and Library, and transfer-control terms before first I/O. It preserves the original,
position, Pool, WorkClient, SDK, registry, deadline and live callback. If any reached term is unavailable, refuse
before child I/O; never substitute zero or a replacement foreign producer.

## Published snapshot reads and exact retention locators

Decision: bind immutable SQL read declarations to the existing Published Log store and retention discovery,
counting both public keyset streams before the outer limit; retain native command ownership and exact deletion
identity. A causal addition to the existing native retention journey covers a stale scheduled episode after Undo.

`published-log-bounds.ts` retains original serialized binds and compiled SQL for point, locked point, first/next
public page and due discovery reads. Execution uses the caller's original client. The public partial index excludes
deleted rows. A next page has two independently limited ranges; discarded candidates, the sentinel and repeated
candidate/final projections count before response filtering. The due partial index excludes non-deletions and
minimization tombstones; cutoff and the three-column locator bound its range. Empty probes count even when no
row is returned. Schema widths determine escaped projections, including the 1000-character note, UUIDs, literal
session states, int32 revision and timestamp text. These SQL leaves have no identity admission, witnesses or Search
engine calls. Their declarations supply no authority or successful execution evidence.

These read leaves do not yet constitute complete operation plans. Enclosing plans must add account/action/group
preparation, source/version and currentness reads, command receipts, mutation triggers, History, transaction and
connection controls, response serialization, retries and DBOS/outbox controls before native admission. Retention
must price one bounded page/segment, retain the original cutoff and exact deletion locator through continuation,
and include negative/racing candidates and cleanup. PAGE_BOUND and SEGMENT_BOUND remain 100; neither bounds future
scheduled invocations. Undo never reads the private session or renews the original deletion's eligibility.

## Subject Collection pair seek

Decision: bind Subject continuation to its exact BASIC/FULL view and public page limit at the HTTP/service
boundary; keep the helper's independent 5,000-pair capacity and the public default 20/maximum 100.
The existing native HTTP journey tests both views across first and next pages and rejects cross-view/limit replay.

`subject-collection-read-bounds.ts` snapshots the actual `listing-page.sql` operands before the existing
`listing.ts` connection dispatch. The subject-leading `(route, subject_id, collection_id)` primary key visits
at most the requested positive pairs, including the sentinel. The declaration counts both index rows and LIMIT
rows, one seek/statement, original serialized binds, literal SQL and the escaped UUID/int4/timestamp projection.
Empty results do not reduce the declaration. This SQL leaf has no identity, witness or Search producer.

This is a leaf, not the complete reverse-discovery operation or a native grant. Subject resolution, maintained
count, partition/currentness, repeated curator checks, connection controls and FULL disclosure still belong to the
enclosing immutable operation. Count and pair observations remain independent; no atomic snapshot, refill or
count recomputation is introduced. Directory/preview composition retains its existing callers and limits.
