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
An affected point reports pending while its required mapping is unready. Unaffected points and fresh creation stay
local and usable without waiting for the catalogue's list barrier. Source privacy and eligibility are independent
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

Library must export a real `IdentityEpochStep` adapter for private follow counts; its concrete module path/export is
MISSING. It receives the same affected-original/new-terminal stream, re-keys in <=100-row steps, and ACKs before
publication. Support is per (canonical target, follower); totals change only at 0->1 / 1->0. Derived pair/support/total
rows live in the canonical-target home; stored follows stay in the source owner home. Admission uses
`admitHomeEffect` in the destination effect transaction. A global epoch pre-read is not an atomic fence. Old-destination
applies reject, then reread current source+mapping. Crossing-epoch cleanup, delayed first positive and terminal account
purge must never resurrect a pair or total. Existing follow/listing helpers do not provide that proof; neither an
assumed noData ACK nor a new account generation, holder directory or private-fact mirror substitutes for it.

Required `semantic/identity-epoch-coordinator.ts` exports `resumeIdentityEpochJob: ResumeIdentityEpochJob` and
`waitIdentityEpochPublished: WaitIdentityEpochPublished`. The final binding serially drains mapping, invokes the fixed
participants, reconciles their committed ACKs and publishes once. It registers through existing `WorkModule.register`
and `WorkContext.addEffects`, `DBOS.registerStep/registerWorkflow`, `WorkClient.enqueue` with stable job workflow ID
and `return-existing`. `composeWork` owns the single DBOS launch; `KERNEL_WORK_MODULES` owns default binding and
`startWorker` owns lifecycle. No scheduler/process/second launch or independently invented maintenance engine.
STORE and mapping import only native dependencies and these types; participant producers import STORE/types;
only final coordinator composition imports concrete participants. Neither participant waits for or imports coordinator.
Accounts and ordinary callers bind last, after their actual response contracts and native prerequisites exist.

## Independently landable producer boundaries

| Producer                  | Required surface / evidence                                                                                                  | Present |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| Semantic STORE            | identityEpochStore; cap/index/control records, creation self mapping, bootstrap completeness, per-home fences, ACK custody   | MISSING |
| Semantic native step      | stepIdentityEpochMapping; scoped effect receipts and bounded mapping/redirect/member/link work                               | MISSING |
| Search participant        | version-1 search-canonical-index IdentityEpochStep; actual physical target/incarnation/canonical ACK                         | MISSING |
| Library participant       | version-1 library-private-follow-counts IdentityEpochStep; <=100-row support re-key and stale-destination rejection          | MISSING |
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

- Touches: exact control/job and fixed participant-version ACK receipts; point readers inspect local mapping and
  native original/terminal eligibility. Canonical readers inspect published epoch and maintained canonical indexes.
- Bound: fixed participant count and indexed job/control points; no per-page 4096-home sweeps, whole follow/source
  scans, cached allow or stored-personal-reference moves. Incomplete ACK/readiness cannot manufacture a ready zero.
- Growth check: affected/unaffected points, publication/replay and cursor restart while unrelated groups, histories,
  private support and completed workflow state grow independently. Full native growth evidence remains required.

## Inspected native evidence

Read the full identity shaping ledger and settled identity decision, Semantic Identity/Account agents sections,
filtered-list canonical identity, Library README, private-follow-counts and library-profile-consumers documents.
Native evidence inspected: `merges.ts`, `merge-moves.ts` and its member/redirect/page SQL, redirect migration and
outbound-relation phase migration, `account-agents.ts`, `links.ts`, `command/command.ts` (currentCommand/native time,
authorization-before-receipt/replay), `access/agent-verification.ts` and `agent-verification-work.ts`, Library follows
and work registration, `work/registry.ts`, `work/modules.ts`, `worker.ts`, `rating/merge-job.ts` durable work, Search work/runner/indexer/source and generation helpers, native
creation SQL, and ordinary merge HTTP/problem schemas. No external reference implementation was required by this
contract's cited owner sources; none was cloned or copied.
