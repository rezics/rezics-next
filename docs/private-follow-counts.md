# Private follow counts

This is the count authority for the first public scope in [scope.md](scope.md). It specifies future runtime work;
this change installs no route, projection, migration, consumer or production driver. The native outcome suite remains
red without its real driver. Existing follows and the existing own outgoing page remain the source contract.

## Current truth and inspected boundaries

| Existing surface                                                                                     | Actual behavior and limitation                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library/follow-model.ts`, `follow-store.ts`, `follow-store-{apply,read,page}.sql`, follow migration | One row keyed by `(route, account_id, target_id)` in the follower's partition; immutable target type. Explicit unfollow is a stored `unfollowed/explicit` row. Implied library/membership intent never overwrites an existing row.                                                                    |
| `library/follows.ts`, `entries.ts`, `community/work.ts`                                              | Explicit commands, entry in-progress implied follow and membership implied follow all use that row. There is no second graph. `readFollow` retains tombstones; `pageFollows` seeks only `following` rows with an account-leading index.                                                               |
| `library/events.ts`, `follows.ts`                                                                    | `com.rezics.library.follow.updated.v1` has account event subject and closed data `{targetId}`. It is a private invalidation, not a positive edge or a count delta. No change emits no follow update.                                                                                                  |
| `library/personal-routes.ts`, `tokens/cursor.ts`                                                     | `GET /v1/follows` is own-account, `follow:list`, `gate:personal_library`; default limit 20, maximum 100. Signed cursor binds operation `follow.list`, authenticated account and `state=following`, partition epoch and `(updatedAt,targetId)`. Order is updated time descending, target id ascending. |
| `library/collections.ts`, `request/access.ts`                                                        | `collection:update` is the management action. Current `visibleCollection` restricts private Collection command admission to its curator; that helper must not become a new count-owner formula excluding valid management grants.                                                                     |
| `community/space.ts`, `community/README.md`                                                          | `updateSpace` uses ordinary `space:manage` on the Space identity. Installed `community.space.owner` supplies management through native resource roles. Count code must use that evaluator.                                                                                                            |
| `access/account-data.ts`, account public reader SQL                                                  | `readPublicAccountByAgent(pool, subjectId)` follows the verified subject pointer, checks the actual account's active state and reciprocal agent binding, then returns public identity with account `id`. Empty means no usable public account resolution.                                             |
| `library/listing.ts`, `listing-source.sql`, `listing-apply.sql`, `listing-counts.ts`                 | Existing projection counts public Collection membership only. Released source reads and digest receipts do not order first applications. It is neither a follow projection nor a safe ready-made follow adapter.                                                                                      |
| `partition/partition.ts`, `command/command.ts`, `events/log.ts`                                      | `readPartition` yields immutable partition identity, owner state, epoch and bigint position. Native commands atomically advance position with writes/outbox. A follow row has timestamps and transaction UUID, but **no comparable source position**.                                                 |

Paths in this inventory are relative to `services/kernel/src/` except the migration in
`services/kernel/db/library/migrations/20261025164145_library_follows.sql`. Existing event schemas and source row
stamps have been inspected; the observation shape below is a requirement, not an import that already exists.

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

The follower always sees its own outgoing follows, including follows of ordinary unowned subjects. Target management
confers no right to another account's outgoing page or count. No follower identity list is authorized by an aggregate.

## Bounded HTTP contract

Use the existing camel-case route convention, embedded routable UUID parameters and problem responses. A route is
derived with `routeOf(id)`; there is no client-supplied partition, route, owner or principal parameter.

`GET /v1/followCounts/:targetType/:targetId` is the proposed private target read. `targetType` is exactly `subject`,
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

It contains one exact nonnegative safe integer counting distinct currently eligible follower accounts, regardless
of explicit/library/membership reason. A ready, observed empty population returns 0. Count overflow fails closed
with `503 dependency_unavailable`; neither floating approximation nor a numeric string fits this DTO.

Keep `GET /v1/follows?limit=...&cursor=...` and its existing closed `{follows,next}` envelope, signed keyset binding,
maximum 100 rows, optional authorized views and stale-epoch behavior. There is no new account selector. The outgoing
disclosure requirement is satisfied by this existing page; it does not itself require a new outgoing-count route.
The frozen native outcome binding additionally reserves `GET /v1/followCounts/outgoing`, with closed DTO
`{followingCount: number}`, for exact own-account counts. That is a proposed surface tested by that binding, not an
implemented endpoint or a premise needed to preserve the existing page. It accepts no query/body; `?accountId=...`
returns `400 invalid_request`. If implementing this binding, use a maintained own-account live counter, updated in
the same source command as changed follows (including implied paths), not `COUNT` over even the follower's own history.
No-op, tombstone replay and duplicate effects must not increment it. It counts current outgoing source edges; only
active authenticated followers can read it. Outgoing count and list need no target management permission.

Both proposed count reads require real bearer authentication, `follow:list`, `gate:personal_library` and normal read
admission. Target management additionally evaluates its existing action scope in the ordinary formula. Missing
`follow:list` is `403 forbidden`; a viewer with list scope but no management authority receives concealed 404.
Anonymous is `401 authentication_required`; suspended/stale/revoked authentication is `401 invalid_credentials`;
closed exposure gate is `404 not_found`. Existing own outgoing requests retain their native authentication/gate checks.
Never mount the route with optional authentication or substitute caller-asserted identity.

Success uses `Cache-Control: private, no-store`. Errors use `application/problem+json`, native status/code and
`type=https://rezics.com/problems/<code>`, without either count field. Unavailable Access or unavailable/incomplete
projection coverage returns `503 dependency_unavailable` after ordinary request admission; it never returns zero.
This proposed count-specific mapping does not claim existing Access errors already use that problem code.
Counts add no field to public subject, Collection, Space, account-agent responses or public listing DTOs. Private
follow effects change no public FTS, public counts, sitemap, notification or public response artifact.

## Shared protocol inventory and required adapter boundary

The following are reusable **contracts**, not an implemented universal projection compiler:

- `library/listing-freshness-contract.{ts,md}` specifies same-client repeatable-read source truth plus partition
  epoch/position, release before target checkout, monotonic target versions including negative first applications,
  atomic pair/count/outbox changes, guarded cutover and bounded reverse cleanup. Only its stamp comparator and
  public-history predicate execute; its effectful functions throw. Its public-history retention predicate and public
  listed events must never be used to justify private follow retention or disclosure.
- `library/shelf-contract.{ts,md}` and `shelf-maintenance-ops-contract.{ts,md}` specify quiescence, published complete
  generations, readiness distinct from empty, bounded native intents/checkpoints and terminal purge precedence.
  Effectful maintenance ports throw; no follow gate, counter generation or purge consumer exists through them.
- `events/effects.ts` actually registers native effects and deterministic per-envelope workflow ids, retries and
  release-before-next-work delivery. `library/work.ts` actually handles Collection listings only. Neither an effect id
  nor ordered enqueue supplies monotonic follow application or complete source-account visibility coverage.
- `work/retention.ts` actually sweeps terminal DBOS history: default 30 days, configurable 7–365, batches up to 1000,
  up to 60 batches per scheduled run. This is age-based workflow retention, never permission to delay account-private
  purge. `core.receipt`, `core.outbox`, write basis, consumer checkpoint and DBOS history have distinct custody;
  exact per-owner payload locators and consumer-aware erasure remain shared-owner work.

The minimum private target adapter must supply these semantics through that shared protocol; names here describe
data, not exported APIs or installed tables:

1. Source observation: exact `(follower account, target id/type, immutable source route/partition)`, current source
   `following` truth/reason and current active/unfenced account eligibility, with partition epoch/bigint position.
   Read account, follow and `readPartition` on ONE authoritative RR read-only client, including absence/tombstones.
   Failed routing, moved/fenced partition, unresolved account or unavailable source is not observed zero. Release
   before any target command. Use existing point readers; no cross-partition joins or migration of source APIs.
2. Event handling: follow and account-state notifications invalidate observations and request current truth. They
   do not assert positive state. A saved positive must be revalidated by native production preparation against current
   source/account truth on delivery, including its FIRST target application; the test driver cannot do this itself.
   Every source state change advances its partition position. No UUID, wall-clock time or delivery order sorts changes.
3. Target application: one private contribution/version per follower-target pair, plus a target-leading aggregate and
   readiness reference. Preserve source binding; compare epoch then bigint position only within the SAME immutable
   source partition. Older is no effect; equal identical is duplicate; equal conflicting payload is an invariant
   failure rolling back the command. Newer applies delta `eligible(new)-eligible(old)` once in native `runCommand`,
   atomically with version, aggregate and any private receipt/effect. A negative must fence a delayed first positive.
   Explicit unfollow remains authoritative until a NEW explicit follow; later library/membership intent cannot clear it.
4. Read coverage: one exact target key and complete published generation; constant rows/statements plus B-tree depth,
   independent of current follower count or unrelated history. No scan of all follower partitions or `library.follow`,
   no per-edge account/Access checks, and no cross-partition count join. A missing aggregate alone is not zero.
   Readiness must cover source-account visibility changes as well as follow writes. Suspension/deletion invalidates
   any uncovered positive population; no successful exact read may include it while waiting for a notification.
5. Bounded maintenance: indexed source-account locators for every private pair/version, staged observation,
   receipt/checkpoint and generation, including obsolete/negative rows. Target-leading keys serve counts; account-
   leading locators serve purge. Keep at most current operational state/stamps per pair, never transition history or
   a public inverse directory. Reads never enumerate these identities. No inverse is needed for an unowned ordinary
   subject's target count; its source outgoing edge remains legal.

The exact missing shared-kernel contract is a released-source observation/validation and monotonic-apply binding,
with coverage publication/invalidation for **source-account state changes across target partitions**, durable page
intent/ack/checkpoint atomicity, terminal source rejection, and exact evidence-erasure locators. It must state how a
change invalidates old coverage before a successful exact read, including a change after source release, without
holding source and target connections together. Stamps alone and eventual event delivery do not prove that guarantee.
No existing `ListingObservation` import supplies account eligibility, a coverage certificate or private erasure.
These are explicit shared implementation obligations to brief before a count adapter, not invented implemented
ports, an account-generation counter, or a local follow maintenance engine. Ordinary Access and the public-agent
resolver already exist and need no prerequisite API work.

Use the adopted maintenance limits: raw pages at most 100 rows, at most 100 pages per segment, native command deadline
at most 5000ms, bounded scalar keyset continuations (at most 8 scalars / 2048 JSON bytes), workflow arguments/results
at most 4096 bytes. Store epochs/positions as native bigint where applicable; durable JSON positions are canonical
decimal strings, never Number-converted positions. Follow count DTOs remain safe integers. Bootstrap guards every
writer, drains owned captures, builds in bounded native pages and publishes complete coverage atomically. Unversioned
captures cannot apply after cutover; reject old prepared writers at the storage boundary. An incomplete build serves
503, not a partial or fabricated zero. Reuse common scheduling/maintenance custody, not another workflow framework.

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

Remove all outgoing follow rows, including explicit-unfollow tombstones, after bounded target withdrawals/acks have
safe custody. Remove private count contributions, observations, all generations, count-owned receipts/checkpoints and
payloads through indexed pages of at most 100. Terminal cleanup covers pairs with no prior positive application and
old captures in flight, not just current live edges. Durable checkpoint advance and page acknowledgement must survive
crashes. All delayed positives, source replay, rebuild/publication and duplicate terminal events remain fenced.
After exhaustion retain only payload-free account terminal evidence, not a target directory or follower history.
Source terminal rejection must outlive arbitrary saved observations; age alone cannot authorize deleting that fence.
Never call cleanup complete while count-owned payload or locators remain. Shared evidence/backups outside that
inventory require their owner's explicit custody/erasure evidence; workflow GC alone proves no account erasure.

The general retained set is dynamic: active-public contributions remain visible and de-identified, using the last
completely published generation. Holds suspend purge. Safe nonpersonal skeletons may remain; a private fact whose
skeleton itself is personal is erased wholly. Follow data is private and is not a retained public contribution.
Individual record deletion retains its separate 30-day undo policy. Takedown withholds the least affected field/record
and never triggers purge by itself; legal-order purge requires platform authority. Neither rule delays terminal
account-private work or introduces restoration. This decision supersedes older workflow-window deferrals for private
count-owned evidence; shared owners must reconcile replay promises with immediate bounded payload erasure.

## Runtime slices and verification

Each future implementation slice is at most 400 changed implementation lines / eight files; split further if needed.
These are parallel ownership boundaries with concrete existing code edges, not claims that prerequisites have landed.

| Slice                       | Existing edges and required work                                                                                                                                                                                | Dependency                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Shared protocol binding     | `partition/partition.ts`, `command/command.ts`, `events/effects.ts`, Library listing/maintenance contracts: source validation, coverage publication/invalidation, durable terminal custody and private locators | Shared kernel owner; no local substitute                      |
| Source counter/observation  | `follow-store.ts`, follow SQL/migration, `follows.ts`, `entries.ts`, `community/work.ts`: all source writers, exact own counter when binding outgoing count, same-client stamped truth                          | Shared observation/coverage contract                          |
| Private target adapter      | Native target command and indexed private aggregate/contribution storage; monotonic apply and bounded cleanup using the common protocol                                                                         | Shared binding and source observation                         |
| HTTP authority              | `personal-routes.ts`, `request/access.ts`, `community/space.ts`, `access/account-data.ts`: closed target route, one ordinary management check, existing gate/scopes, no public fields                           | Private ready-count reader; Access/resolver already available |
| Native binding and evidence | `http/kernel.ts` real `createKernel`, real Auth/Access and native fixture commands; isolated databases, captures/faults, real SQL instrumentation                                                               | Runtime slices; run every frozen outcome                      |

`specs/follow-counts-driver.ts` is only the test binding; it returns original Responses and captures opaque native
observations. Dispatch starts held. No fake Access, raw grant/role SQL, policy model, normalized response, in-memory
count or direct follow/projection fixture writes may make the suite pass. A setup failure cleans only its own resources.
Every outcome runs through the exact absent-driver guard, including all lifecycle and growth cases.

The frozen suite covers curator/grant/role and account-agent authority, revoked and unowned targets, outgoing isolation
and signed cursors, authentication/scopes/gates, one management check, replay/implied-intent precedence, delayed first
positives and current account state, immediate terminal bounded purge, unavailable dependencies and public exclusion.
Its growth axes separately add unrelated followers, unrelated targets, inactive own history and actual target followers
at cumulative `128 * scale`, scales 1, 4, 16. Keep reader/target fixed within each axis and physical partition numbers
below 4096. Warm real reads, then measure real statements, plan rows times loops plus filter removals, and shared
hit/read blocks: no sequential relation scans except tiny core metadata, identical statements, rows within first +8,
blocks within first +64*log2(16). Measure target and outgoing reads; do not substitute elapsed time or estimated rows.

Run `bun test specs/follow-counts-contract.test.ts` for shape/identity fixtures only, and `bun scripts/typecheck.ts` from
the root. The specification acceptance command is:

```sh
bun specs/support/verify-outcome-suite.ts specs/follow-counts-outcomes.test.ts FOLLOW_COUNTS_DRIVER 'Follow count outcome driver is required'
```

It must prove every native scenario executes red for the missing driver, with zero skips/todos. Passing this verifier
and pure fixture tests establishes an executable specification, never a native implementation pass.
