# Semantic and Zones account erasure

This records the participant contract, implemented immediate read fences, and remaining cleanup gaps for
[Deletion](../../../../docs/deletion.md). One `semantic` participant includes Zones and Semantic editorial
provenance. A5 remains a launch gate until the actual participant's native completion schedules pass. Today
Semantic cannot attest either `erased` or `none` until local source coverage and actual shared-copy custody have
been certified. The local runtime below performs owned cleanup; missing shared custody remains **pending**.

## Native coordinator boundary

The authority is [Access erasure consumers](../access/README.md#erasure-consumers) and
[erasure.ts](../access/erasure.ts). Native confirmation commits the account tombstone, one
`com.rezics.access.account-tombstoned.v1` with `data.accountId`, and `access.erasure` version 1 at the same barrier T.
There is no account grace or restore. Individual record deletion's thirty days do not postpone T.
`ERASURE_PARTICIPANTS[1]` already contains exactly one `semantic`; do not add Zones or modify the frozen list.

The sole Semantic WorkModule registers `semantic_erasure` for tombstones, `semantic_erasure_local` for bounded
native continuation and `semantic_erasure_locator` for source/effect delivery. The tombstone effect retains
agent synchronization, then calls `beginSemanticErasure`; the local continuation enqueues the stable native
`semantic.erasure.local` workflow under the same effects queue and partition key. Each persisted DBOS step calls
one `stepSemanticErasure`; the workflow continues between steps without another queue dispatch for every home.
They share the normal WorkContext, queues, ordering, retries, relays, startup, shutdown and drain. Identity
publication remains a separate protocol. No cleanup operation restores the deleted account's authority.

Only after the final local purge AND required shared minimization have committed may the real worker call
`acknowledgeErasure({ pool }, { accountId, participant: 'semantic', outcome: 'erased' | 'none' })`. This API creates
its own account-home command transaction. Never call it inside a purge transaction or restore the deleted
initiator. Exact replay is immutable/no-effect; a conflicting outcome is refused. No test wrapper may fabricate
an ACK. Observe the real record with `readErasureStatus(client, accountId)`, not an invented HTTP route; the value
is `participants.semantic = { outcome: 'pending', retained: [] }` until actual acknowledgement.

## Effect locators and terminal closure

Close the per-account native fence **first**, retaining the exact native T. Then enumerate and handle copies
located in another home by an effect. The fence and locator locks must serialize against the actual producing
transaction: an effect already writing a locator when the fence closes cannot fall between an empty page and
completion. Fence/locator evidence must identify the same native transaction; a returned flag is not proof.
No locator-first command, exported locator or caller-created completion is authority.

A late item is recorded in its locator transaction, minimized through the actual owning producer, and only then
resolved through Accounts' coordinator. Resolution before the payload minimization commit is forbidden. A prior
empty page cannot discard a subsequently committed locator. Release each home before acquiring another; retain
the native locator and minimization receipt across crashes and duplicate effect delivery.

Participant closure and overall completion are different predicates. The Semantic worker closes its own fence,
handles **every located item and known local role**, and obtains every required local/shared minimization commit
receipt before its separate account-home ACK. It never waits for `readErasureStatus.state`, `completedAt`, another
participant's ACK, or an overall frontier predicate that requires its own ACK. That dependency would be cyclic.
The overall coordinator additionally waits for all fixed participants, no open late item, and the Accounts-owned
effects delivery/open-work barrier. All ACKs plus one open late item is still incomplete. Closing a fence,
exporting locators, queueing work, one empty read or a checkpoint alone proves neither payload minimization nor
overall completion. Retention and backup/delivery status remain separate obligations.

The delivered [Accounts coordinator](../access/erasure.ts) supplies these exact ports:

- `recordLateErasureItem(tx: CommandTransaction, { accountId, participant, locator }): Promise<void>` requires a
  LIVE command in the account home holding the participant's own locator fence in the SAME transaction. It locks
  the erasure record but neither creates nor closes that fence. The locator contains IDs only, 1–255 printable
  ASCII characters. Repeated recording of the same key, including a resolved key, is idempotent.
- `resolveLateErasureItem({ pool, clock? }, { accountId, participant, locator })` creates a native internal
  platform command AFTER the owning payload minimization commits. Unknown keys are refused; resolved-key replay
  has no effect. The caller supplies no completion flag or restored account authority.
- `advanceErasureCompletion` owns frontier snapshot/delivery/cutoff/completion. Consumers do not compare native T
  to envelope position, epoch or wall-clock milliseconds and do not manufacture frontier certificates.
- `resolveLocatorWork(tx: CommandTransaction, workflowId): Promise<void>` requires a LIVE platform command that
  emits its own event after the owner has handled the copy. The actual executor callback records the native
  resolution transaction. Unknown IDs are refused; an already done/resolved row remains unchanged.

The delivered [effects relay](../events/effects.ts) commits `access.erasure_locator_work` BEFORE each registered
locator enqueue. `opened_at` and coordinator `workflow_until` use the SAME database-millisecond expression,
`ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint`. An open row holds EVERY erasure whose
`workflow_until >= opened_at`, regardless of account. A missing cutoff is incomplete anyway; a row opened later
than the frozen cutoff is outside it. The snapshot vector covers backlog delivery, not old already delivered
failed work. Status/completion query the actual open-row index, not DBOS pending/history/status tables.

Inflight, ERROR, CANCELLED, exhausted recovery and deleted DBOS history leave the permanent row OPEN. Only success
under that SAME workflow ID or explicit platform resolution naming that row clears it; a successful fork never
clears its origin. The delivered SDK leaves ERROR unchanged on resume; cancelled/max-recovery runs can resume under
the same ID. Failure evidence survives until actual resolution. Deterministic IDs, partition keys, per-key order,
retry policy and the existing dedicated `WORK_QUEUES` locator queue remain unchanged.

`ERASURE_LOCATOR_EFFECTS` includes the implemented `semantic_erasure` tombstone and `semantic_erasure_locator`
names. Their normal effects relay
opens and closes native locator-work rows. It pages exact committed source positions, emits one continuation
with its checkpoint, and rechecks the account-home fence on replay. Source-role capture and the native record
commit together; foreign effect delivery records the account-home inbox and any late item while holding that
fence. The local payload commit precedes late resolution. Content's cleanup modules are not Semantic custody
ports, and the shared-history encoders are not a shared minimizer or a receiving custody receipt.

Required participant native schedules, **NOT YET FROZEN** until actual Semantic producers and barriers bind:

| Schedule                                                                                                                  | Native observations required                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect already writing its locator when the native fence closes                                                           | Actual owner lock/barrier interleaving, same-transaction locator/fence proof and exact T; the copy is either prevented or remains a recorded cleanup obligation.                                |
| Late locator after the previous page was empty                                                                            | Actual locator commit is durably open; no empty-page completion; owner minimization commits before coordinator resolution and participant ACK.                                                  |
| Crash after locator commit before minimization                                                                            | Restart finds that exact open item and invokes the real owning minimizer; payload and coordinator remain incomplete until it commits.                                                           |
| Crash after minimization before resolution                                                                                | Replay proves the committed minimization receipt, then resolves once; no payload resurrection or premature ACK.                                                                                 |
| Crash after resolution before the frontier passes T                                                                       | Participant ACK may already exist; overall completion stays pending until Accounts proves its delivery/open-work barrier. Never advance a checkpoint manually.                                  |
| Duplicate effect replay, including after final closure                                                                    | Actual producer rechecks the native fence and preserves minimized payload; locator/resolve replay cannot reopen activity or create a second ACK.                                                |
| All actual participant ACKs plus an open late item                                                                        | Overall completion remains pending until actual owning minimization then late resolution; never fabricate ACKs in participant acceptance to reach this state.                                   |
| No open item with delivery/open-work barrier still outstanding                                                            | Overall completion stays pending; the participant ACK depends only on its own closed-fence/local/located/shared obligations.                                                                    |
| Registered failed locator predating cutoffs for multiple accounts, including a partition absent from the backlog snapshot | Actual permanent open row holds all affected erasures; later rows outside a frozen cutoff do not. Native failed effect records remain until same-ID success or named platform resolution.       |
| CANCELLED/max-recovery same-ID resume; ERROR resume; successful fork; named resolution                                    | Observe actual relay/DBOS/native owner records. Same-ID successful resume can clear its row; ERROR resume and fork cannot; platform resolution names the original and retains failure evidence. |

Accounts' existing `test/access/erasure-late-items.test.ts` and
`test/access/erasure-failed-locator-work.test.ts` cover coordinator primitives, including all ACKs/open item,
failed work/cutoffs, same-ID resume and fork behavior. Their seeded coordinator fixtures and test-only effect
registrations are not Semantic participant acceptance. Those cases do not attest any Semantic payload cleanup.
Full participant closure schedules above remain required when actual Accounts shared-history custody exists;
the local runtime tests below exercise the normal registered Semantic producer without fabricating that custody.

These schedules require native owner records and commit barriers, not callback truth, a test-generated tombstone,
a fake ACK adapter or a manually advanced effects checkpoint. Existing agent synchronization proves only its
own field-clear replay behavior.

## Producing owner inventory

This is a coverage/dependency map, not an ownership transfer. The following physical stores are in
`db/semantic/schema.sql`, `db/zones/schema.sql` and `db/schema.sql`. A subject/release
is communal, so a creator match is not authority to erase the entire catalogue object. Conversely a public
skeleton cannot shelter old private body, labels, contact data, hashes or unpublished history.

| Store and payload                                                                                                                                               | Actual locator / enumeration evidence                                                                                                                                                                                                                | Required disposition                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate`: statement value, qualifiers/references, rank, release, origin; `fact`: label/description/alias/body, statement and retractions/expansion history   | Subject-home primary keys; `candidate_page`; `fact_compact_candidate`, `fact_label`, `fact_terms`. Proposal origin joins `candidate.revision` to `revision.recorded_transaction_id`; compact original assertion uses `fact.recorded_transaction_id`. | Erase private/unlisted/deleted/archived payload, including superseded copies. Retain only eligible published contributions with de-identified attribution. Native source-transaction hooks create role-first locators; the one-record local minimizer removes private bodies and superseded facts.                                                                        |
| `revision`: `source`, release, kind, verification/revocation receipt ids and original transaction                                                               | `(route,subject_id,revision)` and `revision_transaction(recorded_transaction_id,route,subject_id)`                                                                                                                                                   | Preserve original identity attribution semantics while minimizing personal source/history. Narrow platform erasure guards require the exact committed obligation and pending owning-home locator; ordinary immutable writes remain refused.                                                                                                                               |
| `acceptance`, `acceptance_current`, `adoption`: verdicts, heads, selection and revision; `retraction.references`, `hidden_candidate`, `moderation`              | Subject/Context/candidate keys and native revision transaction; current and historical versions are separate obligations                                                                                                                             | Follow acceptor/editor/moderator as well as author. Remove private references and decisions unless an explicit fields/purpose/expiry exception exists. Revision/moderation provenance is captured in the same source commit; private decisions and references are minimized through the native locator.                                                                   |
| `context`: labels, settings id/release, defaults; `context_extension.body` and extension activation digests/heads                                               | Context primary key, `recorded_transaction_id`; current owner is the real `semantic.context.owner` Access role, not a Semantic `account_id` column                                                                                                   | Current owner and former editors/owners both matter. Native owner-grant creation/revocation commits exact current/former-owner locators in the resource home. Old extension bodies/digests cannot survive as private archive copies. Global is communal.                                                                                                                  |
| `definition_release.body`, `definition_activation`, `release_composite`; `external_claim` and `source_candidate` external ids, source keys and statement digest | Release/digest/tuple primary keys, `source_candidate_retract`, recorded provenance transactions                                                                                                                                                      | Communal releases are not deleted wholesale by creator. Identify actual personal contributions and their private source/digest copies by exact producer locators; unknown custody is pending.                                                                                                                                                                             |
| `statement_disclosure`: account, target, property, disclosed flag, source/target order keys                                                                     | Subject/candidate key; inbound/outbound indexes are **partial `NOT disclosed`** and do not enumerate all consent history by account                                                                                                                  | Revoke disclosure at T, erase private order keys and copies; already disclosed rows must not disappear from the obligation. Point disclosure and candidate-page reads now fence the proposal author's current deleted/fenced account state through the exact revision transaction; native source hooks separately capture consent and editorial-role cleanup obligations. |
| `account_agent_subject`, `account_agent_moved_link`; derived agent subject/facts, redirects/merge members and verification/reversal receipts                    | Actual account mapping and receipt/subject keys; deterministic `accountAgentId`; reversal ledger                                                                                                                                                     | Partial `synchronizeAccountAgent` label erasure is real, but does not attest all roles, revisions or merged/verified copies. Keep terminal/original identity and replay fences, including types no longer in active definitions.                                                                                                                                          |
| `outbound_link`, `inbound_link`, Context variants/counters, relation slots, partition totals                                                                    | Native source/target/statement/Context indexed keys and re-emission indexes                                                                                                                                                                          | Apply source/privacy/identity-original/terminal fences before rows, exports and numbers escape. Projection catchup is not cleanup. An unproved public number is omitted under `aggregate-disclosure.md`; no account-wide graph scan.                                                                                                                                      |
| `zones.zone`: configuration JSON (labels/pages/templates/scopes/custom relations/appearance), mounts, visibility/state, withholding and lifecycle dates         | `zone_owner_keys(route,owner_id,state,zone_id)`; creation/current transaction ids; resource role `semantic.zone.owner`                                                                                                                               | Enumerate every state, not only active; erase private/unlisted/deleted payload immediately on account erasure without thirty-day delay. Zone owner is explicit, editor/acting-human attribution still follows transactions. Current table stores one head; receipt/event copies are additional custody, not an invented revision table.                                   |
| `editorial.write_basis`: principal kind/id, generated actor id, client, `requested_by`, recorded time, transaction/position                                     | `(partition_no,transaction_id)` primary key and unique `(partition_no,position)`; Semantic revisions/facts/Contexts and Zone transaction ids provide exact forward joins                                                                             | Semantic owns editorial provenance of its edits. The actual source transaction captures principal/requested-by into indexed role locators before attribution can be removed. Semantic minimizes its own basis rows and retains required shared-history coordinates; Accounts does not own this local cleanup.                                                             |
| `core.receipt`, `core.outbox`, durable work/DBOS copies                                                                                                         | Native receipt identity, outbox partition/position and actual durable work identity; direct locators commit with copies, foreign effect locators use the closed-fence/late-item protocol                                                             | Accounts owns the separate `shared-history` participant and its store minimizers. Locator research is not an exported runtime interface. Semantic must supply exact artifact locators and wait for their actual required minimization receipts.                                                                                                                           |
| Delivery media/cache copies                                                                                                                                     | Content's actual media object/cache locators, including `/v1/media` custody                                                                                                                                                                          | Content owns physical delivery minimization. Local JSON removal cannot certify media/cache/backup expiry. No new media custody API is created here.                                                                                                                                                                                                                       |

Every applicable author, editor, acting human, delegate and operator must be discoverable, including current Zone
and Context owners and former roles. `editorial.write_basis.requested_by` is delegation provenance. Deferred source hooks resolve its actual native
request principal into `acting-human` and `delegate` locators; the minimal locator registry is separate from
the attribution payload. A known candidate point lookup proves that fixture's ownership, never account-wide
absence. No JSON scan, name search, subject-wide sweep or central ownership graph may fill these holes.

Physical custody is assigned as follows; listing a dependency here cannot transfer its payload to Semantic.

| Exact physical store / record family                                                                                                               | Actual owner minimizer obligation                                                                                                                                             | Required shared custody                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `semantic.*` table named above, including identity/control/source records when delivered                                                     | The local runtime implements native role locators and bounded owning-home minimization; launch still requires certified historical coverage and every-role native acceptance. | Exact copied receipt/event/work keys to Accounts; actual media keys to Content where applicable.                                                           |
| `zones.zone` and Semantic edit rows in `editorial.write_basis`                                                                                     | The ONE Semantic participant owns local payload and editorial provenance minimization, including nonowner editors and acting humans.                                          | Accounts minimizes receipt/outbox/DBOS copies; Content owns delivery copies. Generic Access grants remain Access-owned evidence.                           |
| `core.receipt`, `core.outbox`, DBOS workflow inputs/results/steps and operational `enqueueIntent` history                                          | Accounts' existing shared-history participant must provide registered artifact minimizers and durable custody receipts; these exports remain missing.                         | Semantic supplies exact producer locators for all copied roles and waits for its required custody, without taking over physical deletion.                  |
| `access.erasure`, `access.erasure_acknowledgement`, `access.erasure_late_item`, `access.erasure_locator_work`                                      | Accounts owns coordinator IDs, barrier/frontier/cutoff, outcomes, late resolution and permanent input-free work evidence.                                                     | No personal payload in locators or coordinator evidence; these rows are not a second Semantic data registry or minimization certificate.                   |
| Access verification/reversal intent records in the account home                                                                                    | Access owns the intent TABLE and its erasure disposition; exact delivered schema/consumer bindings remain pending.                                                            | Derived Semantic provenance stays Semantic-owned; copied DBOS/receipt/event history stays shared-history-owned.                                            |
| `library.canonical_source_fact`, `library.canonical_source_state`; future Library directory/candidate/support/first-apply/rekey/canonical receipts | Library A5 owns ALL physical Library cleanup, including derived operational preparation; no Semantic exhaustion proof can certify it.                                         | Actual Library producer locators go to shared-history minimizers; Semantic stores only its own identity/control references and required receiving custody. |
| Content media objects, `/v1/media` and delivery caches                                                                                             | Content owns delivery minimization and proof for actual object/cache keys.                                                                                                    | Payload cleanup, delivery expiry and backups remain separately observed; no invented cache table or minimizer ABI.                                         |

The SAME `library-private-follow-counts` identity publication participant covers every Library canonical record,
including directory/support/concurrent first-apply custody. It is distinct from the fixed Library A5 erasure
participant. Neither protocol gains a third participant. Unknown owner locators or missing minimizer signatures
remain REQUIRED runtime prerequisites, never `none` or a claim that another participant's purge happened.

Registration's actual agent synchronization creates an account-linked agent. The native author fixture explicitly
runs that real producer; its accounts are not zero-data accounts. No `none` fixture is manufactured. Real `none`
requires genuine indexed absence across every role and every registered store, after custody is known.

## Identity source and control inventory

Identity publication and account erasure remain different protocols. The actual native identity store is in
`identity-epoch-store.ts` and `identity-epoch-admission.ts`; it is not a type-only future API. Its job, input,
change, mapping, home gate, step, publication acknowledgement, effect receipt and receiving admission
attempt/plan/source/receipt tables are part of this same Semantic participant. No third participant is added.

Job intent and verification/reversal receipts are payload-bearing. Job producer provenance creates the same
source-home locators as other native edits. `identityErasureRoles(pool, jobId)` reads exact indexed job-role
coordinates before a receiving transaction; `bindSemanticProducerRoles(tx, roles)` binds those roles to the
actual native receiving transaction through its command callback. Admission records therefore capture genuine
actor/delegate/acting-human provenance in their own home rather than joining a foreign job while holding it.
The job minimizer drops raw receipt text, receipt-derived keys and private verification receipt fields. Its
narrow immutable exception preserves every other job field. The erased receipt is only an observation and
cannot be used as an admission receipt.

Minimal communal transforms, original/terminal IDs, published mappings, structural control cursors and native
proof coordinates remain necessary to prevent replay resurrection. They are not permission to retain private
source text, unpublished history or digest-bearing personal receipts. Every new payload-bearing identity copy
must add actual source roles, bounded local disposition and required shared-history custody before launch.
Native every-role coverage, concurrent creation/capture/rekey/undo and crash/replay acceptance remain required;
identity publication receipts or acknowledgements never substitute for erasure custody.

Library owns its canonical directory, candidates, support, counts and preparation records, including
operational-transaction outputs. The existing `library-private-follow-counts` identity participant covers all
of its canonical records; Library A5 remains its separate erasure participant. Access owns its account-home
verification/reversal intent records. Accounts owns physical command/outbox/DBOS and operational
`enqueueIntent` history copies. No future minimizer or receiving-custody signature is inferred for those stores.

## T, retention and bounded work

T immediately denies private/unlisted reads, exports, counts and producer work, with cleanup paused. Test a live
other editor/moderator and anonymous native unlisted reads: a rejected deleted bearer alone proves too little.
[Zone eligibility](../zones/eligibility.ts) checks current native owner state as well as visibility and head
eligibility. Zone metadata/configuration and mutations, community Context ownership and private consent
source checks apply current native account fences. Context custody follows a live current owner, so a former
creator cannot erase a surviving owner's communal Context. Every late import/job/native source effect
must recheck the barrier before copying or publishing; replay must never resurrect payload or account benefits.
No new query, Source, identity or publication engine is implied.

Eligible PUBLIC contributions retain only their published data and `Deleted account` attribution. Private
candidate/history/reference/settings/agent copies cannot be retained beneath that public skeleton. Personal
unlisted/deleted/archived records are erased. Source licensing attribution and native original/terminal identity
rules still apply to independently retained communal data. No indefinite moderation exception is assumed; a
retention exception needs actual store, fields, purpose and expiry or the material is erased.

### Callable local runtime and native keys

`account-erasure.ts` exports `beginSemanticErasure(pool, accountId)`, `stepSemanticErasure(pool, accountId, continuation = 'event')` and
`readSemanticErasure(pool, accountId)`. Begin closes `(routeOf(accountId), accountId)` against the actual committed
Access obligation and preserves its native T without timestamp arithmetic. Read returns `{at, state, partition,
applied}`. A step returns `{changed, localComplete, rawKeys, bytes}`; `localComplete` is local discovery only,
never custody, participant or global completion. Applicability survives outside workflow history.
The sole default WorkModule registers `registerSemanticErasureWork(context)`. The returned scheduler records the
exact work ID in native progress before enqueueing with `return-existing`; enqueue failure remains retryable by
the original effect. This is a pending shared-work locator, never custody. The stable ID binds the account and
the unchanged native T. Each workflow step passes `continuation = 'workflow'`, examines one fixed routing home,
releases it, and commits the account checkpoint before the next separately persisted step. Event-driven callers
retain their native scheduled continuation. No workflow step contains another page or a held connection across
steps. Empty intermediate homes need no payload transaction. The terminal home has a native committed receipt
before the last account checkpoint, preserving replay after that commit. Queue configuration, partition ordering,
step retry policy and the single WorkContext executor lifecycle remain unchanged.

The migration creates source-home locators keyed `(partition_no, account_id, role, store, record_key)`. A partial
work index leads with partition/account then `(priority, store, record_key, role)`; source transaction, exact
record and delivery-position indexes support native joins and relay continuation. Record ordinals carry no
business payload. Each source table has an exact ordinal index. Same-transaction hooks resolve the real revision,
moderation or producer transaction; editorial basis supplies the principal and native requested-by assignment.
Native account-agent inputs and copied link roles use explicit typed source tuples. Current and former Context
and Zone owners are captured from native owner-grant changes; owner evidence never grants cleanup authority.

`erasure_progress` retains the account-home discovery cursor, native T, applicability and actual local workflow ID.
`erasure_home` retains
the owning minimization receipt, including applicability after a lost response. `erasure_delivery` retains each
source position's cursor outside workflow history. `erasure_fence` and `erasure_inbox` retain exact late delivery;
`erasure_provenance` retains a payload-free source transaction after editorial attribution is removed.
The account-home inbox has an unresolved-late partial index led by account and source home. Local discovery and
parent-driven minimization commit the exact child's late item before its payload; an interrupted payload commit
resumes its unsettled inbox receipt before advancing that home's discovery checkpoint. Source continuation also
drains those receipts before becoming idle, including when discovery already passed the owning home.
Children precede parents. A Context owner locator also seeks inherited extension/activation/composite children
through their native resource prefix, one child per step. The parent remains pending until indexed child
absence; the child deletion and its required custody coordinate commit atomically. Current communal definitions
with a surviving current owner remain eligible. Warm composed caches recheck current custody at T. Platform immutable exceptions require both the exact pending native locator and the
committed local obligation, and admit only the field-minimal mutation. They do not disable triggers or TRUNCATE.
Latest private facts keep an empty retract marker, preventing resurrection of an earlier value. Communal subjects,
public definition releases and published identity mappings survive. Identity jobs retain the communal transform
and native scope/proof coordinates while dropping raw receipt keys, digest-bearing command receipts and private
verification receipt text. An erased receipt is an observation, never an admission input or authority.

### Cost: owned native continuation

- Touches: one source-home pending locator, exact owning keys and indexed child probes; a separate account-home
  progress commit after releasing the source. Discovery visits fixed 4096 native homes, with no subject, name,
  JSON payload, account graph, ownership mirror or account-wide count scan.
- Bound: the adopted ceilings remain 100 raw keys, 64 KiB returned and 1 KiB per locator. This implementation
  uses one pending locator, at most one unsettled receipt key and one additional exact Context child key. All raw
  keys and their returned bytes count. Rejected and absent keys count. Native SQL/pool/row/block/request/response costs
  are captured by the shared growth harness; total steps grow with owned roles plus fixed routing discovery.
  Empty discovery uses one raw home key. Each durable step includes its native SQL and DBOS step receipt costs;
  it does not hide a loop of pages. Indexed inbox, progress and late-item predicates stay bounded even before
  fresh planner statistics.
- Growth check: `growth-account-erasure-local.test.ts` measures the same account neighbourhood under unrelated
  64/512/4096 population, then separately increases native owned roles and payload bytes.

### Pending custody and launch coverage

After all local homes complete, progress is durable `pending-shared-custody` and further local steps are idle.
`erasure_shared_custody` retains exact source partition/transaction/outbox position and account roles. Accounts
owns command receipts, outbox and durable-work payloads. The delivered history artifact/role encoders do not
supply an actual receiving minimizer/commit receipt; current native receipt keys also differ from the future
versioned history locator key. No future callback or successful receipt is inferred. Local cleanup neither
throws because that export is absent nor calls `acknowledgeErasure`.

The native producer migration does not invent a historical backfill or attest absence of pre-migration roles.
Historical coverage remains a launch prerequisite, as do full participant/shared-custody/final-ACK schedules.
Registration, queued work and a local empty page do not certify historical or foreign custody. Required media,
Library and backup/delivery obligations remain with their actual owners. Their pending status is independent of
local payload minimization and does not weaken full-account deletion.

## Native acceptance and remaining schedules

The two `account-erasure-user-cases.test.ts` suites use one actual kernel DB and native Auth host per fixture,
`test/support/account-deletion.ts`'s committed `deletePersona` with `{ version: 1, pool, auth }`, fresh human sign-in
and real `/account-operations/approve` then `/execute` deletion. They do not invoke lifecycle tombstone directly,
insert account/erasure/ACK rows, maintain a second registry or fake progress. They inspect exact known keys and the
real coordinator. The fixture's lack of Semantic worker deliberately leaves cleanup paused, not simulated complete.
`drainEffects(pool, partition, { deadlineMs })` is the committed checkpoint/head observer; without an actual bound
Semantic worker it cannot prove a participant ran or minimized anything.

Frozen available native scenarios cover current Context-owner anonymous reads; disclosed personal consent at its
source; a genuinely accepted/adopted public contribution alongside a private candidate; partial label clearing
and duplicate source effects; real private candidate/editorial custody remaining pending; live moderator reads;
unlisted anonymous Zone metadata and page rendering; live private Zone editor reads and late producer refusal;
and individually deleted Zone payload with final account T and forbidden restore. Additional physical-store
cases bind Context payload to its Semantic editorial transaction, and a Zone configuration edit to a nonowner
editor, retaining actual pending obligations after T without manufacturing a purge or ACK. Positive native creation/read
assertions precede negative reads. A missing driver, 404 or 503 is never a successful substitute for setup.

The approved stale-schema corrections assert the exact pending object. Original calls to agent synchronization
remain agent-only observations; the local runtime suite invokes the real default WorkModule in fresh processes.

Native setup currently exposes two authority gaps, independently of shared-history custody. Principal assignment
requires `access:delegate` on the principal account; neither native personal-account activation nor an existing
resource role or governance holder supplies that action. Context extension publication/activation checks
`definitions:publish` and `definitions:activate` on that Context, while its owner role lacks both and governance
holds them only on Global. The real grant command denies both setup paths even with client consent. The native
schedules retain their positive setup requirements. Choosing initial holders or expanding global reach requires
an Access policy decision; erasure work does not seed grants or change the authorization formula to bypass it.

The following are **REQUIRED NOT YET FROZEN** native schedules. Do not implement them with unconditional throws,
fictional driver signatures or a helper that calls ACK on the worker's behalf:

| Required schedule                                                                                                                                                  | Delivered local evidence and still-required closure evidence                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current AND former authors/editors/acting humans/delegates/operators; transferred Context owner; all archived/deleted versions and settings/custom relation copies | Native role capture and callable local stepping are delivered. The runtime suite retains real transfer, nonowner editor, principal assignment and Context publication schedules; every-role and historical coverage must pass before launch. Generic grants and forward joins alone are insufficient.                                   |
| Bounded children-before-parent purge over account records and independent unrelated populations                                                                    | The real default WorkModule, permanent checkpoints, native key/byte caps and narrow own-table guards are delivered. Native 64/512/4096 and owned-role/byte growth use shared SQL/pool measurement and exact physical keys; all required families remain subject to that bound.                                                          |
| Crash after local commit, before shared minimization; crash after minimization before ACK; replay with later effects                                               | The local runtime suite uses fresh default workers at locator, payload, late-resolution and last-page commit boundaries. Final shared-minimization and pre-ACK crashes still require actual Accounts/Content exports and durable custody receipts. Agent synchronization alone does not prove these schedules.                          |
| Semantic remains pending until ALL actual local and shared minimization commits                                                                                    | Semantic exact same-transaction producer locators for direct copies, fence/late-item locators for effect-written foreign copies, Semantic editorial row minimization, and Accounts shared-history store-owned minimizer exports/receipts; Content delivery proof as applicable. None are inferred from research or a dispatcher return. |
| Final separate account-home ACK once, immutable duplicate replay, late effects cannot resurrect                                                                    | Bind the actual participant to the real WorkModule, then observe final local/shared commits followed by native ACK transaction and unchanged coordinator record on duplicate delivery. No direct test-generated semantic ACK can stand in for that worker.                                                                              |
| Private/deleted/archived export/count surfaces at T and public retained skeleton free of every private historical byte                                             | Actual owner enumeration and export/count producers where absent, plus final minimization driver and exact copy keys. Existing T/public cases freeze available native surfaces, not a new export API or a certification of final storage absence.                                                                                       |
| Genuine no-applicable-data account                                                                                                                                 | Indexed absence proof across ALL roles/stores and real registration/agent disposition. Unknown stores or missing cleanup may never return `none`.                                                                                                                                                                                       |

The sole local participant producer is registered by default. The manager binds the final separate account-home
ACK only after actual Accounts shared-history producer exports and commit receipts exist. Existing lifecycle,
retention and privacy tests retain their authority; no new public deletion, export, hold or restore API is added.
