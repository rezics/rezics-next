# Deletion

Every owner follows one deletion policy, so a person can undo a mistake, moderation keeps its evidence, and erasure
promises still hold.

- **Soft deletion is the default.** Deleting a post, review, Collection, library fact, subject contribution or any
  other user-owned record marks it deleted: it disappears from every read, search document, sitemap, count and
  feed at once, references to it render as a tombstone, and its owner can restore it within 30 days.
- **Purge is separate.** Removing the stored data is a distinct operation:
  - after the 30-day window, deleted personal and private data is purged automatically by bounded durable work;
  - account erasure follows the [Account erasure](#account-erasure) protocol below and does not wait for the window;
    no platform action is needed, because erasure is the person's right;
  - an immediate purge before the window ends needs a platform permission and its own route or explicit parameter,
    never the ordinary delete call.
- **Purge the least data that serves the purpose.** A purge removes the fields that are personal or private
  (author link, body or image, contact data, network addresses) and keeps the record's
  skeleton: identifier, type, relations, aggregate counts and the tombstone, so threads, lists, counts and
  references stay consistent. A whole record is removed only when the skeleton itself is personal data, such as a
  private library fact that one account reads a subject.
- **Takedown and legal holds.** A takedown hides, it never deletes: it withholds the least that the notice covers
  (one image, one passage, one field, or the record when nothing smaller does), keeps the data for a counter-notice
  or a reversed decision to restore, and keeps the record's other fields visible. Only a legal order purges, through
  the platform route. A legal hold suspends the automatic purge for its records.
- **Evidence.** Moderation and audit records keep identifiers and decisions, not the deleted content, past the
  window.

## Account erasure

1. **Confirmation and T.** Account erasure is final at confirmation, with fresh authentication and the typed
   confirmation. That instant, T, is both a read and write fence: private and unlisted reads, exports, counts, media
   and producers reject the owner immediately. Every worker checks the fence before any effect. Authentication
   denial alone is not enough for public or unlisted routes. Imports and late webhooks can never recreate the
   account's data or benefits. The 30-day restore window applies to records deleted one by one; it never postpones
   account erasure. There is no account restore, and an account id is never reused.
2. **One terminal workflow.** Each account has one terminal erasure workflow, identified by the account and its
   barrier. Accounts owns the request and the overall outcome. The participant list is fixed and versioned: Access,
   Auth, Library, financial commerce, content and media, community, ratings and notices, semantic and Zones, search,
   imports, shared history (receipts, outbox events, editorial provenance, durable work), and delivery custody (media
   storage and caches). Each participant acknowledges that its cleanup actually happened or attests that no data of
   the account applies. Dispatching work or accepting an obligation is not completion; only minimized or erased
   payload is. Completion also waits for every open late item to be resolved and for the effects frontier: all
   envelopes committed before T must be delivered and their registered locator effect workflows must succeed
   or receive an explicit platform resolution.
   A minimal completion record lives in PostgreSQL outside DBOS history, so deleting workflow history
   cannot lose an unfinished obligation or let an old event reopen activity.
3. **Every role.** Cleanup follows every role the account held: author, editor, uploader, reporter, buyer, seller,
   delegate, operator, member and acting human. It is not limited to rows keyed by the account id.
4. **Shared copies.** Copies in shared stores are found through exact locators that the producing owner records
   atomically with the copy, or for a copy in another partition, by an effect behind the participant’s fence. The
   participant closes that fence before paging; an effect finding it closed records a late erasure item and handles
   the copy itself, resolving the item only after minimization or purge commits. Locators include receipt, outbox
   event, provenance transaction, durable work id, Auth record key, media
   object key, search document or import record. The store's owner minimizes them through a registered minimizer for
   that artifact type. There is no account-wide JSON scan, search for a person's name or central ownership graph.
   Every producer of personal data uses an indexed native ownership relation or records the exact locator. A new
   personal field or store needs its erasure disposition before release.
5. **Retention.** Private, unlisted and already deleted material is erased, including archived versions. Eligible
   public contributions keep only the published contribution with de-identified attribution (`Deleted account`). A
   dynamic Collection keeps its last completely published generation, never a pending one or a fresh evaluation.
   Published reading logs are erased. Financial records keep only the legally required subset, restricted and with
   an expiry. That subset is defined by the payment and tax retention schedule: jurisdiction, record categories,
   fields, purpose and expiry. The schedule remains an open external condition. Anything an owner keeps beyond these categories, including
   moderation evidence (reports, decisions, bans), is a retention exception under item 7: the store, fields, purpose
   and expiry must be stated in that owner's retention inventory and purged at expiry; without one it is erased,
   including the reporter of a report, which is private material.
6. **Bounded steps.** Every phase pages with keyset seeks over a small fixed number of raw keys and explicit byte
   limits, children before parents, releasing the connection before entering another partition. Total work grows
   with the account's own records; no step grows with unrelated data. Cleanup runs under narrow platform authority
   bound to the committed erasure obligation; it never restores the deleted initiator.
7. **Completion.** The outcome distinguishes active cleanup complete, retention exceptions outstanding (each named
   by fields, purpose and expiry), and backup expiry outstanding. Unknown custody, a failed participant or an
   unresolved external write keeps it incomplete. Completion is checked by indexed existence probes, never by full
   counts. Registered locator effects have a permanent, input-free open-work row committed by the relay before
   enqueueing. Only success under that workflow id or an explicit platform resolution naming the row clears it.
   ERROR, cancellation, exhausted recovery and deletion of DBOS history leave it open. A fork never clears the
   original row. An open row whose database `opened_at` is at or before the erasure's `workflow_until` holds it,
   regardless of account. The relay commits rows before advancing the checkpoint; `workflow_until` is recorded after
   that frontier passes. Rows opened later do not hold the erasure. Done and resolved rows remain.
8. **First scope.** A coordinator plus each owner's cleanup uses the existing PostgreSQL, DBOS, OpenSearch and R2
   APIs. Account restore, a legal-hold engine, self-service export, a separate deletion service and per-account
   encryption are not built.

Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.

### Realm membership at deletion entry

Realm membership is not an organization ownership or operator responsibility. Access's
[Realm transition coordination contract](../services/kernel/src/access/README.md#realm-transition-coordination-and-deletion-entry)
requires an exact committed-publication or cancellation proof to close each transient hold, retaining the inverse
until authoritative leave or post-erasure cleanup. An in-flight or uncertain transition still prevents tombstone
before T, the erasure obligation and its event. The default native membership workflow now closes only its exact
committed transition, so a current member can reach genuine Auth approval, tombstone, obligation and event while
inverse and membership remain for real cleanup. Old stable holds require the stopped-old-writer barrier and bounded
resumable reconciliation described by Access; absence or uncertainty never clears them. Genuine participant cleanup,
shared history and physical custody must still complete before final acknowledgement. The new immutable transition,
source-proof and reconciliation records also remain physical retention obligations; this entry slice produces no
participant acknowledgement.

### Shared-history participant

Accounts owns the minimizers, durable locators/fences and financial-retention policy of the `shared-history` participant for `command-receipt/v1`, `outbox-event/v1` and `durable-work/v1`.
Kernel retains command/storage/request machinery and History/Work execution. Every producer declares typed account references for all copied roles and records exact locators in the artifact's
physical partition in the transaction that creates the copy. This includes foreign-partition copies; there is no
cross-partition write on the command path. The committed `access.erasure` obligation seals participant discovery.
Discovery visits all 4,096 partitions, one partition per step, and seeks only the deleted account's locator prefix.
This fixed discovery budget is paid during erasure. Receipt and event minimizers retain only their required skeletons;
durable work is removed through supported DBOS cancellation and deletion after native obligations are settled or
transferred. The participant acknowledges `erased` if any artifact was ever applied, and acknowledges `none` only
after sealed complete coverage proves that no artifact applied. Until this protocol and complete producer coverage
are implemented, shared-history acknowledgement remains an open gap. There is no production backfill; complete
producer coverage is required before launch. The default thirty-day workflow-history sweep is not erasure.

The default native worker now advances sealed local pages and exact receipt/outbox/SDK minimizers, recording
immutable per-artifact receiving proofs. Missing consumers do not stop independent artifacts from being minimized.
The current runtime has no complete producer-family declaration and cannot issue aggregate coverage across routing
changes. Auth's committed copies proof is required independently of its final ACK. The separate shared-history ACK
rejects incomplete coverage and, when enabled, emits only a closed technical version/outcome marker.
[Access's implementation status](../services/kernel/src/access/README.md#delivered-preference-history-coverage)
lists the concrete remaining producer, scope, consumer and routing proof gaps. These local pages do not establish
Commerce's mandatory unused-account `none` result.

Ordinary record purge is a distinct owner exchange: Semantic's selected `record-purge-authority.ts` owns native
ordinary deletion/generation/hold/restore validation; Content locks that same opaque authority for its own bytes;
Accounts' selected `history/record-purge.ts` owns copied history and receiving consumers. Accounts publishes the
selected signatures, but Semantic's source methods, Content's minimizer and the producer-recorded record-to-copy
inventory/receiving implementation are unavailable here. Account-role custody or account erasure cannot authorize
or certify ordinary record purge.

### Access and Auth participants

Neither participant can acknowledge yet: [Access's coordinator](../services/kernel/src/access/erasure.ts) supplies
the acknowledgement primitive, while [Auth's `eraseAccount`](../services/auth/src/service.ts) deletes the native
user and schedules consent cleanup without acknowledging. Each participant must acknowledge only in a final
durable step after indexed residue phases cover every applicable role. Enqueueing, credential expiry, a declared
cascade and a successful first page never prove erasure.

Access acknowledges `erased`: every terminal account has its own lifecycle row. Auth acknowledges `none` only if
its persisted initial inventory found no applicable record in any role, including client ownership, operator and
acting-human evidence, and shared-copy obligations. A missing native user alone never proves `none`. Persist
whether anything applied before deletion, outside workflow history, so retry cannot change `erased` to `none`.

No Access or Auth audit or security payload has a retention exception. Erase it unless an adopted inventory names
its fields, purpose and expiry. Encrypted credential stages, hashes, keys, denial reasons and review evidence are
personal payloads too. Only these minimal tombstone, completion and impersonation-prevention skeletons remain:

- Terminal account identity: `id`, `state: deleted`, `kind`; internally, its route, authentication epoch floor,
  fenced flag and current fence receipt/transaction identifiers needed to refuse renewed authority. Historical
  handles, operators, reservations, verification pointers and public timestamps are excluded.
- Permanent erasure obligation: `route`, `account_id`, `version`, `at` (T), `completed_at`. Its acknowledgement keeps
  `route`, `account_id`, `participant`, `outcome`, with empty `retained` and `resolutions` for Access and Auth.
- Native completion/replay refusal: obligation/barrier key, immutable initial applicability/outcome, phase/coverage
  version and terminal/done marker. Temporary progress holds only store/role, partition and independent raw-key
  boundary; it carries no historical business payload. A still-needed fence witness keeps only the current epoch
  and receipt identity until its consumer finishes.
- Retired handle allocation: route, normalized handle and permanent retired state. There is no owner, forwarding,
  reservation, hold, expected prior handle or operation/transaction provenance. The allocation represents itself;
  another real account must never stand in for the erased owner.
- Surviving resource initialization and bootstrap fences: resource key/type and initialized or bootstrap-completed
  marker, without creator/bootstrap actor attribution. They prevent reinitialization or a second bootstrap.

A permission granted by the deleted account to a surviving account stays; minimize the deleted granter's command
provenance through shared-copy locators. Remove a grant whose subject or account resource is deleted. A surviving
organization never loses its data merely because an operator, member or reviewer was deleted. Handles are retired
permanently without forwarding; sever the former owner's mapping and operation/reservation provenance.

Keep immutability and terminal-proof triggers enabled. Purges use narrowly checked platform paths bound to an
existing `access.erasure` obligation, after proof consumers finish. `access.erasure` and its acknowledgements stay
permanent. Finish committed organization, operator, membership and verification/reversal work before deleting its
locators or evidence. Preserve Auth's specific native fence/release witness until consumed; Access must not wait
for Auth's final acknowledgement. Clear residue and verify indexed absence/minimal fields before acknowledging.

Discovery of a non-owner role visits the fixed routing universe one partition at a time: a role-first index is
constrained to that partition's route interval, at most 4,096 indexed range seeks per role. This is a fixed routing
cost, never enumeration of a table, accounts or JSON. An account-owned store uses only that account's route;
route-zero stores use only partition zero. A native step selects at most 100 raw keys in one store/role/partition,
with at most 64 KiB returned and 1 KiB per locator, saves progress atomically with selected-key changes, and releases
the connection before another partition, service call or wait. Drain children first and prove indexed child absence
before deleting a parent, so a final cascade has no account-owned children.

A traversal cursor never stores an account id; hashing or encrypting the id is not erasure. Use ordinals independent
of the id, remove the id-to-ordinal binding on deletion, and retain only ordinal boundaries. Cut over existing
cursors through a bounded deployment backfill and indexed predecessor translation, including missing ids; reject
old writer versions. Do not reset a surviving owner's work or rewalk its unrelated accounts during erasure.

Shared history minimizes shared receipts, events and workflow payloads. Access and Auth record exact locators for
every role atomically with each copy, including child messages/results and their own erasure/acknowledgement copies.
An enqueue intent alone does not cover the actual durable copy. Wait only for durable producer handoff, never for
shared history's global acknowledgement; that would create a cycle. Global completion still requires its separate
acknowledgement.

Auth must drain owned-client and operating-session children before user deletion, then finish post-user residue and
delayed consent. [The current deletion transaction](../services/auth/src/service.ts) schedules a 310-second marker;
[minute maintenance](../services/auth/src/maintenance.ts) calls [the purge](../services/auth/src/consent-erasure.ts),
whose native bounded client pages persist completion without acknowledging a participant. Retain at least that delay, verify the
last possible issuance fence against token lifetime/verifier leeway: [kernel token checks](../services/kernel/src/access/authenticate.ts)
allow at most 300 seconds, leaving ten seconds of margin. Increase the delay if the composed lifetime/leeway exceeds
that margin. Persist the original due time and sleep without a connection. Bounded client pages must durably signal completion before Auth's local-copy completion proof
can run; missing composition fails closed. The delay is a safety minimum, never an overall completion deadline.

Logs, delivery diagnostics, backups and replicas follow Auth's adopted
[external custody and restore contract](../services/auth/src/external-custody-contract.md), which inventories the
actual producers and names the missing receiving and infrastructure interfaces. No configured writer is distinct
from sealed zero data, unknown custody and actual retained copies. Missing configuration, callback/row absence and
elapsed TTL never establish `none`; unresolved provider diagnostics keep erasure pending. No external legal
retention schedule is inferred.

Restore is an operational admission procedure: assign a fresh random database incarnation, rotate the Access
proof-signing key and replay deletions committed since the backup before admitting traffic or writers. Coordinated
Auth/Kernel restore uses the latest available WAL/PITR. Isolate the restored copy and retire old writers before
opening the replacement; live and historical deletion obligations must both survive. There is no account restore,
runtime physical-owner ABI or restore-generation witness protocol.

Replay preserves the original obligation/version/T, captured floor, applicability and original 310-second consent
due time. A restored local completion marker cannot cover reintroduced bytes. Pending succession retains its
locators until the actual consumer finishes. Local emptiness proves neither historical coverage, terminal custody
nor financial closure. Technical negative-identity minima never waive legal or financial retention. Committed
deletion time is not downstream custody acknowledgement. Hosting/runbook restore proof remains unexercised and
unverified, distinct from ordinary dev landing; this adoption establishes no operational pass.

Library reuses existing Auth host/deletion interfaces. Consumers own orchestration, never Access-table SQL or
interpreting a denied read as absence. Existing bounded minimization, immutable source fences, writer retirement
and retained financial obligations remain required.

A complete `readErasureStatus` does not prove backup expiry or external custody;
[the coordinator](../services/kernel/src/access/erasure.ts) does not model it. Report active cleanup, named adopted
retention exceptions and backup expiry separately, while retaining incomplete status for unknown custody. Native
Auth completion and final trusted acknowledgement remain subject to all other requirements above.

Native residue/cursor coverage, actual copy recorders, delayed-consent completion and fixed host plumbing remain
prerequisites to their respective terminal acknowledgements. A cursor cutover precedes purge of cursor evidence;
children and committed consumers finish before identity minimization. Shared producer handoff must not wait on a
shared-history global ACK. Missing producer, routing or physical custody evidence remains incomplete rather than
being inferred from a successful local page.

### Auth-local copies and the fixed proof boundary

Auth owns its database and `auth_dbos`; kernel `dbos` is a different store. Auth
records account roles and exact workflow/artifact keys in the same transaction as
SDK enqueue/message writes. App-owned native-table triggers cover subsequent
status, input, output/error, operation, event/history and message writes. Unknown
schema/artifact coverage, missing roles and unresolved result consumers stay
pending. An old registration/request intent is not native copy custody.

The private `AuthErasureProofPorts` boundary carries only
`{accountId, version, at}` and, for the specific native source dependency,
`{continuationId, receiptId}`. `readAuthErasureBarrier(accountId)` obtains the
committed kernel identity before local cleanup. `readAuthErasureSource` verifies
the original committed erase-auth-owner continuation and its authorized target.
`recordAuthNativeConsumption(source)` and `recordAuthHistoryCompletion(barrier)`
are distinct fixed Auth-only capabilities. No caller chooses a participant,
principal, locator, phase, payload or authorization flag.

Source acceptance commits atomically with the native Auth obligation under its
producer fence. Acceptance of the native obligation does **not** discharge its source. The real
Auth deletion step validates the exact source again, then commits transfer of its
complete remaining erase-auth-owner need to the existing native obligation under
the producer fence. This records the original source workflow, continuation,
receipt and immutable kernel barrier outside DBOS. Replayed exact work uses that
native transfer without rereading the former evidence. Only then can Auth publish
`native-consumed`; Access can read this specific dependency using
`readAuthNativeConsumption(pool, source)`. Other releases, approvals, openings,
children and identity evidence have their own consumers and receive no permission
from this witness.

The later `copies-erased` fact requires native/consent closure, known creation
coverage, completed actual result consumers, retired exact work, supported SDK
cancellation/deletion and raw-key absence probes. The final native producer
persists a bounded result commitment outside DBOS; caller and default recovery
consume the actual exact SDK return against it before recording readiness.
Disclosure refusal cannot prevent this native result retirement. Live, failed,
unmapped or mismatched results remain pending, regardless of workflow status.
Kernel refuses completion before its matching native-consumed phase.
Completion survives DBOS history
loss in `auth_erasure` and publication redrives idempotently after a lost reply.
Auth releases its connection before every kernel call. Kernel verifies its own
permanent erasure and terminal/fenced account, stores each immutable fact in that
account partition, and never accesses Auth's database.

Kernel shared-history acknowledgement still requires this completion fact **and**
its own producer/minimizer closure. Neither phase acknowledges the participant.
There is no kernel-to-Auth maintenance RPC, kernel Auth credential or final-ACK
dependency cycle. Enqueue, local cleanup alone, storage, missing configuration and
an undelivered specification are not shared-history proof. The global participant
set and Search's undelivered cleanup remain unchanged.
