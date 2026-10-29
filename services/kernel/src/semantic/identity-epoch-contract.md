# Native identity epoch job

This is the type-only implementation boundary for the adopted [Identity](README.md#identity) mechanism.
[Canonical identity](../../../../docs/filtered-lists.md#canonical-identity-and-personal-references) owns list semantics;
[private follow counts](../../../../docs/private-follow-counts.md) owns private contributions and counts.
The adjacent TypeScript file emits no runtime producer, registry, route, schema or permission result.
All producer names below are **MISSING**, unless explicitly identified as existing. They are required exports to
implement, not declarations that the current checkout can call. Old identity-basis and terminal producer tasks
supply no authority, dependency or substitute implementation.

## Invariants

A permanent ID names a catalogue original and is never reused. Creation needs actual Global `subject:create`,
including import batch authority where applicable, and writes native revision 1 independently of Search.
Only duplicate identity is mergeable. Editions, translations and formats retain separate identities and relations.
Every published redirect is direct to an active terminal. A requested larger-UUID survivor is legal.

One durable structural job serializes merge, unmerge, repoint and both account-agent operations across the catalogue.
The exact union of the affected groups, including their terminals, is admitted at **4096 originals maximum per
resulting group**, before pending epoch, revision, redirect, mapping, index, participant or outbox effects.
Two input IDs do not imply two originals. Unmerge binds the prior `undoJob` and the original to restore to self; its verificationReceipt is non-null only
for an Accounts reversal. Repoint moves one original to the named terminal. A split checks all resulting groups; overlapping membership counts once.
Overflow is `identity_group_overflow`. Missing/incomplete/moved ownership cannot become a small or empty group.
No structural effects occur while another job is pending; another intent receives `identity_epoch_busy` and retries
with current truth. The same immutable receipt and intent find the same job instead of allocating another epoch.
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

## Exact existing callable compatibility

`merges.ts` exports `mergeSubjects(pool: Pool, options)` with `subjects: string[]`, optional `survivor`, actual
`AccountActor`, `idempotencyKey`, `Uint8Array digest`, `{digest, release: Release}`, `CommandAuthorization`, optional
`deadline` and `clock`. It returns `{survivor, redirected, revision, component}`; component is
`{partition: number, epoch: number, position: bigint}`. `mergeSubjectsInCommand(tx, transactionId, options)` shares
revision/redirect work with account verification; its options are survivor, redirected, release, optional
verificationReceiptId and allowAccountAgent. That existing helper is evidence of effects, not the new job admission.
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
`semantic/http/subjects.ts`, preserving native current required anchor checks. `runCommand` mints native time and
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
component or result disclosure. Authentication remains native: a valid suspended bearer receives
`403 account_suspended`, while revoked credentials receive `401`; invalid credentials never become anonymous.

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

1. A fixed native control partition; a durable job ID, native bigint target epoch, immutable intent and existing
   receipt reference; last published epoch and sole pending job; exact group cardinality and affected-original index.
   Durable JSON serializes bigint as canonical decimal strings, never Number. A job contains no client result vector.
2. `admit(tx, {intent, receipt}) -> CommandResult<IdentityJobRef>` under a live native control command. It verifies
   real ordinary authorization (or the exact persisted platform decision), receipt/intent equality, complete group
   membership and the cap before writes. Pending plus wakeup are atomic. The final user DTO receipt cannot be
   manufactured as successful by this internal admission result. Typed failure codes are `identity_group_overflow`,
   `identity_epoch_busy`, and `identity_participants_incomplete` for the conditions named here.
3. `initializeSubject(tx, original)` in the real revision-1 creation transaction. It records an exact initial-self
   mapping from actual creation; it does not infer self from a missing row, touch Search or advance a structural epoch.
   All creation paths, including account-agent and imports, must bind it. No per-read lazy write.
4. `readEpoch`, `readJob`, `findJob` and `readMapping` are native observation, not permission. `absent` is established
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
The bootstrap producer and its concrete cursor/export remain MISSING implementation work; this specification does
not invent a legacy ordering or claim that a fixture SQL insert has completed bootstrap.

The home fence has a required ordering proof. Install the pending gate at each affected destination before mapping
or participant effects there. Installation serializes against old-epoch apply in that home: an apply committed first
is included in the retained re-key input; an apply after installation is rejected atomically. Cross-home removal and
addition retain page intent and per-home effect receipts, so crash/retry cannot forget either half. Before releasing
the pending gate, publication proves all retained changes/withdrawals have ACKs and installs the published mapping
fence. A stale old-destination delivery rereads CURRENT source, account eligibility and mapping on retry, rather
than relabelling a saved positive. Source-account terminal fencing is separate and still required. No amount of
identity epoch bookkeeping alone proves current source-account eligibility across released reads.

## Bounded native mapping and fixed participants

Required `semantic/identity-epoch-mapping.ts` export `stepIdentityEpochMapping: IdentityEpochStep` receives only
`(pool, {jobId, epoch})`. It reads the persisted frontier and affected changes, commits one bounded unit and returns
`{job, frontier, state, work, receipt}` only after effects/frontier receipts have durable custody. Re-delivery after a lost
result reads committed progress. Continuation contains at most eight scalars / 2048 JSON bytes; workflow arguments
and results at most 4096 bytes. Group membership is stored in the work index, never workflow JSON.

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
Search must export a real `IdentityEpochStep` adapter for its canonical index and prepared rows. Its actual module
path/export is MISSING; do not guess evolving public-filter source/export names. It must bind the physical target,
incarnation and complete canonical observation at this epoch, keep one public terminal document and unique prepared
rows per generation+canonical ID, and preserve original support and last-eligible-original behavior. This ACK is
DISTINCT from ordinary projection checkpoint and privacy-reduction ACK. Source/public projection and current privacy
narrowing remain separately owned work; do not fork their public-filter contract or require a new engine/certificate.

Library must export a real `IdentityEpochStep` adapter under the existing fixed `library-private-follow-counts`
name for ALL Library canonical records; its concrete module path/export is MISSING. It receives the same
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
only final coordinator composition imports concrete participants. Neither participant waits for or imports coordinator.
Accounts and ordinary callers bind last, after their actual response contracts and native prerequisites exist.

### Complete Library canonical coverage under the fixed participant

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
replay and terminal erasure. Local published fences may be installed while the global job is pending; no reader
treats that local installation as permission to bypass the global publication predicate.

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
ACTUAL delivered exports for Members GET derived preparation. This specification adds no Core, Accounts, Library,
Search, schema or SQL implementation. Directory/first-apply production cannot be counted as `noData` while missing.

## Independently landable producer boundaries

| Producer                  | Required surface / evidence                                                                                                  | Present |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| Semantic STORE            | identityEpochStore; cap/index/control records, creation self mapping, bootstrap completeness, per-home fences, ACK custody   | MISSING |
| Semantic native step      | stepIdentityEpochMapping; scoped effect receipts and bounded mapping/redirect/member/link work                               | MISSING |
| Search participant        | version-1 search-canonical-index IdentityEpochStep; actual physical target/incarnation/canonical ACK                         | MISSING |
| Library participant       | version-1 library-private-follow-counts IdentityEpochStep; ALL canonical records/directories, first-apply custody and fences | MISSING |
| Commerce ordering         | same-transaction owner counter and entry.owner_write_seq producers; legacy readiness policy                                  | MISSING |
| Final coordinator/callers | resumeIdentityEpochJob, waitIdentityEpochPublished, fixed WorkModule/default composition and unchanged Accounts step binding | MISSING |

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
- `a valid natively suspended bearer receives403 rather than an authentication or anonymous response`
- `unknown operation GET is concealed and valid suspended polling receives403`

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
claim of executable coverage. STORE, mapping, fixed Search/Library adapters and coordinator exports above are still
missing. Do not invent their schema, participant paths or barrier exports to make this suite green.

| Scenario title                                                              | Required native schedule and missing prerequisite for owner review                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published completed DTO only after actual fixed Search and Library receipts | Hold mapping, Search and Library separately before ACK custody; poll pending with either ACK absent; reconcile both actual receipts, publish once, then assert the exact completed DTO. Requires real adapters, STORE/coordinator and a controlled hold/release at each native ACK reconciliation and immediately before publication. Ordinary projection pause is not this port.                                                                                               |
| Pending crash restart and same receipt                                      | Kill/restart the actual identity worker after admission commit/before dispatch; before and after each mapping/home-effect commit, frontier commit, local ACK commit, control ACK custody, publication commit and DBOS result journal. Replay the same POST and compare operation, job/epoch and native transaction ID plus component of every retained receipt. Requires worker lifecycle control and durable commit barriers; a lost returned promise is not process recovery. |
| Completion custody includes every prior removal addition and fence          | Interrupt between withdrawal and addition at different homes, after each gate install and before published fence installation. Deliver duplicate, stale, wrong-transaction/same-position, wrong-component, wrong-job/epoch/version/scope and missing receipts; none may publish or forget a prior half-effect. Requires home effect/fence receipt enumeration and controlled barriers on the actual producers, plus real Search target/incarnation receipts.                    |
| Fresh creation has exact self mapping independent of Search                 | Hold actual Search unavailable during pending work; create revision 1 and read the exact native self mapping without advancing the structural epoch. Requires STORE creation hooks and actual Search outage control. The frozen HTTP case proves revision/read behavior with the shared driver's absence of a Search worker only.                                                                                                                                               |
| Completed maintenance preserves personal originals                          | Run the real published merge/split/repoint with nonempty follows, entries and repeated occurrences, retaining stored IDs, notes, order and multiplicity byte for byte. Requires actual participants/publication; the frozen admission case does not certify completion.                                                                                                                                                                                                         |
| Revoked bearer401 differs from valid suspended bearer403                    | Revoke an actual issued credential through Accounts/Auth, then exercise POST and GET with that credential; separately exercise the still-valid suspended bearer. Requires an exposed actual credential-revocation fixture producer in the shared driver; do not forge authn epochs, account state or tokens. The suspended POST assertion already uses its real suspension producer.                                                                                            |
| Accounts same native operation waits within its existing DBOS step          | Hold publication, crash after effects before step journalling, redeliver the same verify/unverify receipt and prove no approval/clear pending until publication, with unchanged successful DTO. Requires actual publication barriers and Accounts workflow inspection; no extra polling step.                                                                                                                                                                                   |

These are missing controlled observation/lifecycle prerequisites, not proposed test-only completion APIs. The owning
STORE/coordinator, Search, Library and Accounts producers must supply actual controls before these schedules can be
frozen. Do not revive identity-basis, home vectors or per-page replay as a substitute.

## Cost

### Admit structural intent

- Touches: native authorization/receipt/control point, indexed complete group cardinalities and retained affected work.
- Bound: exact maintained cardinality points before effects; retained affected work <=4096 originals per resulting
  group, produced in bounded native steps. The cap does not authorize a request-time all-home scan. No link-degree scan.
- Growth check: retain the native 64/512/4096 group axis; independently grow unrelated subjects, owner pools,
  group/history/receipts/outbox and denied/replay paths. Capture actual rows, points, statements, bytes and blocks.
  Existing numbers are not changed; final measured budgets need Performance capture, not this type-only document.

### Poll an ordinary identity operation

- Touches: current native account/Global merge authority and original/terminal disclosure, indexed operation/job,
  published control epoch and the durable result after publication.
- Bound: indexed operation/control and current eligibility points; no affected-original response vector, participant
  enumeration, all-home sweep or reusable allow. Reuse the native Access and publication bounds above.
- Growth check: pending/completed, unknown/denied, revoked authority and hidden original while unrelated jobs,
  receipts, groups and history grow independently. Full measured native evidence remains required.

### Advance mapping or participant step

- Touches: one <=100-row indexed raw page, retained frontier/intent, exact scoped home effects and durable receipts;
  release each home before another home or engine. Search additionally captures actual engine work/bytes/incarnation.
- Bound: <=100 raw rows per page, <=100 pages per durable segment; native command deadline <=5000ms, scalar keysets
  <=8/2048 bytes, workflow payload <=4096 bytes. Total retained work follows changed finite input and link/support
  degree, independently of request-page cost. Every reread, lookahead, retry and discarded row is charged.
- Growth check: first/deep/empty/replay/denied paths across three native scales, separately growing unrelated data
  and history while selected neighbourhood stays fixed. Measure native rows/points/statements/bytes/blocks/engine
  calls and retained work, including two-home crash schedules and Library pages of 100/101. No planner pins or
  altered 64/512/4096 axes/captures; actual owner pools and current source-account locks are required.

### Publish and observe

- Touches: exact control/job and fixed participant-version ACK receipts; point readers release source mapping before the fixed-control pending observation
  and coherent epoch probe, then revalidate source and native original/terminal eligibility. Canonical readers inspect published epoch and maintained canonical indexes.
- Bound: fixed participant count and indexed job/control points; no per-page 4096-home sweeps, whole follow/source
  scans, cached allow or stored-personal-reference moves. Incomplete ACK/readiness cannot manufacture a ready zero.
- Growth check: affected/unaffected points, publication/replay and cursor restart while unrelated groups, histories,
  private support and completed workflow state grow independently. Full native growth evidence remains required.

### Library canonical directory and first-apply custody

- Touches: the SAME affected-input pages, indexed original-to-owner/source/driver/fact directory, owner candidates,
  all canonical driver records and source working/ready bases, follow pair/support/totals, old/new home gates,
  current source-account fences, expected effect manifest, native receipts and released control custody.
- Bound: charge raw directory fanout BEFORE filtering/deduplication, including empty seeks and concurrent first
  registrations; fanout follows finite relevant support, never all owners. One rekey locator has two input reads
  (affected original and directory locator), two directory changes (OLD removal/NEW insertion), two candidate
  changes, two canonical support changes, two fence effects, and at least four native receipt/custody writes for
  the old/new effects: at least 14 raw row touches before metadata and retries. Consequently a page containing
  c metadata/frontier/owner/account/receipt/outbox rows admits AT MOST floor((100-c)/14) such locators; extra
  driver/follow/total or native receipt rows reduce it further. This is a ceiling, not a claim that 14 suffices
  for every driver. Each native one-home effect command includes BEGIN/SERIALIZABLE setup, native time, owner
  checks, gate/claim, effect SQL, callbacks, native fence, receipt/outbox and COMMIT. Every statement is charged;
  batching OLD/NEW keys cannot erase their raw row cost. At most one indexed HOME handoff-state lookup per guarded
  write remains mandatory; first-absent gate uniqueness/locking and source-account terminal locks are additional
  work under existing bounds. Directory EOF needs a bounded indexed empty seek plus all pending registrations
  and deliveries in custody, not a returned empty page alone. Retained space includes one directory row per live
  source-support locator, negative work until safe minimization, both halves of each unfinished rekey, and the
  minimized per-effect completion/custody skeleton. Native B-tree/MVCC/catalogue/physical bytes are measured.
  Keep 100 raw rows/page, 100 pages/segment, 5000ms command deadline, eight scalars/2048 cursor JSON bytes and
  4096 workflow bytes. Owner operational transaction costs require the actual Accounts Core producer; existing
  `noEffect` is not an allowance to omit that transaction, its durable intent or source/control delivery.
- Growth check: fixed selected support while unrelated owners, directory rows, original groups, completed jobs and
  receipt history grow 1/8/64; separately 64/512/4096 originals and 100/101 raw support boundaries. Native first,
  deep, empty, replay, OLD/NEW key deletion, concurrent first apply on either side of gate insertion, terminal
  purge, source->custody->ACK crash and follow-complete/directory-incomplete publication refusal are mandatory.
  Capture all source/Library/control pools, statements, rows, index/heap/catalogue blocks, payload bytes and live
  retained evidence. No new participant, sweep, global creation lock, deadline allowance or passed budget follows
  from these proposed bounds; Performance reviews actual formatted rows before runtime release.

### Released mapping control observation

- Touches: existing Pool, native source owner/mapping/creation basis, ONE fixed pending-membership indexed probe,
  ONE coherent epoch/current-original indexed probe, and final source owner/basis revalidation. These are named,
  charged CONTROL READs. Existing original/terminal privacy and Access work remains independently charged.
- Bound: one attempt uses at most three released read snapshots. Existing `withReadTransaction` costs BEGIN,
  SET LOCAL timeout and COMMIT per snapshot (nine statements), plus one owner point and one mapping/basis point
  at each source visit (four statements), plus one control owner point and two indexed probes (three statements):
  **16 statements**, or 11 if pending returns before final source visit. Combine native provenance/gate fields
  in those point records, not extra queries. Each control probe returns at most one basis per requested original;
  the pending descriptor has at most two input references and constant exceptions. A batched page has the same
  two control statements, not two statements per ID, and <=100 total raw basis records INCLUDING both probes,
  owner/descriptor rows and lookahead; reduce the requested batch accordingly. No second engine/helper/budget.
  Indexed depth is bounded by actual membership/epoch B-tree height; heap/index blocks and physical bytes include
  transaction setup, initial catalogue/plan reads, cold/warm owner checks and final revalidation. This statement
  envelope is a proposed implementation constraint, not evidence that missing runtime meets existing budgets.
- Growth check: pending memberships and published epochs independently 1/8/64 at fixed requested originals,
  actual pools and fixed privacy data. Capture rows, statements, index/heap/catalogue blocks and bytes for source
  miss/unready/moved, control miss/unready/moved, pending-after-source, publication-between-reads, newer pending,
  unaffected and Search-absent fresh-self paths. Constant returned rows/statements and constant or logarithmic
  physical index work must fit the existing declared budget; no remote availability exclusion or cache/TTL.

### Immutable current generation and bounded reclamation

- Touches: current-original indexed locator, its ONE flat sealed generation, shared-budget keyset input pages;
  retained generations, indexed reference counts, native minimizer/custody records and reclamation frontier/receipt.
- Bound: current access reads no parent/ancestor/history and at most 100 raw entries including lookahead, overlap
  and retries. At fixed current group count G, retain at most G+4 full generations and 4096(G+4) membership rows,
  plus actual index/tuple/page overhead. If B is the measured physical bytes per membership plus its index entries,
  full payload is <=4096(G+4)B plus G+4 generation headers/index entries; R minimized obligations and L scoped
  effects add their actual retained bytes, not zero. One reclamation command locks one retired generation/header,
  checks its indexed live-reference count, reads/deletes a keyset batch and commits one frontier/native receipt
  and wakeup. Budget owner/header/ref/frontier/receipt rows first; if that consumes c raw rows, delete at most
  floor((100-c)/2) members, charging both selected and deleted rows. The point-header transaction work and all
  ref/minimizer lookups count, including a refused live-reference attempt. Reclaim header only after an indexed
  empty page and zero references in the same locked command. A crash replays that native receipt/frontier; no
  saved empty result can close a later generation or skip a newly retained reference. Reference acquisition is
  serialized with retirement; no hidden full-generation copy or unbounded cascade/delete is allowed.
- Growth check: independently grow earlier completed job history 1/8/64 with current generation fixed; first,
  deep, empty, replay, live-reference refusal, native minimizer and crash-before/after-frontier paths. Grow G and
  R/L separately, recording retained rows/bytes/index blocks, all statements/transaction/catalogue reads and raw
  deletions. Reclamation advances bounded steps over the retained-generation index, never scans all history.
  Backpressure preserves this finite full-generation bound; it is not a passed Performance budget or time expiry.

### Final handoff guard

- Touches: guarded native source write, existing source barrier/claims/command fence and the home's handoff state;
  deferred SAME-transaction guard at commit, with old writer and queued continuation scope retained in custody.
- Bound: at most ONE indexed HOME handoff-state lookup per guarded write, including its deferred check; use the
  same transaction's captured basis/lock, not a second lookup or global effect permission. Key-changing updates
  charge both OLD/NEW capture rows; deletion retains a negative key. Installation/catalogue locks and waiting
  are measured separately from completed work and cannot be represented as a constant trigger-function call.
  If implementation probes active transactions, there is NO assumed bound on active XIDs: charge each probe and
  preserve the required fixed-data 1/8/64 OPEN native `pg_current_xact_id()` transaction axis. A timeout is WAITING,
  never successful handoff. No active-XID axis is imposed on a mechanism that does not inspect active XIDs.
- Growth check: old DML before barrier, old/queued work after final handoff, first absent gate racing insertion,
  same-position wrong TX, wrong owner/scope and unfinished previous page. Capture statement/row/index/physical
  work with actual owner pools; include the active-XID axis exactly when the chosen native mechanism needs it.

### Birth, topology, custody, admission and effects

- Touches: real `writeSubject`/import claim and named/unnamed account-agent creation; native source barrier,
  indexed base/member/dirty schedules for all 4096 owner epochs; source export, control custody, exact-head ACK;
  immutable input/header/cardinality refs, pending+intent+wakeup; scoped effects and native complete receipts.
- Bound: birth adds one self mapping in the SAME source transaction as revision 1; source fence/claim/receipt
  work remains charged and rollback removes both. No control/Search checkout or statement outside account home.
  Bootstrap scheduling keyset-reads at most 100 raw owner slots per step (including empty homes), persists exact
  owner epochs/cuts, and releases source before control. It cannot claim closure in fewer than ceil(4096/100)
  owner-slot pages, and actual metadata/lookahead rows reduce each page's capacity. For every saved page custody
  requires a source export read, control insert/receipt/frontier command, then released exact-head source ACK
  command: THREE transactions, never a free export ACK. If c native metadata/receipt/frontier rows are touched,
  payload allowance is floor((100-c)/k), where k counts EACH payload read, retained copy and effect/ACK row in
  that step; c and k must be captured from the actual calls, not excluded. Admission uses <=2 sealed group
  headers/counts plus <=2 retained input refs, one intent/job, one pending descriptor and one native wakeup,
  atomically; no 4096-row admission insert. Existing authorization-before-receipt, native command fence/time,
  receipt lookup/write and all outbox/catalogue statements are additive and measured. Exact all-result group
  counts enforce 4096 admitted/4097 refused before ALL effects. Mapping/effect steps reserve metadata then
  divide the remaining 100 raw allowance across input, OLD/NEW capture, effect, frontier and native receipt
  writes. A statement returning zero still counts, and replay/retry consumes the same shared allowance.
  Every operation keeps 100 rows/page, 100 pages/segment, 5000ms command deadline, <=8 scalar/2048-byte cursor
  JSON, <=4096 workflow bytes. No request/workflow original vector, planner pin or larger allowance.
- Growth check: preserve original native 64/512/4096 groups, actual account creation growth and actual pools;
  all4096/empty/missing/moved owners, lower-key births/deletions/key moves, dirty h+1 after export/control ACK,
  source->custody->ACK crash, saved empty replay, same-effect fence and complete prior-effect custody. Record
  native statement counts from runCommand/read transactions INCLUDING authorization, transaction setup, native
  time/fence/receipt/outbox, catalogue/index/heap blocks, physical payload/index bytes and retained history.
  The shared limits are unchanged even though this baseline kernel README lacks its planned Bounded job steps
  subsection. These are derived admission/work ceilings for review; actual producers and Performance evidence
  remain required before runtime activation. Deadline bounds waiting and does not waive work bounds.

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

The two complete integrated reports [current](../../../../docs/research/identity-store-cutover-current.md) and
[deep](../../../../docs/research/identity-store-cutover-deep.md) supply evidence. This section adopts the native
choices below; it does not adopt their illustrative SQL, their observed statement counts or the preserved partial
producer as runtime. Both reports identify the same missing writer boundary and dependency direction. Where their
dirty-export timing differs, **control custody precedes source ACK**. Where their enforcement sketches differ,
**both the home barrier and deferred same-transaction structural validation apply at final real caller handoff**.
The corrected released-control meaning below replaces any interpretation of “stay local” as source-only I/O.

The integrated report revisions inspected are `a73bcefb2fe9a901d22478bb4e3d774c06186c55` (current)
and `e9ae39f06176b66a4026533812f07c6e00e46dec` (deep). Their integration changed Markdown formatting only.
Neither report ran native probes. The preserved, unintegrated `49a51f6350` Store/bootstrap, four source queries,
migration and native-store suite are evidence only: admission, home admission, reconciliation and publication
still unconditionally throw, the cutover reader hardcodes missing writers, and no actual creation caller binds
self initialization. In particular, its source export updates captured heads BEFORE control custody and its
key-changing UPDATE capture selects only NEW. Both conflict with the adopted protocol below. Do not copy those
behaviors into an implementation or infer delivery from their presence in a git object.

The comparison's complete co-owner appendix and subsequent Library ruling apply together. This specification
does not release runtime implementation: full parent review, Accounts/Search/Commerce confirmation, Performance
review of every Cost subsection and freezing the formatted native bytes precede producer activation. An honest
red native schedule is missing-capability evidence; it supplies neither a passed budget nor an ACK.

### Primitive delivery and final activation

Source creation/capture, complete topology bootstrap, ordinary pending/cap admission and all four Store tails
(`admit`, `admitHomeEffect`, `reconcileStepReceipt`, `publish`) belong to the same owning implementation. A primitive
may land and prove ordinary pending/cap/fencing independently of consumers. It MUST NOT claim activated Store,
all-writer coverage, full publication or successful Accounts compatibility from that proof.

The consumption order is Store -> mapping and fixed participants -> coordinator -> final caller handoff.
Store never imports coordinator or consumers. Mapping imports actual Store; fixed Search/Library producers consume
Store/Step; coordinator imports those actual producers; final callers bind last. No `noData`, default ACK, readiness
setter or process declaration fills an absent producer. Every original positive native/API/default-worker/DBOS/growth
outcome remains mandatory, including the already adopted ordinary 202/Location/poll and unchanged Accounts success.
Final native guards are enforced with actual caller binding and custody of all old work, not with creation primitives.

### Source birth and writer inventory

Every birth below writes subject, revision 1, exact self mapping, singleton creation provenance, dirty delivery and
native receipt/outbox in the SAME actual source command. Rollback removes all of them. There is no statement outside
the account home during an account birth, control checkout, Search checkout, global creation lock or structural epoch
allocation. An existing redirected agent/claim replay must retain its existing identity, never reset to self.

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

Mandatory birth-hook growth acceptance is the existing Access-owned `test/access/growth-commands.test.ts`, named
`Account and organization creation stays within its bound as A grows`. The requested Semantic path does not exist;
use that existing exact named test rather than duplicate or weaken it. It must still pass after actual birth-hook
delivery; account-agent ensure cost and type/registry assertions cannot replace it.

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
   published epoch. Source export or control custody alone does not publish a job.

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

### Atomic affected index and flat generations

Admission retains, atomically with pending+immutable intent+native wakeup, complete immutable input-generation
references and a CONSTANT transform. This ONE affected index is authoritative even before any home gate or consumer
runs. It is not a promise to insert 4096 rows in that transaction. Canonical groups are disjoint through the unique
current-original index; identical group references collapse once. Merge takes at most two input generations;
repoint/split binds the explicit original, prior/destination terminal and exact prior undo scope. No caller original
vector or whole-group scan is permitted. Check exact maintained counts of EVERY resulting group before effects;
4096 is admitted, 4097 refused, including unselected cross-home originals and terminals/self.

`pageChanges` retains its existing DTO. It keyset-merges at most two flat input streams and constant point exceptions,
with a shared **100 RAW-entry** allowance covering overlap, discarded duplicates, sentinel/lookahead and retries.
Do not fetch 100 from each stream. Use indexed disjoint original intervals/stream identity to avoid duplicates;
continuation is the greatest fully consumed original, with equal-key contributions consumed together. Reserve space
for that fixed overlap or return fewer rows. A page exactly at the cap may return a continuation and then an empty
terminal page; it may not read row 101 for free. Exact uniqueness and before/after terminal transformation preserve
self, split, repoint and undo. Build each next generation fully flat in bounded native mapping steps; it is ineligible
as a later admission input until fully sealed. Current reads never follow a delta, parent or generation-history chain.

### Released mapping observation and coherent basis

There is ONE existing `IdentityEpochStore.readMapping(pool, original)`, now typed with the existing Pool.
It adds no Source ABI, permission helper, action, engine, public job/page DTO or budget. “Stay local” means **no wait
for list preparation or publication**, with explicit dependence on current control availability and these charged
bounded reads. It must never be described as source-only I/O.

The native algorithm has one attempt, not an unbounded retry-until-stable loop:

1. Read the original's source owner epoch, exact local mapping/write basis and local gate/creation provenance in a
   native source read snapshot; release that source before control checkout. Native absence is established by the
   real source reader, not missing mapping. A legacy missing/unready mapping is unavailable.
2. In ONE fixed-control repeatable-read snapshot, read pending membership with **ONE indexed fixed-pending-index
   observation**, then coherent published/local basis with **ONE indexed epoch revalidation probe** on existing
   call keys. The first probe seeks current original membership and compares its generation against the sole
   pending descriptor's at most two immutable inputs/point exceptions. Admission updates descriptor and pending
   atomically, so no per-original fanout at admission is required. The second probe returns that snapshot's
   published epoch, original current generation/terminal and control owner epoch, not an unrelated latest epoch.
   Batch requested keys in one statement per probe per page, NEVER a per-ID control query loop. Release control.
3. If affected pending at that snapshot, report that exact job, even before its first home gate. Otherwise perform
   ONE source revalidation against the captured native owner epoch, mapping/write basis and the control snapshot's
   original generation/terminal (or the same-TX creation provenance where enrollment is not yet custodied).
   An unchanged older local epoch is usable only when that current original basis proves no intervening mapping
   change; merely comparing numeric epochs or matching receipt strings is insufficient. Source owner/mapping change
   or inconsistent publication yields unavailable for this attempt, not a cached/self/zero result.

The linearization point is the fixed-control snapshot, provided final source revalidation establishes the same
mapping/creation basis. If admission commits after initial source read but before that snapshot, return pending.
If publication intervenes, revalidate the newly published original basis and actual source; stale local mapping
cannot be blessed by a latest control epoch. If a newer job exists after prior publication, inspect the NEW pending
scope, never return a previous job's saved mapped success. An admission after the snapshot can linearize later than
this read; subsequent writes still require SAME-effect-TX home admission. If source/control ownership is missing,
moved or unready, report unavailable, including for unaffected and fresh-self observations. A true absent original
may return absent only on coherent native source/control absence. Original AND terminal privacy checks remain
independent and current; this metadata never authorizes disclosure or a destination effect.

### Accounts immutable native intent record and delivery

These are **data requirements**, not a new callable/export or successful permission receipt. The existing
`access.agent_verification_request` (route 0, request_id) holds account_id, account_kind, requested_by,
catalogue_subject_id, state and decision_receipt_id/decided_by. `decide()` sets state `approving` and
`decision_receipt_id = transactionId` and emits the existing approval event in the SAME native command.
`recordPendingAgentVerification()` then binds `access.account` in its actual account home using
pending_agent_subject_id/pending_agent_receipt_id and its native pending command receipt. `commitReversal()`
atomically moves the previous catalogue/verification receipt into a reversal value and the account pending fields,
emitting the reversing event. Those callbacks/rows are the actual authorities to consume.

Persist one immutable owner intent RECORD with:

- Direction `account-agent.verify` or `account-agent.unverify`; account ID, deterministic derived agent ID, account
  kind, catalogue ID, release digest and exact native merge/unmerge intent. No name, statement or public-page body.
- Verify: request ID, requestedBy, existing decisionReceiptId (equal to delivered receiptId), native decision locator
  and pending-account command locator; immutable binding of request/catalogue/account/kind to that decision.
- Reversal: existing receiptId, verificationReceiptId, catalogueSubjectId, requestedBy, kind `released | revoked`,
  reason disposition under Access retention, native reversal locator and the exact prior published verification job
  (`undoJob`). The immutable undo binding preserves the old verification scope, not a newly read representative.
- Both: source owner partition/epoch, native `{transactionId,partition,epoch,position}` for the committed source,
  canonical binding key, normalized immutable fields/digest, native delivery/custody locator and associated semantic
  job reference once admitted. Preserve original native receipt identity across redrive and commit-to-journal crash.

The canonical key is UTF-8 JSON of the fixed tuple
`[direction, accountId, receiptId]`, with canonical lowercase native UUIDs; verify receiptId is the EXISTING
approval decision transaction ID, reversal receiptId is the EXISTING reversal command transaction ID. Tuple encoding
avoids separator ambiguity. Normalize all effect-relevant fields once; conflicting reuse is a conflict, never a new
approval. Ordinary keys retain the existing actor/kind/idempotency-key/digest identity. Scope does not come from
`basis === null`, receipt string equality, a forged actor, extra approval status or a new decision receipt.

Access owns the source intent and its indexed account/decision/reversal locators. For verification, read/retain
Global decision authority, release it, then bind the pending account receipt at the account home; for reversal bind
the committed account reversal and prior verification/undo. The owner commits immutable intent and delivery in its
native transaction; release ALL owner connections. Native delivery next resolves that exact committed record and
receipt and durably takes **control custody BEFORE admission**. Control custody retains immutable input and exact
source identity idempotently; missing/moved/stale source is retryable unavailable. No cross-home transaction exists.
The EXACT consuming port is existing **`IdentityEpochStore.admit(tx, {intent, receipt})`** in a live native control
command. It resolves already-custodied owner intent by the canonical key and compares the exact fields/native scope.
No caller-supplied serialized assertion is accepted as authority.

**MISSING Accounts owner callable:** current `mergeVerifiedAgent` forwards account/catalogue/receipt to
`verifyAccountAgent`; `unmergeVerifiedAgent` checks current pending receipt/catalogue then forwards to unverify.
Neither currently persists/delivers this immutable record or transfers it to native control custody. No guessed
export, generic setter, receipt constructor or new permission port is declared here. Accounts must deliver that
owner binding and confirm its actual locator before producer activation. Current mutable pending fields alone
cannot retain old verified/reversal work across a newer decision. A stale reversal after newer verification must
still fail the existing comparison; durable in-flight custody must retain responsibility for already accepted work.

Both existing durable steps (`accounts.agent-verification.merge` and
`accounts.agent-verification-reversal.unmerge`) wait for PUBLISHED inside the SAME step, including exact receipt
replay. A transient handoff refusal must escape as retryable unavailable or resume native durable work, never as
`AccountAgentVerificationError` converted to failed/denied review. No page write, approve/complete, finish or pending
clear occurs before publication. Retrying after native commit/before DBOS journal recovers the same job. Both
in-flight verification AND in-flight reversal across final barrier/guard are mandatory native schedules.

### Finite full-generation retention and reclamation

This is owner data policy and proposed native proof, **not a passed space/work budget**. Let G be the number of
CURRENT sealed groups, A their unique originals, and J the sole pending job. A group has at most 4096 originals.
At every durable state retain at most **G + 4 full generations**, and at most **4096(G + 4) full membership rows**:
G current, at most two next flat outputs under construction, and at most two retired inputs awaiting reclamation.
In actual publish transitions these categories overlap, so this is a conservative upper bound. No new admission
starts while the previous job's retired full inputs or abandoned prepared outputs remain unreclaimed. Births add
one current singleton, increasing G/A explicitly; repeated jobs at fixed A cannot grow full-generation history.
Unchanged groups share their existing sealed generation; no whole-catalogue generation is copied per job.

Only J/mapping/fixed producers may hold full input references while J is active. Before publication all affected
consumer work/fences and receipts are custodied and outputs sealed. Before reclamation, convert every still-live
undo/replay/receipt/consumer/owner-move reference to its owner's **native minimized record**, with exact native
locator, immutable intent, job/version/scope digest, resulting basis and complete effect-custody manifest. For the
specified unmerge, retain its explicit original and prior before/after terminals plus verification-scoped moved-link
ledger; it restores that original, not an arbitrary historical group snapshot. Record exact per-effect provenance
for reversal, including Context/property/source/statement/filter. Other consumers must either finish under J or
retain their exact bounded remaining scope/effect records with custody. They cannot retain a callable full-generation
reader after J. No historical group-membership archive, disguised full-generation copy, vector in workflow JSON or
ancestor walk is permitted. A requirement to enumerate an arbitrary historical full group after publication would
contradict this policy and needs an owning contract change before activation; existing receipts/undo do not grant it.

Minimization preserves live evidence rather than deleting undo. For R live minimized native obligations and L live
verification-scoped link/effect keys, retained evidence is explicitly O(R + L), plus their actual payload bytes and
native/shared custody. These records may outlive many jobs; this is NOT a constant total-history-space claim. Their
identities/digests and de-identified public skeletons survive as existing receipt/provenance policy requires;
personal/private fragments follow existing terminal erasure. No arbitrary time expiry, account grace, legal hold or
second retention/custody engine is added. Physical MVCC/index/vacuum space remains measured, never inferred away.

A generation becomes reclaimable ONLY when it is not current/prepared/active input, its job is published or its
abandonment durably fenced, every live reference has completed minimization with native receiving-owner custody,
and an indexed live-reference count is zero. Protect that predicate with the same native generation lock used to
acquire a reference: reclamation versus new reference races serialize. A failed minimization or missing locator
blocks reclamation and therefore later admission, not evidence deletion or a free additional full generation.
Consumer/API replay reads minimized receipts, never resurrects a retired generation or reopens completed effects.

The existing `resumeIdentityEpochJob` coordinator also resumes retained reclamation work for a published job;
its published fast path cannot discard that work. It returns after the available reclamation segment commits or
reports retryable unavailability, with further bounded segments retained by the same native work registration.
This adds no callable port or completion flag: publication is still read from native custody and reclamation from
its native frontier/receipt. Admission remains fenced until that prior reclamation actually completes.

Use existing native job work to reclaim by indexed `(generation,original)` frontier, with at most 100 TOTAL raw
keys per step including reference/lookahead/deletion work. Delete membership/index rows in bounded batches and
commit deletion frontier, native receipt and wakeup atomically. Children precede descriptor; descriptor becomes a
minimized tombstone only after a native empty-range proof and zero live references under lock. Repeated empty
replay returns the same receipt; it cannot create a fresh generation or advance newer work. Crash before deletion
commit changes nothing; after commit resumes its exact saved frontier. First/deep/empty/replay/live-ref-refusal and
crash paths grow retained-generation count independently of membership size. The reclaim executor/locator schema
is MISSING implementation, not a new public helper or manual checkpoint.

The bound also covers failures of publication and minimization. If the current job cannot finish, its at most
two inputs and two flat outputs remain the only extra full generations; retry resumes those identities. Once
published, a live consumer reference prevents deleting its input until that consumer accepts the exact minimized
scope under native custody. Subsequent admission waits for reclamation even though point reads of the published
generation remain usable. There is no allocation-on-retry or unbounded abandoned-output list. This is backpressure
on structural admission, not a timeout that discards undo. For a merge G decreases by one at publication; at most
two former current inputs become retired while the new output becomes current. For a split G increases by one;
one input retires and at most two outputs become current. Repoint changes at most two groups. Thus each transition
preserves G+4 without counting a retired generation as current or excluding partially deleted membership rows.

### Existing terminal-erasure inventory amendment

Adoption text for the existing Semantic terminal-erasure participant (and the existing Access participant), to be
incorporated by the account-erasure owner into its inventory; no second erasure contract/participant is created:

> Semantic's single existing terminal-erasure participant owns every account-bearing identity-epoch record:
> immutable semantic intent/receipt binding; source capture head/tombstone and saved page payload; affected-input
> descriptor, flat generation membership and pending membership; topology/work/frontier and unfinished legacy
> manifest; mapping/home gate/effect record; native receipt and editorial write-basis reference; control page,
> effect and participant ACK custody; undo/reversal provenance and minimizer/reference/reclamation records.
> This explicitly includes Library canonical owner-candidate and structural-support directory locators, every
> driver support row, pending/published fence, concurrent FIRST-APPLY delivery/registration work, directory OLD/NEW
> rekey manifest, prior-half receipt, Library ACK coverage manifest and all minimized/shared custody copies.
> Each producer atomically records an indexed account-role-to-exact-locator relation, including requester,
> operator, reviewed account, source author and acting human, not just the primary account key. Owners/keys are:
> source home `(route,original[,terminal],head/page/native transaction)`; control home `(job,epoch,version,scope,
> original/generation/page/effect)`; effect home `(destination,original,job,step,native transaction)`; and shared
> core/editorial/work stores by exact native receipt/outbox/write-basis/workflow key. Access owns Accounts source
> intent by `(direction,account,receipt)` plus Global `(route=0,request_id,decision_receipt_id)` and account-home
> reversal/pending native locator. All copies and shared custody retain exact producer/consumer owner locators.
> Library remains the payload owner of canonical data: `(route,collection_id,generation,basis_digest,canonical,
> stored_original,driver,fact)` and owner-candidate `(owner,source_incarnation,canonical)`; its directory is indexed
> by `(original,owner,source_incarnation,driver,fact)`. The Semantic participant inventories its identity work and
> exact Library payload/minimizer locators; it does not claim that clearing Semantic rows erased Library copies.
> First-apply/work/receipt locators include source revision, job/epoch/version and exact native transaction plus
> component; both OLD and NEW directory keys remain cleanup obligations until receiving custody is acknowledged.
> Access additionally owns the Accounts Core operational transaction/atomic-intent source records and their
> account-role/native receipt/delivery indexes. A missing callable or locator is unfinished, never noData.
>
> Clear personal labels, request/reason bodies, private provenance and account attribution payload according to
> existing account terminal policy; preserve communal originals/terminals and only the necessary de-identified
> immutable skeleton (job/epoch/version/scope identity, native transaction/component, nonpersonal intent transform,
> minimized complete custody and reversal binding) needed for replay/no resurrection. A private identity linkage
> cannot survive merely because it is in a digest or locator. Minimize private links and their copies through the
> existing owner policy without discarding unfinished cleanup responsibility. Shared receipt/outbox/editorial/DBOS
> payload copies require the existing shared owner's actual minimizer ACK, not dispatch. Missing account-role index,
> source/shared locator, minimizer or custody is **unfinished/unknown**, never `none`, erased or a no-data ACK.

These are obligations before release; their owner-key index/minimizer delivery is MISSING. The existing terminal
account fence remains immediate and independent of this cleanup. A reclaimed full generation cannot erase a live
native undo obligation, and retained undo cannot retain erased personal payload by cloning it into control history.
