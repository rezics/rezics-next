# Follows: Accounts and Commerce design status

Research date: 2026-10-31; primary sources consulted on 2026-10-30–31. This report traces the assigned integrated
worker checkout. It is evidence for adoption, not a second owner contract. Source presence, owning delivery claims
and demonstrated outcomes are distinguished below; no acceptance, native or browser verification was run.

## Boundary and authority

The exact [scope row](../scope.md) is **Follows — accounts, commerce — In: follow edges; follower counts visible
to their owner only**. Commerce owns the Library relationship, writers, projections and Library erasure;
Accounts owns current account identity, authentication, Access, membership and shared lifecycle infrastructure;
Web owns the served controls. Content owns Realm/Space visibility and moderation, Semantic owns canonical identity.

The normative sources are [Library's follow contract](../../services/kernel/src/library/README.md#follow),
[private follow counts](../private-follow-counts.md), [accounts](../accounts.md),
[viewer actions](../viewer-actions.md), [Access](../../services/kernel/src/access/README.md),
[Community](../../services/kernel/src/community/README.md) and [deletion](../deletion.md).
There is no separate `docs/follows.md`. The count contract owns disclosure and maintenance requirements; the
Library README describes the partial runtime. Its source-metadata section is newer than the count document's
opening statement that no migration exists. That opening must not erase the implemented storage slice.

An account is followed through its catalogue agent **Subject**, not an Account edge. Targets are Subject,
Collection and Space; all intent lives in the follower's account home. A follow grants no target access or Realm
membership. Owner count access grants no follower identities or another account's outgoing list. Public follower
pages/counts, a following feed, federation, follow approval, follow notices and a second consent system are outside
this adopted row. Notifications remain the existing replies/mentions/moderation system.

| Capability                                                                 | Specified | Implemented in this checkout                                       | Interface exposed                                                  | Outcome evidence and limit                                                                                                                                                |
| -------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit/implied follows, own outgoing page, negative intent and replay    | Yes       | Native Library commands, SQL, HTTP and signed keysets              | Collection buttons; Following page; implied Entry/membership paths | Existing `services/kernel/test/library/{follows,follow-store}.test.ts` and Web Following tests; trust owning landed delivery, no new outcome claim.                       |
| Source replacement metadata and represented outgoing counter               | Yes       | Migration, all-writer trigger, owner/source rows and pending index | None; counter is not ready for disclosure                          | `services/kernel/test/library/follow-count-source-storage.test.ts` exists; Library README explicitly leaves calibrated growth proof incomplete.                           |
| Private incoming/outgoing counts, canonical reverse support, readiness     | Yes       | Target aggregate, bootstrap, delivery and routes absent            | No count component or endpoint                                     | Seventeen frozen scenarios in `specs/follow-counts-outcomes.test.ts`; `specs/follow-counts-driver.ts` is a contract, not a native driver. Whole outcomes remain unproven. |
| Identity rekey and terminal count withdrawal with actual receiving custody | Yes       | Local follow purge exists; complete count participant does not     | No follow restore or count lifecycle UI                            | Existing participant delivery does not establish target withdrawal, shared-copy closure or final erasure ACK.                                                             |

The owning [Accounts](../goals/accounts.capabilities.md#follow-owner-counts),
[Commerce](../goals/commerce.capabilities.md) and [Web](../goals/web.capabilities.md) manifests retain the
cross-owner outcome debt. `apps/web/tests/library-following.test.ts` and
`apps/web/tests/native/native-following.host.test.ts` provide existing Following coverage; reading these tests
does not establish a new served or native result.

## Existing research and primary precedents

[Follow-count simplification](follow-counts-simplest.md) is **primary-backed**: it surveys twenty products and
examines Mastodon source. Its useful finding is separation of private relationship intent, maintained counts and
disclosure authority; its recommendation was adopted in the count owner document. Coverage of the present UI/API
journey, source cutover, current-T gaps and receiving custody was **partial**. This report fills those gaps rather
than repeating that survey. The cited capability manifests are delivery inventories, not independent native proof.

- **ActivityPub:** the [2018 W3C Recommendation, §§7.5–7.7](https://www.w3.org/TR/activitypub/#follow-activity-inbox)
  separates Follow from Accept/Reject; approval may be automatic, delayed or manual, and rejection can be concealed.
  [Undo, §6.10](https://www.w3.org/TR/activitypub/#undo-activity-outbox) requires the original actor and reverses
  effects where possible. The transferable pattern is authenticated reversal and replay-safe state replacement.
  REZICS has already chosen immediate local intent, so pending requests, federated inboxes and Accept are not
  missing implementation. W3C's [permissive document licence](https://www.w3.org/copyright/document-license/)
  applies; this is the dated Recommendation, not an assumed current editor's draft.
- **Mastodon API/privacy:** [follow/unfollow methods](https://docs.joinmastodon.org/methods/accounts/) return a
  Relationship; already-unfollowed removal succeeds. Locked-account approval has its own
  [authorize/reject API](https://docs.joinmastodon.org/methods/follow_requests/).
  [Hiding the network](https://docs.joinmastodon.org/user/preferences/#miscellaneous-options) controls list
  disclosure independently. [Blocking](https://docs.joinmastodon.org/user/moderating/#blocking) removes both
  directions and prevents refollow, whereas muting is different. These are distinct product policies, not reasons
  to infer a REZICS block cascade or public count. Live documentation spans several releases; `hide_collections`
  is documented from 4.1. Documentation licence: [GFDL 1.3](https://github.com/mastodon/documentation/blob/master/LICENSE).
- **Mastodon implementation:** reused `.reference/follow-counts/mastodon`, pinned by the reference index to
  `f943e0583be804bb062e5c9a4f8e65e2a05e5346`, under
  [AGPL-3.0](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/LICENSE).
  [`app/models/follow.rb`](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/models/follow.rb)
  makes a unique relationship drive counters; `app/models/follow_request.rb` holds pending requests separately.
  [`app/services/unfollow_service.rb`](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/services/unfollow_service.rb)
  serializes removal and schedules downstream cleanup; `block_service.rb` and `after_block_service.rb` separate
  immediate relationship policy from asynchronous feed/notification cleanup. This is useful evidence for one
  authoritative edge and observable delayed work. Its arithmetic counter callbacks do not solve REZICS's
  cross-partition replacement, canonical support or terminal fences. Source was read only, never executed;
  recommend patterns in TypeScript/PostgreSQL/DBOS, not copied AGPL files.
- **GitHub:** the [official followers API](https://docs.github.com/en/rest/users/followers?apiVersion=2026-03-10)
  distinguishes authenticated `/user/following` from named-user lists. `PUT`/`DELETE /user/following/{username}`
  return 204; relationship probing uses 204/404 and separate read/write permissions. This supports owner-scoped
  idempotent commands, but its public-list policy and page-number pagination do not fit REZICS's private signed
  keysets. These are versioned 2026-03-10 examples in live docs, licensed
  [CC BY 4.0](https://github.com/github/docs/blob/main/LICENSE).

Across these sources, relationship intent, disclosure, moderation and delayed side effects are separate concerns.
The adopted REZICS model fits that separation: preserve the native edge and Access evaluator; derive private counts
from current replacements. None of the precedents warrants adding requests, public networks or notification work.

## Actual UI ↔ API ↔ storage journeys

In the table, `W/` means `apps/web/src/`, `K/` means `services/kernel/src/`; these are actual source paths.
Web's `W/session/request.ts` reads `__Host-rezics_session`; `W/session/store.ts` keeps access/refresh credentials
in its SessionStore Durable Object. The BFF uses generated `KernelClient`; unsafe actions require origin/CSRF and
send `Idempotency-Key`. Auth participates in issuance/refresh/JWKS, not a new follow consent callback.
`K/access/authenticate.ts` verifies JWT issuer/audience/time/scopes and current native account/fence/epoch evidence.
The personal Library gate and exact operation scope then apply. Following and Collection BFF responses use
`private, no-store`; tokens and follower identities do not enter page data.

For source writes, `K/library/command-support.ts` and `K/command/command.ts` take the native account barrier,
mint authoritative **T**, reauthorize before receipt replay, and atomically commit relationship changes, source
trigger metadata, receipt and outbox. Target resolution in `K/library/follows.ts` currently precedes this envelope;
it is not proof that target eligibility was evaluated at that same T. Read routes use native read admission rather
than pretending to be source transactions. The following table names that distinction explicitly.

| User journey / actual UI                                                             | HTTP and actual hops                                                                                                                                                                                                                                                      | Authority, transaction and durable work                                                                                                                                                                                                                                                                 | Result, disclosure and gap                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow/unfollow a Collection: `/collections/$id`, curated and built-in dynamic pages | `W/library/{collection-page,dynamic-collection-page}.tsx` → POST server function in `collection-edit.ts` → `collection-records.ts` → `PUT` or `DELETE /v1/follows/:targetId` → `K/library/personal-routes.ts` → `follows.ts`                                              | `follow:create` / `follow:delete`, own active unfenced actor account; current target preflight; source command at T. One `library.follow` row and source hook, receipt/outbox in follower home.                                                                                                         | 200 `{follow}` with `targetId,targetType,state,reason,updatedAt`. Current private Collection preflight accepts only curator, public or unlisted; it must not be copied as count management authority. Both Web button branches currently advertise `follow.put`, leaving delete-scope-only users without the correct independent affordance.                   |
| Read current button state / follow a Subject, account agent or Space                 | Collection loader `collection-records.ts` uses `GET /v1/follows/:targetId`; PUT/DELETE also accept readable Subject/Space IDs. Subject address `/subjects/$id` redirects to `/subjects/$id/$slug`; it, `/@handle` and `/spaces/$address` have no explicit follow control. | `follow:read` reads own keyed row including negative intent. New Subject follow resolves the current canonical terminal; Space uses native `space:read`; there is no Account target type.                                                                                                               | Missing own edge: 404; unreadable/unknown write target: concealed 404. Collection loader maps missing to false and dependency failure to unknown. Subject/account/Space explicit controls are absent, not undiscovered endpoints.                                                                                                                              |
| Browse own Following, continue, remove a selected row                                | `/library/following` → `W/library/mine-following-actions.ts` GET → `mine-following.ts` → `GET /v1/follows?view=FULL&limit=…&cursor=…`; POST BFF unfollow → DELETE above                                                                                                   | `follow:list`, authenticated account only; `follow_account_page` seeks `following` rows by updated time DESC/id ASC. Signed `follow.list` cursor binds account, state and partition epoch; default 20, max 100. FULL hydration in `K/library/views.ts` performs current target reads.                   | 200 `{follows,next}`, no total or incoming identities. Invalid cursor 400; stale epoch 409; BFF restarts stale pagination. Concealed/deleted targets become `target:null`, retained as unavailable rows. Selected deletion updates UI only on success; BFF currently collapses distinct failure reasons. Space rows have no navigation link.                   |
| Remove an unavailable target / refollow / replay                                     | Following still offers DELETE for the stored ID; `follows.ts` loads its existing type, but then re-resolves target readability before the command                                                                                                                         | Existing original ID is retained for removal, including after canonical resolution. Explicit `unfollowed/explicit` survives later implied intent on the same stored original. Same-key successful replay changes nothing; identical intent aborts before a new receipt/event.                           | Hidden/deleted targets currently fail removal at preflight although their own edge is visible. Replaying after lost current authority is refused before receipt return. Different input under a used key is 422 `idempotency_conflict`; there is no follow undo/restore token.                                                                                 |
| Entry becomes in-progress; later Entry clear/restore                                 | Subject Library slot (`W/library/subject-slot-view.tsx`) → POST `subject-slot-actions.ts` → `subject-slot-mutation.ts` / `entries-read.ts` → `PUT /v1/libraryEntries/:subjectId` → `K/library/entries.ts`                                                                 | Entry's revision/incarnation/profile admission applies. `followFromLibrary` runs in the **same** account transaction with reason `library`; it cannot override an existing row.                                                                                                                         | Entry response is 200/201; follow is an implied side effect. Clearing Entry is not unfollow; restoring an Entry is not restoration of a deleted account or permission to overwrite explicit negative intent.                                                                                                                                                   |
| Join/leave a Realm, then implied Space follow                                        | `/realms/$id` and Space membership UI `W/community/realm-membership.tsx` → POST `space-actions.ts` → `POST`/`DELETE /v1/realms/:realmId/membership`; authorized add-member route also uses join work                                                                      | Community current Realm visibility and native membership authority → durable join/leave workflow in `K/community/work.ts` → await Access membership child completion → separate `followForMembership` trusted active-account command on member home. DBOS `workflows` queue; no cross-home transaction. | 202 means accepted/pending, not follow committed. Public self-join only; protected/denied join fails. Leave removes membership but deliberately retains follow. Delayed membership/library work cannot defeat explicit unfollow of the same stored original. Library's trusted membership step itself does not re-resolve Space visibility.                    |
| Read follower count as target manager, or own outgoing count                         | **Absent UI/BFF/runtime routes.** Adopted reads are `GET /v1/followCounts/:targetType/:targetId` and `GET /v1/followCounts/outgoing`; these are requirements, not callable endpoints here.                                                                                | Target: ordinary `collection:update`, `space:manage`, or reciprocal `readPublicAccountByAgent` resolving the actual Account ID, then self or `account:manage`. Other Subjects have no count owner. `follow:list` and gate still apply. Outgoing is own account only.                                    | Required closed DTOs are `{targetType,targetId,followerCount}` / `{followingCount}`, safe nonnegative numbers, private/no-store. No follower list or public zero fallback. Target/support/total tables, complete bootstrap and readiness are missing.                                                                                                          |
| Suspension/fence/reactivation; revocation or Realm ban                               | No follow-specific UI/API. Current Access/account changes affect existing authentication and target reads; later count maintenance must consume owner lifecycle events.                                                                                                   | Native actor state, authn floor, grants and delegated principal evidence are authoritative. Realm bans govern join/participate; protected Realm reads use membership. A public Space is not automatically hidden by a Realm ban.                                                                        | Loss of management immediately removes count entitlement; loss of target readability conceals FULL summaries without rewriting raw intent. No implemented pairwise follow-block API/cascade. Required count eligibility wakeups for suspension/reactivation are absent; outgoing intent must survive suspension.                                               |
| Canonical merge/unmerge, agent verification/reversal                                 | No follow-specific route. New Subject writes use `K/library/subject-anchor.ts`; later counts must join the existing Semantic serialized identity job                                                                                                                      | Current mapping/readability protects resolution; old stored original IDs remain. Adopted derived contributions deduplicate one follower across canonical originals; account-agent count authority uses current reciprocal account binding, not subject/account ID equality.                             | No implemented reverse aggregate/rekey or complete Library receiving participant. Verification cannot itself create follow consent; reversal must remove former count ownership and preserve source intent. An unlanded identity contract is not a runtime adapter.                                                                                            |
| Terminal account deletion and late/replayed work                                     | No account-delete control in `/settings` and no follow-specific deletion endpoint to invent. From committed `com.rezics.access.account-tombstoned.v1`: `K/library/work.ts` → `library_account_erasure` effect → `library.accountErasure` workflow                         | `erasure-participant.ts` verifies deleted/fenced obligation; `account-fact-purge.ts` uses terminal authorization, not active-account command admission. Indexed `account-fact-purge-follow.sql` deletes raw rows in pages ≤100, alongside Entry/Copy and owned-graph cleanup.                           | Immediate native fence prevents private reads/writes; workflow retries are durable, not completion. Current physical DELETE preserves negative source metadata through the trigger. Target withdrawal, terminal receiving fence, metadata cleanup, late-copy custody and final Library ACK remain incomplete. Terminal account deletion has no 30-day restore. |

The source of truth is the migration
`services/kernel/db/library/migrations/20261025164145_library_follows.sql`: primary key
`(route,account_id,target_id)`, immutable type, explicit negative rows. There is **no authoritative incoming relation
store or usable reverse follower index**. The later
`20261029061530_follow_count_source.sql` adds `library.follow_count_source` keyed by account/type/original,
monotonic bigint revisions (including negative physical-delete replacements), and `library.follow_count_owner`.
Its `observed_live_count` covers represented rows only; `bootstrap_complete` remains false. Transactional DDL
captures even already-prepared writers after cutover; legacy population is deliberately not backfilled.
The pending partial index is `(route,account_id,pending_since,target_type,target_id)`: owner-local, not a global
oldest-work sampler. Neither the counter nor a missing metadata row may be returned as ready zero.

Follow updates emit only private `{targetId}` invalidations (`com.rezics.library.follow.updated.v1`), never count
deltas or saved positive edges. Existing outbox/effects/DBOS queues provide retries and deterministic IDs, not
target application ordering or proof of receiving custody. Future `follow_contribution`, canonical follower support
and maintained total are derived structures required by the owner contract; they do not exist in this checkout.

## Privacy, authority and operational gaps

- **Current authority:** retain the installed actor grant ∩ consented action scope ∩ delegated principal grant,
  including current denials/roles/assignment. Never infer count ownership from staff, subject authorship, operator
  pointers or a private-Collection curator shortcut. Public account discovery, Subject readability and target-count
  management are different decisions. Target preflight outside command T and the Space read's wall clock need an
  owning temporal-authority correction; current source is not proof of a single-T target decision.
- **Disclosure/errors:** current personal routes expose 401 authentication failures, 403 scope refusal, concealed
  404, 409 stale cursor, 422 key conflict and typed 503 infrastructure failures. Current platform admission maps
  closed gates to **403 `platform_closed`** in `K/http/app.ts`; the count contract requires closed-count **404**.
  The count producer must implement/reconcile its scoped mapping with Accounts, not silently claim the current
  route already complies. Count authority/health uncertainty must remain 503, never a successful zero or stale
  public cache. Unavailable-target removal and Web's boolean-only failures are concrete usability gaps.
- **Delayed counts:** every delivery must reread native account/follow under the account writer barrier, release
  that home before entering a target home, and apply only the highest edge revision. Never replay a saved positive.
  Bounded account wakeup/bootstrap pages and target replacements are missing. Required normal convergence is 60s;
  oldest unfinished work over 300s closes readiness, including queued/error/lost work, original event age, effects
  consumer lag and every installed partition, even idle ones. A recent heartbeat or owner-leading pending index
  cannot establish this. Do not add a request-time graph scan or reverse-list API to obtain a count.
  Canonical groups are capped at 4,096 originals by the adopted contract; rekey segments process at most 100 rows,
  while reads seek one maintained total rather than unioning original-target counts.
- **Restore/deletion/copies:** individual record restoration and terminal account deletion are different contracts.
  The same Library erasure participant must first withdraw every target contribution, including negative-only
  source history, install the permanent payload-free target `terminal_follower(accountId)` fence, and only then
  remove source metadata. A stale in-flight positive must lose to that fence. Canonical moves must include original,
  receiving and unpublished destinations and move fences before pairs. Actual receipt/outbox/write-basis/DBOS
  argument/result copies, locators and late effects still need their owning disposition. Enqueue, timeout, TTL or
  empty source pages cannot prove cleanup; `K/library/erasure-participant.md` explicitly withholds final ACK.

## Adoption boundary and existing delivery

Recommended owner adoption is to finish the already chosen private local model. Accounts/Commerce should settle
unavailable-target removal as an own-edge operation, bind required target evidence to command T, and reconcile
count-only gate concealment with HTTP admission. Web/coowners should choose count placement on existing management
surfaces and expose the same explicit follow affordance wherever an eligible target appears. Those placement and
authority corrections need owning-document adoption; this report does not define new endpoints or permissions.
Locked requests, public networks, block cascades and follow notifications require a separate Root/coowner scope
decision and are not prerequisites for finishing this In row.

The current Accounts/Commerce continuation handoffs were consulted, not executed as contracts. They already name
the full private-count producer, the sole Effect owner-admission producer, the **ALL-Library** identity participant,
the account intent/verifier caller and the shared receipt/outbox/DBOS custody producer. The latest handoff reports
Effect admission delivered on the integrated development branch and routed to Commerce; this worker's
`K/events/effects.ts` still has only `name/types/run`, so it is a real incoming source dependency, not a callable
local hook. Trust the owning delivery and consume it through the controller; do not dispatch a duplicate, reopen
its native campaign or narrow the Library participant to follows.

The following are whole existing-scope product slices, in dependency order. Their outcome checks are **later**
acceptance, not work performed by this report:

1. **Make existing follow removal and controls consistent.** After the adoption above, change
   `K/library/follows.ts`, `command-support.ts`/existing prepared-command support and
   `W/library/{collection-page,dynamic-collection-page,mine-following-page}.tsx`; use stored own-edge identity,
   current native authority, existing CSRF/idempotency and independent `follow.delete` exposure. Add explicit
   controls in `W/features/pages/{subject,account}.tsx` and `W/community/space-page.tsx` using the existing PUT/DELETE,
   with the Subject route's existing private reader path, not new APIs.
   Later outcome: each supported target can be followed and removed; an unavailable row can be removed without
   target disclosure; revoked/delete-only users and replay receive the proper current result.
2. **Finish the existing full private-count producer through a visible management count.** Consume the delivered
   owner-admission implementation in `K/events/{effects,relays}.ts`; preserve atomic durable admission before
   enqueue/checkpoint with the actual imported `PoolClient`/`CloudEvent` interface and original age. Extend the
   existing source migration/`K/library/work.ts` with bounded current-source delivery, bootstrap, lifecycle wakeups,
   revision replacement/support/total and partition health; implement the adopted reads in `personal-routes.ts`.
   Input dependencies are real source rows, native Access management and delivered effect admission, not saved
   events. Later outcome: the seventeen existing frozen count scenarios pass through a real driver; owner sees
   one deduplicated count, strangers see none, and unbuilt/stale work returns unavailable rather than zero.
3. **Complete canonical and terminal convergence inside the existing Library participant.** Reuse the sole
   ALL-Library identity producer and account verification caller; integrate actual Semantic receiving admission,
   canonical source and count pair/support/total/fence delivery before calling any such port.
   Owning paths are `K/library/{subject-anchor,erasure-participant,account-fact-purge,work}.ts` and the existing
   Semantic identity participant integration. Use the existing Accounts shared-history producer for receipt,
   outbox and DBOS copies. Later outcome: merge/unmerge and verification/reversal preserve distinct-follower totals;
   deletion plus delayed/replayed positives cannot recreate contribution or private payload; ACK follows actual
   receiving/copy disposition, with no new workflow or fabricated completion.
4. **Expose private counts end to end on adopted existing pages.** Web binds the real count reads through
   `W/library/collection-records.ts`, `W/community/space-actions.ts` and `W/features/pages/agent-actions.ts`'s private
   reader path, using current viewer actions and existing session custody. Keep private additions out of public
   agent HTML/query caches. Depend on the full count producer and the coowned placement
   decision; do not add a followers page. Later outcome: Collection managers, Space managers and the resolved
   account owner see their authorized count, the follower sees their own outgoing total, and anonymous, suspended,
   revoked and ordinary-Subject viewers get no count, cached leak or invented zero. Retain Following's signed
   keysets and unavailable-target rows; verify these served behaviors with the existing Web outcome infrastructure.
