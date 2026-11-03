# Private follow counts

This is the count authority for the first public scope in [scope.md](scope.md). The native source hook, bounded bootstrap, current-source delivery, target pair/support/total maintenance,
account-state admission, health metadata and private count HTTP are installed in source. Their native outcome
proof and full identity/custody integration remain pending; counts remain behind the existing platform gate.
The native outcome suite remains red without its real driver. Existing follows and the existing own outgoing page
remain the source contract.
The adopted design uses the [simplification report](research/follow-counts-simplest.md) as evidence; this document
owns the contract, including the maintained canonical aggregate and the kernel maintenance-readiness gate.

## Current truth and inspected boundaries

| Existing surface                                                                                     | Actual behavior and limitation                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library/follow-model.ts`, `follow-store.ts`, `follow-store-{apply,read,page}.sql`, follow migration | One row keyed by `(route, account_id, target_id)` in the follower's partition; immutable target type. Explicit unfollow is a stored `unfollowed/explicit` row. Implied library/membership intent never overwrites an existing row.                                                                                               |
| `library/follows.ts`, `entries.ts`, `community/work.ts`                                              | Explicit commands, entry in-progress implied follow and membership implied follow all use that row. There is no second graph. `readFollow` retains tombstones; `pageFollows` seeks only `following` rows with an account-leading index.                                                                                          |
| `library/events.ts`, `follows.ts`                                                                    | `com.rezics.library.follow.updated.v1` has account event subject and closed data `{targetId}`. It is a private invalidation, not a positive edge or a count delta. No change emits no follow update.                                                                                                                             |
| `library/personal-routes.ts`, `tokens/cursor.ts`                                                     | `GET /v1/follows` is own-account, `follow:list`, `gate:personal_library`; default limit 20, maximum 100. Signed cursor binds operation `follow.list`, authenticated account and `state=following`, partition epoch and `(updatedAt,targetId)`. Order is updated time descending, target id ascending.                            |
| `library/collections.ts`, `request/access.ts`                                                        | `collection:update` is the management action. Current `visibleCollection` restricts private Collection command admission to its curator; that helper must not become a new count-owner formula excluding valid management grants.                                                                                                |
| `community/space.ts`, `community/README.md`                                                          | `updateSpace` uses ordinary `space:manage` on the Space identity. Installed `community.space.owner` supplies management through native resource roles. Count code must use that evaluator.                                                                                                                                       |
| `access/account-data.ts`, account public reader SQL                                                  | `readPublicAccountByAgent(pool, subjectId)` follows the verified subject pointer, checks the actual account's active state and reciprocal agent binding, then returns public identity with account `id`. Empty means no usable public account resolution.                                                                        |
| `library/listing.ts`, `listing-source.sql`, `listing-apply.sql`, `listing-counts.ts`                 | Existing projection counts public Collection membership only; it is not a follow projection or an incoming-count adapter.                                                                                                                                                                                                        |
| `command/command.ts`, `events/effects.ts`, `work/queues.ts`                                          | Native commands commit changes, receipts and outbox together. Effects provide deterministic workflow IDs, retries and release-before-delivery; queue concurrency does not order target application. `Effect.admit(client, event)` commits owner admission before enqueue/checkpoint and releases its connection before delivery. |
| `20261029061530_follow_count_source.sql`                                                             | The installed follow trigger maintains per-original bigint revisions, negative replacements, oldest pending age and an owner-local observed live counter. Owners remain bootstrap-incomplete; this counter is not yet a disclosed outgoing total.                                                                                |

Paths in this inventory are relative to `services/kernel/src/` except migrations in
`services/kernel/db/library/migrations/`. Source delivery rows, bounded bootstrap/delivery, canonical aggregates and health sampling now have runtime
implementations; source presence does not establish native outcome proof. No source-storage or admission
registration alone establishes count readiness.

## Disclosure authority

Owner means the authenticated viewer who passes the existing management action on this target, with one exception:
the account resolved for an account agent also sees its own count. There is no persisted owner relation or helper.

| Target                             | Required existing authority                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection                         | Ordinary `collection:update` on `{route: routeOf(targetId), id: targetId}`. Includes curator and management-grant holders.                                                                                                          |
| Space                              | Ordinary `space:manage` on `{route: routeOf(targetId), id: targetId}`. Includes installed management role grants, evaluated by native Access.                                                                                       |
| Subject resolving as account agent | First call `readPublicAccountByAgent`; use its actual account `id`, deliberately different from the subject id. Allow viewer account equality, otherwise ordinary `account:manage` on `{route: routeOf(accountId), id: accountId}`. |
| Every other subject                | No owner; nobody receives a target follower count. A subject author, editor, follower or staff identity is insufficient.                                                                                                            |

Use the ONE installed Access permission formula: actor grant AND consented action scope AND, when delegated, the
principal's grant, with current identity/assignment/role evidence and explicit denials. Do not reconstruct this in
SQL, inspect grant/role rows, or add a staff branch. Person self, automated operator and organization owner are the
same account-agent rule; operator/organization authority is evaluated on the **resolved account**, not inferred from
an operator pointer, organization membership or an agent-id/account-id coincidence. Other account-management command
anchors in Access documentation do not redefine this count-specific decision.

Perform one management check per requested target count page, independent of the number of follower edges; the
resolved account's self branch needs none. Authentication and exposure-gate checks are separate admission checks.
Reuse ordinary Access preparation and evaluation with the request deadline, not a permission cache or per-edge checks.
Unknown, inactive, hidden, deleted or not-visible targets and failed management authority all conceal as `404 not_found`.
Resolve target existence/visibility through its native reader; a private Collection's valid management grant must not
be defeated by the curator-only command helper. Empty account-agent resolution never permits guessing ownership.
Revoke a grant/role and the same bearer loses count access on the next request.
Native unverified graph agents resolve only through their exact persisted Semantic link and current public account; catalogue subjects still require the existing verification pointer.

The follower always sees its own outgoing follows, including follows of ordinary unowned subjects. Target management
confers no right to another account's outgoing page or count. No follower identity list is authorized by an aggregate.

## Bounded HTTP contract

Use the existing camel-case route convention, embedded routable UUID parameters and problem responses. A route is
derived with `routeOf(id)`; there is no client-supplied partition, route, owner or principal parameter.

`GET /v1/followCounts/:targetType/:targetId` is the private target read. `targetType` is exactly `subject`,
`collection` or `space`; `targetId` is a lowercase routable v7/v8 UUID and must identify that type. Invalid target
identity, wrong type, unknown and concealed identities return the same not-found result; malformed route/query shape
returns `400 invalid_request`. There is no query or request body. The closed success DTO is:

```ts
{
  targetType: 'subject' | 'collection' | 'space';
  targetId: string;
  followerCount: number;
}
```

It contains one nonnegative safe integer counting distinct eligible follower accounts in the maintained aggregate,
regardless of explicit/library/membership reason. The scalar may lag current source truth within the maintenance
bound below; it is exact for the applied replacements. A ready, initialized empty population returns 0.
Count overflow fails closed with `503 dependency_unavailable`; neither floating approximation nor a numeric string fits this DTO.

Keep `GET /v1/follows?limit=...&cursor=...` and its existing closed `{follows,next}` envelope, signed keyset binding,
maximum 100 rows, optional authorized views and stale-epoch behavior. There is no new account selector. The outgoing
disclosure requirement is satisfied by this existing page; it does not itself require a new outgoing-count route.
The frozen native outcome binding additionally reserves `GET /v1/followCounts/outgoing`, with closed DTO
`{followingCount: number}`, for exact own-account counts. The native personal routes mount this surface beside the target count and existing outgoing page. It accepts no query/body; `?accountId=...`
returns `400 invalid_request`. Use the maintained own-account live counter, updated in
the same source command as changed follows (including implied paths), not `COUNT` over even the follower's own history.
No-op, tombstone replay and duplicate effects must not increment it. It counts current outgoing source edges; only
active authenticated followers can read it. Outgoing count and list need no target management permission.

Both count reads require real bearer authentication, `follow:list`, `gate:personal_library` and normal read
admission. Target management additionally evaluates its existing action scope in the ordinary formula. Missing
`follow:list` is `403 forbidden`; a viewer with list scope but no management authority receives concealed 404.
Anonymous is `401 authentication_required`; a suspended requester's bearer is below the authentication floor and
receives `401 invalid_credentials`;
stale/revoked authentication is `401 invalid_credentials`; closed exposure gate is `403 platform_closed` under the
[Accounts platform-gate authority](accounts.md#8-platform-gates). Existing own
outgoing requests retain their native authentication/gate checks.
Never mount the route with optional authentication or substitute caller-asserted identity.

Success uses `Cache-Control: private, no-store`. Errors use `application/problem+json`, native status/code and
`type=https://rezics.com/problems/<code>`, without either count field. Unavailable Access or unavailable/incomplete
maintenance readiness returns retryable `503 dependency_unavailable` with `Retry-After` after ordinary request
admission; it never returns zero. The queue-age gate below defines the bound for both count reads.
This count-specific mapping does not claim existing Access errors already use that problem code.
Counts add no field to public subject, Collection, Space, account-agent responses or public listing DTOs. Private
follow effects change no public FTS, public counts, sitemap, notification or public response artifact.

## Per-edge replacement and source maintenance

Keep `library.follow` and its explicit/implied intent precedence. Add a source-side current delivery row keyed by
follower account and original target type/id: bigint `revision`, desired eligibility and oldest uncompleted change
time. Every changed explicit, entry-implied and membership-implied follow updates this row and the own outgoing
live counter in the same source command transaction, emitting the existing private invalidation. Replayed/no-op
commands advance neither revision nor counter. An explicit unfollow remains negative until a new explicit follow.

Eligibility is `following AND account.active AND NOT account.fenced`. A native reconciliation command reads current
account/follow state under the existing account writer barrier, updates desired eligibility and advances the edge's
revision when eligibility changes. Per-edge revisions survive partition moves as row data. Timestamps and transaction
UUIDs do not order replacements. Retain negative delivery rows until terminal erasure; no transition history is needed.

DBOS effects are wake-ups. Every delivery attempt invokes native current-source reconciliation, including a positive
first application; it never replays a saved positive or a `+1` delta. Release the source client before invoking the
native target command. Acknowledgement clears pending work only if the acknowledged revision is still current;
otherwise newer work remains pending. A crash after target commit retries idempotently. SQL owns current work and
acknowledgements, rather than a completed DBOS step's saved result. Native routing still rejects moved/fenced partitions.

Every active/suspended/fenced/terminal account state change commits its outbox event in the transition's own
transaction. Library does not install a trigger on Access account state. Its effect admits the account maintenance
item through `Effect.admit`, using the event's `time` as the item's change time, before the workflow is enqueued and
before the relay checkpoint advances. An event is acknowledged only once its item exists; queued, pending or failed
workflows therefore leave an unprocessed item. The shared `Effect.admit` ABI and relay ordering are owned by Accounts; Library registers its own
account-work admission on that real delivered hook. Kernel records each relay consumer's oldest pending envelope time and observation time in
`core.consumer_lag`; `readConsumerLag` reads that row and `consumerReady` reports false for missing, stale or old
pending work. Readiness requires Library's oldest unprocessed item age and `consumerReady` for the `effects` consumer
to each remain within five minutes of the change. Suspension/reactivation pages only that account's own follows in stable
target-id order, at most 100 rows per page. Each source page reconciles pairs and advances its cursor in one source
transaction under the account writer barrier; target delivery follows after release. Carry the account item's oldest
uncompleted change time into pair work. Page completion never acknowledges target delivery. A new state transition
resets the cursor under the same barrier; no delayed page acknowledgement may overwrite that reset, including an
active/suspended/active sequence. A follow written behind the cursor has its own pending pair work. Do not use the
outgoing page's mutable `updatedAt` seek for maintenance. No account-generation counter is needed.

Disclosure is immediate, while totals may lag: a revoked manager loses access on the next request; a suspended or
deleted follower's contribution is subtracted within 60 seconds under healthy supported load. Beyond the five-minute
maintenance bound the response is readiness, not a stale scalar. Account/target visibility and authorization are
checked live regardless of maintenance progress; queue health is never a permission cache.

## Canonical aggregate and identity ordering

Maintain `follow_contribution(follower, original, revision, eligible)` pairs, a bigint support count per
`(canonical target, follower)` and a bigint total per canonical target. The support count is the number of that
follower's eligible original edges in the identity group. Pairs, support rows and total live together in the canonical
(terminal) target's partition. Keep pairs for ordinary subjects as a private derived index: verification can later
make the subject an account agent. These rows authorize neither a count nor an identity list. Collection/Space
custody follows the target, never its manager; management transfer changes authorization only.

In one target transaction, lock/create the pair and its support row, accept only a higher revision and adjust support
by `newEligible-oldEligible`. Equal identical replacement is a no-op, equal conflicting replacement is an error and
older replacement is a no-op. Negative first applications retain their revision. Increment the canonical total only
on a support transition from 0 to 1; decrement only on 1 to 0; change it at no other time. Pair, support, total and
any command outbox changes commit atomically. A follower of two merged originals counts once; unfollowing one keeps
the other eligible edge. Index pairs by original for re-keying and by follower account for erasure, including negative
and never-positive rows; never recount a target's followers.

Resolve the requested subject in one step to its active terminal and current reciprocal account-agent binding with
`readPublicAccountByAgent`. Authorize against the actual account id, and retain the requested original `targetId` in
the response. Read one indexed canonical total, never sum original totals or union follower pages. Resolution and
count reading cost O(log N), independent of follower population and identity-group size (at most 4,096 originals).
Check the requested original's native visibility as well as the terminal's visibility; a readable terminal cannot
expose a concealed original. A change of binding during the read requires retry/readiness, never guessed ownership.

This applies to account-agent verification and reversal as well as ordinary merges/unmerges. Verification can merge
a derived account agent into a catalogue survivor despite the ordinary account-agent merge prohibition. Source
follows keep their original subject IDs. Re-key only the affected originals' derived pairs and support into the new
canonical partition, in durable pages of at most 100 rows, as a registered Library step inside
[Semantic's scoped identity epoch job](../services/kernel/src/semantic/README.md#durable-publication-and-caller-contract).
Total merge/unmerge work is O(pairs of the affected originals), with indexed probes per row. Reads never pay that cost.

The ordering obligation is:

1. The identity job marks affected old/new destinations pending before changing their mapping. Ordinary applies and
   identity re-key/erasure commands serialize at target admission; admitted applies finish before a re-key page can
   move their rows, and no new ordinary apply enters an affected destination while its epoch is unpublished. Count
   reads of affected targets return `503 dependency_unavailable` with `Retry-After`; other targets remain ready
   subject to the maintenance gate. This is not a global point-read outage.
2. A page durably retains its move intent before source removal, releases one partition before entering another and
   acknowledges destination commit before advancing. Remove old support and add new support with the same transition
   rules, preserving pair revisions. Durable page identities make crash/replay idempotent, including same-partition
   moves. Both partitions' totals may be intermediate only while the affected epoch remains unpublished.
3. Every terminal fence governing moved rows travels with them: install `terminal_follower(accountId)` at the new
   destination before any corresponding pair can be admitted there. Serialize moves and terminal withdrawals with
   the target-local account lock used by applies. A fence wins over every revision; fenced pairs are withdrawn,
   never copied as eligible. Retain the old partition's payload-free fence for old in-flight work. A concurrent
   Library erasure page must acknowledge withdrawal against the current job destination before its source cleanup
   can complete; a changed destination invalidates its old acknowledgement and requires a fresh withdrawal. Include
   never-positive work in this ordering, not merely rows that have already contributed.
4. The Library participant acknowledges all re-key pages and fence custody before Semantic publishes the epoch.
   After publication, the target refuses an apply addressed to the old destination/mapping, even if it has never
   seen that pair. Its retry re-resolves the destination and re-reads current source eligibility under the account
   barrier; it must never retarget a saved positive. A terminal/missing erased source cannot authorize a replacement.
   Fences and unfinished erasure remain effective across later merges, unmerges and retries.

Identity epochs govern routing/publication only; per-edge revisions order eligibility. No read-time group enumeration,
shared source-ordering protocol or cross-partition transaction is required. Native verification must prove the delayed
first apply crossing an epoch and a follower's terminal cleanup cannot recreate an erased relation.

## Kernel maintenance readiness

Provide a kernel queue-age facility keyed by projection name; follow counts are its first user. Other projections
with the same healthy 60-second and maximum five-minute rule can use it. It is operational health, not proof of a
simultaneously current population. The gate covers every installed source partition, including idle partitions and
ones with no previously delivered followers. An unrelated unfinished follow-count job may close this projection's
gate for all targets; unrelated projections have separate health.

Durable source work is the truth for unfinished changes: unrelayed pair work, running/failed/exhausted DBOS retries,
unfinished account-state and erasure pages, and target acknowledgements still owed. Coalescing, retry, leases and
heartbeats preserve the oldest uncompleted change timestamp. Index pending work by oldest time. An enqueue checkpoint
or a completed source page is not delivery completion.

Sample the oldest uncompleted change and sampling time per installed source partition, including an explicit idle
sample. For sample time `s`, oldest pending time `o` and request time `t`, use the conservative bound
`max(t-s, t-o)`; idle samples contribute `t-s`. Add bounded clock skew and the maximum 5-second source transaction
duration, so an uncommitted writer cannot vanish across a sample. Use authoritative database time; unknown/unbounded
skew, missing/unreachable/expired samples or missing topology members mean unknown health. Reduce through a fixed
health tree with bounded fan-out/depth, retaining minimum sample/oldest pending times. Parents expire with their
oldest child and cannot refresh a stale child's timestamp. Count requests read only constant-size root metadata,
never poll partitions or enumerate followers. Read the gate at start and end of the count read.

Dispatch and sampling run at most every 10 seconds. Provision and measure healthy end-to-end completion within
60 seconds, including large-account fan-out; alert on violations. A recent heartbeat cannot redefine healthy.
Return retryable `503 dependency_unavailable`, `Retry-After` and no count when the conservative bound exceeds
300 seconds, health is unknown, bootstrap is incomplete or Access is unavailable. A known bound at exactly
300 seconds is still within the gate; it is already an SLO violation after 60 seconds. Routing failure, an affected
unpublished identity epoch, bigint revision overflow or an unsafe DTO total also fails readiness. Missing totals are
not automatically zero; only an initialized, ready total can report zero.

Bootstrap closes count readiness, enables every source writer hook before bounded backfill, applies by per-edge
revision and opens only after backfill and its pending work drain. Reject old prepared writers at the storage
boundary. Initialize new targets' totals in their native transaction. Install a new source partition in the health
topology as unready before accepting count-affecting writes. The runtime uses the installed native partition topology, a fan-out-16 depth-three health tree and indexed
source/account pending probes. No queue heartbeat alone supplies readiness.

## Cost bounds and operational limits

Let `A` be a follower's own stored follow rows, `E` pairs of affected originals, `D <= 4096` installed physical
partitions, `B` B-tree probe depth (O(log N)), and `H` that account's own retained private work/receipt payload rows.
Index depth can grow logarithmically; no operation enumerates unrelated rows. Health-tree topology is fixed and
bounded. These are work bounds, not elapsed-time guarantees under contention.

| Operation                       | Bound and locality                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow                          | O(B) source pair/work updates plus O(B) target pair/support/total replacement; constant rows/messages, including implied paths. Retry is the same bounded replacement.                    |
| Unfollow                        | Same O(B); preserve source negative and target ordering pair, decrement at most once on the last eligible edge. No follower/target-wide recount.                                          |
| Account suspend/reactivate      | O(B) admission/work item; O(A B) eventual reconciliation, pages <=100, segments <=100 pages. Reset/retry may repeat own work, never unrelated accounts.                                   |
| Account deletion                | O((A+H) B) total Library participant withdrawals/evidence erasure, no extra account-wide count pass. Target fences are O(min(A,D)) payload-free account rows.                             |
| Count read, singleton or merged | One indexed total read O(B), constant rows, one management evaluation (zero for resolved account self), two constant-size health reads; independent of followers, group size and history. |
| Merge/unmerge                   | O(E) derived pair moves with O(B) indexed work per pair, paged <=100 rows inside the identity job; source follows remain unchanged.                                                       |
| Health sample/update            | Indexed oldest pending probe O(B) in one source partition, O(log D) bounded parent updates; request reads root metadata only. No per-count partition polling/account scan.                |

Storage is O(current source and target pairs), support rows and totals, without transition history. Terminal evidence
is payload-free. Store revisions/support/totals as native bigints, decimal strings in durable JSON and safe integers
in responses. Durable steps follow the [kernel's bounded job step limits](../services/kernel/README.md#bounded-job-steps).
Reuse existing PostgreSQL commands, outbox and DBOS scheduling; no separate maintenance engine is required.

## Terminal deletion and minimization

Account deletion is TERMINAL at fresh authentication plus typed confirmation T. Only
`com.rezics.access.account-tombstoned.v1` exists for deletion. There is no scheduled/cancelled event, restore API,
cooling-off window, `accountDeletionState` port or account-generation prerequisite. Suspension/reactivation remain
ordinary current account-state changes, never account restoration; they cannot undo explicit unfollow.

At T private/unlisted/deleted payloads are hidden immediately. Account-private purge starts AT ONCE through bounded
durable work, without platform action, a 30-day delay, projection-consumer completion or physical exhaustion before
the deletion HTTP response. The native tombstone event is the trigger; redelivery is idempotent. Serialize source
cleanup against ordinary writers' `shareAccount` barrier and fence late work before deleting its evidence. Purge
uses a narrowly bound tombstone-checking account lock; the active-only `shareAccount` helper cannot admit it. Cleanup
is not an ordinary active-account follow command; it needs the shared narrowly bound tombstone-consumer authority.

Deletion runs through the **Library participant** of the [terminal erasure workflow](deletion.md#account-erasure),
not a separate count purge workflow. Each Library page arranges target withdrawal before deleting its source
follow/delivery records, including explicit-unfollow tombstones and never-positive pairs. Keep that source page and
its cursor durable until target acknowledgement. Cleanup has no extra recount of the account's Library and no
scan of all accounts/partitions. Duplicate terminal events resume indexed work idempotently.

In each target partition, the withdrawal transaction installs a payload-free `terminal_follower(accountId)` fence
before deleting pair evidence and adjusts support/totals by the same transition rules. Every ordinary apply,
including negatives, checks it in that transaction and drops fenced work without creating private evidence. A
target-local account lock serializes fence installation, applies and identity re-key work; a concurrent first apply
cannot pass an absent-fence check while purge commits. The purge command can still remove existing pairs under its
narrow terminal authority. The fence contains only the account id: no target id, count, cursor or follow history.
Keep it beyond arbitrary saved work/workflow history expiry. Source rereading alone cannot stop a packet already
in transit; terminal source admission and target fences together must prevent recreation, including across epochs.

Remove count-owned staging, receipts, checkpoints and DBOS arguments/results through account-leading exact locators,
including parked work and terminal errors, before Library completion. Source and target page acknowledgements and
checkpoints must survive crashes. Old test captures are handles to revoked work, never a bypass of native admission.
Shared receipt/outbox/DBOS owners must provide registered minimization/deletion custody; age-based workflow GC proves
no erasure. Completion names outstanding shared custody and backup expiry and stays incomplete while any required
payload remains. After exhaustion retain only payload-free terminal evidence, never a target directory or history.

The general retained set follows [deletion](deletion.md): eligible public contributions remain de-identified;
private facts whose skeleton is itself personal are erased wholly. Follow data is private and is not a retained public contribution.
Individual record deletion retains its separate 30-day undo policy. Takedown withholds the least affected field/record
and never triggers purge by itself; legal-order purge requires platform authority. Neither rule delays terminal
account-private work or introduces restoration. Shared owners must reconcile replay promises with immediate
bounded payload erasure.

## Runtime status and verification

Source bootstrap, current-source delivery, canonical pair/support/total maintenance, health/lifecycle work, count
HTTP and the full native driver form one capability. Source storage does not establish a separately ready tier.

`follow-count-source.ts` and `follow-count-bootstrap.ts` own finite source/target coverage and native current-source
reconciliation. Bootstrap continuation commits through the same operational client; no positive snapshot is stored
in workflow inputs. `follow-count-target.ts` applies higher per-original revisions atomically with support and total,
stages exact source-home receiving locators before target checkout, and serializes all applies with terminal fences.
`follow-count-lifecycle.ts` registers atomic keyed account-event admission and revision-bound own-source pages.
`follow-count-health.ts` reduces indexed pending ages and idle samples; initial coverage and pending drain precede
readiness. `follow-count-work.ts` installs dispatch on the default Library WorkModule. The two count routes are
mounted by `personal-routes.ts` in `createKernel`, with native bearer/scopes/gate/admission, closed DTOs and no-store.

`erasure-follow-counts.ts` extends the existing fixed Library participant with exact destination withdrawals and
source/negative/never-positive cleanup before ordinary follow purge. Its real terminal admission hook retains
oldest pending age and a payload-free source fence against late relay replay. It does not ACK the participant or minimize
shared command/event/work copies. Terminal fences contain only physical partition and account identity. The
participant continues to report unresolved whole-role custody as pending. Identity re-key/fence receiving custody
and the full original-Response native driver still require integration; no native/full-suite capability claim follows
from the compiler-only source landing. OpenAPI/client/schema regeneration is deferred to the controller.

The actual [Semantic producer inventory](../services/kernel/src/semantic/identity-epoch-contract.md#independently-landable-producer-boundaries)
delivers `identityEpochStore`, bootstrap and scoped current mapping reads. The required
`semantic/identity-epoch-mapping.ts:stepIdentityEpochMapping` and
`semantic/identity-epoch-coordinator.ts:resumeIdentityEpochJob` / `waitIdentityEpochPublished` are absent, including
the default fixed-participant composition. The native `nativeMappingStep` and `nativeCutoverCoordinator` helpers
address those exact modules. Store admission cannot replace their mapping, re-key callback or publication delivery.
The merged-original verification/reversal and delayed-first-apply-across-epoch outcomes require those real producers.

The installed [Library terminal participant](../services/kernel/src/library/erasure-participant.md) also records
unresolved whole-participant roles and returns pending after local exhaustion. Count-role exhaustion cannot satisfy
the frozen terminal outcome's `purge.complete === true` until that actual participant completes. No separate count
ACK, replacement participant or driver completion flag can close that boundary.

`specs/follow-counts-driver.ts` is only a test binding returning original Responses. Dispatch starts held. Capture
parks a real pending per-edge replacement after releasing the source client. Delivery invokes native current-source
reconciliation and then the target command; handles cannot preserve permission or saved positive eligibility.
No fake Access, raw grant/role SQL, modeled policies, normalized responses, in-memory counts or direct follow/projection
fixture writes may make the suite pass. Setup failure cleans only its own resources. Every outcome runs through the
exact missing-driver guard, including lifecycle and growth cases.

The frozen suite covers curator/grant/role and account-agent authority, revoked and unowned targets, outgoing isolation
and signed cursors, authentication/scopes/gates, one management check, replay/implied-intent precedence, delayed first
positives and current account state, immediate terminal bounded purge, unavailable dependencies and public exclusion.
Its growth axes separately add unrelated followers, unrelated targets, inactive own history and actual target followers
at cumulative `128 * scale`, scales 1, 4, 16. All 17 frozen scenarios stay in place; their singleton fixtures
do not prove merged-group maintenance. Keep reader/target fixed within each axis and physical partition numbers
below 4096. Warm real reads, then measure real statements, plan rows times loops plus filter removals, and shared
hit/read blocks: no sequential relation scans except tiny core metadata, identical statements, rows within first +8,
blocks within first +64*log2(16). Measure target and outgoing reads; do not substitute elapsed time or estimated rows.

Native implementation verification must additionally prove:

- Healthy visibility by 60 seconds, the 300-second boundary and retry headers; missing samples, unrelayed work,
  exhausted retries and a fresh heartbeat with an old unfinished account page fail the gate as specified.
- Crash after target commit before source acknowledgement, coalescing preserving oldest age, state resets racing
  pages, explicit-unfollow precedence and source partition moves preserving revisions.
- Concurrent terminal fence versus first apply, Library erasure of never-positive/tombstone rows, payload custody
  and a delayed first apply crossing an identity epoch and follower terminal cleanup without recreating any relation.
- Verification/reversal with follows on both originals counted once, removal of only one edge, bounded re-key pages,
  crash/replay between source removal and destination acknowledgement, fence propagation, stale-destination refusal
  and current-source reconciliation on retry. An unpublished affected target gives readiness; others stay ready.
- One indexed total read at three geometric scales of followers and group size, including a 4,096-original group;
  no read-time union, original-total sum or group scan. Identity changes during a read cannot disclose a partial total.

The frozen outcome suite and existing meaningful native/security/growth cases remain later integration proof.
This source landing runs only the foreground local kernel typecheck. The controller owns schema, OpenAPI and
client regeneration and the later acceptance command; typing proves neither native readiness nor all seventeen outcomes.
