# Access

Access owns account state and lifecycle, bearer identity evidence, resource permission evaluation, grants, principal assignments and creation authority.

Every access event type has a schema in `events.ts`, and the catalogue test proves it with real data.

## Registries

Command admission, the approval identity bridge, the durable identity bridge, platform gate checks and resource roles are registered on one Access object. Every lookup goes through `accessRoot`. `deriveAccess` therefore keeps the root's registration, through any number of further derived adapters. Copying methods onto a new object does not: that object is its own root and has no registration.

A command whose Access has no command admission is refused. A missing approval or durable identity bridge refuses the identity. A missing platform gate check denies the gate. A missing resource-role catalogue leaves the type unresolved. `createAccess` installs each registration, so an Access from that factory keeps admission, both identity bridges, platform gate checks and resource roles.

Installing command admission or either identity bridge on a derived Access is refused. Resource-role installation is stored on the root, so a derived Access reads that same catalogue.

Each use is one WeakMap read plus the derivation walk to the root.

## Internal actions

`createAccess` adds the fixed `INTERNAL_ACTIONS` catalogue to mounted route declarations in every composition,
including the default kernel and native workflows. These actions have no default mounted route:

| Action                           | Access checks                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate:any`                       | `gates/admission.ts` and `gates/visibility.ts` check Global exposure; `grant-command.ts` checks gate grant authority.                                                                                                                                                                                                                                                                                     |
| `account:manage`                 | `agent-verification.ts` checks non-self status, request, withdrawal and release; `index.ts` checks the credential floor bridge; `workflow-approvals.ts` checks credentials, automation and operator changes; `lifecycle.ts` checks automated rename/deletion; `session-revocation.ts` checks own session revocation; `committed-deletion-work.ts` and `operator-fence-work.ts` compose management checks. |
| `account:delete`                 | `lifecycle.ts` deletion and `workflow-approvals.ts` delete approval. Retains `replay: 'self-account-read'`.                                                                                                                                                                                                                                                                                               |
| `account:assign_reserved_handle` | `lifecycle.ts` reserved-handle assignment.                                                                                                                                                                                                                                                                                                                                                                |
| `organization:create`            | `workflow-approvals.ts` organization creation approval.                                                                                                                                                                                                                                                                                                                                                   |
| `organization:membership`        | `lifecycle.ts` membership changes and `workflow-approvals.ts` membership approval.                                                                                                                                                                                                                                                                                                                        |
| `client:manage`                  | `workflow-approvals.ts` client reduction approval.                                                                                                                                                                                                                                                                                                                                                        |
| `access:delegate`                | `native-account-bindings.ts` configures `delegation-commands.ts` principal assignment checks.                                                                                                                                                                                                                                                                                                             |
| `account:renew_cleanup`          | `committed-continuations.ts` cleanup renewal.                                                                                                                                                                                                                                                                                                                                                             |

Composition is additive: an identical mounted declaration keeps its metadata. A conflicting anonymous, replay or
resource-type declaration throws an error naming the action. The default kernel validates this at startup even
though it builds Access lazily. Internal entries do not become HTTP routes or alter the mounted route catalogue.

Registration grants no authority. Ordinary grants, account and principal evidence still apply, and a session's
consented client scopes must include the checked action. This catalogue neither registers clients nor widens their
scopes. Auth's trusted `registerClient` and `registerWebsiteClient` inputs own registered scopes; website registration
also enforces the supplied `siteActions` catalogue (`services/auth/src/website.ts`). A website composition deriving
those inputs only from mounted routes therefore cannot issue `account:manage` until its owning Auth composition
explicitly includes that scope. Auth's host creates a missing `login` client with empty scopes (`services/auth/src/host.ts`).

## Grant rule

A grantor needs `access:grant` and never grants an action they do not hold. Grant, change and ordinary revoke use that same check for every new and previous action. An account may renounce its own direct grant without `access:grant` when its acting client's consented scopes cover every action being revoked; organization-role, `active_accounts`, and another account's grants still require `access:grant`.

`gate:<group>` and `gate:any` are direct actions on the Global Context (route 0, id `00000000-0000-8000-8000-000000000000`). `<group>` matches `^[a-z][a-z_]{0,62}$`. On that resource, holding `gate:any` counts as holding every `gate:<group>`. Granting `gate:any` requires `gate:any`. The grantor check adds at most one extra exact `gate:any` check on the Global Context per granted gate action, `O((1+K) log G)` with `K <= 1000`. Other actions are unchanged. There is no caller-supplied grantor and no wildcard for any other action.

### Platform governance reach

For `moderation:takedown`, `moderation:read_reports`, `post:erase`, `media:erase` and `access:grant`, Access first evaluates the ordinary formula on the requested resource. If it denies, Access checks that exact action on the Global Context with the same actor, client scopes, principal and authoritative time. The Global check uses the normal account and assignment floors and current suspension/fence checks; denials on the requested resource do not affect it. A Global action never covers another action. The actions in `globalReach` must also be held by the built-in `platform.governance` role. Grant commands still require the grantor to hold each listed action on the Global Context when granting it there.

A command authorized by this Global check writes one row to `access.governance_reach` in the same transaction. The row records the command transaction id, action, requested resource and actor account. Permission proved on a separately released authority connection carries that reach use into the command transaction; authorization denies if the transaction cannot register it. Repeated authorization for the same action, resource and actor in one command registers one write. Replays, denials, rolled-back commands and checks outside a command write nothing.

## Resource evidence failures

Every owning-module resource evidence callback runs through `accessEvidence` in `evidence.ts`.
A callback failure closes the whole request, including the independent grant branch. The shared
`throwAccessUnavailable` classifier turns deadline, pool capacity, connection and contention failures into
`AccessUnavailableError` (HTTP 503). An existing Access unavailability error retains its identity through command
rollback. The command retries Access contention inside its deadline with the normal fresh attempt and does not
reclassify the error; deadline and overloaded errors pass through immediately.
The module's own denial passes through unchanged. Any other failure uses the caller's existing denial form:
boolean checks (`accessCheck`, `authorize`, and eligibility preparation/verification) answer `false` for the
whole check, including the independent grant branch. Commands throw their `denied()` error;
`GrantDeniedError` applies only to grant commands. The kernel's `console.error` logger records the original failure as
an error cause; response bodies contain only the denial. No callback failure authorizes an effect, receipt
or outbox event. Failed creation validation poisons its transaction even if the command catches the error.

The boundary covers eligibility `prepare` and `facts.verify`; shared resource/page/parent anchor `validate`;
creation-entry `validate` (individual and manifest) and the delegated parent `authorize`; durable-operation
`readOperation` and restored-step anchor `validate`; workflow-resolution anchor `validate`; Realm role
`realmRoleReader`; Realm membership `readTerminal` and `readChange`; and standing-parent setup `validate`.
Enclosing Access catches preserve unavailability and module denials. Unexpected callback failures in boolean
checks instead leave no usable permission evidence or return a denied decision.

Existing Content denial classes have no shared base type. The boundary retains their closed set of error
names (`ContentNotFoundError`, `ContentForbiddenError`, `RevisionPreconditionError`, `ReportUnavailableError`),
Access's `GrantDeniedError`, the caller's specific denial class, and HTTP `ProblemError` client errors.
Unrecognized error types fail closed as the caller's denial. This changes no module callback, evidence read,
row count or statement count; it adds only local exception handling to existing calls.

`test/access/evidence-callback-failures.test.ts` injects failures through these callback paths, checks
unavailability and denial identity, cause logging and rollback, and exercises a real board read through
the HTTP application. `test/access/unavailable-not-denied.test.ts` retains authentication and native
permission failure coverage.

## Accounts

### Account graph agents

The accounts WorkModule registers one shared effects worker for account-agent synchronization. Account activation and
automated-account activation use `com.rezics.access.actor-activated.v1`; organization creation uses
`com.rezics.access.organization-created.v1`; a committed display-name change emits
`com.rezics.access.account-display-name-changed.v1`. The effect also consumes account tombstones, authentication
fences, floor advances and establishment, suspension and reinstatement, operator subject fencing and unfencing,
and verification reversal completion. It reads the current account row by its `(route, account_id)` anchor and
calls Semantic's `ensureAccountAgent` as platform work. An actor without an operator is a `person`, an organization is
an `organization`, and an actor with an operator is `software`. The label uses the current display name or handle and
language `und`. When no global definition release is active, the effect completes without creating an agent;
there is no agent work yet. Every other failure propagates so delivery retries from current account state.

An account's display name is personal data. Deletion or fencing erases its existing agent node's label with
`name: null`, including all label history, revisions and event or receipt copies. The node's stored type preserves
its kind after deletion clears the operator. Missing nodes are left absent. Clearing a fence restores the current
display name, falling back to the handle. Other non-active accounts do not acquire labels. A merged account node
ignores label synchronization, preserving the independently maintained catalogue agent's labels.

Deleting a verified account first queues the durable verification reversal. Its final step synchronizes the
restored account node from the current account row, erasing the label after unmerge, page removal and Access cleanup
complete. Replayed events and reversal steps converge on the current state.

Run `bun services/kernel/scripts/ensure-account-agents.ts` during deployment after activating the global definition
release to backfill active, unfenced accounts, including those skipped before a release was active.
It scans in `(route, account_id)` keyset order with pages of 100, releases each page before issuing its per-account
Semantic command, and can be rerun safely after interruption.

Managing an automated account requires an `account:manage` grant on its operator's account resource.
A person holds this grant for the automation they operate. When an organization operates automation,
its owners receive `account:manage` and `access:grant` through the owner-role grants written at organization creation.
Owners can grant management to other members through the ordinary `/v1/grants` routes; a grantor cannot grant
actions they do not hold. Operator session and credential capabilities also require current organization membership,
so a management grant to a non-member is inert. Revocation removes management authority at command time T,
including when consuming a previously approved opening.

Who may delete an account (`account:delete`):

- A person's account is deleted only by that person.
- An automated account is deleted by that account itself or by the managers of its current operator. The managers'
  authority is `account:manage` on the operator, read through the operator relation at command time. It is never
  copied into a standing grant on the automated account, so it follows the relation on transfer: the previous
  operator's managers lose it and the new operator's managers gain it. The delete approval reads the same relation.
- An organization is closed by a current owner who holds `account:manage` on it. Both management and the
  owner membership are read at command time T. A manager without an owner membership and governance receive no
  new deletion power. The existing zero-owner deletion through `account:delete` remains supported.

The operator relation adds one anchored point read to deleting another account: O(log R), with no extra statement
when the account deletes itself.

An operator cannot be deleted while it operates accounts; the responsibility hold ends only when each operated
account has transferred or been deleted and its responsibility released.

An organization close atomically tombstones and fences its account at T, without first removing its owners.
Every organization membership and owner-role grant stops conferring authority at that barrier, including retained
history, operator openings and organization-role reads. Responsibility holds still block the command; refusal
identifies the hold's purpose and related account. An organization operating automated accounts must first transfer
or delete each account and release its responsibility.

The tombstone transaction stores a durable cleanup checkpoint. The accounts work module consumes the committed
tombstone event and runs separate workflows of at most 100 membership rows, ordered by member ID and validity range.
Each page commits the removed rows, terminal reservation proofs and its cursor with an immutable receipt before
releasing the corresponding inverse rows on their own actor anchors. Replay finishes the same receipt's releases;
restart resumes the saved step. Final cleanup runs the existing deleted-handle retirement step under the same
committed key as any Auth deletion continuation. Member accounts,
their grants and their other memberships are preserved, including suspended or deleted members' accounts.
Deleted organization public identities expose only `{ id, state, kind }`.

The close now traverses an independent random row key; no Access cursor stores an account id. The operator page's
reservation id is also an independent key; relation residue erasure removes its subject bindings. This replaces the
member-ID and validity-range ordering described above.

Resources owned by the organization in other modules, including Realm roles and content, remain those modules'
responsibility. They learn of deletion from `account-updated`; organization close changes no such resources.

No organization exists in any deployment yet, so these creation defaults need no upgrade path.
Organization creation writes two additional grant rows; request paths and their costs are unchanged.

Suspension is never blocked by coordination. Platform governance can suspend an active account that operates
automation or has a pending responsibility reservation or other lifecycle coordination row. Suspension locks that
account, requires `state = 'active'`, and advances the authentication floor and fence. Responsibility reservation
and transfer, deletion, and every other coordinated lifecycle step that reads `lifecycle_coordination` lock the same
account row and require `state = 'active'` under that lock. Once the account is suspended, that step fails closed
and writes nothing. An account that is already suspended or deleted is still refused.

Reinstatement is the separate governance reversal, `account:reinstate` on the Global Context, held by
`platform.governance`. `POST /v1/accounts/{accountId}:reinstate` locks that account while it is `suspended`, sets it
`active`, clears `suspension_reason`, and lowers the authentication fence the suspension raised. `minimum_authn_epoch`
stays where the suspension put it, so every token, session and proof issued before the suspension stays refused. The
person signs in again. From the command's T the account is permitted as any active account. An active, pending or
deleted account answers 409 and stays unchanged. A deleted account is never reinstated. The command leaves every other
fence and hold alone. It commits a continuation root to lift fences raised by this suspension on accounts it still
operates under the same reservation. Signed pages of at most 100 persist their child allowlist before effects and
recheck each subject and relation slot under lock. Only the current fence with this suspension's native receipt is
lifted; deleted, transferred, independently suspended or otherwise fenced accounts stay unchanged. Authentication
floors never decrease, so credentials can obtain fresh tokens while earlier tokens and sessions stay refused. Each
page first checks that the operator is still active and that this is its latest suspension; another suspension stops
that reversal.
Page and subject receipts make crash recovery and replay idempotent.

### Account agent verification

`POST /v1/accounts/{accountId}:requestVerification` accepts `{ subject, statement, links }`. A fresh human session may
request its own actor account; an organization's manager may request that organization through its existing
`account:manage` authority. The catalogue subject must be a visible `schema:Person` or `schema:Organization` when the
request is approved. Statements contain 1–2000 characters; links follow the account profile limits. Only one request
per account may be pending or in approval. `GET /v1/accounts/{accountId}/verification` returns that account's latest
request, and `POST /v1/accounts/{accountId}:withdrawVerification` withdraws its pending request.

Platform governance reviews `GET /v1/verification-requests?state=pending`, which returns
`{ verificationRequests, next }` with an opaque `encodeListCursor` cursor bound to the route, governance viewer,
pending state, ordering and page size, and a limit from 1 to 100. The approval and rejection routes,
`POST /v1/verification-requests/{requestId}:approve` and `:reject`, accept an optional reason of at most 500 characters.
Both require `account:verify_agent` on the Global Context, held by `platform.governance`. All verification routes
stay closed behind `gate:agent_verification` until governance opens that exposure group. The public handle identity
read remains public.

Approval first records its decision receipt and queues the durable `accounts.agent-verification` workflow. The workflow
rechecks and marks the account in its own partition, calls Semantic's `verifyAccountAgent` as platform work, then
marks the request approved. A semantic refusal clears the pending account marker and records the typed problem on a
failed request. The semantic catalogue node survives the merge. A subject id permanently names a catalogue record
and is never reused; merging asserts duplicate identity only. Every published redirect points directly at an active
terminal, so a read takes at most one step. An identity group holds at most 4,096 originals, checked when a merge
is admitted. Stored references are never rewritten: personal entries, labels, sessions, copies and Collection
occurrences keep their stored subject ids. New writes address the current terminal, and canonical views group them.
Merge and unmerge run serialized through Semantic's one durable identity job: it marks a catalogue identity epoch
pending, completes bounded mapping and index maintenance, then publishes the next epoch. A crashed job stays
pending and resumes. Receipt-bound commands and the semantic merge make workflow replay and restart converge.
Rejection changes only its request. Request, withdrawal, approval, rejection, failure and verification each emit a
registered Access event.

`POST /v1/accounts/{accountId}:revokeVerification` accepts `{ reason? }` (at most 500
characters) and requires `account:verify_agent` on the Global Context. Send `{}` when omitting the reason.
`POST /v1/accounts/{accountId}:releaseVerification` takes no body and requires the account's own
`account:update`, or `account:manage` for an organization. Both routes use the same exposure gate and return
`{ reversal }`, including the account, catalogue subject, original verification receipt, decision receipt,
requester, reversal kind (`released` or `revoked`) and nullable reason. A rejected application is not a reversal.

The reversal decision commits in the account's partition. This is the first workflow step: atomically save the
receipt and registered `agent-verification.reversing.v1` event, set `agent_verified` false, clear the active subject
and receipt, and retain the subject and reversal receipt in the pending fields. Both public lookup directions
stop advertising the link immediately: the handle uses the account's own agent, and `GET /v1/accounts?agent=`
checks the account's current verified state before returning a page pointer. The pointer may still exist then.
The pending marker prevents a new application until cleanup finishes.

The outbox effect queues durable `accounts.agent-verification-reversal` work, bound to the decision receipt.
It calls Semantic's `unverifyAccountAgent` as mechanical platform work, deletes the exact original receipt's
`access.agent_page` pointer in the subject's partition, then clears the pending marker and emits the registered
`agent-verification.reversed.v1` event atomically in the account's partition. Its final durable step synchronizes the
restored account node from current Access state, erasing the label for a deleted or fenced account. Erasure waits
until reversal completes because ensure ignores a merged node. Both events and the decision receipt
retain the reversal kind and reason. Commands, Semantic's reversal and pointer deletion are idempotent across
replay and process loss. Old deliveries check the pending reversal receipt before unmerging, so they cannot undo a
newer verification. The account may submit a new reviewed application after completion.

The account agent effect also consumes `account-tombstoned.v1`. A deleted verified account commits the same
reversal, with kind `revoked` and reason `Account deleted`; durable outbox delivery runs the same cleanup workflow.
If approval or reversal is pending, the effect retries until that work completes, then converges from current state.
An old activation or rename delivery also converges from the deleted row. No catalogue agent remains linked after
cleanup; independently held catalogue facts and links remain Semantic's responsibility.

The handle identity read returns `subject: { id, label, type }` for an active account, using its derived account agent
until verification and the catalogue subject afterward. It returns `verified: false` or `true` accordingly; a deleted
account returns `subject: null` and `verified: false`.

- Request touches the account's anchored read, one unique pending-request probe and one insert in the Global Context
  partition. A decision touches its Global Context request and writes that row. Rows and statements are constant;
  blocks grow logarithmically with requests.
- Pending pages read at most `limit + 1` rows through the partial pending-page index. Rows are O(limit), blocks are
  O(limit + log N), and decided requests do not affect the range.
- The workflow performs one account point read/update per Access step; Semantic's merge has its own cost entry.
- Growth checks: `test/access/growth-agent-verification.test.ts`, `agent verification request stays bounded as decided
  requests grow` and `pending agent verification page stays bounded as decided requests grow`, scales `[256, 1024,
  4096]`, seeded in `grow` with at least one warm-up.

### Agent verification policy

Verification establishes authority to represent a catalogue subject. Reviewers check evidence in this order,
strongest first:

1. A challenge on the subject's established official site or domain.
2. Authenticated confirmation from an established official account.
3. Confirmation from a publisher or distributor, reached through a contact found independently.
4. Private documents plus proof of authority to represent, as an escalation only.

A link or screenshot alone is never enough. Reviewers record which evidence they checked and why they decided.
The claimant is told the outcome and may add evidence or appeal by applying again.

Verification grants answering as the subject (official speech) and the profile link. It grants no catalogue
editing power: corrections follow the ordinary evidence and permission rules. An organization speaks through its
organization account and its members, never through a person's credentials.

Readers see `Verified representative of <subject>`, linked to that subject, with an explanation that verification
is not an endorsement. Public reads show only the current verification state and never the evidence.

The account may release verification; governance may revoke it. A dispute is resolved by revocation followed by a
new reviewed application, never by automatic transfer to the next applicant. There is no fixed expiry. A re-check
follows an event such as a compromise, a change of domain control or a complaint.

`gate:agent_verification` remains closed until governance explicitly opens it under this evidence and review policy. The
[verification research](../../../../docs/research/agent-verification.md) supplies the evidence behind these decisions.

## Operator responsibility pages

`createOperatorCommands` remains an internal privileged application port; it has no public list route.
Production composition must supply `OperatorConfig.cursorKeys: KeyRing` to use `responsibilityPage` (the field remains optional when constructing commands for other operations):
`current` is the active key ID (integer 0–255), and `keys` maps trusted IDs to token keys of at least 32 bytes.
Keep this ring stable across requests, workers and restarts, and retain decryption keys during rotation for the shared 15-minute cursor lifetime.
Construction without this field still supports existing commands; every page call fails closed without a valid active key.
There is no environment lookup, generated key or unsigned fallback in this factory.
The existing pool must reach the operator anchor's `core.partition` row; its epoch is read through `readPartition` in the same repeatable-read snapshot as the page, so callers supply no epoch override.
A missing anchor partition also denies the page call before reading responsibilities.

The list port accepts `{ operatorAccountId, cursor?: string, limit?: number }` and an optional authenticated `Actor`, returning `{ operators, next: string | null }`.
Trusted composition supplies the acting account from authentication; omitting the actor denotes an anonymous viewer.
An anonymous cursor cannot resume as an account viewer, and an account cursor cannot resume anonymously or as another account.
The default limit is 20; explicit limits must be integers from 1 to 100.
Rows retain exactly `{ reservationId, subjectAccountId }`, including pending responsibilities conservatively; they do not establish current relation authority.
`cursor` and `next` use the opaque `encodeListCursor`/`decodeListCursor` format.
Because this internal port has no HTTP route, its fixed feed name is `access.operator.responsibility.list`; the binding includes the acting account ID (or `null` for anonymous), operator identity, purpose `operator`, ascending reservation order and the effective limit.
The encrypted position retains the partition epoch and reservation after-key. A cursor cannot cross viewers or page sizes.
Issuance and expiry use `OperatorConfig.clock`, defaulting to the kernel clock installed on Access.
Each page samples that clock once for both cursor validation and issuance; a cursor remains valid at exactly 15 minutes old.
The scan touches the same rows and statements; cursor encryption adds constant CPU for HKDF and AES-GCM per token.
The separate internal `responsibilityWorkPage` port retains sealed work cursors for durable fence fanout; these never reach list readers.
Malformed, expired, wrong-key, differently bound and stale-epoch cursors fail before the responsibility query.
A token conveys no permission: only trusted composition may call this internal port, and Auth still authorizes its operation before its bounded 64-row fanout steps.

## Native Auth barriers

Auth's trusted server composition supplies `createAuthBarrierCapabilities({lifecycle, proofs})`:

- `lifecycle` is the concrete `createLifecycleInternals(...)` result, specifically
  `advanceAuthenticationFloor`, `readFenceReceipt` and `readFenceState`. Its existing kernel pool,
  stable `routeKey`, provisioning evidence resolver and new-establishment recovery resolver remain host configuration.
- `proofs` is Auth's `createBarrierProofVerifier({database: authPool})` result, or its host-owned
  closure exposing only `verify(reference, {accountId,purpose,previousEpoch,operationKey})`.
  Auth retains its pool, credentials and receipt writers. Kernel receives only this proof capability.

The Auth host composes its `AuthServiceOptions.trustedAccess` as follows (other capabilities stay host-owned):

```ts
const barriers = createAuthBarrierCapabilities({
  lifecycle,
  proofs: createBarrierProofVerifier({ database: authPool }),
});
const trustedAccess = {
  ...createAuthBindings({ pool: kernelPool, ...otherCapabilities }),
  ...barriers.trustedAccess,
};
```

Spread `barriers.trustedAccess` last. It translates exact native receipt floors to Auth's numeric receipt
contract and lets native receipt identity authorize retries. The factory also exposes `invalidateAccount`
and `authorizeRecovery` matching `AuthBindingCapabilities`, returning `LifecycleFenceReceipt`; the older
`createAuthBindings` barrier wrappers pre-read the previous floor and therefore cannot resume a committed barrier.
No public route accepts these capabilities, their command arguments or caller-supplied account/epoch authority.

Both calls require Auth's actual `proofReference` and `operationKey`. Consent proofs bind the authenticated
session and exact reducing consent revision; recovery proofs bind the consumed native verification and intended
credential establishment. Missing, unavailable, expired, consumed or mismatched proof resolution denies before
mutation. Proof resolution repeats for every native attempt, including receipt replay. The account lock checks
active human eligibility and proof expiry at authoritative T; recovery additionally requires the native fence.
The command digest binds purpose, expected current floor, operation key and exact proof identity. Its SQL
compares the floor again, advances once and inserts one persistent native receipt in that transaction.
Concurrent exact retries return that receipt; other operations at the old floor and later supersession deny.
Committed receipt and current account state are read back before returning to Auth.

An automated account's consent to a third-party client is granted only by an approved operator opening: the opening binds
the acting human's client and exact scopes when it is created, and Auth records that consent for the opening's client and
scopes in the transaction that installs the session. The record only adds scopes; the consent endpoint never grants or
widens it.
Auth also lets an operator-opened session of an automated account reduce that account's consent for a client through the same barrier and receipt.
Only `consent-reduction` advances an automated account's floor; `recovery` still requires an account without an operator.
Auth sends `openingReceiptId` exactly for such a reduction and binds it into the consent proof, so Access accepts only the
opening Auth committed for that session. The anchored read of that opening (`auth-barriers-opening-read.sql`) checks
the receipt and floors only: it must be consumed, of purpose `session`, for this subject, operator and reservation, and
recorded at the subject's previous floor; the acting human must be active, have no operator and still hold the floor
recorded at the opening (`human_epoch_floor`); the operator must be active and unfenced. It returns the principal the
opening recorded (acting human, `client_id`, `scopes`, `requested_by`, human epoch) and reads no membership, grant,
denial or role.

Whether that human still manages the operator is the shared permission evaluator's decision, the one the opening itself
makes. Before the account lock the barrier reads the opening once, restores the recorded principal and runs the
opening's evidence at the attempt's T (`OpeningManagement` in `lifecycle.ts`, built by `createOperatorCommands` and found
with `openingManagement(access)`): the human's current account, the operator and subject, the membership read the opening
uses, and `account:manage` on the operator through the evaluator over the mounted action catalogue. Every operand of the
formula therefore applies: the recorded client scopes, grants by identity, role or all active accounts, resource roles,
denials, the delegating principal, suspension and governance reach. The evaluator for a restored principal is built
with the mounted catalogue and refuses to decide when its resource roles differ from the Access's own; it has no Realm
role reader, so a Realm-group grant denies. Under the lock the same anchored read runs again and the opening's final check
verifies the evidence, locking the subject and the operator in route-then-id order. A missing management decision or any
refusal advances nothing. An exact replay of a committed floor advance returns its receipt without this decision.

Both barriers advance the floor and fence the account in the same update, so Access holds the new floor, the fence
and the receipt before Auth applies any effect. A barrier always advances the floor: a reduction is possible on an
account that is already fenced, such as an owner an operator fenced. It raises the fence and sets its receipt only when
the account is not fenced; a fence it did not raise keeps its own receipt. Recovery needs the fence it already holds
and replaces that fence's receipt with its own, because completing the recovery is what clears it.

Auth applies nothing until Access confirms the receipt. Auth calls `trustedAccess.confirmBarrier` with the account,
purpose, operation key, receipt id and floor, and refuses unless it returns true. Access answers with one anchored read:
the fence receipt for that account and floor joined to the barrier command receipt keyed by purpose and operation key
(`lifecycle.confirmBarrier`, `auth-barriers-receipt-read.sql`). A replaced, foreign or other-purpose receipt id is not
found. Recovery confirms before it hashes the password or writes the credential, sessions, effect receipt and
establishment row; consent confirms before it reduces the stored consent or revokes sessions.

The fence clears only by completion with that receipt. After a consent reduction and its session revocation commit,
Auth calls `trustedAccess.completeBarrier`; `lifecycle.completeConsentBarrier` clears the fence only while the account's
fence receipt and floor are that barrier's. Otherwise the fence stays and the completion still commits, so Auth's
effects apply either way, and an exact repeat returns the committed completion. Until then a retry of the same consent
request resumes the barrier and completes it. Recovery completes through `completeRecovery`: only existing
`clearFence` with trusted new establishment evidence bound to the exact account, receipt and current floor can clear a
recovery fence. Both ports are optional on Auth's trusted access object; the factory always
supplies them, and only isolated fixtures omit them.
The focused tests exercise Auth's real HTTP consent/recovery flows and concrete proof verifier against native
PostgreSQL lifecycle commands. This establishes the barrier seam; provisioning and fence-clear evidence readers
remain separately required host capabilities and are not supplied by this factory.

## Write rate

`WriteRateLimiter.spend` admits a person's request at the route stage before
commands execute. Ordinary writes spend one unit; bounded request batches reserve
their 1–100 command units once. A durable bulk uses the chunk port for each later
step.

### Durable bulk

`createWriteRateLimiter` returns `DurableWriteRateLimiter`, which adds
`spendChunk(context, {operation, index}, family, units)` to the unchanged spend-only
`WriteRateLimiter` port. A durable bulk calls it inside its chunk command's
`CommandAuthorization.prepare`, after `restoreInitiator` at the same T, with the
restored actor in context. Units are the chunk's 1–100 targets; index is a
nonnegative safe integer derived deterministically from committed progress.
Interactive writes and chunks charge the same identity/family counter and current
`RATE_LIMIT_V1` class budget. A restored service account still spends its budget.

The partition-led UNLOGGED `access.write_rate_chunk` ledger keys the initiator's
route, identity digest, operation ID and chunk index. An admitted chunk is free on
retry until its recorded counter window expires, including when its family or
class changes. Refusal records no ledger entry: sleep `retryAfter` seconds durably,
then restore and retry the same index. Missing bound identity or unavailable
storage raises `WriteRateUnavailableError`; workflows retry this 503-class failure.
A concurrent first admission that loses a ledger race rolls back its entire debit
and raises the same transient error; retry observes the committed admission.
Crash loss of the UNLOGGED ledger may charge again and is accepted.

## Durable initiators

Sessions and durable actor snapshots admit at most 512 consented scopes, each at most 128 ASCII bytes,
with at most 66,047 bytes when joined by single spaces. Auth and Access share these bounds from
`@rezics/auth-contract`. `createKernel` rejects a mounted plus internal action catalogue larger than
512 at composition, reporting its count and the bound before serving requests. Snapshot capture retains
the session's complete scope ceiling; it does not narrow it to the operation's actions.

`readAuthConsentConfig(env)` in `auth-consent.ts` owns the shared configuration for every module that restores an initiator: `KERNEL_AUTH_CONSENT_URL`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The group is optional and all or nothing. The URL must be the exact private HTTPS `/internal/v1/consents:read` endpoint, without credentials, query or fragment. Values retain the visible-ASCII limit of 1024 characters. A partial or invalid group fails startup with a variable name, never its value. Content erasure and the Realm adapter use this same Access reader; the worker reports the consent group when absent.

Successful restoration publishes rate identity from its existing anchored account
facts: route, creation time, private tier and operator. It applies authentication's
class rules at this step's T, valid only through this step's deadline.
A denied restore publishes no rate identity. A chunk then uses `spendChunk` in
command preparation as described above; a refused chunk sleeps durably before
restoring and retrying its unchanged index.

`createInitiatorRestorer({pool,access,readOperation,readConsent})` restores a genuine native account identity for a later person-attributed action. `readConsent` is mandatory trusted server composition using `createAuthConsentReader` from `auth-consent.ts`: the Auth-owned private listener, its exact HTTPS Tunnel/Access URL and service token configuration stay at their respective homes. Kernel receives current consent facts through that authenticated channel, never an Auth pool, signing key, cookie or runtime. The reader checks the exact actor/client consent, current client ceiling/readiness/reduction and the selected consent's pending restriction on every invocation. No epoch-only fallback exists.

The owning module implements `DurableInitiatorReader` against its own immutable committed operation and source. The complete exported contract, including all required creation evidence, is in `durable-initiator.ts`; there is no domain SQL in this helper. The native creator records the original actor and scope ceiling, account floor/operator snapshot, exact original delegation creation, immutable source/target digest, transaction and creation receipt locator/digest. Its actual command response commits a canonical digest of the entire allowlisted record. Both the reader and common helper verify the exact native receipt at its primary key, never search receipt history or accept a copied tuple/transaction/source. Missing evidence fails closed; a receipt supplies provenance, never permanent authorization.

Call `restoreInitiator({operation:{route,id,kind,sourceId},action,anchor,context}, attempt.time)` inside `CommandAuthorization.prepare`, before target checkout, for **every** step, retry and receipt replay. Independently validate the actual authority anchor at that same live `CommandAttempt.time`. The returned actor carries only the intersection of recorded scopes and current Auth scopes. Current floor/operator must equal the immutable original snapshot, even when the token epoch is higher; suspended, deleted or fenced accounts deny. Exact delegation creation and validity, current principal, matched memberships, both grant operands and explicit denials remain inputs to the installed native formula. Scopes do not grant permission. The existing anonymous/public floor and named denials retain their native meaning; this adds no person-action anonymous exception.

The private instance/pool-bound identity proof is consumed once and bounded to the action, operation, resource, context, live time and native evidence deadline. The returned actor may serve same-attempt final exact-target formula checks, with evidence prepared before target checkout. It cannot authorize another attempt or action, and a spread/JSON copy carries no identity. Readers release their connections before consulting the next anchor; distinct operation, account, principal, group and target partitions work with a max-one pool. Original bearer expiry alone does not revoke an otherwise currently authorized operation. The separate workflow approval bridge retains its carried JWT expiry and provenance checks.

Mechanically completing an already committed platform decision—URL fetch, Sharp transcode of reserved media, physical erasure cleanup or derived projection maintenance—does **not** restore the initiator. Publication and download fences remain owned by those domains. A new person-attributed action, including each later post erase or publishing for someone, **does** restore and authorize that person at the step's current time. This distinction follows the authority of the particular action, not a blanket always-restore or never-restore rule.

## Membership work

`createMembershipWorkPorts` accepts an installed `RealmMembershipCommands` port from the owning Realm module. When the principal kind is `realm`, the enqueue check and the later publication step both call that port's `authorize`, and reserve, publication and terminalization call the port's commands. Organization creation and organization membership keep the supplied authorizer, or the native approval resolver when none was supplied. A Realm principal stays on the Realm port. With no Realm port installed, Realm membership work throws `RealmMembershipUnavailableError` before any inverse, coordination or publication write.

An injected organization authorizer must return an identity authenticated by the same installed Access passed in
`options.access`, using the publication pool. A hand-built actor or the low-level permission evaluator cannot supply
command admission. Native concurrency fixtures use this same boundary so a refusal proves the membership guard,
rather than a missing Access registration.

Every contention retry admits the authenticated identity again and prepares permission evidence at its fresh command
time, under the original request deadline. A retry alone is never a denial. Changed identity or permission can still
deny; exhausted deadlines and unavailable evidence answer unavailable. The locked last-owner guard remains required
on every attempt.

## Resource denials

`recordResourceDenial` and `endResourceDenial` run inside the caller's command transaction. The transaction's own authorization must be execute mode for the same resource route and id, and `at` must be that attempt's authoritative time. Otherwise they throw `ResourceAccessWriteDeniedError` and write nothing. `reason` is `resource`, `suspension` or `realm_ban`. `action` matches the denial table's action pattern. `subjectRole` is empty, so the row is one direct identity denial. `record` opens `[T, infinity)` and leaves a key that is already open at T unchanged. `end` sets that open row's upper bound to T and leaves the table unchanged when no open row contains T. A row whose lower bound is already T cannot be closed to an empty range, so that call throws and writes nothing. One key — resource, subject, action and reason — is one row. Community records `realm_ban` on the Realm resource for `realm:join` and `realm:participate`. From T the formula denies exactly that action; ending the row restores the underlying grant from the closing T.

## Grant subjects

A Realm owner or member is a `GrantSubject` `{ kind: 'realm', id, role }` with role `owner` or `member`. It is stored as an identity subject, which is the subject the formula matches through `realmRoleReader`. Production `createAccess` accepts an optional `realmRoleReader` and forwards it to that formula. The credential-floor permission instance keeps its own account evidence and has no Realm reader. `grantGroupRole` writes one `resource_role_grant` from the command's T under the same same-resource authorization rule, for principal `{ kind: 'realm', id }`, a membership role and one resource role. A key already open at T is left unchanged. A current member holds the resource role through that single grant. A former member, still present on the inverse, stops when the membership proof ends.

## Evaluator time

The kernel clock is domain time for domain rules and lifetimes the kernel issues itself. Bearer credentials are issued outside the kernel and their time claims use actual wall time, as do request and evidence budgets. An approval-restored identity keeps its kernel-time expiry, checked on the kernel clock at every use. When a bearer caps a kernel lifetime, Access carries the remaining wall duration into kernel time, sampling the target clock before the source clock.

Permission preparation and the final formula evaluate grant, assignment and membership validity at one instant T. Inside a command attempt, T is that attempt's authoritative time, minted from the kernel clock given to the executor. Outside a command, one time statement binds the clock configured on Access, with the same validation and ISO instant as command time. When Access has no clock, the bound parameter is empty and PostgreSQL `clock_timestamp()` supplies T.

The evidence deadline guards elapsed time on the database clock only. That time statement also returns PostgreSQL `clock_timestamp()` as `databaseAt`, and the deadline given to the formula is `databaseAt` plus the remaining request budget. The formula keeps `observed_at < deadline` and does not compare T with that deadline. In-process wall-clock deadline checks stay. The observed-at guard stays on PostgreSQL `clock_timestamp()`.

That read is still one statement per non-command check and returns one more column. Its bound is unchanged; `test/access/growth-permission.test.ts` covers the formula's cost.

### Resource pages

`resourceAuthorizationPage({access, actor, action, context, anchor})` authorizes one action for
an entire trusted anchor `{route, resourceType, ids, validate(client, time)}`. The owning module supplies
`validate`, which checks existence and domain prerequisites for the whole page in one statement at the
attempt's authoritative T. This callback never comes from request input.

A page contains 1–100 distinct UUIDs of one resource type and route. Construction rejects empty,
oversized, duplicate, malformed or mixed-route pages with `RangeError` before any statement. Access copies
and freezes the exact id set and resource type. Each attempt prepares actor, principal, membership,
delegation and client-scope evidence once, validates the page, then runs `permission-check.sql` once.
The same statement takes a singleton array for `checkPermission`, `accessCheck` and
`resourceAuthorization`; it returns one decision per id. Execution requires every decision to permit.
A denied member produces the ordinary `GrantDeniedError`, without identifying that member. Proofs stay
single-use and bind the action, actor, exact page, target partition, live attempt and evidence deadline.

For listed governance actions, the same formula statement evaluates the Global Context and uses its
result only for ordinarily denied members. A successful command records exactly those members through
one batched governance reach statement in its transaction. Validation and formula connections are released
before target checkout. Page authorization supplies no anonymous eligibility or creation capability.

### Explicit action decisions

`accessExplicitCheck(access, actor, action, resource, context)` prepares the installed Access port
through `accessRoot`, including for derived adapters, and returns a check yielding `{allowed, explicit}`.
`allowed` is the ordinary decision. `explicit` uses the same formula with the public floor off and no
resource grant roles; direct action grants, including grants to verified membership roles, still require
current actor, principal, delegation, client scope, temporal, fence and denial evidence. Missing explicit
support fails closed. Content uses this port to decide whether erased metadata may be disclosed.
Adapters must use this port rather than intercept SQL text or reconstruct the permission formula.

`Access.authorizeExplicit` also accepts a prepared homogeneous page; each returned field requires that
field's decision to hold for every id. The two fields are evaluated independently; callers must retain
their ordinary admission check when using the explicit decision to control disclosure.
`permission-check.sql` returns both fields per id and evaluates
its explicit branch only when requested and the authenticated scope permits it. Ordinary single and page
checks leave that branch disabled and read the same grant and denial keys as before.

## Account standing check

`accountStandingCheck(access, { accountId, action, target, context })` is exported from Access for kernel
modules sending notices after a write. It returns a frozen map of resource id to the ordinary boolean read
decision. The target is a resource or the same single-route page accepted by `preparePage` (1–100 ids).
Derived Access adapters resolve the installed root port.

The recipient is its own durable account principal, with no caller-selected client, scopes or delegation.
Access represents it internally as one frozen `AccountActor`: its account id, a module-constant client id
beginning with U+0000 (outside OAuth's VSCHAR client-id character set and rejected by PostgreSQL text),
frozen scopes containing every catalogue action, `requestedBy: null`, and the current `minimumAuthnEpoch`
(at least 1 and a safe integer). These neutral values make its decision equal to a first-party session
holding every scope. An account cannot acquire an organization's identity authority through this port.
Identity, organization and Realm roles, active-account grants, resource roles, domain eligibility, bans
and denials use `permission.ts` and `permission-check.sql`, with the same installed Realm role reader as
session checks. There is no parallel formula or additional evaluator principal type.

The port point-reads the account itself and denies suspended, fenced, pending, missing and tombstoned accounts,
as well as organization identities. It does not apply a credential authentication floor. A private WeakMap
binds that account evidence to the exact actor while the check runs, including nested checks through the main
Access from eligibility callbacks. Copies cannot borrow evidence; it is removed when the call finishes.
The actor is never returned or exported, and its impossible client id matches no command attempt basis.

Each call evaluates at its own current send time, never the post's or effect's earlier T. A grant revoked
before the call stops delivery. The effect's DBOS step records that outcome, so retry after success does not
re-evaluate. Inbox listing still rechecks every notice with the recipient's real bearer and scopes before
showing it; a scoped client therefore sees no extra content.

### Account standing check cost

- Touches: one account-state point read, the evaluator's existing bounded time, inverse and matching
  membership-role preparation reads, and one run of `permission-check.sql` for the resource or page on its
  target route. No assignment read runs. Public eligibility retains its owning domain's bounded reads.
- Bound: constant statements per check, O(log N) blocks for fixed admitted membership and target bounds,
  with N the grants, accounts and resources. Mention delivery calls it at most ten times per post.
- Growth check: `test/access/growth-account-standing-check.test.ts` grows grants, accounts and resources at
  three scales and checks constant statements and logarithmic blocks under the series rule for resources
  and route pages, including denials and inactive accounts.

## Read decisions

`prepareReadDecisions(access, { actor, actions: ReadonlySet<string>, context })` resolves the optional
`Access.prepareReadDecisions` port through `accessRoot`. Prepare once outside the page's snapshot for
1–64 catalogue actions. The frozen handle exposes only
`decide(client, { action, resourceType, ids, eligibility? }, time?)`, returning a frozen id-keyed record
of frozen `{ allowed, explicit }` decisions. It confers no command capability or proof.

Call `decide` inside the caller's REPEATABLE READ transaction, for 1–200 distinct routable UUIDs of one
resource type across routes in the same database. UUIDs encode routes, not resource types: the owning
reader supplies the homogeneous type and ids; structural mixed-type inputs are refused. Invalid actions,
empty, oversized, duplicate or malformed ids and invalid type declarations raise `RangeError` before I/O.
The trusted owner `eligibility(client, ids, at)` returns an id-keyed boolean record using rows already
read at that snapshot (zero statements) or one statement. It never comes from request input. Access
passes the formula's authoritative snapshot T to it. Only a catalogue action admitting anonymous
readers can use this floor. Explicit decisions always exclude the floor and resource grant roles.

One handle serves all prepared actions and batches until min(request deadline, preparation + 1 s),
using the unchanged evidence deadline policy and the verified identity lifetime. Callers do no waiting
between preparing and deciding; on retry they prepare afresh. Expiry or any failing dependency throws
Access unavailability (503 at the edge), with no partial result. Every decide probes current grant,
denial and delegation keys in that snapshot; preparation never captures resource grants. Global
governance reach is included without writing use records. Commands keep `resourceAuthorizationPage`.

### Read decisions: prepare

- Touches: actor/principal inverse entries (at most 1,000 per identity), at most one principal assignment,
  all admitted organization role proofs in one statement, and at most one trusted batched Realm reader
  call (`realmRoleReader.batch`), installed by the native kernel Realm adapter. A custom Realm adapter
  without that batch reader is unavailable for these reads.
- Bound: **E ≤ 6 statements**, a constant for the whole action set. The implementation uses one time
  statement, at most one inverse, one assignment, one organization batch and one Realm batch (at most 5).
  Rows O(J), J ≤ 2,000 admitted pairs; blocks O(J log N), logarithmic in stored ACL/history at fixed J.

### Read decisions: decide

- Touches: exact grant, role-grant and denial keys for the ids and prepared identities/role proofs;
  the owner's eligibility rows. Resource probes run only in `permission-check.sql`.
- Bound: **at most 2 statements**, a constant: one formula plus zero or one eligibility statement.
  Rows O(ids × prepared keys) probes and O(ids) results; blocks logarithmic per probe.
- Growth check: `test/access/growth-read-decisions.test.ts`.

## Erasure consumers

### Shared-history acknowledgement

Accounts owns the shared-history participant that minimizes command receipts and outbox events and removes durable
work. Its final acknowledgement occurs only after every sealed locator page across all 4,096 partitions is covered,
all applicable artifacts are minimized or removed, and registered locator effects have completed under the
coordinator's open locator-work rule. It reports `erased` if any artifact ever applied; `none` is valid only after
complete sealed coverage and proof that zero artifacts applied. Missing coverage, pending effects, an incomplete
page or failed removal keeps acknowledgement pending and erasure incomplete; none is never inferred from an empty
page or a missing DBOS row. This shared-history acknowledgement path remains an open runtime gap.

Shared-history cleanup covers operational receipts, event payloads and durable execution copies. It does not erase
semantic provenance, whose owner retains its own attribution and evidence contract, or delivery custody for content,
media storage and caches, which remains the delivery-custody participant's responsibility.

Every deletion of an active account commits exactly one `com.rezics.access.account-tombstoned.v1` event,
with `data.accountId`, in the deletion barrier's transaction envelope. This covers person deletion with or
without a committed continuation, automated-account deletion by the operator's manager, and organization close.
Registration expiry deletes only pending accounts, which cannot create consumer state.

Modules that retain per-account data register a durable effect on this event through
[`registerEffects`](../events/effects.ts), using the account id to start their own purge. Work modules contribute
effects through `context.addEffects`. The existing consumers in [Rating eligibility](../rating/eligibility.ts)
and [organization close](organization-close-work.ts) show the pattern: persist progress
and schedule bounded steps with stable workflow identities. Access never calls an owner's purge code.

The barrier also inserts one `access.erasure` row in the account's partition with T and the current participant
list version. Only the tombstone transaction creates this row. `ERASURE_PARTICIPANTS` is an immutable map of
versions to participant ids; version 1 contains `access`, `auth`, `library`, `commerce`, `content`, `community`,
`semantic`, `search`, `imports`, `shared-history` and `delivery`. Add a new entry for a new version; never modify a
recorded version's list.

Every listed owner registers an effect, including an owner with no per-account data. After its final purge step
has committed, the owner calls `acknowledgeErasure({ pool }, { accountId, participant, outcome })` in a separate
command transaction in the account's partition: `erased` attests to actual cleanup and `none` attests that no data
applies. This mechanical work runs as the platform and restores no initiator. New acknowledgements use the existing
`account-updated` event; there is no new event type. Dispatch success is not completion.

Only `erased` may name optional `retained` exceptions, at most 16, each with `store`, `fields`, `purpose` and
`expiresAt: Date`. Store and field identifiers match `[A-Za-z_][A-Za-z0-9_]{0,63}`; each exception names 1 to 32
fields, a purpose of 1 to 200 characters and a known expiry strictly after T. Store names are unique within
an acknowledgement. A participant without a decided expiry stays pending. Exception and field order do not affect
identity. Each participant's acknowledgement is immutable: the same outcome and exceptions do nothing; any
difference, unknown participant or missing erasure is refused.

The owner names exceptions in its acknowledgement and retention inventory, purges each store at expiry, then calls
`resolveRetention({ pool }, { accountId, participant, store })` as its own command transaction after that purge
commits. Resolution records one time, requires expiry to have arrived, is idempotent, and refuses an unknown erasure,
participant or store. Like acknowledgement, it runs as the platform and restores no initiator.

The terminal `access.erasure` workflow is started by the tombstone effect and retries completion durably until
all participants acknowledge, no late item is open, the effects frontier has passed, and no pre-T locator work is open. Acknowledgement alone
never marks completion. `completedAt` means active cleanup complete even when retention remains. The minimal
PostgreSQL record is independent of DBOS history and command receipts and never reopens on event replay.

`recordLateErasureItem(tx, { accountId, participant, locator })` runs inside the live command transaction in the
account's home that holds the participant's locator fence. The participant must belong to the recorded version.
The opaque locator is 1–255 printable ASCII characters, ids only and never personal data. Insertion is idempotent
on account, participant and locator, including an already resolved item. After the copy's minimization or purge
commits, the effect calls `resolveLateErasureItem({ pool }, { accountId, participant, locator })` as internal platform
work. Resolution is idempotent, refuses an unknown item, and restores no initiator. Both interfaces refuse an
account without an erasure record. Participants close their fence before paging and acknowledge once every located
item is handled; each effect reaching a closed fence handles its own copy through these interfaces.

Register locator effect names in `ERASURE_LOCATOR_EFFECTS`, beside `ERASURE_PARTICIPANTS`. The effects relay routes
only those effects to `locator-effects`, with the effects queue's concurrency options including
`partitionConcurrency: 1`. Workflow ids, partition keys, ordering and effect-run retries remain the same.

In its first durable step after T, the coordinator reads the fixed partition map and effects checkpoints in one
statement, storing only heads ahead of their checkpoint. Each retry probes those exact checkpoint keys. After all
reach their stored positions, it freezes a database millisecond timestamp marking delivery. It never scans outbox
history or polls from a request.

The relay commits one `access.erasure_locator_work` row per registered locator effect run before enqueueing any
workflow in its batch. Deterministic workflow ids and `ON CONFLICT DO NOTHING` preserve done/resolved rows on replay.
The source key is the outbox envelope's authoritative `recorded_at` (CloudEvent `time`), compared at full PostgreSQL
precision to the tombstone's `at`, inclusively. The delivered checkpoint frontier remains a delivery barrier;
`workflow_until` records that barrier passing, not a cutoff for source work. Completion and status probe only the
partial index of open source times at or before T, never DBOS history. Later traffic cannot hold the erasure.

After `effect.run` succeeds, the durable `effect.locator.done` step marks only its own workflow id done. Failures,
cancellation, exhausted recovery and retention leave the row open, holding every subsequent erasure because custody
is unknown. Resuming a cancelled/exhausted run can succeed under its own id; SDK 5.4.6 resume leaves ERROR and SUCCESS
unchanged. A successful fork cannot clear its origin. After the owner handles the copy, platform work may call
`resolveLocatorWork` inside a live command that emits its own event; its callback records the executor-minted
resolution transaction id atomically with that command. Kept rows contain no workflow inputs or event data.
`readErasureStatus` reports this condition through `outstanding.effectsFrontier` and keeps `state` pending.
Each relay batch adds one multi-row insert only if it includes locator effects; successful locator work adds one
primary-key update. The open-work probe has constant statements/rows and logarithmic blocks as kept rows grow.

Internal/test-only `readErasureStatus(client, accountId)` returns version, T, `completedAt`, participant outcomes
and retained exceptions with `resolvedAt` and `overdue`. `outstanding.lateItems` and
`outstanding.effectsFrontier` report unresolved work without exposing locators. `state` stays `pending` until
active cleanup completes, then `retention-outstanding` while exceptions remain unresolved, then `complete`.
It returns null for a missing erasure and has no HTTP route. Backup expiry remains an open external condition.

- Each purge is idempotent and bounded per step, so durable retries and replay are safe.
- Deletion never waits for consumers. Authority ends at T; consumer data goes asynchronously and durably.
- Each consumer lists its purge, trigger and retained data in its owner's retention inventory.
- Before creating per-account state, an owner command calls [`shareAccount(tx, accountId)`](account-share.ts)
  inside its own command transaction. It returns `'active'` or throws `LifecycleDeniedError` for a pending,
  suspended, fenced, deleted or missing account. It also refuses use outside a live command transaction.

`shareAccount` holds the account row `FOR SHARE` until the caller commits or rolls back. Tombstone locks that
same row `FOR UPDATE`, so a deletion starting during the command waits for its commit. A purge following the
barrier therefore sees the command's committed state. A command starting after deletion commits sees the
deleted account and refuses. The share lock supplements the owner's normal command authorization.

[`pageActiveAccounts(client, { afterRoute, afterAccountId, limit })`](active-account-page.ts) is an internal deployment
surface for repairs such as the Library counter rebuild with `--all`. It returns only `{ route, accountId }` for active,
unfenced accounts in `(route, account_id)` order, strictly after the cursor, with an integer limit from 1 through 100.
Start at route 0 and the zero UUID; release the caller's client between pages and re-check each account with
`shareAccount` inside the owner's command. Enumeration confers no command authority and has no route or action.

## Cost

- Touches: The same admission and permission statements on each attempt; retry adds no statement to an attempt.
- Bound: O(attempts) per request, with attempts bounded by the request deadline.
- Growth check: `test/access/growth-commands.test.ts`, `Membership change stays within its bound as m grows`.

### Internal action composition

- Touches: a fixed set of catalogue entries added once at composition, alongside the existing route catalogue snapshot.
- Bound: O(1) per composition for the internal set; no per-request work.
- Growth check: not applicable; composition-time constant set.

### Erasure record at tombstone

- Touches: one insert in the account's partition inside the existing tombstone transaction.
- Bound: one statement, one row; the tombstone's existing bound plus O(log A).
- Growth check: `test/access/growth-commands.test.ts`, "Tombstone erasure stays within its bound as m grows",
  including the added statement.

### Erasure acknowledgement

- Touches: one point read locking the erasure row, one keyed insert of the acknowledgement with at most 16
  exceptions (or lookup of the immutable existing acknowledgement), and at most one completion update in the
  account's partition, counting at most P acknowledgements.
- Bound: O(P + X + log A), P the version's participant count and X ≤ 16 the exception count. A duplicate uses the
  command's no-effect fence without advancing history.
- Growth check: `test/access/growth-erasure-coordinator.test.ts`, accounts, completed erasures and other accounts'
  exceptions at three scales; statements and rows per acknowledgement stay constant.

### Retention resolution

- Touches: one keyed point update in the account's partition; its statement locks that acknowledgement and returns
  the existing resolution on replay without writing it again.
- Bound: O(log A), with at most 16 exceptions in the acknowledgement.
- Growth check: `test/access/growth-erasure-coordinator.test.ts`, the same three scales; statements and rows stay constant.

### Erasure status read

- Touches: one statement reads the erasure record, at most P acknowledgements and their exceptions in one snapshot,
  and probes the open-late-item partial index. An unfinished erasure with a delivered frontier adds one open locator-work
  existence probe bounded by T; completed erasures need no locator-work lookup.
- Bound: at most two statements; O(P·X + log A + log W), W the open locator-work rows. Neither outbox nor DBOS history is read.
- Growth check: `test/access/growth-erasure-coordinator.test.ts`, the same three scales; statements and rows stay constant.

### Record or resolve a late erasure item

- Touches: one primary-key erasure probe and one primary-key late-item insert or update in the account's home;
  recording shares the caller's locator transaction, resolution uses one platform command.
- Bound: constant statements and rows; logarithmic blocks as unrelated accounts, erasures and late items grow.
- Growth check: `test/access/growth-erasure-coordinator.test.ts`, fixed record and resolve keys at three scales.

### Advance erasure completion

- Touches: one locked erasure key; once per erasure, one frontier snapshot statement over the fixed partition map;
  one keyed checkpoint probe per stored frontier partition; one open locator-work existence probe through
  `erasure_locator_work_open`; one open-late-item existence probe and the bounded acknowledgement count.
- Bound: constant statements and rows in account data and unrelated history; logarithmic blocks. The snapshot and
  stored frontier are bounded by the fixed partition map; open locator work uses one indexed probe.
- Growth check: `test/access/growth-erasure-coordinator.test.ts`, fixed undelivered, locator and late-item frontiers
  as outbox history, unrelated workflows, erasures and late items grow through three scales.

### Active account page

- Touches: one range read on `account_active_pages`, from the cursor, up to the limit; no heap row is read for a
  row it skips. The unchanged account agent backfill query uses the same partial index.
- Bound: constant statements; at most 100 rows; buffers logarithmic in active accounts plus the page.
- Growth check: `test/access/growth-active-account-page.test.ts`, "active account page reads stay bounded as inactive
  accounts grow".

### Close an organization

- Touches: the organization's account, hold and saturated owner reads, the actor's exact owner membership and one
  cleanup checkpoint, all anchored in the organization's partition. No member enumeration.
- Bound: constant rows and statements, independent of member count; indexed probes use logarithmic buffers.
- Growth check: `test/access/growth-organization-close.test.ts`, at `[256, 1024, 4096]` with a warm-up, growing both
  this organization's members and unrelated organizations' members in `grow`.

### Organization cleanup step

- Touches: at most 100 membership rows after the saved key cursor and their exact reservation slots and inverse
  rows. Inverse releases lock only each affected member's anchor and remove only this organization's reservation.
- Bound: O(batch) rows and statements per step; O(members / batch) steps, with a final empty step when the count is
  an exact multiple of 100. A step is independent of other organizations and completed history.
- Growth check: `test/access/growth-organization-close.test.ts`, one fixed-batch step as membership grows at
  `[256, 1024, 4096]`, with a warm-up.

### Page authorization

- Touches: actor evidence once, as for a single check; one owning-module page validation statement; one formula statement over at most 100 exact grant, role-grant and denial keys per admitted subject; one governance reach record statement when reach is used. Membership anchors are deduplicated across the page.
- Bound: `O((1 + K) log G + P log R)` with page size `P <= 100` and the existing admitted-key and catalogue caps; statement count is independent of page size for fixed actor evidence. Per id, each key matches at most one current grant and three denial reasons. No ACL enumeration.
- Growth check: `test/access/growth-resource-authorization-page.test.ts`, two `checkGrowth` series at [1, 8, 64] with warm-ups: growing page size, including the explicit operand, has constant statements and linear rows; growing unrelated accounts, grants and resources at fixed page size has constant rows/statements and logarithmic buffers.

### Platform governance reach

- Touches: preparation probes the page and the Global Context on separately anchored reads, as for a single check. The sole formula statement includes one exact Global Context candidate for a listed action and uses it only when the requested resource denies. That statement documents its partition-binding exemption: the requested single-route page and the fixed Global Context must be decided together at T. A command authorized through Global adds one Access record row per reached resource in one statement.
- Bound: `O((1 + K) log G)` added, the same shape as `gate:any`, independent of the requested resource, other resources and other grants.
- Growth check: `test/access/growth-governance-reach.test.ts` at [1, 8, 64], growing unrelated resources, their grants and Global grants to other accounts; default warm-up; constant rows and statements, logarithmic buffers.

### Rate tier

- Touches: one governance check on the Global Context, the receipt, one locked account row and its operator relation.
- Bound: `O(log R)` per statement, a fixed number of statements, independent of other accounts.
- Growth check: `test/access/growth-rate-tier.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts and operated accounts; warm-up on a spare account; constant rows and statements, logarithmic buffers.

### Account graph agents

- Effect touches: one account point read by anchor, then one Semantic `ensureAccountAgent` command in the node's
  partition. Rows and statements are constant per event; blocks are logarithmic in accounts and subjects.
- Growth check: `test/access/growth-account-agent-effect.test.ts`, test
  `account agent effect growth stays within its bound at [256, 1024, 4096]`; it grows unrelated accounts and their
  graph nodes, uses a warm-up, and checks constant rows and statements with logarithmic blocks.
- Backfill touches one `(route, account_id)` keyset page per batch, then one ensure command per account. With page
  size 100 it is O(accounts) in total and runs only during deployment, never on a request path.

### Operator transfer

Touches: the source approval and optional destination acceptance, with receipts on the actors' anchors (one approval
row when a shared actor is authorized for both); per step two approval resolutions (each one anchored actor read and
one grant probe on an operator resource), plus point reads for the subject relation and destination eligibility; the
destination hold in the destination operator's partition; the relation, version and old slot on the subject; the old
hold on the source operator.

Bound: O(log R) per statement, a fixed number of statements, independent of how many accounts either operator holds.

Growth check: `test/access/growth-operator-transfer.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts
and both operators' other responsibilities with the transferred subject fixed; constant rows and statements,
logarithmic buffers.

These bounds follow the TypeScript adapters, their SQL, `db/access/migrations/` and `db/access/schema.sql`; measured shapes below refer to the integrated growth checks, not schema-only query-plan guarantees.
The criterion is a fixed number of anchored hops and results, with work proportional to changes times index depth, regardless of database size.
`A` is total accounts; `G` is stored grants and denials for one resource/action, including applicable role grants and temporal history; `O` is distinct organizations on that resource, including denial subjects; `R` is roles in a type's template; `Gt` is total grants and denials; `m` is members of one organization.
Additional sizes are `H` (all stored grant/role-grant/denial rows on that resource, across actions), `h` (stored membership intervals in one organization), `q` (intervals for one member overlapping `[at,infinity)`), `M` (membership intervals in total), `D` (assignments), `C` (coordination holds), `U` (handle claims), `F` (fence receipts), and `K` (membership slots).
Thus `G <= H <= Gt`, `m <= h`, and `q <= h`; these stored neighbourhoods have no enforced cap, but permission evaluation does not enumerate them.
`b` counts actions changed, `a` distinct actions authorized (management plus new/old actions), `d` is 0 or 1 principal assignment, and `k <= 2` is actor/principal identities needing membership evidence (automated identities are skipped).
`S` below is total stored data in the measured fixture (subjects/history, activity and media), and `c <= 16` is a creation manifest size. `J <= 1000k <= 2000` is their combined admitted inverse entries and `V <= J` the account/group pairs with a resource probe hit; each pair contributes two role keys, so serialized evidence is `O(J)`. Native account-locked admission enforces 1000 entries per account; the inverse proves admission, not membership roles.
`L(N) = O(log(2+N))` shared blocks for a B-tree probe, with constant rows for a unique key; a batch of `x` point mutations costs `O(x L(N))` blocks.
Unless named otherwise, indexes below are the relation's `_pkey`: ordinary keys are B-trees; `organization_member`, `resource_grant`, `resource_role_grant` and `resource_denial` have temporal `WITHOUT OVERLAPS` GiST keys.
Exact permission probes fix resource, subject, action/role and time: at most one current grant per key and three denial reasons, using grant/role-grant primary keys and `resource_denial_permission`; unrelated actions and historical intervals are not resource-prefix candidates.
`I_T(x)` denotes temporal indexed work for `x` qualifying/rechecked rows, including overlap checks on writes; selective traversal is ordinarily about `L(T)+x`, but an unmeasured GiST path has no B-tree worst-case guarantee from schema alone (conservatively `O(T+x)`). Measured paths state their observed growth shape instead.
`P` denotes preparation and `Q` the final formula: for fixed catalogue, authenticated `P+Q` reads `O(1+J+V)` rows in `O(1+k+V)` statements, with measured logarithmic blocks in stored ACL/history size at fixed J and at most linear work in J through its cap. Trusted catalogue role expansion scales with R; external eligibility, Realm and resource validation ports add their own costs.
Counts are Access SQL statements on a successful attempt, excluding the shared command envelope: a constant number of transaction, time, receipt and fence statements, a point receipt read, one partition counter update and constant outbox/write-basis/receipt inserts in the command's partition.
The command admission row adds one acting-account read per authenticated attempt to these bounds, once outside any action multiplier `a`; anonymous attempts add no actor read.
Retries and receipt replays also pay that fresh attempt read; action checks share it only within the same attempt. Retries repeat preparation and the shared envelope costs; contention retries continue until the command deadline with full-jitter backoff capped at `min(100, 5 × 2^attempt)` ms, behind a process-local per-pool, per-partition FIFO gate with at most 64 waiters, a grant uniqueness/exclusion conflict can invoke a second executor, and fenced-partition polling is deadline-dependent rather than a size-dependent scan.
Realm membership port dispatch adds no query. Each denial write and each Realm group-grant write probes the base range with `upper_inf(valid)` and `valid @> T`, then inserts or updates at most one row. The partial open-key btree visits only an open row; when the planner selects a temporal GiST index, the range condition is part of the index probe and skips the key's closed intervals. The range condition used to be checked after a materialized candidate, so a GiST plan could scan every historical interval sharing the equality prefix. The end statement carries the same condition into its update. On insert, the temporal primary key still performs its exclusion check. The formula's denial and group probes are unchanged and keep their existing growth checks.

### Share an account row

- Touches: `shareAccount`: one account row by its primary key `(route, account_id)` in the account partition, held `FOR SHARE`; one statement.
- Bound: Constant rows and statements; blocks logarithmic in accounts.
- Growth check: No growth check needed beyond the point read. `test/access/erasure-consumer-contract.test.ts`: `shareAccount serializes account deletion with the owner command commit` covers locking.

### Account read and public projection

- Touches: `account-read.sql` / `account-public-read.sql`: 1 statement, 0–1 `account` rows via `account_pkey(route,account_id)` on the account partition; no writes. `account-organization-role.sql`: 1 statement, at most 1 current interval via `organization_member_pkey(route,organization,member,valid)` on the organization partition. Grow A and M, fixing the target and its intervals.
- Bound: Account: constant rows/statements, blocks `L(A)`; role: one current row and one statement via temporal GiST. Integrated reads measure constant rows/statements and logarithmic blocks at fixed target intervals; account projection has no directory scan.
- Growth check: `test/access/growth-commands.test.ts`: `Account read and public projection stays within its bound as A grows`

### Bearer verification

Bearer scope claims are bounded once at authenticator creation to 129 characters per distinct known scope (`openid`, `offline_access`, `media:complete` and every mounted action), defaulting to 12,900 characters without a catalogue, while each scope retains its 128-character limit and character rules.

- Touches: `actorOf` parses headers (absent header gives anonymous with no SQL); `authenticate.ts` locally verifies ES256 JWT and claims against JWKS, then performs the existing one acting-account point read (0–1 rows) via `account_pkey` on the account anchor; with `requested_by`, adds time plus 0–1 `principal_assignment` via its `(route,principal_id,request_id)` B-tree and 0–1 principal `account` via its key, both on the principal partition. Invalid bearer evidence retains HTTP 401. No writes. Grow A and D, fixing token, JWKS and identities.
- Bound: Constant rows; 1 or 3 SQL statements; blocks `L(A)+d(L(D)+L(A))`. Per-factory JWKS cache lasts 300 s, fetch timeout 2 s and request deadline apply; warm matching keys need no fetch, cold/expired/unknown keys can fetch (cooldown 0). JWT bytes and JWKS key count are additional input costs, not A-dependent; the adapter does not cap their raw sizes.
- Growth check: `test/access/growth-authenticate.test.ts`: `Bearer verification stays within its bound as A grows`

### Write rate admission

- Touches: `write-rate-stage.ts` runs after authentication/body validation and before effects. `write-rate-identity.ts` derives HMAC-SHA256 from the verified acting account (canonical account route; private tier/age from the existing authentication read), or canonical socket/trusted-proxy IP (IPv6 /64; digest-derived route). `write-rate.ts` selects the in-memory class/family budget. `write-rate-counter.sql` atomically upserts one unlogged `access.write_rate_counter` key via `write_rate_counter_pkey(route,identity_digest,family)`, resetting expired windows or charging all units. Ordinary writes spend 1; batches spend their total command count, 1–100, once. Missing deployment key or unavailable identity/storage returns 503; exhaustion returns 429 with Retry-After.
- Bound: One counter row and one SQL statement for admission or exhaustion, including first connection use; constant rows/statements and logarithmic blocks in stored counters at fixed units. No classification query, receipt, scan or cleanup on the request path. Identity hashing scales with identity input; budget lookup and validated command-array length lookup are constant. An opaque request charge prevents duplicate spending.
- Growth check: `test/access/growth-write-rate.test.ts`: `actual ordinary and batch100 admission use one point statement as unrelated and hot-scope counters grow` (`checkGrowth`). `test/access/write-rate-counter-cost.test.ts`: `one seed at three scales proves constant rows and one statement` (captured statement count and EXPLAIN at 1/8/64, without `checkGrowth`).

### Mounted write declarations

- Touches: `http/request.ts` snapshots mounted declarations once after composition in `MountedRouteCatalogue`, indexed by method and the native matched template. `http/app.ts` resolves one mounted route per request and shares it between authorization and `write-rate-stage.ts`; request body/headers cannot select declarations. No relation or SQL is needed for declaration resolution.
- Bound: Construction scales with mounted routes and native aliases. Each request uses one catalogue find with at most three Map probes (method, ALL, *), plus method/template key processing; no route scan or repeated hook/detail reads. Declaration resolution adds zero database rows/statements; integrated ordinary/batch100 admission retains one counter statement and logarithmic counter blocks as routes/background counters grow.
- Growth check: `test/access/growth-write-rate-route.test.ts`: `mounted declarations and one native counter statement stay bounded as routes and background rows grow` (`checkGrowth`, plus explicit one-find/one-spend and no repeated route/detail-read assertions).

### Write rate expiry

- Touches: `write-rate-expiry.ts` schedules one maintenance batch per minute for one admitted partition, rotating its 16 routes without draining backlog. Each effect locks one `core.partition` key FOR SHARE and checks local node/active ownership. `write-rate-expiry.sql` seeks `access.write_rate_counter` through `write_rate_counter_expiry(route,expires_at,identity_digest,family)` and `access.write_rate_chunk` through `write_rate_chunk_expiry(route,expires_at,identity_digest,operation_id,chunk_index)` for windows expired strictly more than 48 hours ago; counters consume the shared 1,000-row allowance first, and ordered selection uses FOR UPDATE SKIP LOCKED and exact locked ctid/key deletion. Growth tests: `test/access/write-rate-expiry.test.ts`; durable dispatch and contention checks: `test/access/write-rate-expiry-work.test.ts`.
- Bound: B <= 1000 deletions/results in one native statement; admitted effect adds one partition read plus BEGIN/COMMIT. At fixed B and no locks, constant rows/statements and logarithmic blocks in counter and chunk history; measured rows <= 2B. With X skipped locked candidates, examined rows include X (test: 2B+X); deletion cap does not cap skipped-key work. Backlog waits for a later tick; moved/fenced/nonlocal partitions do no expiry mutation.
- Growth check: `one native statement uses the route-led expiry index and remains bounded through common-seed growth` (`checkGrowth`); `each durable accounts tick admits one local batch, yields backlog and fences moved partitions`; `contention explicitly accounts for skipped index candidates while deletion stays admitted` (latter two: fixed bounds without `checkGrowth`).

### Permission preparation

- Touches: `createAccess.prepare` reuses only the genuine authenticated account snapshot for reads until `min(original request deadline, JWT expiry, authentication observation + 180 s)`. Commands first require the separate attempt admission below. It prepares the optional domain eligibility capability, reads that one bound time statement, and optionally joins one assignment/principal account on the principal anchor. `permission-inverse.sql` reads one coverage flag from the account-backed view and up to 1000 `membership_inverse` entries per non-automated identity via account/inverse B-tree keys. `permission-candidates.sql` performs exact temporal grant/role-grant/denial probes for those admitted keys, direct identities and active-accounts. Only V matching pairs cause independently released group-anchor reads: one organization account plus two current/next role proofs via membership GiST and `organization_member_next_role`; Realm uses the trusted reader. No writes.
- Bound: `P` excluding shared command admission: O(1+J+V) rows, `2+d+k+V` native statements; blocks measured logarithmic in G/history at fixed J, at most linear in J. Assignment adds `L(D)+L(A)`, inverse `O(k L(A)+J)`, matched organization reads `O(V(L(A)+L(M)))` on the measured path. Anonymous preparation reads the time statement only, plus external eligibility preparation; neither O nor q drives a loop. Evidence TTL: min(caller deadline, real time + 1 s); O(1), no extra reads.
- Growth check: `test/access/growth-permission.test.ts`: `Permission preparation stays within its bound as O grows` `test/access/access-deadlines.test.ts`.

### Command attempt admission

- Touches: `command-admission.ts`: each authenticated command attempt’s prepare adds exactly one independently anchored acting-account point read via `account_pkey(route,account_id)`, before resource connection checkout. The opaque observation is shared across all same-attempt action checks. Changed state, authentication fence, minimum authentication floor or operator identity denies, even when a changed floor remains below the token epoch; missing/mismatched identity also denies. Anonymous attempts add no actor read.
- Bound: Exactly 1 extra statement and 0–1 account rows per attempt, blocks `L(A)`; equivalently `O(log(N+U*t+M))` in total subjects/history, activity and media. Retries and receipt replays each pay the fresh read. Native 1/8/64 measurements assert one actor seek for generic and multi-action commands, with constant rows/statements and logarithmic blocks at fixed K=2, rather than one seek per action.
- Growth check: `test/access/growth-command-admission.test.ts`: exact `checkGrowth` names `generic command admission` and `multi-action command admission`; test titles `generic command admission adds one account seek per attempt at all three growth scales` and `multi-action command admission adds one account seek per attempt at all three growth scales`.

### Final permission check

- Touches: `permission-check.sql` re-probes the exact direct, active-accounts and admitted group role keys at evaluator T using grant/role-grant GiST primary keys and `resource_denial_permission`. Scope and optional principal grants intersect; denials and expired/missing group proofs fail closed. One result per requested id (one id for a single check), no writes or inverse/role rereads. The verified domain floor supplies public eligibility; anonymous input has no subject keys and does not scan denials.
- Bound: `Q`: one formula statement (plus time when not supplied and optional domain verifier); O(1+J) bounded probe rows, O(1) result. Integrated P+Q: constant rows/statements in G; blocks are the sum of independently indexed grant, role-grant and denial probes, with discrete index-depth transitions at fixed J; at most linear in admitted J through cap1000 per identity. Role expansion adds R-dependent probes, not H/O enumeration. Permission and operator evidence use the shared real-time TTL helper; elapsed evidence returns 503 without effects. No added reads.
- Touches: `permission-check.sql` re-probes the exact direct, active-accounts and admitted group role keys at evaluator T using `resource_grant_pkey_lookup`, the role-grant GiST primary key and `resource_denial_permission`. Scope and optional principal grants intersect; denials and expired/missing group proofs fail closed. One result per requested id (one id for a single check), no writes or inverse/role rereads. The verified domain floor supplies public eligibility; anonymous input has no subject keys and does not scan denials.
- Touches: `permission-check.sql` re-probes the exact direct, active-accounts and admitted group role keys at evaluator T using the grant/role-grant GiST primary keys and `resource_denial_permission`; Global grant reads use `resource_grant_pkey_lookup`. Scope and optional principal grants intersect; denials and expired/missing group proofs fail closed. One result per requested id (one id for a single check), no writes or inverse/role rereads. The verified domain floor supplies public eligibility; anonymous input has no subject keys and does not scan denials.
- Bound: `Q`: one formula statement (plus time when not supplied and optional domain verifier); O(1+J) bounded probe rows, O(1) result. Integrated P+Q: constant rows/statements in G, logarithmic blocks at fixed J; at most linear in admitted J through cap1000 per identity. Role expansion adds R-dependent probes, not H/O enumeration. Permission and operator evidence use the shared real-time TTL helper; elapsed evidence returns 503 without effects. No added reads.
- Growth check: `test/access/growth-evaluator.test.ts`: independent G and K checks, production pool, K through cap1000. `test/access/access-deadlines.test.ts`.

The Global grant B-tree companion orders subject kind/id/role, action and validity; its partial predicate fixes
route/resource, which are included for covering reads. Each probe binds the full key, seeks the greatest `valid <= [T,infinity)`, then checks
`valid @> T` after `LIMIT 1`. Two lexicographic bounds with the same subject/action prefix supply the exact B-tree start and stop keys; empty sorts below every stored nonempty range. Keeping that prefix in the bounds preserves the full index ordering for the predecessor seek. All stored finite starts are inclusive and intervals never overlap, so this
predecessor is the only range that could contain T, including unbounded endpoints. Gaps and exclusive ends
still deny. Neither other subjects/resources nor the key's expired/future intervals are enumerated. The same
probe is used in `permission-candidates.sql` and `governance-reach-candidates.sql`; the temporal primary key
continues to enforce integrity. `test/access/grant-key-lookup.test.ts` checks all three plans and temporal
boundaries against unrelated and exact-key history at 1/8/64. The partial index and explicit Global branch
leave other resources on their existing temporal probes.

### Generic / parent creation authorization

- Touches: `resource-authorization.ts` prepares actor/principal inverses and matched group proofs, validates the trusted authority existence/revision, then runs one Access formula at attempt T on one authority connection, released before target checkout. Fresh proof on every retry; authorization precedes replay. `parent-creation.ts` additionally binds the exact child UUID/partition and unique INSERT provenance, single-use initialization and manifest guard. Reads are the P/Q keys plus exact owning-module validation keys; no writes during authorization.
- Bound: `P+Q` plus shared command admission and the authority validation seek per attempt: measured constant rows/statements and logarithmic blocks in S at fixed J/output, with permission work at most linear in capped J and V. Target changes add their own indexed writes; creation adds an exact provenance seek per declared child. No ACL/history enumeration or held connection across anchors.
- Growth check: `test/access/growth-resource-authorization.test.ts`: composed stable tuple and creation commands at three scales

### Standing parent installation

- Touches: `standing-parent.ts` prepares/checks a supplied actions plus trusted authority and parent validation. `standing-parent-install.sql` inserts one `standing_parent_installation` via its B-tree key and b temporal `resource_grant` rows on the parent partition in one mutation statement. No recipient lookup; grow Gt and local ACL/history with fixed actions and authority.
- Bound: `a(P+Q)` plus authority/validator; 1+b written rows, one mutation statement; `L(N)+b I_Gt(1)` mutation blocks (N installation markers). Integrated fixed-action check measures constant rows/statements and logarithmic blocks. Uncapped action arrays scale with a/b; no O-candidate fan-out. Governance bootstrap uses its named 10 s job budget through `deadlineFor`; no added reads.
- Growth check: `test/access/growth-commands.test.ts`: `Standing parent installation stays within its bound as Gt grows` `test/access/access-deadlines.test.ts`.

### Creator grant initialization

`creationDeclares(tx, resource)` answers whether the live command declares that exact route and id for creation, solely to bind module data written in the same command to that resource; it reads no rows, issues no statements, grants nothing and is not a permission check.

- Touches: `creation-manifest.ts`, `parent-creation.ts`, `resource-initialization.ts/.sql`: one parent P/Q per attempt at T; a manifest binds c distinct new resources and their type/creator/provenance ports to the command. Each entry performs one exact provenance validation, then one SQL statement inserting one `resource_initialization` marker via its B-tree primary key and at most R owner/standing `resource_role_grant` rows via temporal GiST. Finalization checks at most 16 entries in memory; replay reauthorizes without initialization writes.
- Bound: Parent `P+Q` and validation, then c provenance reads and c initialization statements, O(c(1+R)) written rows. At fixed trusted template and c, integrated checks measure constant rows/statements and logarithmic blocks in S; initialization blocks `O(c L(S)+c R I_Gt(1))`. Work scales with changed resources and trusted template size; no finalization SQL or history enumeration.
- Growth check: `test/access/growth-creation-manifest.test.ts`: native creation/initialization/replay; background and k=1/8/16.

### Grant create/change/revoke

- Touches: `grant-command*.ts` prepares/checks a distinct management/new/old actions. `grant-create/change/revoke.sql` use exact subject/action/range temporal primary keys in `resource_grant`, inserting/deleting O(b) rows; `role-grant-mutate.sql` changes at most one old and one new role-grant after authorizing expanded actions. One resource-partition mutation statement, no recipient-account join. On the Global Context, each `gate:<group>` action may use one extra exact `gate:any` check instead of that action; `gate:any` stays exact.
- Bound: `a(P+Q)` plus O(b) mutated rows, one mutation statement and `O(b I_Gt(1))` mutation blocks; integrated fixed-action check measures constant rows/statements and logarithmic blocks as Gt grows. Work also scales with uncapped action arrays and catalogue expansion. The extra Global `gate:any` check is at most one per granted gate action, `O((1+K) log G)`, `K <= 1000`. Other actions are unchanged.
- Growth check: `test/access/growth-commands.test.ts`: `Grant create/change/revoke stays within its bound as Gt grows`

### Delegation create/revoke/read

- Touches: `delegation-*.sql` reads one principal account via `account_pkey` and reads/inserts/updates one assignment via `principal_assignment_pkey(route,principal_id,request_id)` on that same anchor. Identity trigger examines OLD/NEW only. Commands add one action P/Q; standalone `readAssignment` is one read statement with no writes.
- Bound: Commands `P+Q` plus constant account/assignment rows and one mutation statement; standalone read is one statement. Point blocks `L(A)+L(D)`; integrated commands measure constant rows/statements and logarithmic blocks at fixed permission neighbourhood.
- Growth check: `test/access/growth-commands.test.ts`: `Delegation create/revoke/read stays within its bound as A grows`

### Account and organization creation

- Touches: `lifecycle.ts`: pending actor reads one handle by `handle_claim_pkey` on its handle anchor, then inserts one account and two default grants in two statements on the account anchor; activation updates one account. Account insertion initializes inverse coverage on that row. Organization creation reads exact inverse/hold/account reservation evidence on the owner anchor, then inserts one account, upserts one slot, closes only owner intervals overlapping `[T,infinity)`, inserts one membership and three grants in four statements. A fresh organization has no previous intervals.
- Bound: Actor: constant rows, three statements, blocks `L(U)+L(A)+2 I_Gt(1)`; activation one statement, `L(A)`. Organization: constant rows, five statements, blocks `L(C)+L(A)+L(K)+I_M(1)+3 I_Gt(1)` plus exact owner inverse seek. Integrated creation check measures constant rows/statements and logarithmic blocks; no history deletion or member-total scan.
- Growth check: `test/access/growth-commands.test.ts`: `Account and organization creation stays within its bound as A grows`

### Handle reserve/change/resolve/expire

- Touches: `lifecycle-handle-*.sql`: reserve upserts, claim/redirect update, resolve reads one `handle_claim`; expiry deletes only an expired ordinary pending claim and preserves former-handle claims. Rename publication changes one new claim, one former claim and the account row; the deletion handle step changes only the current claim. Each is a constant number of point statements independent of rename history. Grow U/A, fixing spelling, account and reservation.
- Bound: Constant rows/statements, blocks `L(U)` plus `L(A)` for claim; registration, claiming, account activation and redirect are separate commits, not a cross-partition transaction.
- Growth check: `test/access/growth-commands.test.ts`: `Handle reserve/change/resolve/expire stays within its bound as A grows`; `test/access/growth-handle-retirement.test.ts` covers forwarding, rename and deletion at [256, 1024, 4096] with a warm-up.

### Account update, coordination and fences

- Touches: Public update: P, boundary Q, lock one account, Q, update one account, Q (two body statements plus three Q). Coordination reserve locks one account and inserts one hold via `lifecycle_coordination_pkey` (two statements); membership admission also point-locks/updates the account inverse count and inserts its exact inverse key under the 1000 cap. Raise fence locks account then updates it/inserts one fence receipt (two statements); clear updates one account; fence state/receipt reads are one point statement each. All native body work stays on the account anchor.
- Bound: Update `P+3Q` plus constant rows, `L(A)` body blocks; coordination/fence point blocks `L(A)+L(C)+L(F)` as applicable, plus exact inverse work for membership admission. Integrated check measures constant rows/statements and logarithmic blocks. Triggers use row-local checks or indexed EXISTS, not hold enumeration. Native workflow boundaries and continuation resume use `deadlineFor` with the named 10 s continuation budget; no added reads.
- Growth check: `test/access/growth-commands.test.ts`: `Account update, coordination and fences stays within its bound as A grows` `test/access/access-deadlines.test.ts`.
  `test/access/account-profile-http.test.ts` measures one HTTP profile update, including its avatar check and display-name event,
  at three account scales: constant statements and rows, logarithmic blocks.

### Membership change

- Touches: Read exact member inverse/hold/account reservation evidence on the member anchor, then P; on the organization anchor: boundary Q, lock one account, Q, `lifecycle-owners.sql` seeks at most two current owners through partial `organization_member_owner_probe` and one exact current target through membership GiST. Upsert one slot via its primary key (and `lifecycle_membership_live` uniqueness), close only q target intervals overlapping `[T,infinity)` via temporal GiST, optionally insert one ongoing membership, Q. Past intervals are retained: truncate the crossing interval at T and delete scheduled intervals starting at/after T. Worker deadline: named `MEMBERSHIP_WORK_DEADLINE_MS` (30 s) through `deadlineFor`; no added reads. `test/access/access-deadlines.test.ts` covers job budgets.
- Bound: `P+3Q`; constant reservation/account/slot rows and at most three owner-probe rows, q changed intervals plus at most one insert. Three–four body statements plus one reservation statement; the closure function performs q cursor mutations internally. Measured constant rows/statements and logarithmic blocks as expired history/background grow at fixed q; work is proportional to actual q changes, not h or m. Native writes admit one ongoing interval; imported future intervals can make q uncapped.
- Growth check: `test/access/growth-commands.test.ts`: `Membership change stays within its bound as m grows`; `test/access/owner-cost.test.ts`: `the real owner guard has constant examined rows and logarithmic buffers at three scales`; `test/access/membership-history-cost.test.ts`: `keep actual membership mutation rows fixed as expired history and background grow` (each member and role variant)

### Tombstone erasure

- Touches: P for delete and possible self-read replay fallback; a deleted subject with a matching command receipt additionally resolves its prior operator from that receipt's transaction and its tombstone fence receipt, through the shared approval query; boundary Q (fallback Q only after denial), lock one account, Q, indexed EXISTS in `lifecycle_coordination` via `(route,account_id)`, organization-only saturated owner/target probes as above, scrub/fence update, at most one preference row erased by `(route,account_id)` in the same statement, and one fence receipt, Q. Body relations stay on the target anchor; grants, assignments, membership history, handles and coordination facts are retained. A caller who still holds `account:manage` on the recorded prior operator may replay that exact command; a different key still requires `account:delete` on the subject.
- Bound: Up to `2P+4Q`; constant rows, including at most three organization owner-probe rows; three actor or four organization body statements. Point blocks `L(A)+L(C)+L(F)` plus the preference primary-key seek and owner seeks. Integrated tombstone and owner checks measure constant examined rows and logarithmic buffers as m/history grow. No organization count or erasure fan-out across Gt.
- Growth check: `test/access/growth-commands.test.ts`: `Tombstone erasure stays within its bound as m grows`; `test/access/owner-cost.test.ts`: `the real owner guard has constant examined rows and logarithmic buffers at three scales`

### Operator responsibility list

- Touches: One `readPartition` point read on the operator anchor plus one `operator-page.sql` keyset seek through `lifecycle_coordination_purpose_page(route,account_id,purpose,reservation_id)`. Equality predicates select route/operator/purpose before the reservation range and ordering; at most `limit+1 <= 101` rows, including pending holds.
- Bound: With total stored data S, `O(log S + limit)` rows/index work, `O(1)` epoch read, fixed bounded cursor payload validation/hashing; 2 data statements plus BEGIN/COMMIT. No OFFSET, count, unrelated-account enumeration or all-page fetch.
- Growth check: `test/access/growth-operator-cursor.test.ts`: first and late fixed-20 pages at three scales.

### Provisioning proof

- Touches: `createRegistrationProofBindings({pool,referenceKeys: KeyRing})`: `createProvisioningReference({input,outcome})` takes the exact `createPending` input `{accountId,key,handle,reservationId}` and awaited native `CommandOutcome`; `verifyProvisioningReceipt(reference)` verifies one core receipt via the trusted reader. Fixed internal principal, `access.actor-pending`, derived partition and route-prefixed key; digest, transaction, epoch/position and response must agree. `registration-proof-account.sql` binds the pending actor, handle, reservation, expiry and creation transaction, enforcing expiry at PostgreSQL time regardless of cleanup.
- Bound: In stored data S: constant rows/statements, `O(log S)` buffers; at most 1 receipt, 1 account and 1 partition epoch/fence read. 3 data statements plus BEGIN/COMMIT; invalid keys/digests stop earlier. Seal input/output <=4096 chars. References confer no Auth authority/completion; no registry or Auth credential read.
- Growth check: `test/access/growth-registration-proof.test.ts`: valid/invalid, same-account history, unrelated accounts, 1/8/64.

### Native Auth barriers

- Touches: `createAuthBarrierCapabilities`: host-owned Auth proof resolution before mutation and at each command attempt; native account lock, exact expected-floor compare/update and one `lifecycle_fence_receipt` insertion in `auth-barriers-advance.sql`. Exact `core.receipt` identity handles retry; committed fence receipt and account state are point reads on the same account anchor.
- Bound: In stored data S, fixed effect size: O(1) rows/statements and O(log S) buffers per attempt, plus one anchored receipt read to confirm and one update to complete; retry bounded by the existing command deadline. No session/recovery/receipt/account enumeration; Auth effects retain their separate session cap/GC bounds. Credential-floor commands use `deadlineFor` with a named 3 s fallback; request work retains its deadline. No added reads.
- Growth check: `test/access/growth-auth-barriers.test.ts`: same-account history and unrelated accounts, 1/8/64. `test/access/access-deadlines.test.ts`.

### Operator session capability

- Touches: `createOperatorSessionCapability({pool,access,operators,referenceKeys,accessTokenForProof})`: installed Access, native commands and live `AuthService.internal.accessTokenForProof` closure. `createOpeningReference(opening)` seals only the committed `{operatorAccountId,subjectAccountId,receiptId}` locator. Bind `consumeAuthAuthorization` into `createAuthBindings`: live human JWT → Access/JWKS → native `consumeOpening`, key `auth-session:<receiptId>` and native digest. Exact proof/scope, purpose, relation, epochs, expiry and current authority apply; receipt/expiry come from consumed opening, unchanged floor from current subject. Credentials use the Credential capability row below.
- Bound: In stored data S: fixed evidence and exact opening/receipt; existing `P+Q`, J<=2000. Constant rows/statements, logarithmic buffers at fixed J/output. No responsibility/history scan; Auth owns single-use receipts and 64-session cap. Replay/lost acknowledgement denies without renewal. Keys<=3; local JWT/JWKS cache. `deadlineFor` retains the request deadline, with a named 3 s fallback outside requests; no added reads.
- Growth check: `test/access/growth-auth-session-capability.test.ts`: real Auth/JWT, invalid/replay, fixed K/output, 1/8/64. `test/access/access-deadlines.test.ts`.

### Credential capability

- Touches: `createCredentialCapability`: verify the Auth stage through its trusted point-read closure; narrow one native operator credential-management opening to one purpose, operation key and Auth reference/digest. Own-person approval requires account:manage on that account through the installed formula and a 60 s one-use workflow approval, capped by bearer expiry. Consume and commit revalidation check current authority, relation, floors and exact binding. The credential floor hook binds the consumed opening and expected previous floor, advances once with the fence preserved and returns a committed receipt. Grow dimension=consumed-openings, other-approvals, old-auth-effects or unrelated-owners independently at 1x/8x/64x; fix subject, human and permission neighborhood.
- Bound: In stored data S: fixed selected rows/statements plus existing P+Q, J<=2000; logarithmic buffers at fixed J/output. One opening/approval CAS; destructive effects add one subject floor CAS and one credential_floor_receipt insert, with exact receipt replay. No opening/approval/effect history scan; Auth owns credential mutation and the 64-session cap.
- Growth check: `test/access/growth-auth-credential-capability.test.ts`: `credential capability ${dimension}`

### Durable initiator restoration

- Touches: Exact immutable operation PK/source/creation receipt and full tuple digest; one independently anchored current account/fence observation; one Auth-owned actor/client consent plus current client/readiness/reduction/pending-ceiling chain through the private authenticated reader; exact original delegation and current matched membership evidence; the installed formula at the same live T. Readers release before the next anchor and target checkout.
- Bound: With R=N+U*t+M, O(log R+(1+K)log G+matches), K<=1000 per account. Fixed rows/statements and logarithmic blocks in stored person history/operation count at fixed tuple/output/K; native formula matches retain their own cap. Every serialization retry and replay restores afresh. No history scan, token retention or stub-verifier cost claim. Shared evidence TTL: min(caller deadline, real time + 1 s); O(1), no added reads.
- Growth check: `test/access/growth-durable-initiator.test.ts`: other/same-person operation/consent/delegation series at 1/8/64 x500; native creation, retry/replay and revoked replay; ALL nested Access and Auth SQL captured, including operation/source/receipt, account, current consent/client chain, exact delegation, matched membership and formula. `test/access/access-deadlines.test.ts`.

### Recovery completion

- Touches: the account's recovery, barrier proof, establishment and effect receipt rows, its Access account and fence
  receipt, and one core receipt.
- Bound: rows and statements constant; blocks logarithmic in recovery history.
- Growth check: `test/access/growth-recovery-completion.test.ts`, test
  `native completion growth independent of receipt history`, through `checkGrowth` at [256, 1024, 4096].
  Shared `seed` populations in `grow` copy rows read back from one real recovery, with same-account and
  unrelated-owner history. The default warm-up completes a spare seeded
  recovery; measured runs perform fencing, delivery, completion and exact success replay on the measured owner.

### Reinstatement

- Touches: one governance check on the Global Context, the receipt, and one locked account row in its partition.
- Bound: O(log R) per statement, a fixed number of statements, independent of other accounts and of the account's
  history.
- Growth check: `test/access/growth-reinstatement.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts
  and the account's earlier suspension and reinstatement receipts; default warm-up on a spare suspended account;
  constant rows and statements, logarithmic buffers.

### Open interval lookups

- Touches: one exact probe using the partial open-key btree or a temporal GiST key (`resource_denial_pkey`,
  `resource_denial_permission` or `resource_role_grant_pkey`). The base-table probe keeps both `upper_inf(valid)` and
  `valid @> T`, so the btree selects only the open row and GiST also excludes closed intervals for that key. Ending a
  denial repeats the time condition on the update. An insert also runs the temporal primary-key exclusion check.
- Bound: O(log R) per statement, constant rows and statements, independent of one key's closed history and unrelated
  keys under any selected index.
- Growth check: `growth-open-interval-history.test.ts` at [1, 8, 64]. Denial history is built through repeated real
  record/end statements at recent times; denial and group-grant probes also grow unrelated keys. Each series runs with
  `VACUUM ANALYZE` after growth and with baseline statistics left unchanged after growth; rows and statements stay
  constant and buffers grow logarithmically.

### Handles

New claims and renames case-fold to lowercase, then match
`^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$`: 3–64 ASCII letters, digits, underscores or hyphens,
with a letter or digit at both ends. Whitespace is refused, never trimmed.
`handle-policy.ts` defines claim and lookup validation separately. Lookups keep
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, so existing short or punctuation-ending handles
keep resolving to their owners. A rename's expected old handle uses lookup validation.

The version-controlled reserved registry in `handle-policy.ts` contains:

- `platform`: rezics, official, system, root, api, www, mail.
- `role`: admin, administrator, support, help, staff, team, moderator, mod, security, abuse, legal, privacy.
- `mention`: everyone, here, anonymous, deleted, null, undefined.

An addition needs a reason (`platform`, `role` or `mention`) and a reviewed change.
The one reservation command checks the case-folded name for every account kind and
workflow, with the same typed refusal as an occupied name. There is no public bypass flag.
An authenticated account with `account:assign_reserved_handle` on the Global Context
may use the ordinary workflow to reserve a name for itself or an account it currently
manages (`account:manage`). Authority and token scopes are checked on every command
attempt and receipt replay. The reservation and publication receipts record
`reservedHandleException: true` when this exception is used; their handle events carry
the same optional audit fact. Auth supplies the verified
workflow context only for protected operations; public sign-up cannot use the exception.

The registry check is an in-memory set lookup with fewer than 64 entries: constant
work and no additional relation or growth check. Existing claim storage bounds remain unchanged.

### Public identity read

`PATCH /v1/accounts/{accountId}` (`account.update`, action `account:update`) updates the public profile through
`updateAccount`. It accepts a nonempty partial patch of `displayName`, `biography`, `avatar`, `links`, `publicViews`
and organization-only `speakersListed`, preserves omitted values, clears nullable fields with null, merges view flags,
requires the account's own available avatar media and existing account or operator management authority, and uses the
ordinary account-command idempotency and problem responses; unknown fields and malformed values answer 400
`invalid_request`.
The mounted action catalogue includes the authenticated `account:manage` operand needed for automated profiles.

`GET /v1/accounts` accepts exactly one of `ids` (1–100 comma-separated account UUIDs, deduplicated in first-request
order), `handle` (one handle, normalized to lowercase using the lookup rules), or `agent` (one catalogue subject UUID).
Each form returns
`{ accounts: [...], next: null }`. The web builds an account's public page at `/@handle`, outside Realms and Zones.
The `handle` and `agent` forms hide deleted accounts exactly like unknown handles or subjects, returning the same
empty account list. The `ids` form retains deleted identities for attribution.

The `agent` form resolves one `access.agent_page` pointer in the subject's route, then reads the named account by its
own `(route, account_id)` key. The account row remains authoritative: the read returns an empty account list unless
it is present, active, marked verified and still names the requested subject. Approval writes this pointer in its own
receipt-bound workflow step after Semantic's merge and before the account is marked verified. An exact replay confirms
the existing pointer; a subject already pointing at another account fails with a typed workflow problem. The page table
is backfilled from accounts already verified when the migration runs. Reversal owns pointer removal.

- Returns per visible account: `id`, `kind` (`actor` or `organization`), `handle`, `displayName`, `state` (`active` or
  `deleted`), `automated` and `operatorId`. An account with an operator is `automated: true` and names its operator;
  every other account is `automated: false` with `operatorId: null`. A deleted account keeps only its `kind`: handle,
  display name and operator are withheld, and `automated` is false. Pending accounts are absent and no private field is
  selected.
- Touches: one statement (`public-identity-page.sql`); at most 100 `account_pkey(route, account_id)` probes on `access.account`.
- Bound: the sum of at most k independently indexed `account_pkey` probes, O(k log N) for k <= 100 requested ids and N accounts, with discrete index-depth transitions; constant statements; rows at most k.
- Growth check: `growth-public-identity-read.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts with
  the 100 requested ids fixed (seed thousands of accounts before scale 1 and analyze); constant rows and statements,
  logarithmic buffers.

### Agent page lookup

- Touches: one `agent_page` primary-key point read in the subject's route and one anchored `account_pkey(route,
  account_id)` point read; the account row must still verify the subject.
- Bound: rows and statements constant; blocks logarithmic in verified agents.
- Growth check: `test/access/growth-agent-page-lookup.test.ts`, `agent page lookup stays within its bound as unrelated
  verified subjects grow`, scales [256, 1024, 4096], seeded in `grow`, with one warm-up.

### Agent page pointer write

- Touches: one insert or primary-key probe in the subject's partition inside the approval workflow.
- Bound: rows and statements constant per approval.
- Growth check: `test/access/growth-agent-page-lookup.test.ts`, `agent page pointer write stays within its bound as
  subject pointers grow`, scales [256, 1024, 4096], seeded in `grow`, with one warm-up.

### Organization speakers page

`GET /v1/accounts/:accountId/speakers` is public and uses `account:read_public_identity`. It accepts an opaque
`cursor` and `limit` from 1 to 100 (default 20), returning `{ speakers: [...], next: string | null }`.
Each speaker is exactly the ids read's public identity item. Only active, unfenced accounts with a principal
assignment current at the request's kernel-clock T appear, once per account regardless of assignment count.
Membership history is not a substitute for a current principal assignment.

An organization must be active, unfenced and have `speakersListed: true`. Otherwise, including actor and unknown ids,
every caller receives `{ speakers: [], next: null }`. This gate precedes cursor decoding, so an old cursor cannot
reveal a hidden organization's speakers. Revoked assignments, expired or future validity, and inactive or fenced
speakers do not appear.

Pages order by assigned actor UUID. `next` and `cursor` use opaque `encodeListCursor` and `decodeListCursor` tokens
from `tokens/list-cursor.ts`, bound to this route, the acting viewer (including anonymous), organization, ordering and
page size, with format epoch 1 and the shared 15-minute lifetime. The cursor records the last scanned actor, so
filtering hidden identities may yield a short or empty page with a non-null `next`; clients continue until `next` is
null. This avoids an unbounded search to fill a page. Each request evaluates live facts at its own T; a cursor does not
freeze assignments or public identity state.

- Touches: one organization `account_pkey(route, account_id)` point read; one bounded distinct-actor range on the
  principal's own partition via the partial `principal_assignment_speakers` index; one statement projecting public
  identities for at most `limit` account keys. The assignment query seeks past each actor's remaining assignments,
  admits at most `limit + 1` distinct current actors, excludes revoked rows from the index, and constrains validity's
  lower bound in the index. Public identities are read together, with each account's route and key, independently of
  the organization's partition.
- Cost: rows O(limit + E), constant statements (three for a listed organization, one otherwise), blocks
  O(limit + E + log N) for the capped page size. E is this organization's expired but unrevoked assignments inside
  the scanned range, this read's one unbounded term; other organizations' assignments and revoked assignments do
  not add scanned rows. Distinct-actor seeks also skip duplicate current assignments.
- Growth check: `test/access/growth-organization-speakers.test.ts`,
  `organization speakers page stays bounded as unrelated and revoked assignments grow`, scales `[256, 1024, 4096]`,
  page size 20 and one warm-up per scale. It also grows duplicate current assignments for one listed speaker.

### Public profile by handle

- Returns the identity fields above plus `bio` (the stored biography or null), `links` (an array of `{ label, url }`),
  `avatar`, `publicViews`, `subject` and `verified`. `avatar` is null or the [Content cover summary](../content/README.md#the-cover-summary)
  with `credit: null`. `subject` is the derived account agent until verification, then the verified catalogue subject;
  both include `{ id, label, type }` from Semantic. A former handle returns the same current account profile as its
  current handle, with optional `movedTo` while forwarding is live. `movedTo` always names the account's current
  handle. After 30 days it is absent and the former handle returns an empty list. Unknown and ordinary pending handles
  also return an empty list. A deleted account's current and former handles return exactly that empty list; an ids read
  still returns only its identity tombstone.
- A former handle keeps three independent facts: its allocation row records the owning account, its `former_until`
  timestamp bounds public forwarding, and the owning account row determines whether that account still exists and is
  active. Another account can never claim the former handle. Its own active account can take it back through an
  ordinary rename, which applies the same rename limit. Forwarding reads the owner's current account row, so a handle
  renamed more than once points straight to the current handle.
- An account may change its handle at most five times in any rolling 30-day period. The account row keeps the latest
  five change times; initial handle publication is not a change. Deleting an account retires its current handle under
  the same allocation rule but never forwards it, because the account no longer exists. Former-handle rows are
  retained to prevent impersonation; they contain allocation and timing data, not profile data. No work releases or
  deletes a former-handle row. Until a reviewed command exists for forced renames or reassignment, impersonation is
  contained through suspension.
- The existing account profile patch accepts `links` alongside `displayName` and `biography`; `[]` clears links.
  There are at most 5 links, with labels of 1–64 characters and absolute `https:` URLs of at most 2048 characters,
  without credentials.
- `avatar: <media id> | null` sets or clears the reference. Content's `checkAvatarMedia` checks available avatar media
  uploaded by that account, by primary key in the account partition, inside the same command. Invalid media answers
  `invalid_request` and the whole patch writes nothing. Clearing the reference does not erase Content's media object.
- `publicViews: { posts?: boolean, reviews?: boolean, collections?: boolean, realms?: boolean }` merges only the
  supplied flags. Posts, reviews and collections default to true for actors and organizations; `realms` defaults to
  false. The handle read always returns all four keys. The three activity flags hide only the lists on the agent's
  subject page; individual items retain their own visibility. The Realm flag controls the public account Realms page.
- An organization's patch also accepts `speakersListed: boolean`, default false. Only organization handle profiles
  return this field. Principal assignments still determine who speaks for the organization; this flag controls listing.
- Presentation follows the existing profile authorization: the account itself (including an organization's acting
  principals) or its operator's managers. Manager authority follows the current operator, rechecked under the account lock.
  There is no new action. Fencing or deletion clears avatar, biography and links, sets every view off and clears speaker
  listing. Fenced or inactive profiles expose no public views even if stale presentation values remain stored.
- Touches: one `handle_claim_pkey(route, normalized_handle)` point read on the handle's route, then one
  `account_pkey(route, account_id)` point read on the account's route for an active or currently forwarding claim.
  A missing, expired or ordinarily pending claim stops after the first read.
  An active profile reads the selected subject's label and type through Semantic's bounded one-id batch reads. An avatar
  adds one `readAvatarSummaries` statement in the account's partition. An avatar patch adds one
  `checkAvatarMedia` primary key read to the existing patch statements.
- Bound: constant rows and statements; logarithmic blocks in accounts, handle claims and media.
- Growth checks: `test/access/growth-account-handle-read.test.ts` covers current profiles;
  `test/access/growth-handle-retirement.test.ts` covers former-handle reads, rename and deletion at
  [256, 1024, 4096], with one warm-up per scale.
- Rename publication also checks the bounded account-local history and refuses a sixth change when the fifth-latest
  change is less than 30 days old. Forwarding lasts until the former row's `former_until`; expiring forwarding never
  releases that row. An active owner may reclaim it through the ordinary rename workflow, while deleted accounts and
  other accounts cannot. The same growth check covers this forwarding and retirement path.

### Public activity view port

- Access exports `readPublicViews(client, accountIds): Promise<Map<string, PublicViews>>` for Content and Commerce.
  A batch accepts at most 100 ids; an empty batch returns an empty map without querying. Duplicate ids collapse.
  Malformed and unknown ids, deleted, fenced and other inactive accounts return all three flags false. Active accounts
  that never chose return all three true, including organizations.
- Consumers answer an empty per-account page for a private view unless the viewer is that account or acts for that
  organization. Access serves only the flags, not the activity lists or their item visibility rules.
- Touches: one statement per partition among valid ids, with a primary key probe for each id.
- Bound: at most 100 ids; O(ids) rows, O(partitions among ids) statements, O(ids log N) blocks.
- Growth check: `test/access/growth-account-public-views.test.ts`,
  `public view flags for 20 accounts across 4 partitions stay bounded as accounts grow`, uses scales [256, 1024, 4096],
  seeding in `grow` and using the default warm-up.

### Public account Realms page

`GET /v1/accounts/:accountId/realms?cursor=&limit=` returns `{ realms: [{ id, role }], next }`, with `role` set to
`owner` or `member`, a default limit of 20 and a maximum of 100. The page is public under the account identity read
action. An account must opt in through its existing profile patch with `publicViews.realms: true`; the new flag
defaults to false. Fenced, deleted and incomplete-inverse accounts answer an empty page. Each candidate from the
account's Realm membership inverse is confirmed at T by the registered Realm role reader, then checked for
`realm:read` at the same T, in that order. A stale membership or unreadable Realm is skipped. The opaque cursor from
`tokens/list-cursor.ts` is bound to `GET /v1/accounts/:accountId/realms`, the viewer and the account/limit query; it
uses the kernel clock and continues after the last scanned inverse row without revealing its id. The page does not
refill after skips, so it may return fewer than `limit` items.

- Touches: one account primary-key probe for the opt-in and inverse-completeness gate; one `membership_inverse_pkey`
  range of at most `limit + 1` Realm rows in the account's partition; then, for each scanned candidate, one registered
  Realm role read and one `realm:read` authorization, each anchored in that Realm's partition. Checks run in sequence.
- Bound: rows and statements O(limit); blocks are the sum of one indexed inverse range seek and each candidate's
  indexed role and authorization probes, O((1 + 2 × limit) log R) with discrete index-depth transitions. This remains independent of other accounts' memberships and of
  this account's Realms beyond the page.
- Growth check: `test/access/growth-account-realms.test.ts`,
  `account Realm pages stay bounded as this and other accounts' memberships grow at a fixed limit`, seeded in `grow`
  with at least one warm-up.

### Organization creation

- Touches: one approval row and its receipts on the creator's anchor; per step one approval resolution (the creator's
  anchored read plus one Global grant probe through the standing grant); the organization's account row, owner
  membership and handle rows in the new organization's partition; the owner inverse in the creator's partition; the
  handle hold on the handle route.
- Bound: O(log R) per statement, a fixed number of statements, independent of the number of accounts, organizations or
  Global grants held by others. Existing owner safety probes inspect at most two owners plus the target.
- Growth check: `growth-organization-creation.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts,
  organizations and other subjects' Global grants with the creator fixed; constant rows and statements, logarithmic
  buffers.

### Governance bootstrap

- Touches: one native Global command to install the governance role and its receipt/outbox, followed by a separately
  authorized standing-parent command for `organization:create`. Replays recheck the role installation marker and the
  standing-parent marker; a conflicting operator is refused before the second command.
- Bound: constant rows and statements at fixed actor and Global anchors, with logarithmic buffers as unrelated
  accounts and Global grants grow. The integrated check observes four account rows on first install/replay and one on
  refusal; refusal performs only the initial command attempt.
- Growth check: `growth-bootstrap-governance.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated accounts,
  Global grants and receipts with the bootstrapped actor fixed.

### Workflow approvals

Approval creation, reads and consumption use the kernel clock configured on Access (including derived Access adapters). On this T timeline, expiry is `min(T + TTL, carried JWT expiry)`: TTL is 60 seconds for a credential approval and 300 seconds otherwise. Reads and consumption require T strictly before both the approval expiry and carried bearer expiry. The `jwt_expires_at` column stores the bearer expiry carried into kernel time at issuance, equal to the JWT exp when clocks agree apart from the sampling gap. Restored identities retain this kernel-time expiry. The fence-operator suspension uses that same clock. Operator session and credential openings, consumed native opening readers and registration readers also evaluate lifetimes at T. Operator opening TTL remains 60 seconds; binding a credential opening caps it at the bearer expiry carried into kernel time. Request and evidence budgets never use a stored lifetime as a wall-clock deadline. Evidence deadlines remain on the database clock plus the remaining evidence budget and are never compared with T; request deadlines remain on real time.

`test/access/approval-opening-clock.test.ts` checks approval and operator opening expiry at the exact T boundary with an untouched process clock, live lifetimes behind database and process time, and request and evidence deadlines independent of T.

`client:manage` authorizes Auth client scope reductions on the Global Context through the ordinary Access formula; the approval binds the exact client, first-party flag and scopes.

Touches: `workflow-approvals.ts` verifies the real JWT/JWKS, reads the exact actor and native logical-binding/create receipts, and inserts one immutable `workflow_approval` row on the actor anchor. Separate resource authority is released before storage checkout. Resolve reads one exact approval and its native creation receipt, current actor/assignment/principal facts, then the installed actor-side formula with original scopes. No token, context, history/ACL scan or receipt-response search. Sweep seeks expiry keys by route and deletes at most B<=1000 exact rows.

Bound: with `R=N+U*t+M` (subjects/history, activity and media), exact approval lookup returns at most one row, with fixed account/receipt reads plus the installed formula `O((1+K)log G+matches)`, K<=1000 per actor/principal. Rows/statements are constant beyond formula matches, with logarithmic buffers; creation writes one approval row and native receipts/outbox. Expiry sweep B<=1000 costs `O((1+B)log R)`. Strict expiry survives restart/GC delay.

An operation's approval is resolved once before its first effect, and again only by a step that takes a new effect for the person: each such resolution prepares its own evidence at its own T, rereads the acting account after the formula has fixed that T (so a consent reduction, a raised floor or a fence since the approval was restored denies), and nothing is reserved, provisioned or written until it passes. A step that only completes an effect already committed (releasing the hold of a membership that ended, terminal cleanup of a deletion) runs under that effect's record: the release is keyed from the committing step and the cleanup from the committed continuation, and neither resolves the approval again. Within one run an operation that removes the actor's own standing (the account's own deletion, own consent reduction, own leaving of an organization) answers with the workflow's outcome and is not re-authorized against state it changed, so an account that deletes itself and an owner who leaves are permitted. Every other operation keeps the post-workflow check, so its result is disclosed only under current authority; a resumed operation is a later invocation and returns a user result only if the caller is authorized at its own T, while a committed continuation whose caller lost authority completes its cleanup and returns none. A refusal crosses the Auth binding as an error carrying status 403, and Auth recognizes it by that status rather than by class name.

A person may request an approval for themselves or for a principal: an actor without an operator, acting through a current principal assignment (`requested_by`). The approval row stores that reference, which names the principal and the assignment, and the logical-binding receipt binds the original actor, client and reference, so the same operation key cannot be approved again under another one. Resolving the approval restores the identity only while the assignment is current, and every step's formula reads the assignment, the principal's account state and the principal's grants at its own T beside the person's own, so a revoked assignment, a suspended or fenced principal or a removed principal grant denies the step with nothing written. An automated or operated account is never a person, with or without an assignment. Cost: the existing 0-1 assignment and principal point reads, `L(D)+L(A)`, per resolution.

A completed workflow result is private to the caller whose approval started it: the stored request is bound to the approval's actor and logical operation, so another caller's approval of the same operation under the same key is refused, and a replay, a resume or a restarted host discloses the result only after resolving the caller's approval, and so its assignment, again.

- Growth check: `test/access/growth-workflow-approvals.test.ts`, exact `checkGrowth` names `approve: same-actor history`, `resolve: same-actor history`, `denied replay: same-actor history`, `expiry sweep: same-actor history`, `approve: unrelated accounts and resources`, `resolve: unrelated accounts and resources`, `denied replay: unrelated accounts and resources`, and `expiry sweep: unrelated accounts and resources`, at [1, 8, 64].

### Committed cleanup continuation

A committed continuation has an immutable root, derived allowlist entries and completions. Its initial allowlist has
at most four entries. Each fan-out page atomically adds its derived entries to the root's indexed
`access.committed_continuation_entry` rows before their effects. The read port exposes both lists, while the sealed
reference continues to bind the immutable root. Every step checks exact root membership and records one immutable
row in `access.committed_continuation_completion`, including its business receipt ID, key and digest. The completion
belongs to the root even when the business receipt belongs to an operated account on another route. Receipt replay
writes nothing twice and is also refused after the stored expiry.

At barrier commit, the expiry is the earlier of T plus 300 seconds and the resolved approval's expiry minus the
protected native step's ten-second budget, all on the Access clock. A barrier with no cleanup lifetime left is
refused. Native barriers without a workflow approval use the 300-second lifetime. An expired continuation releases
no hold and fences nothing by TTL; current governance can renew its stored live expiry.

`continueCommitted(reference)` dispatches on the allowlisted step kind to the runner that owns it:

- Fencing and reinstatement roots (`operator-responsibility-page`, `operator-unfence-page`) run signed pages. Each page
  and each child fence or unfence records its completion in its own transaction, before its effect.
- Deletion roots (`erase-auth-owner`) run the kernel-owned steps in allowlist order: `retire-operator`,
  `release-operator` and `redirect-deleted-handle`. Each is recorded through the same expiry-checked authorization,
  checked live again, then executed by its native command under the step's committed key. Each target must match the
  account's recorded operator, reservation and handle. Auth owns `erase-auth-owner` and `revoke-auth-sessions` and
  records them itself through `authorizeStep`; the runner leaves them alone. The tombstone transaction already made
  the account deleted and fenced, so a subject's release depends only on its terminal slot, and an operator deletes
  only after its subjects' deletions released their responsibilities.

- Touches: one continuation insert in the barrier's transaction; per cleanup step a primary-key root read, an exact derived-entry probe when needed, and one completion insert. Each fan-out page inserts its bounded derived entries in the page transaction. Renewal adds one governance check on the Global Context and one update.
- Bound: O(log R) per point statement, independent of other accounts and continuations. The allowlist read touches only this root's initial and derived entries, proportional to its own effects. A fencing page adds at most 100 child completions and one next-page entry.
- Growth check: `test/access/growth-committed-continuation.test.ts`: "continuation lookup stays bounded as unrelated accounts and continuations grow" and "one fanout page completion stays bounded as unrelated continuations and operated accounts grow"; constant rows and statements, logarithmic buffers.
- Behaviour: `committed-continuation-runner.test.ts` runs real deletion and fencing continuations through the runner, including expiry, replay and the immutable completion store.

Permission preparation and the final formula use capped account inverses and exact temporal probes; integrated checks measure constant rows/statements and logarithmic blocks in ACL/history size at fixed admitted membership, and at most linear work through the 1000-per-account cap.
Command freshness adds only the shared attempt seek to the installed actor-side formula `O((1+K)log G+matches)`, K<=1000 per actor/principal; bounded container/parent anchors, creation manifests and actual command changes retain their existing costs.
The independently released account observation is not an atomically locked global snapshot. Bearer command evidence remains bounded by the original request deadline and JWT expiry; the read snapshot’s 180 s reuse window does not replace fresh command admission. Durable identities instead use the freshly verified step deadline and native evidence budget, without renewing a bearer or a workflow approval.
Generic/parent creation authorization and dependent commands inherit bounded permission work plus their own point reads and mutations; trusted external validators and Realm/eligibility readers require their own locality and growth bounds.
The owner guard advances one keyed organization membership-time floor under the organization account lock and reads at most two owners and one target at that floor, serializing owner removal and demotion against every membership write while preserving the single command time for history, constant examinations and logarithmic buffers.
Membership replacement preserves expired history and changes only q current/future intervals, with measured logarithmic buffers at fixed q; imported scheduled authority can make the actual number of changes uncapped.
Temporal GiST bounds stated from growth checks apply to the measured paths and fixed inputs; these measurements do not establish a worst-case guarantee for arbitrary unmeasured probes.
Catalogue processing and action-list expansion scale with trusted catalogue size and a/b/R, with no numeric template or action-list cap.
Bearer verification scales with raw JWT/JWKS inputs and cache misses while database work stays point-anchored; evidence budgets and request deadlines bound elapsed authority, not rows or shared blocks.
The account/public projection is a point read and tombstoning scrubs its account row while retaining authority/coordination history; no denial-projection writer or bulk erasure implementation is present to derive an additional bound.
Access SQL keeps assignment/account and inverse/hold/account joins on their principal/member anchor, releases independent group/authority reads before target checkout, and has no cross-partition join or global lock/counter.
The shared executor serializes writes through one `core.partition.position` counter per partition, so contention can grow within that partition without requiring all partitions on one machine.

### Session revocation

`revoke` is the native adapter behind Auth's `revokeSessions`: it ends every session and token a person holds before
now, and it is the only way a person's sessions are revoked.

- Authority: the subject itself, authenticated with its own credential (an operator-opened session is not the
  person's own), under `account:manage` on that account; and platform governance, under `account:suspend` on the
  Global Context, the action suspension uses. Nobody else holds either, including an organization's owners and the
  managers of another account. The subject is an active person (an actor with no operator). An automated account's
  sessions end with its operator's fence or its own deletion.
- Order, Access first: one Access transaction advances the subject's `minimum_authn_epoch`, raises its authentication
  fence, inserts the fence receipt (`kind = 'fence'`) and the command receipt, and commits the continuation whose
  only entry is Auth's `revoke-auth-sessions`. Only then does Auth delete the sessions, authorized by that continuation
  and not by the caller, whose standing the fence has just ended. From the commit every earlier session and token is
  refused, and no new one is issued while the fence stands, whether or not Auth has deleted anything.
- Failure: if Auth fails, the workflow answers `revocation-failed` (`RevocationFailedError`, `code: 'revocation-failed'`)
  and leaves the fence. `resumeOperation(key)` completes the deletion under the continuation; it is recorded once.
  A continuation expires after five minutes and governance renews it.
- Recovery: the person stays `active`. A recovery clears exactly the fence of its own proof, and its proof names the
  floor it was issued at. A proof issued before this fence no longer matches the account, so it cannot complete,
  cannot lower the floor and cannot clear the fence. A recovery started afterwards restores the person at a higher
  floor. Revoking an already fenced person advances the floor again and supersedes a recovery in flight.
- Replay: the command receipt is keyed by the approval's operation key, so a replay by governance answers the stored
  receipt, advances nothing and asks Auth nothing more. The subject's own replay is refused like any request signed
  by a floor it has since passed.
- Touches: one actor admission seek, the native formula, one account lock and update, one fence receipt insert, one
  command receipt and one continuation insert, all in the subject's partition. Auth's deletion is bounded by the
  subject's sessions, k.
- Bound: O(log R + k), R = N + U*t + M, plus the formula `O((1 + K) log G)`, K <= 1000. No statement reads more than
  the subject's rows, so there is no growth check beyond the existing ones for the shared account and receipt paths.
- Behaviour: `test/access/session-revocation.test.ts` runs the workflow through the native bindings with real Auth
  sessions, tokens and recovery.

### Operator fencing

- Touches: the suspension's existing rows plus one responsibility probe and one continuation insert. The committed
  suspension event starts the kernel worker; Auth's `fence` barrier calls that same suspension through its resolved
  approval context and revokes only the operator's own sessions under the continuation. Each durable step reads one
  signed keyset range of at most P+1 responsibility rows and the partition point, writes one immutable child allowlist
  before effects, then checks each subject's relation and slot and applies the native fence in its partition. Pending,
  unpublished reservations remain held. Connections are released before the next page is scheduled.
- Bound: per page O(P log R), P <= 100; total work proportional to the operator's affected accounts, never to unrelated
  accounts or the operator's completed history. Native command receipts make worker retries and trusted
  `continueCommitted(reference)` recovery idempotent.
- Growth check: `test/access/growth-operator-fencing.test.ts` with `checkGrowth` at [1, 8, 64]: unrelated accounts with
  the operator fixed; completed and pending history with fixed first and late page seeks; and affected accounts with
  P fixed. Per-page rows and statements stay constant and buffers logarithmic; total work is linear in affected accounts.

### Operator reinstatement fanout

- Touches: one continuation root row in the reinstatement transaction; per page, one signed responsibility page read
  of at most 100 subjects, one anchored point read and lock of each subject and its relation slot, one fence receipt
  read per subject, and one page receipt.
- Bound: O(P log R) per page with P <= 100; the whole fanout is O(S log R) for S operated accounts, in pages.
- Growth check: `test/access/growth-operator-reinstatement.test.ts` with `checkGrowth` at [1, 8, 64], growing unrelated
  accounts and the operator's earlier fence and reinstatement history with the page fixed; constant statements and
  rows, logarithmic buffers. Seed in `grow` and use the default warm-up.

Access failures caused by time or capacity are unavailability, never a denial.
`AccessUnavailableError` carries `deadline`, `overloaded`, or `contention` through
request preparation, authentication, and authorization. The shared classifier
recognizes an elapsed request deadline, pool connection timeouts, SQLSTATE classes
08 and 53, query cancellation (57014), server shutdown/unavailability (57P01–57P03),
and exhausted serialization/deadlock attempts (40001 and 40P01). Classification
inspects only the failure and deadline, takes O(1), and reads no rows.

HTTP maps these reasons to retryable 503 `deadline_exceeded`, `overloaded`, and
`transaction_retry_exhausted`; the latter two include `Retry-After: 1`. Commands
report `effect_status: not_applied`. Missing tables, missing rows, unresolved
accounts, and other unclassified failures retain their existing denial behavior.
The kernel's configurable request deadline defaults to 2000 ms, shared with the
standalone command default. Test kernels use 30000 ms.

Prepared permission, operator, and durable identity evidence expires at the earlier of
the caller's deadline and one second of real time after preparation: min(caller deadline, real time + 1 s).
Callers prepare evidence immediately before the transaction that applies it and never wait between preparing and
applying it: no freshness or projection wait, lock wait, sleep or retry back-off. A caller that must wait does so
first and prepares afterwards; a retry prepares afresh. Evidence that elapses before it is applied answers 503
without effects. Binding checks verify identity and provenance. Elapsed time is checked separately and raises
unavailability. The final SQL continues to check evidence validity at the authoritative
command time. The database deadline uses the remaining budget when its clock was
observed, so later preparation does not subtract elapsed time twice.
The bounds below describe fixed admitted inputs: account batches are capped at 100, pages at their declared limit, command event count k at 1,000, and durable work batches at their stated size. Indexed probes use logarithmic blocks; table rows and statements remain constant unless the row says they scale with a page, batch, or affected fanout. Account/partition history and unrelated subjects do not add work unless named.
Bounds hold for a fixed admitted neighbourhood: account batches are at most 100, page work is limited to its stated page size, command event batches are at most 1,000, and durable work uses its stated batch size. Rows and statements stay constant unless a row names page, batch, or affected-item growth; indexed probes grow logarithmically with the named key population. No operation depends on unrelated account, partition, assignment, grant, receipt, or workflow history unless the row says so.

| Operation                                              | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Bound                                                                                                                                                                                                                                                                                                                       | Growth check                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active account page                                    | One keyset range on `account_active_pages`, returning at most the fixed page limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Constant statements; rows linear in page limit; logarithmic blocks in active accounts.                                                                                                                                                                                                                                      | `test/access/growth-active-account-page.test.ts`: “active account page reads stay bounded as inactive accounts grow”                                                                                                                                                                     |
| Permission preparation and final permission            | Preparation reads anchored actor and organization/member evidence; final formula probes exact grant, role grant, denial and assignment keys for the requested action/resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant statements and rows for fixed evidence and K; logarithmic blocks in accounts O and grants G.                                                                                                                                                                                                                       | `test/access/growth-permission.test.ts`: “Permission preparation stays within its bound as O grows”; “Final permission check stays within its bound as G grows”                                                                                                                          |
| Resource authorization                                 | Actor proofs, target authority validation, then the selected target execution; stable tuple and creation paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Constant statements; constant rows for fixed proofs; logarithmic blocks in actor, grant and target indexes.                                                                                                                                                                                                                 | `test/access/growth-resource-authorization.test.ts`: “${mode} authorization composes bounded actor proofs, authority validation and target execution”                                                                                                                                    |
| Resource authorization page                            | Actor evidence, one target page validation and batched exact grant/role/denial keys for at most 100 resources; governance-use write when applicable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant statements; rows linear in page size P; logarithmic blocks in grants G and resources R.                                                                                                                                                                                                                            | `test/access/growth-resource-authorization-page.test.ts`: “page authorization keeps its statement count fixed as ${series} grows”                                                                                                                                                        |
| Global governance authorization                        | Anchored Global Context/page reads and exact Global grant formula candidates; evidence setters are in-memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows and statements; logarithmic blocks in grants and unrelated resources.                                                                                                                                                                                                                                         | `test/access/growth-governance-reach.test.ts`: “checkGrowth keeps Global authorization bounded as unrelated resources, grants and accounts grow”                                                                                                                                         |
| Record Global governance reach                         | One attribution insert per reached resource in the authorized command transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows and statements; logarithmic blocks in the anchored index.                                                                                                                                                                                                                                                     | Missing: no checkGrowth measures successful command attribution writes as unrelated reach records grow.                                                                                                                                                                                  |
| Rate tier change                                       | Global governance authorization, command receipt, locked target account and operator relation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows and statements; logarithmic blocks in accounts and receipts.                                                                                                                                                                                                                                                  | `test/access/growth-rate-tier.test.ts`: “rate tier stays bounded as unrelated accounts and operated accounts grow”                                                                                                                                                                       |
| Account reads and public projection                    | One account point read, public account projection and organization role point read as requested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows and statements; logarithmic blocks in accounts A.                                                                                                                                                                                                                                                             | `test/access/growth-commands.test.ts`: “Account read and public projection stays within its bound as A grows”                                                                                                                                                                            |
| Public identity batch                                  | Full-key batch read for at most 100 accounts, grouped by partition and relation kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows linear in batch limit; constant statements per relation kind; logarithmic blocks in account history.                                                                                                                                                                                                                   | `test/access/growth-public-identity-read.test.ts`: “a fixed 100-account public identity batch stays bounded as unrelated accounts grow”                                                                                                                                                  |
| Public profile by handle                               | Exact handle claim lookup followed by the current account projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in account and handle histories.                                                                                                                                                                                                                                               | `test/access/growth-account-handle-read.test.ts`: “public profile by handle stays bounded as accounts and handle claims grow”                                                                                                                                                            |
| Public profile by agent                                | Exact verified subject pointer lookup followed by the current account projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in account and subject pointer histories.                                                                                                                                                                                                                                      | `test/access/growth-agent-page-lookup.test.ts`: “agent page lookup stays within its bound as unrelated verified subjects grow”                                                                                                                                                           |
| Agent pages                                            | One indexed agent page with account-state validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows linear in page limit; constant statements; logarithmic blocks in listed and unlisted accounts.                                                                                                                                                                                                                         | `test/access/growth-agent-pages.test.ts`: “agent pages stay bounded as listed and unlisted accounts grow”                                                                                                                                                                                |
| Public change time                                     | The existing account update compares only public identity fields and advances `public_changed_at` in that same row write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Constant rows/statements per account update; no history read or additional statement.                                                                                                                                                                                                                                       | `test/access/growth-agent-pages.test.ts`: “public change time stays bounded as accounts grow”                                                                                                                                                                                            |
| Organization speakers page                             | One bounded range of active speaker assignments and the corresponding account evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rows linear in page limit; constant statements; logarithmic blocks in assignments and accounts.                                                                                                                                                                                                                             | `test/access/growth-organization-speakers.test.ts`: “organization speakers page stays bounded as unrelated and revoked assignments grow”                                                                                                                                                 |
| Account Realm page                                     | One membership keyset page at fixed limit, with account and Realm membership anchors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows linear in page limit; constant statements; logarithmic blocks in memberships.                                                                                                                                                                                                                                          | `test/access/growth-account-realms.test.ts`: “account Realm pages stay bounded as this and other accounts' memberships grow at a fixed limit”                                                                                                                                            |
| Public activity views                                  | Full-key batch read for at most 20 accounts over at most four partitions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Constant statements per relation kind; rows linear in the fixed batch; logarithmic blocks in account history.                                                                                                                                                                                                               | `test/access/growth-account-public-views.test.ts`: “public view flags for 20 accounts across 4 partitions stay bounded as accounts grow”                                                                                                                                                 |
| Bearer authentication                                  | One credential/session evidence lookup anchored by presented token material.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows and statements; logarithmic blocks in accounts A and credential history.                                                                                                                                                                                                                                      | `test/access/growth-authenticate.test.ts`: “Bearer verification stays within its bound as A grows”                                                                                                                                                                                       |
| Write rate counter and ordinary/batch admission        | One atomic counter upsert for the admitted identity/scope, plus bounded batch units (maximum 100).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows and statements; logarithmic blocks in counter keys as unrelated and hot-scope counters grow.                                                                                                                                                                                                                  | `test/access/growth-write-rate.test.ts`: “actual ordinary and batch100 admission use one point statement as unrelated and hot-scope counters grow”                                                                                                                                       |
| Mounted write rate stage                               | Route declaration lookup and one native rate-counter statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Constant statements and rows for the mounted route; logarithmic blocks as declarations and background counter rows grow.                                                                                                                                                                                                    | `test/access/growth-write-rate-route.test.ts`: “mounted declarations and one native counter statement stay bounded as routes and background rows grow”                                                                                                                                   |
| Write rate counter expiry                              | One route-led expiry-index delete limited by the configured batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Rows linear in the fixed batch; one statement; logarithmic blocks in counter history.                                                                                                                                                                                                                                       | `test/access/write-rate-expiry.test.ts`: “one native statement uses the route-led expiry index and remains bounded through common-seed growth”                                                                                                                                           |
| Durable write rate chunk                               | One exact ledger key and one exact counter key per chunk; expiry deletes at most 1,000 combined rows on one route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements per chunk; expiry rows linear in the fixed batch; logarithmic blocks in live ledger and counter history.                                                                                                                                                                                           | `test/access/growth-write-rate-chunk.test.ts`: “chunk ${mode} stays constant as identities, operations and recorded chunks grow”; “ledger expiry is one bounded statement as expired and live chunk history grows”                                                                       |
| Command actor admission                                | One account seek per attempt, plus fixed receipt/attempt evidence for the selected mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows and statements per attempt; logarithmic blocks in account history.                                                                                                                                                                                                                                            | `test/access/growth-command-admission.test.ts`: “${mode} command admission adds one account seek per attempt at all three growth scales”                                                                                                                                                 |
| Parent creation authorization                          | Exact parent role/grant proof for the requested child creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Constant rows and statements; logarithmic blocks in grant history G.                                                                                                                                                                                                                                                        | `test/access/growth-permission.test.ts`: “Parent creation authorization stays within its bound as G grows”                                                                                                                                                                               |
| Standing parent grant installation                     | Parent and account anchors plus bounded exact grant writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Constant rows and statements; logarithmic blocks in grant history Gt.                                                                                                                                                                                                                                                       | `test/access/growth-commands.test.ts`: “Standing parent installation stays within its bound as Gt grows”                                                                                                                                                                                 |
| Resource initialization and replay                     | Resource/partition anchors, creation provenance and bounded default grant writes; replay reads exact receipt/provenance keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows and statements; logarithmic blocks in unrelated and same-partition history.                                                                                                                                                                                                                                   | `test/access/growth-creation-manifest.test.ts`: “native creation, provenance, grant writes and replay stay bounded as unrelated and same partition history grows”                                                                                                                        |
| Grant, denial and group-role routes                    | Exact resource/account anchors, grant or denial point writes and bounded command receipt work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows and statements per command; logarithmic blocks in grant and denial histories.                                                                                                                                                                                                                                 | `test/access/growth-grant-routes.test.ts`: “actual HTTP grant routes keep full native SQL cost bounded at 1/8/64 x 500 grants and histories”                                                                                                                                             |
| Delegation create, revoke and read                     | Delegator/delegate account anchors, exact assignment key and receipt; one assignment read for lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows and statements; logarithmic blocks in assignment and account history.                                                                                                                                                                                                                                         | `test/access/growth-commands.test.ts`: “Delegation create/revoke/read stays within its bound as A grows”                                                                                                                                                                                 |
| Held resource role                                     | Exact target/resource role grant probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows and statements; logarithmic blocks in role grants.                                                                                                                                                                                                                                                            | `test/access/growth-resource-role-held.test.ts`: “resourceRoleHeld stays constant as role grants grow”                                                                                                                                                                                   |
| Account and organization creation                      | Account/organization anchors, Global governance proof, receipt, and fixed initial grants/provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows and statements per creation; logarithmic blocks in unrelated accounts, organizations and grants.                                                                                                                                                                                                              | `test/access/growth-organization-creation.test.ts`: “real organization creation stays bounded as unrelated accounts, organizations and Global grants grow”                                                                                                                               |
| Handle reserve, claim, resolve, redirect and expiry    | Exact handle/account claims, transition and receipt keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Constant rows and statements per operation; logarithmic blocks in account and handle history.                                                                                                                                                                                                                               | `test/access/growth-commands.test.ts`: “Handle reserve/change/resolve/expire stays within its bound as A grows”                                                                                                                                                                          |
| Account update, coordination and fences                | Target account point read/update and exact coordination/fence evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Constant rows and statements; logarithmic blocks in account history A.                                                                                                                                                                                                                                                      | `test/access/growth-commands.test.ts`: “Account update, coordination and fences stays within its bound as A grows”                                                                                                                                                                       |
| Membership mutation                                    | Account/organization membership anchors and bounded current membership mutation; expired interval history is not enumerated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant changed rows/statements per member; logarithmic blocks in interval history; total work linear in changed members.                                                                                                                                                                                                  | `test/access/membership-history-cost.test.ts`: “scales 256 1024 4096 keep actual membership mutation rows fixed as expired history and background grow (${scheduled ? 'scheduled' : 'ongoing'} member, ${role ?? 'removal'})”                                                            |
| Tombstone erasure                                      | Anchored account/tombstone writes and fixed participant cleanup ledger; m identifies bounded source records per command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rows linear in m, constant statements for fixed m; logarithmic blocks in account and receipt history.                                                                                                                                                                                                                       | `test/access/growth-commands.test.ts`: “Tombstone erasure stays within its bound as m grows”                                                                                                                                                                                             |
| Membership inverse and durable join/leave work         | One inverse key/range and durable reserve, join, leave and release commands per member; fixed batch progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements per member step; total work linear in affected members, with logarithmic blocks in membership history.                                                                                                                                                                                             | `test/access/membership-work-growth.test.ts`: “real durable joins and leaves keep reserve join leave and release command and history work within the same bounds through the shared growth harness at scales 256 1024 and 4096”                                                          |
| Operator responsibility page                           | One `readPartition` point read on the operator anchor plus one keyset seek through `lifecycle_coordination_purpose_page(route, account_id, purpose, reservation_id)`, returning at most `limit + 1 <= 101` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                | Rows linear in the page limit, two data statements and one epoch read; blocks logarithmic in stored data S. There is no OFFSET, count, unrelated-account enumeration or all-page fetch.                                                                                                                                     | `test/access/growth-operator-cursor.test.ts`: “operator responsibility keyset seeks stay bounded with mixed-purpose history and unrelated reservations”                                                                                                                                  |
| Operator transfer, reserve, record, retire and release | Source/destination approvals, account anchors, exact responsibility rows and receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements per transfer; logarithmic blocks in each operator's responsibility history.                                                                                                                                                                                                                        | `test/access/growth-operator-transfer.test.ts`: “complete operator transfers stay bounded as unrelated accounts and both operators’ other responsibilities grow”                                                                                                                         |
| Organization close cleanup step                        | At most 100 membership rows after saved key cursor, with exact reservation and inverse updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rows linear in fixed batch per step; steps linear in target members; constant statements per row; unrelated organizations do not add work.                                                                                                                                                                                  | `test/access/growth-organization-close.test.ts`: “one deep cleanup page stays bounded as current, history and unrelated memberships grow”                                                                                                                                                |
| Operator fencing fanout                                | One fixed-size page of affected operator responsibilities and corresponding account fences.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rows linear in page size; statements linear in affected members; total work linear in fanout.                                                                                                                                                                                                                               | `test/access/growth-operator-fencing.test.ts`: “total operator fence fanout”                                                                                                                                                                                                             |
| Operator reinstatement                                 | Exact account/operator anchors, fixed responsibility page and durable fence/reinstatement checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows linear in page limit per step; total work linear in affected responsibilities; logarithmic blocks in history.                                                                                                                                                                                                          | `test/access/growth-operator-reinstatement.test.ts`: “${late ? 'late' : 'first'} reinstatement page stays bounded as unrelated accounts and earlier operator fence and reinstatement history grow”                                                                                       |
| Suspension                                             | Account/operator evidence, permission, write-rate stage/counter and fixed suspension receipt/update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Constant rows/statements per command; logarithmic blocks in accounts, grants and counters.                                                                                                                                                                                                                                  | `test/access/growth-suspension.test.ts`: “mounted suspension keeps full native formula, stage and counter cost bounded at 1/8/64 x 500”                                                                                                                                                  |
| Registration proof lookup                              | Exact registration reference and receipt lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements; logarithmic blocks in receipt history.                                                                                                                                                                                                                                                            | `test/access/growth-registration-proof.test.ts`: “reference lookup is bounded across receipt history”                                                                                                                                                                                    |
| Native account bindings and Auth registration          | Fixed registration/account keys, proof references and exact replay receipts; no receipt-history scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in old receipts and stages.                                                                                                                                                                                                                                                    | `test/access/growth-native-account-bindings.test.ts`: “fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow”                                                                                                                     |
| Native Auth barriers                                   | Account/session barrier point reads and exact receipt checks for same-account credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Constant rows/statements; logarithmic blocks in same-account receipts and unrelated accounts.                                                                                                                                                                                                                               | `test/access/growth-auth-barriers.test.ts`: “native Auth barriers stay bounded with same-account receipts and unrelated accounts at 1x 8x 64x”                                                                                                                                           |
| Operator session capability                            | Native adapter, command and Auth session point reads across opening/replay state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in opening history.                                                                                                                                                                                                                                                            | `test/access/growth-auth-session-capability.test.ts`: “native adapter to command to Auth session remains bounded across opening history, invalid locators and replay”                                                                                                                    |
| Credential capability                                  | Exact credential and account capability keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks in credential history.                                                                                                                                                                                                                                                         | `test/access/growth-auth-credential-capability.test.ts`: “credential capability growth stays fixed at 1x/8x/64x”                                                                                                                                                                         |
| Durable initiator restoration                          | Exact selected actor, assignment and captured operation tuple; K is fixed command event count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Constant rows/statements at fixed tuple/output/K; logarithmic blocks in account and assignment history.                                                                                                                                                                                                                     | `test/access/growth-durable-initiator.test.ts`: “native durable initiator ${mode}: ${person} ${relation}, fixed selected tuple/output/K”                                                                                                                                                 |
| Durable initiator capture                              | Delegated path reads one account/assignment point; non-delegated path reads none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Constant rows/statements; logarithmic blocks in accounts and assignments.                                                                                                                                                                                                                                                   | `test/access/growth-durable-initiator-capture.test.ts`: “capture adds ${delegated ? 'one point read' : 'zero reads'} at 1x/8x/64x accounts and assignments”                                                                                                                              |
| Recovery completion                                    | Exact receipt and account completion keys; no receipt history traversal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements; logarithmic blocks in receipt history.                                                                                                                                                                                                                                                            | `test/access/growth-recovery-completion.test.ts`: “native completion growth independent of receipt history”                                                                                                                                                                              |
| Direct reinstatement                                   | Account point read/update, selected suspension receipt and exact replay keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements; logarithmic blocks in unrelated accounts and suspension history.                                                                                                                                                                                                                                  | `test/access/growth-reinstatement.test.ts`: “reinstatement stays bounded as unrelated accounts and suspension history grow”                                                                                                                                                              |
| Workflow approvals and approved identity               | Exact approval/account keys and up to K command events; sweep reads a bounded approval page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Constant rows/statements per fixed K and page; logarithmic blocks in accounts and receipts.                                                                                                                                                                                                                                 | `test/access/growth-workflow-approvals.test.ts`: “${mode} stays bounded as ${population} grows with K fixed”                                                                                                                                                                             |
| Committed cleanup continuation                         | One exact continuation lookup or fixed fanout page completion and operated account keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Constant rows/statements per fixed page; logarithmic blocks in continuation and account history.                                                                                                                                                                                                                            | `test/access/growth-committed-continuation.test.ts`: “one fanout page completion stays bounded as unrelated continuations and operated accounts grow”                                                                                                                                    |
| Account preferences                                    | One account preference point read or one preference-key write; notification checks use the same exact account/key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Constant rows/statements; logarithmic blocks as accounts with stored preferences grow.                                                                                                                                                                                                                                      | `test/access/growth-preferences.test.ts`: “preferences read stays constant as accounts with stored preferences grow”; “setting a maximal shelf stays constant as accounts with stored preferences grow”; “notificationAllowed stays constant as accounts grow”                           |
| Rating counting keys                                   | One controller-version point read and HMAC per vote; a relation transfer adds one controller-version write and one outbox row, without enumerating votes or responsibilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements per account; logarithmic blocks in account and relation history.                                                                                                                                                                                                                                   | `test/access/growth-rating-counter.test.ts`: “counting keys stay constant as accounts and operated accounts grow”                                                                                                                                                                        |
| Account agent effect                                   | One account point read and one Semantic ensure command in the node partition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constant rows/statements per event; logarithmic blocks in accounts and subjects.                                                                                                                                                                                                                                            | `test/access/growth-account-agent-effect.test.ts`: “account agent effect growth stays within its bound at [256, 1024, 4096]”                                                                                                                                                             |
| Agent verification requests and pending page           | One anchored account read, unique pending probe and request insert; pending pages read at most limit + 1 indexed rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Constant rows/statements per request; page rows linear in page limit; logarithmic blocks in request history.                                                                                                                                                                                                                | `test/access/growth-agent-verification.test.ts`: “agent verification request stays bounded as decided requests grow”; “pending agent verification page stays bounded as decided requests grow”                                                                                           |
| Share account lock                                     | One account primary-key read with `FOR SHARE`, held until the caller's transaction commits or rolls back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Constant row and statement; logarithmic blocks in account index, independent of partition history.                                                                                                                                                                                                                          | Missing: the existing serialization test checks locking, not growth under unrelated same-partition account growth.                                                                                                                                                                       |
| Agent page pointer write                               | One exact pointer insertion or deletion keyed by subject and account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One row and statement; logarithmic blocks in subject pointers.                                                                                                                                                                                                                                                              | `test/access/growth-agent-page-lookup.test.ts`: “agent page pointer write stays within its bound as subject pointers grow”                                                                                                                                                               |
| Agent verification review and durable workflow         | Exact request/account decision keys, native stage SQL, and bounded reads/writes at each forward approval, withdrawal, reversal and release step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements per fixed step; logarithmic blocks in requests, accounts and pointers.                                                                                                                                                                                                                             | Missing: no growth check measures review commands, native workflow stage SQL and all durable steps together.                                                                                                                                                                             |
| Session revocation                                     | Exact account/session and revocation receipt keys for the native command and durable revocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements per command step; logarithmic blocks in account and session history.                                                                                                                                                                                                                               | Missing: no checkGrowth measures native session revocation and durable delivery as session and receipt history grow.                                                                                                                                                                     |
| Current consent binding                                | Native Auth current-consent read plus exact account binding evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Constant rows/statements; logarithmic blocks in consent and account keys.                                                                                                                                                                                                                                                   | Missing: Auth coverage does not measure the Kernel binding adapter end to end as binding history grows.                                                                                                                                                                                  |
| Handle transitions and registration expiry             | Exact handle-transition ledger key, account/registration anchor and saved durable checkpoint; no old claim scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Constant rows/statements per step; logarithmic blocks in account and transition history.                                                                                                                                                                                                                                    | Missing: no native transition and registration-expiry series measures growth across ledger history.                                                                                                                                                                                      |
| Handle holder lookup                                   | One exact handle claim lookup used by Space address resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Constant rows/statements; logarithmic blocks in handle and address histories.                                                                                                                                                                                                                                               | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”                                                                                                                                                    |
| Erasure acknowledgement                                | one point read locking the erasure row, one keyed insert of the acknowledgement with at most 16 exceptions (or lookup of the immutable existing acknowledgement), and at most one completion update in the account's partition, counting at most P acknowledgements.                                                                                                                                                                                                                                                                                                                                                                                            | Rows linear in P + X for participant count P and exceptions X ≤ 16; statements constant; blocks logarithmic in account history A. A duplicate uses the command's no-effect fence without advancing history.                                                                                                                 | `test/access/growth-erasure-coordinator.test.ts`: “erasure acknowledgement (${phase}) stays constant as accounts and completed erasures grow at three scales”                                                                                                                            |
| Retention resolution                                   | one keyed point update in the account's partition; its statement locks that acknowledgement and returns the existing resolution on replay without writing it again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Constant rows and statements; logarithmic blocks in account history A, with at most 16 exceptions in the acknowledgement.                                                                                                                                                                                                   | `test/access/growth-erasure-coordinator.test.ts`: “retention resolution (${phase}) stays constant as accounts, erasures and other accounts' exceptions grow at three scales”                                                                                                             |
| Erasure status read                                    | one statement reads the erasure record, at most P acknowledgements and their exceptions in one snapshot, and probes the open-late-item partial index. An unfinished erasure with a delivered frontier adds one ordered DBOS lookup using the frozen timestamp as a parameter; completed erasures need no workflow lookup.                                                                                                                                                                                                                                                                                                                                       | At most two statements; rows linear in P×X for participants P and exceptions X; logarithmic blocks in account history A and in-flight workflows W across D distinct locator priorities. Neither outbox history nor unrelated queues are read.                                                                               | `test/access/growth-erasure-coordinator.test.ts`: “erasure status costs one point read and at most P outcomes as accounts and completed erasures grow at three scales”                                                                                                                   |
| Record or resolve a late erasure item                  | one primary-key erasure probe and one primary-key late-item insert or update in the account's home; recording shares the caller's locator transaction, resolution uses one platform command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | constant statements and rows; logarithmic blocks as unrelated accounts, erasures and late items grow.                                                                                                                                                                                                                       | `test/access/growth-erasure-coordinator.test.ts`: “late item ${phase} has constant statements and rows at three scales of unrelated accounts and late items”                                                                                                                             |
| Advance erasure completion                             | one locked erasure key; once per erasure, one frontier snapshot statement over the fixed partition map; one keyed checkpoint probe per stored frontier partition; one ordered DBOS locator-queue lookup through `idx_workflow_status_in_flight_v2`; one open-late-item existence probe and the bounded acknowledgement count.                                                                                                                                                                                                                                                                                                                                   | constant statements and rows in account data and unrelated history; logarithmic blocks. The snapshot and stored frontier are bounded by the fixed partition map; the DBOS lookup costs one descent per distinct priority.                                                                                                   | `test/access/growth-erasure-coordinator.test.ts`: “completion with ${phase} frontier stays bounded as outbox history, erasures, late items and unrelated DBOS workflows grow”                                                                                                            |
| Close an organization                                  | the organization's account, hold and saturated owner reads, the actor's exact owner membership and one cleanup checkpoint, all anchored in the organization's partition. No member enumeration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | constant rows and statements, independent of member count; indexed probes use logarithmic buffers.                                                                                                                                                                                                                          | `test/access/growth-organization-close.test.ts`: “close has constant rows and statements as target and unrelated memberships grow”                                                                                                                                                       |
| Provisioning proof                                     | `createRegistrationProofBindings({pool,referenceKeys: KeyRing})`: `createProvisioningReference({input,outcome})` takes the exact `createPending` input `{accountId,key,handle,reservationId}` and awaited native `CommandOutcome`; `verifyProvisioningReceipt(reference)` verifies one core receipt via the trusted reader. Fixed internal principal, `access.actor-pending`, derived partition and route-prefixed key; digest, transaction, epoch/position and response must agree. `registration-proof-account.sql` binds the pending actor, handle, reservation, expiry and creation transaction, enforcing expiry at PostgreSQL time regardless of cleanup. | In stored data S: constant rows/statements, `O(log S)` buffers; at most 1 receipt, 1 account and 1 partition epoch/fence read. 3 data statements plus BEGIN/COMMIT; invalid keys/digests stop earlier. Seal input/output <=4096 chars. References confer no Auth authority/completion; no registry or Auth credential read. | `test/access/growth-registration-proof.test.ts`: “reference lookup is bounded across receipt history”                                                                                                                                                                                    |
| Open interval lookups                                  | one exact probe using the partial open-key btree or a temporal GiST key (`resource_denial_pkey`, `resource_denial_permission` or `resource_role_grant_pkey`). The base-table probe keeps both `upper_inf(valid)` and `valid @> T`, so the btree selects only the open row and GiST also excludes closed intervals for that key. Ending a denial repeats the time condition on the update. An insert also runs the temporal primary-key exclusion check.                                                                                                                                                                                                         | O(log R) per statement, constant rows and statements, independent of one key's closed history and unrelated keys under any selected index.                                                                                                                                                                                  | `test/access/growth-open-interval-history.test.ts`: “denial lookup stays bounded as recent closed history grows (${statistics})”; “denial lookup stays bounded as unrelated keys grow (${statistics})”; “repeated group role grants stay bounded as unrelated keys grow (${statistics})” |
| Governance bootstrap                                   | one native Global command to install the governance role and its receipt/outbox, followed by a separately authorized standing-parent command for `organization:create`. Replays recheck the role installation marker and the standing-parent marker; a conflicting operator is refused before the second command.                                                                                                                                                                                                                                                                                                                                               | constant rows and statements at fixed actor and Global anchors, with logarithmic buffers as unrelated accounts and Global grants grow. The integrated check observes four account rows on first install/replay and one on refusal; refusal performs only the initial command attempt.                                       | `test/access/growth-bootstrap-governance.test.ts`: “checkGrowth 1x/8x/64x ${mode}: native operator command and exact child CLI use bounded seeks”                                                                                                                                        |

Semantic identity job steps and participant-owned erasure cleanup have no row because those operations are not implemented on this base.

## Viewer preferences

Access stores one optional `account_preferences` row on the account's route and partition. Missing storage means
`{ "spoilerLevel": 0, "suitability": "blur", "shelf": {}, "notifications": { "reply": true, "mention": true }, "version": 0 }`.
Anonymous viewers use these defaults locally.

- `spoilerLevel` is the highest `rezics:spoilerLevel` displayed without a reveal control: 0 (none), 1 (minor), or
  2 (major). Summaries remain spoiler-safe regardless of this setting.
- `suitability` is `blur` (default) or `show`. With `blur`, covers and images withheld for suitability appear blurred
  behind a label and reveal control. `show` opts into displaying them. Content and semantic own classification;
  the web owns applying these values to Cover, relations and character displays.

- `shelf` holds the reader's shelf view choices so every device shows the same shelf. Access stores only what the
  account saved and never a default; web applies its own defaults for any absent part, and a URL value wins over the
  stored one. Every part is optional:
  - `layouts`: map from a type scope to `grid`, `list` or `table`. A key is `all` or an absolute IRI (a scheme, `:` and
    no whitespace) of at most 256 characters, such as `https://rezics.com/vocab/Book`. Keys are not checked against the
    catalogue, since types are configuration; web ignores an entry for a type it no longer shows. At most 32 entries.
  - `sorts`: map from a tab (`in_progress`, `planned`, `completed`, `paused`, `dropped`, `all`) to
    `{ "field", "direction" }`. `field` is one of `last_activity`, `added`, `finished`, `title`, `rating`,
    `release_date`, `progress`; `direction` is `asc` or `desc`. A stored entry always has both.
  - `gridSize`: `small`, `medium` or `large`.
  - `tableColumns`: an ordered list of 1 to 11 distinct keys from `cover`, `title`, `creator`, `type`, `status`,
    `progress`, `rating`, `added`, `started`, `finished`, `last_activity`.

  The column is `jsonb NOT NULL DEFAULT '{}'` with a check that it is an object of at most 16,384 bytes.

- `notifications` maps every optional in-app notification kind to its effective boolean, using the saved override
  or the catalogue default. [`notification-kinds.ts`](notification-kinds.ts) is the frozen catalogue: `reply` and
  `mention` are optional and enabled by default; `moderation_decision` is mandatory and cannot be turned off.
  Mandatory kinds are absent from this field. Content appends kinds to the catalogue, at most 32 total, with unique
  lowercase snake case keys and an `optional` flag and `default` boolean. Moderation decisions include the statement
  of reasons owed to a content author and the decision owed to a notifier. These preferences cover in-app notices;
  there is no email delivery.

  PATCH applies JSON Merge Patch (RFC 7396) over stored notification overrides: `true` or `false` sets one kind,
  `null` removes its override, and `notifications: null` clears all overrides. Mandatory or unknown keys and values
  other than booleans or null answer 400 and change nothing, including other fields in the same command. Only values
  differing from a kind's default are stored. An equal merged result with other settings unchanged preserves the
  version and writes no preference row. Storage is `jsonb NOT NULL DEFAULT '{}'`, checked to be an object of at most
  2,048 bytes.

`GET /v1/accounts/{accountId}/preferences` returns both settings, `shelf` (`{}` when nothing was saved, including
when the account has no row), `notifications` and `version`. `PATCH` accepts `expectedVersion` (required, a nonnegative
integer) and any of the settings, `shelf` and `notifications`. Omitted settings keep their current values.

`shelf` in a PATCH is a JSON Merge Patch (RFC 7396) applied to the stored shelf: an object merges key by key, `null`
removes that key (a part such as `gridSize`, or one `layouts` or `sorts` entry), and an array (`tableColumns`) replaces
the stored one. A sort entry may be patched by one of its fields when the stored entry exists. `shelf: null` clears the
whole shelf. Access checks the patch shape and the merged result against the rules above; a break (more than 32
layouts, a sort entry missing `field` or `direction`, an unknown key at any level, a value outside the allowed sets)
answers 400 and changes nothing. A patch whose merged shelf equals the stored one, with the other settings unchanged,
keeps the version and writes no row.

Both routes require the acting account to equal the path account, with `account:read` and `account:update` respectively. Grants to
another account do not bypass this equality check. An operator-opened session acts as its automated account and changes
that account's settings; the operator's own bearer cannot change them directly. Responses are private and not cached.

PATCH uses the structured-field `Idempotency-Key` header, the shared write-rate stage (one write unit), and `runCommand`.
A changed value increments the version once. Unchanged values preserve the version and write no preference row;
setting the initial defaults therefore leaves storage absent. Returning to the defaults after a change keeps the row
and its advancing version. Stale expected versions answer 409; reusing a key with different input answers 422.
Replaying a successful key returns its original values/version after current authorization, even if later commands
changed the preferences. Every successful response includes both settings, the shelf, notifications and the version,
and PATCH carries the session token for its command receipt. Each successful command emits the existing `account-updated` event with only
the account ID, keeping preference values out of the event data. Invalid values and unknown fields answer 400.

Read cost: one exact `(route, account_id)` primary-key seek, at most one row and one statement, with logarithmic
blocks in accounts plus a constant number of TOAST blocks, since the stored shelf is capped at 16,384 bytes and
notification overrides at 2,048 bytes.
Set cost: one preference row and the command envelope's receipt, with constant rows and statements; the merge is in
memory over at most 32 + 6 + 2 shelf entries and 32 notification kinds. Authentication and native authorization
retain their existing bounds. `test/access/growth-preferences.test.ts` grows accounts with stored
preferences, each holding a maximal shelf (32 layouts with 256-character keys, all six sorts, `gridSize` and 11
columns) and every optional notification kind overridden, at scales 256, 1024 and 4096 (16 accounts per scale unit,
to avoid tiny-table scans) using the shared harness and default warmups, for both the read and setting a maximal
shelf and all optional notifications.

Content calls `notificationAllowed(client, { recipient, kind }): Promise<boolean>`, exported from Access, at send
time. An unknown kind throws `TypeError` before any read. A missing, deleted or pending recipient returns false.
For any other state, including suspended, a mandatory kind returns true and an optional kind follows its effective
setting. Content still checks access to the item. The port uses one statement in the recipient's partition, joining
one account row to at most one preference row by `(route, account_id)`: constant rows and statements, logarithmic
blocks in accounts. `test/access/growth-preferences.test.ts` checks `notificationAllowed stays constant as accounts
grow`, seeding every optional kind overridden at the same scales with the shared harness.

## Direct resource role data

`resourceRoleHeld(client, { resource: { route, id }, role, accountId, at }): Promise<boolean>`, exported from
Access, reports whether the account has a direct identity `resource_role_grant` for that exact resource and role
whose temporal range contains the `AuthoritativeTime` at T, minted by a command attempt or `mintReadTime`.
The exact PostgreSQL timestamp text preserves microsecond precision. The start is inclusive and the end is exclusive; revocation
ends the range. Group-held grants (owner or member), `active_accounts` grants and account state are ignored, so
deletion consumers can read grants belonging to a tombstoned account.

This data-only port is not a permission check. The caller must already have authorized the read and must not
disclose the answer to anyone else. It uses the caller's open query client and snapshot, opening no connection or
transaction. Invalid resource routes, unroutable account UUIDs, malformed roles or roles longer than 128 characters,
and times that were not minted throw `TypeError` before any read. `Date` and string times are rejected.

The one `SELECT EXISTS` statement probes the temporal primary key's equality columns plus `valid @> at` in the
resource's partition: constant rows and statements, logarithmic blocks in role grants.
`test/access/growth-resource-role-held.test.ts` checks this at three scales with unrelated grants on the same
resource, other resources and ended ranges for the same account.

## Rating counting key

Trusted kernel composition constructs `const ratingCounter = createRatingCounter({ secret })` (exported from
Access), supplying a private `Uint8Array` of at least 32 random bytes. Use the same stable secret across kernel
processes and restarts; changing it requires re-keying stored rating populations. There is no default secret.

The internal port has signature `ratingCounter(client, accountId, at): Promise<string>`. `client` is the caller's
PostgreSQL query client; `at` is a `Date` or PostgreSQL timestamp string on the authoritative T timeline. Keep event
T strings intact to preserve microseconds. A missing account rejects. The result is the lowercase hexadecimal
HMAC-SHA256 of `access.rating-counter.v1` followed by a NUL and the canonical controller UUID. An automated account's
controller is its operator at T; every other account controls itself. The separate private `controller_id` account
field is not this rating relation. Only key equality has meaning to rating. The key is never an account ID and must
never be returned by a route, put in an event or log, or interpreted as authority. Rating may store it privately in
its vote population; choosing the latest vote per key belongs to rating.

`rating-counter.sql` reads one controller version through
`rating_counter_controller_pkey(route, account_id, effective_at)`, seeking the latest version at or before T with
`LIMIT 1`. This private account relation projection retains prior controllers so delayed vote events and paged
recounts remain correct after later transfers. Account insertion and migration establish the baseline relation;
pre-migration history is unavailable. Relation recording and native account deletion write their exact command T,
inclusive at the boundary. Removing the operator relation records the account's own controller; direct removals use
database transaction time.

Each successful `recordOperatorRelation`, including initial automation, appends exactly one
`com.rezics.access.rating-counter.changed.v1` event alongside its existing relation event in the same native command
transaction and outbox envelope. Failed commands publish none; command receipt replay publishes no additional row.
The event's `subject` is the affected account's UUID string. Its data has exactly these fields:

- `accountId: string`: the affected automated account's canonical UUID, whose votes need re-keying.
- `at: string`: the transfer transaction's authoritative T as PostgreSQL ISO `timestamptz::text`, preserving up to
  six fractional digits and the time zone offset (for example `2026-10-26 12:00:00.123456+00`). This is the inclusive
  instant from which `ratingCounter(client, accountId, at)` returns the new controller's key.

The guarantee is one durable counter-change row per committed relation transfer, atomically with that transfer.
Outbox consumers may retry delivery and must deduplicate by the event ID or their existing checkpoint; delivery is
not an exactly-once invocation guarantee. Rating handles it with its paged recount. Neither the controller nor either
counting key appears in this event. Account erasure continues to use its existing lifecycle events.

## Agent pages

`GET /v1/agent-pages?cursor=&limit=` returns `{ agentPages, next }`, where each item is
`{ handle, kind, lastModified }`. The public route uses `account:read_public_identity`.
The limit defaults to 1000 and accepts integers from 1 through 1000. This 1,000 entry page limit is the
server-to-server sitemap exception to the shared list maximum of 100. `next` is an opaque
`encodeListCursor` cursor bound to the route, acting viewer and page size, or null at the end.
Cursors expire after 15 minutes. Omit `cursor` for the first page and keep the same limit while
continuing that walk.
Pages seek in `(route, account_id)` order through the partial `account_agent_pages` index:
only active, unfenced accounts with a handle are indexable.
Pending, suspended, fenced and deleted accounts never appear.

`account.public_changed_at` starts at `created_at`, including for existing accounts.
The single `account_public_change` BEFORE INSERT OR UPDATE trigger initializes it and
advances it on changes to the account columns used by `account-public-read.sql`, including
visibility guards. Other updates, unchanged public values and direct timestamp assignments
preserve it. Keep the trigger's comparison aligned with that read.
The feed's `lastModified` covers the account's own identity;
activity lists on the handle page belong to their owning modules and are outside this feed.

## Deletion

Access follows the [platform deletion policy](../../../../docs/deletion.md). It owns no user-authored content,
so nothing in Access is soft-deleted in that policy's sense; its records describe identity and authority
([schema](../../db/access/schema.sql)).

- **Records.** Person deletion, automated-account deletion by its operator's manager and organization close all
  cross the terminal account barrier in [lifecycle.ts](lifecycle.ts) and [lifecycle-fence.sql](lifecycle-fence.sql).
  Grant and role-grant revocation and membership removal change authority rather than delete a user-owned record
  under the policy, even where SQL physically removes a row ([grant-revoke.sql](grant-revoke.sql),
  [role-grant-mutate.sql](role-grant-mutate.sql), [lifecycle-membership.sql](lifecycle-membership.sql) and
  [`close_membership_authority` in the schema](../../db/access/schema.sql)). A new grant or membership restores
  authority, subject to current authorization ([grant-commands.ts](grant-commands.ts), [grant-create.sql](grant-create.sql),
  [role-grant-mutate.sql](role-grant-mutate.sql), [lifecycle-member-insert.sql](lifecycle-member-insert.sql) and
  [lifecycle.ts](lifecycle.ts)). A former handle redirects for 30 days: `HANDLE_REDIRECT_TTL_MS` in
  [lifecycle.ts](lifecycle.ts) sets the reservation deadline, and [handle-holder.sql](handle-holder.sql) excludes
  expired redirects; expiry does not itself purge the claim.
- **Restore.** There is no restore after the barrier: [lifecycle.ts](lifecycle.ts) requires an active account for
  tombstone, and [lifecycle-fence.sql](lifecycle-fence.sql) makes it deleted and fenced. As
  [Account deletion policy](#account-deletion-policy) states, fresh confirmation before the barrier replaces the
  policy's restore window for accounts. Account erasure starts at T and does not wait for any window. Access starts
  purging identity fields at that barrier; unresolved stores and deadlines remain in
  [Known retention gaps](#known-retention-gaps).
- **Minimal purge.** [lifecycle-fence.sql](lifecycle-fence.sql) clears the identity/profile group and retains the
  account skeleton plus the residual fields listed in the [retention inventory](#retention-inventory), rather
  than deleting the account row. The public skeleton is `{ id, state, kind }` under
  [Account deletion policy](#account-deletion-policy); [account-data.ts](account-data.ts) and
  [public-identity-page.sql](public-identity-page.sql) withhold the former identity, with the extra null/false
  projection fields recorded in [Known retention gaps](#known-retention-gaps). Clearing personal fields while
  retaining the skeleton is the policy's minimal purge; it does not settle the residual retention gaps.
- **Purge bounds.** The barrier statement clears a constant number of fields in one account row
  ([lifecycle-fence.sql](lifecycle-fence.sql)). Consumers of `com.rezics.access.account-tombstoned.v1` purge in
  idempotent bounded steps, as described in [Erasure consumers](#erasure-consumers); for example,
  [organization-close-work.ts](organization-close-work.ts) records page receipts and schedules stable workflow
  identities. A per-step bound is not a completion deadline; open retention and deadline items remain in
  [Known retention gaps](#known-retention-gaps).

## Account deletion policy

Deletion is terminal. Before the deletion barrier, the person must confirm freshly after being told the
consequences; after the barrier there is no cancellation window. A future reversible deactivation would be a
separate state, never restoration of a deleted account. The sources discussed in the
[deletion report, §1](../../../../docs/research/account-deletion.md#1-cooling-off-and-cancellation-matches-an-established-pattern)
share no cooling-off rule. A committed continuation's expiry limits cleanup authority, not the person's choice.
Expired cleanup leaves the account deleted; governance renewal continues the unfinished steps.
The erasure protocol, participants and completion are defined in [Deletion](../../../../docs/deletion.md#account-erasure).

There is no self-serve export at launch. Before or after deletion, a person may request a copy of their data through
the platform's privacy contact. The deletion confirmation names that channel. Self-serve export is a later feature
of each data owner. The confirmation also describes the terminal barrier, retained contributions and attribution,
operator/ownership consequences, and lists every owned OAuth client. Owned OAuth clients are deleted with the
account through the [Auth schema](../../../auth/db/schema.sql)'s `auth_client_userId_fkey` cascade; this ends other
people's grants to those clients as well. The physical cleanup gaps below and in [Auth](../../../auth/README.md#known-retention-gaps)
remain work to do, not exceptions to the policy.

A deleted account's public identity is `{ id, state, kind }` only. Readers see “Deleted account” or
“Deleted organization”, never the old name, handle or profile, and never a person-or-automated label. This is
**de-identified attribution**, not anonymous data: the stable id can still link retained content. Posts and reviews
remain subject to [Content's erasure rules](../content/README.md#subject-threads), and catalogue history to
[Semantic's history rules](../semantic/README.md). Where those documents do not state an account-deletion retention
rule, the owner decides; account deletion does not invent a content or catalogue erasure cascade.

Deleting an account purges all of its private Library data and its private, unlisted and deleted Collections.
Active public Collections stay, with their current notes, as frozen, de-identified contributions. Published reading
logs are erased. No replacement curator is appointed. Authority ends at the deletion barrier; the Library's tombstone
consumer cleans up asynchronously.
The [Library README](../library/README.md) documents the mechanism and the Library's own consumer. The deletion
confirmation states exactly what is erased and what stays as de-identified public contributions, next to the
privacy contact.

Statutory erasure requests are separate from product deletion. A missing export, a last-owner dispute, a suspension
or a pending bot handoff never delays the legal response. Product eligibility and cleanup authority are not the
privacy contact's response clock.

## Retention inventory

### Shared-history stores

The shared-history participant covers `command-receipt/v1`, `outbox-event/v1` and `durable-work/v1`. Receipt
skeletons retain receipt identity, principal and command identity, request digest, transaction and observed position,
and a versioned keyed-hash replay token; the raw idempotency key and response payload are removed. Event skeletons
retain stable partition, position and event sequence plus type and schema version, with personal payload and subject
removed. Durable-work history is canceled and deleted through supported DBOS APIs after native obligations are
settled or transferred. Locator discovery is sealed to the committed `access.erasure` obligation and visits the
fixed 4,096 partitions one at a time, seeking only the account prefix. These are required dispositions, not current
runtime behavior: producer coverage, minimization, removal and the final shared-history acknowledgement remain open
gaps. Semantic provenance has its own owner and retention rules; content and delivery custody, including media and
caches, remain separate obligations.

This inventory describes current storage and implemented cleanup, including account-linked ids, digests and
payloads that remain personal data. A retention purpose describes the store's operational use, not a new legal
basis or permission for indefinite retention. “No deadline” means no enforced erasure deadline was found. Expiry
of authority, a closed validity interval or a terminal flag does not itself erase a row. Except where noted, the
[Access schema](../../db/access/schema.sql) has no account-deletion cascade. Auth has its
[own inventory](../../../auth/README.md#retention-inventory); other domains decide their own data lifetimes.

The dispositions below describe the current implementation, not completion of the
[Access and Auth participant contract](../../../../docs/deletion.md#access-and-auth-participants). Schema citations
cover retained fields and the absence of a deletion trigger; command citations identify narrower cleanup. No gap
closes through this inventory. Its implementing capability must pass its named native acceptance test first.

### Identity and allocation stores

- `access.account`, subject profile: [the barrier](lifecycle-fence.sql) clears handle, name, avatars, biography,
  links, birth date, content preferences, suspension reason, registration and own operator/controller fields;
  public views and speaker listing become false. This is the immediate identity/write fence.
- `access.account`, subject residue: [the schema](../../db/access/schema.sql) retains id/kind, timestamps, epoch/fence,
  relation version/reservation, handle operation/change times, inverse status, rate tier and verification pointers.
  No complete residual-field purge or deadline exists; creation time is guarded against change.
- `access.account`, operator of another subject: [the barrier](lifecycle-fence.sql) changes only its own row;
  [operator lifecycle work](lifecycle.ts) handles responsibility release, without a reverse historical purge.
- `access.account`, controller of another subject: [controller history and account fields](../../db/access/schema.sql)
  retain the link; own tombstoning does not erase another account's stored relationship/history.
- `access.account_preferences`, owner: [the barrier](lifecycle-fence.sql) deletes private spoiler, suitability, shelf,
  notification and version data with the tombstone; fencing without tombstone preserves the row.
- `access.agent_page`, verified account: [account-agent effects](account-agent-effect.ts) wait for reversal/unmerge
  and label synchronization; [reversal](agent-verification.ts) removes the exact receipt-bound pointer. The
  [schema](../../db/access/schema.sql) has no account reverse index or general stale-pointer erasure sweep.
- `access.handle_claim`, current owner: [lifecycle commands](lifecycle.ts) retire the deleted account's current handle
  without forwarding. [The schema](../../db/access/schema.sql) still requires its account mapping.
- `access.handle_claim`, former owner: [reservation/expiry](lifecycle-handle-expire.sql) can release unclaimed holds;
  [handle retirement](lifecycle.ts) permanently reserves former allocations and limits forwarding to 30 days.
  The account, reservation/operation, expected-handle and transaction fields have no erasure scrub.
- `access.lifecycle_handle_operation`, subject: [the schema](../../db/access/schema.sql) retains terminal handle,
  reservation and replay state without an account-erasure trigger or deadline; purpose is handle recovery.
- `access.lifecycle_handle_effect`, subject: [the schema](../../db/access/schema.sql) retains handle/account,
  operation/reservation, effect and transaction evidence without account-erasure cleanup.
- `access.lifecycle_registration_expiry`, registrant: [the schema](../../db/access/schema.sql) retains expiry and
  reservation evidence without account-erasure cleanup; expiry does not physically erase the proof.

### Relationships and traversal stores

- `access.organization_member`, organization subject: [organization close](organization-close-work.ts) deletes
  membership history in [pages](organization-close-page.sql), then releases member inverses; no elapsed deadline.
- `access.organization_member`, member: [membership closure](../../db/access/schema.sql) ends authority intervals;
  historical intervals in surviving organizations have no member-erasure purge or deadline.
- `access.lifecycle_membership_slot`, organization subject: [close pages](organization-close-page.sql) terminalize
  slots; [the terminal guard](../../db/access/schema.sql) preserves them and rejects their deletion.
- `access.lifecycle_membership_slot`, member: [the schema](../../db/access/schema.sql) retains historical reservations
  and terminal state in organization partitions, without member-erasure cleanup.
- `access.membership_inverse`, member: [verified release](membership-inverse-20261025093747-release.sql) removes the
  live inverse using exact terminal proof. This locates current relationships, not every historical interval.
- `access.membership_inverse`, group account: [organization-close work](organization-close-work.ts) finishes exact
  member-side release; completion depends on native work, without an erasure deadline.
- `access.membership_inverse_terminal`, member: [the schema](../../db/access/schema.sql) keeps immutable account,
  reservation and transaction release proof; no physical purge or deadline.
- `access.membership_inverse_terminal`, group account: [the schema](../../db/access/schema.sql) retains the group link
  even after the live inverse is gone; no reverse erasure cleanup.
- `access.lifecycle_coordination`, owning account: [operator release](operator-release.sql) and
  [membership release](lifecycle-membership-release.sql) delete exact holds on successful native release, without TTL.
- `access.lifecycle_coordination`, related member: [the schema](../../db/access/schema.sql) retains related-account
  reservations in the owner's partition until release, without reverse-role erasure or a deadline.
- `access.lifecycle_coordination`, related operator: [the schema](../../db/access/schema.sql) has the same hold and
  release dependency; deleting this related account does not itself purge the owner's hold.
- `access.lifecycle_coordination`, related organization: [membership release](lifecycle-membership-release.sql)
  removes the exact resolved hold; no complete historical organization-role sweep exists in the schema.
- `access.operator_relation_slot`, subject: [the schema](../../db/access/schema.sql) retains terminal relation slots,
  reservations and transactions; no account-erasure cleanup.
- `access.operator_relation_slot`, operator: [the schema](../../db/access/schema.sql) retains old operators on other
  subjects' slots, without reverse-role cleanup.
- `access.organization_close`, organization subject: [the finish update](organization-close-finish.sql) marks progress
  complete but retains handle, receipt/key and cursor in [the row](../../db/access/schema.sql).
- `access.organization_close`, cursor member: [the page writer](organization-close-page.sql) stores the last member
  id and validity boundary; no member-erasure cursor cutover exists. It is a surviving organization's work.
- `access.principal_assignment`, principal/granter/creator: [the schema](../../db/access/schema.sql) constrains
  `creator_principal_id = principal_id`; revocation closes validity but preserves assignment/replay provenance.
- `access.principal_assignment`, assigned actor/delegate: [the schema](../../db/access/schema.sql) retains active and
  revoked actor links; the live speaker index excludes revoked rows and is not complete erasure discovery.

### Permission and provenance stores

The grant tables have no granter column ([schema](../../db/access/schema.sql)); granter identity is in command
provenance, inventoried under shared stores below. Erasing a granter preserves surviving recipients' permissions,
as required by the participant contract, while subject/account-resource grants are removed.

- `access.resource_grant`, identity/member/organization subject: [grant commands](grant-commands.ts) can revoke selected grants;
  [the schema](../../db/access/schema.sql) has no account-erasure purge covering every validity interval.
- `access.resource_grant`, account resource: [the schema](../../db/access/schema.sql) retains resource permissions
  without a deleted-resource purge. Sentinel subjects do not identify an account.
- `access.resource_role_grant`, identity/member/organization subject: [the schema](../../db/access/schema.sql) retains
  role/validity payload outside selected role mutations; no all-history account-erasure sweep.
- `access.resource_role_grant`, account resource: [the schema](../../db/access/schema.sql) has no deleted-resource purge.
- `access.resource_denial`, subject: [the schema](../../db/access/schema.sql) retains private reasons, scope and
  temporal ban/suspension history, without an account-erasure deadline or adopted moderation exception.
- `access.resource_denial`, account resource: [the schema](../../db/access/schema.sql) has no deleted-resource purge.
- `access.resource_initialization`, resource account: [the schema](../../db/access/schema.sql) retains initialization
  after account deletion, with no child-before-parent erasure path.
- `access.resource_initialization`, creator of a surviving resource: [the schema](../../db/access/schema.sql) requires
  creator attribution and retains it; there is no terminal minimization to a platform-origin marker.
- `access.standing_parent_installation`, account resource: [the schema](../../db/access/schema.sql) retains standing
  installation state without account-erasure cleanup; surviving resources' installations are separate obligations.
- `access.governance_bootstrap`, bootstrap actor: [the schema](../../db/access/schema.sql) retains the actor and singleton
  completion fence; no actor minimization exists. The fence prevents a second bootstrap.
- `access.governance_reach`, actor/acting human: [the schema](../../db/access/schema.sql) retains action, resource and
  transaction reach evidence without erasure cleanup.
- `access.governance_reach`, operator: [the same schema](../../db/access/schema.sql) retains operator-origin reach
  provenance; it has no separate reverse-role purge.
- `access.governance_reach`, account resource: [the schema](../../db/access/schema.sql) retains transaction-led reach
  records without resource-account erasure cleanup.
- `access.rating_counter_controller`, subject: [the controller trigger](../../db/access/schema.sql) records effective
  controller history, without account-erasure cleanup or a retention duration.
- `access.rating_counter_controller`, controller/operator: [the schema](../../db/access/schema.sql) retains historical
  links on surviving subjects; no reverse-role purge exists.

### Proof and review stores

- `access.lifecycle_fence_receipt`, subject: [the barrier](lifecycle-fence.sql) writes epoch, kind, operator and
  transaction evidence; [the schema](../../db/access/schema.sql) has no payload minimization/purge deadline.
- `access.lifecycle_fence_receipt`, prior/current operator: [the schema](../../db/access/schema.sql) retains the links
  on other subjects' receipts, with no reverse-role cleanup.
- `access.credential_floor_receipt`, credential subject: [the schema](../../db/access/schema.sql) retains opening,
  operation, epoch and transaction evidence without cleanup; linked opening human/operator roles also lead here.
- `access.credential_floor_receipt`, linked opening's acting human/operator: [the schema](../../db/access/schema.sql)
  retains the opening reference without an indexed child relation covering its full subject/route or reverse-role purge.
- `access.operator_opening_receipt`, operator: [the schema](../../db/access/schema.sql) expires authority in at most
  60 seconds but retains scope, session/credential binding, relation/reservation and transaction payload.
- `access.operator_opening_receipt`, acting human: [the schema](../../db/access/schema.sql) retains the human on a
  surviving operator's opening; no reverse-role erasure exists.
- `access.operator_opening_receipt`, subject: [the schema](../../db/access/schema.sql) retains the subject outside its
  own route, with no subject-erasure purge.
- `access.operator_opening_receipt`, requested-by principal/delegate: [the schema](../../db/access/schema.sql) retains
  the delegation reference after expiry, without a resolved account-role locator or erasure cleanup.
- `access.workflow_approval`, actor: [the schema](../../db/access/schema.sql) bounds authority to 300 seconds (60 for
  credential approval); [the expiry sweep](workflow-approvals-sweep.sql) deletes expired rows when invoked, without
  a registered completion guarantee.
- `access.workflow_approval`, operation subject/operator/member/delegate/requested-by: [the schema](../../db/access/schema.sql)
  retains operation JSON and delegation references without typed role discovery or account-erasure cleanup.
- `access.committed_continuation`, owner: [continuation commands](committed-continuations.ts) refuse expired authority
  but preserve roots through completion/renewal; no physical erasure path or deadline.
- `access.committed_continuation`, prior operator/allowlist target: [the schema](../../db/access/schema.sql) retains
  prior relation/handle, reservation, digest and target JSON, without role-complete native discovery.
- `access.committed_continuation_entry`, target/key subject: [the schema](../../db/access/schema.sql) preserves immutable
  allowlist children, without physical erasure after consumers finish.
- `access.committed_continuation_completion`, target/receipt subject: [the schema](../../db/access/schema.sql) preserves
  immutable receipt/completion payload, without a consumer-aware purge.
- `access.operator_fence_page`, continuation owner: [the schema](../../db/access/schema.sql) retains immutable finite
  allowlists and page proofs without cleanup.
- `access.operator_fence_page`, allowlisted subject/cursor account: [the schema](../../db/access/schema.sql) retains
  account-bearing cursors and allowlists even after expiry/completion, without typed role cleanup.
- `access.agent_verification_request`, subject: [review commands](agent-verification.ts) change state but retain
  statement, links, catalogue linkage, decision/problem details and receipts; no evidence-erasure deadline.
- `access.agent_verification_request`, requester: [the schema](../../db/access/schema.sql) requires requester attribution
  on surviving subjects' requests, with no requester minimization.
- `access.agent_verification_request`, reviewer/acting human: [the schema](../../db/access/schema.sql) retains reviewer,
  reason and problem details; no reverse-role erasure or adopted evidence expiry.

### Rate, completion and shared stores

- `access.write_rate_counter`, authenticated account: [identity derivation](write-rate-identity.ts) HMACs the account;
  [expiry SQL](write-rate-expiry.sql) removes eligible digests/families 48 hours after expiry. The
  [optional partition scheduler](write-rate-expiry.ts) visits one of sixteen routes per minute, sharing a 1000-row
  budget with chunks. No account-specific purge, old-secret attribution coverage or backlog deadline exists.
- `access.write_rate_chunk`, authenticated account: [the schema](../../db/access/schema.sql) stores the same digest plus
  operation/chunk key; [expiry SQL](write-rate-expiry.sql) deletes it independently in that shared budget, without a
  counter cascade or account-erasure guarantee. Anonymous transport buckets are not uniquely account-owned.
- `access.erasure`, terminal subject: [the coordinator](erasure.ts) and [schema guard](../../db/access/schema.sql) keep
  route/account, T, participant version and completion timestamp permanently; the tombstone creates the obligation.
- `access.erasure_acknowledgement`, subject/participant: [the coordinator](erasure.ts) and
  [schema guard](../../db/access/schema.sql) preserve immutable outcomes and bounded retention/resolution evidence;
  the primitive does not establish that Access's own residue phases have run.
- `core.receipt`, subject/actor/delegate/granter/operator/reviewer/member: [the core schema](../../db/schema.sql) retains
  command key, digest, principal, response JSON and transaction/time for replay, with no account-erasure trigger.
- `core.outbox`, subject/actor/delegate/granter/operator/reviewer/member: [the core schema](../../db/schema.sql) retains
  event payload and transaction/time, including non-actor event subjects, without account-erasure minimization.
- `editorial.write_basis`, actor/delegated principal/granter/operator/member: [the core schema](../../db/schema.sql)
  retains client/principal/requested-by and transaction provenance, without role-complete erasure cleanup.
- Kernel DBOS workflow/status/input/result/step/event/message copies, every business-input/result role above:
  [terminal retention](../work/retention.ts) uses `KERNEL_WORKFLOW_RETENTION_DAYS` (default 30, range 7–365), every ten
  minutes, at most 60 batches of 1000. Running work remains; there is no account-specific scrub or backlog deadline.

`membership_inverse_coverage` is a view over `account`, not another stored copy; `access.exposure_opening` stores
platform intervals without native account ids ([schema](../../db/access/schema.sql)). Its actor/granter provenance
is still personal data in shared copies.

Required protocol metadata is not implemented in [the current schema](../../db/access/schema.sql): erasure
phase/progress/coverage and immutable outcome state (terminal subject); `operator_opening_account` (requested-by
principal/delegate plus opening roles); `workflow_approval_account` (actor, subject, operator, member and delegate);
`continuation_account` and full-key page associations (owner, prior operator and allowlist targets); rate digest
bindings by secret generation (authenticated account); atomic copy locators (all producer roles); and independent
traversal ordinals with removable id bindings (organization members and operator-page subjects). Their disposition
must follow the participant contract: temporary locators/progress are removed after consumption, minimal native
completion/refusal survives outside DBOS, and cursor boundaries never retain account ids. These requirements do
not claim that existing payloads are already minimized or that shared-history handoff exists.

### Known retention gaps

- Backup expiry is an open external condition: no backup retention policy exists, so the coordinator does not model it.

- Access has no takedown of a single profile field (display name, avatar, biography or links) in [lifecycle.ts](lifecycle.ts); under the [policy](../../../../docs/deletion.md), a takedown would withhold only the field the notice covers and keep the data.
- `access.account` residual relationship, verification and operation fields have no complete deletion minimization rule or deadline.
- Handle-based reads of retired and deleted handles return the same empty list as unknown handles; ids reads retain the exact three-field deletion identity.
- The deleted handle projection in [account-data.ts](account-data.ts) still returns extra null/false fields, including `automated`; convergence to the policy's exact three-field identity is separate implementation work.
- Former-handle allocation records intentionally remain after their 30-day forwarding period to prevent impersonation; historical handle operation/effect/registration-expiry rows have no scrub or purge deadline.
- Membership history, terminal slots/proofs and principal assignments have no erasure schedule; live inverse/coordination cleanup depends on workflow completion without a deadline.
- Grants/role grants, denials, resource initialization/standing records and governance provenance have no account-deletion retention schedule; retained denial reasons also need minimization.
- Rating controller history has no erasure trigger or justified retention duration.
- Fence, credential-floor and operator-opening receipts have no erasure/minimization schedule; expired opening authority leaves personal payloads stored.
- Workflow approval expiry has a sweep primitive but no registered scheduler or bounded erasure deadline.
- Continuation roots, children, completions and fan-out pages retain prior handles/relations indefinitely. No alert was found for a committed deletion continuation expiring before cleanup finishes; governance renewal exists but is not an alert.
- Verification requests/evidence, reviewer reasons and failure details have no deletion or retention deadline; a field for the decision reason alone does not ensure the policy's evidence-check record or outcome notification.
- Write-rate cleanup is optional per deployment partition and batch-limited; no deadline covers missing admission, contention or backlog.
- Shared receipts, outbox events and write-basis records retain personal payloads without an erasure schedule; their operational purposes do not settle indefinite personal-data retention.
- Kernel workflow retention covers terminal work only, with no deletion-specific scrub, stuck-work deadline or backlog guarantee.
- Logs and telemetry outside these stores have no documented account-data inventory, erasure trigger or retention deadline here.
- Backups/replicas and restore procedures have no documented expiry or deletion-replay barrier. A restored backup could bring back a deleted identity; prevention is not demonstrated.
- The platform privacy contact must be published and named in deletion confirmation; these services do not define its address or a request-tracking/response process. Owner-provided self-serve export remains future work.

### Late erasure items and completion cost

- Recording or resolving touches one erasure primary-key probe and one keyed late-item insert or update. Statements
  and rows are constant; blocks are logarithmic as unrelated erasures and late items grow.
- Completion probes the open-item partial index, at most one checkpoint per stored backlog partition, the bounded
  acknowledgement range, and the open locator-work partial index. The one-time snapshot is bounded by the fixed partition map.
  Outbox history is never read. Statements and rows are constant with unrelated data and history; blocks are
  logarithmic for fixed frontier cardinality.
- Growth evidence: `test/access/growth-erasure-coordinator.test.ts`, three scales with the account and frontier fixed.
