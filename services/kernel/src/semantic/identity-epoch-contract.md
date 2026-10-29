# Native identity publication contract

This is the sole owning specification for concurrent identity admission, publication and native cutover.
[Canonical lists](../../../../docs/filtered-lists.md#canonical-identity-and-personal-references) own list semantics;
[Library owner queries](../../../../docs/library-owner-queries.md) own structural private support;
[private follow counts](../../../../docs/private-follow-counts.md) own private contributions and counts.
This document adopts scoped concurrent publication. It is **not a formatted-byte freeze, Cost confirmation,
type delivery, runtime delivery, publication completion or root-gate completion**. Performance must confirm all
nine review items and all coowners must review these corrected bytes before types or executable native work.
P remains symbolic until the capacity owner adopts it. No new numeric budget is selected here.

The adjacent `identity-epoch-contract.ts` and existing native fixtures describe a superseded globally serialized
proposal. In particular, one `controlPartition`, one pending `readEpoch` and its sole-job admission sketch do not
fit this contract unchanged. Existing native cases remain evidence and required outcomes; they are not the new
frozen boundary. Missing producers below mean actual missing native implementation and proof, never permission
to manufacture a callable, receipt, ready state or successful adapter from this prose.

## Invariants

A permanent catalogue original is never reused. Creation requires actual Global `subject:create`, import batch
authority where applicable and native revision 1, independently of Search. Only duplicate identity is mergeable;
editions, translations and formats keep separate identities and relations. Published redirects are direct to an
active terminal; a requested larger-UUID survivor is legal. Stored personal originals, occurrence IDs, notes,
dates, order, multiplicity and accepting pins are preserved. Only derived mappings and canonical indexes rekey.

Merge, unmerge, repoint, account-agent verification and reversal use the same native job mechanism. Changed
**disjoint group sets run concurrently**. Pending claims and capacity are partitioned by changed groups, with a
fixed per-partition cap P. `identity_epoch_busy` means overlapping groups only, including a PREPARING claim.
Local capacity or reclamation pressure is retryable local unavailability, not overlap and not a global lock.
No sole pending job, whole-job global lock, global active marker or universal read-page gate is allowed.

Each resulting group has at most **4096 originals**, counting terminal/self and all unselected members, counting
overlap once. Missing, incomplete, moved, retired or unsealed evidence is unavailable, never zero or self.
Initial `409 identity_group_overflow` at 4097 precedes ALL new Semantic effects: job, binding history, claim,
capacity slot, control, epoch allocation, receipt, outbox, revision, mapping, participant and reader revision.
Safe preparation is durable recovery work; later drift, capacity loss, cancellation or RPC uncertainty cannot be
relabelled effect-free overflow or `not_applied`. Replay always retains the same original intent and receipt.

A crash resumes retained native frontiers. Leases, timeouts, elapsed time, ordinary projection checkpoints and
failed I/O cannot publish or erase work. Publication requires exact native mapping custody and both fixed
version-1 identity participants, `search-canonical-index` and `library-private-follow-counts`. Source export,
local completion, function return and overall account erasure are different boundaries. Every prior withdrawal,
addition and fence must have receiving native custody before its owning participant can ACK.

Current ORIGINAL and terminal privacy are independent of identity metadata. A public terminal cannot launder a
hidden original; neither mapping nor a job receipt grants Access or SourceAccess. Complete excluded/NOT/order
and FOREIGN physical-query safety remain required before enumeration. No anonymous downgrade, permission
certificate, per-ID positive sample, new cursor vector/cryptography or replacement query engine is introduced.

## Existing caller compatibility

`merges.ts` exports `mergeSubjects(pool, options)` with subjects, optional survivor, actual AccountActor,
idempotencyKey, Uint8Array digest, `{digest, release: Release}`, CommandAuthorization and optional deadline/clock.
Its completed native fields remain `{survivor, redirected, revision, component}` with component
`{partition: number, epoch: number, position: bigint}`. `mergeSubjectsInCommand` shares revision/redirect work
with verification; that effect helper is not concurrent job admission. Native bigint JSON is canonical decimal
text, never Number. Native transactionId AND component identify effects; a noEffect position can be reused.

`ensureAccountAgent(pool, {account, kind, name, language?})` keeps `{subject, created}`. Deterministic
`accountAgentId(account)` and person/organization/software creation rules remain. `verifyAccountAgent(pool,
{account, catalogue, receipt})` and `unverifyAccountAgent(pool, {account, receipt})` keep exactly
`{survivor, redirected, revision, subject: Item, component}`. Every successful path, including already-verified
same-receipt and reversal replay, waits for its actual job publication. Current catalogue revision/component on
replay need not equal the historic response byte for byte. Matching Person/Organization, catalogue survivor,
reciprocal backlink, verification receipt and software rejection remain unchanged. Reversal restores only exact
verification-scoped moved links, including Context/filter identity, and preserves unrelated subsequent facts.

Ordinary merge keeps `POST /v1/subjects:merge`, body `{subjects: [id, id]}`, actual Global `subject:merge` via
`authorizeSemanticWrite`/`globalContextAnchor`, quoted structured-field Idempotency-Key and current anchor checks.
Only ACTUAL ADMISSION returns `202 {operation: {id}}` and
`Location: /v1/subjectIdentityOperations/{id}`. PREPARING alone is not a 202. Lost response or request deadline
retains durable preparation/admission and replay recovery; it cannot create a second operation or claim no effect.
Authorized identical replay returns the same operation/Location after publication too. Different body under the
same key remains `422 idempotency_conflict`. Authorization precedes receipt lookup, including replay.

`GET /v1/subjectIdentityOperations/{id}` reauthorizes CURRENT native merge authority and original/terminal
visibility. Unknown and denied are the same concealed `404 not_found`, without result or session component.
Authorized responses remain `200 {operation: {id, done: false}}` or, only after durable publication,
`200 {operation: {id, done: true, result: {survivor, redirected, revision}}}`. No participant/frontier/vector leaks.
Existing deadlines, evidence TTL and Problem effect_status vocabulary remain unchanged. Recovery is through the
original locator/receipt; no fake successful completion or new public cancellation protocol is added.

Actual suspension revokes pre-suspension bearers: held-token requests return `401 invalid_credentials` with
`WWW-Authenticate: Bearer error="invalid_token"`. Invalid required credentials never become anonymous. Auth
cannot mint a valid suspended bearer; correct-password suspended sign-in is `403 {"error":"account_suspended"}` without a
session. Kernel `403 account_suspended` remains defensive only. Native suspension is the revocation producer;
SQL token/account fabrication is not acceptance evidence.

`runCommand` authorizes before readReceipt and exposes currentCommand only on the live transaction. Do not
serialize that binding as permission. Admitted immutable internal work resumes its persisted job and native
home fences, not a fabricated user. Existing platform verify/reversal requires `currentCommand(tx).basis === null`;
this is a specific owner path, not a generic actor bypass. User response replay still reauthorizes. Account and
follow effects retain active/terminal account locks independently of identity publication.

## Concurrent control and coherent admission

### Immutable cut before any new effect

Resolve the at-most-two input groups to immutable, non-ABA current generation/source versions and exact counts.
Perform an effects-free double collection: capture EVERY input header/source version, then validate EVERY captured
version remains current, ready and under the same native owner/generation. A common cut lies between last capture
and first validation when all versions match. A version cannot return to an earlier value after a change. A
single mixed read is insufficient: moving an original can expose a new 2048 count with an old 2049 count even
when the coherent union is 4096. Immutable data alone does not make differently timed current pointers coherent.

Use that coherent cut and constant transform to check EVERY resulting cardinality, including split/repoint and
undo's explicit restored original. Shared generation references collapse once. No caller original vector,
privacy-filtered member count, whole-group scan or generated input copy precedes this check. Missing bootstrap or
source custody is unavailable. Overflow snapshots include ALL installed tables, indexes' logical inputs and
partition state, including new history/job/claim/slot/generation/scope/revision/effect/ACK/wakeup records; existing
legacy subject/revision/redirect/member/receipt/outbox snapshots alone cannot prove this boundary.

After the check, prepare with durable immutable input references and a constant transform. Claims later revalidate
those exact versions before admission. Drift after safe preparation follows native cancellation/recovery of that
attempt; a new coherent attempt keeps the original binding. An Accounts decision/reversal source intent already
committed in its native transaction is not a new Semantic admission effect and is never erased by overflow.

### Receipt history, ordered capacity and P=1 progress

The stable original receipt-to-job binding is compact indexed **HISTORY**. It binds original receipt, normalized
intent digest, immutable job/attempt home and replay disposition, with account-role locators and native cleanup
custody. It is not a free full job, hidden input generation, group snapshot, claim or unbounded active-control
slot. Its retained bytes/indexes belong to H under existing receipt/erasure policy. Retain the minimal immutable
binding needed for replay after full job minimization; cleanup cannot let the same original receipt mint a new job.

For an immutable attempt, order all planned control resources deterministically by native partition and key,
INCLUDING job home. Changed group control homes come from their actual source/current-group bases (incarnation, immutable generation,
monotone version and native owner epoch), not from a currently visible representative. The actual job home is the
FIRST ordered resource. Do not reserve an arbitrary receipt-hash
home out of order. The compact binding can be established only after cap validation; its unique native CAS
selects the one attempt/home before remote delivery. A full job, claim, full copy and slot are charged where
physically stored, even when another home retains a locator. Acquisition at the first resource reserves local
P-capacity and the job there atomically; later acquisitions proceed strictly in order. At every home, native
partition-owner fence, attempt lock, capacity counter/unique slot and group overlap predicate are checked in the
same transaction as the claim. A read followed by an unlocked insert is insufficient.

Crash before first acquisition: lookup binding, then indexed native job/attempt state; absent acquisition resumes
at the same first resource. Crash after sending a remote acquire: lookup that same binding/job, retain the uncertain
planned home, and reconcile the exact attempt there. Do not allocate a replacement job because an RPC result was
lost. Binding history cannot certify that remote admission occurred, and mapping cannot query remote admission.

At P=1, a blocked attempt holds only resources lower than the next one it awaits. Every wait-for edge strictly
increases this total order, including job homes, so a finite cycle is impossible. The highest held resource has no
lower successor to wait on; with fair bounded native scheduling and eventual available owners it completes or
cancels and releases, inductively enabling lower attempts. Native slot checks/fences/locks must realize those
edges. A long unavailable owner may pause its dependent attempts, not disjoint partitions. No lease expiry,
timing luck or repeated try/unwind is the liveness proof. Cancellation and reclamation allocate no new slot and
must be runnable while capacity is full. Native schedules must prove both the ordering and those reserve-free paths.

### Admission versus cancellation, including uncertain delivery

PREPARING is affected pending and overlap-busy from its first native claim. The job retains EVERY planned home,
not only successful responses. At each planned home, delayed acquire and cancellation serialize on the SAME
native attempt lock, including first absence (unique insertion plus locked recheck). Cancellation installs an
irreversible closed-attempt fence even if no claim exists yet. An uncertain RPC cannot remove a home from this set.
The retained native job-home CAS selects exactly one disposition: admitted or cancelling. Admission consumes exact
native claim receipts and revalidated source versions; cancellation closes every planned home and reconciles
receipts/slots before releasing custody. Admitted work cannot be cancelled by a stale delivery. Delayed acquisition
cannot resurrect a closed attempt. No new attempt overlaps the old one's uncertain claims without that proof.

The admitted record atomically binds immutable intent, inputs, affected pending descriptor, native receipt and
wakeup. That descriptor is authoritative before home gates or participants run; it need not materialize 4096 rows
in admission. Initial capacity failure with no committed preparation remains retryable; once any preparation has
committed, disposition and cleanup are durable recovery work. No failed step discards retained generations.

### One current mapping route per original

The actual source mapping/birth basis names ONE relevant current control home per original. Routing is not a
terminal hash guess, all previous homes, a history traversal or remote admission query. A route handoff keeps old
routing pending/unavailable until the new current basis and native custody can be installed coherently. Missing,
moved or retired source/control state is unavailable, never a fresh self mapping. Birth has exact same-transaction
self evidence at its source home; absent Search is irrelevant. Unaffected points continue during disjoint jobs.

An affected original observes its pending immutable descriptor from the relevant home, including PREPARING.
Mapping reads no ancestor generations and exposes no Access. An admission after a released source snapshot must
be caught by the control cut; publication/newer pending before final validation must invalidate stale success.
Native same-backend and cross-backend observation costs are derived below.

## Scoped reader publication and complete query dependencies

### Source scope is an owner plan, not returned hits

Use ACTUAL native plan keys and observations. Library's existing Collection header has `(route,collectionId)`,
incarnation, sourceGeneration, revision, listing stamp, accepted release/profile/state pins and factFence;
its raw ranges are stored-original keysets. The existing Source observation additionally binds normalized query,
order, projection and accepted meaning. Scope those observations to their actual authority/population and COMPLETE
expanded query. Expand saved filters before gathering dependencies, including false/excluded originals, NOT,
order-only originals, membership, labels/parents, pins/meaning, identity support and public/FOREIGN dependencies.
One candidate's returned positive witness is not complete-query evidence. A broad catalogue plan can genuinely
depend on all groups; that cannot impose its barrier on an unrelated finite owner source.

Library's adopted structural plan has ONE candidate per `(owner,canonical)` and structural `(original,scope)`
existence/extrema, with inverse `(original,owner,scope)` access. Scope dimensions follow accepted family/profile/
lifecycle/label/state/holding and order meaning; facts remain native. A million sessions for the same original,
profile and lifecycle cannot make a million directory rows. Native session/copy/fact indexes find extrema and the
next surviving top after withdrawal. No per-fact witness/copy, membership mirror or required legacy
`canonical_source_fact` write is the directory proof. That existing table is physical inventory only.

### Required registration, arm and finish protocol

A ready scope must first establish full dependency registration under the SAME native source mutation frontier
and owner/generation as its observation. Bounded bootstrap scans the source population, including excluded/order
support, while native indexed OLD/NEW dirty capture retains changes behind the frontier. Registration is not ready
until captured work and a final writer fence close the scan. Source edits atomically update structural registration
or retain exact bounded repair work and invalidate readiness. A plain broad `readOwnerFactVersion` mutation alarm
cannot certify that this registration is complete. No silent full-source scan moves into a public request.

The two existing batched page probes must observe an affected pending claim/arm even before asynchronous
source-summary delivery. A source cannot remain readable with an old clean summary during that gap. The actual
owner plan must bind its complete registered dependency cut to those probes and native registration frontier,
without enumerating dependencies on the page. Closing that gap within existing SQL/row allowances is a REQUIRED
missing native producer proof, not a claimed consequence of an eventually delivered summary. If an actual plan
cannot do so, its native case stays red; prose cannot turn a mutation version into a complete observation.

Jobs discover affected scopes through the native inverse dependency index. Scope registration racing a claim
must handshake with that claim under the source/attempt fence: either the registered scope is included in arm
custody, or registration stays unready until it consumes the job's current mapping/publication. Before canonical
effects for a scope, its affected partition summary must durably ARM that exact job/attempt/version, with native
source ownership and receiving custody. A first registration cannot slip between discovery and effects. Fanout
to many scopes is retained bounded work, not synchronous admission enumeration or uncharged per-page SQL.

Each partition summary is keyed by actual scope and native source incarnation. It carries a COMMITTED SCOPED
reader revision and truthful active/repair state. Arm/finish messages have exact native receipt custody; duplicate
and delayed delivery compare immutable attempt identity under the same fence as cancellation. Finish is accepted
only after all scope-specific OLD withdrawal, NEW addition, first-apply, source handoff and participant effects
are in custody. A cancelled attempt cannot arm later or publish a source change. A published lower-numbered job
finishing after a higher one must still advance the committed scope revision: `max(allocated epoch)` loses that
change. A cancellation after a higher publication cannot regress the revision or overwrite active state.

The existing source observation must consume these partition summaries through retained, indexed repair and a
native source-local publication CAS. A new accepted summary advances the source's COMMITTED scoped scalar revision
and retains pending work until all covered dependencies are current; it does not copy a per-job global history.
That CAS is local to the actual source, not a source-wide catalogue marker. Reordered messages are compared by
committed summary version and exact custody, never job allocation order. Replacing a summary must preserve
unfinished arm/finish obligations until the receiver durably covers them. Registration retirement, source moves
and cursor expiry release refs only after exact receiving custody. Unknown summaries keep that source unavailable.

At page start, validate current source authority/incarnation/query/order/pins and a clean committed scoped reader
revision using the existing observation. At final page validation compare the SAME complete basis and revision;
any intervening relevant arm/finish/repair invalidates it even if the source is clean again. A continuation is
current only against that source's current clean observation. Existing opaque cursor signing binds that scalar
basis; no new vector/crypto is selected. Continuous disjoint jobs cannot change it. For finite unchanged owner
input and eventual successful I/O/fair work, relevant preparation settles and useful pages continue. Global active
count gating fails this progress condition, even if each individual job is finite.

### Exact missing native bindings and required red boundaries

The protocol above is an owner obligation, not an invented exported interface. The following actual sources do
NOT yet supply complete scoped observations or registration/summary custody:

| Owner and actual source                                                      | Delivered evidence                                                | Required native boundary before readiness                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library `collection-source.ts:createCollectionSource`                        | Source shape/observations; methods return unavailable             | Complete admitted native prepare/prefix/containsSubject/readRawStoredPrefix binding for structural owner and Collection plans, including false/NOT/order dependencies |
| Library `collection-source-native.ts` and its header/members/facts/probe SQL | Actual header, stored-original ranges and bounded points          | Structural inverse directory, first registration/fence, source-local scoped summary consumption and final coherent observation                                        |
| Library `owner-fact-version.ts:readOwnerFactVersion`                         | Indexed account-home mutation version                             | Complete dependency capture/registration and summary custody; broad mutation alarm alone is insufficient                                                              |
| Search `scope-source.ts`                                                     | Admission scaffolding, unavailable native prepare/prefix/evaluate | Complete native canonical Source and physical namespace/source authorization, including negative/excluded/order population                                            |
| Search `source.ts:SubjectSource`, Semantic `search-source.ts:subjectSource`  | Subject chunks/snapshots and bounded facet samples/probes         | Complete scoped producer observation and native canonical-index participant, not sampled returned IDs                                                                 |
| Semantic native STORE/mapping                                                | Superseded types and missing producers                            | Current-route/control fences, ordered capacity, attempt closure, registration handshake, native committed partition summaries and receipt reconciliation              |

Search's actual `searchWorkModule -> startSearchIndexing -> createSubjectIndexer`, subjectIndexName/subjectAlias,
per-generation subjectConsumer, 256-ID chunks and `refresh: wait_for` bulk precede ordinary checkpoints. They do
not supply complete canonical/negative-query observation or SourceAccess. Native namespace/query admission must
prevent FOREIGN private lookup before engine work; current original/terminal admission and privacy-reduction
ACKs remain independent. Full Search/Library publication cannot be proved by producer-focused missing-capability
cases. Each missing row needs an owner-native red case and actual SQL/engine binding, before types/runtime; Root's
scoped ruling supplies none of those exports. It selects this boundary rather than freezing the old global types.

## Native effects and fixed participant custody

A native effect checks and locks job/original/destination mapping gate in the SAME home transaction as the write.
Global pre-read is insufficient. Installation serializes against legitimate old-epoch first apply: if apply commits
first, include its effect in retained rekey input; if gate installs first, reject/redrive that apply atomically.
Wrong destination, native transaction, scope, owner or obsolete epoch rejects. Release each home before visiting
another home or engine. Persist cross-home OLD withdrawal/NEW addition intent and both receipts; neither half
can disappear at an empty frontier. A stale delivery rereads current source, account eligibility and mapping.

Mapping work covers direct redirect/revision/account backlink and indexed member/link maintenance. Existing
`moveMergePage` links/outbound/members/done phases and `reverseAccountAgentLinks` provenance are behavior evidence,
not this protocol's publication condition. Retain bounded frontiers instead of synchronous degree exhaustion.
Affected changes keyset-merge at most two flat immutable streams plus constant exceptions, with one shared durable
step allowance including overlap, duplicates, lookahead, rereads and retries. Never fetch the full allowance from
each stream or inspect row 101 free. Equal keys are consumed together; exact before/after includes terminal/self,
split/repoint and explicit restored original. No personal reference becomes a move input.

At first absence the native gate/guard uses at most one indexed handoff-state probe/write in the effect
transaction, with native unique insertion/locked recheck. A lock-timeout or skipped row is contention, not proof
that capacity is full or an effect is complete. Capture that work and any trigger/index/FK work in native Cost.

Each producer atomically commits its effect/frontier/native receipt and exact job/version/scope completion
observation. After releasing the home, control resolves that ACTUAL record by transactionId AND component and
takes receiving custody. Lost ACK redelivers the same receipt. Receipt or function `complete` alone is not proof.
No arbitrary callbacks, caller booleans, request-selected participant or default noData ACK is legal.

### Complete Library canonical coverage under the fixed participant

The SAME version-1 `library-private-follow-counts` identity participant covers every canonical directory,
candidate, support, first-apply registration, follow, total, pending/published fence and prior-effect custody.
All six member, entry, label, session, copy and output drivers are included, with working/ready bases, accepted
meaning and exhaustion evidence. Owner state chooses the highest live native `entry.owner_write_seq`, preserves
conflicts, unions labels and keeps sessions/copies distinct. That sequence increments in the SAME successful
set/clear/Undo transaction; Undo is a new write despite historic dates. The actual Commerce sequence/schema/helper
producer remains missing; timestamps, UUIDs, type_source_position, per-slot revisions or invented legacy ordering
cannot substitute. Clear and replay retain their native meaning.

Directory discovery is structural `(original,scope)` existence/extrema, not one locator per fact. It covers never-
positive first apply and hidden/excluded/order support too. Its EOF requires drained native registrations and
custodied OLD/NEW work. Follow support is per `(canonical target,follower)`; totals change at 0-to-1/1-to-0 only.
Derived pairs/support/totals live in target home, stored follows in source owner home. Current account terminal
fences remain separate. Actual follow ACK with directory incomplete MUST refuse publication; an interrupted legacy
canonical_source_fact insert without a follow ACK does not establish this negative. No third identity participant,
follow-only ACK or transfer to the Library A5 erasure participant is allowed.

The final coordinator composes native STORE/mapping and these TWO fixed producers, reconciles native custody and
publishes once. Existing WorkModule.register/WorkContext.addEffects, DBOS registerStep/registerWorkflow,
WorkClient.enqueue stable job workflow ID with return-existing, composeWork, KERNEL_WORK_MODULES and startWorker
own launch/lifecycle. No second scheduler/engine. STORE/mapping depend on native primitives; producers depend on
STORE; final composition imports producers. Neither producer waits for/imports the coordinator. Caller handoff
comes last. Actual revised exports/signatures remain unfrozen until Cost confirmation.

## Native cutover adoption

All 4096 native partition homes, including empty and unselected homes, require actual scheduler/bootstrap closure
and native owner epochs; each has sixteen routes. Fixture seeding is before final guards. `readEpoch` is not an
implicit scheduler, preset bootstrapReady is not proof, and an unsealed bootstrap group is not G=0/free storage.
Birth initialization, source capture, OLD/NEW dirty export, native custody and deferred writer guard are required
in the actual owners. The following actual writer inventory retains native source bindings.

- `subject.ts:createSubject -> writeSubject`: actual current Global `subject:create`, authored installation and
  native source fences remain in force. Bind `initializeSubject` after actual revision-1 insertion; same executor
  transaction ID binds revision, subject and creation evidence. An action string alone is insufficient authority.
- `bulk.ts:batchCommand` create/import: shared `writeSubject` binds actual new births. Preserve batch authorization,
  Global creation authority, source fence, tuple claim and receipt replay. A preexisting claimed tuple is not a birth.
  A failed claim, source fence or later native command fence rolls back self initialization too.
- `account-agents.ts:ensureAccountAgent -> ensureInTransaction`: BOTH named (`writeSubject`) and unnamed
  (`createUnlabeledAgent` direct `create-subject.sql`/`create-revision.sql`) paths, for person AND organization,
  bind actual deterministic `accountAgentId`, kind, account and existing platform creation command. Software retains
  its current definition/kind constraints. Native platform creation is a specific existing owner path, not arbitrary
  `basis === null` permission. No generic actor bypass or new action is introduced.

Birth hooks retain `test/access/growth-commands.test.ts`, `Account and organization creation stays within its bound as A grows`.
That case does not call `ensureAccountAgent`. Its actual birth coverage is
`test/access/growth-account-agent-effect.test.ts`, `account agent effect growth stays within its bound at [256, 1024, 4096]`,
for named and unnamed person, organization and software. Verification/unverification additionally retain
`test/access/growth-agent-verification.test.ts`. None substitutes for another or changes an existing bound.
Ordinary and imported subjects initialize at the SUBJECT SOURCE HOME, not their creator account home;
account-agent/account births use the account home. Birth and revision-1 initialization roll back together.

Every structural mutation and continuation below is in final writer coverage. Capture the logical source keys for
INSERT, DELETE and BOTH OLD/NEW keys for key-changing UPDATE, retaining negative/tombstone evidence after deletion:

- `merges.ts:mergeSubjectsInCommand`: `merges-insert-revision.sql`, `update-subject-release.sql`, subject counts,
  `merges-insert-redirect.sql`, projection-pending state and emitted `SUBJECT_MERGED` effects, for both ordinary
  merge and verification. A larger requested survivor remains legal; direct latest terminal replaces UUID preference.
- `account-agents.ts:verifyAccountAgent`: merge plus `account-agent-subject-verify.sql` reciprocal backlink changes;
  already-verified/same-receipt `existingVerification` also waits on the same published job.
- `merge-moves.ts:register` and `moveMergePage`: `merge-moves-insert-member.sql`,
  `merge-moves-insert-redirect.sql`, `merge-moves-update-member.sql`, links/outbound/members/done phase changes,
  inbound/outbound withdrawals and additions, source projection clear and verification moved-link ledger.
  `links.ts:linkProjection/applyLinkBatch` deliveries of old `SUBJECT_MERGED` and `LINKS_MOVING` are writers too.
- `account-agents.ts:unverifyAccountAgent`: `account-agent-unverify-revision.sql`,
  `account-agent-subject-unverify.sql`, `account-agent-delete-redirect.sql`, `account-agent-delete-member.sql`,
  release/count/backlink restoration and replay through `account-agent-read-revocation.sql`.
- `merge-moves.ts:reverseAccountAgentLinks`: saved provenance pages from `account-agent-reversal-page.sql`,
  node-home restoration and survivor-home `account-agent-reversal-delete-links.sql` cleanup. Preserve exact
  verification receipt/account/survivor/movedFrom/Context/property/source/statement/filter keys, current facts and
  security state. Replace synchronous exhaustion with retained bounded native work; do not adopt its planner pins.
- All direct structural SQL affecting subject identity, redirect, membership or account-agent backlinks participates,
  including account-agent creation/backlink insertion and deletions by lifecycle work. OLD home/key removal and NEW
  home/key insertion have separate capture/custody; phase-only updates retain unfinished work without recounting
  the original. A source-account terminal fence remains independently necessary for follow/support effects.

Old DML before the home barrier either commits under installed capture and is drained, or rolls back. At final real
handoff each native home updates its barrier and enforces a deferred same-TX guard on structural tables. The guard
requires the actual same-TX scoped effect/creation record and executor native receipt; a SQL XID may connect rows
inside that transaction but is not the durable receipt. A transaction that wrote before handoff but commits later
must conflict/retry or satisfy the deferred final invariant. Queued old relay/move/reversal work is drained or its
EXACT unfinished manifest is transferred to new native durable work. A saved half withdrawal/addition may never
vanish behind an empty member page. Guard refusal is retryable unavailable or durable redrive, NEVER a verification
or reversal denial. No process attestation, generic setter or global read grants an effect.

### Complete topology, export, custody and closure

The scheduler uses existing Semantic WorkModule/outbox/DBOS infrastructure and the fixed partition topology
**0 through 4095**, each with sixteen routes. Persist indexed topology slots and a bounded enumeration frontier;
visit empty homes as well as nonempty ones. Each slot binds actual native owner epoch and writer generation.
A missing/fenced/moved owner does not constitute empty coverage. A move transfers pages, fences, native receipts
and unfinished obligations under actual native custody or invalidates that slot until reestablished; it cannot
reuse an old owner cut. The actual move-transfer/scheduler callable is MISSING and must be supplied by its owner.

Per home, seek subjects `(route,subject_id)` then members `(route,subject_id,member_id)` using native indexes.
Resolve latest redirects through retained bounded terminal-closure work, including self, cycles, deleted targets
and missing owners. A one-hop `coalesce` or smallest UUID is not closure. Unique original membership counts once,
including terminal/self; duplicate member/move evidence is unfinished work, not another original. Install actual
legacy local mappings with captured revision comparison before claiming mapping coverage.

Capture installation precedes the base snapshot under native DDL locking. Lower-key births/updates/deletions after
the scan enter coalescing dirty heads keyed by `(route,original)` and `(route,terminal,original)`. Dirty drains start
at the beginning of the pending index each time, never behind a permanent `after` cursor. Bound raw keys BEFORE
filters, include lookahead/overlap/retries, and save captured head h with the source page, frontier and exact native
receipt. A page has three separate states:

1. **Exported:** source page/payload/native receipt is durable. It remains unacknowledged source work.
2. **Custodied:** after source release, a control native command has validated owner, generation, page, exact
   transaction ID plus component and taken complete durable page custody. Duplicate delivery verifies that SAME
   identity/payload and changes counts/frontier once. Only now may the source ACK run.
3. **Published:** complete all-home closure plus mapping and all fixed participant custody permits the structural
   publication. Source export or control custody alone does not publish a job.

After actual control custody, a separate source command ACKs ONLY the captured h with the current-head predicate.
A concurrently advanced h+1 remains pending. A crash source-commit -> control-custody, or control-custody -> source-ACK,
redelivers the same retained page/receipt and then that exact ACK. No next frontier/closure skips an unacknowledged
export. A replayed saved empty page proves only its captured generation; it cannot close a newer dirty head or new
writer generation. Closure binds exhausted base/member frontiers, drained captured heads, all exports in custody,
complete unfinished old work, installed mapping and native barrier/owner epoch. Reduce exact coverage incrementally
across all 4096 slots, decrementing once per validated slot; a zero counter alone is not proof.

Post-conversion births continue source-locally with exact self evidence. They need not keep a finite legacy drain
permanently open. Structural admission on a new original waits for actual enrollment custody and never guesses a
singleton from a missing control row. Current mapping observation does not wait for list/preparation/publication.

### Flat generations, retention and local reclaim

For each partition q, let Gq and Aq be its current groups and originals. At EVERY durable/crash/replay/abandon step,
full generations are at most **Gq + 4P**, and physically retained memberships at most **Aq + 4P·4096**. Count actual
physical home, not logical job locator. Bootstrap uses actual native source group/original counts for Gq/Aq, never only the count of already sealed
new headers. Source legacy memberships, their retained exports and new shadow rows are included in the physical
copy ledger before each allocation. A bootstrap that cannot reserve the next bounded copy must reclaim or pause
locally; bootstrapReady does not excuse storage. Current groups share unchanged flat generations; each charged attempt
needs at most two retained inputs and two outputs. Current inputs are not double-counted as extra until retired.
Merge reduces G by one, split increases it by one and repoint changes at most two groups; former current inputs
then consume the reserved extra allowance. Birth increases actual G/A with its singleton. Allocation reserves
against the post-transition bound before writing; no fifth copy or allocation-on-retry is possible.

The allowance includes bootstrap, unsealed/partially built output, source export, retained input, abandoned work,
partially deleted generations and ALL physically retained copies on source and destination. A full export copy
consumes that allowance too; reuse/ref/chunk custody must be proved, not hidden as R or L. General physical owner
transfer still lacks an actual bounded custody/memory/storage producer: keep it a named missing boundary until
native copy reservation and one-connection bounded streaming prove the same bound on BOTH homes through failure.
No transfer exception, hidden generation or full-group workflow JSON is accepted.

At a partition with unreclaimed retired or abandoned full copy, do not admit a NEW local attempt until that copy's
native empty-range proof commits. Existing P charged attempts recover/cancel/reclaim under their reservations;
reclamation needs no new slot. Other partitions admit and progress independently. Publication does not abandon
retained reclaim work on its fast path. Repeated jobs at fixed A/G cannot accumulate full-generation history.

Before retirement, minimize every live undo, reversal, move, replay, consumer and cursor reference into exact
native bounded scope/effect records with receiving-owner custody. Unmerge retains its explicit original and prior
before/after terminals, not an arbitrary historical group. Verification reversal retains exact moved-link ledger
Context/property/source/statement/filter provenance. Consumers finish or accept minimal remaining obligations;
no callable full-generation reader survives as an allegedly minimized locator. R live obligations and L effect
keys are history-proportional storage, as H receipts are, not constant space or a disguised group archive.

Reference acquire and reclaim share the SAME native generation lock. A reclaimable generation is noncurrent,
not prepared/active input, published or durably abandonment-fenced, with completed native minimizer custody and
indexed zero live references. Missing locator/minimizer blocks reclaim. Bounded keyset deletion commits frontier,
receipt and wakeup together. Child membership precedes header removal; final indexed empty-range proof and zero
refs occur under that same lock. Saved empty replay cannot close a newer generation or race a new ref. Before
commit a crash changes nothing; after commit it resumes exact progress. Delete.rowCount is not physical proof:
assert native table counts and relation/index size deltas through partial deletion/MVCC retention too.

## Accounts source intent and workflow boundary

Access owns an immutable-except-erasure account-HOME intent TABLE keyed exactly
`(route, account_id, direction, receipt_id)`. It is separate from Core operational delivery. Verification records
it in `recordPendingAgentVerification`, reversal in `commitReversal`, in the ORIGINAL native decision/reversal
transaction with its ORIGINAL receipt. Canonical Semantic key is UTF-8 JSON `[direction,accountId,receiptId]`,
using exact native UUID values: verify receiptId is the original decision transactionId; reversal receiptId
is the original reversal command transactionId. Indexed role-first account_id/requested_by/decided_by access supports actual erasure;
this means actual account-role indexes, not a new generic relation table or mutable pending fields as history.

Verify direction `account-agent.verify` retains deterministic agent/account/kind/catalogue, requestId/requestedBy,
Global `(route=0,request_id,decision_receipt_id)` native decision locator, pending-account receipt, accepted release,
source owner epoch, native transactionId/component, normalized digest and delivery custody/job locator. Reversal
`account-agent.unverify` retains receiptId, verificationReceipt, catalogue, requestedBy, released/revoked/reason
disposition, native reversal locator and prior published undoJob. Source intent custody precedes admission and
must survive pending state replacement. Existing `mergeVerifiedAgent` forwards exact native Semantic inputs;
`unmergeVerifiedAgent` compares pending receipt/catalogue to avoid undoing newer review. Those checks remain, but
are not immutable old-delivery custody. Actual source record/delivery binding is still missing.

The SAME Accounts workflow performs bounded delivery/admission steps, then bounded indexed native published-state
probes and durable `DBOS.sleep` OUTSIDE a step, before existing approval/page write/finish or removal/reversal finish/
pending clear. No worker or transaction is held through an outage, and no new queue, permission, DTO or public poll
protocol is introduced. DBOS callback-before-result journalling requires same-receipt replay after effects commit.
Busy/overlap, local capacity, guarded handoff or source unavailability retry the SAME intent/receipt with backoff;
they never become denied review or AccountAgentVerificationError. Success requires actual publication, not a
redirect revision or fake readiness. The exact owner-native polling/sleep composition remains required delivery.

Core OP is the delivered `command/operational.ts:runOperationalTransaction` and `enqueueIntent` (5b5c3be17ea1).
Use that actual live transaction, fenced account set and DBOS enqueueInTransaction; no invented Core intent table,
receipt, event, outbox, write-basis, component position or relay. Access owns its verification/reversal intent,
Accounts shared-history owns operational DBOS history, and Library A5 owns derived Library data. Access does not
own Core operational records or Library payload. The no-intent-table statement applies ONLY to Core OP.

## Terminal erasure and custody inventory

Amend the EXISTING Semantic/Access inventories under existing erasure policy; no new participant or retention
policy. Semantic owns its physical job/binding/attempt/claim/slot, source capture heads/tombstones/export payload,
topology/frontier/legacy manifest, flat input/output membership, mapping gates/effects, scope registration/inverse
keys/partition summaries/repair custody, native completion/ACK, minimized reference/reversal/reclaim records.
For EACH new store native delivery must bind its actual owner, key, indexed account roles, own minimizer and
shared receiving custody before that owner can ACK.
Requester, operator, reviewed account, source author and acting human are all roles, not just primary account ID.
Source keys are route/original/terminal/head/page/native transaction; control keys include home/job/attempt/version/
scope/generation/effect; effect keys include destination/original/job/step/native transaction. Missing concrete
new schema/role index/minimizer is an explicit unfinished producer obligation, not `none`.

Library owns candidate `(owner,canonical)`, structural `(original,scope)` support/extrema, six native driver payloads,
first-apply work, OLD/NEW rekey and follow/support/totals/fences and their native minimizers. Semantic retains exact
Library cleanup/custody locators; exhausting Semantic refs cannot certify Library purge. Access owns intent key
`(route,account_id,direction,receipt_id)`, its role indexes, native Global decision and account-home reversal/pending
locators. Shared receipt/outbox/editorial write-basis and DBOS copies require the ACTUAL shared owner's minimizer
ACK, not dispatch. Operational DBOS history belongs to shared-history; no nonexistent Core OP record is inventoried.

Use the delivered account terminal T, account locator fence/registration, `recordLateErasureItem`,
`resolveLateErasureItem`, `acknowledgeErasure`, `advanceErasureCompletion`, `readErasureStatus` and erasureWorkModule.
A participant's own ACK follows its own exhausted locators and receiving cleanup custody; it does NOT wait for
overall frontier/all other ACKs (a cycle). OVERALL completion separately requires effects frontier, no open late
items and ALL fixed A5 ACKs. Late items arriving behind enumeration remain outstanding until actual resolution.
Use the actual ERASURE_LOCATOR_EFFECTS/locator-effects queue registration and frontier snapshot/delivered/work
queries: freeze the database timestamp only after recorded effects checkpoints, then probe the existing indexed
ENQUEUED/PENDING frontier. Unrelated or failed workflows do not extend that finite frontier. Separately, a failed
workflow/fork that owns a missing locator or unacknowledged copy leaves its PARTICIPANT unfinished, never no-data;
passing the coordinator frontier cannot absolve that custody. Existing work/retention.ts terminal-history deletion
is not erasure/minimizer evidence or authority to forget an unfinished identity obligation. Actual source
locator/failed-work integration remains a required native owner binding, not a prose certificate.

The fixed A5 participant registry is distinct from the two identity publication participants. Identity publication
does not certify erasure, and Library A5 does not take over identity directory ACK. Immediate terminal account
fencing applies independently of asynchronous cleanup. Minimize personal labels/reasons/private linkage and all
copies under existing policy; preserve only necessary de-identified immutable replay/no-resurrection skeletons
and communal originals/terminals. A digest is not an exemption for private links. Actual Auth deletePersona and
owner minimizer schedules are required; a direct native tombstone call observes only the barrier, not full A5 proof.

## Cost

The SINGLE limit authority is [Bounded job steps](../../README.md#bounded-job-steps). All durable job operations
below adopt it, including continuation, workflow bytes, raw work and deadline. Raw 100 is a DURABLE STEP bound,
not a universal public page allowance. Public operation class, filtered-lists decision 5 and the ACTUAL Source
plan allowance govern public reads; Source's 256 per-call input cap is not proof of engine or complete-query work.
The proposed public two-probe raw-100 argument is rejected. Existing page budgets and executor behavior do not change.

Define A current originals, G current groups, M pending memberships, E published epochs, R live minimized
obligations, L live scoped effect keys and H receipt/outbox/binding history. Let D registered dependency rows,
S scopes, F relevant native structural fact rows and n raw entries actually examined in a bounded step. q denotes
an actual physical partition; P is its symbolic fixed capacity. Logs mean log(2+size). Rows include filtered,
discarded, deleted, joined/materialized, overlap, lookahead and replay work; blocks include shared index/heap/
payload/catalogue work, not cache misses. O(n log X) means keyed points/writes against named X indexes, not scans.
R/L/H retain O(R+L+H) actual rows/payload plus indexes, while a point on them is O(1) rows and O(log(R+L+H)) blocks.

### Native statement accounting per attempt

Use current `runCommand`, not an imagined cheap command. The kernel Command-and-receipt derivation gives K=7
unreceipted and K=8 fresh receipted framework statements (transaction setup/timeout, native time, receipt lookup
when configured, partition fence, COMMIT). Authorization preparation/finalization, acting-account gate queries,
body SQL and separate wakeup SQL are ADDITIVE. The existing fence SQL already writes result receipt/event/outbox/
write-basis in that SAME statement: count those rows/index/FK effects, not another statement per inserted row. Replay's framework differs
(the kernel derives six plus current authorization); do not count fresh writes on a receipt hit or omit current
authority. Counts are PER ATTEMPT; contention retries to original deadline with jitter up to 100ms and no count cap.

For actual future SQL, let j be job/attempt lock/read statements, g exact group/version/header statements, v exact
claim/custody validation statements, i input/ref statements, p pending/summary/CAS statements, w wakeup statements,
r EXTRA receipt-result statements and o EXTRA event/outbox/write-basis statements beyond the existing fence SQL.
For the existing normal runCommand fence, r=o=0: these writes are already in K; only actual separate body SQL
can make those terms nonzero. These count executed SQL, including zero results,
not function calls; a batched statement may cover several fixed keys but still charges their rows. They are
schema-derived body terms to bind and measure, not invented existing exports or a new numeric allowance.

| Operation                  | Native normal-path statements per attempt                            | Derivation obligation                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admit final local command  | K_receipted + j + g + v + i + p + w + r + o + authorization/gate     | Exact at-most-two headers/refs; planned-home receipts are fixed scope. Prior ordered acquire commands each pay their own K and body; they are not free or folded into one remote command.                                                               |
| Poll operation native read | K_read + owner + job + scoped-publication/result + current authority | K_read=3 from withReadTransaction BEGIN/SET/COMMIT; one actual owner point. No mutation receipt or durable wakeup. If implemented with a native command instead, pay that executor's K plus this body and prove why; no cheaper assumed port.           |
| Publish local command      | K_receipted + j + v + p + w + r + o + authorization/gate             | v validates mapping plus TWO versioned participant completion records and prior-home custody; p covers admitted-to-published CAS and committed scoped-summary work. Summary fanout happens in retained bounded steps, never all scopes in this command. |

These algebraic totals name EVERY statement category before measurement. Exact j/g/v/i/p/w/r/o native SQL counts
and c_MAX values are MISSING until native storage/producer plans bind them; Performance must confirm them before
types or runtime. This is not a measured K+body pass. Bounded body size follows constant descriptors and
indexed point/continued work, not a blanket claim that a multi-command acquisition is one transaction.

Actual OP has a different framework: initial time snapshot BEGIN/SET/time/COMMIT =4; serializable transaction
BEGIN, lock-timeout SET, initial timeout SET, partition fence, final timeout SET, COMMIT =6. Thus OP pays
**10 + account fences + authorization/finalization + derived body + actual DBOS enqueue SQL** per attempt, plus
gate work. At most two actual fenced accounts are sorted by the executor; fenceOperationalAccount executes the actual
account-share.sql point once per account (one statement each), including its lock/owner rows and FK/index work. OP adds no command receipt/event/outbox/write-basis/position. DBOS SDK statements
and shared history are not zero and must be captured from actual WorkClient on the SAME native connection.

### Touches, Bound and Growth check for every operation

Every growth entry below names REQUIRED tests on activation under `test/semantic/growth-identity-publication.test.ts`
(abbreviated **GI**). That file is not delivered here. It must use existing `test/support/growth.ts:checkGrowth`
with `rule: 'series'` and native EXPLAIN examined rows/shared blocks/statements, all actual pools/engine captures.
Leading SQL tags `/* identity:source:<operation> */` and `/* identity:control:<operation> */` distinguish growing
statements. Returned/affected row helpers cannot replace plans. Periodic reclaim/wakeup belongs in `prepare` AND
its own growth case, with no subtraction, local catalogue classifier or exemption for untagged setup. Cold/warm
catalogue/DDL/trigger costs and installation waiting remain visible in their actual phase.

1. **Coherent cap, ordered prepare/acquire, admit and cancel.** Touches: double-collected at-most-two current
   headers/source versions, compact binding, local owner/slot/attempt/group claims, immutable refs and native
   receipts/closed-home fences. Bound: O(1) rows PER home command and O(log A + log G + log M + log E +
   log(R+L+H)) blocks; statement sums above per command, plus both effects-free collection passes. No full member
   scan or global history walk. Planned homes are a fixed descriptor from inputs, job home included. Growth check:
   GI `coherent admission and ordered cancellation stay indexed`, pending/control/history independently 1/8/64,
   group sizes 64/512/4096, P=1 cross-home contention, mixed-count/ABA, uncertain RPC and all-table 4097 no-effects.
2. **Poll, reconcile and publish.** Touches: indexed original receipt/job, current auth/disclosure, actual native
   mapping/two participant receipts, scope frontier and CAS/wakeup. Bound: O(1) rows per fixed native completion
   point; O(log M + log E + log(R+L+H) + log S) blocks; K+body per table, EACH released custody command separately.
   Growing scope/receipt fanout is a continued operation, not a poll scan. Growth check: GI `poll and publication
   custody stay indexed`, unrelated groups, E and H independently 1/8/64; native pending/completed/replay/revoked/
   hidden/unknown and out-of-order lower publication/cancel paths.
3. **Standalone current mapping.** Touches: source owner and mapping/birth basis, one relevant control owner,
   batched pending-membership probe and coherent current/scoped-revision probe; final source validation when
   cross-backend. Bound: O(b) rows for b requested originals, O(b(log A+log M+log E)) blocks, plus independently
   charged current privacy/Access. Same backend uses ONE RR: BEGIN, SET, source owner, source basis, control owner,
   TWO probes, COMMIT = **8 statements**. A snapshot is a coherent cut; no extra reread/snapshot without an actual
   counterexample. Cross-backend releases source before control and then revalidates source: source<=10,
   control<=6, **16 total**, or **11** pending before final source visit. A batch keeps TWO probes, not per-ID
   queries. Growth check: GI `current mapping remains scoped across released snapshots`, M/E/history independently
   1/8/64; all missing/moved paths, pending-after-source, publish-between-reads, newer pending and fresh self.
4. **Filtered page and cursor validation.** Touches: existing shared batched owner/epoch observation plus TWO
   control probes, existing per-candidate source points and complete source observation. Bound: no separate
   readMapping, extra snapshot/client/control SQL or per-ID loop. Fit direct<=12 statements/backend or composed
   `8+4R_page` (R_page is source references, not retained obligations), one connection/backend; existing candidate,
   Access, raw/native plan and physical-query allowances apply. Work is page-derived; no S/D scan. Growth check:
   GI `finite owner pages progress under continuous disjoint identity work`, source size/query support 64/512/4096,
   unrelated A/G/M/E and R/L/H independently 1/8/64, complete excluded/NOT/order changes and cursor start/final/
   current checks. The native Source bindings above are required reds until delivered; samples cannot make it pass.
5. **Register, arm, summary finish, revalidate and repair scopes.** Touches: actual source headers/structural
   dependency index, inverse `(original,owner,scope)`, OLD/NEW dirty capture, native claims, committed summary/CAS,
   receipts and source-local repair. Bound: O(n) examined dependency/effect rows, O(n(log D+log S+log A+
   log(R+L+H))) blocks and K_or_OP+body SQL per native home. Registration scans finite relevant source input in
   retained steps; discovery fanout is continued by original/scope, not a per-page scan. A source with arbitrarily
   many scopes gets in-unit keyset continuation with OLD/NEW custody retained. Growth check: GI `complete scope
   registration and reordered summaries stay bounded`, D/S/unrelated history 1/8/64, support 64/512/4096,
   registration versus first claim, move/cancel/delayed messages, all-group versus owner-source isolation.
6. **Mapping, Search and Library canonical effect steps.** Touches: shared immutable affected streams, actual
   source/engine records, structural directory/candidate/extrema, six drivers, OLD/NEW gate/effect/follow/support/
   total and exact native receipts. Bound: O(n) examined rows, O(n(log A+log G+log F+log D+log(R+L+H))) blocks;
   each one-home command pays K or ACTUAL OP plus all effect/wakeup SQL, Search pays native engine work/bytes too.
   Structural fanout follows relevant original/scope existence, not number of repeated session facts. No fixed
   per-fact 14-row formula is valid. Divide remaining durable allowance by captured actual elementary-unit cost;
   any original/scope/extrema with unbounded support has IN-UNIT keyset continuation for support/OLD/NEW halves,
   no requirement that the entire original fit once. Growth check: GI `canonical effect and first-apply custody
   stay bounded`, originals 64/512/4096, raw boundary 100/101, unrelated owner/support/history 1/8/64, million same-
   scope sessions, first/deep/empty/replay, legitimate first apply in both orders and follow ACK/directory negative.
7. **Birth and final writer guard.** Touches: actual revision-1/self mapping, native source fence/claim, OLD/NEW
   capture and same-TX deferred home handoff guard. Bound: O(1) additional fixed birth/guard rows, O(log A+
   log(R+L+H)) blocks; at most ONE indexed home-handoff-state lookup per guarded write including deferred check,
   actual native command body/receipt/event SQL additive. No Search/control checkout for birth; correct SOURCE
   home. Capture fanout uses continued dirty work. Growth check: exact Access birth/verify files above plus GI
   `native writer handoff covers old and queued transactions`, fixed-data open-XID 1/8/64 ONLY if mechanism probes
   active transactions; otherwise no invented active-XID axis. Catalogue locking and waits are not a free trigger.
8. **Bootstrap, export, receiving custody and exact-head ACK.** Touches: indexed topology slots, base/member/dirty
   keysets, source export, native control receipt/frontier, released source ACK. Bound: O(n) examined rows,
   O(n(log A+log G+log(R+L+H))) blocks, EACH actual command's K+body. Each saved page costs THREE distinct native
   transactions: export, custody, ACK. At least ceil(4096/100) topology pages before metadata, with empty homes
   included; actual capacity is smaller after metadata/lookahead. Large page payload/custody subdivides within
   unit, retaining exact source receipt/head across steps. Growth check: GI `all-home cutover retains exact dirty
   custody`, 64/512/4096 group/support and 1/8/64 export/history; h+1, lower keys, deletion/move/saved empty,
   crash export->custody->ACK and native failed/control-owner moves. No hidden export full-copy exemption.
9. **Minimize, reference acquire, reclaim and wakeup.** Touches: locked generation/ref/header, actual owner/shared
   minimizers, indexed retired generation and member keyset, frontier/receipt/wakeup. Bound: O(n) examined rows,
   O(n(log A+log G+log(R+L+H))) blocks and native K+body SQL including refusal/empty/wakeup. Reclaim selects and
   deletes each member (k_MAX=2 for that payload); metadata c_MAX explicitly equals the actual plan's owner/fence
   rows + locked header/ref rows + frontier rows + native receipt rows + wakeup/outbox rows + minimizer/custody
   point rows + empty-range sentinel work. These categories ALL count, including executor gate/body FK work.
   Exact maxima for each are a MISSING native plan binding, not c=0. Allocate at most floor((100-c_MAX)/2)
   members ONLY after Performance confirms c_MAX+2<=100. If metadata cannot fit, split minimization/custody into
   prior bounded native units with locked retained state; no zero-progress reclaim loop. Growth check: GI
   `reclaim and wakeup retain local physical bounds`, retained generations and R/L/H independently 1/8/64,
   memberships 64/512/4096, first/deep/empty/replay/ref refusal/minimizer failure/crash and other-partition progress.

10. **Accounts intent, delivery and durable publication probe.** Touches: one account-home intent insert in the
    existing decision/reversal transaction, primary and three role-first indexes, exact source/control custody,
    same-workflow indexed publication state. Bound: one additional intent statement with O(1) examined rows and
    O(log(R+L+H)) blocks, plus actual native command/authorization/receipt work already charged to that owner.
    Delivery commands each pay their actual K+body; each bounded read probe pays K_read plus native owner/job
    points, O(1) rows and O(log E+log H) blocks, never a history scan or request-held wait. Durable sleep adds real
    DBOS shared-history work, captured independently, no command effects. Growth check: existing
    `test/access/growth-agent-verification.test.ts` for verify/unverify and the unchanged birth tests named above;
    GI `account intent replay and publication probes stay indexed`, source intent/history and completed jobs
    independently 1/8/64, in-flight verify/reversal, outage/sleep and same-receipt busy/capacity recovery.

Every other page division `floor((100-c_MAX)/k_MAX)` above requires a captured finite c_MAX+k_MAX fit before
activation OR in-unit keyset continuation for arbitrarily supported originals. Continuations retain exact
original/scope/subphase/OLD-NEW custody in native storage and use existing bounded cursor/workflow limits; no
original vector in JSON. A unit too large to ever fit is a failed design, not permanent preparation.

At each three-scale capture, measure B as membership table PLUS ALL index `pg_relation_size` deltas per retained
membership; record generation headers and other relation/index deltas separately. Full membership payload bound
is `(Aq+4P·4096)B`, plus at most Gq+4P headers/indexes and actual O(R+L+H+D+S) payload/index bytes. Record physical
native counts after EVERY durable/crash/replay/abandon state, including bootstrap, unsealed/export/partial-delete/
abandoned and move copies. MVCC/index/vacuum residue is measured, not inferred from logical deletes. This is a
measurement column, not a new budget or a claim that a formatter/earlier setup red confirms native Cost.

## Required native schedule matrix before executable closure

These are REQUIRED native SPEC cases, not tests delivered or weakened by this documentation change. Retain the
original admission/publication/HTTP cases and all nineteen cutover outcomes, with honest actual producer bindings.
Primitive/capacity/negative producer cases run separately from full coordinator/Search/Library publication so a
missing consumer cannot create a cycle or force fake ACK. An unavailable primitive may establish a specific red,
never full publication success. Native setup failures before a named assertion are not reached-case evidence.

| Native surface               | Required schedule and assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission fixtures           | Native 4096 success and 4097 no-ALL-table effects, coherent mixed count and non-ABA validation, hidden/unselected member and terminal/self, immutable inputs, native authorization before receipt and conflicting replay; no seeded readiness.                                                                                                                                                                                                                                      |
| Concurrent control           | Disjoint changed groups progress together; overlap alone busy including PREPARING; P=1 cross-home claims include first ordered job home. Crash/replay before/after remote acquire, uncertain RPC, cancel versus delayed acquire in BOTH orders at EVERY planned home, CAS admitted/cancelling exclusivity, no stranded capacity and no free binding/full job.                                                                                                                       |
| Mapping                      | Released real source connection; one relevant current route; pending-after-source, publish-between-reads/new pending, wrong/missing/moved/retired owner unavailable, unaffected/fresh Search-absent self; one-RR same backend and cross-backend cost capture.                                                                                                                                                                                                                       |
| Complete scoped Source       | Finite unchanged owner source produces useful pages while continuous disjoint jobs run. Complete excluded/NOT/order-only dependencies change before start, between start/final and before continuation. All-group catalogue's broader scope does not block that source. No returned-hit completeness proof.                                                                                                                                                                         |
| Scope summary custody        | First dependency registration versus claim/arm in both orders; lower allocated job publishes after higher, lower cancels after higher, delayed arm/finish/cancel, source move and repair, scope retirement/cursor ref release. Native committed scoped revision detects clean-to-clean change and has no global active marker.                                                                                                                                                      |
| Native receipt/effect        | Same position wrong transactionId, wrong owner/scope, unfinished prior page, actual per-home withdrawal/addition/fence custody. Crash after effect commit before DBOS result journal and before control ACK resumes SAME receipt once.                                                                                                                                                                                                                                              |
| First apply and Library      | LEGITIMATE old-epoch apply at the actual destination commits before gate and is included in rekey; gate-first atomically rejects/redrives it. A stale epoch at a guessed NEW destination is insufficient. Real follow ACK with directory incomplete refuses publication; all six structural drivers/first registrations/last eligible original then complete under SAME participant. No canonical_source_fact write assertion substitutes.                                          |
| Public HTTP                  | Native POST body/Auth/quoted key/202 ONLY after admitted/Location and same authorized replay; conflicting key; poll pending/completed/unknown/denied/revoked/hidden original concealment. Native held pre-suspension token 401 invalid_credentials/Bearer invalid_token and Auth sign-in 403 actual shape, never invented valid suspended bearer.                                                                                                                                   |
| Accounts publication         | Verify and reversal keep successful DTO and wait before approval/page/finish/clear. Busy/capacity retry same native decision/reversal intent, crash before/after job return; already-verified/reversal replay waits publication; no worker held during durable sleep.                                                                                                                                                                                                               |
| Cutover topology and birth   | EXPLICIT real scheduler/bootstrap closure on all 4096 including empty/unselected homes and actual owner epochs; lower-key births after frontier, failed birth rollback/revision1, ordinary/import correct source home and named/unnamed person/org/software account-agent births. Legacy seed before final guard. Missing native bootstrap callable remains red.                                                                                                                    |
| Writer final handoff         | Actual verify AND reversal in flight before/after installed home barrier/deferred SAME-TX guard, queued merge/move/link/reversal continuations. Owner move shows availability retry only; separate legitimate native guard race proves handoff. Active-XID1/8/64 only when inspected.                                                                                                                                                                                               |
| Native structural semantics  | Larger survivor, split/restore/repoint, overlapping undo/replay preserve direct terminals and exact immutable counts; first/deep/empty/shared100/101 changes include overlap/lookahead/retries without free row101; current flat lookup never follows ancestors.                                                                                                                                                                                                                    |
| Export/custody               | Lower dirty head, OLD+NEW key-changing update, delete negative, saved empty replay, source export crash before custody and custody before source ACK; failed ACK of h leaves h+1; failed/moved control custody retains exact page and native receipt.                                                                                                                                                                                                                               |
| Retention EVERY step         | Assert Gq+4P and Aq+4P4096 from ALL native tables after every commit/crash/replay/abandon/bootstrap/unsealed/export/partial deletion/move; no fifth copy, false G=0 or R/L group. Minimize real undo/reversal/move/cursor refs, generation ref-lock races and missing-minimizer refusal. Local admission refused before native empty proof, succeeds after it; another partition progresses. Relation/index byte deltas and examined work, not three small jobs or delete.rowCount. |
| Terminal/late/failed custody | Actual account terminal T/locator fence, late item registration behind enumeration, failed-work/fork missing locator, owner/shared minimizer custody, participant-own ACK independent of overall frontier, then overall no-open-late/allACK/frontier. Native Auth deletePersona proves full flow; direct tombstone proves barrier observation only. No Semantic ref exhaustion claiming Library purge.                                                                              |
| Full publication             | Actual mapping + fixed Search + full Library receipts with all prior effects/fences custodied; missing/delayed receipt stays pending, crash/replay publishes once, public canonical uniqueness and cursor currentness, crossing-epoch delayed first positive/terminal purge cannot resurrect support.                                                                                                                                                                               |

Existing `test/semantic/identity-epoch-admission.test.ts`, `identity-epoch-publication.test.ts`,
`identity-operations-http.test.ts`, `identity-epoch-cutover.test.ts` and their three native support files are evidence.
Their globally sole-job assertion, implicit bootstrap via readEpoch, legacy-only snapshot, stale wrong-destination
first-apply case, legacy fact-table directory assertion and hypothetical suspended-bearer expectations cannot freeze
the new boundary. Preserve the original safety/DTO/custody outcomes in the REQUIRED schedules above; revise native
SPEC/executables only AFTER Cost confirmation and owner review. Earlier bootstrap P1114/setup reds did not execute
the nineteen cutover scenarios and supply neither a native pass nor Cost confirmation. No costly retry is part of
this documentation closure.

## Evidence and review boundary

Read the full current owning documents, existing contract types, admission/publication/HTTP/cutover cases and
support, actual native writer/command/read/operational/work bindings, Library structural owner/source/fact-version
and Search source/scope-source/producer-consumer/privacy contracts. The two integrated cutover reports (current
`a73bcefb2fe9a901d22478bb4e3d774c06186c55`, deep `e9ae39f06176b66a4026533812f07c6e00e46dec`) and both independent
concurrent reports identify candidate mechanisms, not native performance evidence. The integrated current report
also exists at `docs/research/identity-concurrent-groups-current.md`; the absolute reviewed copies, comparison,
full coowner review, single-closure master and Performance/Accounts/Search reviews supplied the corrected adoption.
Their superseded global-summary alternatives do not remain a second contract.

Read-only reference evidence: PostgreSQL `src/backend/commands/trigger.c`, `indexcmds.c`,
`src/backend/utils/time/snapmgr.c`, `src/backend/access/heap/heapam.c` in
`.reference/library-shelf-maintenance/postgres` (sparse files read from git objects where needed), and DBOS
`src/dbos.ts`, `src/dbos-executor.ts:runInternalStep` in `.reference/search-worker-outcome-harness/dbos-transact-ts`.
Native installation locking/snapshot rules and body-before-result journalling motivate the required schedules;
no reference implementation was copied and no new external research is claimed.

Review proceeds on hashes of these formatted owner documents: Semantic and all coowners review complete-query
producer bindings, native custody and ownership; Performance confirms ALL nine items and actual derived body/
metadata/page-fit plans BEFORE types or runtime. Missing scope producers, owner-transfer bound, account source
intent/delivery, native bootstrap/guard/minimizer/locator and fixed participant bindings remain exact native red
obligations, not approval requests for alternate product policy. Formatter success checks bytes only. Integration
does not freeze a signature, attest native performance, complete publication or satisfy a main/root runtime gate.
