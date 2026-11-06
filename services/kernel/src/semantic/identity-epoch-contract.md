# Native identity publication contract

This is the sole owning specification for concurrent identity admission, publication and native cutover.
[Canonical lists](../../../../docs/filtered-lists.md#canonical-identity-and-personal-references) own list semantics;
[Library owner queries](../../../../docs/library-owner-queries.md) own structural private support;
[private follow counts](../../../../docs/private-follow-counts.md) own private contributions and counts.
This document adopts scoped concurrent publication. It is **not a formatted-byte freeze, Cost confirmation,
type delivery, runtime delivery, publication completion or root-gate completion**. Native growth and receipt evidence remain required for implementation closure.
The initial production capacity is P=1: one admitted or PREPARING job reservation per native control partition, charged once per (home, job). Capacity is local; recovery, cancellation and reclamation require no new reservation.

`identity-epoch-contract.ts` exposes storage; controlPartition is bootstrap topology, while job IDs encode home. `readEpoch(client, partition)` observes that
home independently. The earlier globally serialized proposal is superseded. Existing native cases remain evidence and required outcomes; they are not the new
frozen boundary. Missing producers below mean actual missing native implementation and proof, never permission
to manufacture a callable, receipt, ready state or successful adapter from this prose.

## Invariants

A permanent catalogue original is never reused. Creation requires actual Global `subject:create`, import batch
authority where applicable and native revision 1, independently of Search. Only duplicate identity is mergeable;
editions, translations and formats keep separate identities and relations. Published redirects are direct to an
active terminal; a requested larger-UUID survivor is legal. Link and relation `related` maps keep the original key;
the authorized fill is the survivor's `RelatedSubjectSummary` and `redirect` names that survivor. Stored personal originals, occurrence IDs, notes,
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

[Exact callable compatibility](#exact-existing-callable-compatibility) owns native merge/AccountAgent signatures,
replay and authority. [Asynchronous HTTP](#ordinary-http-asynchronous-identity-operation) owns admission,
polling, suspension and publication. Retained HTTP200 does not deliver HTTP202 admission.

### Reviewed Person identity precondition

Decision: paired evidence uses the existing native merge/original Subject read; preserve
admission/publication and refuse unsupported coverage. Adopted evidence:
[reviewed identity atomic boundary](../../../../docs/research/merge-reviewed-identity-atomic-boundary.md).

Optional expectedIdentity.endpoints is a strict pair bound to subjects BEFORE sorting/hashing. Endpoint has
subject UUID, positive safe all-kind revision, positive decimal securityRevision, source bangumi/vndb or their exact bangumi_cross_media/vndb_cross_media claim aliases,
externalId, claimTransactionId UUID, property and value. Bangumi person:N maps to wdt:P6298=N; VNDB sN to
wdt:P3180=sN, using canonical positive numbers. externalId/value each spend at most 255 UTF-8 bytes;
expectation spends at most 4096 bytes. Same/cross-provider pairs are legal. Evidence fixes Person/Global,
grants no authority and leaves equivalence to the reviewer.

Subject GET accepts paired reviewIdentitySource/reviewIdentityExternalId; partial/malformed pairs fail.
Optional reviewedIdentity is Endpoint|null; null means incomplete/ineligible evidence. Read claim, latest
all-kind revision/security and selected Global identifier in the final authorized transaction, preserving
freshness/disclosure, sessions, documents/viewerActions and private/no-store. Redirect following cannot yield
positive original evidence. Only positive original claims expose their transaction identifier.

After authorization, exact replay and saved preflight errors, BEFORE terminal capture/effects, resolve both
tuple homes with server routeKey and both Subject homes. All four must share the admitted partition;
foreign/fenced/moved/unresolved incarnation or unsupported coverage is atomic_guard_unavailable via native
HTTP503. Lock positive claims FOR SHARE in tuple order, then Subjects FOR UPDATE in ID order. Compare claim
binding/transaction, visible Person, absent redirect, security and all-kind revision. Missing claims fail
without gap locking. Reuse effectiveGlobalSlotFacts: require complete selection, at least one nondeprecated
string and exact agreement of every nondeprecated value. Display/rejected candidates never count.

Editorial/type/moderation/disclosure writers update Subjects. Erasure independently mutates claims,
fact/candidate payload and adoption heads: hold selected-row/head SHARE locks too. Hold exclusions through
effects/receipt/outbox COMMIT or ROLLBACK; drain/restart reacquires and compares. Retain SERIALIZABLE,
200ms lock timeout, bounded retries/deadline. Exact replay wins before comparison after mutation/redirect;
current authority/erased results remain. Digest the whole validated ordered body with actor/operation.
Changed evidence, omission/presence or swaps conflict. AccountAgent gets no implicit Person guard.

Price prevents redirecting an unreviewed identity: four primary locks, two claim/Subject/latest-revision/
redirect seeks and two slots. Compact slots have at most 32 assertions (33rd expands), expanded slots at most
32 candidate points. Up to 64 selected-row plus two head locks yield 70 locks. Oversized/incomplete evidence
is unavailable, never sliced. Evidence is 4KiB, digest 32 bytes, no ledger. Logical bounds are not measured Cost.

Ordinary HTTP merge admits the native identity job and answers 202 `{operation:{id}}` with Location polling;
`mergeSubjects` keeps the completed callable DTO for AccountAgent and unguarded callers. The Person guard runs
in the admission first-effect after authorization and replay. Legacy-only coverage refusal remains until
incarnation/fence exclusion is separately proved. Guard success proves no publication. Imports retains
original bindings and withholds credits until independent current canonical Person and mapping/Search/Library
publication. Content keeps its sole publisher; Rating/Content retain original COMMIT/ROLLBACK obligations.
Native races/growth and integration remain required.

Decision: colocated store callers keep a single `authorization`; HTTP merge supplies `authorizationFor` per
partition because admission home and the redirected Subject partition can differ. Closing an unreserved binding
asks `authorizationFor` for the job home and each source home it delivers. Independent public readback is
the one-hop 308 plus the survivor GET. Foreign-home reviewed Person evidence answers HTTP 503
`atomic_guard_unavailable`. `done: true` still requires mapping and both participant receipts.

Original-funded Identity Source receiving prepares, checkpoints and finishes through Core's
`event-callback-source-association` profile on the same Pool, Work client, ledger, reservation,
receipt, source position and deadline. Publication rereads Mapping `readJob` and the three
complete participant ACKs without inserting a new event. Access owns the original-source reader
and reversal settlement; Commerce and Search own their participant bodies; Library owns
`revalidateHold`. Installed owner declarations determine the disposition. Absent operands name
that owner and callable. Subject erasure keeps a separate source walk. Native History composition
installs the Accounts declaration binder before commands; merge, replay, custody and Accounts
readback keep those original bodies. Worker-installed Search and Library participants remain
required before Accounts verify/unverify can resume a job. Original-source native cases install
those participants, then run Accounts verify through `mergeVerifiedAgent` so the published job
and participant receipts exist before original-funded prepare/checkpoint/finish. The independent
Source maintenance Library emptySeeks ceiling is 128, matching its statement axis, because
coordinator produce runs Search/Library participants inside that frame and Search `readJob`
alone dispatches partition, job and ack seeks. Admission-only cases may still call
`prepareAdmission` without resume. Library cutover Access keeps
`collection:delete` with `library.collection` owner/type metadata so native grants compile.

## Concurrent control and coherent admission

### Immutable cut before any new effect

After current authorization, resolve same-receipt replay through an indexed read BEFORE fresh cap collection.
Recheck a raced original receipt binding before returning overflow: existing preparing/admitted custody wins over
a fresh refusal, and resumes that same job. Neither lookup creates a receipt or any other effect.

Resolve the at-most-two input groups to immutable, non-ABA current generation/source versions and exact counts.
Perform an effects-free double collection: capture EVERY input header/source version, then validate EVERY captured
version remains current, ready and under the same native owner/generation. A common cut lies between last capture
and first validation when all versions match. A version cannot return to an earlier value after a change. A
single mixed read is insufficient: moving an original can expose a new 2048 count with an old 2049 count even
when the coherent union is 4096. Immutable data alone does not make differently timed current pointers coherent.
Both passes include current original-to-group source bindings and readiness, not just unchanged group headers;
a stable former group or gated half-publication cannot qualify as a current input. Distinguish the claim/CAS
version from the published basis version. Preparing/cancelling advances CAS state, while the published basis
changes only with published generation/routing: cancellation cannot invalidate every original's unchanged pointer.

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

### Native pre-arm boundary

[The pre-arm protocol](identity-prearm-protocol.md) owns enrollment, scope custody and claim ordering.
`identity-epoch-prearm.ts` implements the control side: the existing home reservation is first held by a
`prepared` native attempt with no group/control pending fields. Immutable retained inverse pages advance only
through contiguous Source disposition and job-home custody. Explicit empty exhaustion seals each pinned input;
the maintained input heads permit the fixed root seal. A native seal handoff precedes every `acquired` claim
receipt and final pending promotion. The colocated fast path proves empty closed prefixes in its own native
transaction; a nonempty prefix requires released preparation. No caller boolean supplies coverage.

`identity-epoch-prearm-contract.ts` exposes a locator-only read of immutable native page/item, exact attempt,
immutable input handoff, retained membership, bridge and current owner. Captured membership cannot be changed
until release, including by the admitted job; structural results use a new generation. Source enrollment owns the real capture and forward/inverse ticket custody;
it takes the native generation bridge lock before issuing a ticket and retains retirement while closed.
The selected Source receiving exports commit unsafe state and their own native receipt together. Missing Source
receiving support remains retryably unavailable. Ordinary post-admission arm does not supply admission proof.

Cancellation closes every planned native attempt, including unknown deliveries, before reconciling every
exported Source ticket. Only complete cancellation custody or real publication releases the same reservation
and bridge. Replaying the original receipt reauthorizes and collects a fresh cap cut; only complete native
closure of the cancelled attempt retires its history pointer and permits a new generation with the same intent
and receipt. Missing closure remains unavailable. Existing WorkModule wakeups advance each retained unit and reopen capacity without a new queue.
Native framework, erasure roles, SQL/index/FK work and physical copies remain charged separately from public
probe work; the runtime feasibility evidence required by the protocol is not supplied by body counters alone.

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
capacity is charged once per `(home,job)`, shared by both changed groups when they reside at that home. Its full
physical allocations still count individually. At every home, the
partition-owner fence, attempt lock, capacity counter/unique slot and group overlap predicate are checked in the
same transaction as the claim. A read followed by an unlocked insert is insufficient.

Crash before first acquisition: lookup binding, then indexed native job/attempt state; absent acquisition resumes
at the same first resource. Crash after sending a remote acquire: lookup that same binding/job, retain the uncertain
planned home, and reconcile the exact attempt there. Do not allocate a replacement job because an RPC result was
lost. Binding history cannot certify that remote admission occurred, and mapping cannot query remote admission.

At P=1, a blocked attempt holds only resources lower than the next one it awaits. Every wait-for edge strictly
increases this total order, including job homes, so a finite cycle is impossible. Follow a blocked attempt to
the holder of its requested resource: that holder can only await a strictly higher resource. On a finite set
of resources this chain ends at an attempt with no capacity dependency, which fair bounded native scheduling
and eventual available owners let complete or cancel and release. Release then enables its predecessors.
This proves absence of a capacity cycle, not starvation freedom under endless competing relevant arrivals;
retained recovery work must receive fair service alongside new admission. Native slot checks/fences/locks must realize those
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
Retain rejected-attempt fences until every registered delayed delivery/retry has receiving native custody.
Minimization to an indexed per-home/job rejected-attempt watermark requires that custody proof; absence or elapsed
time cannot permit recreation of an old attempt. These minimal fences are charged history, never full-job slots.

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

The native negative must pause delivery after a real relevant claim commits but before the source receives
its arm. Target an excluded or order-only original with that claim while keeping the source fact version
and returned positive IDs unchanged. Start/final validation and an old continuation must refuse the stale clean basis. A second schedule
lets arm, effects and finish all complete between probes: the changed committed scoped revision must still
invalidate the page. Run both inside the existing inclusive page capture. Passing only after injecting a
summary, adding a remote admission lookup or sampling returned IDs does not close this boundary.

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

Library scope completion enumerates the native `LibraryScopeEffectsPage` frontier from its first sealed
page through exhaustion under the same seal key, generation, version and frontier. Every exact selected
receiving binding, applied effect and control custody is resolved from committed owner records; caller arrays
are optional hints. Retained completion rows bind source registration/capture/generation and immutable attempt.
A changed seal invalidates the earlier prefix. Only live Source-local `verifyLibraryScopeEffectsSeal` plus the
final native source/owner/attempt guards can finish the scope. Pending, missing or unsealed pages cannot seal
zero, clear an obligation or increment the committed revision as completed. Native WorkReceipts debit the
original reserved dimensions. Public catalogue completion requires its distinct native projection/receiving
coverage; Library exhaustion supplies no public catalogue proof.

Retirement progresses actual active attempts before directory release. The source persists each sending intent
before visiting its directory home. Release under the same open bridge records a native receipt and tombstone
before source-local forward custody is removed; a closed bridge keeps the ticket discoverable. Only exhausted
source-local obligations and actual native hold release permit the retired-state commit. This retires the
scoped registration, not the native business Source or its independent purge obligations.

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
| Library `owner-write-sequence.ts:allocateOwnerWriteSeq`                      | Delivered native allocator and private counter/entry columns      | Production set/clear/Undo integration, bounded legacy cutover and canonical readiness; the primitive alone supplies neither directory nor identity ACK                |
| Library `owner-fact-version.ts:readOwnerFactVersion`                         | Indexed account-home mutation version                             | Complete dependency capture/registration and summary custody; broad mutation alarm alone is insufficient                                                              |
| Search `scope-source.ts`                                                     | Admission scaffolding, unavailable native prepare/prefix/evaluate | Complete native canonical Source and physical namespace/source authorization, including negative/excluded/order population                                            |
| Search `source.ts:SubjectSource`, Semantic `search-source.ts:subjectSource`  | Subject chunks/snapshots and bounded facet samples/probes         | Complete scoped producer observation and native canonical-index participant, not sampled returned IDs                                                                 |
| Semantic native STORE/mapping                                                | Native STORE, bootstrap, current-route reads, ordered P=1 custody | Complete mapping maintenance, registration handshake and native committed partition summaries; fixed participant custody still gates publication                      |

Search's actual `searchWorkModule -> startSearchIndexing -> createSubjectIndexer`, subjectIndexName/subjectAlias,
per-generation subjectConsumer, 256-ID chunks and `refresh: wait_for` bulk precede ordinary checkpoints. They do
not supply complete canonical/negative-query observation or SourceAccess. Native namespace/query admission must
prevent FOREIGN private lookup before engine work; current original/terminal admission and privacy-reduction
ACKs remain independent. Full Search/Library publication cannot be proved by producer-focused missing-capability
cases. Each missing row requires an owner-native case and actual SQL/engine binding. STORE and bootstrap
acceptance exercise the implemented scoped route without substituting for those missing producer records.

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

## Exact existing callable compatibility

`merges.ts` exports `mergeSubjects(pool: Pool, options)` with `subjects: string[]`, optional `survivor` and expectedIdentity, actual
`AccountActor`, `idempotencyKey`, `Uint8Array digest`, `{digest, release: Release}`, `CommandAuthorization`, optional
`deadline` and `clock`. It returns `{survivor, redirected, revision, component}`; component is
`{partition: number, epoch: number, position: bigint}`. `mergeSubjectsInCommand(tx, transactionId, options)` shares
revision/redirect work with account verification; its options are survivor, redirected, release, optional
verificationReceiptId and allowAccountAgent. The helper performs effects, not admission.
The type aliases `MergeSubjects`, `VerifyAccountAgent` and `UnverifyAccountAgent` reference actual exports so their
callable types cannot silently diverge in this specification.

`account-agents.ts` exports:

- `ensureAccountAgent(pool, {account, kind, name, language?}) -> {subject: Item, created: boolean}`;
  account is `string | Pick<AccountActor, 'accountId'>`; kind is person, organization or software.
- `verifyAccountAgent(pool, {account, catalogue: string, receipt: string})`;
- `unverifyAccountAgent(pool, {account, receipt: string})`.

The latter two return exactly `{survivor, redirected, revision, subject: Item, component}` with the component above.
Their successful inputs and DTOs remain unchanged, with no pending DTO or polling. Each successful return MUST wait
for its job to publish, including the already-verified/same-receipt branch and the reversal replay branch. A mapping
or merge revision alone cannot satisfy replay. Idempotence means the same job/receipt and no repeated structural
effect; the existing already-verified branch can report the current catalogue revision/component. Do not impose
byte-identical historical DTO values or freeze the native component position as a new replay contract. Keep the deterministic `accountAgentId(account)`, native kinds,
matching Person/Organization restriction, catalogue survivor, reciprocal backlink and verification receipt on the
merge revision. Software verification remains rejected. Reversal restores only exact recorded moved links, including
Context/filter identity, without undoing unrelated subsequent facts or creating an account lifecycle generation.

Existing `access/agent-verification.ts` has `mergeVerifiedAgent(pool, AgentVerificationWorkflowRequest &
{receiptId: string}): Promise<void>` and `unmergeVerifiedAgent(pool, AgentVerificationReversal): Promise<void>`.
They call those exact native Semantic inputs. `registerAgentVerificationWork` registers durable
`accounts.agent-verification.merge` and `accounts.agent-verification-reversal.unmerge` DBOS steps. Publication wait
belongs INSIDE the same step, before success lets the workflow write its public page/approve/finish or remove the
page/finish reversal/clear pending. A crash resumes that same receipt-bound step, including after effects committed
but before its output was journalled. Do not add another Accounts status, decision receipt or intermediate approval.
The current reversal's pending receipt/catalogue comparison still prevents an old delivery undoing newer review.

Ordinary merge uses real Global `subject:merge` through `authorizeSemanticWrite` and `globalContextAnchor` in
`semantic/http/subjects.ts`, preserving native current required anchor checks. A cross-partition proof is bound to one
command partition, so every identity command obtains its own through `authorizationFor(partition)`: receipt lookup and claim
at the actor partition, admission at the home partition, acceptance at the binding partition, and the terminal merge at
the redirected partition. `runCommand` mints native time and
calls `authorization.authorize` before `readReceipt`, even on replay; `currentCommand(tx)` exposes the completed
binding only on that live transaction. Never serialize that binding as permission. Replaying a user response must
re-authorize the current request. In contrast, admitted immutable job intent is trusted internal durable work
already committed by that admission, not a fresh command on behalf of a fabricated user. Existing platform work
uses `runCommand` without a user basis, and account verification/reversal checks `currentCommand(tx).basis === null`.
Bind job execution to the persisted job, exact scope and native home fences, through the existing outbox/DBOS
composition. This is not a new bypass port or a kernel-wide rule about user authorization after admission.
Account/follow effects retain their real active/terminal account locks and current nativeT contract.

## Ordinary HTTP asynchronous identity operation

Ordinary merge keeps `POST /v1/subjects:merge`, body `{subjects: [id, id]}`, the current native Global
`subject:merge` authorization and quoted structured-field `Idempotency-Key`. After durable admission it answers
**202** `{operation: {id}}` with `Location: /v1/subjectIdentityOperations/{id}`. This acknowledges admission only.
The opaque operation ID identifies the same durable native identity job and receipt, not a separate HTTP scheduler.
Identical authorized replay returns the same operation and Location, including after publication. Different-body
reuse remains `422 idempotency_conflict`; authorization precedes receipt lookup. Admission commits the immutable
intent, pending control/epoch and wakeup atomically before returning the locator. No completed merge DTO is returned
from this POST. An overflow is `409 identity_group_overflow` before ANY job, control, epoch, revision, redirect,
mapping, participant, receipt or outbox effect; the cap stays 4096 originals per resulting group.

`GET /v1/subjectIdentityOperations/{id}` uses CURRENT native authorization on every request, including after
publication. It requires the ordinary merge authority and current disclosure of the original and terminal subjects;
operation possession and an old admission receipt provide no authority. A hidden original cannot be exposed through
a public terminal. Unknown and denied operations return the same concealed `404 not_found`, without a session
component or result disclosure. POST and GET authenticate before operation lookup, including unknown operations.
The native Accounts producer issues a bearer before suspension; suspension advances the authentication floor and
fences the account before Auth revokes sessions. That pre-suspension bearer receives **401**, JSON problem code
`invalid_credentials` and exactly `WWW-Authenticate: Bearer error="invalid_token"` on both admission and polling.
`invalid_token` is the challenge text, not the JSON code. Invalid credentials never become anonymous; an absent
GET route returning 404 does not satisfy authentication or polling acceptance.

Correct-password sign-in is Accounts' own native `403 ACCOUNT_SUSPENDED` with no session, cookie or token;
wrong-password sign-in retains ordinary 401. This is Accounts evidence, not a second Semantic fixture or API.
The kernel's verified-suspended `403 account_suspended` remains a defensive branch for a verified bearer of a
suspended, unfenced account, not a native persona. Current source and original/terminal disclosure on polling and
bans over independent grants remain mandatory.

An authorized GET answers exactly one of:

- `200 {operation: {id, done: false}}` while the native identity epoch is pending.
- `200 {operation: {id, done: true, result: {survivor, redirected, revision}}}` ONLY after the epoch is durably published.

The result uses the native completed merge fields. Neither response includes affected-original vectors, private
participant state, work frontiers or internal receipt details. A committed redirect/revision, mapping step,
ordinary Search checkpoint or local participant completion is insufficient for `done: true`. Completion requires
control custody of mapping and BOTH fixed version-1 Search/Library receipts, covering every prior home removal,
addition and fence installation before publication. Receipt verification binds native `transactionId` together
with `{partition, epoch, position}` and job/step/version/scope. A native `noEffect` command may reuse a position;
position alone cannot identify a transaction or certify completion.

The existing request deadline, Access evidence TTL, global problem `effect_status` and its
`not_applicable | not_applied` values do not change. Do not report a durably admitted operation as `not_applied`
when a request deadline expires: after admission, recovery is through the same receipt and locator. A lost response
or process crash leaves the operation pending and replay recovers that same admission; neither failure cancels
committed work nor declares early success. This response binding is required implementation work, not permission
to extend deadlines or add a global problem status.

Accounts verify/unverify use this SAME native job and publication boundary. Their callable successful DTO remains
unchanged. The existing durable DBOS merge/unmerge step waits internally for publication before approval or clearing
pending; Accounts adds no polling step, pending success DTO or second operation protocol.

## Native STORE and effect boundary

Required `semantic/identity-epoch-store.ts` export `identityEpochStore: IdentityEpochStore` owns:

1. Ordered native control resources and a first-resource job home; a durable routed job ID, native bigint target
   epoch, immutable intent and existing receipt reference; partition-local published basis and reservations; exact group cardinality and affected-original index.
   Durable JSON serializes bigint as canonical decimal strings, never Number. A job contains no client result vector.
2. `bindReceipt(pool, authority, {intent, receipt}) -> Promise<IdentityReceiptBinding>` performs current native
   authorization before any indexed receipt lookup. Fresh coherent cap collection precedes claim/history writes.
   The binding home is the actual actor/account route, with the unchanged `identityReceiptKey` tuple. It commits
   pending intent digest, generation and exact proposed job/home/epoch, releases, and returns committed custody.
   The proof exposes `partition` (binding home), `generation`, `transactionId`, `jobHome` and immutable `job`
   (`jobId`, bigint `epoch`). Callers route admission with `binding.jobHome`; opaque in-process verification
   rejects caller JSON. The locator does not grant Access.
   `admit(tx, {intent, receipt, binding}) -> CommandResult<IdentityJobRef>` runs at that first ordered group home.
   Calling `bindReceipt` again after reservation independently verifies the committed native job and publishes the
   immutable accepted pointer at the binding home. `prepareAdmission` composes those three released stages.
   A pending replay recovers that same reservation before collecting a fresh basis. A failed provisional basis
   can advance generation only after real irreversible first-absence/close receipts at every planned home;
   all generations and closure custody remain retained under the same receipt/digest. No elapsed-time expiry.
   The old transaction-only signature requires genuinely colocated receipt and group homes. It verifies
   real ordinary authorization (or the exact persisted platform decision), receipt/intent equality, complete group
   membership and the cap before writes. Pending plus wakeup are atomic. The final user DTO receipt cannot be
   manufactured as successful by this internal admission result. Typed failure codes are `identity_group_overflow`,
   `identity_epoch_busy`, and `identity_participants_incomplete` for the conditions named here.
3. `initializeSubject(tx, original)` in the real revision-1 creation transaction. It records an exact initial-self
   mapping from actual creation; it does not infer self from a missing row, touch Search or advance a structural epoch.
   `writeSubject`, unlabeled account-agent birth and imports bind it after the revision-1 insert, under native
   `subject:create` authorization and the executor transaction identity. No per-read lazy write.
4. `findJob(tx, receipt, binding?)` requires current native authorization before replay/conflict disclosure,
   an explicit released binding proof for a foreign binding home, and the exact native job-home transaction.
   A locator or reconstructed JSON object grants neither custody nor Access. `readEpoch`, `readJob`, and
   `readMapping` remain native observation, not permission. `absent` is established
   native absence, `unavailable` names bootstrap/missing/moved owner, and `pending` names the affected job. Unaffected
   point reads inspect their indexed local mapping; they do not enumerate the affected group or all homes.
5. `pageChanges(client, job, after)` uses the immutable affected-original keyset and returns at most 100 changes with
   before/after terminals and a bounded continuation, including self rows/destinations needed for split and repoint.
   It does not return personal references or a privacy-filtered representative vector. This is the concrete input
   shared by Search and Library; both consume the same job and page through the store themselves.
6. `admitHomeEffect(tx, effect)` locks/compares the persisted job/mapping gate in the SAME native home transaction
   as the effect. Structural effects bind job+original; follow-count effects bind original+destination+epoch.
   It returns void, never a cached certificate. Wrong native partition, obsolete mapping, stale epoch or out-of-scope
   job rejects. A global pre-read followed by a later other-home write is insufficient.
7. `publish(tx, job)` consumes durable native completion records for mapping and the fixed participant version.
   It reconciles participant ACK receipts with exact job/epoch/version/work scope before atomically publishing.
   `reconcileStepReceipt(pool, receipt)` first resolves the exact committed native producer record identified by
   `{job, step, version: 1, native: {partition, epoch, position, transactionId}}`, validates its work scope and
   observation, and takes control-home custody with idempotent ACK delivery. Missing/uncommitted/conflicting
   locators reject; the locator alone does not certify completion. It takes no caller booleans, result vectors, callback assertions, elapsed leases or noData claims.

Bootstrap must establish complete membership/cardinality/mapping and readiness for actual legacy originals and
redirects through indexed bounded work, capture/drain concurrent creation and structural admissions, and reject
uncovered writers at cutover. A missing aggregate, absent mapping or default epoch zero is not ready. Moved/missing
owners use native partition availability and routing; the job remains pending until actual ownership resolves.
`stepIdentityEpochBootstrap(pool, partition)` implements retained subject/member/dirty keysets, native export,
receiving custody and exact-head source ACK. `stepIdentityEpochBootstrapWork(pool)` is the actual default-worker
legacy scheduler over all 4096 topology slots. Fixture inserts are source data; only actual native receipts establish
legacy closure. Default installation may instead establish locked absence custody as specified below.

The home fence has a required ordering proof. Install the pending gate at each affected destination before mapping
or participant effects there. Installation serializes against old-epoch apply in that home: an apply committed first
is included in the retained re-key input; an apply after installation is rejected atomically. Cross-home removal and
addition retain page intent and per-home effect receipts, so crash/retry cannot forget either half. Before releasing
the pending gate, publication proves all retained changes/withdrawals have ACKs and installs the published mapping
fence. A stale old-destination delivery rereads CURRENT source, account eligibility and mapping on retry, rather
than relabelling a saved positive. Source-account terminal fencing is separate and still required. No amount of
identity epoch bookkeeping alone proves current source-account eligibility across released reads.

### Receiving effects and local custody

`IdentityEffect` has the adopted additive receiving alternative
`{kind: 'receiving', job, original, effectKey, receipt: IdentityNativeReceipt}`. The existing structural and
follow alternatives retain their original-home and published-destination semantics. A matching pending gate
can advance only its admitted job through the receiving alternative; ordinary follow calls acquire no new power.

`identity-receiving-effects-types.ts` owns the closed selection, Source provenance, binding, record shapes. `identity-receiving-effects.ts` exports:

- `prepareIdentityReceivingEffect(pool, selection)` verifies a real pending native job, its immutable input
  original at each input's own released home, and the sole Source owner's committed provenance. It registers
  the exact binding and expected effect at control BEFORE taking the Source hold and committing an accepted
  receiving record/gate atomically. `sourceHold` names that real accepted native command component. Repeated identical preparation returns the same locator. Conflicting scope, incarnation,
  generation, owner, disposition or effect rejects. New scopes cannot register after the Library complete ACK.
- `lookupIdentityReceivingEffect(tx, effect)` resolves the exact committed local record by job, epoch, effect
  key, original, transaction ID AND native component. It checks the current native owner epoch and locks the
  owner/original gate. Its record binds the full job scope, fixed version-1 Library participant, Source identity,
  incarnation, generation, scope and OLD/NEW/first-apply/handoff disposition. `applied` is the exact persisted
  effect receipt/frontier or null. It is a scope receipt, never participant completeness or Access.
- The existing `identityEpochStore.admitHomeEffect(tx, effect)` receiving branch additionally invokes the
  selected Source owner's `readAndHold` operation on the same command client and T. It rejects an already applied effect; consumers
  recover its persisted `applied` receipt before attempting another mutation. Admission installs a fixed native
  callback check: a successful command cannot commit without its SAME-transaction scope effect receipt.
- `recordIdentityReceivingEffect(tx, effect, {frontier})` commits the scope effect/frontier with the owner's
  actual mutation and Source hold. It uses the fixed Library native commit, shared with the participant's native
  step record. The callback and subsequent lookup require that exact native consumer step, full scope and
  frontier in the same transaction; repeated native commit registration is coalesced on the live transaction. A different
  purpose in that transaction rejects. There is no caller complete flag or second participant.
- `reconcileIdentityReceivingEffect(pool, effect)` resolves the actual receiving effect commit, releases it,
  and takes exact control custody under the persisted job/plan/scope before acknowledging the Source hold.
  Lost control/Source ACK replies replay those retained receipts, including after publication. It creates no
  job-wide participant ACK. Existing `reconcileStepReceipt` and `publish` continue to require all expected
  effect custody and the separate mapping, Search and Library completion observations.
- `releaseIdentityReceivingEffect(pool, effect)` releases this job's owner/original gate only after a separately
  released control read proves real publication. The owner invokes this exact-key handoff before later work at
  that gate; one scope ACK cannot clear a pending sibling's OLD/NEW/first-apply obligation.

Native cancellation closes PREPARING jobs; receiving registration accepts only PENDING jobs. Cancellation and
registration serialize on the actual job record. A cancelled/cancelling/preparing job therefore cannot have a
receiving gate opened by this producer. Pending publication cannot overtake a newly registered expected effect.
No native Source hold is discarded on crash, timeout or failed transport. A moved source or receiving owner is
unavailable/stale until its native ownership protocol resolves; there is no relabelling to a new owner epoch.

All SQL/FKs are home-local. The ledger is additive in a new UTC migration; landed migrations are unchanged.
It retains control plans/custody, receiving records/gates and actual effect/frontier receipts, including native
transaction/component and existing native erasure-role locator capture for the retained transaction records.
Original-home gates, P=1 reservations, group cap 4096, raw-key limits and ordinary follow authorization do not change.

#### Receiving preparation, effect and reconciliation Cost

- Touches: one exact job, at most two retained input-generation original points at separately released homes,
  one selected Source/owner/scope/disposition, its native provenance/hold, one control plan/expected effect,
  one receiving owner/original gate, record and effect/frontier, and one control custody/native receipt.
- Bound: partition-leading full keys on every local query/FK; no history walk, foreign join, source-wide scan,
  permission mirror, extra engine or fanout. Each preparation/receipt operation selects one effect; descriptors
  are at most 3072 serialized bytes (4096 stored JSON bytes), effect keys/scopes at most 256 bytes, frontiers at
  most eight scalar keys and 2048 bytes. Source-owned capture/hold/release, native fences, callbacks, erasure
  locator writes and failed/replayed attempts are charged under the existing shared SQL/row/point/byte/deadline
  allowances. Capture carries the caller's allowance and absolute deadline. Local hold/release calls have a fixed
  per-operation ceiling of 512 native rows, 32 points, 16 statements and 262144 bytes, with no candidate
  scan, under the original command deadline. Each retry charges its own dispatched owner work. Preparation
  rechecks finishCapture under the same ceiling and a five-second deadline; no Source work is free.
- Growth check: retain the existing native64/512/4096 receiving-custody companion and changed-neighborhood,
  original-store/key/RLS/cap/privacy/replay controls. Run after integration; minimal delivery uses only the
  changed workspace's local compiler database typecheck. No native/growth result is claimed here.

## Bounded native mapping and fixed participants

Required `semantic/identity-epoch-mapping.ts` export `stepIdentityEpochMapping: IdentityEpochStep` receives only
`(pool, {jobId, epoch})`. It reads the persisted frontier and affected changes, commits one bounded unit and returns
`{job, frontier, state, work, receipt}` only after effects/frontier receipts have durable custody. Re-delivery after a lost
result reads committed progress. Continuation and workflow arguments/results follow the
[kernel's bounded job step limits](../../README.md#bounded-job-steps). Group membership is stored in the work index, never workflow JSON.

Mapping maintenance covers actual direct redirects, revision/account backlink effects and indexed member/link
maintenance. A page is at most 100 raw rows; full inbound/outbound degree is paged, never scanned in one request.
Each native transaction visits ONE actual home. Release it before another home or Search engine, recording enough
intent and per-home receipts to resume a partially applied cross-home page safely. Do not keep one 4096-home
transaction. Existing `moveMergePage` uses phases links/outbound/members/done with 100-row SQL keysets and native
commands. It is behavioral evidence; its old numeric-UUID preference, bare projection events and old completion
condition do not implement the new admission or publication protocol. `reverseAccountAgentLinks` records/restores
only verification-scoped Context/property/source/statement/filter rows; its synchronous loop needs durable frontier
binding, not a full-degree request loop. Stored personal references are never move inputs.

`IdentityEpochParticipants` is the EXACT closed trusted composition object: version 1, `search-canonical-index`
and `library-private-follow-counts`, each `IdentityEpochStep`. Participant functions receive job reference only and
obtain affected originals/new terminals through `pageChanges`, plus their own persisted native progress. No caller
page/epoch override, arbitrary HTTP callback, request-selected participant, or default successful adapter is legal.
Each owns effect/frontier atomicity, monotonic native progress and durable ACK delivery. The returned receipt uses `IdentityStepReceipt`; the producer must persist its frontier, scoped completion
observation and effect references atomically with that native receipt. `reconcileStepReceipt` runs only after releasing
that home, rereads this actual record, and records control custody. The ACK is a persisted
job+epoch+participant-version completion record backed by exact per-home/engine receipts. Crash between local
commit and control ACK must redeliver the SAME receipt; a lost ACK cannot permit early publication. Local receipts
and retained work cannot be discarded before control has safe custody. The coordinator reconciles actual records,
not the function's returned `complete` field alone. Concrete ACK storage/delivery lives with STORE and producers;
no generic caller-facing `ack(true)` port is exposed.

The existing Search binding is `searchWorkModule` -> `startSearchIndexing` -> `createSubjectIndexer`, using
`semantic/search-source.ts`'s `subjectSource`, `subjectIndexName`/`subjectAlias` and per-generation `subjectConsumer`.
The indexer uses 256-ID source chunks and `refresh: wait_for` bulk before its ordinary partition checkpoint.
Those are actual subject index surfaces, not a complete epoch observation or a private/public disclosure grant.
Search must export a real `IdentityEpochStep` adapter for its canonical index and prepared rows. The concrete producer is
`search/identity-epoch-participant.ts`, `createSearchIdentityEpochParticipant({search,prefix,routeKey,receiving})`.
The composition root supplies `receiving` through `searchIdentityReceivingComposition`.
Its current native support/receiving boundary fails unavailable; the declaration is not complete coverage. It must bind the physical target,
incarnation and complete canonical observation at this epoch, keep one public terminal document and unique prepared
rows per generation+canonical ID, and preserve original support and last-eligible-original behavior. This ACK is
DISTINCT from ordinary projection checkpoint and privacy-reduction ACK. Source/public projection and current privacy
narrowing remain separately owned work; do not fork their public-filter contract or require a new engine/certificate.

Library must export a real `IdentityEpochStep` adapter under the existing fixed `library-private-follow-counts`
name for ALL Library canonical records; `library/identity-epoch-participant.ts` exports `stepLibraryIdentityEpoch`.
Library and Search bind live Source maintenance, producer roles and native commit through the
`identity-adapters/index.ts` public entry. Its native Source invalidation
and six-driver planner are bound. Empty-home coverage seals after a committed original scan; homes with collections still require Source manifests. It receives the same
affected-original/new-terminal stream, re-keys in <=100-row steps, and ACKs before
publication. Support is per (canonical target, follower); totals change only at 0->1 / 1->0. Derived pair/support/total
rows live in the canonical-target home; stored follows stay in the source owner home. Admission uses
`admitHomeEffect` in the destination effect transaction. A global epoch pre-read is not an atomic fence. Old-destination
applies reject, then reread current source+mapping. Crossing-epoch cleanup, delayed first positive and terminal account
purge must never resurrect a pair or total. Existing follow/listing helpers do not provide that proof; neither an
assumed noData ACK nor a new account generation or private-fact mirror substitutes for it. The required bounded
owner-candidate and structural-support directory is covered by this SAME participant, as specified below.

Required `semantic/identity-epoch-coordinator.ts` exports `resumeIdentityEpochJob: ResumeIdentityEpochJob` and
`waitIdentityEpochPublished: WaitIdentityEpochPublished`. The final binding serially drains mapping, invokes the fixed
participants, reconciles their committed ACKs and publishes once. It registers through existing `WorkModule.register`
and `WorkContext.addEffects`, `DBOS.registerStep/registerWorkflow`, `WorkClient.enqueue` with stable job workflow ID
and `return-existing`. `composeWork` owns the single DBOS launch; `KERNEL_WORK_MODULES` owns default binding and
`startWorker` owns lifecycle. No scheduler/process/second launch or independently invented maintenance engine.
STORE and mapping import only native dependencies and these types; participant producers import STORE/types;
the composition root binds concrete participants and Search receiving; the coordinator receives them as ports.
Neither participant waits for or imports the coordinator.
Accounts and ordinary callers bind last, after their actual response contracts and native prerequisites exist.

The coordinator now exports these two functions and registers through the existing Semantic module. Control
reads `prepare_job`/`prepare_epoch` with pending custody: a preparing job owns the prepare reservation, and
acquisition mirrors that job into pending before promotion. Publication clears prepare and pending locators,
then revisits admission so every planned home, bridge and Source hold is released. Produce still runs inside
the original Source maintenance frame; Search and Library reconcile their own native receipts there. Lifecycle
owns platform-native inverse removal on the same control home; Identity does not borrow editorial write-basis
for finish-close. Accounts are pre-armed with each grant action on their token before identity installation,
and cancelled admission retains source rows until that Lifecycle removal. Each finite
DBOS segment contains at most 100 pages and enqueues its deterministic continuation with only job/segment locators;
it releases its queue slot rather than waiting for a child on the same bounded queue. Wait follows that workflow
custody but returns only after rereading the actual published job and control. The mapping declaration remains
provisional and fails unavailable. The integrated Search and Library modules preserve their producer-owned
unavailable boundaries; neither supplies a completion ACK without native coverage. Real producer integration, the frozen real positive fixture and native
publication/crash/growth evidence remain required; no native-tested coordinator revision is claimed.

Decision: ordinary `createKernel` / `server` / `worker` install those participants through
`composeSemanticIdentityParticipants` and `composeSemanticDomain` as `IdentityEpochParticipantPorts` on
`SemanticDomainPorts.identityEpoch`. Library custody and Search currentness remain that version-1 pair; Rating
review, Content lifecycle (batch cover reads and imported-tuple routing), hashing, routing and the fact store are
the other installed adapters. Inward subject, summaries and bulk HTTP resolve Content lifecycle through
`adapters/ports.ts`; they do not value-import the native cover adapter. Contract/core/application add no SQL. Cost
stays on this document's identity-epoch derivations. Compact tests pin fake-port load and ordinary composition;
native epoch growth remains later acceptance.

### Complete Library canonical coverage under the fixed participant

The SAME version-1 `library-private-follow-counts` identity participant covers every canonical directory,
candidate, support, first-apply registration, follow, total, pending/published fence and prior-effect custody.
All six member, entry, label, session, copy and output drivers are included, with working/ready bases, accepted
meaning and exhaustion evidence. Owner state chooses the highest live native `entry.owner_write_seq`, preserves
conflicts, unions labels and keeps sessions/copies distinct. That sequence increments in the SAME successful
set/clear/Undo transaction; Undo is a new write despite historic dates. The delivered
[owner sequence prerequisite](../library/owner-write-sequence.md) supplies
`allocateOwnerWriteSeq(tx: CommandTransaction, accountId: string): Promise<bigint>`, private
`library.owner_write_counter (route,account_id)` and nullable positive `owner_write_seq` columns on live/archive
entries. It performs indexed initialization and increment in two statements in the same authorized owner command;
replay skips allocation and failed/noEffect allocation rolls back. These are actual primitives, not missing
schema or an invented callable. Production entry set/clear/Undo writers and bounded legacy migration/cutover
remain missing: null legacy sequences are not ready or ordered. Successful equal-value set still allocates;
archive sequences never compete as live state and Undo allocates afresh. Timestamps, UUIDs,
`type_source_position`, per-slot revisions or invented legacy ordering cannot substitute. Clear and replay retain
their native meaning. The counter requires its own exact Library terminal cleanup after T fences writers;
Semantic reference exhaustion cannot certify that cleanup.

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
STORE; final composition imports producers. Neither producer waits for/imports the coordinator. Caller handoff comes after the native producers and fixed participants are bound.
A permanent ID names a catalogue original and is never reused. Creation needs actual Global `subject:create`,
including import batch authority where applicable, and writes native revision 1 independently of Search.
Only duplicate identity is mergeable. Editions, translations and formats retain separate identities and relations.
Every published redirect is direct to an active terminal. A requested larger-UUID survivor is legal.

Structural jobs cover merge, unmerge, repoint and account-agent changes. Overlapping changed groups serialize; disjoint changed groups can make concurrent progress under ordered control-resource acquisition.
The exact union of the affected groups, including their terminals, is admitted at **4096 originals maximum per
resulting group**, before pending epoch, revision, redirect, mapping, index, participant or outbox effects.
Two input IDs do not imply two originals. Unmerge binds the prior `undoJob` and the original to restore to self; its verificationReceipt is non-null only
for an Accounts reversal. Repoint moves one original to the named terminal. A split checks all resulting groups; overlapping membership counts once.
Overflow is `identity_group_overflow`. Missing/incomplete/moved ownership cannot become a small or empty group.
No structural effect overlaps a job that changes the same group; an overlapping intent receives `identity_epoch_busy` and retries with current truth. Disjoint groups remain independently admissible. The same immutable receipt and intent find the same job instead of allocating another epoch.
Conflicting reuse is the existing idempotency conflict. Authorization still precedes receipt lookup.

The control command commits the pending epoch, immutable admitted intent, affected-original work index and durable
wakeup before structural effects begin. It retains the last published epoch. No lease, workflow timeout, ordinary
projection checkpoint, elapsed time or failed I/O can mark completion. A crash remains pending; resumption starts
from the committed frontier and exact job identity. Publish once, only after mapping/index maintenance and both
fixed participants have actual durable ACKs for that job and epoch. Failure leaves truthful pending state.

Canonical lists prepare while pending; their signed cursors bind the published epoch and restart after a change.
An affected point reports pending while its required mapping is unready. Unaffected points and fresh creation remain
usable without waiting for the catalogue's list barrier. Mapping explicitly depends on one bounded current-control
observation and coherent epoch revalidation, with released source connections as specified below. Source privacy and eligibility are independent
of job completion: both the original and terminal need current native admission. A public terminal never exposes
a hidden original; an arbitrary representative cannot stand for all originals. Preparation must find the last
eligible original through maintained support, without a page-local deduplication claim or repeated home sweep.

Entries, labels, sessions, copies, follows and Collection occurrences keep stored ORIGINAL IDs, notes, dates, order
and multiplicity, with each original still addressable for editing. Only derived mappings, support and canonical
indexes re-key. New writes resolve the current terminal with native admission. Canonical state chooses the highest
native `entry.owner_write_seq`, retaining conflicts, unions labels and keeps sessions/copies distinct. The owner
partition counter increments in the SAME successful set, clear or Undo transaction; Undo is a NEW write despite
historic user dates and retained accepting pin. Epoch maintenance reads that sequence and never allocates it.
The actual Commerce counter/schema/helper producer is missing. No timestamp, UUID, per-slot revision,
`type_source_position`, zero initialization or invented legacy backfill order can substitute for it.

The fixed version-1 `library-private-follow-counts` step covers EVERY Library canonical record. Its historical
name does not restrict its ACK to follows. There is no third participant, identity job, queue, component shape,
transaction-ID shape or callback ABI. The same job/epoch/input descriptor and native receipt protocol applies.
Coverage includes:

- Canonical source facts for all six existing drivers: member, entry, label, session, copy and output; their
  working/ready generations, source/identity bases, checkpoints, candidate seeks and pending/exhaustion state.
  Existing physical `library.canonical_source_fact` keys are `(route,collection_id,generation,basis_digest,
  canonical_subject_id,stored_subject_id,driver,fact_id)`; `canonical_source_state` is keyed by
  `(route,collection_id)`. Their presence is storage evidence, not a working producer or readiness certificate.
- Owner candidate records keyed by owner/source incarnation and canonical subject, and their structural-support
  directory keyed by original and exact owner/source/driver/fact locator. Cover every supporting original, including
  a hidden original, negative/tombstone support and a never-positive first apply. The directory is an internal
  maintenance locator, not Access, membership authority or a new private-fact mirror. It must discover affected
  owners through indexed bounded work, never an identity-job scan of all Libraries or a per-request home sweep.
- Canonical entry state/conflict winners under the existing native owner write sequence, union-label support,
  independent session/copy support and curated occurrence/output candidate support. Preserve every stored original,
  occurrence, note, date, order, multiplicity, accepting pin and unrelated later write. A source's ready pointer
  alone cannot authorize a canonical candidate or prove all support was rekeyed.
- Follow source-replacement delivery, old/new canonical target pairs, per-target/follower support and totals,
  pending/published identity fences and independent current source-account terminal fences. Canonical totals count
  a follower once at positive support; only 0->1 and 1->0 transitions change the total. Negative first applies and
  delayed deliveries retain revision/fence protection. No ready zero is inferred from missing producer data.

Before dispatching a page, persist its COMPLETE expected effect manifest: each old canonical removal, each new
addition, owner-candidate replacement, directory OLD-key removal and NEW-key insertion, source-basis invalidation,
pending fence and eventual published fence. Include all preceding pages and retained half-effects. Identity work
uses exact old/new terminal and source locator, not just its endpoint vector or the observed count of follow rows.
Each home commits effects, manifest progress and exact native receipt together under the actual same-effect
gate/account fences. Release ALL source/Library clients before another home/control/engine checkout. The receiving
control command takes durable custody of every expected receipt; an empty manifest created without authoritative
directory coverage is incomplete. No blanket `noData`, callback return or missing-row-as-empty inference is legal.

FIRST APPLY is part of this invariant. Directory registration/support application and identity gate installation
serialize in the actual destination home, including first-absent gate insertion. If first apply commits first,
its directory and support are included in the retained input/dirty head and rekey manifest. If installation wins,
the stale apply atomically rejects and retries from current source/mapping/account truth, or commits durable
retry responsibility under the new epoch. A source command already committed but not yet registered must have
durable delivery custody visible to closure; it cannot fall between enumeration and directory publication. Directory
rekey is not complete until both OLD removal and NEW insertion, concurrent registrations, pending/published fences
and all first-apply obligations have receiving-owner/control custody. Saved empty pages do not close newer work.

The final Library ACK binds the SAME native transaction ID AND component, job, epoch, step/version and complete
scope. `publish` rejects `identity_participants_incomplete` when even ONE canonical-directory, candidate, support,
first-apply or prior-page effect lacks custody, EVEN IF every follow pair/support/total effect is complete. A
follow-only ACK is invalid for this scope and cannot be upgraded by relabelling its receipt or by the coordinator.
The minimized completion manifest retains proof of directory coverage and all prior effects through reclamation,
replay and terminal erasure. Local published fences may be installed while the owning job is pending; no reader
treats that local installation as permission to bypass its publication predicate.

Native negative schedule: retain a real owner with canonical candidates and a follow, admit the real job, complete
actual follow effects, then interrupt directory OLD removal/NEW addition or concurrent first-apply custody. Attempt
reconciliation/publication with the real saved producer receipt: it must reject and remain pending. Also race first
apply on BOTH sides of gate installation and crash between directory halves/source commit/control custody/ACK.
Full completion requires actual directory, canonical driver, follow, support, total and fence receipts and all prior
effects; resume the SAME job, idempotently redeliver lost receipts, publish once, then assert canonical reads and
unchanged stored originals. Actual missing directory/Core producers keep these cases RED, not skipped or satisfied
by follow-only completion. The cutover suite's native interruption uses actual owner input and coordinator SQL;
the full follow-complete/directory-incomplete schedule additionally needs the owner's delivered receipt layout.

Accounts owns the additive event-free fenced owner operational transaction plus atomic durable intent Core
primitive and its native specification. Existing `noEffect` forbids domain writes and CANNOT implement this
primitive. Semantic declares neither a guessed callable export nor an operational callback/permission receipt.
That owner producer is **MISSING**; source intent/operational rows remain Access-owned. Commerce alone consumes its
ACTUAL delivered exports for Members GET derived preparation. The Semantic STORE/bootstrap implementation does
not provide the Core, Accounts, Library or Search producers described here. Directory/first-apply production cannot
be counted as `noData` while missing.

## Independently landable producer boundaries

| Producer                  | Required surface / evidence                                                                                                  | Present                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic STORE            | identityEpochStore; cap/index/control records, creation self mapping, bounded all-home bootstrap, P=1 fences, native custody | Implemented; full publication still awaits the producers below                                                                                                                                                 |
| Semantic native step      | stepIdentityEpochMapping; scoped effect receipts and bounded mapping/redirect/member/link work                               | Ordinary merge and Accounts verify/unverify mapping drain from original Access source; participant ACKs remain required for publication                                                                        |
| Search participant        | version-1 search-canonical-index IdentityEpochStep; actual physical target/incarnation/canonical ACK                         | Coordinator installs same-Pool receiving, six native operations and directory-complete ACK                                                                                                                     |
| Library participant       | version-1 library-private-follow-counts IdentityEpochStep; ALL canonical records/directories, first-apply custody and fences | Six-driver planner bound; empty-home coverage seal ACK; collection rebuild still requires Source manifests                                                                                                     |
| Commerce ordering         | same-transaction owner counter and entry.owner_write_seq producers; legacy readiness policy                                  | Allocator/schema present; complete producer integration remains required                                                                                                                                       |
| Final coordinator/callers | resumeIdentityEpochJob, waitIdentityEpochPublished, fixed WorkModule/default composition and unchanged Accounts step binding | Coordinator module exports resume/wait; Accounts `deliverAccountIdentity` binds those two names. The public Semantic barrel does not re-export them. Native Search/Library publication proof remains required. |

These are real capability dependencies, not task identifiers. Store/native-step acceptance must not require a fake
Search or Library completion. It can prove pending and refusal to publish independently. Full successful publication
and full persona/API/default-worker/growth coverage remain required until all actual consumer ports exist.

## Acceptance and required integration matrix

The two new native suites run against migrated PostgreSQL, production pools/partition guards, actual native
creation/merge/verification APIs and `createRealAccess`. They do not import cancelled producer fixtures.
The admission suite builds two legacy native groups of 2048/2049 originals and attempts an actual two-input merge,
checks no revision/redirect/member/receipt/outbox effect, and retains an actual stored follow original. That population
is fixture data, not a readiness certificate: STORE bootstrap must cover it before allowing admission, and a generic
bootstrap-unavailable error cannot pass the required overflow-code assertion. Another native test preserves stored
follow IDs on successful merge and requires current Global authority even for the same receipt replay.

The publication suite first executes unchanged Accounts inputs and checks actual subject/component DTO and receipt
idempotence, then requires real STORE records with mapping and both actual participant ACKs. The STORE-only case
admits a native authorized job, requires pending before mapping, rejects another receipt, reads affected/unaffected
points, retries saved mapping progress, and refuses publication without participants. A missing producer fails
explicitly at its native load; no fallback mapping, stub ACK, skip/todo or permanent unconditional throw test is used.
Native repeated delivery covers lost-result replay, not process-death or full DBOS recovery proof.

The cutover suite adds source-command rollback/retry, explicit larger-survivor/overlap/split/repoint replay,
independent in-flight reversal, both export/custody/ACK interruption boundaries, OLD/NEW-key capture and saved-empty
reopening. Its reclamation schedule preserves active immutable inputs, interrupts an actual native membership
DELETE after publication, resumes first/deep generations, repeats empty work, and replays minimized receipts before
later admission. The existing history schedule grows completed generations independently at 1/8/64. Erasure starts
with actual signed Access and account/agent creation plus native tombstone; missing control custody must leave the
same Semantic obligation pending. It does not claim cleanup completion from a status read or fabricate an erasure
ACK. The missing cleanup producer and the full directory/first-apply receipt schedule remain explicit owner
integration obligations; these tests do not certify those absent producers.

The named suite is deliberately red on the current runtime. Required scenarios that need absent consumers stay in
this matrix rather than pretending passing partial coverage establishes the whole outcome:

| Required native schedule                                                                                                                                                                 | Needed producers                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Fresh Global creation revision 1, exact self mapping without Search, denied/import authority; legacy coverage/moved/missing homes                                                        | STORE + creation hooks + bootstrap                           |
| 64/512/4096-original groups; 4096 admitted, 4097 rejected before pending/effects; overlapping groups and concurrent admissions                                                           | STORE + native mapping                                       |
| Larger survivor, merge->merge flat redirects, unmerge/repoint split after intervening revisions                                                                                          | STORE + mapping + caller binding                             |
| Pending-before-first-effect, crash before/after each home commit/frontier/ACK/publication, duplicate delivery same job, no competing epoch                                               | STORE + mapping + actual fixed participants + DBOS           |
| Affected point pending, unrelated point/creation stays local; cursors restart and lists prepare then fill after finite work                                                              | STORE + Search/prepared/list readers                         |
| One public terminal doc and unique canonical generation rows; hidden original with public terminal and last eligible original; immediate privacy narrowing                               | actual Search canonical + public-filter producers            |
| Entries/labels/sessions/copies/Collection originals, order/notes/multiplicity, latest seq conflict, Undo as new write, terminal new writes                                               | actual Commerce ordering + owner APIs                        |
| Follow support 0/1 transitions, merge/split, >100 rows, crash between withdrawal/addition, stale old-destination first apply, epoch-crossing terminal cleanup no resurrection            | actual Library producer + native source/account fencing      |
| Accounts same receipt waits pending->published in SAME DBOS merge/unmerge step, crash after effects before journal, no early approval/clear, exact moved-link reversal and unchanged DTO | coordinator + Accounts durable binding + actual participants |
| Ordinary API durable 202 admission, current authorized polling/replay, no false not_applied; native actor/denial/hidden/default worker personas                                          | async HTTP operation binding + final caller composition      |

No test changes a pre-existing/frozen acceptance or treats missing native ports as successful readiness.

### Mounted HTTP acceptance and unbound schedules

`test/semantic/identity-operations-http.test.ts` uses the actual shared `createSemanticDriver()` with its real
Accounts registration/token/suspension producer, Access, migrated kernel database and mounted production kernel.
Its support creates subjects through HTTP, uses actual grant administration for revocation, and writes personal
follows, entries and repeated Collection occurrences through their native HTTP routes. It creates no second fixture
database, substitute participant, fabricated runtime option or completion override. The overflow population follows
the existing native epoch helper's migrated historical rows in that same shared database; it is not a bootstrap ACK.
Existing native Search 13+6 outcomes and both epoch suites/support remain required and unchanged.

The frozen HTTP scenario titles are:

- `merge admission returns one durable operation with same-key replay and different-body conflict`
- `currently authorized pending poll exposes only operation id and done false`
- `polling after current merge grant revocation is concealed and denied replay has no identity effects`
- `polling a hidden original cannot disclose its public terminal or operation result`
- `cap4097 rejects before any pending job control epoch revision redirect receipt or outbox effects`
- `fresh unrelated revision1 creation remains usable without Search while an identity operation is pending`
- `admission and replay preserve stored follows entries and repeated Collection occurrences`
- `the pre-suspension revoked bearer receives401 invalid_credentials on merge admission`
- `unknown operation GET is concealed and pre-suspension revoked bearer polling receives401 invalid_credentials`

The first identity assertion is the actual POST status/DTO, before any absent-producer assertion. An absent STORE or
participant therefore exposes the current HTTP red, rather than failing only on a future export. Effect snapshots
include installed native identity tables, control partition, revisions, redirects, membership, receipts, outbox and
stored references. Missing identity tables are NOT evidence that the pending/control/epoch portion has passed.
The shared driver's own ordinary link relay is paused before effect snapshots so its unrelated commands cannot
race identity denial assertions; this neither pauses nor acknowledges an identity participant. Personal owner
authority comes from the production owner formulas, not fabricated Global grants. Receipt replay compares native
transaction ID AND component. The suite has no skip, todo, permanent throw or
successful test adapter. Admission preservation is not proof of preservation through completed maintenance.

The following exact integration cells are **NOT YET FROZEN**. They remain required outcomes; their prose is not a
claim of executable coverage. The native STORE and bootstrap exports are implemented. Mapping maintenance and
complete Search/Library coverage remain missing; coordinator exports exist and preserve those unavailable
boundaries. Do not invent producer schema or native proof to make this suite green.

| Scenario title                                                              | Required native schedule and missing prerequisite for owner review                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published completed DTO only after actual fixed Search and Library receipts | Hold mapping, Search and Library separately before ACK custody; poll pending with either ACK absent; reconcile both actual receipts, publish once, then assert the exact completed DTO. Requires real adapters, STORE/coordinator and a controlled hold/release at each native ACK reconciliation and immediately before publication. Ordinary projection pause is not this port.                                                                                                                                      |
| Pending crash restart and same receipt                                      | Kill/restart the actual identity worker after admission commit/before dispatch; before and after each mapping/home-effect commit, frontier commit, local ACK commit, control ACK custody, publication commit and DBOS result journal. Replay the same POST and compare operation, job/epoch and native transaction ID plus component of every retained receipt. Requires worker lifecycle control and durable commit barriers; a lost returned promise is not process recovery.                                        |
| Completion custody includes every prior removal addition and fence          | Interrupt between withdrawal and addition at different homes, after each gate install and before published fence installation. Deliver duplicate, stale, wrong-transaction/same-position, wrong-component, wrong-job/epoch/version/scope and missing receipts; none may publish or forget a prior half-effect. Requires home effect/fence receipt enumeration and controlled barriers on the actual producers, plus real Search target/incarnation receipts.                                                           |
| Fresh creation has exact self mapping independent of Search                 | Hold actual Search unavailable during pending work; create revision 1 and read the exact native self mapping without advancing the structural epoch. Requires STORE creation hooks and actual Search outage control. The frozen HTTP case proves revision/read behavior with the shared driver's absence of a Search worker only.                                                                                                                                                                                      |
| Completed maintenance preserves personal originals                          | Run the real published merge/split/repoint with nonempty follows, entries and repeated occurrences, retaining stored IDs, notes, order and multiplicity byte for byte. Requires actual participants/publication; the frozen admission case does not certify completion.                                                                                                                                                                                                                                                |
| Native suspension authentication and Accounts sign-in evidence              | The two HTTP cases above require the actual pre-suspension bearer to receive 401 invalid_credentials with the exact invalid_token challenge on POST and GET, even for an unknown operation. Accounts owns correct-password 403 ACCOUNT_SUSPENDED/no-session and wrong-password ordinary401 evidence in its native suspended-sign-in suite; no still-valid suspended native persona or additional credential producer is required. The defensive verified-suspended403 branch is not a native integration prerequisite. |
| Accounts same native operation waits within its existing DBOS step          | Hold publication, crash after effects before step journalling, redeliver the same verify/unverify receipt and prove no approval/clear pending until publication, with unchanged successful DTO. Requires actual publication barriers and Accounts workflow inspection; no extra polling step.                                                                                                                                                                                                                          |

These are missing controlled observation/lifecycle prerequisites, not proposed test-only completion APIs. The owning
STORE/coordinator, Search, Library and Accounts producers must supply actual controls before these schedules can be
frozen. Do not revive identity-basis, home vectors or per-page replay as a substitute.

## Inspected native evidence

Read the full identity shaping ledger and settled identity decision, Semantic Identity/Account agents sections,
filtered-list canonical identity, Library README, private-follow-counts and library-profile-consumers documents.
Native evidence inspected: `merges.ts`, `merge-moves.ts` and its member/redirect/page SQL, redirect migration and
outbound-relation phase migration, `account-agents.ts`, `links.ts`, `command/command.ts` (currentCommand/native time,
authorization-before-receipt/replay), `access/agent-verification.ts` and `agent-verification-work.ts`, Library follows
and work registration, `work/registry.ts`, `work/modules.ts`, `worker.ts`, `rating/merge-job.ts` durable work, Search work/runner/indexer/source and generation helpers, native
creation SQL, and ordinary merge HTTP/problem schemas. For cutover adoption, also read the already cloned PostgreSQL `src/backend/commands/trigger.c`
(from its local git object) and `indexcmds.c` (trigger installation locking, old-writer draining and older-snapshot
waits), and DBOS `src/dbos-executor.ts` (`runInternalStep`, body-before-result journalling and replay). These are
read-only evidence under the reference paths listed in the integrated reports; no implementation was copied.

## Native cutover adoption

Legacy deployments require actual scheduler/bootstrap closure and native owner epochs at all 4096 native partition
homes, including empty and unselected homes; each has sixteen routes. Fixture seeding is before final guards. `readEpoch` is not an
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
across all 4096 legacy slots, decrementing once per validated slot; a zero counter alone is not proof. A fresh
installation may instead prove native absence under the installation/writer cut described below; that proof is
separate from topology custody and never supplies fabricated home receipts.

Post-conversion births continue source-locally with exact self evidence. They need not keep a finite legacy drain
permanently open. Structural admission on a new original waits for actual enrollment custody and never guesses a
singleton from a missing control row. Current mapping observation does not wait for list/preparation/publication.

### Flat generations, retention and local reclaim

For each partition q, let Gq and Aq be its current groups and originals. At EVERY durable/crash/replay/abandon step,
full generations are at most **Gq + 4P**, and physically retained memberships at most **Aq + 4P·4096**. With P=1 these bounds are **Gq + 4** and **Aq + 16384**. Count actual
physical home, not logical job locator. Bootstrap uses actual native source group/original counts for Gq/Aq, never only the count of already sealed
new headers. Source legacy memberships, their retained exports and new shadow rows are included in the physical
copy ledger before each allocation. A bootstrap that cannot reserve the next bounded copy must reclaim or pause
locally; bootstrapReady does not excuse storage. Current groups share unchanged flat generations; each charged attempt
needs at most two retained inputs and two outputs. Current inputs are not double-counted as extra until retired.
The transactional allocation ledger names every physical copy and partial payload. Duplicated export pages,
outbox and workflow payloads spend the SAME membership allowance; a materialized member list is not free history.
Store exact immutable range/receipt locators where sufficient instead. Original basis belongs in the existing
source row/point where the native plan proves the bound; an inverse index is not another current membership copy,
and any alternative physical copy must be charged explicitly.
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
are not immutable old-delivery custody. `access.agent_identity_intent` now preserves that source independently
of the pending marker. Its native verifier runs under the account-home command and current account fence before
receipt lookup; the released binding carries private WeakMap custody into group admission. Native Global
`subject.merge` authorization is unchanged. A source owner epoch change, missing original decision/pending proof
or digest mismatch remains retryable with the exact Accounts source locator; current pending fields never repair
historical proof.

The SAME Accounts workflow performs bounded delivery/admission steps, then bounded indexed native published-state
probes and durable `DBOS.sleep` OUTSIDE a step, before existing approval/page write/finish or removal/reversal finish/
pending clear. No worker or transaction is held through an outage, and no new queue, permission, DTO or public poll
protocol is introduced. DBOS callback-before-result journalling requires same-receipt replay after effects commit.
Busy/overlap, local capacity, guarded handoff or source unavailability retry the SAME intent/receipt with backoff;
they never become denied review or AccountAgentVerificationError. Success requires actual publication, not a
redirect revision or fake readiness. The original workflows now redrive bounded source/admission/publication
steps with durable sleep and independently probe mapping and both fixed participant completions before each
success stage. A separate publication step also covers an old journalled merge/unmerge result. The narrow typed
adapter resolves only the coordinator module's `resumeIdentityEpochJob` and `waitIdentityEpochPublished` exports,
which `identity-epoch-coordinator.ts` delivers. Until native delivery publishes, the call stays retryable, retaining
the original intent and workflow, with no publication or undo substitute. Mapping of an admitted account-agent job
re-reads the original Access source for its exact intent at the account home (`admittedAccountMappingSource`) and
releases that home before any destination work; a moved, fenced or absent source is retryable unavailability.
Actual positive native delivery, historical recovery from complete original custody, crash schedules and inclusive
Cost remain integration debt.

Decision: Accounts verify/unverify mapping is admitted from the original Access source at the account home for the
exact admitted intent; the subject.merge-only and reversal refusals are removed. Ordinary merge eligibility does not
apply to linked account-agent subjects. Native `apply_identity_epoch_mapping_source` permits those linked originals
only for an account-agent.verify/unverify job on the same mapping fence; ordinary merges still refuse them.
Accounts receives `resumeIdentityEpochJob` and `waitIdentityEpochPublished` from `identity-epoch-coordinator.ts`;
the public Semantic barrel does not re-export them, because that value edge closed a coordinator cycle.
Empty-home ALL-Library coverage seals after a committed 16-route original scan with no building plans and no members
of this job's originals; homes with collections still require the live Source frame and six-driver manifests.
Fewest tests: keep the existing Accounts mapping drain, JSONB reviewed-vote consent (including JSONB object-key
order), bootstrap, voter, growth, merge and `identity-epoch-store` exact-self cases; do not add a second suite.
History composition binds `IDENTITY_HISTORY_ACCOUNTS_DECLARATION` as a typed getter with numeric reached
multiplicities, and Access original-work reads the installed Source child through that same binding.
Exact-self creation is this Identity producer: `writeSubject`, unlabeled account-agent birth and imports call
`initializeSubject` in the same revision-1 command, with native `subject:create` authorization and executor
transaction identity; `identity-epoch-store.test.ts` covers commit and rollback.

The three source roles are registered in Access's existing indexed erasure inventory. Source roles also travel
through the existing Semantic receiving-role binder when claims, reservations and accepted pointers commit.
The source minimizer and consumer-aware discharge/transfer into shared receipt/outbox/DBOS custody are not
implemented by this source table. Enumeration does not certify erasure or authorize removal of live delivery proof;
these copies remain unfinished obligations until the physical owner supplies that custody.

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

Use the delivered account terminal T, participant-owned locator fences, `recordLateErasureItem`,
`resolveLateErasureItem`, `acknowledgeErasure`, `advanceErasureCompletion`, `readErasureStatus` and erasureWorkModule.
`recordLateErasureItem` requires a live account-home command transaction that already holds that participant's own
locator fence. `resolveLateErasureItem` runs only after actual minimization or purge commits. Neither helper creates
or closes a fence, enumerates roles or minimizes; those physical owner producers remain missing. A participant's
own ACK follows its own closed fence, all located and known-role dispositions, its minimizer and shared receiving
custody. It does NOT wait for `readErasureStatus.complete`, other participants, the overall frontier or global open
work. A truly unfinished copy independently leaves its owner unfinished.

Access owns input-free `erasure_locator_work` keyed by workflow id. The required effects relay opens one row for each
registered locator effect before `startWorkflow` or enqueue; `opened_at` is database milliseconds using the same
expression as `workflow_until`. An OPEN row with `opened_at <= workflow_until` holds OVERALL completion for ANY
account; a later-open row does not hold that cutoff, and an unset cutoff is incomplete. ERROR, CANCELLED,
max-recovery and a crash before done stay open. Only SUCCESS/done under the same workflow id or explicit platform
resolution naming that row after the owner handled the copy clears it. A fork, deleted DBOS history, age, alert or
timeout never clears it. Failed-locator-work and overdue/resolution-duty owner deliveries remain required native
dependencies, not ports delivered here.

Overall completion separately requires every fixed A5 ACK, no open late items, the actual effects frontier and no
applicable open locator work. The coordinator and status use one ordered lookup on the OPEN-only `opened_at` index,
ranged by `opened_at <= workflow_until`, oldest first with `LIMIT 1`: constant statements and O(1) examined rows,
with logarithmic OPEN-index blocks. They read no DBOS workflow table or closed history and introduce no
history-based permission. Do not compare authoritative T to a database cutoff or envelope positions to the
BACKLOG-ONLY vector. `readErasureStatus` reports open locator work as outstanding and overdue status under its
existing `outstanding` reporting; this contract invents no callable or status field. An overdue held pass logs only
the workflow id at error level, with no workflow inputs, personal data or locators. The Access
[erasure-consumer policy](../access/README.md#erasure-consumers) and [account-erasure policy](../../../../docs/deletion.md#account-erasure)
own the overdue duty: alert after 24 hours of database age and named platform resolution within 7 days after the
alert, only after the owner handled the copy. These are cited owner-policy values, not Semantic constants. An alert,
age or duty breach never clears the hold or certifies cleanup. Account/queue scoping remains a later option only
for producers that certify every account role their copies can carry.

Late items arriving behind enumeration remain outstanding until actual resolution. Existing
work/retention.ts terminal-history deletion is not erasure/minimizer evidence or authority to forget an unfinished
identity obligation. Actual source locator, failed-work, role-enumeration and physical-minimizer integrations remain
required native owner work, not prose certificates.

Required native erasure schedules include: an unrelated OPEN row with `opened_at <= X.workflow_until` holds X; a
later-open row does not hold an earlier cutoff, so X completes while later rows remain open. ERROR, CANCELLED,
max-recovery, crash before done, fork and deletion of DBOS history before the first tombstone all leave the row
holding. Only same-ID SUCCESS/done or named platform resolution after owner handling clears that row. With all
ACKs, open work or a late item keeps overall completion pending; after actual named resolution and no other change,
X completes on the next coordinator pass. An overdue alert never clears the hold. These are required native cases,
not tests delivered here.

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
an actual physical partition; P=1 is its fixed initial production capacity. Logs mean log(2+size). Rows include filtered,
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
and c_MAX values require actual native storage/producer plan evidence for complete Cost closure. This is not a measured K+body pass. Bounded body size follows constant descriptors and
indexed point/continued work, not a blanket claim that a multi-command acquisition is one transaction.

Actual OP has a different framework: initial time snapshot BEGIN/SET/time/COMMIT =4; serializable transaction
BEGIN, lock-timeout SET, initial timeout SET, partition fence, final timeout SET, COMMIT =6. Thus OP pays
**10 + account fences + authorization/finalization + derived body + actual DBOS enqueue SQL** per attempt, plus
gate work. At most two actual fenced accounts are sorted by the executor; fenceOperationalAccount executes the actual
account-share.sql point once per account (one statement each), including its lock/owner rows and FK/index work. OP adds no command receipt/event/outbox/write-basis/position. DBOS SDK statements
and shared history are not zero and must be captured from actual WorkClient on the SAME native connection.

### Operation evidence

Every growth entry below names REQUIRED tests on activation under `test/semantic/growth-identity-publication.test.ts`
(abbreviated **GI**). That file is not delivered here. Its 1/8/64 values are harness scale factors over seeded
production-shaped populations of thousands of rows (usually 500 × scale), as described by the kernel README's
[Growth checks](../../README.md#growth-checks), not populations of 1, 8 and 64 rows. The smallest scale must exercise
every continuation, raw boundary and first/next page shape exercised by the largest; use fixed-operation and
boundary fixtures as needed without exceeding group or slot caps. Keep the separate 64/512/4096 group and 100/101
raw-work axes unchanged. It must use existing `test/support/growth.ts:checkGrowth`
with `rule: 'series'` and native EXPLAIN examined rows/shared blocks/statements, all actual pools/engine captures.
Leading SQL tags `/* identity:source:<operation> */` and `/* identity:control:<operation> */` distinguish growing
statements. Returned/affected row helpers cannot replace plans. Periodic reclaim/wakeup belongs in `prepare` AND
its own growth case, with no subtraction, local catalogue classifier or exemption for untagged setup. Cold/warm
catalogue/DDL/trigger costs and installation waiting remain visible in their actual phase.

### Coherent cap, ordered prepare/acquire, admit and cancel

- Touches: double-collected at-most-two current
  headers/source versions, compact binding, local owner/slot/attempt/group claims, immutable refs and native
  receipts/closed-home fences.

- Bound: O(1) rows PER home command and O(log A + log G + log M + log E +
  log(R+L+H)) blocks; statement sums above per command, plus both effects-free collection passes. No full member
  scan or global history walk. Planned homes are a fixed descriptor from inputs, job home included.

- Growth check: GI `coherent admission and ordered cancellation stay indexed`, pending/control/history independently 1/8/64,
  group sizes 64/512/4096, P=1 cross-home contention, mixed-count/ABA, uncertain RPC and all-table 4097 no-effects.

### Poll, reconcile and publish

- Touches: indexed original receipt/job, current auth/disclosure, actual native
  mapping/two participant receipts, scope frontier and CAS/wakeup.

- Bound: O(1) rows per fixed native completion
  point; O(log M + log E + log(R+L+H) + log S) blocks; K+body per table, EACH released custody command separately.
  Growing scope/receipt fanout is a continued operation, not a poll scan.

- Growth check: GI `poll and publication
  custody stay indexed`, unrelated groups, E and H independently 1/8/64; native pending/completed/replay/revoked/
  hidden/unknown and out-of-order lower publication/cancel paths.

### Standalone current mapping

- Touches: source owner and mapping/birth basis, one relevant control owner,
  batched pending-membership probe and coherent current/scoped-revision probe; final source validation when
  cross-backend.

- Bound: O(b) rows for b requested originals, O(b(log A+log M+log E)) blocks, plus independently
  charged current privacy/Access. Same backend uses ONE RR: BEGIN, SET, source owner, source basis, control owner,
  TWO probes, COMMIT = **8 statements**. A snapshot is a coherent cut; no extra reread/snapshot without an actual
  counterexample. Cross-backend releases source before control and then revalidates source: source<=10,
  control<=6, **16 total**, or **11** pending before final source visit. A batch keeps TWO probes, not per-ID
  queries.

- Growth check: GI `current mapping remains scoped across released snapshots`, M/E/history independently
  1/8/64; all missing/moved paths, pending-after-source, publish-between-reads, newer pending and fresh self.

### Filtered page and cursor validation

- Touches: existing shared batched owner/epoch observation plus TWO
  control probes, existing per-candidate source points and complete source observation.

- Bound: no separate
  readMapping, extra snapshot/client/control SQL or per-ID loop. Fit direct<=12 statements/backend or composed
  `8+4R_reads` (`R_reads` is the number of DISTINCT ADMITTED READS of the common page, `R_reads <= 16` and total
  output slots `<= 128`), one connection/backend; resource leaves, conditions, dependencies, homes and retained
  `R` minimized obligations do not increase `R_reads`, and `R` has no page-read alias. A mixed `subject.search`
  request is one read with at most 12 statements per backend. The `8+4R_reads` formula applies only to composed
  pages. Existing candidate,
  Access, raw/native plan and physical-query allowances apply. Work is page-derived; no S/D scan.

- Growth check: GI `finite owner pages progress under continuous disjoint identity work`, source size/query support 64/512/4096,
  unrelated A/G/M/E and R/L/H independently 1/8/64, complete excluded/NOT/order changes and cursor start/final/
  current checks. The native Source bindings above are required reds until delivered; samples cannot make it pass.

### Register, arm, summary finish, revalidate and repair scopes

- Touches: actual source headers/structural
  dependency index, inverse `(original,owner,scope)`, OLD/NEW dirty capture, native claims, committed summary/CAS,
  receipts and source-local repair.

- Bound: O(n) examined dependency/effect rows, O(n(log D+log S+log A+
  log(R+L+H))) blocks and K_or_OP+body SQL per native home. Registration scans finite relevant source input in
  retained steps; discovery fanout is continued by original/scope, not a per-page scan. A source with arbitrarily
  many scopes gets in-unit keyset continuation with OLD/NEW custody retained.

- Growth check: GI `complete scope
  registration and reordered summaries stay bounded`, D/S/unrelated history 1/8/64, support 64/512/4096,
  registration versus first claim, move/cancel/delayed messages, all-group versus owner-source isolation.

### Mapping, Search and Library canonical effect steps

- Touches: shared immutable affected streams, actual
  source/engine records, structural directory/candidate/extrema, six drivers, OLD/NEW gate/effect/follow/support/
  total and exact native receipts.

- Bound: O(n) examined rows, O(n(log A+log G+log F+log D+log(R+L+H))) blocks;
  each one-home command pays K or ACTUAL OP plus all effect/wakeup SQL, Search pays native engine work/bytes too.
  Structural fanout follows relevant original/scope existence, not number of repeated session facts. No fixed
  per-fact 14-row formula is valid. Divide remaining durable allowance by captured actual elementary-unit cost;
  any original/scope/extrema with unbounded support has IN-UNIT keyset continuation for support/OLD/NEW halves,
  no requirement that the entire original fit once.

- Growth check: GI `canonical effect and first-apply custody
  stay bounded`, originals 64/512/4096, raw boundary 100/101, unrelated owner/support/history 1/8/64, million same-
  scope sessions, first/deep/empty/replay, legitimate first apply in both orders and follow ACK/directory negative.

### Birth and final writer guard

- Touches: actual revision-1/self mapping, native source fence/claim, OLD/NEW
  capture and same-TX deferred home handoff guard.

- Bound: O(1) additional fixed birth/guard rows, O(log A+
  log(R+L+H)) blocks; at most ONE indexed home-handoff-state lookup per guarded write including deferred check,
  actual native command body/receipt/event SQL additive. No Search/control checkout for birth; correct SOURCE
  home. Capture fanout uses continued dirty work.

- Growth check: exact Access birth/verify files above plus GI
  `native writer handoff covers old and queued transactions`, fixed-data open-XID 1/8/64 ONLY if mechanism probes
  active transactions; otherwise no invented active-XID axis. Catalogue locking and waits are not a free trigger.

### Bootstrap, export, receiving custody and exact-head ACK

- Touches: indexed topology slots, base/member/dirty
  keysets, source export, native control receipt/frontier, released source ACK.

- Bound: O(n) examined rows,
  O(n(log A+log G+log(R+L+H))) blocks, EACH actual command's K+body. Each saved page costs THREE distinct native
  transactions: export, custody, ACK. Legacy closure needs at least ceil(4096/100) topology pages before metadata, with empty homes
  included; actual capacity is smaller after metadata/lookahead. Large page payload/custody subdivides within
  unit, retaining exact source receipt/head across steps.

- Growth check: GI `all-home cutover retains exact dirty
  custody`, 64/512/4096 group/support and 1/8/64 export/history; h+1, lower keys, deletion/move/saved empty,
  crash export->custody->ACK and native failed/control-owner moves. No hidden export full-copy exemption.

### Minimize, reference acquire, reclaim and wakeup

- Touches: locked generation/ref/header, actual owner/shared
  minimizers, indexed retired generation and member keyset, frontier/receipt/wakeup.

- Bound: O(n) examined rows,
  O(n(log A+log G+log(R+L+H))) blocks and native K+body SQL including refusal/empty/wakeup. Reclaim selects and
  deletes each member (k_MAX=2 for that payload); metadata c_MAX explicitly equals the actual plan's owner/fence
  rows + locked header/ref rows + frontier rows + native receipt rows + wakeup/outbox rows + minimizer/custody
  point rows + empty-range sentinel work. These categories ALL count, including executor gate/body FK work.
  Exact maxima for each are a MISSING native plan binding, not c=0. Allocate at most floor((100-c_MAX)/2)
  members ONLY after Performance confirms c_MAX+2<=100. If metadata cannot fit, split minimization/custody into
  prior bounded native units with locked retained state; no zero-progress reclaim loop.

- Growth check: GI
  `reclaim and wakeup retain local physical bounds`, retained generations and R/L/H independently 1/8/64,
  memberships 64/512/4096, first/deep/empty/replay/ref refusal/minimizer failure/crash and other-partition progress.

### Accounts intent, delivery and durable publication probe

- Touches: one account-home intent insert in the
  existing decision/reversal transaction, primary and three role-first indexes, exact source/control custody,
  same-workflow indexed publication state.

- Bound: one additional intent statement with O(1) examined rows and
  O(log(R+L+H)) blocks, plus actual native command/authorization/receipt work already charged to that owner.
  Delivery commands each pay their actual K+body; each bounded read probe pays K_read plus native owner/job
  points, O(1) rows and O(log E+log H) blocks, never a history scan or request-held wait. Durable sleep adds real
  DBOS shared-history work, captured independently, no command effects.

- Growth check: existing
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
| Library owner write order    | Retain existing native allocator rollback/replay, wrong-home/authorization, bigint and independent-owner cases. Separately require actual set/equal-set/clear/Undo writer allocation, legacy-null readiness refusal and bounded cutover, live/archive distinction, and separate exact terminal counter cleanup under Library erasure custody. Helper-only consumer probes do not prove those production paths.                                                                      |
| Public HTTP                  | Native POST body/Auth/quoted key/202 ONLY after admitted/Location and same authorized replay; conflicting key; poll pending/completed/unknown/denied/revoked/hidden original concealment. Native held pre-suspension token 401 invalid_credentials/Bearer invalid_token and Auth sign-in 403 actual shape, never invented valid suspended bearer.                                                                                                                                   |
| Accounts publication         | Verify and reversal keep successful DTO and wait before approval/page/finish/clear. Busy/capacity retry same native decision/reversal intent, crash before/after job return; already-verified/reversal replay waits publication; no worker held during durable sleep.                                                                                                                                                                                                               |
| Cutover topology and birth   | Locked native absence custody for fresh installation, or EXPLICIT real legacy scheduler/bootstrap closure on all 4096 including empty/unselected homes and actual owner epochs; lower-key births after frontier, failed birth rollback/revision1, ordinary/import correct source home and named/unnamed person/org/software account-agent births. Legacy seed before final guard. Missing native bootstrap callable remains red.                                                    |
| Writer final handoff         | Actual verify AND reversal in flight before/after installed home barrier/deferred SAME-TX guard, queued merge/move/link/reversal continuations. Owner move shows availability retry only; separate legitimate native guard race proves handoff. Active-XID1/8/64 only when inspected.                                                                                                                                                                                               |
| Native structural semantics  | Larger survivor, split/restore/repoint, overlapping undo/replay preserve direct terminals and exact immutable counts; first/deep/empty/shared100/101 changes include overlap/lookahead/retries without free row101; current flat lookup never follows ancestors.                                                                                                                                                                                                                    |
| Export/custody               | Lower dirty head, OLD+NEW key-changing update, delete negative, saved empty replay, source export crash before custody and custody before source ACK; failed ACK of h leaves h+1; failed/moved control custody retains exact page and native receipt.                                                                                                                                                                                                                               |
| Retention EVERY step         | Assert Gq+4P and Aq+4P4096 from ALL native tables after every commit/crash/replay/abandon/bootstrap/unsealed/export/partial deletion/move; no fifth copy, false G=0 or R/L group. Minimize real undo/reversal/move/cursor refs, generation ref-lock races and missing-minimizer refusal. Local admission refused before native empty proof, succeeds after it; another partition progresses. Relation/index byte deltas and examined work, not three small jobs or delete.rowCount. |
| Terminal/late/failed custody | Require the native erasure schedules above, each owner's own fence and minimizer, shared custody, and participant-own ACK independent of overall state. Preserve actual Auth `deletePersona` full flow; direct tombstone proves barrier only. No Semantic ref exhaustion claiming Library purge.                                                                                                                                                                                    |
| Full publication             | Actual mapping + fixed Search + full Library receipts with all prior effects/fences custodied; missing/delayed receipt stays pending, crash/replay publishes once, public canonical uniqueness and cursor currentness, crossing-epoch delayed first positive/terminal purge cannot resurrect support.                                                                                                                                                                               |

Existing `test/semantic/identity-epoch-admission.test.ts`, `identity-epoch-publication.test.ts`,
`identity-operations-http.test.ts`, `identity-epoch-cutover.test.ts` and their three native support files are evidence.
Their globally sole-job assertion, implicit bootstrap via readEpoch, legacy-only snapshot, stale wrong-destination
first-apply case, legacy fact-table directory assertion and hypothetical suspended-bearer expectations cannot freeze
the new boundary. Preserve the original safety/DTO/custody outcomes in the REQUIRED schedules above; revise native
SPEC/executables retain their business and custody outcomes while native scoped STORE and bootstrap acceptance
replace the obsolete global-control assumptions. Earlier setup failures establish no native Cost result. Full
publication still requires the actual mapping and fixed participant producers.

## Evidence and review boundary

Read the full current owning documents, existing contract types, admission/publication/HTTP/cutover cases and
support, actual native writer/command/read/operational/work bindings, Library structural owner/source/fact-version
and Search source/scope-source/producer-consumer/privacy contracts. The two integrated cutover reports (current
`a73bcefb2fe9a901d22478bb4e3d774c06186c55`, deep `e9ae39f06176b66a4026533812f07c6e00e46dec`) and both independent
concurrent reports identify candidate mechanisms, not native performance evidence. The integrated current report
also exists at `docs/research/identity-concurrent-groups-current.md`. Their superseded global-summary alternatives
do not remain a second contract.
The integrated deep report's CAS/basis distinction, read-only replay ordering, once-per-home/job quota and physical
payload/fence accounting apply here; its receipt-home-first priority scheduling and global OPEN/CLOSE alternatives
remain superseded by ordered first-resource capacity and source-scoped committed summaries.

The delivered Library allocator/schema and `test/library/owner-write-sequence.test.ts` are evidence only for
the primitive. Its test-only entry consumer is explicitly not production writer integration or a canonical
publication receipt. Composed producer Cost must add the two allocation statements and their counter/index
work to its actual command body where allocation is required; repair/rekey/purge must not allocate.

Read-only reference evidence: PostgreSQL `src/backend/commands/trigger.c`, `indexcmds.c`,
`src/backend/utils/time/snapmgr.c`, `src/backend/access/heap/heapam.c` in
`.reference/library-shelf-maintenance/postgres` (sparse files read from git objects where needed), and DBOS
`src/dbos.ts`, `src/dbos-executor.ts:runInternalStep` in `.reference/search-worker-outcome-harness/dbos-transact-ts`.
Native installation locking/snapshot rules and body-before-result journalling motivate the required schedules;
no reference implementation was copied and no new external research is claimed.

Complete-query producer bindings, native custody and ownership require actual implementation evidence. All nine
Cost items and derived body/metadata/page-fit plans remain obligations for complete publication. Missing scope
producers, owner-transfer bounds, account source intent/delivery, minimizers/locators and fixed participant bindings
remain explicit native obligations. The implemented STORE/bootstrap producers do not replace those records.
Formatter success checks bytes only. Integration alone does not attest native performance, complete publication
or satisfy a main/root runtime gate.

### Native home-binding inventory and recovery cost

Every authoritative identity primary/unique key starts with `partition_no` or `route`. Job children reference
`(partition_no,job_id)` locally; receipt uniqueness belongs solely to
`identity_epoch_receipt_binding(partition_no,receipt_key)` at the routed actor/account home. The forward migration
preserves old job IDs, receipts, intents, epochs and transaction IDs, imports accepted pointers, and requires a
released original native job/write-basis verification before actor-home confirmation. It creates no guessed ACK.

The physical additions are counted as retained history/custody, including indexes and native framework rows:

| Relation                               | Physical home and retained contents                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_epoch_receipt_binding`       | Actor/account home; one exact key/digest, account role index, current generation and immutable accepted job pointer.                                                                                 |
| `identity_epoch_receipt_claim`         | Same home; one immutable intent, receipt, proposed job/home/epoch, scope and at most two exact input/source bases per generation.                                                                    |
| `identity_epoch_receipt_claim_commit`  | Same home; one actual native confirmation per generation, including migrated confirmations.                                                                                                          |
| `identity_epoch_receipt_closure`       | Same home; one actual native close receipt per planned home per retired generation, at most two.                                                                                                     |
| `identity_epoch_admission_handoff`     | Each receiving home; one immutable job/scope/source-transaction locator plus at most two local immutable input bases. No membership vector.                                                          |
| `identity_epoch_admission_source_hold` | Actual original source home; at most two source bases per attempt, native transaction and irreversible closed disposition. Active holds serialize with local dirty-key capture.                      |
| `identity_epoch_admission_validation`  | Job home; one source hold receipt per admitted original source basis, at most two.                                                                                                                   |
| `identity_epoch_bootstrap_basis`       | Receiving home; one native receiving receipt header per export. Mapping basis is read from the already required local home gates written by that transaction; no retained duplicate original vector. |

All head/history/receipt/proof/native commit/outbox/write-basis copies spend the existing R/H storage and command
budgets. Constant keyed hops add no allowance. Input/group references and handoffs spend existing G/A/P retention;
no extra full generation or member list is allocated by binding. Accepted history survives job minimization.
Account-bearing receipt/claim copies and `identity_epoch_receipt_account(partition_no,account_id,receipt_key)` are
native discovery surfaces for the sole local erasure owner. Actual Ad1 minimization/shared-copy ACK binding remains
named pending coverage; this producer supplies neither another erasure engine nor a fabricated completion.

Source finalization takes released actual native source holds, then separately revalidates current receiving
owner/generation/claim evidence and takes source receipt custody locally. Its SQL joins only job-home source and
validation records. Source ACK reads a released exact receiving native receipt and local gate mapping basis before
its source command, whose SQL revalidates source owner, subject and captured heads without a foreign group join.
Receiving acquire joins only its retained local handoff, local group, owner, attempt and slot; close remains atomic
with first absence and takes no capacity. Receiving waiters are discovered from local handoff/attempt records.

Default startup first calls `installIdentityEpochBootstrap(pool)` before DBOS resumes work. Job immutability
keeps intent and receipts fixed; admission may write pre-arm phase and cancellation locators. Writers cast those
locators to uuid and pre-arm epoch/position to integer/bigint in CASE assignments. Topology custody
binds the sealed transaction as uuid. The one-time
installation cut drains structural source and custody writers with SHARE ROW EXCLUSIVE relation locks in a
READ COMMITTED transaction. Its post-lock scan includes subjects, orphan revision/backlink sources, redirects,
members, uncaptured dirty heads and retained bootstrap work. It excludes a native birth only with actual
revision-1/self-mapping/self-gate same-transaction custody. A SERIALIZABLE command snapshot minted before those
locks would miss a drained writer; it is not used for this migration inspection. Under those same locks the
installation enables the deferred birth guard and commits immutable `identity_epoch_installation_cut`
custody. An interrupted cut rolls back atomically; a committed cut without native closure remains unavailable.
Even all 4096 retained native topology closures cannot substitute for the missing installation receipt.
While a cut exists without a valid installation, remaining() counts unclosed topology homes so bounded batches
can finish; cutover stays blocked until the installation receipt. An empty selected frontier is a no-effect
repair pass, not an unavailable failure. Generation-1 is the current Search physical owner until a live
generation is readable.

A separately released home-0 command verifies the committed cut and installed guards and records the actual
bootstrap native commit plus `identity_epoch_installation` closure. The exported result is
`{mode: 'absence' | 'legacy', installationXid: string, native: IdentityNativeReceipt}`. It is custody, never an
Access decision or a caller-supplied completion bit. Restart reuses this exact immutable proof; it does not
repeat source inspection or reset topology. An absent/moved native receipt or invalid capture/birth guard
cannot authorize absence readiness. A valid absence cut avoids the universe sweep without fabricating any
source export, mapping, participant ACK, home closure or topology custody. Actual legacy input still requires
all 4096 native source-home closures, including empty homes. Standalone native legacy migration fixtures retain
their original full topology behavior. Default DBOS effects, all registered queues and Community's 30s settle
remain unchanged.

The installed deferred guard reads only the birth's source-local revision 1, self mapping, gate and native
owner; all must commit in its actual transaction with a positive epoch and matching native transaction ID.
There is no ordinary source-command lookup of a global installation row. A late legacy writer, including one
whose transaction predates the cut, cannot commit an uncustodied birth. Subsequent dirty-source discovery uses
released indexed pending-dirty points when no bootstrap-home row exists; it never scans the topology to make
a point mapping ready. Existing exact-head source ACK, owner, receiving and dirty-frontier rules still apply.

Installation retains exactly one home-0 cut row with its primary index and one home-0 closure row with its
primary index and two local FK checks, plus the native commit/indexes and normal outbox/write-basis copies.
Neither row contains an account role or duplicates receipt-ledger identity. The native closure command and
restart verification, migration lock/scan/catalog work, deferred per-birth indexed checks and dirty discovery
points/bytes are charged to the existing installation/G/A/R budgets; a constant hop grants no allowance.
No 4096 home receipts are charged or claimed for absence. Legacy exports and ALL retained receiving/source/
topology copies keep their existing budgets. Full erasure/shared-copy binding and all-nine Cost certification
remain independent obligations.

Default legacy bootstrap effects execute at most 100 existing bounded native steps. Initial closure uses eight released
home pipelines and amortizes topology overhead: one local command selects at most 100 unclosed topology slots,
advances the cursor; one later local command takes at most 100 independently released native closure receipts.
A contended home is skipped inside the batch so successful empty-home seals still reach that take; a later batch
reads the retained native closure instead of re-exporting.
Four initial native wake events seed bounded chains under the same worker registration. The first actual source ACK
in each batch commits its continuation at that source home, preserving the existing queue partitioning instead of
serializing every batch on topology home 0. A crash before the ACK is recovered by the already durable DBOS effect.
It decrements only newly retained custody and never rewinds the
scheduling cursor. These bounded transient locators add no retained copy or membership vector. Dirty-home repair
keeps its individual scheduler steps and four pipelines. Pool and queue limits are unchanged. Individual
source export/receiving/source ACK commands, raw100 bound, all4096 closure and every registered queue remain intact.
An initially empty legacy home uses three local storage functions to fuse statements within those same three
native commands. Its complete indexed local subject/member/dirty census commits a retained generation-1 empty
page and native export; a separately committed receiving command validates that page/native owner and retains
the ordinary custody and basis; a third source command verifies both exact native receipts before ACK/sealing.
The source closure checks current dirty heads, so a concurrent h+1 cannot be cleared. All page, custody, basis,
three native commits, indexes, outbox and topology copies remain charged exactly as for the ordinary empty
protocol. No extra record, command allowance, larger page, queue or pool is introduced. An interruption at any
stage resumes the same retained page through the ordinary native recovery path. The nested-function RLS witness
covers these commands and rejects ACK before receiving custody. Dirty repair merges known unfinished and newly
dirty homes in cursor order before wrapping; an unfinished lower home cannot starve a newly dirty higher home.
The shared relay refills released worker slots from its current fixed-topology scan, retaining its normal four-worker
limit, pause/stop drain and poll interval. It does not discard the rest of a scan after its first four launches,
which would impose at least 102.4 seconds of polling on 4096 actual native homes. No checkpoint is fabricated.
This changes scheduling overhead, not closure meaning or Community's default 30s settle deadline. Native growth
64/512/4096, nested-function RLS/crash schedules and the actual default Community worker are the focused witnesses;
full participant/output-generation, all-nine Cost, Content consumer acceptance and main/root promotion remain
separate obligations.

### Receiving effect interface and native Source custody

The selected Source owner is `library/native-source-custody.ts:createNativeLibrarySourceCustody({pool,clock?})`.
Its closed `NativeSourceIdentity`, frontier, capture, custody and work unions are authoritative. Receiving uses
`capturePage`, `finishCapture`, `readAndHold`, `revalidateHold` and `releaseHold`; it defines no Source callbacks
or Source SQL. The actual owner implementation supplies these operations. Availability alone proves no
receiving completion.

The additive receiving declaration correction is `IdentityReceivingSelection.capture?: {identity: NativeSourceIdentity, frontier: NativeSourceFrontier}` and
`IdentityReceivingSource.native: {identity: NativeSourceIdentity, captureId: string, holdId: string}`. Existing
preparation, lookup, record, reconciliation and admission signatures and their native records remain. Preparation
without a native capture frontier is unavailable. Preparation resolves that completed frontier through the actual
owner finishCapture operation before trusting its transaction/component. Serialized brands, raw metadata and caller keys establish no provenance.
`IdentityReceivingCaptureInput` carries the owner's identity/frontier/work/deadline and a raw limit;
`IdentityReceivingCaptureResult` is exactly the union of the owner's capturePage/finishCapture results.
`captureIdentityReceivingSource(pool, selection, input)` makes one bounded call, returning a resumable frontier
or the completed native capture. It binds the owner's effect key to job/epoch, participant/version, full scope,
original/effect/disposition and native identity. Capture dependency rows remain the Source owner's truth and
are not ordinary destination-disposition authority.

Receiving preparation takes the fresh Source hold with strict `readAndHold`. Admission uses `revalidateHold`
on the same native command client and authoritative time as the local receiving lock and mutation.
Reconciliation releases the effect home before control custody, then releases
control before the Source hold. It must prove the exact native effect/frontier and control custody before release;
a job-wide participant receipt cannot replace these records. Native physical/privacy/cost proof remains required
after integration, including OLD/NEW/first-apply/handoff outcomes. No unavailable result counts as coverage.

The selected owner's additive `revalidateHold` has the identical input/result to `readAndHold`.
`identity-receiving-effects.ts:holdSource`, invoked by `admitIdentityReceivingEffect`, resolves the already
retained `(identity,captureId,holdId)` and validates its exact native receipt through that operation, including
the applicable current owner/account fences even when the live generation changed. Unavailable stays unavailable;
there is no fallback to fresh `readAndHold`, raw metadata or serialized custody. Retained custody grants no
new read, complete observation, ordinary destination-disposition or general admission authority. Only the exact
accepted receiving record and its local gate admit this effect; native effect/frontier and control custody are
still required before release.

The scoped producer's closed request/result declarations are exported by `identity-scope-types.ts`.
Source keys distinguish native Library and public catalogue identities. Public capture is the opaque native
`PublicIdentitySourceCapture` declared in `identity-scoped-public-source.ts`; it is never a Library capture.
Each delivery names the Source scope and immutable admission receipt. Receiving records are lookup locators,
not completion verdicts. Registration and bounded repair may return pending. No pending result establishes
coverage, publication, permission or a current reader observation. The indexed pre-arm protocol closes the
claim-to-Source boundary before the first pending claim; asynchronous arm delivery cannot establish it.

### Public COMPLETE output capture boundary

A Collection output capture is a separate variant of the existing public capture producer. The generic
registered `NativePublicSource` capture retains its Source and Subject homes, expanded definition dependencies,
population, excluded and order originals, writer guards and claim/first-apply fencing. A generic capture or an
`active_explicit_output` receipt does not establish canonical coverage of a Collection publication.

The output variant receives its native identity from Commerce's
`collection-source-native.ts:bindAndHoldNativePublicCollectionOutput`, on the original Collection-home
`runCommand` Pool/client/time. The binder establishes the capture-specific receiving epoch and effect key;
the caller cannot supply either as authority. The native hold and Semantic accepted binding share the fixed
`identity-public-output-capture` executor component and commit or roll back together. The accepted record binds
the exact full activation, actual COMPLETE publication, immutable registered definition digest and native binding
digest. A returned acceptance is an uncommitted locator. Released replay independently verifies its original
Core/native provenance before checking fresh eligibility; it never resets a stale capture to a new publication.

The released output driver consumes at most 100 native raw keys per page with exact persisted continuation.
It retains the full native identity/publication and acquires current original **and terminal** Subject closure
outside Collection transactions. Neither raw page/count equality nor a sweep of 4096 homes substitutes for that
closure. Zero-output exhaustion still requires the real COMPLETE publication and genuine closure. Sealing uses
the original Collection home, complete retained closure and genuine native hold/current locks through commit.
The seal and its executor receipt are immutable. Changed, moved, private or incomplete authority refuses fresh
use while retaining uncertain custody.

Commerce resolves Semantic disposition through
`identity-scoped-public-source.ts:lockPublicIdentityOutputCaptureDisposition(tx, selection, context)`. The
selection is the exact capture/hold/binding digest and disposition receipt; the context carries the genuine
Pool, command time, deadline and original allowance. Resolution accepts neither a proof callback nor a caller
disposition body. A staged same-command disposition uses the actual shared executor component and deferred
commit constraints; it cannot require its own receipt to have committed already. Released replay independently
checks committed provenance. Applied disposition requires the exact seal and actual successor native retention
installed atomically before consuming the predecessor. Cancelled disposition requires a native cancellation
fence preventing subsequent page/seal/apply/enrollment and genuine closure of all admitted copies and writers.
Missing successor retention or foreign closure remains refusing. A seal, deadline or newer generation cannot
release a hold. Account capture types and private working readers cannot implement this public boundary.

Every literal SQL, control, callback, closure acquisition, repeated current check, native hold, transition,
disposition, release and dispatched failure/rollback prefix must reserve all eight `WorkDimensions` before
dispatch in the caller's original finite frame. Native calls retain smaller child ceilings and remainders;
unknown SQL refuses. This addition receives no allowance from historical public-capture envelopes and cannot
claim readiness from a sufficient final aggregate, a refund, or a second ledger. The actual producer and native
owners must supply their literal and nested operation bounds before consumer composition.

### Public output capture execution and composition

`createPublicIdentityOutputCapture(config)` is the executable producer. `accept`, `capturePage`, `seal`,
`ready`/`revalidate`, `membership`, `prefix`, `enrollConsumer`, `apply` and `cancel` each require the caller's
`{deadline, allowance}`; no operation allocates a production allowance. Capture ID is also the Source scope ID.
A locator can be serialized; its original accepted native/Core/outbox provenance is re-resolved on every use.
Acceptance and persisted replay additionally compare the identity's output generation and full activation
transaction/decimal position/source generation with the returned native publication, and its owner epoch with
the accepted component. An internally mismatched tuple refuses before use; these local comparisons dispatch
no additional SQL and cannot replace the native hold or provenance checks.
The explicit scoped-registration variant is `{kind:'public-output',capture,allowance}`. Current validation accepts
an original-frame allowance and the actual caller transaction when supplied. It resolves the persisted locator
inside that same metered home, then locks the native hold and current publication through commit. It never
casts a public identity into Account custody. Scoped output results retain the complete eight-axis debit as
`work.outputWork`; consumers settle that receipt instead of its legacy four-axis projection, never both.
Original generic capture paths retain their original bodies.

One continuation consumes `min(requestedLimit,8)` raw output keys (requested limit is 1..100). Original mappings
and terminal self-mappings are double-collected in released source/control snapshots. At most 16 distinct
original/terminal cuts are planned. The immutable plan is persisted before any foreign dispatch; each control
home installs both actual inverse directories and an immutable, same-T native cut. Its slot serializes a late
send against cancellation. Final page commit rechecks every retained mapping, original scope revision/active
count, native hold/publication and exact pending version. It retains raw keys, native tuple, mappings, cuts and
real cut receipts in the rolling manifest. A retry resumes the exact same pending plan or refuses; it does not
invent a new publication. Sealing requires exhausted progress with no pending plan, original revision 1 and no
active preparation. Current readiness, membership and prefix take both hold and publication locks; membership
has at most 100 keys and prefix at most 101 including lookahead. No foreign home is checked out inside a
Collection command.

Cancellation first commits an immutable no-future-use fence. Each subsequent call closes at most one retained
page/plan (16 cuts), then acknowledges that exact closure ordinal. A never-delivered cut is tombstoned with a
real native release receipt. An admitted inverse is deleted in that same control Pool/home/T by
`removePlatformNativeInverse`: it records `erasure_source_commit` immediately (position+1 before the fence)
and deletes `identity_epoch_prearm_inverse` and `identity_scope_inverse` keyed to the cut. A retired boolean
alone is insufficient: the installed pre-arm export still includes such inverses. The producer does not
fabricate editorial write-basis. `capture_erasure_source_removal` and `validate_erasure_source_commit`
accept current-position `editorial.write_basis`, `identity_epoch_native_commit`, or `erasure_source_commit`
whose xmin is this command. Cut release still records purpose `identity-scope-directory-release`. Charged eight-axis cost is
the instrumented delete/commit statements. Any ordinary consumer intent also refuses disposition until its
actual copy/writer closure is installed. Ordinary output closure and identity-job Search closure are
separate authorities. Scoped finish/retire refuse this output branch while that foreign identity-job
closure composition is absent. These refusals preserve all retained obligations.

`receivePublicIdentityOutputCapturePrearm(pool,ticket,work,cancellation?)` resolves the real released native
ticket before opening the Collection command. It invalidates the original scope revision and records the
actual preparation/cancellation receipt, including for a stale retained publication. Source's existing pre-arm
wrapper accepts this finite work as its additive third operand (`outputWork` on cancellation); the caller must
transfer its original remainder and settle the returned receipt, including a refusing/thrown prefix. Callers
without that operand cannot claim an output preparation receipt. No allowance is supplied by the wrapper.

Applied/cancelled disposition rows, native transfer/release and transition rows share one original Collection
transaction and executor purpose. Commerce resolves a persisted stage only for the actual current component, transaction and native xid on
that same transaction; deferred constraints require native component, real outbox event and corresponding
transition to commit together. Semantic persists its genuine distinct successor selection before dispatching native transfer. It binds the
capture/predecessor/digest/original receiving epoch and current component. Native installs precisely that
successor before consuming predecessor or fencing receiving; Semantic checks the returned successor against
the persisted selection. Applied purpose is `identity-public-output-applied`; cancelled purpose is
`identity-public-output-cancelled` and cancellation epoch is exactly `BigInt(original receivingEpoch)+1`. Released replay selects the exact
original disposition and independently validates its committed component and original transition. Faults after
native transfer roll the whole command back. A missing successor, foreign closure or original provenance
retains custody and grants no fresh read.

The canonical concurrent installation input is Commerce's `library/native-public-output-contract.ts`, with
its six agreed native operations and types. Direct imports use those declarations; there is no copied foreign
type, placeholder adapter or callback authority. The owner must compose Semantic's disposition work in its
native frame and charge its own literal SQL, controls and rollback prefix. The producer does not publish a
whole-feature installation verdict when that module or the closure hooks above are absent.

### Public output finite work

`identity-public-output-work.ts` registers literal vectors on all eight axes. Unknown SQL refuses before dispatch.
A key operation reserves eight logical native rows for its indexed input, relation/lock, join and projection plan
nodes; it is a declaration of application work, not a heap/MVCC visibility measurement. Each unique-index check,
FK probe and mutation is counted separately. For reads, one exact relation contributes one point and eight rows.
A root insert/update charges mutation plus its PK; each additional unique index and FK adds one point. The
resulting literal bounds below are reserved before dispatch, including queued deferred checks at COMMIT.
`M/R/P/B/C/W/E/S` are identity metadata rows, native rows, native points, internal/result bytes, candidate keys,
witness keys, empty seeks and statements. SQL text and encoded argument bytes are added to B for every dispatch.

| Literal suffix (`identity-public-output-`)                                         |      M |        R |      P |                              B |   C |   W |     E |     S |
| ---------------------------------------------------------------------------------- | -----: | -------: | -----: | -----------------------------: | --: | --: | ----: | ----: |
| accepted / insert                                                                  |  5 / 5 |  40 / 64 |  5 / 8 |                2114560 / 32768 |   0 |   0 | 1 / 3 | 1 / 3 |
| progress / progress-start                                                          |  1 / 0 |   8 / 24 |  1 / 3 |                     66304 / 64 |   0 |   0 |     1 |     1 |
| component                                                                          |      1 |        8 |      1 |                            128 |   0 |   0 |     1 |     1 |
| plan / advance / close-progress, each                                              |      1 |       24 |      3 |                         131072 |   0 |   0 |     2 |     2 |
| page / seal-insert, each                                                           |      7 |       88 |     11 |                         131072 |   0 |   0 |     6 |     6 |
| original (at most eight mappings, two inserts each)                                |      0 |      256 |     32 |                           4096 |   0 |   0 |     1 |     1 |
| scope-start / scope-seal, each                                                     |      2 |       32 |      4 |                          32768 |   0 |   0 |     3 |     3 |
| scope                                                                              |      1 |        8 |      1 |                           9216 |   0 |   0 |     1 |     1 |
| seal / fence, each                                                                 |      4 |       32 |      4 |                      512 / 256 |   0 |   0 |     1 |     1 |
| fence-insert                                                                       |      3 |       48 |      6 |                           1024 |   0 |   0 |     2 |     2 |
| prefix (k <= 101)                                                                  |      k |       8k |      1 |                            64k |   k |   0 |     1 |     1 |
| membership (n <= 100)                                                              |      n |       8n |      n |                            64n |   n |   0 |     n |     1 |
| definition-size / cut-group / cut-group-read / cut-bridge-lock, each               |      2 |       16 |      2 |          128 / 512 / 512 / 256 |   0 |   0 |     1 |     1 |
| mapping / cut-slot-lock / cut-member / admissions / existing / disposition-locator |      1 |        8 |      1 | 256 / 256 / 64 / 64 / 64 / 256 |   0 |   0 |     1 |     1 |
| cut-slot                                                                           |      0 |       16 |      2 |                              0 |   0 |   0 |     1 |     1 |
| cut-bridge                                                                         |      5 |       80 |     10 |                           1024 |   0 |   0 |     6 |     6 |
| cut-insert                                                                         |     12 |      192 |     24 |                          16384 |   0 |   1 |     9 |     9 |
| cut                                                                                |      8 |       64 |      8 |                            768 |   0 |   1 |     1 |     1 |
| cut-release / cut-released                                                         |  3 / 4 |  64 / 32 |  8 / 4 |                      1024 / 64 |   0 |   0 | 2 / 1 | 2 / 1 |
| cut-live                                                                           |      2 |       16 |      2 |                             64 |   0 |   0 |     1 |     1 |
| release-setting                                                                    |      0 |        0 |      0 |                             64 |   0 |   0 |     0 |     1 |
| disposition                                                                        |      8 |       64 |      8 |                          32768 |   0 |   0 |     1 |     1 |
| disposition-insert / transition, each                                              |     14 |      136 |     17 |                          32768 |   0 |   0 |     3 |     3 |
| gate-start / gate-close                                                            |  3 / 5 |  48 / 56 |  6 / 7 |                   32768 / 1024 |   0 |   0 |     2 |     2 |
| gate / stage                                                                       | 6 / 17 | 48 / 168 | 6 / 21 |                   1024 / 32768 |   0 |   0 | 1 / 3 | 1 / 3 |
| consumer                                                                           |      9 |      104 |     13 |                         131072 |   0 |   0 |     8 |     8 |
| plans                                                                              |      1 |        8 |      1 |                          66560 |   0 |   0 |     1 |     1 |

The native validator is one SELECT over three exact relations (native component, current partition, outbox).
Accepted insertion adds this SELECT and the two-relation binding/gate validator to its mutation/PK/FK (3+3+2=8
points; three statements). Page/seal add four fresh-write SELECTs over accepted address, fence, summary and
progress plus native validation to their mutation/PK/two FKs (4+4+3=11 points; six statements). The fresh-write
trigger projects only the address from accepted, avoiding a second 2 MiB definition transfer. Consumer adds a
locked enrollment-gate point and the monotone gate update (3+4+3+1+2=13 points; eight statements). An ignored
consumer replay cannot increment the gate; its BEFORE checks remain reserved and charged.

The atomic transition validator is one keyed eleven-relation SELECT over stage, disposition, transition,
accepted, gate, native transition, predecessor, receiving, successor, seal and progress. Stage adds three
SELECT input relations, mutation/PK/two FKs, native validation and this atomic validation (3+4+3+11=21 points;
three statements). Disposition and transition each add mutation/PK/native FK plus native/atomic validation
(3+3+11=17 points; three statements), separately, even on later rollback. Initial gate adds its mutation/PK/FK
and original accepted/binding/gate SELECT (3+3=6 points). Closing gate adds update/PK and the five-relation
fence/component/partition/outbox/gate validator (2+5=7 points). Gate origin and closure are durable evidence;
an empty consumer query is only an additional consistency check. No older capture is backfilled as zero.

The Subject cut CTE writes both inverse directories, bridge version and immutable cut. Their mutation/PK,
extra erasure index and FKs contribute twelve points; the prearm inverse guard adds four, native validation
three, and erasure capture five (24 total). Its nine statements include root CTE, two inverse guard SELECTs,
the erasure-role PERFORM plus four SELECTs, and native validation. Bridge creation contributes five write/index
points plus five erasure-capture points, six statements. These platform commands have fresh executor UUIDs,
no actor/basis or copied erasure roles; erasure role queries are still charged, and no writer attribution is
invented. A live inverse's removal is refused before deletion until its owning platform-native removal exists.
A never-admitted cut release charges slot update/PK, release insert/PK/FK and native validation (2+3+3=8).

Other registered owning literals and their vectors are in the same dispatch table: prearm attempt read is
`1/8/1/1024/0/0/1/1`; unsafe summary update `2/32/4/512/0/0/3/3`; attempt upsert
`4/48/6/4096/0/0/5/5` includes both INSERT and UPDATE consumer guards; receipt insert
`2/32/4/512/0/0/3/3`; released receipt and cancellation read `4/32/4/256 or 64/0/0/1/1`;
released ticket `12/96/12/6144/0/0/1/1`. Native component insertion is `1/32/4/128/0/0/1/1`
(Core partition, mutation and two unique indexes). The one-event actorless Core fence is
`0/40/5/128/0/0/1/1` (partition update/PK, outbox insert/PK/FK). A different event count/type or non-null
basis/receipt is unproved and refuses. Controls, including dynamic deadline SQL and terminal cleanup, use
`0/0/0/0/0/0/0/1`. Time mint uses `1/8/1/128/0/0/1/1`. Full unbounded partition projections are not registered.
Public Source register/define use `2/32/4/256/0/0/1/1` and `3/40/5/128/0/0/1/1`; definition/release
reads use `3/24/3/admitted/0/0/1/1` and `1/8/1/admitted/0/0/1/1`, after immutable size admission;
definition existence is `1/8/1/128/0/0/1/1`. Mapping owner/source/pending/current arrays reserve n/4n/n/2n
metadata and points, 8n/32n/8n/16n rows, 256n/1024n/256n/256n bytes, and n/4n/n/2n empty seeks.
Every repeated snapshot collection is charged again.

One continuation has no aggregate funding envelope. A new page performs three eligibility passes, one native
raw page, original/terminal/retained-cut mapping double-collections, at most sixteen released mapping/group
plan pairs and control commands with their original/cut receipt reads. Resume uses the persisted plan and
repeats the complete cut/current/final eligibility prefix. Final seal retains both native hold and publication
locks through commit. Identity PREPARE and its inverses serialize any later Subject change with Source revision
invalidation; a stale/active scope refuses, without reading a foreign home in the Collection transaction.

Each native or reentrant Semantic child receives only the parent's remaining finite reservation via `compose`.
The parent holds that remainder while the child runs; an already-reserved native query suppresses duplicate
parent observation, without changing the real client or authoritative T. A thrown child with a valid settled
receipt charges precisely that prefix; missing/invalid evidence charges the full transferred remainder and
poisons the frame. BEGIN first reserves separate COMMIT and ROLLBACK controls from the same finite frame.
A successful COMMIT cancels unused rollback funding; a failed COMMIT retains that reservation for the actual
ROLLBACK, so both dispatched controls are charged. A failed BEGIN cancels both unused controls and discards
its connection. Failed dispatch and late deferred constraints retain their admitted row/point/byte/nested-empty
charges. No failed callback can settle a query twice.
A single successful seek can refund only its unused empty/candidate/witness bound. Nested seek bounds stay
charged because top-level returned rows cannot show which nested relation was empty. No allowance is minted
by a callback, refusal, replay, control statement or rollback.

### Mapping execution boundary

`identity-epoch-mapping.ts:stepIdentityEpochMapping(pool, job)` consumes only a saved admitted job. Its input
keyset reads at most one raw key from each immutable input stream. Each subsequent invocation applies one
source, link, member, membership or header unit. Sparse Context fanout is a separate raw-90 keyset phase.
The native control head retains one original and one link intent, at most two output descriptors and an
8-scalar/2048-byte frontier. Local effect receipts and the exact control custody row precede advancement;
a lost local result resumes the same unit. Transient payloads are deleted only after released control custody.

Output memberships use separate immutable generations. Four home-local reservation slots cover partial outputs
and retired inputs under the existing G/A allowance; unknown bootstrap exports pause allocation. These slots
are not an erasure or reclaim producer. Missing minimizer and receiving-owner transfer remain pending.
Mapping heads, intents, effects, transient payloads, generation reservations, fences, withdrawals and undo
footers are in the physical erasure inventory. Their native source hooks carry actual job and copied-link roles;
the erasure step retains these obligations pending an owning minimizer. Native cost certification still requires the existing all-pool/nested-SQL harness and
its owning correction; returned body counters are not a substitute for inclusive native plans or failed work.

Ordinary merge authority cannot stand in for an Accounts source intent. Mapping of an admitted account-agent job
re-reads the original Access source at the account home and releases that home before destination work; a moved,
fenced or absent source is retryable unavailability. Ordinary unmerge requires a genuinely published
undo job with both fixed participants and native withdrawal custody. Merge/repoint retains each withdrawn link
in its original home, alongside an immutable footer identifying the current fact revision, security revision and
admitted release. Undo restores one retained row at a time and refreshes projection revisions from native subject
points. A full withdrawal requires the original to have been self-mapped and the real home-local `semantic_links`
checkpoint to cover its last fact command's native editorial basis before the withdrawal footer commits.
Missing projection custody, a previously redirected source, or a moderated source without an equivalent projection
closure remains unavailable for undo. A later repoint's empty withdrawal is not a complete fact inventory.
An indexed non-structural revision check rejects a changed fact/security/release basis rather than replaying
stale facts. Restoration preserves the exact Context/property/source/statement/filter identity and does not enumerate
personal references. Positive published-undo proof remains pending the real fixed participants and coordinator;
no fixture or mapping function manufactures those receipts. Changed-fact reprojection remains an explicit unavailable
boundary rather than an invented fact-restoration port.
Terminal repoint captures the smallest remaining structurally live original from the immutable source generation
as its remainder terminal, using one home-leading indexed selection independently of presentation visibility.
The public intent is unchanged. The captured source snapshot and scope digest retain that UUID; admission persists
it in the immutable job's `remainder_terminal` column. Generation conflict recaptures before effects, while accepted
jobs never reselect a representative. A singleton has no remainder. Same-group/self and nonterminal targets reject
before binding or reservation. Only the requested original moves to the validated target terminal. Every remaining
source original maps directly to the saved remainder (self for that root), and the target group stays at its terminal.
The same transform applies to terminal detachment by unmerge, which still requires its actually published undo job,
fixed participants and native source inventory. No visibility, permission or published-undo evidence is synthesized.
Remainder members use the normal reparenting phases; undo restoration belongs only to the requested original.
Both the destination group and the remainder independently retain the 4096-original cap.

Mapping processes remaining keys before the detached terminal, so their old incoming copies are withdrawn before
moving the old terminal's own remaining links. One skipped key and a final native point replace a group rescan; the
frontier remains scalar and every subphase retains the existing per-home receipt protocol. The remainder output
stays in the captured source control home and has exactly source count minus one members. Its new header spends G;
partial output and retired input reservations still spend the same four slots. Store pages and mapping consume the
same constant transform. Hidden members retain their visibility/security state; ordinary input-terminal eligibility,
account-agent exclusion, current ownership, cancellation and epoch gates remain independent and unchanged.
The visibility exception applies only to members of the saved remainder, not to a requested hidden source.

The remainder column is part of the existing immutable job and its owner/role/minimizer inventory; the home-leading
live-generation index adds no membership copy. Selection examines at most the first two live keys (one excluded
original), plus current metadata under the existing allowance. Native inclusive cost proof and physical index-byte
measurement remain pending the existing cost owner; no new per-step budget is introduced.
Full coordinator composition, fixed Search and ALL-Library production, caller binding, publication/fence
release, erasure/minimization and final integration proof remain separate obligations.
