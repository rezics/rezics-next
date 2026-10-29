# Shared history during terminal account erasure

Research evidence, 29 October 2026. Repository baseline: `da107d37f4b90b508bd705e8d2b0eaa1b38c444b`.
This report recommends a design for adoption by accounts and the affected store owners; it does not change their
contracts. [Account erasure](../deletion.md#account-erasure), the kernel's [partitions and receipts](../../services/kernel/README.md),
and Access's [erasure consumers and retention inventory](../../services/kernel/src/access/README.md) are authoritative.
There is no production data and no backfill is necessary. Complete producer coverage must precede launch.

## Finding and recommendation

Shared history holds substantially more than an account's own commands. An operator's command can copy an acting
human, delegate or subject; a service event can name a reporter, author, member, buyer or creator; a workflow step
can persist another account even when its input contains only an order or operation ID. Indexing only
`receipt.actor_account_id`, event subjects, or DBOS authenticated users would miss these copies.

Use producer-declared, typed account references and three registered artifact minimizers: `command-receipt/v1`,
`outbox-event/v1`, and `durable-work/v1`. Preserve receipt identity and log positions while clearing payloads.
Remove account-bearing DBOS executions using the supported cancellation/deletion APIs once their native obligations
are settled or transferred. The completion record already lives in PostgreSQL outside DBOS; retaining private
workflow history for completion is unnecessary. A default thirty-day history sweep is not account erasure.

Record locators in the artifact's physical partition in the transaction creating the copy. Account-local writes
therefore use the account's partition; foreign-partition copies use a producer-maintained account-prefix index in
that foreign partition. Erasure visits the fixed 4,096 partitions, one per step, and seeks only the deleted account's
prefix. This deliberately pays fixed discovery work at erasure rather than a cross-partition write on every command.
DBOS uses a second local transaction on its system database, described below. No account-wide JSON query, identity
string search, remote hot-path locator write, or central ownership graph is required.

## Inventory and present retention

The schema citations below identify physical storage, not merely application return types. `K` below means
`services/kernel/`; all repository paths are relative to the repository root.

| Store / artifact | Schema authority and producing code | Account roles and copied personal fields | Retention today |
| --- | --- | --- | --- |
| `core.receipt` / command receipt, including no-effect receipt | `K/db/schema.sql`; migrations `20261025050000_receipt.sql`, `20261025095021_receipt_principal.sql`, `20261028013300_receipt_observed_position.sql`; `K/src/command/command.ts`, `fence.sql`, `no-effect-fence.sql` | Principal kind/ID, generated `actor_account_id`; arbitrary `response` can include target accounts, acting human, operator, request context, handles, profile/preferences, grants, order/checkout details, durable initiator record or authorization references. `idempotency_key` is caller-supplied text, so it can itself contain personal text. `request_digest` is a correlation token, not plaintext. The principal alone does not describe response subjects. | No time-based receipt expiry or account minimizer. Receipt identity supports idempotency permanently. |
| `core.outbox` / one event at `(partition_no,position,event_seq)` | `K/db/schema.sql`, migration `20261025020000_core_outbox.sql`; same command fence | `data` and optional `subject`; catalogue inventory below. Actor/human/delegate/operator associations also come from the producing command, even if the event contains only a resource ID. | No payload expiry or erasure. `events/log.ts` requires contiguous envelope positions and event sequences. |
| `dbos.workflow_status` / durable execution metadata | DBOS migrations and system database source [S1]; `K/src/work/client.ts`, `registry.ts`; SDK calls listed below | `workflow_uuid`, `queue_partition_key`, `deduplication_id`, `parent_workflow_id`, `forked_from` may encode account/operation identity. `authenticated_user`, `authenticated_roles`, `assumed_role`, `request`, and legacy `inputs`, `output`, `error` columns can contain context/payload. Current kernel does not deliberately set DBOS authentication context, but that is not an erasure guarantee. Names, application/executor IDs and timestamps must remain operational rather than user text. | `K/src/work/retention.ts`: terminal SUCCESS/ERROR/CANCELLED/MAX_RECOVERY_ATTEMPTS_EXCEEDED, default 30 days, configurable 7–365 days; every ten minutes, at most 60 batches of 1,000 IDs. Nonterminal history remains. |
| `dbos.workflow_input` / workflow input | [S1], migration `109_workflow_payload_tables`; PK `workflow_uuid`, column `inputs` (serialized text), `retention_timestamp` | Generic effects copy the entire CloudEvent. Native workflows copy membership authorization, account/member IDs, operator/organization references, verification decisions, payment/provider references, content operation references and voter jobs. Roles include durable initiator and every subject in the input. | Same execution history policy. This is singular `workflow_input`; older `workflow_inputs` and `workflow_queue` tables are dropped by SDK migrations. |
| `dbos.workflow_output` / workflow result or failure | [S1], same migration; PK `workflow_uuid`, `output`, `error`, `retention_timestamp` | Membership result includes account/reservation; other results contain IDs, cursors or failure details. Serialized exceptions can include personal messages and stack context. | Same policy. No FK to status in the inspected SDK. |
| `dbos.operation_outputs` / durable step and child result | [S1], initial table plus payload-retention/FK migrations; PK `(workflow_uuid,function_id)`; `output`, `error`, `child_workflow_id`, `function_name`, `serialization` | Membership reservations; verification request/decision; commerce Order and CheckoutSnapshot; rating page cursors containing `voterId`; arbitrary content page return values; child IDs. Step arguments are not separately recorded by `registerStep`, but returned arguments/objects and errors are. | Same policy. Migration `112_drop_operation_outputs_workflow_fk` removes the FK: deleting status alone leaves this table behind. |
| `dbos.workflow_events`, `workflow_events_history` / workflow event | [S1]; PKs `(workflow_uuid,key)` and `(workflow_uuid,function_id,key)`; `value`, `serialization` | `content/work.ts` writes `CONTENT_OPERATION_PROGRESS`: counters `processedPosts`, `erasedRevisions`, `steps`, linked to a private operation. Future event keys/values can also carry personal data. Count-only data attached to a private workflow still belongs to its locator. | Same policy; status deletion cascades. |
| `dbos.notifications`, `streams` / possible durable message or stream | [S1]; message `destination_uuid,topic,message,serialization`; stream `workflow_uuid,key,offset,value,serialization` | No current kernel producer of send/receive/stream payloads was found. These are not permission to start untracked copies. A future message must scope the destination workflow to every copied account, including a sender appearing in its payload. | SDK status cascade; no independent kernel account erasure policy. |
| Boundary: `editorial.write_basis` | `K/db/schema.sql`, command fences: principal kind/ID, generated actor ID, `client_id`, `requested_by`, transaction/position/time | Editorial provenance, including semantic edits. It is personal, but semantic owns its policy/minimizer. This participant must not erase the provenance or attest for it. | No generic expiry; owning policy applies. |
| Boundary: native operation, order, membership, content, Auth, search and delivery stores | Their owner schemas; especially `access/durable-initiator.ts` | Native truth and authorization evidence are separate from their receipt/outbox/DBOS copies. Media storage/cache custody belongs to content/delivery. | Each participant's retention and acknowledgement, not shared-history's. |

`core.partition` and `core.consumer_checkpoint` contain routing, epochs and log cursors, not account payloads.
DBOS queue definitions, scheduler state and `event_dispatch_kv` currently hold workflow/schedule configuration,
not account data; kernel does not use the latter as a personal dispatch store. Include a closed nonpersonal
declaration for these surfaces in the work registry. Adding personal schedule/config/dispatch data would require a
new supported artifact contract before use; deleting a workflow does not erase arbitrary configuration rows.
Application logs, backups and external payment systems are not stores this acknowledgement can certify.

### Event catalogue audit

The following expands `K/src/events/catalogue.ts`, including its imported subcatalogues. In this table
`access.X` abbreviates the exact type `com.rezics.access.X.v1` (likewise other prefixes); brace lists enumerate
each exact suffix, not wildcard subscriptions. Fields listed are those needing account association or minimization,
not a replacement event schema. Resource/private-reference events require associations supplied by their owner,
not inference that every UUID denotes an account. A catalogue person is not automatically a REZICS account.

| Schema file under `K/src/` | Event types | Personal fields or owner-known account link |
| --- | --- | --- |
| `access/events.ts` | `access.organization-close.page`; `access.organization-close.{release,completed}` | Page `members[]`, `handle`; release/completed `accountId`. |
| same | `access.rating-counter.changed`; `access.operator.{subject-unfenced,subject-fenced}`; `access.account.{suspended,reinstated,rate-tier-set}` | `accountId`, account state/rate, fence receipt, optional continuation operation, `at`. |
| same | `access.grant.{create,change,revoke}`; `access.role-grant.{create,change,revoke}`; `access.assignment.{create,revoke}`; `access.governance.bootstrapped` | Grant `subject.id` (account or organization), legacy `subjectId,subjectRole`, resource/actions/valid/role; assignment `requestedBy` embeds principal UUID in a request URN; bootstrap `accountId`. |
| same | `access.handle-held`; `access.{organization-handle-published,account-handle-published,transition-handle-claimed,transition-handle-redirected,handle-transition-completed,handle-transition-cancelled,handle-transition-released,registration-handle-released,handle-reserved,handle-claimed,handle-redirected,handle-expired}` | Handles, `accountId` where present, reservation/operation/expiry/exception metadata. `handle-expired` has only `handle,released`: producer must retain its known former owner association before dropping native ownership. |
| same | `access.registration-expired`; `access.{actor-pending,actor-activated,self-read-installed}` | Tombstone/fence `accountId,priorOperatorAccountId`; registration ID/expiry; installation count. |
| same | `access.coordination-reserved`; `access.membership-terminalized`; `access.organization-created`; `access.membership-changed` | `accountId,relatedAccountId`, `organizationId,memberAccountId`, owner account, membership role, reservation and transaction/key metadata. |
| same | `access.{authentication-floor-advanced,authentication-fenced,authentication-established,account-updated,account-display-name-changed,account-tombstoned}` | `accountId`, authentication floor/kind/receipt; tombstone `priorOperatorAccountId`. Display-name event names the account but does not contain the display name. |
| same | `access.agent-verification.{reversing,reversed,requested,withdrawn,approved,rejected,failed,verified}` | `accountId`, request/catalogue/verification/decision receipt IDs; reversal `requestedBy` is a reviewer account and `reason` is text; failure `problemType`. |
| same | `access.membership-inverse-{reserved,bootstrapped,released}`; `access.membership-coordination-released` | `accountId`, principal organization/realm, reservation, source/proof transaction; coordination also `organizationId,memberAccountId`. |
| same | `access.operator.{management-provisioned,responsibility-reserved,relation-recorded,responsibility-retired,responsibility-released,opening-authorized,opening-consumed}` | `operatorAccountId,subjectAccountId`; opening also `actingHumanId,clientId,scopes,requestedBy,expiresAt,purpose`, responsibility/version/receipt. |
| same | `access.operator.{fence-page,unfence-page}`; `access.{workflow-bound,workflow-approved,credential-approved-consumed,credential-floor-advanced,cleanup-continuation.recorded,cleanup-continuation.renewed}` | Page/digest, approval/opening/continuation/receipt IDs, expiry: indirect private authorization links; inherit owner roles even without an account field. |
| `commerce/events.ts` | `commerce.payout_statement.{updated,paid}`; `commerce.offer.{created,revised,delisted}`; `commerce.order.{created,updated}`; `commerce.transactions.recorded`; `commerce.entitlement.{granted,restored,revoked}` | Statement/offer/order/entitlement references; `creatorAccountId,transactionIds`; order resolves buyer and creator, not just principal. Private statement/payment/entitlement links remain personal even without email. |
| `community/events.ts` | `community.space.{address-claim-pending,address-claim-accepted,address-changed,address-activated,address-reservation-skipped,address-reserved}` | `spaceId,address`, optional revision. Address can be identifying user-selected text. |
| same | `community.realm.{ban,unban,membership,membership.requested,membership.terminalized}` | `accountId`, ban `actor,reason`, membership `role`, operation/reservation and time/transaction. Unban has no actor field; its actor comes from command evidence. |
| `content/events.ts` | `content.{thread.created,post.created,revision.created,board.created,authored-field.created,authored-field.erased,reaction.changed,author-item.projected}` | `actorId,authorId,authorAccountId`; target/thread/item/revision/board/subject links, reaction kind/history and activity time. |
| `content/media-events.ts` | `content.media.{reserved,uploaded,available,rejected,erased,collection-pending,collected}` | First two explicitly `actorId`; all `mediaId,containerId`, rejection decision; native owner supplies uploader/subject account link. |
| `content/media-import-events.ts`, `media-moderation-events.ts` | `content.media.{import-requested,taken-down}` | Media reference/security revision; source URL is native/step data, not in these events. |
| `content/moderation-events.ts` | `content.moderation.{appeal-created,appeal-resolved,takedown,restored,erasure}`; `content.post.erased` | Appeal or private target/post/thread/media reference; native reporter/appellant/author/operator scope, not assumed current principal. |
| `content/report-events.ts` | `content.report.{created,resolved}`; `content.report-target.projected` | `reportId,targetKind,targetId,revisionId?`; reporter is an indirect native association. |
| `content/operation-events.ts` | `content.author-erasure.requested` | `operationId,threadId,authorId`, also durable initiator scope from native operation. |
| `content/source-fence-events.ts` | `content.source_fence.taken_down` | `source,external_id,field_group`, route/revision/removal evidence; owner must declare any account link to external identity. |
| `library/events.ts` | `library.account-facts.purged`; `library.follow.updated`; `library.entry.{updated,deleted}`; `library.progress_session.updated`; `library.copy.{updated,deleted}`; `library.published_log.{updated,deleted}`; `library.collection.{updated,deleted,member.changed,listing.changed}` | Explicit purge `accountId`; follow target can itself be an account; private subject/session/copy/log/collection/member references disclose account activity via their owner. |
| `rating/events.ts` | `rating.{voter-realm.changed,vote.changed,segment.page,eligibility.changed}` | `voterId`; vote scores/units/revision/populations/targets; segment nested votes and changed-at history, realm/direction/rekey metadata. |
| same | `rating.source_statistic.changed` | `sourceRecordId` and subject/source reference require an owner disposition when related to an account; public catalogue statistics are not automatically account data. |
| `semantic/events.ts` | `semantic.links.moving` | `verification.account`, free-text `verification.receipt`, cursor array; distinguish account verification from public subject IDs `id,survivor`. |
| same | `semantic.links.{changed,keys-changed,visibility-changed}` | Changed links contain `external,outbound_order_key,order_key,source_type,property` and other relation fields; key/visibility cursors contain raw strings/integers. Owners must declare account-linked values from typed native inputs; no eraser searches these strings for names. |

For completeness, these catalogue types contain only public resource identity, aggregate or configuration fields
as currently specified: `community.space.{created,updated}`, `community.realm.{created,updated,board-scheme}`,
`community.publication.{adopted,withdrawn,rejected}`, `content.{board-thread.projected,subject-thread.projected}`,
`library.subject.listed`, `rating.{aggregate.applied,prior_epoch.work,public_figure.changed,population.pending,subject-merge.page}`,
`subject.{created,visibility_changed,statement_visibility_changed,merged,revised,statement_disclosed,adopted}`,
`statement.{retracted,proposed,accepted,rejected}`, `semantic.{context.created,links.projected}`,
`zone.{created,configured,published,deleted,restored}`, `definitions.{published,activated}`,
`presentation.profile.{published,activated}`, `access.exposure.{opened,closed}`,
`access.workflow-approvals-swept`, and `access.standing-parent.installed`.
Their command actor/human/delegate still supplies locator roles. A private association in a producer overrides
the public-resource disposition. The registration test must require one disposition for every exact catalogue type,
including future additions; silent default-to-nonpersonal is forbidden.

### Durable producers and payload audit

`K/src/events/effects.ts` currently serializes `(effectName, fullCloudEvent)` into a generic workflow, whose
`effect.run` step returns void but persists thrown errors. Its ID is
`fx:<epoch>:<partition>:<position>:<eventSeq>:<effectName>`. A consumer checkpoint proves dispatch, not execution.
Queue partition keys are scheduling labels, not physical data partitions. `events/relays.ts` discovers work;
it is not a producer of a second authoritative account index.

| Producer / registered work | Inputs, durable outputs and account evidence to declare |
| --- | --- |
| `K/src/access/membership-work.ts`: `enqueueMembership`; `K/src/community/work.ts`: join/leave enqueues through it; registered steps in `services/auth/src/membership-workflows.ts` | Input member/organization/principal, role, authorization reference, reservation. `reserve` returns `{accountId,principal,reservationId}`; final result has account/reservation. Approval resolver supplies initiating account, acting human, operator and delegate; a sealed authorization reference is still private. Registration runs on the kernel's DBOS instance although step source is in Auth. |
| `K/src/access/agent-verification-work.ts`: approval enqueue and reversal effect enqueue; decision/start/merge/writePage/finalization steps | Request/account/catalogue/receipt and reviewer `requestedBy`, reversal `reason`; `readDecision` returns the stored verification request including account/kind/reviewer/state/decision. WorkResult failure details can contain text. |
| `K/src/access/operator-fence-work.ts`, `organization-close-work.ts`: local `enqueue` helpers and registered page runners | Operator/subject or organization references, root receipt, step/page key, continuation cursor/result; native responsibility/closure state supplies all affected accounts. Existing bounded page workflows are useful precedents. |
| `K/src/commerce/enqueue.ts`: `enqueueStripeEvent`; `commerce/work.ts`: reconcile effect enqueue, checkout-sync child and expiry-sync child | StripeEventRef contains event/session/payment-intent identifiers. `resolveCheckout`, `readCheckout`, `getOrder`, `createCheckout` persist provider snapshots, full Order or checkout result. Order includes `buyerAccountId,creatorAccountId,title,checkoutSessionId,checkoutUrl` and financial state. Snapshot includes session/client-reference/order/payment-intent/charge/refund/dispute/transaction references, amounts/status/times. Resolve order's buyer AND creator from native indexed truth. Native financial retention does not justify these operational copies. |
| `K/src/content/relays.ts`: `enqueueContentEffect` image/purge/importFromUrl/authorErase; subject-reaction merge enqueue; `content/work.ts`: purge-failure cleanup enqueue, post-erased effect enqueue, `createContentOperationClient.enqueue` | Media/post/operation plus exact source envelope coordinates. Native operation provides initiator snapshot (actor/account, client, requestedBy, authn epoch/scopes, delegation, original operator, creation receipt/digest); copying only an operation ID still copies a private association. Image/import failures may contain source URLs. AuthorErase page results and progress events persist activity/counts; subject-reaction page cursor may name an actor. |
| `K/src/content/work.ts`: collection and notice-retention scheduled parents/partition children, board-rank work | Currently partition/counter inputs or results can be nonpersonal. Require explicit declaration and sanitized errors. Never return personal candidate rows/cursors from global scans into DBOS; keep them in native progress or account-scoped children. |
| `K/src/library/work.ts`: collection-listing effect enqueue and registered `syncPage` loop | Event/collection ID; page subject cursor, collection owner's private activity. |
| `K/src/rating/segment-job.ts`: effect enqueue and page workflow | Job `voterId,realmId,transitionId,direction,populations,at`; page cursors and next jobs. |
| `K/src/rating/merge-job.ts`: effect `context.enqueue` and subject-merge workflow | Subject IDs at input, but page result cursor `{voterId,questionId}` introduces a personal role later. Move this cursor to native progress rather than discovering its owner after DBOS already saved it. |
| `K/src/access/write-rate-expiry.ts`, `work/retention.ts`; schedule registration in owner work modules | Operational routes/configuration/counts only today. Keep account identifiers and personal exception text out of their input/result/error/event metadata. |

These are all present kernel enqueue/startWorkflow sites, including children and failure cleanup. Every registered
step/result/event writer in those workflows needs the same work contract; instrumenting enqueue alone cannot
discover later copies. `work/client.ts`'s legacy realm-leave compatibility query searches serialized inputs: it is
not an acceptable erasure locator and must never be called by this participant.

## Exact locator relation and atomic writes

Proposed application-owned relations (not modifications to DBOS tables):

```sql
-- Installed in every artifact database; partition_no denotes the originating physical partition.
CREATE TABLE core.history_locator (
  partition_no integer NOT NULL,
  account_route integer NOT NULL,
  account_id uuid NOT NULL,
  artifact_type text NOT NULL,
  locator bytea NOT NULL,
  roles integer NOT NULL,
  minimizer_version integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  proof_barrier uuid,
  PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator),
  CHECK (octet_length(locator) <= 256),
  CHECK (state IN ('pending', 'minimized'))
);
CREATE INDEX history_locator_pending ON core.history_locator
  (partition_no, account_route, account_id, artifact_type, locator) WHERE state = 'pending';
-- history_seal PK (partition_no,account_route,account_id), committed barrier identity and phase.
-- history_progress PK (account_route,account_id,barrier_id,store_kind,partition_no), raw cursor/proof.
-- history_work PK (partition_no,work_id): bounded request state, owner-ready proof, retired marker.
```

The implementation adds FK/check constraints for route range, account/route consistency, registered type/version,
role bitmask, proof state and a fixed enum for store kind. Barrier identity is the immutable committed
`access.erasure` identity, not caller-supplied authority. Progress is fixed-size control evidence, not a graph.
Do not copy handles, user text, bearer credentials or opaque authorization seals into locators/proofs.

Locator codecs are versioned binary tuples: receipt `(principal_kind,principal_id,command_kind_id,key_token)`;
event `(epoch,position,event_seq)` with partition in the prefix; work `(work_id)` with a bounded opaque ID and
system-store identifier fixed by configuration. Registered command kinds get bounded nonpersonal identifiers.
Before launch, store a stable keyed HMAC token of the supplied idempotency key instead of arbitrary raw text,
using the same derivation for every writer/reader; preserve the full principal/kind namespace. Keep the key material
for as long as receipts can be replayed, with an explicit key version. Raw command keys must not leak into durable
IDs, locator bytes or error strings. This closes the key-field gap without restricting callers to guessed-safe text.

`roles` is a union of actor, acting-human, delegate, durable-initiator, operator and subject; role differences do
not create duplicate artifacts. Shared executors obtain authenticated roles from committed authorization evidence;
owners explicitly provide typed subject/related-party references from native inputs/rows before modifying them.
No recursive JSON walk guesses these roles. Require at most 64 distinct account references per producer unit,
64 KiB per serialized payload, and the existing 1,000-event envelope maximum; lower owner page sizes where needed.
Validation fails the producer transaction before a copy can be committed without its complete scope.

For receipts/outbox, collect references during the command body and insert exact locator rows in the same
serializable command transaction and partition as `fence.sql`. `no-effect-fence.sql` must also insert its receipt
locator: no-effect is not no-personal-data. Abort/serialization rollback removes both copy and locator; replay
does not create a second copy. The account actor is automatic, but an anonymous/service command must still declare
personal subjects. The owner of each returned value declares its response scope separately from each event scope.

For a foreign account, this transaction writes the locator locally with that account's route/ID. No distributed
transaction or account-partition write is introduced. The new PK/index is the required producer-maintained index;
existing actor-only generated indexes do not cover humans, subjects and delegates. At erasure use exactly
`WHERE partition_no=$p AND account_route=$r AND account_id=$a AND (artifact_type,locator)>($t,$l)
ORDER BY artifact_type,locator LIMIT 8`, using the pending index where appropriate. No OFFSET/count/distinct/group
over the partition. Discovery pays at most 4,096 indexed prefix probes per configured store domain, even for `none`.
Routing snapshots/epochs prevent a moved partition being skipped; a move invalidates its proof and retries that
partition. Do not hold one partition's connection while opening another.

### DBOS transaction boundary and late-write fence

The public `DBOSClient.enqueueInTransaction` accepts a caller-owned PostgreSQL transaction **on the system
database** [S1, S2]. It cannot make two databases atomic. Use this protocol:

1. In the producing native transaction, write the copy's exact durable-work intent, bounded scope references,
   source locator and deterministic work ID. For an event effect, its outbox row plus registered typed scope is
   the intent; materialize its work request in a bounded relay transaction before releasing source evidence.
2. Release the native connection. On the configured system database, lock the local work identity and account
   seals, insert local work locators, and call `enqueueInTransaction` on that SAME client. Commit these together.
   Use `workflowIDReusePolicy: 'return-existing'`; the different `duplicationPolicy: 'return-existing'` option
   is explicitly unsupported inside caller transactions [S1, `client.ts`]. Verify the stored immutable request
   digest on reuse. An aborted destination transaction exposes neither workflow input nor locator.
3. Record destination handoff/completion in the origin intent idempotently. Crash before/after either commit
   retries the same ID. Erasure checks outstanding origin intents as well as destination locators. A delayed
   relay cannot resurrect retired work. No source connection remains held during enqueue or waiting.

All direct `startWorkflow`/`client.enqueue` sites in the preceding table must route through this adapter, including
children. Track child obligations as bounded native work requests, not an unbounded DBOS descendant tree.
If origin and system storage happen to be colocated, the same-client operation can share one transaction, but
the design must not depend on that deployment accident. The application locator schema in the system database
has the same indexes; a scheduling `queuePartitionKey` does not provide physical locality.

Seal each `(store,p,account)` locally under platform authority bound to the committed erasure. Producers first
materialize its guard row and hold a shared row lock until commit; the eraser takes the conflicting exclusive
lock and commits the irreversible seal. This covers the empty-prefix case and orders an in-flight old producer
before the seal or refuses it afterwards. Existing native account admission fences still enforce T; a cached
pre-T account check alone is insufficient. Source and destination seals separately close the two-stage enqueue
race. After sealing, new personal copies for that account are refused, including step-created children,
retries, manual resume/fork/restart, external event/message injection and workflows with a living principal but
deleted subject. Platform erasure work has an exact restricted continuation path; it does not restore a deleted
durable initiator's former authority. Unresolved barriers/seals leave the acknowledgement pending.

Account scope must be complete before DBOS input creation. Future step results/events may contain only that
declared scope; discovering a different account in a page requires native progress plus a new scoped intent
before serialization, or removal of the account-bearing cursor from DBOS. Wrapping `setEvent` after it writes
or adding a locator after a step returns is not atomic. Prefer DBOS inputs/results of opaque native progress
ID and counts for workflows spanning unrelated accounts. Native sensitive cursor erasure remains with its owner.

## Artifact minimizers and bounded execution

Use a startup-only registry keyed by the artifact types/versions above, with closed command/event/work producer
registrations. A missing registration is a producer error and an erasure refusal, never evidence for `none`.
Process at most eight locator keys in one partition transaction, but invoke at most **one** artifact minimizer
per platform step. Cursor has only `(artifact_type,locator)`; page metadata is at most 4 KiB. Commit/release
between phases, SDK calls and partitions. Lock/statement deadlines yield retryable progress rather than growing
a transaction. CPU/IO may include B-tree height; no claimed bound is independent of index height or lock contention.

Before erasing a shared artifact, its owner supplies exact durable proof that all registered consumer obligations
are complete or deliberately terminalized by erasure. A projection checkpoint past the envelope proves its
projection pass; the effects checkpoint proves only enqueue. Store each effect's terminal/suppressed disposition
by exact work ID outside DBOS. Owner erasure must hand off this minimal proof before deleting native evidence.
Do not wait for all other participants' acknowledgements, which could form a cycle. If living accounts still
need a shared workflow, transfer their obligation to sanitized native work before retiring the old execution.

| Minimizer | Reads / writes and retained skeleton | Bound and replay proof |
| --- | --- | --- |
| `command-receipt/v1` | Exact receipt PK and owner-ready proof. Add `payload_state`; replace the whole `response` by a closed erased marker, retaining PK/token, request digest, epoch/observed position (including zero for no-effect), transaction ID and creation time. Principal technical ID stays solely for exact idempotency; generated actor ID derives from it. Native financial/provenance data is not recreated here. Replay of a minimized receipt must return a declared erased-result response without executing the body or disclosing old payload; metadata-only `hasOwnCommandCompletion` still verifies its digest. | One bounded receipt, one locator update and constant proof reads. Response cap 64 KiB; key codec <=256 bytes. Repeated marker is a no-op with the same proof. Settle durable initiator/source receipt obligations BEFORE losing their response/hash evidence. A receipt already removed needs an exact store-retirement proof, not an invented success. |
| `outbox-event/v1` | Exact `(p,position,event_seq)` row and consumer proofs. Set `payload_state=minimized`, `data={}`, `subject=NULL`. Retain epoch/position/sequence/count, UUID, original registered type and timestamp: these preserve log integrity, replay identity and diagnostics without the personal body. Do not delete the row or renumber events. | One bounded event (64 KiB) plus locator/proof writes. Repeat recognizes the same skeleton. Missing row at a live position is a log defect and cannot be called erased. |
| `durable-work/v1` | Exact application intent, work/retired record, DBOS ID and owner-ready proof. Commit local seals/retired marker; cancel exact execution through supported API, revoke its owner, then delete its complete history through `deleteWorkflows([id], false)`. Keep only opaque work ID, source coordinates, fixed terminal code and barrier proof in application storage. DBOS status/history need no integrity skeleton once completion/obligations are external. | One execution per step; no listWorkflows/filter JSON/recursive delete. Size/row caps below make deletion bounded. Repeated cancel/delete of an already absent ID must be treated idempotently using the committed retired record. Verify exact absence with bounded reads before setting locator minimized; crash after deletion repeats it safely. |

For outbox readers, adding `{}` without changing the log contract would fail schema validation and stop every
consumer. Extend `events/log.ts` to validate the closed minimized storage form and synthesize the registered
`com.rezics.history.minimized.v1` event at the SAME array index, with empty data and no subject. Its event ID/source/time
and envelope position stay stable; no effect subscribes to this marker. Validate envelope event-count/sequence
before substitution. This preserves `events.entries()` IDs and content's source event-index proofs. Consumers
skip only this explicit marker, not arbitrary invalid payloads. Test middle-of-envelope minimization, mixed
live/minimized envelopes, lagging consumers, already-enqueued effects, position zero receipts and gap detection.

### Supported DBOS removal and its limits

The pinned dependency is `@dbos-inc/dbos-sdk@5.4.6-preview` (`K/package.json`, `bun.lock`). The inspected upstream
revision [S1] and installed declaration expose the transactional enqueue and workflow-management operations.
The public docs document cancellation/deletion; cancellation does not interrupt an already executing step [S2].
Do not assume that `CANCELLED` alone makes arbitrary application side effects stop.

In `system_database.ts:deleteWorkflows`, the SDK explicitly deletes `workflow_input`, `workflow_output` and
`operation_outputs` by exact IDs before deleting `workflow_status` in one transaction. Status cascades remove
workflow events/history, destination messages and streams. Prefix indexes/PKs lead with the workflow ID;
notifications have `idx_workflow_topic(destination_uuid,topic)`. `deleteChildren=true` discovers descendants and
is unbounded, so it is excluded. Neither rewriting serialized DBOS columns nor issuing raw status DELETE is
supported erasure: the latter leaves orphan payloads. There is no public selective field-redaction API identified
for step results. Whole execution removal after native completion is the supported choice.

The inspected implementation's cancellation clears `owner_xid`; normal execution writes check and lock ownership
in `recordOperationResultInternal`/`#checkOwner`, and workflow completion writes update the matching owned status
before saving its output. A stale owned write therefore cannot commit after cancellation wins that lock. This is
a version-sensitive safety premise, not a new application right to edit DBOS internals. Require a real-SDK race
test: pause a step, cancel, delete, release the step, then assert no input/output/operation/event orphan or late
child appears. Also test stale client enqueue, resume and set-event attempts against application seals. Any
upgrade must pass these tests. Public external writers and application code need the local admission gate;
SDK ownership checks do not replace it. Read-only exact table probes in verification are acceptable; erasure
mutations use the SDK APIs exclusively.

Bounded IDs alone do not bound deletion: one workflow may have years of step history. Before launch, split the
current library listing, rating segment/merge and content draining loops into independent bounded page workflows,
with native progress and a new opaque work request for the next page. No workflow repeatedly awaits an unlimited
chain of children. Put broad partition sweep cursors in native nonpersonal progress; use account-scoped units
where results need personal references. Enforce at most 64 operation-result/function IDs including SDK bookkeeping,
eight event keys and 64 event-history rows per execution; no messages/streams for these contracts. Each serialized
input/output/step/event/error is <=64 KiB, metadata <=4 KiB, error messages sanitized to fixed codes rather than
user text. Retry policies must not exceed these cumulative budgets; roll over before exhaustion. Maximum delete
is 139 rows (status + input + output + 64 operations + 8 events + 64 history), under 10 MiB including metadata.
Application wrappers count writes BEFORE invoking the SDK; SDK-internal records count too. Tests must measure the
actual serialized representation and observed table counts, not just count user callbacks. New message/stream use
requires explicit caps and exact locators first. Existing unbounded histories cannot be declared safe by this rule;
there is no production backfill here, and producers must be converted before launch.

Cost per cleanup unit: at most eight key-only locator rows, one artifact, constant exact native proof reads, and
one partition checkout at a time. Receipt/event writes are O(log H) index work plus <=64 KiB payload processing.
DBOS work uses one local retirement transaction, one exact cancel, one exact supported deletion and bounded exact
absence verification; its payload row work is <=139, independent of other workflows. Whole-account work is
O(4,096 × configured store domains + the account's recorded artifact associations), allowing repeated constant
steps after transient conflicts; it is not constant in that account's own history. Hot-path locator writes are
O(distinct declared accounts × produced artifacts), capped by the producer unit; no remote transaction or scan.

## Shared-history effect and acknowledgement

Register a shared-history work module in `K/src/work/modules.ts`. Its tombstone effect consumes the committed
`com.rezics.access.account-tombstoned.v1` barrier, creates an opaque erasure job and returns; the job's DBOS input,
result/error/events contain only a random job ID and fixed codes. The account/barrier mapping and progress live
in account-owned PostgreSQL, not serialized DBOS history. Verify the barrier on every platform step.

Advance a persisted state machine: bind barrier; seal one origin/system partition; resolve its bounded outstanding
intents; settle/transfer exact consumer obligations; minimize exact locators; prove that sealed prefix empty of
pending artifacts; advance raw partition key. Revisit no completed partition unless routing epoch invalidates its
proof. Retired markers prevent replay re-enqueue after SDK deletion has removed DBOS's own deduplication record.
No step calls `restoreInitiator` as the deleted account. A failure, unavailable owner proof, unknown artifact
version, overflow or unreadable partition leaves the participant pending and retryable.

After the final store/partition proof commits, a separate native command calls
`acknowledgeErasure({pool}, {accountId,participant:'shared-history',outcome:'erased'})`. This is the acknowledgement
point: all relevant payloads are minimized, no outstanding copy intent can recreate them, and all locator proofs
are bound to the same committed barrier. `none` is allowed only with the same complete sealed coverage and zero
applicable artifacts/intents; empty currently-read pages or a global history timeout are insufficient. If any
artifact was applicable, including one previously minimized, the outcome is `erased`. Preserve enough minimal
locator/progress evidence to make retries prove the identical immutable acknowledgement.

Avoid a self-reproducing erasure tail. Today acknowledgement emits `access.account-updated {accountId}`;
tombstone and owner erasure commands also create personal history during cleanup. Register a closed **erasure
control marker** disposition: barrier/account technical IDs, route, participant, fixed phase/outcome and counters
only; no original handle/operator snapshot, authorization seal, arbitrary exception text or response payload.
Control copies get locators and can be proven minimized on creation as integrity skeletons. They cannot be a
generic exemption for account-updated events. The initial tombstone's `priorOperatorAccountId` and its ordinary
full-event effect input still need ordinary locators/minimization; transfer them to the opaque job before cleanup.
Acknowledgement's account-updated marker must dispatch via an opaque source reference rather than serialize its
account data into a new generic DBOS execution. Its consumers read the existing terminal account fact and record
only skeletal control evidence. The final acknowledgement transaction checks the sealed proof and records its
own marker locator already minimized atomically. An acknowledgement payload may not invalidate its own proof.

No diagnostic shared-history exception is recommended. Any later legal retention exception must enumerate purpose,
fields and expiry under deletion item 7; native commerce retention cannot silently exempt receipt or DBOS copies.

## Implementation slices for adoption

These are proposed work packages, not existing tickets. Each row is independently limited to **400 changed lines
and eight files, including new tests and SQL**. Paths below are exact or explicitly expanded by the producer-batch
table. All tests named here are proposed new files; preserve existing acceptance/frozen files. Use
`bun run --cwd services/kernel check <test-file-relative-to-kernel>` for each named kernel test, plus the root
typecheck in the implementation contracts. The research delivery itself runs no database tests.
Cost means bounded rows/bytes/statements per production unit, not a wall-clock promise. All growth tests seed
unrelated same-partition history at 512/4,096/32,768 rows and assert indexed raw-row access; ordinary fixture-size
assertions alone do not prove the bound.

| Work package | Paths (in addition to `K/` prefix) and new acceptance test | Acceptance and Cost bound; real dependencies |
| --- | --- | --- |
| Locator storage | `db/migrations/20261029090000_shared_history.sql`, `db/schema.sql`, `test/history/schema.test.ts` (3 files, <=350 lines) | Exact unique keys, pending seek, seal locks, rollback and empty-prefix concurrency; schema-only tables/indexes above. Eight key rows <=4 KiB per page. Depends on partition routing and erasure identity, not DBOS mutation. |
| Registry and codecs | `src/history/contracts.ts`, `src/history/locator.ts`, `test/history/contracts.test.ts` (3, <=350) | Version/type closure, role union, key/payload/scope rejection, every catalogue type explicitly classified. No database scan; <=64 account refs, <=256-byte locator. Depends on storage shape and existing catalogue schemas. |
| Local gates/progress | `src/history/gates.ts`, `src/history/progress.ts`, `src/history/seal.sql`, `src/history/page.sql`, `test/history/gates.test.ts` (5, <=380) | Producer-before/after-seal races, foreign subject and routing change, restart raw cursor; one partition and eight keys, constant statements. Depends on locator schema and committed Access barrier reader. |
| Receipt key codec and central readers | `src/command/receipt-key.ts`, `src/command/command.ts`, `src/command/read-receipt.sql`, `src/command/read-own-completion.sql`, `test/history/receipt-key.test.ts` (5, <=350) | Same raw API key gives same versioned HMAC namespace, mismatch/replay isolation, key longevity and no plaintext. Point reads only. Depends on registered kind IDs and stable key configuration; adoption must retain lookup keys for receipt lifetime. |
| Receipt key writer plumbing | `src/command/fence.sql`, `src/command/no-effect-fence.sql`, `src/command/command.ts`, `test/history/receipt-key-writes.test.ts` (4, <=250) | Normal and no-effect storage tokenization and unchanged digest/position semantics. Constant receipt write. Depends on codec; deploy central writer/readers and remaining reader slices together before launch. |
| Atomic command capture | `src/command/command.ts`, `src/command/fence.sql`, `src/command/no-effect-fence.sql`, `src/history/record.ts`, `test/history/command-capture.test.ts` (5, <=380) | Actor/human/delegate automatically captured, typed subject declaration, rollback and receipt replay, anonymous/service subjects; <=64 scopes per unit, existing envelope cap. Depends on gates, codecs and owner declarations below; missing declarations fail closed. |
| Atomic work adapter | `src/work/history-enqueue.ts`, `src/work/client.ts`, `src/history/work.sql`, `test/history/enqueue.test.ts` (4, <=380) | Same-client SDK enqueue/locator rollback, two-database crash cuts, duplicate ID digest conflict and late sealed request. One destination transaction and <=64 scope rows; no held origin connection. Depends on source intent and installed SDK transactional API. |
| Work budgets | `src/work/history-budget.ts`, `src/work/registry.ts`, `test/history/work-budget.test.ts` (3, <=350) | Enforce serialized bytes and cumulative SDK row budgets, sanitized failures and future-account rejection. <=139 rows/10 MiB/execution. Depends on complete work declarations; per-workflow conversion slices below must land before enabling caps. |
| Effects handoff | `src/events/effects.ts`, `src/history/effect-disposition.ts`, `test/history/effect-handoff.test.ts` (3, <=380) | Every effect ID gets exact intent/locator, terminal/suppressed native marker, capped registered fanout; crash/replay cannot enqueue retired work. Fixed <=32 handlers/event; source envelope at existing <=1,000 events. Depends on transactional adapter and owner obligation proofs; split dispatch into one work request per bounded relay unit. |
| Minimized log form | `db/migrations/20261029091000_history_payload_state.sql`, `db/schema.sql`, `src/events/log.ts`, `src/events/catalogue.ts`, `test/history/minimized-log.test.ts` (5, <=380) | Add receipt/outbox payload-state columns; preserve event count/index/IDs, reject gaps and invalid skeleton, skip marker without running old effects. At most one 64-KiB event rewritten; existing read envelope bound unchanged. Depends on catalogue registration; no consumer may lose source event index. |
| Receipt minimizer | `src/history/receipt.ts`, `src/history/receipt.sql`, `test/history/receipt-minimizer.test.ts` (3, <=300) | Personal response removed, same key cannot re-execute, metadata completion works, delayed initiator settled first. One exact receipt plus constant proof writes. Depends on state column, all receipt readers and owner readiness. |
| Outbox minimizer | `src/history/outbox.ts`, `src/history/outbox.sql`, `test/history/outbox-minimizer.test.ts` (3, <=300) | Clear data/subject only after projection and effect dispositions; shared living obligation transferred; replay-safe marker. One exact event and fixed registered consumer set. Depends on log form, effects handoff and owner's native proofs. |
| Durable minimizer | `src/history/durable.ts`, `src/history/durable.sql`, `test/history/durable-minimizer.test.ts`, `test/history/durable-race.test.ts` (4, <=390) | Real SDK cancel/delete, late step/output/event/child races, exact missing/retired proof, repeat after crash; no FK-orphan payload. One ID, <=139 rows/10 MiB; no descendant discovery. Depends on work adapter, budgets, all bounded-work conversions and readiness. |
| Shared-history coordinator | `src/access/shared-history.ts`, `src/access/shared-history-work.ts`, `src/work/modules.ts`, `test/history/coordinator.test.ts` (4, <=390) | Partition-by-partition barrier proof; none versus erased; unavailable partition, new registration, late request and fake authority stay pending. One artifact per step, fixed partition discovery; depends on all minimizers and native Access acknowledge API. |
| Control-history closure | `src/access/erasure.ts`, `src/history/control.ts`, `src/events/effects.ts`, `test/history/control-closure.test.ts` (4, <=350) | Acknowledgement/event/DBOS bookkeeping creates no personal tail; initial tombstone operator copy erased; replay immutable. Constant marker/proof writes, opaque work only. Depends on coordinator, log form and explicit native erasure command registrations. |
| Documentation adoption | `docs/deletion.md`, `services/kernel/README.md`, `services/kernel/src/command/README.md`, `services/kernel/src/events/README.md`, `services/kernel/src/access/README.md` (5, <=250) | Adopt the field-retention, producer, bounds and acknowledgement contracts listed below. No runtime work. Depends on agreement by the named owners, and final implementation choices verified by preceding slices. |

Every additional native receipt reader must use the same key codec before producer rollout. Make **one separate
slice per row** below: the listed SQL, its listed caller, and `K/test/history/receipt-reader-<name>.test.ts` (three
files, <=200 lines each slice). Acceptance: original exact completion/replay semantics with token storage, including
no-effect position zero; Cost: existing constant PK probe. All depend on the key codec and precede minimization.

| Name | SQL and caller under `K/src/` |
| --- | --- |
| auth-barrier | `access/auth-barriers-receipt-read.sql`, `access/lifecycle.ts` |
| workflow-approval | `access/workflow-approvals-tombstone-operator.sql`, `access/workflow-approvals.ts` |
| checkout-count | `commerce/command-checkout-count.sql`, `commerce/commands.ts` |
| membership | `community/membership-operation-receipt.sql`, `community/membership.ts` |
| erasure-page | `content/read-erasure-page-receipt.sql`, `content/erasure-workflow.ts` |
| operation-enqueue | `content/read-operation-enqueue-receipt.sql`, `content/work.ts` |
| erasure-workflow | `content/read-workflow-erasure-receipt.sql`, `content/erasure-initiator.ts` |

Checkout count currently uses a raw key prefix range. HMAC does not preserve prefix ordering: the checkout-count
slice must replace it with exact token probes for the two permitted numbered outcomes, preserving the existing
two-outcome bound and conflict/retry behavior. It must not HMAC the prefix and retain the old range SQL. If the
native order recorder changes that bound, change its explicit native sequence contract first, not to a receipt scan.

### Command producer batches: exact call sites

Each row below is a separate owner slice: edit the listed files under `K/src/`, and add
`K/test/history/producers-<batch>.test.ts` (at most five files and 350 lines). Acceptance for **every runCommand
invocation in each file**: its receipt and each event have locators for all declared roles, including a different
deleted subject under a living/service/anonymous principal; rollback leaves neither; a sealed role cannot be
copied. Owner-provided assertions enumerate payload fields and private references, with explicit nonpersonal
disposition where appropriate. Cost: <=64 declared accounts × that command's bounded artifacts, local inserts,
no cross-partition write. Dependencies: atomic capture, the corresponding native commands and typed account
evidence. Do not implement a second executor per owner.

| Batch | Exact producer modules/files |
| --- | --- |
| access-verification | `access/agent-verification.ts`, `access/auth-barriers.ts`, `access/bootstrap-governance.ts` |
| access-governance | `access/erasure.ts`, `access/gates/catalogue.ts`, `access/grant-command.ts` |
| access-lifecycle | `access/lifecycle-20261025094010-command.ts`, `access/operator.ts`, `access/preferences.ts` |
| access-standing | `access/rate-tier.ts`, `access/reinstatement.ts`, `access/session-revocation.ts` |
| access-approval | `access/standing-parent.ts`, `access/suspension.ts`, `access/workflow-approvals.ts` |
| commerce | `commerce/commands.ts`, `commerce/payouts.ts` |
| community-membership | `community/ban.ts`, `community/join.ts`, `community/membership.ts` |
| community-resource | `community/board-scheme.ts`, `community/publication.ts`, `community/realm.ts` |
| community-space | `community/space-address.ts`, `community/space.ts` |
| content-authorship | `content/appeals.ts`, `content/author-item-index.ts`, `content/authored-fields.ts` |
| content-command | `content/board-projection.ts`, `content/collection-job.ts`, `content/commands.ts` |
| content-erasure | `content/erase-post.ts`, `content/erasure-workflow.ts`, `content/image-job.ts` |
| content-media | `content/media-import.ts`, `content/media-moderation.ts`, `content/media.ts` |
| content-report | `content/reactions.ts`, `content/report-effect.ts`, `content/report-outcomes.ts` |
| content-index | `content/reports.ts`, `content/source-fence-command.ts`, `content/subject-reaction-merge.ts`, `content/subject-thread-index.ts` |
| library-core | `library/account-fact-purge.ts`, `library/collections.ts`, `library/command-support.ts`, `library/listing.ts` |
| rating-voter | `rating/aggregate-effect.ts`, `rating/eligibility.ts`, `rating/merge-job.ts` |
| rating-state | `rating/public-figure.ts`, `rating/segment-job.ts`, `rating/source-statistics.ts`, `rating/voter-realms.ts` |
| semantic-command | `semantic/account-agents.ts`, `semantic/candidates.ts`, `semantic/context.ts`, `semantic/definitions.ts` |
| semantic-relations | `semantic/extensions.ts`, `semantic/links.ts`, `semantic/merge-moves.ts` |
| semantic-subject | `semantic/merges.ts`, `semantic/moderation.ts`, `semantic/statement-disclosure.ts`, `semantic/subject.ts` |
| public-config | `presentation/profiles.ts`, `zones/resource-commands.ts` |

Wrapper call sites need explicit scope parameters too. Separate slices (same acceptance/Cost/dependencies,
<=350 lines, at most five files including one `test/history/producers-<batch>.test.ts`):

| Batch | Files under `K/src/` |
| --- | --- |
| lifecycle-wrapper | `access/lifecycle.ts`, `access/committed-continuations.ts`, `access/membership-inverse.ts` |
| lifecycle-work-wrapper | `access/operator-fence-work.ts`, `access/organization-close-work.ts`, `access/operator.ts` |
| library-wrapper | `library/entries.ts`, `library/copies.ts`, `library/follows.ts` |
| activity-wrapper | `library/sessions.ts`, `library/published-logs.ts`, `rating/votes.ts` |

### Durable producer conversions

Each row is a distinct slice, <=400 lines and <=four files, adding the stated new test under `K/test/history/`.
Change only the named producer(s), a new owner-local page/progress SQL file if needed, and the test. Depend on
the transactional work adapter, budgets, corresponding command producer declarations and native owner completion
ports. Acceptance common to every row: exact locators atomic with enqueue; every returned personal field has a
predeclared role or is replaced by opaque progress; no after-return registration; sealed retries cannot copy;
one page respects the 139-row/10-MiB execution budget with fixed fanout. The tests are real workflow outcomes,
not mocked claims that the wrapper was called.

| Slice / producer files | New test | Specific acceptance / Cost |
| --- | --- | --- |
| Membership: `access/membership-work.ts`, `community/work.ts`, `services/auth/src/membership-workflows.ts` (last path is repository-relative) | `membership-work.test.ts` | Reservation/final result and authorization scope cover member, organization, initiator/human/operator; fixed step sequence. |
| Verification: `access/agent-verification-work.ts` | `verification-work.test.ts` | Approval and reversal paths, reviewer/reason/decision outputs, bounded page rollover. |
| Operator: `access/operator-fence-work.ts` | `operator-work.test.ts` | Every root/page continuation has exact scope and receipt, one existing bounded fence page per execution. |
| Organization: `access/organization-close-work.ts` | `organization-work.test.ts` | Members in each page declared before enqueue; reduce page to <=64 distinct account refs, no growing parent. |
| Payment intake: `commerce/enqueue.ts` | `commerce-intake.test.ts` | Provider event resolves indexed buyer/creator scope before copy; one event/intent, no provider history scan. |
| Payment orchestration: `commerce/work.ts` | `commerce-work.test.ts` | Reconcile, checkout-sync and expiry-sync child IDs recorded; Order/CheckoutSnapshot and errors bounded, native completion retained outside DBOS. |
| Content relay: `content/relays.ts` | `content-relay.test.ts` | All operation kinds plus subject-reaction merge have indexed native scope, same event index, two-stage crash safety. |
| Content operation enqueue: `content/work.ts` | `content-enqueue.test.ts` | `createContentOperationClient`, purge failure cleanup and post-erased effect all use adapter; exact source/initiator scope, fixed child fanout. |
| Content author pages: `content/work.ts`, `content/erasure-workflow.ts` | `content-author-pages.test.ts` | AuthorErase loop becomes independently enqueued native pages; progress `setEvent` bounded; no stored arbitrary page row. |
| Content reaction pages: `content/work.ts`, `content/subject-reaction-merge.ts` | `content-reaction-pages.test.ts` | Personal actor cursor stays native or scoped before creation; one page/workflow. |
| Content global maintenance: `content/work.ts`, `content/collection-job.ts` | `content-maintenance-pages.test.ts` | Collection/notice-retention/board-rank work has nonpersonal native cursors, sanitized failures and bounded independent partition pages, not full sweep inside one execution. |
| Library listing: `library/work.ts`, `library/listing.ts` | `listing-pages.test.ts` | Replace unbounded syncPage loop, private collection locator on every page, stable native progress, one page per execution. |
| Rating segment: `rating/segment-job.ts` | `segment-pages.test.ts` | Job and nextJobs voter scope covered, independently bounded pages/rollover and no ancestry traversal. |
| Rating merge: `rating/merge-job.ts` | `merge-pages.test.ts` | Move voter/question cursor out of DBOS into native indexed progress; opaque page work, no index of every unrelated voter on the global root. |
| Nonpersonal maintenance: `access/write-rate-expiry.ts`, `work/retention.ts` | `maintenance-disposition.test.ts` | Operational config/counts only, bounded failures and registration rejects personal payloads; history sweep is never used to prove erasure. |

The membership slice uses four files with its test, leaving no fifth SQL file. If an owner slice would exceed
400 changed lines, split its native progress storage (one new SQL/migration plus its own growth test) from its
workflow adapter BEFORE briefing; neither slice may hide unlimited work in a helper. No frozen tests are edited.

The **last** implementation slice is integration: only
`K/test/history/shared-history-erasure.test.ts` and `K/test/history/shared-history-growth.test.ts` (<=390 lines,
two files), depending on all producer conversions, minimizers, control closure and the existing
`K/test/support/account-deletion.ts` helper. Create personas through native support, generate receipts (including
no-effect), multi-event envelopes, generic effects, membership/payment/content/rating workflows and failures,
and copies where the persona is solely subject, human, delegate, durable initiator or operator under another
principal. Delete with `deletePersona`, drain effects with that support module, then await bounded erasure jobs
(the helper's effects checkpoint alone does not await workflow completion). Enumerate the recorded locator keys
in test fixtures and assert EVERY artifact is its allowed skeleton or proven absent DBOS execution; verify no
late write/replay resurrects it, another persona's still-required work completes, and `readErasureStatus` reports
`shared-history` as `erased`. Also test genuinely empty coverage for `none` and missing proof remaining pending.
Growth test fixes the deleted account's history while increasing unrelated receipts/events/work and measures
the prefix/minimizer bounds above; separately increase its own history to show additional constant-size steps.
The production Cost remains one artifact per step, eight raw keys, one partition and fixed discovery domains.

## Owner-document changes implied by adoption

- `docs/deletion.md`: name the shared-history owner and three artifact types; specify atomic producer locators,
  foreign-partition prefix discovery and seals, full role scope, bounded DBOS removal and narrowly closed control
  skeletons. Preserve the prohibition on scans and item 7 retention requirements. State no production backfill.
- `services/kernel/README.md`: receipt/outbox skeleton fields and replay behavior, key-token storage, per-partition
  locator Cost, fixed discovery, workflow-history row/byte budgets and two-database enqueue protocol.
- `services/kernel/src/command/README.md`: required typed result/event scope, automatic actor/human/delegate,
  no-effect capture, erased-result replay and digest-only completion, raw-key confidentiality and stable key life.
- `services/kernel/src/events/README.md`: minimized storage form/reader marker, stable indices/positions, effect
  completion versus dispatch, registered consumer proofs and source handoff before payload removal.
- `services/kernel/src/access/README.md`, “Erasure consumers” and “Retention inventory”: exact shared-history
  acknowledgement point, none proof, pending failure behavior, restricted platform authority, schema citations,
  SDK-managed durable copies and explicit boundary with semantic provenance and content/delivery custody.

## Primary sources and reusable patterns

Reference clones were read as untrusted data, never installed, built or executed. Existing clones are reused;
their topic entries are recorded in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`. Paths below
are relative to that reference directory. Designs should be implemented with this repository's PostgreSQL,
TypeScript, command/outbox and DBOS abstractions, not by copying upstream files or long passages.

- **[S1] DBOS source, MIT (`LICENSE`)**, commit `980dc55095f445b189aecb59e7f3334345179f65`,
  `search-worker-outcome-harness/dbos-transact-ts/`.
  [SDK schema/migrations](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/sysdb_migrations/internal/migrations.ts)
  establish the exact payload tables, FK removals and indexes;
  [client.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/client.ts)
  establishes transactional enqueue;
  [system_database.ts](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/system_database.ts)
  establishes `deleteWorkflows`, `cancelWorkflows`, `recordOperationResultInternal`, `#checkOwner`,
  `#recordWorkflowOutcome` and `setEvent`. Source-specific claims above derive from these implementations.
- **[S2] Official DBOS documentation**, [DBOSClient](https://docs.dbos.dev/typescript/reference/client),
  [DBOS methods](https://docs.dbos.dev/typescript/reference/methods),
  [workflow management](https://docs.dbos.dev/typescript/tutorials/workflow-management), and
  [Cloud history retention](https://docs.dbos.dev/production/dbos-cloud/retention/), read 29 October 2026.
  Public management and transaction APIs are the supported boundary. Cloud retention describes the categories
  of history, not a claim that this self-hosted kernel has that Cloud policy enabled. No documentation text copied.
- **[S3] Discourse source, GPL-2.0-or-later (`LICENSE.txt`)**, commit
  `589325e2b8466178ee83acac9ec411de555a0093`, `partitioned-sitemap-feeds/discourse/`,
  [app/services/user_anonymizer.rb](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/services/user_anonymizer.rb).
  It updates named profile fields and removes known credential relations by user ID while retaining an anonymous
  user identity. Its optional IP handling, historical-name logging and background job containing previous emails
  are not suitable erasure defaults here. The reusable pattern is explicit owner-known fields and references;
  privacy cleanup jobs themselves are copies needing a locator. No GPL implementation is proposed for copying.
- **[S4] PostgreSQL source, PostgreSQL License (`COPYRIGHT`)**, commit
  `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, `library-shelf-maintenance/postgres/`,
  [src/backend/executor/nodeLimit.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeLimit.c).
  The executor advances through skipped OFFSET tuples. Official [LIMIT/OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)
  and [row-lock documentation](https://www.postgresql.org/docs/current/explicit-locking.html) support unique keyset
  order and conflicting lock modes. LIMIT alone does not bound skipped history or JSON filtering work.

The sources share two useful patterns: stable technical identity can survive removal of personal fields, and
transactional owner-known relationships are safer than retrospective payload discovery. DBOS adds a third:
durable systems persist more than their inputs and require their own supported complete-history deletion path.
The recommended partition-local locators, closed minimizers and native completion proofs apply those patterns
without importing a new graph service or assuming an unsafe SDK storage-editing API.
