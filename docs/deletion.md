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
   original row. Any open row whose source envelope's authoritative time is at or before T holds every later
   erasure, regardless of account; later envelopes do not hold it. Done and resolved rows remain.
8. **First scope.** A coordinator plus each owner's cleanup uses the existing PostgreSQL, DBOS, OpenSearch and R2
   APIs. Account restore, a legal-hold engine, self-service export, a separate deletion service and per-account
   encryption are not built.

Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.

### Shared-history participant

Accounts owns the `shared-history` participant for `command-receipt/v1`, `outbox-event/v1` and `durable-work/v1`.
Every producer declares typed account references for all copied roles and records exact locators in the artifact's
physical partition in the transaction that creates the copy. This includes foreign-partition copies; there is no
cross-partition write on the command path. The committed `access.erasure` obligation seals participant discovery.
Discovery visits all 4,096 partitions, one partition per step, and seeks only the deleted account's locator prefix.
This fixed discovery budget is paid during erasure. Receipt and event minimizers retain only their required skeletons;
durable work is removed through supported DBOS cancellation and deletion after native obligations are settled or
transferred. The participant acknowledges `erased` if any artifact was ever applied, and acknowledges `none` only
after sealed complete coverage proves that no artifact applied. Until this protocol and complete producer coverage
are implemented, shared-history acknowledgement remains an open gap. There is no production backfill; complete
producer coverage is required before launch. The default thirty-day workflow-history sweep is not erasure.

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
whose inner client loop is unbounded and which emits no acknowledgement. Retain at least that delay, verify the
last possible issuance fence against token lifetime/verifier leeway: [kernel token checks](../services/kernel/src/access/authenticate.ts)
allow at most 300 seconds, leaving ten seconds of margin. Increase the delay if the composed lifetime/leeway exceeds
that margin. Persist the original due time and sleep without a connection. Bounded client pages must durably signal completion before Auth's final trusted acknowledgement port
can run; missing composition fails closed. The delay is a safety minimum, never an overall completion deadline.

Logs, delivery diagnostics, backups and replicas remain explicit custody findings. A complete `readErasureStatus`
does not prove backup expiry; [the coordinator](../services/kernel/src/access/erasure.ts) does not model it.

Implement capabilities in this dependency order:

- Access discovery/progress on the existing coordinator/routing, plus Access and Auth cursor cutovers on their native
  traversal state; deployed cutover coverage precedes any purge of cursor-bearing relations or evidence.
- Command and workflow copy recorders, after shared history supplies its locator interface and producer-closure
  protocol; both owners use the agreed artifact contract, including actual durable copy creation.
- Access and Auth residue phases, using indexed discovery, cursor cutovers and recorders: finish native consumers,
  drain children before parents, minimize identity last. Auth client drain needs opaque protocol locators; subject
  drain needs client, operating-evidence and staging cleanup. Registration cleanup needs workflow recording.
- Auth bounded delayed consent on subject-drain progress/due/completion state, then service plumbing after every
  native purger, bounded consent and both workflow recorders; fixed-host enqueue accepts an obligation only.
- Each participant's terminal acknowledgement, last: Access needs all Access phases/recorders and specific Auth
  native-release evidence; Auth needs every Auth phase, consent completion and fixed trusted service-port wiring.
