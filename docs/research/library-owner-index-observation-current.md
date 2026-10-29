# Native owner candidates, support and complete observations

Research evidence, 2026-10-29. Inspected worktree HEAD and local `dev` both resolve to
`bae843d0b9e438ebba76a96b4b758d537808d64c`. This is a design recommendation, not adoption,
an executable interface, runtime acceptance or permission to activate an incomplete source.
No sibling investigation was read. Native sources below are AGPL-3.0-only under the root
[licence](../../LICENSE); external source was read without installation, build or execution.

## Recommendation and authority

Keep native facts authoritative. Build one private owner candidate/support directory, indexed
by canonical subject, with native fact-table indexes for exact predicates and a small aggregate
accepted-pin support directory within that same owner access structure. Do not resurrect the
per-Collection `canonical_source_fact` witness design. Add private selective invalidation metadata
and retained changed-input work, not another fact database. Admit direct plans only where their
examined work is page-bounded; use the shared retained preparation for the other supported shapes.

This follows [Library](../library-and-collections.md), [owner predicates](../library-owner-queries.md),
[dynamic Collections](../dynamic-collections.md), [Collection source](../collection-source.md),
[Continue](../library-continue.md), [filtered lists](../filtered-lists.md) and [deletion](../deletion.md).
All their relevant membership, identity, publication, lifecycle and cost sections were inspected.
Those documents supersede older witness/replay guidance. The current parser, rather than the
owner-query document's outdated parser inventory, establishes the delivered shared grammar.

Everything includes state, effective labels, retained sessions/history and holdings; labels work
without profiles and support no state siblings. Only actual live entry/session/copy pins support
state-set identities; trash supports none. Reactions support only Liked. Liked must have a logical
private identity and genuine empty 200 even before materialization. Its identity is still missing
from the inspected helper. No independent presence flag, default state or reaction mirror follows.

## Committed source inventory

Paths in this section are relative to `services/kernel/`, except the shared parser.
The module [README](../../services/kernel/src/library/README.md) is an inventory, not proof of runtime;
its allocator/column absence paragraph is superseded by the actual migrations and primitive receipts.

| Boundary | Actual evidence and classification |
| --- | --- |
| Shared grammar | `packages/filter/src/{filter.ts,owner-filter.ts,index.ts}` exports `FilterDocument`, `OwnerLeaf`, `parseFilter`, `admitFilter`; owner admission is explicitly enabled by the consumer. Closed owner families, saved expansion and Boolean limits are implemented. This does not bind private SQL or viewer authority. |
| State order | `src/library/owner-write-sequence.ts/.md` delivers `allocateOwnerWriteSeq(tx,accountId):Promise<bigint>`; migration `20261028182526_owner_write_sequence.sql` delivers counter plus nullable positive live/archive columns. Production set/clear/Undo integration and authoritative legacy cutover remain pending. |
| Private head | `src/library/owner-fact-version.ts/.md` delivers `readOwnerFactVersion(client,accountId):Promise<bigint|null>` on the caller's snapshot. `20261028193813_owner_query_version_coverage.sql` replaces all five UPDATE triggers with actual changed-row coverage. NULL means unbuilt, never zero. |
| Native truth | `src/library/{entry-store.ts,progress-store.ts,label-store.ts,label-assignment-store.ts}` and their SQL read actual entry/copy/session/label rows. The entry/copy adapters still constrain fixed values and omit accepted pins. These are storage primitives, not full profiled owner plans. |
| Current raw sources | `src/library/collection-source-native.ts` exports `readNativeCollectionMetadata`, `authorizeNativeCollectionMetadata`, `readNativeCollectionRawPage`, `probeNativeCollectionOriginal`; raw ranges and current label-parent checks are implemented. Headerless/public dynamic sources are unavailable; state probes are not canonical winner selection. |
| Common source | Every `createCollectionSource` method in `src/library/collection-source.ts` throws `dependency_unavailable`. `canonical-source-store.ts` exports throwing scaffolding; its historic alias budgets/signatures do not implement the adopted epoch design. |
| Collection identity | `builtinCollectionId` in `builtin-identity.ts` implements Everything/state, not Liked. `collection-model.ts` is still curated-shaped. `builtin-reference-store.ts` binds entry witnesses, not complete session/copy pin support or all sibling lifetimes. |
| Identity epoch | `src/semantic/identity-epoch-contract.ts/.md` is interface-only. `IdentityEpochStore` names missing `identityEpochStore`, mapping step and coordinator producers. Registration/specification is not a delivered store/bootstrap or publication runtime. |
| Existing public source | `src/semantic/search-source.ts:subjectSource` is implemented: same-snapshot subject/fact/adoption/release loading and optional tuple-fence filtering. It is not the future complete public-filter projection/privacy observation. |
| Public Source2a boundary | `src/semantic/public-filter-source-contract.ts/.md` declares future `publicFilterSource`, `recordPrivacyReduction`, projection pages, reduction log and population observations. These are interface-only; no type name establishes delivery. |
| Disclosure points | `src/semantic/disclosure.ts:readCandidateDisclosure`, `statement-disclosure.ts`, `eligibility.ts` and Access supply actual point/native checks. Security revisions and emitted revision/link events do not implement full-query reduction routing or refresh-visible foreign ACK. |
| Work | `src/work/{registry.ts,client.ts,queues.ts}` and `src/library/{work-module.ts,work.ts}` implement DBOS composition and listing effects. They do not deliver owner preparation or terminal Library graph cleanup. |
| Content | `src/content/reactions.ts`, `reaction-viewer.sql` and reaction migrations implement actor-partition native truth/points. No callable owner Liked page+membership/version reader appears in this committed tree or the inspected equal local dev revision. |

The supplied raw-Liked delivery description is narrower than canonical support: stored subject IDs,
actor partition only, no identity/disclosure/completeness proof. Even where that later raw adapter is
available, classify it only as raw. The registered page+membership-version/`readLikedVersion` extension
must produce its actual development receipt and DDL cutover before a consumer calls it delivered.
Neither the local dev revision nor the primitive receipts establish that extension here. Do not guess
its filename or signature; Content must provide the export, snapshot scope and covered mutation set.

## Physical minimum: directory plus native truth indexes

Use schematic keys below as derivations, not proposed exported types. `O` means routed owner;
`C` canonical subject; `S` immutable stored original. Only derived keys change on identity maintenance.
The one directory has canonical candidate rows `(O,C)` and original-support rows `(O,C,S)`;
native fields/pins/fact IDs are not copied into one row per fact. Original-support rows summarize
family presence and activity and permit strict next-original seeks, independent of fact multiplicity.
Its canonical level supplies unique ID order and maintained activity order. These are discovery
summaries, never current disclosure, permission, exact public counts or new personal facts.

Native tables need derived canonical routing columns/indexes or an equivalent owner-local maintained
mapping access path. Keep `subject_id`, accepted pins, session/copy IDs and occurrence references intact.
Do not put canonical groups or all fact IDs in a JSON array. Reuse native full-key points after discovery.
One row per distinct original is necessary to skip a million same-original sessions without DISTINCT
over those sessions; one canonical row avoids duplicate runs between pages. Both are one shared directory,
not Everything/state/Continue/Liked subject tables. Prepared rows remain quota-bound query results.

| Need | Existing path and minimum extension |
| --- | --- |
| Initial source coverage | Entry PK `(route,account_id,subject_id)`; `copy_raw_source` and `progress_session_raw_source` `(route,account_id,subject_id,fact_id)` from `20261028003557_owner_fact_source_hooks.sql`; reserved-label source from `20261027234813_label_reservation_source.sql`. These support bounded producer backfill, not canonical read order. |
| Canonical page/direct target | Directory `(O,C)` seek and `(O,C,S)` support range. A point target can start at its C without enumerating preceding owner subjects. Raw `[a,c,z]`, a→z, becomes maintained `[c,z]` before paging. |
| State winner | Native live entry index `(O,C,owner_write_seq DESC,S)` and original support points; retain all conflicting entries. Select the highest LIVE sequence under adopted disclosure, then test its scoped state, never seek an older matching state. A withheld original cannot supply a displayed winner. |
| Sessions | Native index anchored by `(O,C,S,profileId,lifecycle,session_id)` for EXISTS, plus active top-session `(O,C,S,last_changed_at DESC,session_id ASC)`. Actual `progress_session_active` already supports stored-subject top-one; canonical/profile prefixing is missing. |
| Holdings | `copy_raw_source` and existing subject copy index cover enumeration; add native accepted-profile/kind/status seeks for each admitted qualifier shape. Both kind/status constrain the same copy. Omitted qualifiers must not force a scan through unselected kind/status prefixes. |
| Labels | Existing reserved source bounds one S to 32 reservations; assignment PK and same-owner parent PK prove actual liveness. `label_assignment_owner_label` seeks affected assignments after parent changes. Legacy unreserved rows need cutover; ignoring them cannot certify absence. |
| Continue activity | `progress_head` retains activity after entry removal; `createShelfHeads`/`createProgressActivity` in `shelf-heads.ts`, `shelf-head-touch.sql`, `shelf-entry-raise.sql` provide native head-first/max maintenance. Add canonical directory `(O,activity DESC,C ASC)` discovery, not a sort over entries/sessions. |
| State-set/presentation support | Aggregate distinct accepted pin use in the owner directory, indexed by profile/set and state-containing digest order. Derive sibling vocabulary from `profile.ts:resolveLibraryProfilePin` and immutable Definitions. No pin/fact payload copy or per-state subject list. |

The support level counts live accepted pin uses, with exact first/last transitions under the owner
transaction. For a new digest, bounded immutable descriptor expansion establishes its state-containing
support index; do not enumerate every release on discovery. Seek the smallest currently supported digest
containing the requested state. A digest supporting other states is insufficient. Last-use removal retracts
that digest's support; another retained session/copy may preserve it. Empty siblings remain discoverable.
Materialized headers and complete public generations keep accepted meaning; owner rename wins.

First supporting fact inserts coverage in its native transaction or marks exact incomplete work there.
Last removal uses native indexed EXISTS/top-one replacement, not `COUNT(*)` over all sessions. Counts may
accelerate discovery but are not disclosure. Serialize aggregate transitions with a stable owner/original
lock order; charge both old/new support keys on transitions. Parent-label deletion changes one native
parent and invalidates its private dependency immediately; it must not synchronously update millions
of candidate rows. Bounded work uses the label-leading reverse index to repair affected originals.

State's same-value fresh sequence changes the winner even if visible state text stays equal. It must
update native winner ordering, private invalidation and relevant activity/support projections. The current
changed-row head trigger covers that mutation; the original narrow trigger would not. No archive competes.
Clearing removes that live contribution without creating a sequence tombstone; session history survives.

For millions of sessions on one subject, exact lifecycle EXISTS and top-active probes use native indexes;
finishing one displayed session exposes the next without sorting all sessions. Skip to the next directory
original/subject, not the next raw session, for page discovery. Sparse units/history are never enumerated
to construct BASIC_SESSION. Activity remains exact SQL timestamp text; tie order is session ID, separately
from Continue's activity-descending/C-ascending subject order. Unknown historical activity stays unready.

Continue must work as the FIRST Library read: writers/backfill maintain these paths proactively, not on
an Everything visit. Chosen state role comes from its exact accepted profile; a non-active winner defeats
an older active state but never vetoes an independent active session. Session-only subjects have null state.
Completing/abandoning a session can raise subject activity while another active support remains.
An aggregate activity maximum over withheld originals is only a candidate bound: it cannot order the final
page. Preparation computes disclosed activity and indexes settled rows; direct Continue needs equivalent
current coverage. Labels union across admitted originals; independent sessions/copies never collapse.

## Last-readable-original access and identity concurrency

Canonical support must preserve every potentially qualifying original, including currently withheld
ones for later repair. An arbitrary representative loses the only readable support when it is last.
The directory's original range lets preparation inspect each original once, with native truth probes
and actual original/source/terminal admission, in bounded steps. It retains group frontier and settled
result/order work; it does not repeat the 4096-original walk on each read/page/direct target.
Register complete disclosure dependencies, including excluded originals. Results may retain a bounded
support locator for final native recheck; never copy every exact fact as a witness database.

Trace: only S4096 supports a readable terminal. Preparation seeks all relevant originals across steps,
rejects withheld originals and settles C from S4096. Later S4096 loses disclosure. A relevant native
reduction invalidates that prepared use immediately, even if its positive support count remains large.
Recheck the locator, repair the affected group from retained native input work and prove replacement or
complete absence. A failed positive alone proves neither. Grant/restoration behind an old frontier also
requires dependency repair; permanently skipping previously withheld originals is incomplete.

This cannot be implemented solely by current Access points: missing is a complete native observation/
change-routing producer for original/source/terminal dependencies. Semantic/Access must answer the minimum
question: which committed dependency changes invalidate this owner query, including excluded supports,
and how does a consumer detect them since its covered cut without sweeping every home? Its concrete
transactional routing/observation must be reviewed; this report invents no reader signature or allow token.

Merge/unmerge/repoint first marks the shared identity epoch pending, then pages derived mapping/directory/
native-index work, then publishes only after required participant effects and custody complete. Original
facts never move/re-key and maintenance never allocates state sequence. Delayed work binds actual job,
epoch, native transaction and current home fence, so a prior merge cannot overwrite a later split.
Private fact writes racing maintenance must update the admitted mapping or leave retained catch-up work;
publication must reconcile that work under the native home fence. Reads prepare during pending and restart
cursors after publication. Existing `IdentityEpochStore.admitHomeEffect` describes this requirement;
its implementation and bootstrap are missing. Ordinary redirects do not substitute for this protocol.

## Complete observations and selective preparation

A complete owner observation identifies actual population/source, accepted meaning, published identity
epoch, coverage/cutover state and query dependency closure in one admitted basis. Read head and native
facts in the same owner REPEATABLE READ snapshot. A non-null head merely detects native mutations;
it proves no bootstrap, empty set, permission, canonical epoch or completeness of query results.
A missing entry makes `owner.state` false only after complete source coverage. NOT state includes no-entry subjects;
`presence AND NOT own-completed-session` retains no-entry label/holding/session support but excludes
any live own completed session even after state clear. Bob's completion changes no Alice predicate.
Catalogue unknown remains not-proven under NOT; a missing owner index is readiness, not false.

Expand saved branches with `admitFilter`, collect every owner/catalogue leaf, qualifier dependency,
negative branch, source/population key, order and accepted meaning. Do not prune dependencies because
a current Boolean branch is false or because a subject is excluded. Native owner scope binds viewer-self
after real credential/scope/gate admission; no account selector or Collection-curator substitution.

The broad version plus native indexes is sufficient for a fresh bounded direct query, but insufficient
for selectively reusing arbitrary prepared queries. Two commits can advance the same head while changing
different labels, session lifecycles or order inputs. The head alone cannot distinguish these cases;
re-evaluating every definition or rebuilding all results on every head change violates selective work.

Additional PRIVATE change discrimination is required. The smallest alternatives are indexed full-query
dependency registrations invalidated in the fact transaction, or per-dependency change positions plus
indexed changed-input locators. Recommend the latter together with registrations for affected-result seeks:
keyed last-change metadata, coalesced original/parent-range repair intents, retained query frontier and
unique `(result,generation,C)` rows. These are invalidation/work metadata, not copied fact values or grants.
Use the existing head as a commit fence; derive family/key impacts from actual old/new native rows.
Same-value sequence, lifecycle/activity, holding kind/status and parent-label changes all participate.

Deleting a parent records a label-parent range intent once; registration includes presence as well as
the exact label predicate. Repair visits its indexed assignments, not the whole owner. A copy/session
change records the affected original and old/new predicate keys; physical deletion retains its locator
until dependent results catch up. High-water marks alone lose intermediate affected inputs, so keep
work custody until all relevant prepared consumers cover it or are actually evicted. No public log
receives private IDs/keys. This private metadata is absent from the broad-head primitive.

Preparation reads a bounded native input range and current dependency positions, commits results and
frontier with CAS, and retains changes arriving behind that frontier. Final activation proves raw EOF,
all required producer coverage and caught-up dependency work, under current native fencing. A writer
either precedes this cut or atomically invalidates it afterwards. A read starting after an owner write
cannot disclose the old result: apply indexed repair or return retained preparing, then useful output.
Do not compare the broad head inside one old RR snapshot twice and call that final revalidation.
Implement activation/impact serialization on one stable native owner control row: writers lock it and
record impacts before commit; activation locks it, checks the covered cut and installs registrations before
unlocking. A racing writer then invalidates atomically. RR serialization failures restart bounded work and
are charged; missing control-row/bootstrap coverage admits no negative proof. This lock protocol is proposed.

Each later page reauthorizes source/viewer, observes current relevant safety, reads the covered result,
checks emitted native support and fields, and revalidates the same safety start before disclosure.
A relevant reduction repaired and ACKed between start and finish must still be detected. Separate
owner/home transactions release connections before another home; there is no global delivery snapshot.
Private high-water metadata cannot replace Semantic's public/foreign privacy observation and ACK.

Finite preparation advances raw keys once per build, persists settled result rows in order, and repairs
only changed dependency inputs. A large OR/NOT/order intersection uses retained indexed set work, not a
match-linear request sort or repeated final-leaf replay. Building order indexes incrementally charges
their B-tree work. Publish a useful filled page or genuine final exhaustion; otherwise preparing, never
successful empty chains. Population 4096 is a required growth scale, not an owner/session population cap.

## Members cache fill and operational transaction gap

The specific members exception in dynamic Collections permits idempotent derived preparation plus work
intent. It supersedes generic Library prose forbidding GET enqueue for this surface only. Collection
list/detail/discovery and Continue GET remain pure; Continue's proactive maintenance is a prerequisite.
Members preparation key includes actual viewer, Collection, validated expanded filter/sort and accepted
release/meaning. Enforce existing quota/expiry and account terminal fence in the same intent transaction.
Persist no receipt, domain event, grant, header or user-visible resource mutation.

Transport is exactly HTTP 202, `application/json`, `{preparing:true}`, `Retry-After`, `private, no-store`;
retry the same validated URL and cursor. No operation ID, next field or partial members. Exhausted 200
remains `{members:[],next:null}`. Unavailable/no-progress remains 503, not perpetual fake preparation.

Actual integration inspection matters: `createLibraryCommandRunner.ownAccount`/`trustedAccount` use
receipted `runCommand`. `runCommand` requires an event unless branded noEffect; callbacks on noEffect
are rejected. `shareAccount` requires a live command transaction and locks the account FOR SHARE.
`withConnection` supplies checkout/release only. `WorkClient.enqueue` uses DBOS's system store; no native
atomic owner preparation+intent transaction is exported here. `registerLibraryWork` currently registers
listing only. Neither post-commit enqueue alone nor mutation disguised as noEffect closes crash custody.

Root/Core must resolve this precise integration gap: support a fenced operational transaction that writes
only derived preparation and its durable intent without receipts/domain events, with recovery dispatch
through existing WorkModule/DBOS infrastructure. Inspect the actual producer receipt before integration.
Do not fabricate Actor/CommandTransaction, bypass Access, add a queue/scheduler, or call the existing
trusted-account command a compliant GET path. This is a missing producer, not contradictory page semantics.

## Authoritative legacy cutover and terminal custody

First deploy real sequence allocation for every fresh successful set/clear/Undo before advertising
canonical state readiness. Exact receipt replay allocates nothing; failures roll back counter/fact/hooks/
receipt/outbox together. Archive keeps original sequence, Undo receives a new one. Preserve native CAS,
incarnation, restored pins/user dates and exact clear/Undo response behavior. Repair/purge allocate nothing.

For NULL legacy rows, bounded migration may reconstruct authoritative command order only from proven
native locators. `editorial.write_basis` has PK `(partition_no,transaction_id)` and unique partition
position; `command/fence.sql` commits that order with facts. Current entry update stores transaction_id;
`shelf-entry-raise.sql` changes activity without replacing it. Verify historical writers and retained
locators actually identify the latest state write, and that partition move/epoch history preserves order.
Do not use outbox JSON scans, timestamps, UUID ordering, unrelated source stamps or fabricated zero.

Migration needs a native owner-keyed retained frontier, evidence-derived ordering index and short final
owner write barrier/catch-up. Rank only verified state-write evidence, reserve the legacy range before
fresh sequences can overlap, and compare expected original revision/transaction before assigning.
An initial per-owner cutover fence may hold that owner's state mutations while its bounded legacy work
settles; other owners proceed. Resume fresh writes above the reserved range. Never reset an already-used
counter or backfill by calling the live allocator in arbitrary row order. Archived unknowns remain NULL;
they never compete live and a later authorized Undo allocates normally after cutover admission.
If fresh sequences already exist, their relation to legacy evidence must also be proven; reserving a range
afterwards cannot silently put old state above new state. Fence unresolved owners before first cutover write.

Missing authoritative history is not recoverable by clever SQL. Commerce/Core must decide the minimum
semantic question: what verified legacy state-write order is available, or what explicit owner-confirmed
new writes resolve remaining conflicts? Until then affected canonical state/NOT-state/Continue state
selection stays unready. Native original reads and ordering-independent presence/label/session/holding
queries can ship where their own pin/coverage/disclosure evidence is complete; they cannot silently omit
an unresolved state-dependent branch. Do not make every independent Library operation wait on chronology.

At terminal T, native account fences reject private/unlisted reads and every effect, including delayed
repair. Page children/old/building results, original facts, pin support and shared payload obligations;
remove counter/head metadata last, since fact DELETE hooks can recreate the head. Check terminal state
before each effect and retain minimal completion outside DBOS history. Shared receipts, outbox events,
write-basis and workflow payload need exact producer locators recorded atomically, then store-owner
minimization/acknowledgement. Native row exhaustion alone proves no shared payload erasure.
`db/schema.sql` gives receipt PK `(partition_no,principal_kind,principal_id,command_kind,idempotency_key)`,
outbox PK `(partition_no,position,event_seq)`, and write-basis PK `(partition_no,transaction_id)`.
`command/fence.sql` produces these artifacts together, but not a complete owner-erasure reverse directory.
Work locators must include actual workflow UUID and relevant step/input/output artifact keys; DBOS age-based
`work/retention.ts` deletion is not that directory or a private-payload minimizer. These producers need custody
registration at creation; shared stream checkpoints cannot be erased as though they belonged to one owner.
Preserve only active-PUBLIC completed A at T, never pending B or fresh private evaluation; erase reading
logs/private/unlisted/deleted payload. No legal-hold/custody engine or guessed financial schedule is needed.

## Small independently shippable cuts and required evidence

These are estimates for manager decomposition, each capped at 400 production lines and eight paths;
tests count toward paths, not production lines. `L=services/kernel/src/library`, `T=services/kernel/test/library`,
`M=services/kernel/db/library/migrations`. New names below are proposed files, not real exports.
Every cut must keep its existing native outcome suites; exceeding a cap splits the cut before dispatch.

| Cut | Bounded surface, real anchor and independent proof |
| --- | --- |
| Set sequencing | 300 lines, 6 paths: `L/entries.ts:createEntryCommands.putEntry`, `L/entry-store.ts:{insertEntry,updateEntryState}`, both entry insert/update SQL files, `T/owner-state-order-api.test.ts`, `T/owner-write-sequence.test.ts`. Consume real allocator; this alone never enables complete canonical state. |
| Clear/Undo sequencing | ≤400 lines/≤8 paths per phase: `entries.ts.deleteEntry`, `entry-store.ts.deleteEntry`, delete SQL, proposed retained DAO/SQL and native clear/Undo tests. `entry_deleted` schema exists, but current delete is physical and no Entry Undo export exists. Split archive capture, then restore/CAS, then sequence admission; preserve full outcome requirements at final activation. |
| Directory schema | 250 lines, 3 paths: `M/<timestamp>_owner_directory.sql`, native schema snapshot, new directory schema test. No runtime-ready default. Prove canonical/original unique seeks and private lifecycle keys. |
| One producer at a time | 350 lines, ≤8 paths each: actual entry/session/copy/label writer and its SQL, proposed `L/owner-directory.ts` plus one SQL, producer test and native outcome test. Complete all four before Everything readiness; no partial union advertised. |
| Native predicate indexes | 300 lines, ≤5 paths per family: forward migration, schema, one actual DAO/SQL and native growth test. Start from raw source/active indexes; prove EXISTS/top-one independent of session multiplicity. |
| Pin support | 350 lines, ≤7 paths: proposed support DAO and two SQL files, migration/schema, native support test, existing profile test. Consume `resolveLibraryProfilePin`; first/last support and containing-state digest, no fact witnesses. |
| Selective changes | 350 lines, ≤7 paths per family: migration/schema, actual writer/change hook, proposed private impact DAO/SQL, coverage and growth tests. Anchor `readOwnerFactVersion`; prove unrelated changes do not rebuild settled results. |
| Bootstrap/cutover | 350 lines, ≤7 paths per source: bounded source DAO/SQL, retained frontier/intent, actual registration, native replay and coverage tests. Reuse raw seeks/`pinLegacyFactsPage`; chronology is a separate evidence-gated cut, not pin migration. |
| Generic retained plan | 380 lines, ≤8 paths per phase: proposed owner prepare store/SQL, step adapter, `L/work-module.ts`, quota/expiry SQL and native prepare/replay/growth tests. Wait for reviewed operational-intent and identity producers; no stub-to-ready switch. |
| Continue reader | 350 lines, ≤8 paths: actual route registration, proposed reader/SQL, directory maintenance hook, existing cursor codec consumer, `T/continue-user-cases.test.ts` and growth test. GET writes zero rows, including first visit. |
| Members composition | 380 lines, ≤8 paths per source: `L/collection-source.ts`, actual members route/reader, reviewed generic plan adapter, source/native/dynamic outcome bindings. Preserve curated occurrences and opaque cursor/202 contracts. |
| Liked integration | 250 lines, ≤6 paths after Content receipt: `L/builtin-identity.ts`, actual logical DTO/discovery reader, Content adapter consumer, native Liked/persona tests. Raw stored-ID paging is insufficient for canonical ready pages. |

Full requirements remain `specs/{dynamic-collections,library-profiles,collection-source}-outcomes.test.ts`,
native released-profile/population suites, Continue cases, owner-state-order API and released shared query
cases. Primitive allocator/DAO passes cannot replace them. Required Recipe output is exactly quick,
edge and other-cooked using actual released diet/time/profile IDs; preserve Book/harem/word-count,
same-statement units/qualifiers, saved/OR/NOT and order closure, no-entry negatives and two-release pins.
Use `createReleasedDiscoveryFixture`/`createReleasedLibraryPopulation` actual HTTP producers, not fake drivers.

Freeze adversarial schedules for first/last support, deleted-parent/many-assignment cleanup paused,
millions of sessions on one subject, equal-state new sequence, last-eligible alias loss/restoration,
merge/unmerge with delayed repair, missing pins/heads, epoch restart, first Continue visit, crash after
intent/frontier/effect commits, concurrent owner writes and terminal T with public complete A/pending B.
Include actual personas/scopes and revoked suspended credentials; no fabricated bearer or raw SQL grant.

Measure 64/512/4096 geometric scales and legal larger populations; group size alone is capped at 4096.
Charge raw inputs, current-authority/parent/dependency points, aliases, duplicate/reject/lookahead keys,
full expanded query dependencies, examined/removed rows, buffers, statements, bytes, engine operations,
background work, retries and discarded work. Preserve single-home/single-backend connection ownership:
`database/pool.ts:withConnection` rejects nested checkout; release before foreign home/DBOS/engine calls.
Apply existing direct/ready/step and composed budgets in filtered lists without extra numeric allowances.
Show constant/page-bounded ready work, logarithmic seeks and finite retained preparation; a deadline,
small LIMIT, growing preparation latency or never-ready legal input is not a growth proof.

## External primary evidence and limits

Reused `.reference/library-shelf-maintenance/postgres`, commit
`700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`), read 2026-10-29.
The reference index records reuse. Read source through Git because this clone is sparse:
[nbtsearch.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtsearch.c)
constructs scan boundary keys; [nodeLimit.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeLimit.c)
pulls its child plan, so LIMIT alone says nothing about the child's filtering/sort work. No source was copied.

Official PostgreSQL [ordered indexes](https://www.postgresql.org/docs/18/indexes-ordering.html) support
the matching-order seek recommendation; [combined indexes](https://www.postgresql.org/docs/18/indexes-bitmap-scans.html)
lose index order, so arbitrary Boolean bitmap plans do not prove bounded sorted pages.
[Isolation](https://www.postgresql.org/docs/18/transaction-iso.html) and
[locking](https://www.postgresql.org/docs/18/explicit-locking.html) support same-snapshot reads and transactional
row-lock serialization, not cross-owner permission snapshots. [Licence](https://www.postgresql.org/about/licence/).
The common source pattern is explicit indexed boundaries plus transactionally retained progress/authority;
the directory and selective-change recommendations are deductions for this repository's adopted semantics.

Report-presence acceptance establishes this evidence artifact only. No runtime/API, database, engine,
provider or growth acceptance was executed or inferred; missing producer boundaries above remain explicit.
