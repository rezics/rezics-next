# Access

## Fixed Global viewer-action bindings

Mounted resource-authority metadata may declare `x-authority-resource-id` only as the canonical
`PLATFORM_RESOURCE.id` (`00000000-0000-8000-8000-000000000000`), with exactly
`x-authority-resource-types: ['semantic.context']` and no `x-account-authority` override. An omitted
`x-authority-anchor` retains the existing resource default; `own-account` is incompatible. Other IDs,
missing authority types and other type combinations fail constructor compilation. This is the actual
fixed Global Context, not a new resource type or permission floor.

The existing `exposure.open` and `exposure.close` operations publish this declaration. Compilation retains
it as `ViewerActionBinding.fixedResourceId`. Native viewer actions discard inapplicable bindings before
preparation and gate/candidate work, and restrict mixed-batch action decisions and operation entries to
the matching native reference. All existing resource existence/privacy, current T, scopes, principal,
floor, explicit grants and denials still apply. Command authorization and receipt handling are unchanged.

Consumers obtain both the type and fixed ID from the genuine mounted declaration, then request the existing
`viewerActions` batch for that exact reference. Only an exact action and operation pair offers the control.
Neither discovery/admission nor a configuration management read grants mutation authority; viewer actions
also convey no current exposure state. Actual state must come from the sole native management read.

The default Context viewer reader is deliberately limited to Global. `fixedGlobalViewerResource` accepts
Semantic's canonical `globalContextAnchor`; on the existing native checkout it validates actual existence
with the same opaque `AuthoritativeTime` used by the viewer action decisions. The optional fourth `read`
argument carries that token without changing three-argument owner readers. Missing/expired time fails before
IO; missing Global and all other Contexts are absent. Native errors retain the existing typed unavailable
response. The viewer request releases its time only after preparation, owner reads and final authorization
finish. The default never replaces a trusted supplied full `semantic.context` reader, and other duplicate
registrations still fail. Existence supplies ordinary Context read eligibility, never mutation authority.

The native fixed-binding fixture supplies a trusted Context reader through `viewerActionResources` so it can
attest a real non-Global Context using Semantic's `editorialContextAnchor(id)` and the same live viewer time.
Only `ContextNotFoundError` means absence; other Source failures propagate. This fixture composition leaves
the production Global-only default and the missing/private resource outcomes unchanged.

## Native work admission

`access/work.ts` owns the additive accounting port. It has no dependency on the Source interpreter and no
numeric allowance. Its exact structural dimensions are `{keys, points, witnesses, rows, bytes, emptySeeks}`.
The caller supplies its existing ledger through `AccessWorkSink.reserve(operation, bound, kind)`, which either refuses
with `null` or returns a one-shot `settle(actual)` reservation. `kind` is exactly `'native' | 'owner'`:
the former dispatches an Access-owned native operation; the latter holds an envelope for the resource owner's
actual dispatched operations. A thrown admission error also prevents dispatch.
Instantiate `new AccessWorkAccounting(sink, fixedRequestDeadline)` and supply it as `AccessContext.work`.
The accumulator never grants authority; existing native identity, opaque eligibility, principal, scope and formula
checks remain mandatory. The ordinary signatures and behavior without `work` are unchanged.

The supported producer is the installed `createAccess` implementation, including its ordinary `prepare`,
`preparePage`, `authorize`, `authorizePage`, `authorizeExplicit` and `prepareReadDecisions().decide` methods.
Metered preparation requires the caller's already-live native `AuthoritativeTime`: `context.time` for individual
and homogeneous page preparation, `input.time` for read-decision windows (and matching `context.time` if supplied).
Final checks must receive that SAME object. Access does not mint another native clock or exempt epoch checks.
The caller owns admission of its original clock read and resource checkout; Access admits its own time query,
independent checkouts/waits, assignment, inverse, candidate, organization role and final formula statements.
Prepared role/assignment metadata can be shared within this live window and its original evidence TTL/deadline;
each target/scope/denial decision still executes the same `permission-check.sql` at final T. A homogeneous page
prepares once for its bounded ids. A read-decision window prepares inventory once and executes a fresh final
formula for each bounded target batch; it stores no allowed boolean.

`await work.capture(operation)` returns the closed union:

```ts
type AccessWorkResult<T> =
  | { state: 'complete'; value: T; usage: AccessWork }
  | { state: 'unavailable'; dependency: string; usage: AccessWork }
  | { state: 'failed'; error: unknown; usage: AccessWork };
```

For example, capture ordinary preparation with its metered context, then capture the ordinary final authorize
call using its returned evidence and the same live T. `false` is a complete denial, with its actual usage.
`usage` is cumulative across preparation and final checks, including rejected candidates and failed operations.
`work.usage()` exposes the same immutable receipt when preserving the ordinary throwing API. Do not add a
captured cumulative receipt to the ledger again: the sink already receives per-operation settlement.

Reservations precede dispatch, including owner callbacks and explicit pool acquisition. Dispatched native rows
are the owner-declared plan bound, also on empty output, and cannot be refunded using result cardinality. Completed
statements settle actual serialized parameter/projection bytes and their outer empty seek; this is not a claim of
measured PostgreSQL physical tuples. Unknown failed work consumes its entire admitted bound and poisons reuse.
An enclosing timeout seals every pending bound before returning; a late callback cannot refund unknown work or
issue another reservation. Foreign owners must account all their nested operations within their declaration;
Access does not inspect their SQL or substitute result rows for work.

`AccessWorkProducer<C,R>` is exactly `{bound(context: C): AccessWork | undefined;
actual(context: C, result: R): AccessWork | undefined}`. Both functions are synchronous, pure accounting metadata;
the owner binds the actual receipt to this exact invocation, including zero-IO results. Access reserves `bound`
before invoking the ORIGINAL callback, then settles the actual receipt. Missing/invalid receipts retain the
full bound and fail the attempt. A completed owner envelope can release work for branches that never dispatched;
its receipt must retain every nested native statement's charged plan rows. This differs from refunding dispatched
native rows using a result row count. There is no blanket callback estimate. The native owner integration points are:

- `ResourceEligibilityOptions.work.{prepare,verify}` for the SAME Content/resource eligibility callbacks.
- `ReadDecisionEligibility.work`, with context `{client,ids,at}`, for native batch resource eligibility.
- `AccessRealmRoleReader.work` / `.batchWork` for the original Realm single / batch callback inputs.
- `AccessConfig.contentEditionBuyerFactWork` for the original Commerce buyer fact reader input/result.

A missing declaration refuses BEFORE that callback, with `AccessWorkUnavailableError.dependency` naming
`Content resource eligibility.prepare`, `Content resource eligibility.verify`, `Resource ReadDecisionEligibility`,
`Content AccessRealmRoleReader`, `Content AccessRealmRoleReader.batch`, or `Commerce ContentEditionBuyerFactReader`.
No foreign native implementation is claimed by publishing these ports.

`accessCheck` preserves its ordinary `(client, time?) => Promise<boolean>` call. Native checks prepared with
live `AccessContext.time` and the existing `AccessContext.work` additionally expose optional `.work`:
`PreparedAccessCheckWork` is an `AccessWorkProducer<PreparedAccessCheckInvocation, boolean>` with
`run(input): Promise<boolean>`, where `input` is exactly `{client, time, work}`. These types are exported from
the original `access/index.ts`. Manual and foreign checks can omit the property.

Prepare on the released pool before acquiring the target client. The native producer's pure `bound(input)`
combines the existing mounted formula declaration with the original eligibility owner's verify declaration,
using the actual prepared roles, assignment, buyer, resource and deadline evidence. Undefined means unsupported
before nested IO. Unmetered preparation cannot acquire a declaration afterward. The invocation must retain the
same accounting and live native time object as preparation; a formatted `at`, copied time or cached permission
cannot substitute for it. Both eligibility contexts now carry optional `time` and `work`; verify retains its
ordinary formatted `at`. These fields come from the evaluator, including at preparation.

Call `.work.run(input)` to invoke the same native authorizer on the supplied target client. Its synchronous
`.actual(input, result)` consumes a one-shot receipt for that exact invocation object and result. Distinct
invocations sharing T remain independent; a cloned input, repeated invocation or missing receipt supplies no proof.
A false decision still charges the owner points and formula statements actually dispatched.

Owner reservations establish an asynchronous accounting frame inside the SAME `AccessWorkAccounting`. Nested
native statements and owner envelopes reserve from that finite admitted parent footprint before dispatch. They
settle into the parent receipt, without a second reservation or charge in the caller's sink. `invocation` returns
only that frame's child receipts, never a difference of global usage. Concurrent siblings cannot borrow each
other's reservations. Nested admission also retains the earlier of the parent and native evidence deadlines.
An owner receipt must include every admitted child; unfinished children, an overrun,
failure or missing receipt burn the full reservation and poison the attempt. Closed frames forbid late IO.
Native statement row declarations and all six dimensions retain their original meaning.

This bridge does not declare Content cover readiness: consumers still need to propagate genuine preparation
time/accounting and compose their own native owner declarations and receipts.

### Retained Kind audience contract

Collection presentation uses mixed defaults or an explicit owner-selected Type. It does not invoke
`Access.kindAudience` or wait for audience capture, preparation, raw input, Type evidence or currentness.
The optional ABI in [`kind-audience.ts`](kind-audience.ts) and its existing native adapters remain available to
shared callers and retained-data controls. They supply no ordinary permission or replacement Actor. Existing bearer
authentication, account fencing, Collection/member disclosure and explicit Type/catalogue publication keep their
own authorization contracts. No automatic Kind admission/evidence outcome is required for this presentation journey.

Native account variants use the existing `account-viewer-actions.sql` full-key projection through
`readNativeAccountStates`: UUID, kind/state enums, fence, current operator and positive bigint authentication floor.
`ReadDecisions.prepareAccountAuthority` supports batches admitting `account:read`, `account:update` and
`account:manage` for `access.account`. Its metered preparation retains only target/operator bindings. Each final
call rereads current actor/operator and targets and executes fresh ordinary/explicit formulas on the supplied
client, at the SAME live T object. It checks self, profile operator, verification kind, scopes, principal,
assignments, role validity and denials through the existing formula. It neither uses the unmetered prepared answer
map nor checks out another connection under the caller's checkout. Unrelated action windows cannot prepare native
Account authority and retain the explicit AccountAuthority dependency refusal before IO.

`createAccountPublicEligibility(resource)` supplies the native public-account floor for
`account:read_public_identity`, using the same current full-key projection. Only active, unfenced accounts qualify;
an independent grant still uses the ordinary formula. Its zero-IO preparation and actual one-statement verification
have exact producer declarations. Unknown resource callbacks still require their owners' declarations.

`accountStandingCheck` observes a fresh native account anchor, mints its OWN admitted read time (ignoring a caller's
command time), prepares native permission evidence and releases that time in `finally`. It admits its checkout and
final formula in the same parent ledger. The installed authenticator can refresh only its own already-verified
bearer/account proof, retaining its original pool, deadline, JWT wall-clock expiry, authentication floor and fence.
Native command admission compares the closed current account projection against the actual authenticated snapshot;
its per-attempt observation is reusable only with the same accounting object. No partial Account or bearer is minted.

Standalone fixed Global gate checks support the existing exact `gate:<group>` or `gate:any` formula with the mounted
operation's scope operand. They prepare before resource checkout and admit each checkout, transaction control and
final formula. Native read minting passes the original timestamp text directly to PostgreSQL, preserving
microseconds; a provided read time must match the exact window. Expiry is checked again after final transaction
control. A borrowed client requires the already-prepared shared read window, so foreign preparation never
runs under a resource checkout. Shared-window checks also execute afresh. `admitGroup` / `admitExposure` accept optional `work`/`time`;
the native opening probe has no open cache, and a locally minted read time is always released. Failed transactions
discard only their own checked-out connection rather than dispatch unadmitted rollback work after ledger failure.
Native opening reads preserve the Global partition handoff check in the same repeatable-read snapshot.
The metered path first projects only the schema-closed partition state and handoff byte length. A moved partition
then reserves a separate exact-key locator fetch using that length before dispatch, and preserves the exact moved
target in the native unavailable error. No unbounded node or locator text is read before admission.
Exposure admission does not become configuration or Source authority.

The remaining authentication dependency is external ES256 verification/JWKS transport: direct metered
`authenticate` refuses with `Auth ES256 verification/JWKS native work producer` before cryptography/key fetch;
`actorOf` retains `Auth bearer authentication native work producer`. Approval restoration's full private account /
assignment path requires `Auth approval restoration full account/assignment native work producer`. These callbacks
have no declared native bound here and are never metered as zero. Already-verified native refreshed-account paths
are supported. Unmetered behavior stays compatible.

### Native declaration proof

`accessNativeWork` is called explicitly at each owning SQL call site; it is not a query proxy or SQL matcher.
Its statement point also admits the implicit pool wait when using `pool.query`; `accessCheckout` admits each
explicit borrowed checkout separately. Closed projections contain UUIDs, enums, booleans and finite PostgreSQL
timestamp/range text, never native content bodies. Byte bounds use those shapes plus the actual serialized input;
completed projection bytes are measured directly. Witness work is zero: Access does not produce Source witnesses.

- `account-viewer-actions.sql`: N full keys, N unique account candidates plus N generated input rows, at most
  N output rows, N point seeks plus the statement point. UUIDs are at most 36 ASCII bytes, positive PostgreSQL
  bigint text at most 19, and kind/state are schema-closed enums. Missing rows retain the entire 2N plan charge.
- `gates/opening-read.sql`: one scalar time row and one exact group/time nonoverlapping opening candidate;
  two plan rows and one key seek plus the statement point. Opening output is a boolean and timestamp.
- `gates/opening-partition-read.sql`: one partition primary-key candidate, one seek plus the statement point;
  its output is a schema-closed state and an int4 byte length. A missing partition retains the candidate charge.
- `gates/opening-moved-target-read.sql`: one partition primary-key candidate and seek plus the statement point,
  only after the preceding length observation in the same repeatable-read snapshot. SQL enforces that length;
  the declared JSON projection covers six encoded bytes per observed source byte plus its fixed object envelope.
  Arbitrary handoff text has no invented fixed maximum, and never supplies permission evidence.
- Transaction control: one statement point, no data rows; its receipt contains only the control declaration and
  void result, never transport metadata. Failed control retains its entire admitted declaration.
- `permission-time.sql`: one scalar row and its two timestamp projections.
- `permission-assignment.sql`: one primary-key assignment and one full-key account, at most two native rows.
- `permission-inverse.sql`: one canonical coverage point and two account/kind ranges per admitted human.
  Their combined cardinality is `MEMBERSHIP_LIMIT` from the existing serialized native reservation writer
  (`membership-inverse-20261025093747-reserve.sql`); incomplete coverage still denies. This is charged once per
  shared window, never estimated from returned memberships. A caller whose budget cannot admit this bound refuses.
- `permission-membership.sql`: one organization account and current/next temporal seeks for each of two roles,
  at most five native candidates per organization/member pair. Both positive and negative roles are charged.
- Candidate and final formula SQL: keys are the supplied roles plus two identity/active-account keys per resolved
  account. Targets are the exact page/batch plus optional Global. Branches are ordinary plus requested explicit
  and public projections. Each key/target/branch has an action-grant seek, each configured resource-role grant
  seek, and denial work for the three closed reasons (`resource`, `suspension`, `realm_ban`). The native temporal
  keys' `WITHOUT OVERLAPS` constraints and last-range `LIMIT 1` seeks bound each candidate/reason. The declaration
  also charges the finite generated key/target/probe/decision work. The final assignment recheck is separately
  included. No target grant, current denial or final scope decision is reused from preparation.

Native cost/growth evidence remains separate from this supported admission/receipt port. No Source budget,
resource classifier, ledger or harness is changed here.

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

Test compositions that construct declarations from scope names use the exported internal metadata, including
`account:delete`'s replay policy. The native account fixture passes the same complete declarations to Access and
the operator bindings so restoring an opening uses the same resource-role catalogue. Explicit caller declarations
remain subject to the production conflict check; fixture merging must not conceal a conflicting declaration.

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

For `moderation:takedown`, `moderation:read_reports`, `post:erase`, `media:erase`, `access:grant`, `space:restore` and `realm:restore`, Access first evaluates the ordinary formula on the requested resource. If it denies, Access checks that exact action on the Global Context with the same actor, client scopes, principal and authoritative time. The Global check uses the normal account and assignment floors and current suspension/fence checks; denials on the requested resource do not affect it. A Global action never covers another action. The actions in `globalReach` must also be held by the built-in `platform.governance` role. Grant commands still require the grantor to hold each listed action on the Global Context when granting it there.

A command authorized by this Global check writes one row to `access.governance_reach` in the same transaction. The row records the command transaction id, action, requested resource and actor account. Permission proved on a separately released authority connection carries that reach use into the command transaction; authorization denies if the transaction cannot register it. Repeated authorization for the same action, resource and actor in one command registers one write. Replays, denials, rolled-back commands and checks outside a command write nothing.

## Authenticated fixed-edition benefit

`authenticated-benefit.ts` owns the server-only `ContentEditionBenefit`,
`ContentEditionBuyerFact`, `ContentEditionBuyerFactInput`,
`createContentEditionBuyerFact` and `ContentEditionBuyerFactReader` declarations.
Content supplies `Resource.authenticatedBenefit` only as an exact selector for one
`content.edition`, original revision, canonical lowercase SHA256 and `edition:read`.
It carries no evidence. Page preparation and other actions or targets reject it.
No HTTP field, anonymous eligibility, Library entry or stored grant is introduced.

Content's native composition supplies Commerce's current native
`contentEditionBuyerFactReader` to `createAccess` (including the public factory).
Commerce alone calls the internal native issuer after validating the exact immutable
entitlement/target/version/action and current positive safe-integer native
`Entitlement.revision`. Entitlement and buyer keys are complete native routed UUIDs
on the buyer's home route; the revision and edition keys are complete native routed
UUIDs. The issuer copies and deeply freezes the bindings in a private WeakMap.
Only its opaque frozen object is evidence: structural, spread, cloned and serialized
objects have no authority. The reader must release its Commerce checkout before
returning and must not call Content or Access recursively. `null` proves no matching
current entitlement. Missing configuration and failed sources throw typed
`AccessUnavailableError`; they are never converted to missing entitlement.

A native read caller mints `AuthoritativeTime` with `mintReadTime` on an independently
released bounded connection, supplies that same live object as `AccessContext.time`
and to final authorization, and calls `releaseOperationalTime` in `finally`.
This initial vertical requires that explicit read time; Access does not own a hidden
read-time lifetime. Commands always use `accessCommandAttempt(context).time` and
reject a conflicting supplied time. Actor/principal assignment, membership and the
formula use that same T. Every retry prepares fresh evidence with its own live T
and the original fixed request deadline.

After native actor/current principal and assignment resolution, preparation invokes
the reader sequentially for each distinct actual actor/principal identity: at most
two calls, with the unchanged request deadline, before resource checkout. A fact
for the actor does not satisfy a different principal. Every final check rechecks
opaque identity, native revision and exact benefit/buyer/time/deadline bindings,
including after its SQL statement. Neither a mutated selector nor an expired or
released time can expand authority.

The existing `permission-check.sql` consumes at most two exact buyer keys only in
the local single-edition authenticated grant operand. Actor and principal each
need their own ordinary grant or fact. Consented client scope, current assignment,
account standing, membership evidence, denials/bans/fences and deadlines remain
mandatory. The operand supplies neither explicit native grant nor Global governance
reach, public/anonymous floor, page authority or another target's permission.
Ordinary public/free and explicit/Global rules retain their existing behavior.

Content independently checks the current native edition/version/availability,
original source/licence and full current parent/thread/board/Realm/Space authority
before preparation and immediately before every byte or conditional response.
The buyer operand does not authorize a post/container action, target readiness or
sale. Sale still requires current `edition:sell` and native author/post:revise,
licence and source authority. An edition points to the exact original revision;
Commerce stores no copied body, so source erasure/purge cannot leave duplicate
bytes. These checks belong to Content, outside the Commerce reader and Access
formula; the fact is not a substitute for them.

`test/access/authenticated-benefit.test.ts` covers this native formula boundary,
opaque bindings, independent operands, released read-time ownership and the public
factory wiring. Its trusted issuer fixture does not claim Commerce's current-reader
or Content's full delivery/sale proof; those remain producer acceptance obligations.
`community.space.owner` holds `space:restore`; `community.realm.owner` and `community.realm.moderator` hold
`realm:restore`. These are additive grants on the existing installed roles. Standing and Realm membership grant
neither restore action. No Space moderator, administrator, management reach or generic restore authority is added.
One restore action cannot authorize restoration of the other resource type.

`community/actions.ts` exports the exact nonanonymous `NATIVE_CONTAINER_ACTIONS` restoration and claim-approval declarations.
Kernel composes them with mounted metadata once, sharing that catalogue between Access and resource-type
validation. Mounted declarations must agree on security and replay policy; unresolved role actions still fail
construction. Content owns the protected native operations. Its local restore decision
requires the current role/action and the exact native removal record: the original remover must still be authorized,
or the caller must currently hold a higher installed role. Realm ordering is owner > moderator > member/standing;
Space ordering is owner > standing. Equal rank is not higher. An exact Global restore grant permits platform
restoration while retaining current native eligibility, the original 30-day deadline, actual own-self-delete rules,
lifecycle, hold and removal evidence, versions, generations, receipts and replay checks. These grants create no
claim approval, owner transfer or automatic acquisition after 30 days; owner initialization is not a transfer path.

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

The native suspended persona holds a bearer issued before suspension: every route answers `401
invalid_credentials` with `WWW-Authenticate: Bearer error="invalid_token"`, because the floor and fence invalidate
that bearer before Auth revokes sessions. Auth mints only for active accounts; correct-password sign-in for a
suspended person answers `403 ACCOUNT_SUSPENDED` without a session.

An otherwise verified bearer at or above the floor for an unfenced suspended account is a defensive case only.
Authentication throws `ProblemError('account_suspended')`; the shared problem mapper returns `403`, title
"Account Suspended", `retryable: false`, and no `WWW-Authenticate` header on every route. Its effect status is
`not_applicable` for `GET`, `HEAD`, `OPTIONS` or actions ending in `:read`, and `not_applied` otherwise. No native
manifest case or per-operation OpenAPI response advertises this unreachable persona. The existing authentication
check order stays: malformed or invalid tokens, below-floor tokens, fenced, deleted and unknown accounts retain
their 401 answers, as do missing credentials (`authentication_required`).

If the acting account becomes suspended between authentication and command preparation's anchored re-read, the
command answers the native `401 invalid_credentials` with the invalid-token challenge, with no effect and no
receipt. Other changed account facts keep their existing denial. These checks add no statement: authentication
still reads one anchored account; command admission uses its existing independent re-read.

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

### Private exact-target lifecycle review

`POST /v1/accounts/{accountId}/lifecycleReview` (`account.lifecycle_review`) is a bearer-authenticated,
private/no-store read on the real account route composition. Its empty body reviews exactly one selected account,
including a suspended account. It does not use management relationships, public account eligibility or generic
`viewerActions`. The mounted `account:read` label describes HTTP read accounting/error semantics; it supplies no
authority. The handler requires either actual `account:suspend` or `account:reinstate` through installed Access on
`PLATFORM_RESOURCE`. The returned action/operation pairs share the native mounted command declarations; suspension
applies to active accounts, reinstatement to suspended, fenced accounts with a native fence receipt. They are advisory.
Commands retain their existing Global reauthorization before receipt lookup, digest, principal, reason limits,
floor/fence transitions and response allowlist. No registry, public audience, scope, floor or grant is widened.

Body `original: {operationId, key, reason?}` asks for the original command readback. The exact original target is the
path selector; keys and reasons are only private body data. The authenticated actor/client/requestedBy tuple is the
original principal basis. The same digest helpers used by the commands include the exact reason (including whitespace)
and the suspension continuation binding, which is null on the mounted HTTP command. A different client, delegated
principal, key, operation, target or body cannot read another result. This port deliberately cannot read a direct
internal suspension supplied with a different continuation binding. It uses `nativeReceiptKeyCandidates` and the
native receipt primary key, stored digest, transaction, epoch/position and present payload. Absent, minimized,
oversized or mismatched receipt evidence returns `original: {status: 'unknown'}`, never `not_applied`. The normal
command problem mapper remains the sole source of explicit non-application; this reader executes no command.

The response allowlists identity, current state/floor/fence, exact applicable actions and optional original status.
It never returns a reason, digest, command key, private response payload, session material or operated account identity.
The current snapshot and original recorded result are independent. Deleted targets have null display labels. A receipt
proves only a recorded original result. Event zero, bound by the same partition/epoch/position and native event type,
proves whether that command committed an operator continuation; event absence proves nothing. A continuation must
match its complete immutable native snapshot digest, barrier transaction/receipt, floor and original command digest.

Operator observation reads one immutable page (at most 100 subjects and one next-page entry), then exact completion
keys and actual internal lifecycle business receipts. It recreates the existing internal executor's digest and
principal/key framing, including each reservation, page cursor and child operands. Both fence/unfence success and
their native recorded false/no-op results terminate that exact liability. A page receipt alone, authorization-only
completion, missing page/completion, queue registration, supersession, current account state or elapsed time does not.
The optional body `operatorPageKey` (64 lowercase hexadecimal characters, requires `original`) selects another page through the native
root's exact derived-entry key. `operatorPage` reports only that page's proof and the next native page key;
it exposes no subject list or internal work cursor. The stored native cursor supplies the original business digest; the page key must match its hash. No automatic traversal occurs. Whole operator completion is asserted only for an
attested first-and-last page or the immutable no-fanout event. Multi-page observations retain the original lock even
when the selected page is terminal: this port does not aggregate caller-held observations into a terminal certificate.
All owned page/child reads are available without a history/account/operator enumeration or a new effect.

There is no authenticated terminal Auth session-revocation operand installed on this suspension path. Its
`sessionRevocation` is explicitly `unknown`; neither an Access continuation authorization nor a session queue is
an Auth ACK. The exact owned session-step completion and its corroborating native
`cleanup-continuation.recorded` business receipt are projected separately as `sessionRevocationAuthorization`;
even `recorded` proves only Access authorization before Auth's deletion call. Reinstatement creates no new session revocation liability (`not_required`) and does not revive old
credentials. Both events also feed the native `account_agent` effect; Semantic synchronization has no original-bound
terminal delivery operand on this path, so `accountAgentSynchronization` remains `unknown`. Neither operation claims
whole-effect completion, even when its owned operator effects are terminal.
Foreign home failure refuses the dependent effect claim as `unknown`, while a recorded original remains recorded.
No physical custody, retention completion, original funding or generic receipt engine extension is introduced.

Call graph: real route -> normal admission -> `readLifecycleReview` -> live native read time -> installed
`accessCheck` preparation (released actor/principal/membership/Realm anchors, client scopes/consent, assignment,
roles, denials and gates) -> exact current actor/floor/home -> canonical Global existence/home and native formula ->
exact target/home -> for original readback, repeat authority BEFORE native receipt -> event/root -> optional immutable
page/completion/child receipt homes -> repeat authority -> final exact target/home comparison -> allowlisted response.
Preparation and all foreign-home reads run after releasing the prior connection, including with pool maximum one.
Each authority phase mints current native T and releases it after use; every phase retains the original job deadline,
including PostgreSQL statement/acquisition limits. No retry, new deadline, coordinator advance or effect is hidden here.
The final snapshot must preserve target transaction/state/floor/fence/identity and source node/epoch/currentness.

Literal owned SQL statement and returned-row bounds, excluding the reused installed Access preparation/formula and ordinary HTTP authentication:
review is at most 22 statements/rows plus four native Access evaluations. Original readback is at most 36 statements/rows
plus six evaluations before effect observation. One operator page adds at most 509 statements/rows (two for optional
exact derived membership, two for the page, five per page/child business proof, at most 101 proofs). Thus the maximum
is 549 owned statements/rows plus six evaluations, including at most four exact native session-authorization
proof statements/rows. At most 103 receipt reads add at most 412 unsuccessful native key candidates
beyond those returned rows. Every statement is an existing leading full primary-key seek:
`core.partition(partition_no)`, `access.account(route,account_id)`, canonical Context,
`core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key)` (at most five native candidates,
LIMIT 1; each receipt statement examines at most five primary-key candidates), `core.outbox(partition_no,position,event_seq)`, continuation root/page/entry/completion primary keys.
Each nested allowlist is capped at four root entries or 101 page entries. Receipts/events are limited to 2048 UTF-8
bytes, root allowlist to 4096, page allowlist to 65536, each cursor to 8192 and each home label to 1024; oversized
native operands refuse the dependent claim. Identity labels are limited to 1024/64 bytes. These guards cap owned
returned SQL data at 2,500,000 bytes per request, including metadata, using 4096 per scalar row plus the one 81920-byte
page allowance. Response identity/progress, including an optional next page key, is below 16384 bytes. Reused Access work
keeps its existing finite/accounting contracts: at most 1000 memberships per actor/principal (two principals), bounded
role candidates and the one native permission formula per evaluation, with its existing foreign-home refusal.
There is no new ledger or guessed foreign zero. This HTTP path supplies no new work accounting authority.

`test/access/lifecycle-review.test.ts` authors real current-authority, suspended-target, privacy, principal/digest,
revoked replay, lost response, native pending/terminal evidence and source-home regressions. They are UNRUN in this
source delivery; generated transport/consumer regression is also UNRUN. Typing does not prove native acceptance.

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

The original pending and reversal commands append one immutable `agent_identity_intent` row at the account's home,
keyed by `(route,account_id,direction,receipt_id)`. Verification retains the original Global decision receipt and
its separate account command receipt; reversal retains its original command receipt and the actual prior published
undo job. Native source reads check the account fence before looking up the receipt. Released source custody is
private to the existing Semantic binding bridge; mutable pending markers and raw receipt JSON grant no authority.
An initially deferred native constraint checks the executor's exact stored receipt key, transaction and component
in the same database transaction. Reversal insertion also rechecks its immutable prior source at the current owner
epoch. The source guard accepts only the role-scoped transition after the independent source, copy, root, owner,
restore and receiving proofs are current in the same transaction; missing source or receiving custody still refuses
the update or deletion.

The original SDK enqueue now records two-stage native receiving custody. Initial verification binds the genuine
committed Global request, approval receipt and native write basis before the SDK input commits. The receiver uses
a new opaque UUID with an immutable mapping to the actual unchanged `accounts.agent-verification:<request>:<receipt>`
workflow ID. It records the complete subject/requester/decider/principal role union. This initial approval-copy
obligation contains no chosen release, accepted Semantic input, AccountIdentitySource or terminal proof.

The unchanged `record-pending` step still chooses the accepted release and creates the account-home Source at its
original time. That original command records its exact Source key, native tuple, digest, release and SDK custody UUID.
After releasing the source checkout, the step associates that intent with the existing receiver before recording its
SDK result. The receiver's original creation transaction remains unchanged. Reversal's original command records the
same source-local intent before its existing effect; enqueue validates the exact original native reversal response.
Both use the configured WorkClient's transactional SDK enqueue, preserving positional arguments, workflow IDs, step
names/order/results, durable redrive and publication. Cached step replays recheck native custody outside the checkpoint.

`history/agent-identity-source.ts` exports the native recording/handoff types and lookup bounded to eight keys and
one artifact in total through the
`lookupAgentIdentityReceivingCopies` port. `history/agent-identity-work.ts` owns the actual enqueue/association wrappers.
Neither lookup nor initial custody seals a Source inventory or grants erasure authority. Source and receiver owner
epochs, current History generations, writer versions, role seals and permanent native retirement are checked before
admission/reuse. The original command's full role manifest, including acting-human and prior Undo roles, is retained
in the SDK source association. SDK payload inspection retains
the existing 64-operation, eight-event-key, 64-history-row, 64 KiB payload, 4 KiB metadata, 139-row and 10 MiB limits.

Older SDK rows can be matched only to exact original arguments and remain marked as uncovered creation; missing old
source-command associations remain pending. Recovery preserves its separate native transaction and does not mint a
missing original SDK source intent. No status/string parsing supplies original Source or consumer authority. Consumer
and technical Undo custody remains exclusively Semantic's `identity-source-consumer-custody.ts`. It walks the
admitted scope directory, checks each Library expected-effect seal and receiving record, and commits its terminal
receipt at the original Account source home. Requester/decider erasure can transfer the immutable technical input to
the native Accounts receiver; subject discharge stays pending until the binding owner supplies a settled native
reversal proof. The Library page API in this checkout still returns unavailable, so no missing scope or seal is
treated as empty. Account root and shared-copy closure remain independent. Physical retirement resolves the genuine
mapped SDK workflow ID and still requires the SDK's permanent writer fence. No foreign SDK tables are mutated
directly.

`history/agent-identity-retirement.ts` exports the original module's retirement staging and verification ports through
`agent-identity-work.ts`. `readAgentIdentityRetirementStage(pool, reference, context)` checks the exact original native
source tuple/digest, immutable custody UUID, workflow ID, release, writer version, current owner and History generation
in the source home, then releases that checkout before calling Semantic's exact
`readIdentitySourceConsumerCustody`. It uses the existing undo-only source read for retirement after the account fence;
this cannot admit a new verification. `verifyAgentIdentityRetirementStage(tx, stage)` rechecks the barrier and the
entire source association in the SAME source transaction and invokes Semantic's native verifier there. It makes no
foreign reads while held. Null/false Semantic evidence remains `identity-source-consumer-custody-pending`. A true
result means the exact durable discharge/transfer was revalidated at the original source home; it is still separate
from the SDK writer receipt, Account root and shared-copy closure.

The default maintenance path is `shared-history-work.ts` → `advanceSharedHistory` → `minimizeHistoryWork` →
`minimizeIdentitySDKWork`. For one selected current mapped identity unit requiring consumer maintenance, it calls
`advanceAgentIdentityConsumerMaintenance` after releasing the native job and receiving checkouts. The actual
`semantic/identity-source-consumer-maintenance.ts` export `withIdentitySourceConsumerMaintenance` opens one frame
around the entire callback: receiver binding, original source and accepted-job lookup, retirement staging, Source
read and final native verification. The configured WorkContext pool, environment and clock pass unchanged; History
owns no maintenance configuration/defaults, native or Library allocation, ledger, usage receipt or refund.

`HistoryReceivingContext.identityConsumerWork` is optional and opaque. Staging forwards the exact original producer
callback context without copying or persisting its funding. A caller-lifetime WeakSet recognizes only those callback
objects while their operations are active; it supplies neither funding validation nor Source authority. Unbacked
direct staging retains its compatible local handoff with a null consumer, without dispatching Source. Source owns
funding validity, accounting and final invalidation. The final verifier runs before the same producer callback ends;
exceptions propagate without opening another frame or resetting partial work.

The original Source producer is integrated in this base. The adapter in `agent-identity-retirement.ts` aliases its
published original module ABI, including `KernelClock`; runtime loads only that original module/export. An absent
module/export or its exact provisional funding refusal yields `identity-source-maintenance-funding-unavailable`
before any Source lookup. There is no local fallback frame.
The selected native association's closed key supplies the original receipt; the undo-only Accounts source read
supplies its current tuple, digest and erased role, and the existing read-only accepted-source getter supplies its
existing job. No fresh identity admission, source reconstruction or workflow-name parsing occurs.

Funding-unavailable or still-pending consumer work keeps this one existing cursor and retries at the ordinary
ten-second native lease cadence. Completed frontiers are not reset, unrelated ticks allocate no Source work, and
unavailable Library seals, SDK writer coverage, Account root and shared-copy branches retain their exact pending
gaps. The original receiving,
restore/writer/source generations, rollback and physical/raw/progress ceilings are unchanged. Caller wiring and
local typing do not establish native acceptance. The producer and default History composition are present, but an
unavailable Library page/seal or missing subject-reversal authority remains pending; the regression keeps the
original bytes and receiving work intact when that evidence is absent.

The native SDK producer publishes `WorkflowWriterFence` exactly as
`Readonly<{ workflowID: string; generation: string; closureID: string; closedAt: number }>`, with
`retireWorkflow(workflowID)` and `getWorkflowWriterFence(workflowID)`. Its original Kernel wrapper is
`work/sdk-retirement-fence.ts`: `retireSdkWorkflowWriters(actualWorkflowId, sdk)` and
`readSdkWorkflowRetirement(actualWorkflowId, sdk)`. The consumer passes the configured real `WorkClient`, never the
wrapper's default static SDK. The producer module and client methods are integrated. History imports their original
types and implementation; it supplies no alternate method, SDK SQL or new receipt domain.

The SDK producer owns installation and current coverage of its permanent native writer guards, including enqueue,
resume/restart, old owner-token writers, parent/fork lineage, output/step/event/history, notification and stream writes.
Its fence survives supported deletion and SDK deduplication loss. The indexed read-only
`search-worker-outcome-harness/dbos-transact-ts` source at `client`, `system_database`, `dbos` and `dbos-executor`
remains the baseline reference for supported deletion and ownership-token behavior. The new producer patch was read
for its fence migration, writer/lineage guards, owner-token serialization and receipt APIs. Source code and a receipt's
shape alone do not establish current installed coverage. Missing native coverage remains unsupported; a technical
fence never supplies consumer, Source or Account-root cleanup authority.

`history/agent-identity-sdk-fence.ts:retireAgentIdentitySDKWork` consumes the original Source
expected-address handoff, records guarded generation-1 readiness on the original association, releases its
command, retires the exact original SDK writer once, and records separately guarded generation-2 closure.
The complete selected-unit composition, its installation prerequisites and charges are described below.

The receiving binding is `access.agent-identity.sdk-retirement/v1`:
`{ kind, custodyId, workflowId, requestDigest, source, receiver: { partition: 0, epoch, generation, writerVersion: 1 },
barrier }`. `source` is the entire original `AgentIdentityWorkSource`, including its source key, tuple, digest, release
and complete role union. `readAgentIdentitySDKReceivingBinding(tx, artifact, barrier)` locks current mapping,
history-work, restore/generation, roles and barrier in the receiving home. It independently rejects another home,
foreign UUID, changed roles and a changed barrier. Its `observed` result grants no cleanup authority.

The exact first consumer receipt binding for Source and original-row minimization is
`AgentIdentitySDKRetirementReceipt = { binding, sourceGeneration, fence }`. `fence` is the unmodified original SDK
receipt, with generation exactly `"2"`. It describes technical closure metadata, not authority to settle the original
History owner. Genuine durable Source discharge and independent current receiver admission remain prerequisites to
any future receipt write. A copied exact receipt cannot authorize readiness, minimize the original Account source
bytes or replace the independent Account root and generated-copy proofs. The original database guard continues to
refuse those state transitions without the missing native handoff.

`readAgentIdentitySDKFence` independently rereads the actual SDK through the original wrapper and rechecks the current
receiving binding before and after that call. It returns only an observation. Caller fields, cached receipt shape,
workflow status, a public boolean and affected-row counts cannot establish closure. The physical minimizer accepts
only already-retired, owner-ready native custody with that exact bound receipt, uses supported deletion without live
cancellation, probes all original physical tables within their unchanged limits, and requires the same native receipt
after deletion. It never enters this path for a live obligation. Missing source transfer, native coverage or physical
closure keeps both inventory APIs pending, even when independent receipt/outbox copies have closed.

Original enqueue and cached replay check the permanent receiving custody before rebuilding source payload. Captured
native retirement also refuses late delivery while cleanup remains pending. The SDK's own permanent fence guards
external enqueue/restart/redrive after deduplication loss. The original native acceptance assertions remain intact;
execution is deferred until integration. Source registration and local typing establish neither native completion
nor Source/main/participant completion.

The existing DBOS workflows redrive source/admission/publication with durable sleep outside steps, preserving their
original ids and receipts through retryable failures. Page writes, approval completion, reversal page removal and
pending cleanup require indexed native mapping and both fixed participant completions. The typed adapter accepts
only the delivered coordinator's resume/wait exports. Success requires native publication; unavailable source,
coordinator or participant custody remains retryable. Missing historical source custody reports its original locator
and also stays pending.
Original DBOS step positions remain unchanged; the extra final publication step verifies recovery even when the
old merge/unmerge and subsequent stages were already journalled. Uncached original stages probe before acting.

The missing-source branch now uses `agent-verification-identity-recovery.ts`. A retained original reversal receipt
is recoverable when its exact native command/write basis and complete prior immutable verification source and
published undo remain available. The lookup uses account home plus original reversal transaction through a unique
partial native receipt index; the account, actor, disposition, reason, catalogue and verification receipt must match
the original executor result and digest. The released native undo reader supplies the original accepted release
and actual first-bound published job. No current verified/pending mapping or active release supplies a missing field.
Each home is released before the next is acquired, and the account/source owner fences are checked again on write.
The original intent keeps its original transaction, epoch, position, receipt key, digest and workflow identity.
`agent_identity_recovery` separately records the actual new recovery transaction and component. Its deferred native
constraint verifies both receipts, their exact source association and the retained prior source; metadata alone
cannot admit identity work. Existing immutable keys require compatible replay of the same evidence. Uncached
success steps in the same original workflow redrive delivery before their publication probe, including a journalled
merge/unmerge.

Original verification pending receipts retain only request/account IDs. The missing-source hook now consumes
`semantic/account-agent-identity-recovery.ts#readOriginalAccountAgentIdentity` before reacquiring Account home.
It passes the actual returned object to `verifyOriginalAccountAgentIdentity` in that same live platform command,
alongside independent original Account locks. Verification still requires the original Global request/decision,
requester, decider, kind, catalogue and decision write basis, plus the exact native pending response and digest.
The pending command is a platform command; its Global decision, rather than a fabricated Account write basis,
supplies the original reviewer evidence. Reversal retains its exact original response, principal, native key,
digest and write-basis checks. The accepted Source input supplies only the immutable release/intent and native
accepted job/claim custody. Legacy reversal uses its genuine `priorVerification` merge input, native provenance,
published job and verification receipt, even when the old Accounts verification source table is unavailable.
It never treats `intent.undoJob` as the current reversal job.

`agent_identity_recovery.original_source` retains that Source claim and prior verification separately from the
original Account command fields and the new recovery component. Deferred constraints recheck exact local accepted,
nonimported claim/native rows and both Account receipts; the recovery digest binds all three native domains and
the original decision component. The released producer read validates foreign jobs and fixed participants before
the Account checkout; no foreign checkout is held during the writer. Recovery neither admits a new job nor changes
the original source key, release, digest, native Account component or deterministic workflow ID. Existing native
reversal recovery remains available without requiring unavailable old Source records when retained native Accounts
verification/undo custody already suffices.

Missing/imported accepted Source claims, incomplete original job/source provenance or unpublished prior undo
remain pending at the exact Source read/verify port. Absent Global decisions/write bases, purged native pending or
reversal payloads, invalid principal/key/digest and moved epochs remain pending at their Accounts owner boundary.
Source publication alone supplies data, never permission or Account completion. The existing workflow still waits
for mapping, Search and ALL Library publication before page, finish and result steps.

The erasure inventory includes original and recovery source/account/requester/decider roles with role-first indexes.
The new recovery command uses the existing History executor hooks: Access declares its genuine original source,
History captures the two expected locators before response/event serialization, associates the actual receipt and
outbox rows after serialization, then seals the recovery cut after the command fence in that same transaction.
The separate `core.agent_identity_recovery_inventory` row is keyed by the exact original source key and binds the
source digest to the recovery partition, epoch, position, transaction, receipt key/request digest, current owner
epoch and restore domain. Its finite cut has exactly two slots: that recovery command receipt and its one
`com.rezics.access.account-updated.v1` event. Each slot retains the actual all-role locator set, capped at 64.
Replay reuses the single recovery row and creates no second serializer cut or recovery event. The original
`core.agent_identity_inventory` (2..3 slots) and original SDK obligation are never inserted, overwritten or
retro-certified by recovery. A historical recovery without this sealed discriminator remains unknown.

Recovery receipt and event retirement reuses the existing History/Work engine and original receiving receipts.
It checks the exact `account_discovery_redrive` consumer, its derived workflow identity and completed native state,
the effects checkpoint, the physical serializer rows, role digest, receiving proof, seal, owner epoch and restore
domain. The recovery wakeup is not the original SDK verification/reversal handoff and creates no SDK workflow
obligation. `verifyAgentIdentityRecoveryArtifactReadiness` keeps the event pending with
`agent-identity-recovery-discovery-owner-unavailable`: installed composition has no Search owner capability that
can return a released current-enrollment observation and verify it again in the source-home transaction. The
former direct `search.discovery_generation` list and checkpoint scan were removed; neither an arbitrary active
generation list nor a relay checkpoint can settle Search custody. The native trigger has the same precise
fail-closed result, so a completed account-discovery effect alone cannot retire the recovery bytes.

The role transition is wired to require the original Source discharge/technical-transfer proof, actual original
and recovery receiving copies, native erasure root, current owner/restore fences and all writer guards in the same
command through COMMIT. It minimizes only the erased role: subject erasure skeletonizes
`agent_identity_recovery.original_source` while keeping its immutable digest/native/job/claim binding; requester
and decider erasure clears only their own identifiers, and decider erasure also clears the decision reason. Live
subject intent, undo and the other roles remain. Native INSERT guards reject a pre-minimized recovery, and UPDATE/
DELETE guards do not accept caller flags, payload overrides or deletion as a substitute for the transition.

Literal recovery costs are in the table below. The recovery SQL guard is 174/174/12/65536/0 per invocation:
six fixed one-row reads, a 33-row event-consumer sentinel, a three-row copy sentinel, and two successful
65-role-plus-one-proof pairs; statements are six fixed reads, the consumer and copy scans, and two locator/proof
pairs. The two guarded updates therefore add 348/348/24/131072/0. Combining that with two original transition
guards gives the exact recovery role-transition reservation 1470/1460/164/573440/0. The original 2..3-slot cut,
SDK gap and unrecognized old receiving obligations stay independently pending. This SQL does not search history,
personal JSON, role prefixes or populations.

The Semantic final-frame owner still cannot fund whole Source completion: five existing current-verifier entries
alone need 696320 bytes against the unchanged 630784-byte native allowance. The Source recovery branch therefore
refuses before its foreign probes or writer with `identity-history-native-funding-unavailable`; it does not borrow
the earlier 11588/9856/2731/6843136/0 consumer-body expansion, change limits/prices, or report aggregate success.
Source/History native acceptance, Search currentness and final Semantic funding remain deferred to their owning
integration. The local regression at `test/access/agent-identity-recovery-retention.test.ts` is authored and
UNRUN; workspace typing proves neither receiving completion nor final retention.

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

`readAuthConsentConfig(env)` in `auth-consent.ts` owns the shared configuration for every module that restores an initiator: `KERNEL_AUTH_CONSENT_URL`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The group is optional and all or nothing. The URL must be the exact private HTTPS `/internal/v1/consents:read` endpoint, without credentials, query or fragment. Values retain the visible-ASCII limit of 1024 characters. A partial or invalid group fails startup with a variable name, never its value. Content erasure and the Realm adapter use this same Access reader.

`WorkContext.getAuthorization()` lazily memoizes one `WorkerAuthorization` containing `access` and `readConsent`.
`createWorkerAuthorization` composes `createKernel` with the worker's actual pool, enqueue client, domain clock,
validated membership route/reference/Auth configuration and dedicated receipt keys. It captures Access through
`onAccessReady` only after canonical routes, native container actions and resource-role validation finish. The
kernel resolver supplies current Realm roles and native edition buyer facts; action names and anonymous metadata
come from mounted declarations. This constructs no listener, request, extra pool/client or DBOS launch. The getter
and configuration confer no authority. Accounts uses this same Access and reader for its existing membership
restorer; Content edition sale restoration receives the identical reader through the pool's existing registry.
Consent configuration is read once for this composition. An absent group installs a reader that throws typed,
retryable `AccessUnavailableError('overloaded')` when invoked; partial configuration still throws `ConfigError`.
Current restoration, grants, scopes, floors, assignments and denials remain the durable initiator and Access formula's
responsibility at each step's time.

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

### Realm transition coordination and deletion entry

Realm membership is neither organization ownership nor an operator responsibility. Its inverse remains until
authoritative leave or post-erasure cleanup. The coordination hold covers a publication transition, rather than
the lifetime of a successful membership. Before every positive publication, including a repeated join, role change
or rejoin, acquire a fresh transition generation under the member account's native lock. Stable inverse reservations
and transition generations have separate lifetimes. A closed generation cannot authorize another publication.

Only an immutable native committed-publication or cancellation proof may retire that exact transition's hold.
The proof binds account, Realm, stable reservation, original operation, transition generation and source transaction.
The shared durable membership workflow reads it on the Realm anchor, releases that connection, then consumes it
atomically on the account anchor. Successful publication consumption preserves the inverse and the real membership.
Wrong, missing, ambiguous, stale or replayed evidence cannot retire a later generation or unrelated coordination.
Terminal inverse release remains a separate command requiring authoritative terminal evidence; a live membership
cannot be terminalized to finalize its join.

In-flight and uncertain outcomes retain coordination and block tombstone before any fence, erasure obligation or
tombstone event. Deletion may commit only after exact transition closure; a queued old writer must then be unable to
publish positively. Keep the account state, fence, authentication floor, current principal/delegation/client scopes,
Realm read/participation and ban checks at native command time under the original fixed request deadline.
Organization ownership and operator responsibility barriers retain their existing meaning.

Recovery after foreign commit completes the same exact durable proof consumption under narrow committed mechanical
authority, without repeating publication or needing a lost bearer. Failed proof reads remain pending. Compensation
commits actual no-publication or terminal evidence before inverse/hold release; age or an absent source row never
proves cancellation. Under the existing inverse writer/deployment barrier, old stable Realm holds require bounded,
resumable reconciliation through opaque native keyset pages over at most the admitted 1,000 membership neighborhood,
exact old reservations and source-proof points, with persisted progress. Historical live, unpublished and uncertain
cases remain distinct and redrivable. No migration alone certifies completion.

`membership-inverse.reserve` returns `{ accountId, principal, reservationId, transition: { generationId,
operationId } }` for a positive Realm transition. `createRealmMembershipTransitions({ pool, authority })` exposes
`proof(transition)` and `consume({ ...transition, key, proofTransactionId? })`. The native Community authority's
`readTransition(client, transition)` returns `RealmMembershipProof | null`: the same tuple, outcome, immutable
source `transactionId` and `publicationTransactionId`. It verifies the exact native receipt and its response
commitment. Consumption locks the account and atomically records the proof and deletes only that generation's
matching coordination row. Repeating consumption is durable even after tombstone or a later generation.

The normal Accounts registrar installs `recover`, `finalize` and `cancel` durable steps for Realm work. A committed
publication is recovered before bearer restoration; finalization uses only its exact mechanical obligation.
Cancellation serializes with publication at the Realm row and commits its own immutable source proof. Neither a
missing source nor a terminal workflow status implies success. Missing production protocol wiring refuses Realm
work. Consuming cancellation closes only its generation; it preserves a live member and inverse. Compensation
then uses the existing registered `terminalize` and `release` steps, with their original receipt keys, to remove
an unpublished reservation only after actual authoritative absence. Organization workflow ordering is unchanged.

Deployment first stops old membership writers and drains or explicitly resolves their in-flight operations, applies
both Realm transition migrations, then installs the new writers and normal Accounts host. Configure
`KERNEL_REALM_MEMBERSHIP_BARRIER` with that deployment's barrier identity before dispatching the internal
`accounts.realm-membership.reconcile` workflow with `{ accountId, cursor?, redrive? }`. It returns at most 32 items
and a sealed cursor bound to account, barrier and mode. Resume that cursor until complete; persisted unresolved
items require explicit redrive. The exact old stable hold must match inverse provenance; live and terminal source
points require their committed native receipts. Missing publication stays pending; disagreement stays uncertain.
The cap probe refuses an overflowing neighborhood. Page completion records traversal, never source completeness.
No migration clears holds or certifies old memberships. Re-enabling an old writer after this barrier is unsupported.

Cost:

- Touches: one account lock, exact inverse/generation/coordination keys, an exact Realm proof and native receipt;
  legacy work adds a 33-key page and at most 32 exact source/adoption/consumption/progress commands. Source checkouts
  finish before the next owner command. Proof and reconciliation evidence remain owned retention obligations.
- Bound: constant rows, statements, connections and output for one transition; logarithmic index blocks in unrelated
  holds, proofs, receipts and historical generations. Legacy rows/output are linear in its fixed page and its
  admission probe is capped at 1,001. Its old source-transaction receipt lookup still requires a bounded Core-owned
  access path before deployment; a page limit does not bound that lookup. Temporal interval index work is measured
  in rows and blocks independently of SQL-call counts.
- Growth check: `test/access/growth-realm-membership-transition.test.ts` grows same-home holds, proofs, receipts and
  historical generations at 64/512/4096 around a real public join/leave and one selected unresolved legacy item.
  The shared harness includes nested Access, proof, DBOS and transaction-control work and measured backend counts.
  Plan assertions use its measured-layout helper.

Native acceptance remains pending: the default Semantic startup schedules work across all 4,096 homes, and the
Community fixture requires complete projection and work settlement. An enqueue checkpoint or a single workflow
list cannot prove downstream events and child work complete. The Semantic owner must supply the actual bounded
source/result boundary; the fixture retains its full settlement condition and original deadline.

The native deletion-entry acceptance in `test/access/realm-membership-transition.test.ts` requires real Auth
approval and execution while membership and inverse rows remain. This entry does not establish Access, Community
or shared-history erasure or their acknowledgements; physical custody and final cleanup remain separate obligations.

`createMembershipWorkPorts` accepts an installed `RealmMembershipCommands` port from the owning Realm module. When the principal kind is `realm`, the enqueue check and the later publication step both call that port's `authorize`, and reserve, publication and terminalization call the port's commands. Organization creation and organization membership keep the supplied authorizer, or the native approval resolver when none was supplied. A Realm principal stays on the Realm port. With no Realm port installed, Realm membership work throws `RealmMembershipUnavailableError` before any inverse, coordination or publication write.

An injected organization authorizer must return an identity authenticated by the same installed Access passed in
`options.access`, using the publication pool. A hand-built actor or the low-level permission evaluator cannot supply
command admission. Native concurrency fixtures use this same boundary so a refusal proves the membership guard,
rather than a missing Access registration.

Every contention retry admits the authenticated identity again and prepares permission evidence at its fresh command
time, under the original request deadline. A retry alone is never a denial. Changed identity or permission can still
deny; exhausted deadlines and unavailable evidence answer unavailable. The locked last-owner guard remains required
on every attempt.

The existing transition producer owns retirement of the exact settled membership hold before account deletion
entry. It must prove the actual committed/cancelled generation; inverse cleanup or a forced leave cannot stand
in for settlement. Current Realm member/participation reads may reconcile a pending UI; no workflow-status API
is introduced. Accounts adopts the current direct manager-add model and records Realm ownership and remaining
delete/restore boundaries in [its membership boundary](../../../../docs/accounts.md#realms-and-spaces-boundary),
supported by the [Realms/Spaces research](../../../../docs/research/accounts-design-realms-spaces.md).

### Native Realm ownership

`readRealmOwnershipRoles(client: AccessClient, input: {resource: Resource, accountId: string,
at: AuthoritativeTime, access?: Access}): Promise<readonly {role: string, rank: number, valid: string}[]>` reads bounded direct
identity grants at T for an already authorized private read. Its built-in role ranks are owner 4, moderator 2,
member/standing 1. Rank 3 is reserved for an explicitly installed native administrator role; the built-in
catalogue does not define one. Supply the trusted service's `access` to use its actual installed catalogue,
including explicitly installed extensions and roles dropped for unmounted actions. Omitting it restricts the
read to built-in definitions. A grant row alone never installs a role. Neither action
inference nor group membership supplies a direct role or current account eligibility.

`assertRealmOwnerMayLeave(client: AccessClient, input: {resource: Resource, accountId: string,
at: AuthoritativeTime}): Promise<void>` requires the actual authorized live Realm command and its exact T.
It locks `access.resource_initialization`, checks the target's current explicit owner grant and requires another
current open-ended direct owner interval. Native role revoke, demotion and interval closure use this guard in
the same SERIALIZABLE command; contention retries must reauthorize and recheck. Ordinary action grant changes
operate only on `resource_grant`, so they neither remove nor infer an explicit role holder.

The dependency-free `resource-access-errors.ts` owns the canonical error hierarchy:
`GrantDeniedError extends ResourceAccessWriteDeniedError` and `RealmLastOwnerError extends GrantDeniedError`.
The original modules re-export those same classes, preserving existing imports and both denial families.
`RealmLastOwnerError` is also exported from Access. Only the same
authorized command's locked native predicate with `target && !remaining` throws it. Missing authority,
creation source or explicit target, wrong transaction/T, formula denial, inactive accounts and unavailable
dependencies retain their existing refusal. Grant catches preserve this exact error only from that guard.
The standard HTTP mapping is exactly:

```json
{
  "type": "https://rezics.com/problems/realm_last_owner",
  "title": "Realm Ownership Transfer Required",
  "status": 409,
  "code": "realm_last_owner",
  "retryable": false,
  "effect_status": "not_applied",
  "request_id": "<request id>"
}
```

There is no detail, failure text or owner/role/account/member/grant evidence in this response. Existing role
change/revoke response metadata permits this exact 409. Content must bind this guard in its current native
leave writer under the same exact command admission and T, preserve the error and declare
`409: problemSchema('realm_last_owner')` in its response schema. The delivered
`community/membership.ts` currently does not invoke this guard; this Access change does not complete native leave
acceptance. A private role read cannot authorize leave, and no Actor may be fabricated for the guard.

An authorized consumer can direct the member to the existing localized `/access/$resourceId` page
(`ResourceAccessPage`, reached through `ResourceAccessLink`) to grant an owner role to an eligible account
before retrying leave. That page uses `readResourceAccess`, `findAccessIdentity` and `saveResourceAccess` under
current native `access:grant`/delegability. There is no delivered atomic transfer HTTP route or UI.

`createGrantCommands({pool, access, managementAction, clock?}).transferRealmOwner(context,
{resource, fromAccountId, toAccountId, previousValid, key})` checks the new account on its source connection
before target checkout, validates the exact current source owner interval, creates the recipient's `[T,)` owner
grant, then guards and removes the source grant atomically. If the recipient already has a current open-ended
direct owner grant, it preserves that interval and transaction identity and returns its actual `valid` instead.
It retains ordinary scopes, grantor anti-amplification,
principal admission and authorization before receipt replay. The native command result contains
`{resource, subject: {kind: 'account', id}, role, valid}` and the ordinary command outcome version fields.

Content owns integration of the leave guard in its existing native membership writer. The separate native
The protected public `POST /v1/roleGrants:transferRealmOwner` custom method declares
`role_grant.transfer_realm_owner`, `access:grant`, normal admission and the ordinary write rate limit.
Its closed body is `{resource: {route,id}, fromAccountId, toAccountId, previousValid}`; only the existing
structured-string `Idempotency-Key` header supplies the key. It calls that same constructed native helper,
records its ordinary session outcome and returns `{roleGrant: {resource,subject,role,valid}}`.
It does not publish a second effect or replace the native error mapping.

`GET /v1/grants` binds the actual native command object to its own pool and Access root before enabling
Realm mutation presentation. A missing or copied port remains `realm_guard_unavailable`; a role row or
caller flag cannot open it. Existing current before/final management reads, all-action delegation checks,
signed 20-row keyset pages and bounded public identity batches still apply. Realm subject groups stay read-only.

The authenticated Web BFF consumer is `/access/{resourceId}` via `transferResourceOwner` and the local typed
`owner-transfer` transport. It uses the server's current credential, shared Origin/session CSRF protection and
private no-store responses. Only a current manageable direct account owner grant plus a delegable native owner
role offers the control. Exact authorized identity lookup selects the recipient. Confirmation names both
accounts and their owner responsibility; selection itself conveys no authority. The existing access recovery
flow keeps one key, body and reference interval across unknown responses and refuses changed-input writes
while pending. A native receipt is historical: the page displays only a fresh private management read, carrying
the native response session token. Unavailable readback shows no current ownership or leave claim; authority
loss clears private grant observations. Content's leave link remains labelled grant management and has no
second transfer control. Native ownership/leave outcome acceptance and interface review remain owed.

Content integrates the leave guard in its existing native membership writer. The separate native
`createRealmOwnershipCommands({pool,access,clock?})` constructor exposes:

```ts
prepareErasureSuccession(attempt: CommandAttempt, input: RealmErasureSuccessionInput): Promise<PreparedRealmErasureSuccession>;
erasureSuccessionAuthorization(input: RealmErasureSuccessionInput): RealmErasureSuccessionAuthorization;
applyErasureSuccession(tx: CommandTransaction, prepared?: PreparedRealmErasureSuccession): Promise<RealmErasureSuccessionResult>;
readAppliedRealmErasureSuccession(tx: CommandTransaction, input: {realmId: string; accountId: string}): Promise<AppliedRealmErasureSuccession | null>;
```

The input is only `{resource,accountId}`. Pass the constructor's authorization to the existing `runCommand`
executor, with the Realm partition, fixed request deadline and service clock; its `prepare` runs before Realm
checkout. The body calls `applyErasureSuccession(tx)` on that same command. No initiating actor, platform account,
current human permission, Community progress or participant ACK supplies authority. Preparation reads the exact
immutable native `access.erasure` `(route,account_id,version,at)` and genuine account tombstone, releases that
checkout and privately binds evidence to the executor attempt, T, deadline and exact target. Copies, other attempts
and second applications in one transaction refuse. The internal authorization checks the actual direct erased
owner source (or its durable decision); it conveys no person or Global action.

Each application examines 99 current native role keys plus one lookahead, retaining a durable cursor, finite native
frontier/horizon and best interval locator. The installed order is owner, moderator, then member/standing at equal
rank; an administrator participates before moderator only when independently installed by the trusted catalogue.
Within a rank, actual native interval start then identity key decide. Groups and membership graphs are never
expanded. Existing explicit owners retain their actual grants; selection creates ownership only when none remains.
Current pages use `readCurrentResourceRolePage` and final same-writer
`verifyCurrentResourceRoleFrontier`; any changed source restarts the traversal. Account observations occur under
native Account share locks. Exclusion requires the genuine terminal erasure root and tombstone: missing,
suspended or temporarily fenced accounts stay pending. Across segments, earlier active losers cannot outrank a
still-active best interval; permanently erased exclusions cannot reactivate. The selected identity must pass
`shareAccount(tx,id)` again in the final writer, or the traversal restarts. No-candidate requires a complete,
unchanged native frontier and only permanent exclusions. Neither filtered EOF nor a released active snapshot
proves absence.

The Content-owned `lockRealmOwnershipSource` locks the actual Realm, including removed containers, and original
orphan episode on this same transaction. Access persists that source episode and immutable decision identity,
writes the native grant changes, then calls Content's `applyRealmOwnershipSuccession` before returning. Content
must consume `readAppliedRealmErasureSuccession` on that exact transaction: it reports only the privately bound,
actually written native result with verified root, candidate grant and original source tuple. Another transaction
or a historical decision cannot obtain an applied proof. A newly orphaned result uses immutable erasure `at` plus
720 hours; an existing orphan episode retains its original timestamps. Native grants, Content state and progress
commit or roll back together. Executor finalization also refuses a caught partial-application failure.
Replay returns the original operation and source with `replayed:true`, without
minting a new applied proof, electing again or resetting an episode.

The two Content source/state exports currently have the adopted provisional declarations and refuse execution
until their Content implementation lands. Content's existing default erasure consumer must invoke this
constructor, resume `pending` segments and retain its owner locator until native result consumption; Access adds
no second worker, coordinator, membership writer or ACK. The current membership erasure consumer is also
provisional. This source delivery is therefore not native integration or full lifecycle proof. Access's native
inventory already includes source, best-candidate and cursor account locators; custody forbids deleting source
or terminal decision before a native consumer closure is provided. Older work lacking the bound Content episode
stays unavailable rather than being relabelled as applied. Installed native role-provenance hooks record grant
changes with the existing executor transaction identity, including destructive removal. This constructor adds no
receipt, event or work producer of its own.

Cost per segment: one released exact account-home source read, one Realm source and progress key, at most 100 raw
current role keys including lookahead, bounded exact account/tombstone/interval comparisons, and final candidate,
grant, Content state and result keys on one live Realm writer. Directory work is O(R*100*log D + 100*log N) for
installed role count R, current directory D and native grant source N; expired role history and membership size
are not request traversal inputs. Progress and private evidence are locators and source custody, never another
owner registry. The existing guard and ordinary transfer remain independently delivered; claim approval is a
separate authority and the 30-day deadline alone confers no grant power.

### Platform approval of an orphan Realm claim

`approveRealmClaim({pool, access, clock?}, actor, {realmId, requestId}, {deadline, idempotencyKey})`
is the owning Access entry. Its result is `{realmId, requestId, claimantAccountId, state: 'owned', orphanedAt,
approvedAt}`. Callers supply neither claimant nor generation, eligibility, role or approval evidence.
Only the exact nonanonymous `realm:approve_claim` action on `PLATFORM_RESOURCE` admits the command, through
ordinary `resourceAuthorization` at each live attempt's T. `platform.governance` includes that action directly;
it is not a `globalReach` action and grants no other Realm operation. Membership, Realm management, Global
`access:grant`, first request and elapsed time supply no approval authority. The real actor, current account,
principal assignment and client scopes remain subject to the existing formula and command admission.
Preparation releases its checkout before the Realm-home transaction. Current admission precedes receipt replay;
replay must not require the orphan state removed by the successful original command.

The independent internal `realm-claim-grant.ts` writer requires the real live Realm-home command with that exact
completed Global authorization, the installed `community.realm.owner` template, the existing creation/owner lock,
complete current-role coverage and the current native role frontier locked through commit. A bounded indexed
temporal predicate rejects every current explicit identity owner, including finite intervals; groups never become
explicit owners. It calls `shareAccount` before writing one native `[T,infinity)` owner role, using existing grant
directory/frontier triggers. Ordinary grant commands and their last-holder and anti-amplification rules are unchanged.

For a new effect, the command calls Content's `lockRealmClaimApprovalSource(tx, {realmId, requestId})`,
then the native Access owner writer, then `applyRealmClaimApproval(tx, source)` before publishing the receipt
and `com.rezics.access.realm.claim.approve.v1` event. All three calls share the live Realm-home
`CommandTransaction`; receipt replay never reacquires a source or writes a grant. A missing source is denied;
an unavailable source fails the command without treating unknown state as absence.

The adopted Content port binds its opaque source to this transaction and the exact native request's
`realm_id`, `request_id`, `account_id`, `requested_at` and `orphaned_at`. The existing Realm `orphaned_at`
is the episode; there is no numeric generation or fabricated request transaction. Content must lock the current
active/nonremoved orphaned Realm and selected pending same-episode request, verify the current lifecycle/source
and original `claim_eligible_at = orphaned_at + 720 hours <= T`, and retain its native source identity across the
grant. Application verifies the same source/transaction and actual installed claimant owner role, changes the
Realm to owned, clears its orphan timestamps and approves the exact request at native command T. Competing
requests in that episode cannot subsequently apply. Original orphan/request provenance and deadline survive in
the source and result. Stale source/request, claimant fencing, removal/restore, a later owner or failed application
rolls back grant, state, request, event and receipt together.

**The native Content implementation is still unavailable in this checkout.**
`community/realm-claim-approval.ts` publishes the agreed original-module types and callable signatures with
unconditionally unavailable provisional bodies. It returns no source or application result and performs no SQL.
Content owns replacing those bodies with its real transaction-bound source/state implementation, native
request/decision retention and route exposure. The Access composition is implemented, but these declarations
provide neither native approval nor acceptance proof. No optional adapter, caller callback, copied Content SQL
or parallel owner registry supplies authority.

The real command basis, grant transaction provenance and event association retain the approver/principal through
the existing command machinery. Native grant retention remains with the existing Access grant owners and
[retention inventory](#retention-inventory). Shared-history custody retains its existing producer
coverage gaps; this entry does not claim preference-only history coverage for a new producer.

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
page or a missing DBOS row. The native gate in `acknowledgeErasure` rejects shared-history acknowledgement without matching complete coverage, registry and committed Auth copies proof. Aggregate completion remains unavailable as described below.

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
`expiresAt: Date`. A store is one identifier or two identifiers separated by one dot; each component matches
`[A-Za-z_][A-Za-z0-9_]{0,63}`. Access keeps the store string literally as supplied and uses it as the exact key for
acknowledgement identity and resolution; it does not infer a schema or normalize the name. Field identifiers keep the
same one-identifier grammar and do not allow dots. Each exception names 1 to 32 fields, a purpose of 1 to 200
characters and a known expiry strictly after T. Store names are unique within an acknowledgement. A participant without
a decided expiry stays pending. Exception and field order do not affect identity. Each participant's acknowledgement
is immutable: the same outcome and exceptions do nothing; any difference, unknown participant or missing erasure is
refused.

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
Each row's `opened_at` is the database millisecond clock when the relay commits it, using the same expression as
`workflow_until`. The delivered checkpoint frontier remains a delivery barrier: its timestamp fences every row
opened for an envelope delivered before the snapshot, including old failed work on a partition absent from the
frontier. Completion and status probe only the partial index of open rows with `opened_at <= workflow_until`, never
DBOS history. The B-tree minimum-key probe visits at most the first open entry, then compares it with the boundary;
it does not scan later open work. The state constraint makes excluding `done` and `resolved` exactly the open set.
The partial index and probe use that exclusion predicate so the planner does not mistake an unmeasured text equality
for a single qualifying row before the first statistics collection. The migration initializes empty-index statistics
before delivery begins.
Later traffic cannot hold the erasure.

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
It returns null for a missing erasure. Backup expiry remains an open external condition.

### Managed erasure progress read

`GET /v1/accounts/{accountId}/erasureStatus` (`account.read_erasure_status`) is a read-only platform capability,
declared with nonanonymous action/scope `account:read_erasure` and closed exposure `gate:account_erasure`.
The existing `platform.governance` role includes this exact action when the route is mounted. Ordinary platform
gate admission still applies. Deployment and client consent must explicitly allow the new scope; nothing grants
it to public, self, default clients or administrator wildcards. The path account id selects one native erasure;
authority is checked directly on the fixed Global Context, never on the deleted account and never through Global
reach to arbitrary targets. Existing actor, client scope, principal assignment, account floors and denials apply.

The exported `readManagedErasureStatus({ pool, access, clock? }, actor, { accountId }, { deadline })` returns null
only for a missing native root (HTTP 404). Success is exactly
`{ accountId, state, at, completedAt, pendingParticipants, retentionOutstanding, lateItems, effectsFrontier }`.
`state` preserves the native `pending | retention-outstanding | complete` enum. `at` is the original erasure
barrier, not the request time. `pendingParticipants` contains only pending names from the frozen eleven-participant
version; `retentionOutstanding` reports any unresolved native exception. No exception fields, stores, purpose,
locators, bodies, profile, reviewer or financial data are exposed. Unavailable, moved, unknown-version or failed
native sources produce typed 503, never a successful empty status. Responses are `private, no-store`.

The reader mints one authoritative read T and keeps the fixed request deadline for both exact Global formula
checks, before native data and before final disclosure (including missing roots). Each checkout is released before
foreign authority preparation. It reads the actual `readErasureStatus` root, participant outcomes, frontier and late
items in a read-only snapshot. It never advances the coordinator, writes ACKs, changes fences or confers completion,
manual retry, cleanup or retention-resolution rights. The original native/root completion proof and deployment
consent remain separate obligations; this read supplies no new proof of physical custody or backup expiry.

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
  existence probe bounded by `workflow_until`; completed erasures need no locator-work lookup.
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

- Touches: `permission-check.sql` re-probes the exact direct, active-accounts and admitted group role keys at evaluator T using the grant and role-grant B-tree companions and `resource_denial_permission`; Global grant reads use `resource_grant_pkey_lookup`. Scope and optional principal grants intersect; denials and expired/missing group proofs fail closed. One result per requested id (one id for a single check), no writes or inverse/role rereads. The verified domain floor supplies public eligibility; anonymous input has no subject keys and does not scan denials.
- Bound: `Q`: one formula statement (plus time when not supplied and optional domain verifier); O(1+J) bounded probe rows, O(1) result. Integrated P+Q: constant rows/statements in G, logarithmic blocks at fixed J; at most linear in admitted J through cap1000 per identity. Role expansion adds R-dependent probes, not H/O enumeration. Permission and operator evidence use the shared real-time TTL helper; elapsed evidence returns 503 without effects. No added reads.
- Growth check: `test/access/growth-evaluator.test.ts`: independent G and K checks, production pool, K through cap1000. `test/access/access-deadlines.test.ts`.

The Global grant B-tree companion orders subject kind/id/role, action and validity; its partial predicate fixes
route/resource, which are included for covering reads. Each probe binds the full key, seeks the greatest `valid <= [T,infinity)`, then checks
`valid @> T` after `LIMIT 1`. Two lexicographic bounds with the same subject/action prefix supply the exact B-tree start and stop keys; empty sorts below every stored nonempty range. Keeping that prefix in the bounds preserves the full index ordering for the predecessor seek. All stored finite starts are inclusive and intervals never overlap, so this
predecessor is the only range that could contain T, including unbounded endpoints. Gaps and exclusive ends
still deny. Neither other subjects/resources nor the key's expired/future intervals are enumerated. The same
probe is used in `permission-candidates.sql` and `governance-reach-candidates.sql`; the temporal primary key
continues to enforce integrity. `test/access/grant-key-lookup.test.ts` checks all three plans and temporal
boundaries against unrelated and exact-key history at 1/8/64. The partial index retains the Global branch.
Other resource grants use `resource_grant_point_lookup` with the complete resource/subject/action key and the
same single predecessor lookup. Role permission probes in `permission-candidates.sql` and `permission-check.sql`
use `resource_role_grant_predecessor`, ordered by the complete route/resource/subject-kind/id/role/grant-role key
and `COALESCE(lower(valid), '-infinity')`, with `valid` included. Both lexicographic seek bounds bind that identical
full key; the upper bound is the shared evaluator T itself. The descending seek returns at most one actual
interval before containment is tested. This is a bound on the actual lower boundary, rather than a range-order
surrogate whose residual containment work could grow. The Access constraint already requires nonempty intervals,
inclusive finite lower bounds and exclusive upper bounds. It remains unchanged, as does the temporal primary key's
non-overlap constraint. Future starts cannot hide a current interval; a predecessor ending before/at T denies;
gaps, unbounded starts/ends and timestamp infinities keep their native range meaning.

For one exact role key, the physical path examines zero or one source interval, with one B-tree descent of height
h(N), one leaf candidate and at most one heap visibility fetch (a covering index-only read can avoid that fetch).
No interval-history rows are traversed. Let S be the actual admitted subject keys (direct identity and active-account
keys for actor/principal, plus admitted group keys), R the requested grant roles, V the targets and B the evaluated
non-explicit branches. The upper bound is V*S*R probes for candidates and V*S*R*B for the final formula; empty,
denied and gap probes use the same bounded seek. Each formula is still one client statement. Short-circuiting can
reduce actual probes; it never grants a source-derived allowance. A denied command's preparation/final checks,
reauthorization before replay, repeated attempts and nested callers each contribute their actual probes. Summing
those executed probes gives at most one source candidate per probe and O(sum h(N)) native index-page touches.
Ordinary grants, denials, group/principal evidence, scopes and authorization-before-receipt are unchanged.
The retained native physical result remains red/pending: no source/type result establishes its buffer bound.
`test/access/permission-role-predecessor.test.ts` adds the focused real history case at 256/1024/4608 and boundary
cases using the existing growth harness. Its integrated native nested-statement attribution and inclusive buffer
accounting (`test/support/growth-capture.ts`, `growth-cost.ts`, including the native nested cost case) are used as-is;
no allowance, calibration or original native outcome has been changed.

### Current resource role keys

`current-resource-roles.ts` is the internal Access directory consumed on the caller's authorized native writer
client. It enumerates role keys, including group and active-account subjects; it does not establish Account
liveness, permission, ownership or a successor. Its complete public declarations are:

```ts
type CurrentResourceRoleKey = Readonly<{
  grantRole: string;
  subjectKind: 'identity' | 'active_accounts';
  subjectId: string;
  subjectRole: '' | 'owner' | 'member';
  intervalKey: string; // decimal native resource_role_grant.erasure_key
}>;
type CurrentResourceRoleFrontier = Readonly<{
  resource: Readonly<{ route: number; id: string }>;
  version: string; // decimal native resource writer/transition version
  validFrom: string; // native timestamptz text, inclusive
  validUntil: string | null; // next native boundary, exclusive; null means no queued boundary
  roles: readonly string[]; // deduplicated, sorted requested role names
}>;
type CurrentResourceRoleAfter = Readonly<{
  frontier: CurrentResourceRoleFrontier;
  key: CurrentResourceRoleKey;
}>;
type CurrentResourceRoleUnavailable = Readonly<{ status: 'unavailable' }>;
type CurrentResourceRolePage = CurrentResourceRoleUnavailable | Readonly<{
  status: 'ready';
  rows: readonly Readonly<CurrentResourceRoleKey & { valid: string }>[];
  frontier: CurrentResourceRoleFrontier;
  after: CurrentResourceRoleAfter | null;
}>;
type CurrentResourceRolePageInput = Readonly<{
  resource: Resource; roles: readonly string[]; at: AuthoritativeTime;
  after: CurrentResourceRoleAfter | null; limit: number;
}>;
type CurrentResourceRoleVerificationInput = Readonly<{
  resource: Resource; frontier: CurrentResourceRoleFrontier; at: AuthoritativeTime;
}>;
type CurrentResourceRoleVerification = Readonly<{ status: 'ready' }> | CurrentResourceRoleUnavailable;
readCurrentResourceRolePage(client: AccessClient, input: CurrentResourceRolePageInput): Promise<CurrentResourceRolePage>;
verifyCurrentResourceRoleFrontier(client: AccessClient, input: CurrentResourceRoleVerificationInput): Promise<CurrentResourceRoleVerification>;
```

The input accepts 1..1000 role names and a page limit of 1..100. An initial page passes `after: null`. Order is
`grantRole, subjectKind, subjectId, subjectRole, intervalKey`, using native database ordering. A non-null `after`
carries the last returned key and original frontier; null ends traversal. A writer-version, role-set or temporal
horizon change returns unavailable: discard the old traversal and restart. Invalid input throws TypeError.
An absent resource frontier, incomplete installation, T before its processed frontier or a boundary due by T
returns unavailable, including an unknown resource with no source roles. A known initialized resource whose roles
were all removed can return a ready empty page. Readiness is for the role directory only. Every page row is checked
against its exact authoritative source interval at T; missing/mismatched source rows return unavailable.

The native source remains `access.resource_role_grant`. A migration locks its writers, captures a finite erasure-key
high water and installation time, and installs an AFTER INSERT/UPDATE/DELETE hook before releasing that cut. The
same hook covers grant commands, initialization, direct-role writers and erasure in their own transaction. It
serializes the resource frontier, increments its native version, installs just the interval valid at the processed
time and queues its actual later start/end boundaries. The directory contains only current full-key/interval
references; the temporal queue contains only resource/interval references. Neither stores policy or allowed flags.
FK cascades remove derived principal keys and boundary work when their source interval is erased.

Default Accounts work always registers `current-resource-roles-work.ts`. Each atomic maintenance call processes at
most 100 source rows during finite installation, then at most 100 due boundaries through the due-time B-tree.
Installation alone traverses the captured history by unique erasure-key cursor; requests never traverse it. All
resources stay unavailable until that cut is complete. New writes are captured throughout installation. Afterward
the directory is complete at `processed_at`; the first queued resource boundary is its exclusive validity horizon.
A due boundary invalidates readiness immediately even if maintenance is late. Bounded default catch-up removes
one exact boundary, checks the source, updates its current reference and advances the resource version/time in the
same transaction. Other boundaries at the same time still block readiness until processed. Work resumes from the
durable cursor/queue after restart. No installer option, membership coordinator or acknowledgement is added.

One page is one statement/snapshot: two exact frontier/install reads, two resource due-key probes (next horizon and
T readiness), at most R*(limit+1) indexed current keys before the bounded merge and at most limit+1 unique source
interval seeks. It returns at most limit rows plus one bounded lookahead. Cost is O(R*(limit+1)*log D +
(limit+1)*log N), independent of expired role history except the source B-tree height; D is directory size and N is
native source size. Verification is one exact resource frontier lock/read plus the same readiness probes. Upkeep
is separate measured native work: source hooks touch a single resource version, one current reference and at most
two boundary references per inserted interval; each maintenance call performs at most 100 such indexed units.
Native trigger/nested statements and index maintenance remain part of measured Cost, never a free allowance.

Realm continuity must hold its own actual Realm writer serialization, verify the frontier on that same writer
transaction before concluding traversal/applying a choice, and restart after invalidation. Verification holds the
native resource frontier `FOR SHARE` through commit, fencing role mutation and temporal upkeep. A selected direct
identity candidate must additionally pass the existing `account-share.ts` `shareAccount(real CommandTransaction,id)`
or `fenceOperationalAccount(real OperationalTransaction,id)` on that same native writer client. Its Account
`FOR SHARE` is held through commit. A denied/unknown Account admission remains pending; it does not prove structural
no-candidate. No separate snapshot or mutable transaction-id surrogate is provided by this directory.

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

### Approve one Realm claim

- Touches: released current actor/principal and exact Global action evidence; the selected Content request/current
  Realm source; the existing Realm creation lock and current-role frontier; one claimant fence and native
  grant/state/receipt bundle in that Realm home. Content source/application is still required as described above.
- Bound: fixed indexed point probes and O(changes log R), with the existing authorization bounds. The partial
  `realm_claim_current_owner` index excludes group subjects; its temporal probe skips closed owner history. No membership,
  owner graph or request enumeration, and no new owner store.
- Growth check: preserve existing authorization/grant/source bounds for native acceptance after integration.
  Current minimal verification adds no native growth capture. `test/access/realm-claim.test.ts` records the focused
  approval, refusal, retry, competing-request and atomic-rollback outcomes; it has not been run in minimal mode.

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

`GET /v1/accounts/{accountId}/profile` (`account.read_editable_profile`) returns the private editable
`{ profile }` source by full account key, including handleless accounts. It requires `updateAccount`'s native
authority: `account:update` on an ordinary account, or `account:manage` on an operated actor's current operator.
Preparation releases foreign evidence before checkout; the operator check is separately released and the subject
snapshot confirms the exact binding. Current viewer, scope, principal, state and fences still apply. Unknown,
inactive, fenced and denied subjects return no profile (403); authentication failures retain 401. Normal platform
admission precedes the handler. This GET has no write-rate declaration or command receipt. Responses use
`private, no-store`. The closed DTO contains `id`, `kind`, nullable current `handle`, `displayName`, `bio`, `links`,
Content's current `AvatarSummary` (or null), four `publicViews` flags and organization-only `speakersListed`.
Missing/malformed visibility values fail closed to false; no proof or stored avatar URL is returned. Former handles
are never read keys. Public identity and discovery projections are independent.

`PATCH /v1/accounts/{accountId}` (`account.update`, action `account:update`) updates the public profile through
`updateAccount`. It accepts a nonempty partial patch of `displayName`, `biography`, `avatar`, `links`, `publicViews`
and organization-only `speakersListed`, preserves omitted values, clears nullable fields with null, merges view flags,
requires the account's own available avatar media and existing account or operator management authority, and uses the
ordinary account-command idempotency and problem responses; unknown fields and malformed values answer 400
`invalid_request`.
Automated profiles authorize the operator through the internal `account:manage` declaration. Mounting this route
does not add that scope to the mounted catalogue: the client's Auth composition must explicitly include it, and
the operator's session must consent to it.

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

- Returns per live visible account: `id`, `kind` (`actor` or `organization`), `handle`, `displayName`, `state`
  (`active`), `automated` and `operatorId`. An account with an operator is `automated: true` and names its operator;
  every other live account is `automated: false` with `operatorId: null`. A deleted identity's contract is exactly
  `{ id, kind, state: 'deleted' }` for both actors and organizations, without profile fields or an automation label.
  Deleted rows return before Subject, avatar or operator hydration. Pending accounts are absent and no private
  field is selected.
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

### Public Account canonical targets

The [Account discovery contract](account-discovery-contract.md) owns native discovery production and
`account-discovery-reduction.ts:readAccountDiscoveryReductionBinding`. Its immutable sorted heads observe
Account and exact-claim counters plus current ownership epochs for every requested native home, including
empty and excluded populations, in one released native snapshot. The shared registered Source must enumerate
the complete configured Account **and** hashed claim domain in bounded pages and retain these heads in its
original immutable capture. Current writer witnesses and later repair ACKs cannot revalidate an old capture
after a changed head. Root/order/read definition, whole owner-domain closure and actual physical incarnation
remain the Source owner's independent obligations; kernel ownership epoch is not restore activation.

`account-canonical-targets.ts` exports `PublicAccountCanonicalView = 'overview' | 'posts' | 'reviews' | 'collections'`
and `PublicAccountCanonicalTarget` with
`{accountId, accountKind: 'actor' | 'organization', handle: string | null, canonicalPath: string | null,
views: readonly PublicAccountCanonicalView[]}` and
`readPublicAccountCanonicalTargets(deps: SummaryReaderDependencies, subjectIds)` returning a map with explicit
nulls. It validates and deduplicates at most 100 full routed input keys before I/O, groups native pointer and
Account reads by home, and always hydrates through the actual anonymous Account discovery summary reader.
Semantic retains ordinary Subject discovery/listability and its feed constructor; null proves neither.

A positive requires reciprocal current Account, page-pointer and Semantic account-agent links with the same
verification receipt, plus the delivered `semantic/identity-epoch-read.ts:readIdentityMappings` publication
guard for both the derived agent and the requested terminal. Stored verification flags and legacy redirects
alone cannot satisfy it. Missing, pending or unavailable required publication authority throws typed
unavailability. No provisional replacement of the native reader is installed. Completing legacy verification's
native publication remains the Semantic verification producer's responsibility.

Native source revisions, exact claim revisions, reciprocal links and publication epochs are collected again
after released foreign hydration; a changed candidate is withheld. Active unfenced Accounts with former,
pending, missing or foreign claims remain valid identities with null handle/navigation. Only an exact current
active claim supplies `/@${encodeURIComponent(handle)}`. A handleless identity has no public URL. These are
readonly facts, with no writer, disclosure-policy, catalogue-identity or operator-identity substitution.
Native Account and exact-claim reads also require current active partition homes; missing, fenced or moved
homes retain typed unavailability instead of supplying absent rows or apparently missing claims.

A navigable target includes `overview` for its proven canonical root and only enabled native activity names from
`readPublicViews`. Handleless targets have no view names. Flags share each initial/final native Account and claim
snapshot and are compared directly, independently of discovery revision; a change withholds the candidate.
No Subject template, Realm or agent-feed view is inferred. These are current presentation opt-ins, never permission
to read Content/Library items, whole-query excluded/order/restore authority or future permission. Native anonymous
routes, formulas, exposure metadata and final list readers remain authoritative; consumers intersect template views
with this list and call the same original batch for final revalidation.

- Touches: at most 100 exact Subject pointers and Account bindings per observation, reciprocal links and at most
  200 identity mapping keys in batches of 100; native flags add one full-key statement per Account home to each
  initial/final binding snapshot. Anonymous summary hydration remains bounded by the existing reader.
- Bound: existing input and hydration bounds remain unchanged; flags add O(ids) rows, O(partitions among ids)
  statements and O(ids log N) indexed work, with no per-account HTTP or leaf-list reads.
- Growth check: the existing `test/access/growth-account-public-views.test.ts` native flag bound applies;
  `test/access/account-canonical-targets.test.ts` covers bounded input and current view admission.

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

The installed `platform.governance` role includes `zone:create` on the Global Context. A governor may delegate
that existing action through the ordinary grant command; Zone creation still checks the current grant and initializes
the actual owner role in the Zone's native command transaction. Bootstrap does not create Zones, grant the action to
other accounts automatically, or open public exposure.

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

### Native creation attribution

`@rezics/auth-contract` exports the literal `NativeCreationContext` and
`NativeCreationContextRequest` from `native-creation-context.ts`. Native composition binds the exact
`readNativeCreationContext` function on both `trustedAccess` and `workflowPorts`. Auth can call either before
creating a new private automated-registration stage or existing workflow request. Historical hosts may omit
the port; absence never establishes empty party scope. This adopts the Access source projection requested by
[Auth's metadata privacy contract](../../../auth/src/metadata-privacy-contract.md), without adding a contact
command or personal metadata permission.

The request supplies the original approval reference, logical `operationKey` and complete existing
`AccountOperation`. The existing approval resolver compares the original immutable business operation and key,
restores the native approval identity, and runs its unchanged current-T formula with the original client,
scopes and assignment. Automated creation's initial empty registration ID is valid before allocation; a later
registration ID must match Auth's existing exact `NativeWorkflowProofPorts.creationBinding` reader. Access
receives that bounded closure, never Auth SQL, credentials or a database handle. The reader renews no approval
or replay authority and returns no private result or business payload.

The immutable basis is the native approval reference, logical operation key, operation digest and existing
stable command prefix (`commandKey`). Native steps continue appending their existing fixed phase to that prefix.
The closed operation projection carries only its native kind, permission action, permission resource ID and,
for `client-reduction`, exact target client ID. It does not invent a new account target before creation.
Auth alone supplies a target client's locked owner; Access does not read `auth_client` or infer ownership
from the actor, client ID or permission resource.

The actor and authenticated `sourceClientId` come from the resolved native identity. `copyActors` and the
projection share one current native party reader: an active, unfenced actor without an operator proves its
own human role; a present `requested_by` must resolve the exact current native assignment and principal.
No assignment makes the principal role inapplicable for that command. An automated actor's approval has
no original opening locator, so it returns typed `unavailable: opening-provenance`; neither the actor nor
its operator is substituted for the missing human. A missing historical approval returns typed
`unavailable: historical-provenance`. Existing private-copy attribution refuses unavailable roles.

The operator is the exact operator in an approved automated creation, opening or transfer, or the current
native operator whose management authorizes an automated-account deletion. An opening additionally checks
the named subject's current native operator relation. Commands using no operator relation carry null for
that role. No role is inferred from a handle, email, JSON field, ciphertext or arbitrary requested-by string.
The source performs only the existing bounded approval/formula reads and released account/assignment point
reads; a one-connection pool suffices, with constant extra rows/statements and logarithmic indexed lookups.

This is private attribution data. It cannot replace an Actor, authorize an effect or result disclosure,
prove erasure, cover shared-history copies, or claim native/participant completion. New Auth consumers must
compose their own source transaction and custody before opening a private writer. The focused native cases
are in `test/access/native-creation-context.test.ts`; their integration acceptance is separate from this
source implementation.

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
| Managed erasure progress read                          | One minted read T; before/final current actor point reads and exact Global formula preparation/checks; Global and selected account partition points; native erasure root, frozen eleven-participant range, open-late-item probe and existing open-locator minimum-key frontier probe. Each checkout is released before foreign authority preparation. Zero writes or coordinator advances.                                                                                                                                                                                                                                                                      | Constant statements and rows for the fixed eleven participants and at most sixteen exceptions per participant, plus the existing bounded actor/principal membership neighborhood; logarithmic blocks in unrelated accounts, grants, erasures and locator-work history.                                                      | None: scoped transport projection reuses native status and Access bounds; dedicated measured growth evidence is deferred. The focused projection/denial cases are in `test/access/erasure-status-read.test.ts`; they do not prove native completion or custody.                          |
| Record or resolve a late erasure item                  | one primary-key erasure probe and one primary-key late-item insert or update in the account's home; recording shares the caller's locator transaction, resolution uses one platform command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | constant statements and rows; logarithmic blocks as unrelated accounts, erasures and late items grow.                                                                                                                                                                                                                       | `test/access/growth-erasure-coordinator.test.ts`: “late item ${phase} has constant statements and rows at three scales of unrelated accounts and late items”                                                                                                                             |
| Advance erasure completion                             | one locked erasure key; once per erasure, one frontier snapshot statement over the fixed partition map; one keyed checkpoint probe per stored frontier partition; one ordered DBOS locator-queue lookup through `idx_workflow_status_in_flight_v2`; one open-late-item existence probe and the bounded acknowledgement count.                                                                                                                                                                                                                                                                                                                                   | constant statements and rows in account data and unrelated history; logarithmic blocks. The snapshot and stored frontier are bounded by the fixed partition map; the DBOS lookup costs one descent per distinct priority.                                                                                                   | `test/access/growth-erasure-coordinator.test.ts`: “completion with ${phase} frontier stays bounded as outbox history, erasures, late items and unrelated DBOS workflows grow”                                                                                                            |
| Close an organization                                  | the organization's account, hold and saturated owner reads, the actor's exact owner membership and one cleanup checkpoint, all anchored in the organization's partition. No member enumeration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | constant rows and statements, independent of member count; indexed probes use logarithmic buffers.                                                                                                                                                                                                                          | `test/access/growth-organization-close.test.ts`: “close has constant rows and statements as target and unrelated memberships grow”                                                                                                                                                       |
| Provisioning proof                                     | `createRegistrationProofBindings({pool,referenceKeys: KeyRing})`: `createProvisioningReference({input,outcome})` takes the exact `createPending` input `{accountId,key,handle,reservationId}` and awaited native `CommandOutcome`; `verifyProvisioningReceipt(reference)` verifies one core receipt via the trusted reader. Fixed internal principal, `access.actor-pending`, derived partition and route-prefixed key; digest, transaction, epoch/position and response must agree. `registration-proof-account.sql` binds the pending actor, handle, reservation, expiry and creation transaction, enforcing expiry at PostgreSQL time regardless of cleanup. | In stored data S: constant rows/statements, `O(log S)` buffers; at most 1 receipt, 1 account and 1 partition epoch/fence read. 3 data statements plus BEGIN/COMMIT; invalid keys/digests stop earlier. Seal input/output <=4096 chars. References confer no Auth authority/completion; no registry or Auth credential read. | `test/access/growth-registration-proof.test.ts`: “reference lookup is bounded across receipt history”                                                                                                                                                                                    |
| Open interval lookups                                  | one exact probe using the partial open-key btree or a temporal GiST key (`resource_denial_pkey`, `resource_denial_permission` or `resource_role_grant_pkey`). The base-table probe keeps both `upper_inf(valid)` and `valid @> T`, so the btree selects only the open row and GiST also excludes closed intervals for that key. Ending a denial repeats the time condition on the update. An insert also runs the temporal primary-key exclusion check.                                                                                                                                                                                                         | O(log R) per statement, constant rows and statements, independent of one key's closed history and unrelated keys under any selected index.                                                                                                                                                                                  | `test/access/growth-open-interval-history.test.ts`: “denial lookup stays bounded as recent closed history grows (${statistics})”; “denial lookup stays bounded as unrelated keys grow (${statistics})”; “repeated group role grants stay bounded as unrelated keys grow (${statistics})” |
| Governance bootstrap                                   | one native Global command to install the governance role and its receipt/outbox, followed by a separately authorized standing-parent command for `organization:create`. Replays recheck the role installation marker and the standing-parent marker; a conflicting operator is refused before the second command.                                                                                                                                                                                                                                                                                                                                               | constant rows and statements at fixed actor and Global anchors, with logarithmic buffers as unrelated accounts and Global grants grow. The integrated check observes four account rows on first install/replay and one on refusal; refusal performs only the initial command attempt.                                       | `test/access/growth-bootstrap-governance.test.ts`: “checkGrowth 1x/8x/64x ${mode}: native operator command and exact child CLI use bounded seeks”                                                                                                                                        |

Semantic identity job steps and participant-owned erasure cleanup have no row because those operations are not implemented on this base.

## Private account management reads

`GET /v1/me/managedAccounts` (`account.list_managed`, `account:read`) reads the current human's own identity,
organization memberships and personal operator responsibility holds. It accepts `organizationsCursor` and
`operatorsCursor`. Incomplete native membership-inverse coverage returns an explicit `preparing` organization
section, while independently available identity and responsibility sections remain readable.

`GET /v1/accounts/{accountId}/management` (`account.read_management`, `account:read`) accepts `membersCursor` and
`operatorsCursor`. Both routes require the installed formula's `account:read` on the human's own account, and
reject operated identities. Organization details require current native membership. Private holders and operator
responsibilities additionally require `account:manage` on that organization; an ordinary member receives a denied
holders section. An automated target requires current management of its native current operator, including current
organization membership where applicable. Attribution and coordination rows never confer management authority.

Reads use one authoritative read time, 20 scanned candidates per section and viewer/target/feed-bound signed
cursors. The inverse is bounded by its existing 1000-membership cap; every candidate is checked against current
organization membership. Member candidates seek the native live-membership slot index and each verifies its authoritative temporal role; responsibility seeks
reuse `operator-page.sql`. Each scanned responsibility has one subject-anchor relation read; `current` means the
operator and exact reservation still match, while `reconciling` means the hold remains without that match. Neither
state asserts a workflow's completion or cancellation. Responses are allowlisted and `private, no-store`, with no
credentials, approval references, private profile or suspension reason. These read endpoints add no write capability.

The detail DTO adds optional `authActions`: `{state: "ready", operations: [...]}` or
`{state: "unavailable"}`. Each positive entry contains only `operationId`, `action` and
`resource: {route, id}`. Older DTOs may omit the field. The native producer emits its current observation;
missing or unavailable metadata supplies no entry. Known denial or inapplicability omits the operation from
`ready.operations`. Unavailable action dependencies do not block independently admitted read-only detail.

The closed native identities reuse the original workflow approval descriptors:

| Operation ID                   | Domain restriction                                                                          | Action and exact authority resource             |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `auth.account.rename`          | Selected self, active unfenced human without an operator                                    | `account:update` on that human                  |
| `auth.organization.membership` | Selected active unfenced organization and current native membership                         | `organization:membership` on that organization  |
| `auth.operator.transfer`       | Active native operated actor with the genuine current slot, reservation and version         | `account:manage` on its current source operator |
| `auth.organization.delete`     | Selected active unfenced organization, actual current human/principal and native membership | `account:delete` on that organization           |

These restrictions only narrow candidates. Each positive runs the installed native action-general Access formula
on the genuine caller, client, consented scopes, current principal assignment, floors, grants and denials at the
read's authoritative time. Native account, operator, membership, relation and home observations are validated before
and after released foreign preparation. Missing native opaque action evidence yields `unavailable`; a raw callback,
role name, owner equality, profile `account.update` viewer action or cached observation cannot create an entry.
Transfer reads reuse the original source slot interpretation and never check an unrelated operated target as its
authority anchor. Destination admission and acceptance remain separate.

This metadata observes workflow ENTRY only. It conveys no approval, result, pending workflow, private body, reference,
key, credential or URL, and does not assert that an Auth route is deployed. Consumers independently require the
explicit deployed Auth path. Auth retains exact-profile consent, fresh same-human step-up, second submission and
all original payload, execution and replay validation.

Cost: a fixed set of at most four native entry action checks on known exact targets (this surface currently selects
one self, two organization or one transfer entry), plus bounded before/final account, assignment, operator slot,
membership and home point reads. Each action retains the existing O((1 + K) log N) permission preparation/formula
cost and membership cap. Foreign preparation holds no source connection, and final validation uses one bounded
snapshot with no second checkout. No holder, account or private-list scan or per-row HTTP is added. Existing
20-row candidate limits, signed viewer keyset cursors, raw work limits and request deadlines remain unchanged;
there is no new numerical allowance or ledger.

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
  of reasons owed to a content author, the decision owed to a notifier and required appeal outcomes. These
  preferences cover in-app notices; there is no email delivery.

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

The helper remains a read, not a notice-commit witness. The selected consumer contract makes optional-send final
at the actual recipient notice commit, using current native recipient preference/account state and existing
current resource Access. Content retains delivery and must durably preserve suppression/replay; separate helper
and Access reads plus deduplicating insertion do not alone establish this race outcome. Required moderation,
report and appeal outcomes are independent of optional toggles. Optional off affects future optional sends,
not old inbox entries, content authority or follows. See [Accounts adoption](../../../../docs/accounts.md#6-auth-ownership-and-registration)
and the [notification research](../../../../docs/research/accounts-design-notification-preferences.md).

Consumers retain the actual effective-map/default, null-reset, shared CAS and replay contracts above. Web must
distinguish an ambiguous save from confirmed Saved and unavailable unread data from zero, preserving session
and CSRF behavior. A replayed preference response is historical acknowledgement; fresh GET establishes current
readback. No channel, quiet-hour or conversation setting is implied.

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

### Native Context ownership occurrences

`shared-history-context.ts` addresses original Access provenance, independently of HistoryArtifact copies and
ordinary record SourceSet/purge. The native key is `{route:number, occurrence:string}`; occurrence is a positive
canonical decimal PostgreSQL bigint. The producer records `resourceId`, `resourceType:'semantic.context'`,
`originalCreator`, `accountId`, `grantRole`, `valid`, `side:'creator'|'new'|'former'`, `grantTransaction` and
`sourceTransaction`. `contextKey` and `delivery` are receiving state. These fields are metadata, never permission.
OLD before DELETE and NEW after INSERT are separate occurrences; current ownership cannot replace either.

The original deferred `resource_role_provenance_deliver` trigger calls
`access.try_deliver_resource_role_provenance(route,occurrence)`. It locks and validates the genuine native row,
then passes its literal fields to Semantic's published `semantic.enroll_context_role_provenance` SQL port.
The executor's real same-transaction editorial write basis must exist before this deferred call enrolls.
`deliverContextRoleProvenance(tx,{route,occurrence})` uses the same Access source lock, then the actual
`enrollContextRoleProvenance` TypeScript wrapper in a live same-home command. That wrapper records Source's
forthcoming native commit and its own deferred constraint validates the executor's eventual fence.

Delivery changes only after Source returns actual enrollment with its real Context erasure key, or its explicit
native `not-applicable` policy. The update guard invokes that idempotent Source port again to verify the transition
in the same physical transaction; a key or boolean alone cannot forge delivery. Source owns the original/late
locator and generation admission. Access reads no Source tables. An unavailable SQL receiver produces the typed
`semantic-context-historical-party-receiver-unavailable` result. Unresolved receiving produces
`semantic-context-historical-party-enrollment-pending`. Both preserve pending input, including creator and unknown
roles. Non-Context occurrences are not applicable. No artifact, candidate, account token, deletion generation or
current DATA authority is synthesized.

Each existing default `shared_history` work unit keysets one configured `core.partition` home and uses a genuine
`runOperationalTransaction` work step to select at most eight pending `(route,occurrence)` keys from
`resource_role_provenance_delivery`. It releases that transaction, connection and gate before a native platform
`runCommand` re-locks and revalidates those exact source rows in the same home and invokes the Source wrapper.
There is no Actor or human permission reconstruction. Only a changed page emits an empty native advancement event,
so its real command basis/fence validates Source enrollment; a pending-only page makes no domain write.
Home discovery also releases its connection before selection; no foreign home or SDK is entered while an occurrence
is held. Source metadata is immutable. A failure rolls back the delivery batch and preserves its scheduling cursor.
Volatile per-home cursors wrap and start over after restart, including rows skipped because another worker held
their lock. These cursors contain only native keys; there is no new journal, queue or coordinator. Delivery alone
proves neither Source's historical cut nor History receiving completeness, and does not change the account erasure
participant proof or final acknowledgement.

The shared-history participant covers `command-receipt/v1`, `outbox-event/v1` and `durable-work/v1`. Receipt
skeletons retain receipt identity, principal and command identity, request digest, transaction and observed position,
and a versioned keyed-hash replay token; the raw idempotency key and response payload are removed. Event skeletons
retain stable partition, position and event sequence plus type and schema version, with personal payload and subject
removed. Durable-work history is canceled and deleted through supported DBOS APIs after native obligations are
settled or transferred. Locator discovery is sealed to the committed `access.erasure` obligation and visits the
fixed 4,096 partitions one at a time, seeking only the account prefix. These are required dispositions. Current
runtime includes exact receipt/outbox minimizers, supported SDK retirement and the default native receiving worker
described below. Complete producer conversion, scoped execution admission budgets and final coverage remain gaps. Semantic provenance has its own owner and retention
rules; content and delivery custody, including media and caches, remain separate obligations.

Realm claim approval associates its native receipt and outbox event with the actual approval transaction and
Realm subject; its result/event also carries the claimant account. Those shared-history artifacts retain the
same unconverted-producer custody/minimization gap. The owner role uses the existing `resource_role_grant`
inventory below. Content owns the native request, selected decision and original orphan provenance; Access
introduces no separate approval history or owner store.

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
- `access.current_resource_role_key`: derived current subject/resource/role and source interval key only. Native
  source deletion cascades the current key; it adds no independent subject-erasure traversal or history retention.
- `access.current_resource_role_due`: resource, source interval key and future boundary only, with the same source
  cascade. No principal payload. `access.current_resource_role_frontier` retains resource id, technical version and
  processed time under the same account-resource inventory as the authoritative roles; it carries no subject keys.
  `access.current_resource_role_install` contains only the finite technical install cut/cursor/time.
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
  the native keyed replay token, digest, principal and transaction/time. The default shared-history worker replaces
  preference and mechanical Library entry-retention purge response JSON with marked tombstones after their
  committed erasure barriers; other receipt kinds await their owners' native result dispositions and minimizers.
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
bindings by secret generation (authenticated account); atomic copy locators beyond the delivered preference
producer; and independent
traversal ordinals with removable id bindings (organization members and operator-page subjects). Their disposition
must follow the participant contract: temporary locators/progress are removed after consumption, minimal native
completion/refusal survives outside DBOS, and cursor boundaries never retain account ids. These requirements do
not claim that existing payloads are already minimized or that shared-history handoff exists.

### Known retention gaps

- Backup expiry is an open external condition: no backup retention policy exists, so the coordinator does not model it.

- Access has no takedown of a single profile field (display name, avatar, biography or links) in [lifecycle.ts](lifecycle.ts); under the [policy](../../../../docs/deletion.md), a takedown would withhold only the field the notice covers and keep the data.
- Native terminal account minimization waits for every local proof consumer; missing consumer and shared-copy proofs still prevent complete erasure and a closure deadline.
- Handle-based reads of retired and deleted handles return the same empty list as unknown handles; ids reads retain the exact three-field deletion identity.
- Native handle cleanup permanently retires allocations without owner/provenance and purges consumed operation/effect/registration-expiry rows; unfinished handle consumers still block their pages.
- Native cleanup covers terminal organization history, consumed slots/proofs and principal assignments. Live inverse/coordination cleanup and Realm terminal-proof consumption still depend on actual owner completion.
- Native deletion removes subject/account-resource grants, role grants and denials and minimizes initialization/bootstrap attribution. Surviving grants' command provenance still requires shared-copy cleanup.
- Rating controller history has no erasure trigger or justified retention duration.
- Fence, credential-floor and operator-opening receipts have no erasure/minimization schedule; expired opening authority leaves personal payloads stored.
- Workflow approval expiry has a sweep primitive but no registered scheduler or bounded erasure deadline.
- Continuation roots, children, completions and fan-out pages retain prior handles/relations indefinitely. No alert was found for a committed deletion continuation expiring before cleanup finishes; governance renewal exists but is not an alert.
- Native terminal verification cleanup removes deleted-subject requests after reversal and minimizes erased requester/reviewer attribution on surviving requests. Missing decision/reversal consumption still blocks cleanup; outcome notification remains separate.
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

### Auth-only erasure evidence

`createNativeAccountBindings` composes `createAuthHistoryProofBindings(pool)` into
the optional-capability/fail-closed `createAuthBindings` boundary. Shared types are
`AuthErasureBarrier` (`accountId`, immutable erasure `version`, exact `at`) and
`AuthErasureSource` (that tuple plus original `continuationId`/`receiptId`) in
`@rezics/auth-contract`. The trusted readers are `readAuthErasureBarrier(accountId)`
and `readAuthErasureSource({accountId,receiptId})`. Each read is anchored to the
account partition and the permanent committed kernel obligation; Auth wall time
or an authentication floor never supplies the barrier.

The fixed methods `recordAuthNativeConsumption(source)` and
`recordAuthHistoryCompletion(barrier)` write separate immutable phases in
`access.auth_history_proof`. The closure fixes the source to Auth and accepts no
principal, participant, phase selector, locator, payload or authorization flag.
Missing capability, original continuation, target, barrier or terminal/fenced
account fails closed. The same immutable proof is idempotent after a lost reply;
a different tuple is refused. Every redrive rechecks the permanent erasure and
terminal/fenced account. A copies-erased submission requires the matching earlier
native-consumed phase; one fact cannot stand in for the other. Kernel keeps no
Auth database handle or credential
and makes no maintenance call into Auth.

`readAuthNativeConsumption(pool, source)` lets Access consume only the exact
native fence/release dependency transferred by Auth's actual consumer. Mere
acceptance/enqueue/progress or terminal DBOS status supplies no witness. This
phase can precede Auth copy cleanup and cannot discharge other native consumers.
`readHistoricalAuthHistoryCompletion(pool, barrier)` reads the later immutable
local-copy publication. It carries no current receiver or restore authority.
`readAuthHistoryCompletion` now requires the independent current closure described
below. No participant ACK or final Kernel ACK dependency is introduced.

### Current Auth receiving controls

`shared-history-auth.ts` retains its original native/history exports and supplies
registration, invalidation, publication, released preparation and live-transaction
verification. `createNativeAccountBindings` binds publication to the actual Auth
service's private `internal.receivingClosure` factory. The caller supplies only
an exact obligation key; it cannot submit a consumer proof blob.

Access owns `auth_receiving_control`, `auth_receiving_obligation` and immutable
`auth_receiving_closure` outside the Auth image. A control revision is a fencing
sequence, never a receiving incarnation. Every current receipt fixes Source
continuity, exact account/version/T, database identity, receiving incarnation,
restore generation, installation, writer fence, physical/receiving custody and
the original accepted source continuation/receipt. Historical copy publication,
early source transfer, successful child, registration and page EOF cannot issue it.
Registration creates only a pending obligation. No identity is backfilled.
Barrier validation rejects account IDs without a native route before checking
out a home; a UUID without a route cannot select partition zero through coercion.

`prepareCurrentAuthReceivingClosure` releases its native checkout before returning.
`verifyCurrentAuthReceivingClosure` re-locks that exact receipt and binding in the
caller's live transaction; it refuses autocommit and changed receipts. The local
SQL function `lock_current_auth_receiving_closure` locks Source/home, current
control, account/original floor/barrier and exact custody/receipt/history keys.
All keys belong to one partition. Invalidation takes the same control exclusively;
its quarantine/revision commit precedes replacement enrollment or replay. Locks
survive destructive COMMIT. No Auth I/O, second home, cross-home join, process-only
cache or caller attestation supplies authority. JSONB object ordering is irrelevant
to exact structural equality.

The native fence-receipt consumer uses this same function inside its existing
transaction. The forward `auth_receiving_witness` DELETE trigger independently
rechecks it, including the original receipt identity. The closure INSERT guard
independently validates Source, control, original tombstone receipt/floor and
exact custody/native consumption under those same locks. Pending control and
obligation INSERT guards also validate the live original Source and exact
account/barrier/floor under native locks, including ON CONFLICT attempts; a
registration cannot permanently pin a caller-selected Source or barrier. A held tombstone cannot be
retired on early transfer or historical custody. Other native consumers retain
their original release requirements.

External installation is parked explicitly: no existing Auth host owner input
supplies independently verified original database identity, surviving installation
and inventory/isolation, receiving/restore generation, permanent writer isolation
and per-obligation physical/receiving closure together. The existing
`AuthRestoreDatabaseOwner` inventory/progress operations supply only their stated
operands. Control activation/identity and obligation custody transitions therefore
refuse natively. There is no installer ABI, default identity, ready callback,
historical-image claim or SQL permission bypass. Restored host composition can
forward the existing trusted Access controls; import/replay/live enrollment still
refuse missing control or a database identity different from verified inventory.
Ordinary authentication is unchanged. The allowed missing external operand does
not establish whole-feature or native acceptance.

#### Bounded receiving SQL

These are derived upper bounds for the implemented local entries, rather than
physical-owner allowances. A key visit counts each keyed table row read or write,
including repeated reads and FK checks; a missing indexed prefix costs at most
one examined key. Q is client SQL statements on the successful longest path;
inner SQL table statements are stated separately. Add one ROLLBACK statement on
a failure after BEGIN. Engine MVCC visibility work follows the architecture rule.
Returned binding/locator limits are 1 KiB, total result limit 64 KiB. Each entry
selects one exact account and one home; none expands into an owner inventory.

| Entry                               | Key visits |        Client Q | Additional SQL table statements / bounds                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------: | --------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read control                        |          3 |               5 | Source/home 2, control 1; includes BEGIN/settings/COMMIT                                                                                                                                                                                                                                                             |
| Register                            |         17 |               9 | Source/home 2; control INSERT + source FK 2; control lock 1; account/barrier/original floor 3; obligation INSERT + two FKs 3; binding 1; INSERT guards reread Source/home 2 and original barrier/floor 3 in two inner statements. At most two inserted rows                                                          |
| Invalidate                          |          8 |               7 | Source/home 2; control INSERT + FK 2; control lock 1; revision/quarantine UPDATE 1; control INSERT guard rereads Source/home 2 in one inner statement, including conflicts. Same requested generation is idempotent; no fanout                                                                                       |
| Native current locator              |          9 |               1 | Four inner table statements: Source/home 2, control 1, root/floor 3, obligation/closure/native consumption 3. No writes                                                                                                                                                                                              |
| Prepare                             |          9 |               4 | Native locator's four inner table statements, plus BEGIN/settings/COMMIT                                                                                                                                                                                                                                             |
| Verify in caller transaction        |          9 |               3 | Same four inner statements plus xid assignment and live-xid comparison; caller funds its transaction controls                                                                                                                                                                                                        |
| Publish, native portion             |         44 |              19 | Full register 17/9 including its two inner registration guards, then released Auth producer, then final native transaction 27/10. Final Source/home 2, binding 1, root 3, custody 1, consumption 1, closure INSERT + FK 2 + insert guard 8, current locator 9; adds four inner statements each for guard and locator |
| Closure INSERT guard                |          8 |   within INSERT | Four inner table statements: Source/home 2, control 1, root/floor 3, custody/native consumption 2; no Auth I/O or writes                                                                                                                                                                                             |
| Shared-history verify Auth addition |          9 |               1 | Same-home locator, four inner statements; a different job home refuses before the call; original History work is unchanged                                                                                                                                                                                           |
| Shared-history ACK Auth gate        |         11 |               2 | Exact job/registry 2 then current locator 9/four inner statements; removes the historical Auth-proof join; caller retains transaction/final ACK costs                                                                                                                                                                |
| Fence consumer current check        |         10 |               1 | Exact barrier 1 plus native locator 9/four inner statements, independently repeated per actual selected witness                                                                                                                                                                                                      |
| Fence DELETE guard                  |         11 | caller's DELETE | Selected old row 1, barrier 1, native locator 9; five inner table statements. Every deletion repeats the guard; earlier readiness cannot fund it                                                                                                                                                                     |

Read/registration/invalidation/preparation/publication share the caller's absolute
deadline, SQL statement/lock timeouts and bounded pool wait. Publication releases
registration before the Auth factory and releases Auth before its final native
transaction. Its complete price is the native portion above PLUS the actual Auth
factory below. The factory also repeats a full native registration (17 keys/9
client statements) before creating local work; thus publication without a native
page totals 61 native key visits/28 native client statements, plus 17 Auth key
visits/38 Auth client statements. If a native page is reached, add its original
engine/Kind fence bounds, that fence's receiving begin (5 Auth keys/18 client
statements plus native registration 17/9), and its terminal callback (3 Auth
keys/one body statement). Every invocation pays again. No cost from an identity
original or another child is reused. Physical installation/custody is unavailable and is never assigned
an assumed fixed foreign price. A future physical-owner binding must supply its
actual independently bounded implementation before activation is enabled.

### Auth obligation discovery

`createAuthBindings` directly composes `createAuthErasureObligationBindings(pool)`.
The dependency-free literal types live in
`packages/auth-contract/src/auth-erasure-obligations.ts`. This fixed Auth capability
accepts no actor, participant, HTTP proof or cleanup acknowledgement. The original
barrier/source readers and their proof phases retain their existing ABI and meaning.

The deferred native `access.erasure` producer captures the immutable route, account,
version and exact PostgreSQL T together with the native tombstone receipt's original
`minimum_authn_epoch`. Both commit atomically; later floors cannot replace that
captured floor. All producers, including older native lifecycle callers, pass the
same trigger. Each partition's native source owns a monotonic ordinal and retained
index. The existing `core.partition` writer lock orders admission, bootstrap and
cut capture; erasure does not take a global counter or mutex.

A replayable cut ID locates a native header. Pages visit partitions 0–4095 in order,
one per call, and retain each immutable high-water row at Source. Callers carry only
`{partition,afterOrdinal}`. Bootstrap drains at most 48 preinstallation roots per
call through the partial index of unindexed erasures, never living accounts. This
installation-only walk uses the erasure primary key; the delivered feed always
seeks its native ordinal. The retained native tombstone receipt supplies historical
floor evidence. Missing/ambiguous original receipts remain permanent pending
obligations, including their original tuple. Current floors and Auth `accepted_at`
are never substitutes. Initializing, empty and exhausted pages alone prove nothing.
No cut partition is sealed while a missing original floor remains.

Every request has an explicit absolute deadline, including connection queueing,
statement and lock waits. Pages contain at most 48 obligations, each at most 1 KiB,
and at most 64 KiB overall. Point reads recheck the exact root and terminal/fenced
account under current native ownership. Cut verification reads one retained
partition, rechecks source generation, owner, epoch, position and live head, and
reports current only after all 4096 partitions have native seals. Auth must retain
its own consumed cursors and verify every partition; no header is Source proof.
New committed erasures necessarily enter the same producer/feed before becoming
visible. A later head invalidates current verification without changing an old cut;
finite-only consumers reconcile a new cut to consume that tail. The additive live
handoff below retains the original cut while enrolling its native tail. Ordinary current
sign-in still checks Access's live account fence, including during restore admission cutover.

Source generation/ownership epoch and inventory/producer versions are independent
of account barrier versions. A missing, moved, fenced or changed-epoch source stays
pending; current native deletion still captures its original obligation under the
current home fence. Lineage recovery cannot relabel retained source rows or reset
completed roots. The port assumes the independently current Access source required by the
Auth custody contract. It does not certify recovery of an older Access database,
physical backup/restore lineage, external receiving closure, Auth native replay,
consent due evidence or final cleanup. Those authorities remain with their owners;
this native discovery feed cannot release an isolated restore by itself.

### Native Auth live obligation handoff

The additive `authErasureLiveReceiver` trusted composition option on `createAuthBindings`
mounts the closed `AuthErasureLivePorts` from
`packages/auth-contract/src/auth-erasure-live.ts`, implemented by
`createAuthErasureLiveBindings(pool, receiver)`. Composition supplies the actual restored
Auth generation, verified database identity, inventory entry/version and original cut ID.
The four receiver identifiers retain Auth inventory's nonempty string format (at most
1 KiB each); its inventory version is independent of the native feed version.
These immutable binding values are data, never a certificate of physical receiving or
restore admission. Existing callers and finite obligation ports keep their original meaning.

`armAuthErasureLivePartition` arms one already sealed original cut partition. It takes
exactly the native `core.partition` writer lock used by tombstone capture, checks the
original source generation/epoch/owner/position and persists the receiver, subscription
and enrollment before committing. The subscription records both the original cut high
water and the immutable arm high water. Obligations committed between those frontiers
are already in the permanent original ordinal feed; later obligations advance a durable
partition enrollment frontier through an `AFTER INSERT` trigger in the same transaction
as original native capture. There is no receiver fanout at append, account enumeration,
account cursor, global cut update or lock across partitions. Failed transactions roll
back the tombstone, original receipt, feed and enrollment together. Exact retries retain
the original subscription; changing any receiver binding for that cut refuses, including
when arming a different partition.

`readAuthErasureLivePage` begins at the original cut high water and seeks native ordinals
in that same feed. It returns at most 48 original tuples, each at most 1 KiB, and at most
64 KiB overall. `next` stays on the same partition even at `tail-end`; it is never an ACK,
consumption proof or instruction to discard tail. A pending original floor retains its
exact tuple and the continuation stops before the first pending item. Missing receiver
composition leaves all native obligations retained. There is no tail deletion operation.

`verifyAuthErasureLivePartition` rechecks the actual current native writer lineage,
retained original cut, exact receiver, immutable subscription and transactionally
maintained late enrollment. It can stay current as the native head advances because
that advancement is enrolled durably, rather than because a snapshot or current maximum
was observed. Verification and arm are per partition; other partitions can continue
while one source is unavailable. An epoch/owner change keeps the old provenance pending,
including when genuine native confirmations continue. Enrollment records that mismatch
without stopping ordinary native deletion; it cannot automatically repin or reset an old
lineage. A native lineage handoff remains the source owner's responsibility.

`test/access/auth-erasure-live.test.ts` covers cut/arm/append races, retry, page bounds,
continued tail after EOF, source lineage changes, partition independence, transaction
rollback and precise unknown-floor pending. The additional
`test/access/auth-erasure-live-binding.test.ts` covers conflicting cross-partition receiver
composition, atomic refusal, immutable composition capture and absence of an uncomposed
live capability. These ports supply Source enrollment only.
Auth owns its database, consumed checkpoints, maintenance and gate. External receiving,
backup/tail custody, replay/restore admission and final erasure ACK remain unproven by
this subscription and require their existing owning evidence.

## Delivered preference history coverage

`createPreferenceCommands.setPreferences` is the first converted command producer. Before reading or changing
preferences it calls `declareCommandHistory` with its native subject, separately from automatic identity evidence.
The real Access permission preparation projects its verified actor, principal, human actor and delegated assignment
into the current transaction. It never derives a human from an automated account's current operator. Reconstructed
Actors, request JSON and a previous retry's proof cannot supply custody identity. The ownership, scope, version and
conflict rules stay in the existing command and Access formula.

The default `shared_history` WorkModule consumes the tombstone through native effect admission. Its opaque random
job UUID, immutable barrier and cursors remain in PostgreSQL; it creates no generic DBOS erasure execution.
`history/work.ts` reexports this same module for compatibility. Each unit visits one physical partition, reads at
most eight account-prefix locator keys and invokes one physical minimizer. Unconverted artifacts record a technical
local gap while independent artifacts continue. Sealed empty prefixes have local `none` proof; previous applicable
artifacts retain local `erased` proof. Neither proves global absence. Consumer, work and committed Auth proof changes
redrive the affected pending job; changed registry generations redrive one job per unit.

`HistoryRegistry.registerOwner` binds versioned native readiness for each closed artifact type.
`registerCoverage` declares a producer family's conversion; it never certifies absence. No family currently declares
complete conversion. Preference and mechanical Library entry-retention purge receipts have no downstream response
consumer and both are registered for the existing receipt minimizer. The Library entry-purged event has no
projection subscriber; its exact effects dispositions are checked independently. Account-updated events await
Search's actual generation-specific consumer inventory. Other command owners must bind their actual consumer proof.

`stageHistoryWork` and `receiveHistoryWork` in `work/history-enqueue.ts` retain exact opaque request/digest and scope
custody at origin and destination. Destination guards, locators and SDK `enqueueInTransaction` use one client after
releasing the origin. `settleHistoryWork` is the owning native handoff port, not a workflow-status observation.
Retired markers prevent re-enqueue after SDK deletion. Historical executions without registered owner readiness or
complete pre-serialization scope/budget enforcement remain pending, including Library's retention root/segments and
existing generic effects. Scoped execution production and stale application writers still require owner conversion.

`history/receiving.ts` exports `readHistoryReceivingReceipt` / `verifyHistoryReceivingReceipt` and
`readHistoryOwnerCoverage` / `verifyHistoryOwnerCoverage` with opaque WeakMap process capabilities. Exact receiving
proofs bind the barrier, physical locator, full role union and current partition epoch; verification locks the proof
and source on the account-home final command. Source loss alone produces no proof. Outbox slots with effect consumers remain pending receiving-copy binding
even after business completion; generic DBOS inputs/results are not erased by completing an effect. Family coverage uses a separate durable selected-family aggregate, never local job completion or an ACK.
`HistoryRegistry.registerFamilySources(family, version, sources)` declares the complete current/former producer
catalogue (at most 100 entries). Each entry fixes an artifact type, native producer name and producer version.
The declaration and `registerCoverage` cannot enroll historical sources or certify an empty prefix.

The default module in `history/work.ts` preserves the existing local worker and adds native family progress.
It captures the finite configured local `core.partition` domain and its routing generation. Each operational segment
visits one native home and reads at most 100 **raw**, unfiltered locator keys. Empty prefixes require the same native
source enrollment as occupied ones. It checks every configured producer's immutable original erasure version/time,
source cut, definition digest and current home epoch; a missing former producer is an exact family-specific gap.
Selected copies require the existing actual receiving proof, physical minimization/retirement and full role union.
Known foreign producers do not block an independent selected family; unresolved provenance stays pending.
The bootstrap reads at most 100 existing native history jobs per unit, with insertion admission covering late jobs.
Cursors survive restarts. Request reads perform only bounded exact aggregate/root/version key reads.

`core.history_family_enrollment` is the remaining **producer-owner native input**, not a public assertion port.
For each family, account root, configured physical home and current/former producer, its owner must enroll:
`{family, account_route, account_id, partition_no, artifact_type, producer, producer_version,
definition_digest, barrier_version, barrier_at, partition_epoch, source_cut}`. `source_cut` is a least-required opaque
locator (1–256 bytes) for that owner's actual sealed historical source inventory. The owner must first capture all
original/receiving role associations, retained deidentified dispositions and late-writer/handoff intents under its
native fences. The receiving worker validates the root, sealed native prefix and source versions and consumes the
actual copy proofs; it never manufactures this owner enrollment from registry declarations, current rows or Source
terminal proof alone. Native enrollment does not replace the consumer's independent Source proof.

Semantic and Zones must supply their actual current/former source declarations and native enrollment from their
sealed Source inventory, including empty prefixes, before their family result can complete. Their modules currently
supply neither input. Other unconverted producer families retain their own registry/enrollment gaps. The local
aggregate cannot certify a foreign physical store or an unavailable cross-home writer fence: the owner must leave
its enrollment absent in that scope. This delivery does not claim those owner integrations or full native acceptance.

The opaque result binds the copied original root, selected family and durable proof identity. On the **same real
account-home final command**, verification locks the genuine current aggregate, source definition, original erasure,
account fence and native routing generation through commit. Native role/receiving/enrollment/physical-copy changes
invalidate the account fence; routing, epoch/restore, source definition and registry changes invalidate the domain.
A newly associated account invalidates the entire copied artifact's role union. Spread/cloned capabilities, wrong
roots/families/homes and changed versions refuse. Sealed native roles and minimized payloads remain irreversible.
No global, Search or Semantic final ACK is called or emitted by this path. Final shared-history ACK remains unavailable.

Cost: one physical home and at most 100 raw locator keys per operational segment, with at most 64 role keys per
selected artifact and a fixed producer catalogue bound of 100; native index seeks are `O(log R)`. No request performs
an all-home, account, role or body scan. Source and home coverage is finite operational work. Final reads lock only
exact root, definition, registry, domain, fence, home and aggregate keys. Original shared-history native correctness
and cost debt, including measured growth evidence and full native acceptance, remains deferred under minimal mode.

Access captures current/new/former direct native grant occurrences before destructive mutation, with original creator
and resource type retained separately. Initialization reads its committed-in-transaction rows after the sibling CTEs
to capture the actual first holder. The native Context delivery port described above enrolls creator and owner occurrences
through Semantic's actual Source sink; unavailable or unresolved occurrences remain `pending`. This is historical provenance, never current permission or certification of former-owner
absence. Existing historical rows have no backfill, and Access's own provenance retention/cleanup remains its
separate obligation.

Ordinary record purge imports Semantic's actual opaque `RecordPurgeAuthority` and its native read/lock ports,
independently of account erasure. `prepareRecordHistoryPurge` captures the exact immutable source bindings and a
fixed request deadline in a private process handle; `minimizeRecordHistoryPurge` rereads and locks the native
source through one physical effect and its local progress. Hold, restore, generation/version changes, original
committed deletion/expiry and current home epoch remain the source owner's authority. Source read failures
propagate; only actual source ineligibility returns null. The native issuer in this checkout exposes contribution
references; Context/Zone source authority remains the Semantic owner's dependency.

`history/record-resource-adapter.ts` accepts the agreed input union independently of authority:

```ts
type ResourceRecordPurgeReference =
  | Readonly<{ kind: 'context'; contextId: string; deletionGeneration: string }>
  | Readonly<{ kind: 'zone'; zoneId: string; deletionGeneration: string }>;
type NativeRecordPurgeReference = RecordPurgeReference | ResourceRecordPurgeReference;
```

It maps only the original contribution tuple, `{kind:'context',contextId}` or `{kind:'zone',zoneId}` to the
existing source key. The actual typed subject, Context or Zone ID determines the home via `routeOf`/`partitionOf`.
The compatible `core.record_history_purge` discriminator defaults existing rows to `contribution`; those rows keep
non-null subject/candidate/revision and optional document, with no resource ID. Context/Zone rows require a resource
ID and null subject/candidate/revision/document. The union CHECK rejects mixed or incomplete locators; operational
fields and the existing primary key are unchanged. Restart validates the stored key and home against that typed
reference before requesting authority. No source observation or stored locator authorizes a physical effect.

The required native extension belongs solely in `services/kernel/src/semantic/record-purge-authority.ts`:
`prepareRecordPurgeAuthority(deps: Readonly<{pool: Pool; clock?: () => Date}>, ref: NativeRecordPurgeReference,
context: Readonly<{deadline: number}>): Promise<RecordPurgeAuthority | null>`, together with
`RecordPurgeSource.reference: NativeRecordPurgeReference`. Its existing `readRecordPurgeAuthoritySource` and
`lockRecordPurgeAuthoritySource` must retain the SAME opaque authority, native lifecycle/version/generation,
original committed deletion, expiry, hold/restore locks and current home epoch checks for each variant.
`prepareNativeRecordPurgeAuthority` delegates contribution, Context and Zone references to the delivered
Semantic issuer through its exact `NativeRecordPurgeReference` union. History has no resource authority shim;
native lifecycle ineligibility remains the issuer's decision.

Original source writers enroll with the exact export
`declareCommandRecordSources(tx: CommandTransaction, sources: readonly RecordHistorySourceReference[]): void`
from `history/record-source.ts`, before history serialization. The closed reference is
`{kind:'contribution',subjectId,candidateId,revision,documentId}`,
`{kind:'context',contextId}` or `{kind:'zone',zoneId}`. A command declares at most sixteen distinct immutable
references, including old/new/current versions when each is copied. There is no deletion generation at original
copy creation. This port associates ownership only; it confers no permission, validates no native source and
asserts no completeness. Source owners retain native writer/lifecycle locking and source eligibility. Semantic
owns adoption in its actual writers. No original command is inferred from a body, account role or guessed UUID.

Receipt/outbox codec hooks and scoped durable staging record the actual generated locator with its original
transaction, fence position and producer version before commit, preserving existing account associations.
Durable receiving copies exact original associations after releasing the source checkout. Converted associations
have explicit partial coverage. An empty page or one converted command cannot certify historical absence, a
sealed original inventory or a finite source cut; unconverted older producers remain pending. The current
implementation does not seal enrollment or claim late-copy exclusion: later real enrolled copies remain visible
through the pending index rather than disappearing behind a completed cursor.

Commands with a genuine complete compact native set use the mutually exclusive alternative
`declareCommandRecordSourceSet(tx: CommandTransaction, sourceSet: SemanticRecordSourceSet): void`, also
from `history/record-source.ts`, once before serialization. The sixteen-reference port keeps its original bound.
The native set has at most the original command limit of 512 exact members, including old/current revisions
actually copied and native terms without candidate IDs. No array, truncation, repeated declaration, fabricated
candidate or per-fact callback supplies this set. The set is an ownership locator, never purge authority or a
claim about older writers.

History aliases the original opaque `SemanticRecordSourceSet` from `semantic/record-source-set.ts`.
Its source-owned `semanticRecordSourceSetLocator(tx,set)` validates the same command synchronously at declaration,
before nested serialization. The actual locator is `{partition,transactionId,revision:number}`. History stores
that identity and each actual codec/SDK-generated artifact in the same command transaction. The existing byte
copy keys encode the transaction UUID and decimal revision for History indexing only; they are not Source APIs.
The original transaction, fence position, copy keys and native serialization ordering remain intact.

A declared set may still be building. History persists `metadata_state='building'` with null member count and
digest, then finalizes the generated command position before COMMIT in the existing order. This is unresolved
technical metadata, never immutable membership or completeness. Semantic's native seal-before-COMMIT guard must
seal the source set or roll back the entire transaction, including generated artifacts and History associations.
History neither seals Source nor registers a substitute guard. Source owns begin/append/seal and actual
old/current/contribution/document/native-term membership with the unchanged 512 cap.

After commit, the real `readSemanticRecordSourceSet` resolves `{locator,digest,members}`. Native reverse lookup
uses `pageSemanticRecordSourceSets` with the actual narrowed original reference (including document/revision),
a string frontier and `progress|complete`. All producer pool reads finish before History opens the live native
source transaction for exact `verifySemanticRecordSourceSet(tx,locator,digest)` and enrollment. Only verified
native snapshots enrich building metadata. Immutable digest and count then stay fixed; no member vector enters
receipt, outbox or DBOS bytes. Reverse-index EOF does not certify older writers, a Source cut, receiving-copy
closure or term purge authority.

The native Source-set implementation is absent in this base. The exact agreed owner declaration lives in
`semantic/record-source-set.d.ts`; it supplies typing only. The History adapter imports the real original module
when available and otherwise throws `record_history_native_source_set_unavailable` at declaration. It defines
no independent brand, provisional producer methods, Source SQL or issuer. Actual compact512/term writer binding
and native whole retention/copy closure remain integration debt. The legacy metadata validator remains solely
for compatibility with the unchanged existing tests and persisted provisional format, never native evidence.

Each segment reads at most eight exact locator keys and applies one physical minimizer. Known co-located receipt
responses with native no-consumer dispositions, the closed Library entry-purged outbox event after actual effect
consumer closure, and native work already retired with verified SDK absence can make local progress. Other
consumer families remain pending until their actual owner supplies record-compatible closure. Receipt identity,
request digest and the existing minimized-result 410/no-reexecution behavior survive. Existing irreversible
payload/retirement seals still apply, and living accounts acquire no fabricated erasure barrier or receipt proof.
Active work requires source-bound native retirement before SDK payload changes; this port does not treat a DBOS
status as authority. Foreign copies consume the unchanged Source-owned prepare/read/lock/completion/release
receiving-hold exports and original opaque types from the delivered `semantic/record-purge-custody.ts`.
`history/record-native-custody.ts` imports that native module directly, without a structural cast or issuer.
The deterministic receiving identity uses its native UUID target codec.
Source preparation/read ends before receiving checkout; native receiving lock, physical minimization, copy progress
and native completion commit together. The existing empty `history.minimized` event gives completion callbacks a
real command position. Restart rereads the native hold at the deterministic receiving locator. A minimized copy
with `record-source-native-release-pending` remains discoverable until Source verifies actual native completion
and releases its hold; no returned flag, lease or timeout releases it. Hold/current generation/home/version and
restore exclusion remain the Source module's responsibility under that same native lock.

Source inventory sealing and verification consume the same native custody module. A valid Source cut, native
member-to-set inventory, History original/receiving copy closure and actual consumer closure are separate
requirements. No Source cut or known EOF seals History's historical copy inventory. Older unsupported writers
and genuine term purge authority remain explicit pending scopes.

The existing default history worker redrives one outstanding native record job per unit from its durable source
locator and reissues Semantic authority after restart. It adds no DBOS purge queue, account/global/participant ACK,
aggregate coverage certificate or second cleanup algorithm. No record completion is issued while original/receiving
inventory, source cut, late-copy exclusion or native consumer closure remains unsealed. These delivered local
capabilities retain all preference-history and Cost qualifications above; full native acceptance remains required.

## Original Agent identity serialization associations

`history/agent-identity-source.ts` publishes the data-only declaration
`declareAgentIdentitySource(tx, key: AgentIdentitySourceKey, digest: string): Promise<void>` and
`readAgentIdentityCopies(pool, keys, context, after?)` / `readAgentIdentityCopyReceiving(deps, barrier, keys, context, after?)`.
The exact key is `{route, accountId, direction, receiptId}`; direction retains the original
`account-agent.verify` or `account-agent.unverify` value. It is separate from ordinary record purge references,
SourceSet membership, deletion authority and Semantic consumer discharge.

The original Accounts source writer issues a private transaction-bound declaration only after its native insert.
History rejects foreign keys, changed digests, a historical read, a different current command, repeated declarations
and declarations after the first nested history serialization. The original immutable component comes from the
insert's returned partition, epoch, position and transaction; its digest is the source's canonical intent digest.
The writer consumes `currentCommandReceipt(tx)`, which reuses the executor's already generated current-key token
from its replay candidates. Source and receipt serialization do not derive another HMAC.

At the existing receipt/outbox serializer, permanent command kind IDs 3–6 cover pending, released, revoked and
deleted verification. The actual receipt codec and final persisted fence position/event sequence create the
locators. The serializer writes `core.agent_identity_history_copy` in the SAME native transaction, checking each
physical receipt/outbox slot. Rollback removes the copy and association together. These hooks preserve native
Source callbacks, SourceSet finalization, authorization, deadlines and the existing connection lifetime.

The full native role union includes the subject, original requester as actor/principal, original decider as reviewer,
any original acting human, the genuine prior undo source roles and all already verified command evidence. Each copy enrolls every role in
`core.history_locator`; technical source-to-copy rows reference that inventory and hold the same open seals and
native routing/restore generation. Exact source-leading and artifact-leading indexes bound both directions.
The existing physical minimizers and receiving API report `agent-identity-source-retention-custody-pending` for
unconverted original sources. Converted sources use the native inventory cut described below. Technical linkage receives no metadata exemption or
ordinary-record purge permission. This declaration does not introduce a second identity minimizer or erasure engine.

Lookup accepts at most eight exact source keys in one home, examines one indexed candidate per key and returns at
most one actual `HistoryArtifact` with the complete native role union. It releases the lookup home before using
`readHistoryReceivingReceipt`. Unknown historical or unconverted sources remain
`agent-identity-original-inventory-unsealed`, including on empty pages. A newly converted original source can return
a sealed native cut independently of page EOF, as described below. This does not discharge receiving or Source
consumer custody; old unassociated copies remain pending.

The actual SDK enqueue and step boundaries use the two-stage custody protocol described above. The four-field
`agentIdentitySourceKey` remains the original receipt/outbox lookup identity; `agentIdentityWorkSourceKey` encodes the
closed native receipt tuple for the separate SDK association. Neither changes an existing Source key or workflow ID.
`history/durable.ts` retains `AGENT_IDENTITY_DURABLE_ASSOCIATION` for historical executions without a captured native
SDK recording seam. Their returned handles, deterministic names and workflow status do not establish receiving
custody. These uncovered copies remain pending. The original DBOS steps and default WorkClient lifetime remain
intact. Neither native association conversion nor new SDK custody claims family or original inventory closure.

### Original identity native inventory

`history/agent-identity-inventory.ts` owns the first finite native inventory declaration. Its key is the original
`AgentIdentitySourceKey` `{route, accountId, direction, receiptId}`. `AgentIdentityOriginal` adds the original
`partition`, `epoch`, `position`, `transactionId` and canonical `digest`. No erasure generation or account time is
substituted for that tuple. `AGENT_IDENTITY_INVENTORY` declares producer version 1, native receipt/outbox conversion,
a maximum of three native copies and closed native future writers. Unknown historical or recovered sources have
no such declaration and keep `agent-identity-original-inventory-unsealed`; there is no backfill or empty seal.

The original native insert issues its transaction-bound declaration. The executor's actual receipt codec is reused,
and all subject, requester/principal, reviewer, acting-human, released undo and authorization evidence roles are
retained. Before nested event/response serialization, `captureAgentIdentityInventory` snapshots the exact native
serializer obligations. The closed producer vocabulary requires one receipt and one pending event or two reversal
events. The receipt/outbox hooks persist their actual associations after the physical fence. Only after every hook
returns does finalization seal the inventory in that SAME original transaction. A deferred SQL validator compares
each expected codec locator, original tuple, exact physical receipt/event slot and original transaction with its
produced association. Incomplete hooks roll back the source and all copies together. Native admission rejects later
copy writers instead of treating producer discovery as evidence about future SDK writers.

`readAgentIdentityNativeInventory(pool, key, context)` returns an opaque `AgentIdentityInventoryProof` only for a
current sealed native cut. `readAgentIdentityCopies` still pages one artifact across at most eight same-home keys;
its native sealed state is independently checked in the same snapshot, including on empty pages. Enumeration and
EOF never mint custody. `readAgentIdentityInventory(deps, barrier, key, context)` releases the native home before
each existing receiving probe, carrying the entire retained role union under the real `HistoryBarrier`.
`verifyAgentIdentityInventory(tx, barrier, key, proof)` must run in the SAME source home. It locks and rechecks the
durable generation, restore domain, partition epoch, native writer seal, exact membership, full roles, every durable
receiving receipt and every physical minimized payload. It uses only local core rows while held; a copied proof or
caller assertion cannot bypass those checks. Its locks exclude enrollment and restore through command commit.

A separate durable SDK obligation is created with each original source, bound to its receipt, generation, original
workflow/delivery key and known approval/reversal enqueue handoff tuple. It contains no invented SDK work ID or
opaque receiver coordinates. `agent_identity_sdk_obligation` retains `pending-recording-port`; absence of a future
SDK mapping cannot certify absence of a copy. Later enrollment must advance that obligation's generation; its
native trigger takes the inventory lock and advances the cut generation, invalidating old proofs. The genuine
original command's SDK source-intent recording advances this obligation through that same trigger, matching its
exact original workflow and delivery key. The later receiver handoff resolves the already-recorded intent and keeps
the SDK creation transaction unchanged; it does not seal future SDK writers. Artifact-leading
role and event-consumer enrollment hooks take that same lock and advance the generation before admission returns. The actual SDK
recording/mapping owner supplies the separate future-writer closure. Until then verification may return
`native: 'verified'` but remains pending. Missing old receiving creation still reports
`agent-identity-sdk-recording-port-unavailable`; released inventory reads distinguish mapped native binding/restore/
creation gaps and the still-missing durable source terminal transfer. The optional retirement stage passed to
`verifyAgentIdentityInventory` is checked only after every original native receiving and physical proof, in the SAME
source transaction; it cannot substitute for any copy or upgrade retained consumer evidence to a CLOSED inventory.
Native physical minimizers may act on a sealed native association subject to their independent owner readiness;
source, technical linkage, SDK obligation, Account-root and Semantic consumer custody remain mandatory. This module
does not minimize original source rows, issue an account erasure ACK or claim full native acceptance.

The optional real `client` on `readAgentIdentityInventory` enables an independent SDK receiving observation.
`readAgentIdentitySDKRetirement(pool, client, original, barrier, context)` releases its receiver snapshot before
calling the original SDK wrapper. It checks the complete original key/partition/epoch/position/transaction/digest,
immutable native mapping, request digest, full retained roles and exact barrier. A stored retirement receipt alone
does not suffice: native SDK fence reads bracket the ordinary durable receiving proof, whose physical work must
already be retired with verified absence and cleared request/scope. A successful observation has state `received`;
the corresponding optional receiving input to `readAgentIdentitySDKRetirementGap` can return `null`. Neither result
is a current source-home cleanup certificate. The pool-only diagnostic overload retains the legacy/mapping gap.

The installed Work producer now supplies `readSdkWorkflowWriterState` and
`lockSdkWorkflowWriterState(tx, expected, sdk)`. History consumes these in
`readAgentIdentitySDKWriterState` and `lockAgentIdentitySDKWriterState`. The latter derives its pool from the actual
live command and leaves the SDK domain and exact workflow locks held through that command's commit. Generation 1
can serialize a pre-retirement readiness candidate; it does not close writers. The separate closure phase requires
generation 2 and the exact closure UUID, timestamp and SDK restore generation. A wrong pool stays
`identity-sdk-source-pool-mismatch`; matching URLs never establish physical placement. A moved cross-database Source
has no supported native bridge. These technical checks establish neither legal readiness nor History copy closure.

The selected identity durable unit enters `withAgentIdentityHistoryUnit` only after the original bounded
job/locator selection has committed and released its checkout. This wraps the actual
`shared-history -> minimizeHistoryWork -> advanceAgentIdentityConsumerMaintenance` chain and the final receiving
transaction in ONE original Source callback and deadline. Its async context carries scheduling information,
never Source authority, a new allowance or a portable certificate. All native commands make one attempt; automatic
command retries are surrendered for this callback. Errors roll back and ordinary later scheduling starts another
admitted unit, re-observing exact durable state rather than repeating an ambiguous SDK retirement in this frame.

The default body stages the native receiving mapping, source tuple, accepted original job and actual Source
consumer. `lockIdentitySourceHistoryHandoff` is the agreed original Semantic port. It must revalidate the current
custody, Account settlement/technical receiver and Library current seal and lock the original Source expected
address plus the actual SDK generation-1/domain on this SAME command. Only its returned address is persisted as
`agent_identity_work.history_authority`; `sdk_readiness` records the exact original binding and writer.
The original History work transitions separately to `owner_ready/state=ready`. Native ALWAYS guards re-resolve
`semantic.lock_identity_source_history_handoff(reference,expected)` and `dbos.check_workflow_writer_state` on the
original association, all roles, barrier, source/receiver/domain and writer generations through COMMIT. A released
boolean, supplied workflow ID, copied terminal or technical SDK receipt cannot enable readiness.

After reading the actual committed readiness, the bounded original SDK owner makes at most ONE retirement attempt.
It revokes the original owner token and retains permanent fences. A fresh Source command obtains current Source
and exact SDK generation-2/domain authority before recording `sdk_closure` and the technical receipt. Technical
receipt metadata remains compatible with old callers, immutable and insufficient for any History transition;
legacy generation-2 rows without genuine recorded generation-1 readiness stay pending. The original readiness
SDK restore UUID must also survive retirement and closure; rotating the domain cannot make an old association eligible.

Later commands independently obtain current Source and SDK closure before sealing and retiring History work,
clearing request/scope, verifying absence and minimizing the locator. A real SDK fence observation precedes the
first physical inspection; every one of the eight actual SDK tables keeps its original LIMIT+1 and storage limits.
Supported SDK deletion is exact, children=false, with no internal retry. Another independent fence observation and
all eight physical absence probes follow it. The absence/locator transaction re-resolves current authority, and
native guards inspect physical absence while permanent SDK non-revival remains in force.

The actual final receiving/progress transaction checks the original selected job, cursor and barrier, freshly
re-enters the Source/SDK owner, and independently re-enters it again for the receiving proof. Its native proof
trigger checks the immutable association, current Source and SDK, physical absence, retired work, exact role hash,
receiver epoch and minimized locator. These locks survive the actual receiving proof and cursor COMMIT within the
same original callback. Stale selections never advance a cursor. Refusals preserve work and cursor and use the
ordinary delayed scheduling path when its own reservation can be admitted.

The supported positive body is the fresh preserved source0/barrier0/receiver0 path on the actual SAME configured
SDK Pool. Matching URLs do not prove pool identity. Missing/moved physical homes, missing original association,
unsupported restore, lost permanent fences, changed receiving custody and absent real Source handoff remain precise
pending branches. The current snapshot lacks the agreed Source handoff export; it refuses
`identity-source-history-owner-not-installed` before attempting that dispatch. Library's exhaustive page/current
seal and Semantic's matching Source SQL footprint and adopted aggregate must land with their owners. Unknown SQL
and exhausted reservations continue to refuse. This consumer does not install foreign bodies or raise budgets.
Account-root, all roles/copies, Source discharge, public/routing exceptions and later source minimization remain
independent. No native or whole-Goal success follows from this source implementation or typing.

#### Cost: complete selected identity unit

Axes below are **rows / points / statements / returned content bytes / engine requests**, with engine=0 throughout.
These are closed pre-reserved dispatch bounds, including refusal, rather than observed successful row counts.
Payload stored bytes are checked inside PostgreSQL and never charged as returned payload/protocol bytes. Limits
apply to visible keys and nested native work, not MVCC engine visibility. The exact literal SQL is in the named
callable and the one forward History migration; Source and SDK function bodies remain with their original owners.

| Symbol / actual dispatch                           | Bound                           | Native home and lock lifetime                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C: `identityHistoryCommand` controls               | 3/1/8/256/0                     | BEGIN, two SET LOCAL, time, final SET, original no-effect partition fence, COMMIT and prepaid failure ROLLBACK; one attempt                                                                        |
| Initial mapping: `resolveAgentIdentitySDKWork`     | 4/4/3/16384/0                   | Original m/work, receiver partition, History domain; released before staging                                                                                                                       |
| Initial `readAgentIdentitySDKReceivingBinding`     | 72/72/6/32768/0 + C             | Mapping, m/work, roles LIMIT65, barrier; released                                                                                                                                                  |
| Initial `readAccountIdentitySource`                | 70/68/25/73984/0                | Includes C and original normal plus bounded technical fallback; released                                                                                                                           |
| `readOriginalAccountAgentIdentity`                 | 86/80/59/205920/0               | Three independently released one-attempt commands and six RR snapshots at most for unmerge, including controls and failure slots                                                                   |
| Local `readAgentIdentityRetirementStage`           | 73/71/26/82176/0                | Includes C, current Account source/technical fallback and source-association/partition/domain statement; released                                                                                  |
| Initial `verifyAgentIdentityRetirementStage`       | 71/71/19/82048/0 + C            | Local source/barrier; Source's own current verification reserves its nested allowance independently                                                                                                |
| R: later receiving binding                         | 160/80/6/131072/0 + C           | Before retirement and each side of each independent SDK fence observation                                                                                                                          |
| H: genuine Source composed handoff                 | 377/293/57/507904/0             | Existing producer-owned composed subject handoff; includes its Account/current custody, Library seal, Source expected address and SDK lock; this consumer never charges its children a second time |
| G: `core.check_agent_identity_history` nested body | 92/87/11/40960/0                | Association1, receiver/domain2, original work1, role LIMIT65+aggregate1, barrier1, standalone Source function17/15/2/32768, SDK4/2/4/8192; same tx through commit                                  |
| L: `lockRecordedAgentIdentityHistory`              | H + G + 2/1/2/123136/0          | Original four capped JSON fields (122880) and outer native guard SELECT (256); same tx                                                                                                             |
| Readiness read / committed reread                  | 1/1/1/106496/0; 1/1/1/65536/0   | Original association only, in separate commands                                                                                                                                                    |
| Readiness association UPDATE                       | G + 1/1/1/0/0                   | Immutable native readiness guard                                                                                                                                                                   |
| Ready work UPDATE                                  | G + W + K + 2/2/2/0/0           | Work guard's association read plus outer UPDATE                                                                                                                                                    |
| Closure association UPDATE                         | G + 3/3/2/0/0                   | Includes compatible receipt metadata's current partition/domain check                                                                                                                              |
| `sealHistoryAccount`                               | 16/16/7/64/0                    | Erasure selection, upsert, two FK checks and one F; unchanged seal may do less                                                                                                                     |
| Prepared work / roles reads                        | 1/1/1/64/0; 65/65/1/8192/0      | Same retirement command                                                                                                                                                                            |
| Actual owner readiness                             | 74/74/7/49152/0 + L             | Independent receiving binding and technical receipt comparison before L                                                                                                                            |
| Work retirement UPDATE                             | G + W + 2/2/2/0/0               | Current native guard through request/scope clearing and COMMIT                                                                                                                                     |
| A: `core.check_agent_identity_history_absence`     | 9/9/9/0/0                       | Mapping workflow point plus eight actual SDK existence probes, early refusal spends full reservation                                                                                               |
| Absence UPDATE                                     | G + A + W + K + 2/2/2/0/0       | Current guard and physical absence through COMMIT                                                                                                                                                  |
| Locator UPDATE                                     | G + A + T + 4/4/4/0/0           | Outer write, native m/work checks and erasure FK                                                                                                                                                   |
| Final selected job, barrier and cursor             | 3/3/3/4224/0                    | Actual selected cursor/identity compare, current barrier, cursor write; same receiving tx                                                                                                          |
| Final proof: separate absence / roles              | A + 1/0/1/256/0; 65/65/1/8192/0 | Independently observed in real receiving transaction                                                                                                                                               |
| Final receiving INSERT                             | G + A + P + 72/71/7/0/0         | Outer insert, m/work, role hash LIMIT65+aggregate, minimized locator, two FK checks; existing immutable proof may cause ON CONFLICT to do less                                                     |
| O: released SDK current observation                | 3/2/1/8192/0                    | Independent SDK owner checkout, no held Source checkout                                                                                                                                            |
| Released SDK retirement receipt read               | 1/1/1/8192/0                    | Existing owner keyed SELECT, independently bracketed by two R calls                                                                                                                                |
| One eight-table physical inspection                | 148/8/12/11888/0                | Per-table LIMIT+1 maxima 2,2,2,65,9,65,1,1; only scalar size/validity results leave PG. Includes BEGIN, settings, COMMIT and the failure ROLLBACK slot                                             |

Nested original trigger bounds, each charged before its triggering dispatch:

| Symbol                               | Exact closed formula and bound                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| F: `history_family_touch`            | erasure1 + fence upsert1 + FK1 + nine coverage rows = 12/12/4/0/0                           |
| W: `history_family_physical_changed` | watch1 + role LIMIT65 + 65 F = 846/846/261/0/0                                              |
| K: `history_work_changed`            | role LIMIT64 + at most one original pending job per role = 128/65/65/0/0                    |
| T: locator invalidation              | one F + two (LIMIT65 role union + at most64 F before its limit refusal) = 1678/1678/518/0/0 |
| P: receiving invalidation            | one F + LIMIT65 role union + at most64 F = 845/845/261/0/0                                  |

The fresh success sequence has eight H invocations (readiness, closure, two preparation checks, bound physical
selection, absence, two receiving checks), six L invocations, thirteen G invocations including native write guards,
three O observations and two independently bracketed SDK receipt reads (four R commands). It also has two eight-table
physical inspections, three W, two K, one T, one P and two seals. There are nineteen History/Account commands including
the three commands inside the accepted-original lookup; the latter's controls are included in its bound. Source
staging and its Library/current checks retain the producer's own separate reservations. Account settlement read
64/64/20/65536 and EACH current verify64/64/15/65536 remain in that owner composition; they are never replaced by a
fixed assumption of two checks. Each additional invocation of a receiving read or verification reserves again.
The released `readHistoryReceivingReceipt` reserves 76/75/17/132000 + G + A; its same-command verifier reserves
76/75/13/131872 + G + A, excluding its caller's already funded controls. The released receiving byte bound
is the sum of M16384, authority/readiness/closure106496, roles8192, barrier128, partition64, digest32, physical64,
two outer native void results512 and settings128 = 132000; the same-command verifier excludes settings128.
Inventory's released mapping-only snapshot reserves 6/5/8/16640, and its complete saved SDK receipt/work/mapping
snapshot reserves 7/6/8/33024 whenever either enters this existing frame; subsequent fence and receiving calls
reserve separately as above. Outside a Source callback their independent inventory admission remains unchanged.

For the fresh subject path, the fixed consumer dispatch envelope is **11588/9856/2731/6843136/0**. Its expansion
is fourteen C, the initial mapping/receiving/source/accepted-original/local-stage/verify rows, five R, eight H,
thirteen G, six L outer portions (2/1/2/123136 each), both readiness reads, readiness/ready/closure outer writes,
two seals, prepared work/roles, actual owner readiness's local portion, retirement/absence/locator outer writes,
final job/barrier/cursor, separate final absence/roles, final receiving outer write, four A, three W, two K,
one T, one P, three O, two SDK receipt reads, two physical inspections, and the single SDK retirement/deletion
envelopes 13/7/17/41088/0 and 144/10/16/8320/0. H and G children are counted once in this expansion, rather
than adding L again. This excludes the separately reserved initial Source staging/current verification and
any additional independent receiving/inventory invocation described above. It is a handoff of the actual
consumer body, not an adopted whole-frame budget. Semantic must reconcile those producer dispatches and exact
SQL identities before adopting the final aggregate. A refusal spends its already reserved prefix; a delayed
reschedule, when admitted, additionally spends C + 1/1/1/0/0. A later scheduling admission starts afresh.

The SDK single-attempt dispatch table is in [Work's owner contract](../work/README.md#bounded-selected-identity-maintenance).
It funds every nested lock/retirement/deletion dispatch, including failed attempts and a rollback slot before BEGIN.
A new invocation never refunds prior work. No success retry occurs in this frame; exact prior committed readiness
plus genuine current generation2 is the only ambiguous-retirement recovery path at later scheduling admission.
The old 577/577/173/630784/0 aggregate, two-lock subtotal and earlier conditional subtotal do not fund this body.
Semantic owns final matching SQL footprint and aggregate adoption. Directory parent100/200/36/229376 and effective
children50/100/18/114688, configured remainders, Library caps and the native100-row page ceiling remain unchanged.
Native/growth, acceptance, browser and whole-Goal proof remain deferred.

## Selected automated creation operator

`automated-operator-source.ts` declares
`readAutomatedCreationOperator({ pool, access, clock? }, actor, { operatorAccountId }, { deadline })`.
It returns exactly `{ id, kind: 'actor' | 'organization', handle, displayName }` or
null for a missing/inactive/unsupported native operator. It reads only the selected
command label and native eligibility anchors, under current `account:manage` on
that exact account. Two live native-time passes retain the same genuine actor,
client, principal, assignment, scopes, floors and denials formula. Human floor and
source/partition changes are rechecked; unavailable sources, moves and deadlines
are typed unavailable rather than missing or managed.

Native responsibility eligibility requires an active unfenced account with no
operator. A label, kind, equality or role is no grant. There is no private profile,
holder enumeration, public fallback or `account:read` scope. The local
`createAutomatedOperatorAccess` adapter binds Auth's live proof through its actual
`accessTokenForProof` and native authentication; default account bindings expose
it on `trustedAccess`. This read neither approves nor creates an account: the
existing approval, workflow and native responsibility commands retain all checks.

## Original committed lifecycle results

`native-lifecycle-results.ts` exports `readOriginalLifecycleResult`; native account
bindings expose it on the private `trustedAccess` and native `workflowPorts`. Its closed Auth contract accepts an
activation account/reservation/key and exact provisioning stage/receipt, or a
recovery account/key and exact establishment reference. These are lookup hints.
Auth's host supplies `nativeLifecycleResults.readRegistrationResult(stageId)` and
`readRecoveryResult(reference)` for mechanical consumers, deriving those hints
from the original native source. Missing original-source capabilities stay pending.

The reader checks out Access, releases it, calls the actual Auth owner point
reader, then independently checks out Access again. Both native snapshots must
agree on the exact original command receipt, full payload, transaction, epoch,
position and internal-service write basis on an active source home. Activation
also verifies the original sealed pending command receipt and immutable reservation,
expiry and initial floor. Recovery verifies its original floor command receipt
and fence row against the Auth establishment. Every read is a fixed number of
unique-key seeks; receipt key versions are bounded by the existing native ABI.

Expiry alone does not invalidate an already committed result. Missing, imported,
retired, minimized or mismatched source evidence returns null. Current account
state cannot reconstruct a result. The output contains only the original native
outcome and minimal technical provenance, never a handle, credential, private
descriptor, pending reference or payload digest. This port executes no command,
extends no lifetime and supplies no current user disclosure, approval or session
authority. Existing activation, recovery, public replay and security checks keep
their current semantics. Consumer/minimizer integration remains with its owner;
this source port does not settle unknown consumers or authorize witness deletion.

## Native erasure groups

The default `account_erasure` module also registers `account_erasure_native` for the committed tombstone event.
It opens an opaque `erasure_native_progress` identity before enqueueing. Native workflow inputs contain only that
identity; step results are fixed codes. Discovery uses `discoverErasurePage` and its adopted role manifest. The
native destructive checkpoint is separate from discovery: selected-key mutation, exact absence proofs and the
checkpoint commit together. A crash between discovery and purge replays the same discovered page. Consumed page
results are cleared in the purge transaction. Deleting DBOS history does not reset native progress.

Implemented native phases cover preferences; grants, role grants and denials in subject and account-resource
roles; standing parent installations; present/former handle claims; handle effects/operations; principal assignments
in principal, creator and assigned-actor roles; governance reach in resource and actor roles; initialization creator
attribution; bootstrap attribution; terminal organization membership history and organization-close work; terminal
verification requests in subject, requester and reviewer roles; account-agent pages after real reversal; and
account-bound rate counters/chunks. Permission
provenance remains with shared history, preserving grants between surviving subjects and resources.

Initialization markers retain only route, resource id and resource type, with creator and initialization time null.
Bootstrap markers retain route/resource id with account and transaction null. A minimized bootstrap still refuses a
second bootstrap. These markers carry no replacement account owner.

Each page contains at most 100 raw keys in one physical partition, at most 64 KiB returned and 1 KiB per locator.
Durable replays are checked against those bounds before readiness probes or consumer calls. Mutation and absence
proofs use full native keys. The organization history phases require the installed random-row-key cursor migration
`20261029041713`; they never reset a surviving close cursor. Current/future membership, nonterminal membership
slots, incomplete organization closes and unfinished verification decisions retain the whole discovered page.

A retired handle retains only route, normalized handle and `retired` state. Owner, transaction, reservation, hold,
forwarding and operation fields are null. Its enabled trigger validates the permanent obligation and finished
handle operations in the erasure transaction, then prevents updates/deletion/reallocation permanently. A
pending/active claim, outstanding hold or published operation retains its page as `handle-consumer`; expiry never
proves consumption.

Discovery invalidation follows the native producer path before its source intent is removed. Cleanup delivers an
exact account or claim intent through the existing atomic outbox command, consuming foreign claims at the account
anchor first. It also removes deleted-account claim cursors. Ownerless retired claims still advance partition
revision without creating a null-owner intent. Final account minimization advances revision without recreating a
previously delivered tombstone intent. These changes preserve source notification, not Search completion proof.

`erasure_native_blocked` retains each blocked phase's page and exact fixed reason while independent later phases
continue. Advancing the scheduling phase does not certify destructive completion. The unpurged discovery result
remains durable; retries rotate through blocked phases with an indexed prefix seek. Local committed deletion
commands use the original continuation keys, validated against the permanent obligation and exact current deletion
fence instead of an expired caller approval. One invocation attempts one root's bounded local steps. Authorization
records are not treated as Auth consumption witnesses, and continuation evidence is retained.
An exact key already purged through another role clears only that stale locator; it does not discharge any other
consumer's evidence dependency.

Verified rate charges store their account association in the counter/chunk transaction. The transaction locks the
account against deletion and checks the permanent obligation, preventing a pre-deletion authenticated context from
recreating erased rate rows. Anonymous identities remain unbound. The migration records whether old HMAC-only
stores were empty; legacy rows leave `rate-binding-deployment-coverage` pending rather than pretending they can be
reverse-attributed. Mixed-version writer shutdown remains a deployment requirement.

The account-agent page phase starts the real receipt-bound deletion reversal. Its existing registered workflow
performs Semantic unmerge, page removal and final account-witness clearing. A pending/verified account retains
`verification-reversal-consumer`; native erasure does not clear those pointers itself or assume that an enqueue
finished the reversal.

Rating controller history remains specifically pending as `controller-transition-consumer` for a surviving current
controller, or `rating-controller-projection-custody` otherwise. Delayed vote events and recounts read the controller
at event T; a current operator change or eligibility handoff alone does not establish projection consumption.

Terminal phases also discover registration expiry; membership inverses and terminal proofs in member and group
roles; organization membership slots; operator slots in subject and operator roles; coordination in owner and related
roles; approvals in actor, typed operation subject/operator/member/previous relationship and delegated-principal
roles; openings in operator, subject, acting-human and delegated-principal roles; credential floors; continuation
children and their typed allowlist targets; fence receipts in subject and old/current operator roles; foreign
operator/controller links; and the account skeleton last. Typed continuation roles point to independent random
native row ids, not copied allowlists, targets or cursors. The native producer records those roles in the source
transaction. This is native attribution, not a shared-copy recorder or custody acknowledgement.

The immutable Auth `native-consumed` proof is now read through its actual fixed reader with the original account,
barrier version/T, continuation and receipt. Local continuation authorization is still not consumption. Actual
kernel business-command receipts, under their original native keys, prove local retirement/release/handle effects;
children drain before roots. Child purge records only opaque original command identities as permanent replay
refusal, so a restarted consumer cannot recreate a previously purged child under a fresh random row id.

Terminal membership proofs require the exact inverse and hold to be gone. Organization slots additionally require
the copied terminal proof created by the real member release, with the exact source transaction; the source proof
stays until its slot is consumed. Operator slots require the original native release command receipt. Existing
immutable triggers stay enabled. Their narrow DELETE exception checks the permanent obligation, selected native
row and terminal source in the same purge transaction. No live membership is treated as terminal by inverse
existence, TTL or a caller-side leave.

A surviving verification applicant keeps its decision and application when only its requester or reviewer is
erased: cleanup removes that attribution, and reviewer reason/problem fields, instead of deleting the survivor's
request. An approved decision must additionally have its actual original identity job published, including its
mapping and native participants, before that attribution can be removed. The earlier approved state alone is
insufficient. A deleted verification subject retains its request until actual account-agent reversal has finished.

Current source roles also include identity intents and recovery associations in subject, requester and reviewer
roles, plus Realm erasure succession in subject, candidate and cursor-subject roles. The immutable source guards
require their actual receiving custody before those rows can be scrubbed. Selected rows remain specifically
`verification-source-custody` or `realm-succession-source-custody`; a published identity job does not discharge future
undo/recovery reads. These appended phases retain the original scheduling identities, reopen earlier local
completion for the added coverage, and run before the terminal account retry. Realm source consumers also retain
their original tombstone fence; Auth consumption discharges only Auth's dependency.

Account minimization waits for every other native phase, including retried blocked phases. It removes private
fields, historical handles/reservations, verification pointers and timestamps while preserving deleted identity,
authentication floor and the current fence/transaction needed for refusal. Only this terminal page can remove the
immutable creation timestamp. Successful independent phases cannot bypass a pending terminal-proof consumer.

The Access participant remains incomplete. Approval and opening acceptance can precede their effects; current
source provides no exact discharged-consumer proof for all those records or credential floors. Those selected
rows retain respectively `approval-consumer-proof-unavailable`, `opening-consumer-proof-unavailable` or
`credential-consumer-proof-unavailable`. Historical suspension/unfence work and cursor-bearing operator pages
retain their own continuation/page consumer reason; an Auth deletion witness does not discharge them. Realm
membership terminal proofs retain their actual source consumer dependency. Current foreign operator relationships
retain the existing transition protocol. These are individual durable blocked pages, not a blanket substitution
for independent native cleanup. The Realm deletion-entry/publication producer remains its owner's responsibility.

The supported shared-history producer-closure handoff for Access receipts, events and actual DBOS copies is still
missing. No recorder/minimizer or Context-role publication bridge is invented here. If all native phases finish,
`native_complete_at` records that fact outside DBOS and `shared-history-producer` identifies the remaining custody
path. This marker never calls `acknowledgeErasure`. Access and shared-history remain pending in `readErasureStatus`;
neither shared-history's global acknowledgement nor Auth's final acknowledgement is an early native readiness
condition. Native deletion, recovery, role/privacy and growth outcomes still require the preserved three-file
acceptance after integration; workspace typing does not establish those outcomes.

### Accepted identity technical receiver

The original `agent-verification-identity.ts` exports
`acceptAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference): Promise<IdentityNativeReceipt | null>`
and `verifyAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference, receiving: IdentityNativeReceipt): Promise<boolean>`.
Both types are the original Semantic exports, without a receiver brand or new source identifier.
The receiver belongs to the same live original source-home command. Its receipt is the actual
Access receiving commit's partition, epoch, position and transaction, distinct from the original
source component. Executor finalization supplies provenance; replay resolves the same durable
receiver. Source commits receiver acceptance and its own terminal transition atomically. A failed
post-write verification aborts that entire command; null acceptance must have no effects.
This custody cannot authorize erasure, new admission, disclosure or all-copy completion.

Integration requires Semantic's original `readAcceptedAccountIdentityBinding` export: an
accepted, committed, current-owner local binding read without active admission or foreign I/O.
The existing `readIdentityBinding` invokes admission and is not a substitute after the terminal
fence. Until that export is delivered, acceptance remains unavailable and verification false.
The original personal-source minimizer and exhaustive consumer discharge remain independently owned.

The Access receiver now stores the exact closed merge/unmerge intent, receipt key, original
native component/digest, accepted current job and original binding generation/commit. The
original workflow locator is retained as indispensable replay identity. Receiver provenance
is separate. Its reserved owner position is verified against the executor's actual same-command
outbox fence by a deferred constraint; callback verification aborts on any local mismatch.
A null result registers no callback and enrolls no inventory. Replay locks the same receiver,
accepted claim and current owner rather than creating another obligation.

Technical payload excludes personal reasons, requester/decider attribution, barrier and private
JSON. Native `agent_identity_technical_role` inventory covers only the source Account subject
actually retained by the closed technical payload. Graph subjects, releases, jobs and receipts
keep their real native identities; they do not create extra Account actor associations. Original
requester/decider, principal, acting-human and inherited History roles are never mirrored. The
remaining source Account association is personal custody and stays pending through native discovery.
Saved discovery phases retain their identities; a removed historical role row no longer blocks a
saved page. The forward privacy migration removes those copied IDs and original-role masks in
100-raw-key pages (under 64 KiB, each locator under 1 KiB), preserving both immutable receipts.
Its temporary native guard permits only the exact owner-migration cleanup, then restores refusal;
future inventory is constrained to the retained subject.

First acceptance validates the genuine original source, its erased-role association, native
component/digest, sealed native producer header with current owner/restore generation, and
accepted current job before writing. Replay and undo-only reads resolve the
same receiver without the erased personal roles or a current Account relationship. They validate
the exact immutable technical source, accepted binding/job, receiving receipt, owner epoch,
restore generation and retained inventory. Source's already-bound retained/reference/terminal
receipt owns barrier, erased-role and root/copy authority; technical verification neither queries
that terminal row recursively nor substitutes for erasure or all-copy proof. Reads use fixed native
source/receiver/binding keys and actual retained locator keys, O(k log N), without scanning the
original History scope. Ordinary admission retains the original active source checks and cannot
obtain a new source capability from the receiver. Original personal minimization and consumer
closure remain independently owned.

### Native Account reversal settlement

`agent-verification-identity.ts` exports the original Accounts ports:

```ts
readAccountIdentityReversalSettlement(
  pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext,
): Promise<AccountIdentityReversalSettlement | null>;
verifyAccountIdentityReversalSettlement(
  tx: CommandTransaction, reference: IdentitySourceConsumerReference,
  proof: AccountIdentityReversalSettlement,
): Promise<boolean>;
```

`AccountIdentityReversalSettlement` is opaque. The default
`finishAgentVerificationReversal` stages `prepareAccountIdentityReversalSettlement`, then calls
`recordAccountIdentityReversalSettlement` in its original account-home reversed command. The Account clear,
immutable relation, native terminal receipt and reversed event commit together. The unchanged workflow finish step
uses this default writer. Its receipt retains the executor's original input digest and replay guard; a retry cannot
replace the settlement or issue another event. No callback supplied by a caller can complete the writer.

The writer resolves the original verification through `readAccountIdentityUndo` in undo-only form, including after
T. It independently resolves the reversal's own accepted binding through
`readAcceptedAccountIdentityBinding`; the unmerge's `undoJob` must equal the verification's accepted job and must
differ from the reversal's own accepted job. Both exact jobs must be genuinely published at their native homes,
with native control currentness and all three fixed scoped receipts reconciled by `identityEpochStore`.
Each job/home probe releases before the Account write acquires its home. Nothing admits or mints a missing hint.

The original final writer accepts both closed technical inputs into the existing
`agent_identity_technical_source` receiver and its subject-only inventory. This is real Account undo/replay custody,
with the existing deferred native receiving constraint and undo-only read path, rather than a fabricated terminal
flag. The original source's personal attribution remains available until its separately authorized minimization;
undo-only source reads prefer that original while it exists and use accepted technical custody after it clears.
The settlement retains only original source components/digests, receipt identities, exact accepted binding
transaction/generation/scope/source basis and job, undo generation, both receiving components and the final command
component/key. It copies no reason, statement, requester, decider, barrier or response payload.

Generation meanings are deliberately separate. `binding.generation` is the original accepted replay generation;
`undoGeneration` is the original binding's current `consumer_undo_generation`, with its real native admission commit.
`restoreGeneration` is `core.history_family_domain.generation`, used by the actual Account technical receivers.
The settlement's `owner_epoch` and both original source epochs remain distinct from that domain generation. Native
claim and undo commits, receiver incarnation and the current source owner must still agree. A new generation is
never substituted for historical provenance. Missing legacy undo generations, missing original inventories, lost
receivers, moved/restored owners or unavailable accepted claims refuse settlement.

Read/verify bind the exact original reference, including job, source digest/component and barrier account/route,
version/time and erased role. The existing genuine Source-retained reference at this same home supplies that
association even after mutable Account fields or original personal attribution clear. It is association, not root
proof. Source must retain its original reference before asking for this component. The validator re-locks both
actual accepted bindings, native undo commits and technical receivers in the current live platform command. It
checks the persisted original terminal command rather than inferring completion from cleared fields, historical
event data, publication, an empty list or an in-process brand. There is no foreign checkout under this home.

These are fixed indexed points: one settlement selected by either unique original receipt, one retained reference,
and exactly two receiver/accepted-binding/native-generation sets. Read reserves 64 rows/points, 20 statements and
64 KiB; verify reserves 64 rows/points, 15 statements and 64 KiB from the original live Source maintenance frame.
No partition/account/history/holder enumeration or per-item network call occurs. Unfunded/expired work returns
null/false; existing worker budgets are unchanged. Released writer staging keeps the existing five-second deadline
and exactly two jobs, each with three native receipt probes. SQL bounds each retained binding snapshot to 8 KiB.

This component transfers Account-native replay/undo input obligations. It asserts no Library discharge, Semantic
terminal cut, generated History/SDK copy deletion, all-copy erasure or root completion. Semantic owns combining it
with independent obligations and extending its original `lockIdentitySourceConsumerCut`/verify protocol. Those
producers/hooks remain unchanged. The retained settlement and both technical receivers remain personal Account
subject custody: native discovery appends a stable phase and blocks their purge as `verification-source-custody`.
The new relation therefore cannot silently disappear from root accounting. The focused default-writer regression
covers genuine verify/reverse, lifecycle T, exact replay, changed input/reference, owner restore and receiver loss.
Original acceptance, native and growth execution remain deferred; workspace typing does not prove native closure.

### Native agent identity source retention boundary

`agent-verification-identity-retention.ts` minimizes at most eight distinct exact
`(route,account_id,direction,receipt_id)` keys. The registered default native erasure step passes its actual
WorkClient, environment and clock to `advanceNativeErasure`; the source phase calls
`minimizeDiscoveredAgentIdentitySources` before its checkpoint transaction. Its existing blocked-page cursor rotates
eight keys at a time. Generic native deletion cannot delete either original intents or recovery proof.
A completed personal source disposition clears the role residue, while the technical skeleton remains in native
inventory. Technical receivers and reversal settlements retain their independent subject obligations.

Supported placement is original source home0, barrier home0 and receiving home0 with the identical SDK Pool.
Root version/time, terminal fenced Account, active owner incarnation, original source tuple/digest and erased role
are checked in the initial command and locked again through the final command COMMIT. Foreign barriers return
`native-erasure-source-home-root-custody-unavailable` before a foreign root read. Missing originals, unavailable
accepted jobs, moved/restored owners, stale roots, unknown copies and mismatched pools refuse with their precise
owner gaps. Recovery originals have additional serializers outside the finite native cut; their missing copy
inventory remains `native-source-recovery-copies-unavailable`, rather than an inferred empty inventory.

The original accepted job is resolved by `readOriginalAccountAgentIdentity` after an undo-only native source read.
Verification uses its original accepted claim; unverify uses its own accepted job, never its prior `undoJob` as the
claim. No admission, new receipt, workflow-name parsing or caller-provided positive proof is involved. Source's
exact `IdentitySourceConsumerReference` and opaque `IdentitySourceConsumerCustody` flow through
`readAgentIdentityRetirementStage` and `verifyIdentitySourceConsumerCustody`. Subject requires discharged custody;
requester and decider require transferred technical custody. Every current Source/Account/Library obligation remains
independently required by the original Source verifier.

The default entry uses `withAgentIdentityHistoryUnit` to retain ONE original Source callback frame across released
observations and final COMMIT. An existing unit reuses its actual context; an unrelated live Source frame refuses
rather than nesting or replacing it. The old Pool-only entry can prepare/refuse but cannot mutate. Deadline and
native reservations are inherited without refund or replacement. The installed selected retirement engine remains
the sole writer of readiness, generation-2 closure, physical deletion and receiving proof; this minimizer consumes
its actual committed result and creates no parallel engine.

`shared-history-agent-identity.ts` stages the original point lookup, complete finite native inventory and original
`lookupAgentIdentityReceivingCopies` artifact. The final verifier re-reads the complete native cut, every role union,
current restore/owner generations, exact source-local obligation, every receiving receipt and receipt/outbox physical
row. It invokes `lockRecordedAgentIdentityHistory` with the actual stage and WorkClient, then the existing native
receiving validator for the original durable artifact. Durable work must actually be retired with physical absence,
cleared request/scope, generation-2 closure and the later matching receiving COMMIT. A successful current result
replaces a stale snapshot gap; null never falls back to that stale gap.

For outbox consumers, `historyReceivingGap` locks all runtime fanout rows (LIMIT33, overflow refuses; runtime maximum
32). Each retained consumer must be completed/transferred and resolve through the unique original workflow mapping,
full original obligation key, immutable source declaration and exact outbox/receipt handoff component. It then calls
`lockAgentIdentityReceivingArtifact`, which reuses the original mapping resolver and reads the complete native
History locator union (LIMIT65). The artifact's accounts come from that physical inventory, never workflow/source
metadata. The same receiving validator rechecks current generation-2, all-role digest, physical absence and barrier.
Unknown wrappers, unrelated executions and missing/foreign authority retain `outbox-receiving-custody-unavailable`;
completion alone cannot erase their arguments or manufacture receiving custody. Consumer rows are never removed to
obtain success. No foreign checkout occurs under the source command.

The forward migration `20261101103400_agent_identity_retention.sql` replaces the blanket source mutation guard with
only the native allowed role transition. Its literal `access.check_agent_identity_retention` locks the original
Source/SDK authority, exact current root and account, G and A, recovery absence, native sealed inventory/obligation,
restore domain, finite copy cut, complete role unions, later receiving rows/seals, durable work, original receipt and
every original outbox/consumer. UPDATE additionally requires every immutable source column to remain identical.
Subject minimization clears `intent` and marks the retained row minimized only after genuine discharge and all-copy
closure. Requester/decider minimization clears only the erased person's attribution (including reason when that
person decided), preserving the living subject's original intent, undo and surviving attribution. Both source and
recovery immutable triggers remain enabled ALWAYS. DELETE and recovery mutation still refuse. Undo-only reads of a
minimized source use the already accepted technical receiver; they cannot supply new-admission authority.

#### Additional final-frame cost handoff

This is the literal Accounts composition for the existing Semantic final-frame owner. It supplements the complete
selected-unit table above; it does not fund it. All vectors are rows/points/statements/bytes/engineRequests, with
engineRequests zero for the additions. Each listed bound is reserved before its actual call, including refusal,
failed dispatch and rollback prefixes. No subtraction on early return, cached success, replacement frame or local
ledger is permitted. SQL recognition and smaller configured/remainder caps stay unchanged.

| Literal SQL / export identity                                                    | Home and locked footprint                                                                                                                                                     | Reservation per invocation                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `identityHistoryCommand` in `history/agent-identity-inventory-work.ts`           | home0, one attempt; BEGIN, local deadline/config/time, no-effect native fence, COMMIT and failure ROLLBACK slot                                                               | C = 3/1/8/256/0                                                                     |
| `prepareNativeRetention` initial and final root/source SELECTs                   | exact erasure, Account, active partition, repeated partition and k source keys FOR UPDATE; k <= 8                                                                             | B(k) = (4+k)/(4+k)/(4+k)/16384/0, twice, each plus C                                |
| `consumerReference` native undo-only `readAccountIdentitySource`                 | original source command, technical fallback/role inventory and native command controls                                                                                        | 70/68/25/73984/0                                                                    |
| `readOriginalAccountAgentIdentity`                                               | original accepted claim/undo job; bounded three command attempts and six RR snapshots including controls/failure slots                                                        | 86/80/59/205920/0                                                                   |
| `readAgentIdentityRetirementStage`                                               | native `sourceHandoff`, original component/role/restore reads, then released Source custody read                                                                              | 73/71/26/82176/0 plus original Source reader's own reservations                     |
| `readAgentIdentityCopyReceiving` point lookup, excluding its receiving validator | released RR; native cut (three LIMIT65 unions), one exact candidate, one complete role union, BEGIN/config/COMMIT/ROLLBACK                                                    | 270/270/12/90112/0                                                                  |
| `readAgentIdentityNativeInventory`                                               | released RR, exact sealed inventory/partition/domain, LIMIT4 original copies, three LIMIT65 unions, controls/rollback                                                         | 203/202/9/65664/0                                                                   |
| `readHistoryReceivingReceipt` receipt/outbox                                     | released RR: barrier, sealed copy gate, LIMIT65 scope, active partition, exact receiving point and physical point, controls/rollback                                          | 76/75/12/24576/0, for each actual probe                                             |
| `lookupAgentIdentityReceivingCopies`                                             | released original native source command, immutable source declaration and exact mapped History work/partition/domain                                                          | 80/80/12/32768/0                                                                    |
| `verifyAgentIdentityCopyRetention` point validator                               | current barrier/copy gate, LIMIT65 scope, partition/receiving/physical points                                                                                                 | 72/72/12/20480/0                                                                    |
| `verifyAgentIdentityInventory` current cut                                       | same final command; exact native cut and three complete LIMIT65 unions                                                                                                        | 202/202/5/65536/0                                                                   |
| Current native inventory receiving/physical join                                 | each of at most three copies; exact receipt/outbox component; receiving/seal/locator FOR SHARE                                                                                | 4/4/3/1024/0 per copy; outbox receiving expansion below additional                  |
| Current `core.agent_identity_sdk_obligation` SELECT                              | full original key FOR SHARE                                                                                                                                                   | 1/1/1/1024/0                                                                        |
| `lockRecordedAgentIdentityHistory`                                               | original mapped row, current Source/SDK H, saved authority comparison and native G closure SELECT                                                                             | 1/1/1/122880/0 + H + 1/0/1/256/0 + G; H's internal reservations are not added twice |
| `verifyCurrentHistoryReceiving` original durable artifact                        | same final command; current mapping, root, full roles, exact receiving proof, native closure and physical absence                                                             | Rcurrent = 76/75/13/131872/0 + G + A                                                |
| `historyReceivingGap` outbox consumer SELECT                                     | same local home; complete fanout LIMIT33 FOR SHARE                                                                                                                            | 33/33/1/65536/0                                                                     |
| Original outbox receiving association SQL in `history/receiving.ts`              | each consumer: unique workflow -> full obligation key, exact outbox/receipt, original source declaration, exact native inventory and full original receipt key; all FOR SHARE | 8/8/1/16384/0                                                                       |
| `lockAgentIdentityReceivingArtifact`                                             | original mapping/work/partition/domain then native LIMIT65 role union                                                                                                         | 69/69/4/24576/0 per associated consumer                                             |
| Associated consumer `nativeReceipt`                                              | full durable receiving validation, never a completion flag                                                                                                                    | Rcurrent per actual consumer invocation                                             |
| Recovery preflight SELECT                                                        | exact original key FOR SHARE in final command                                                                                                                                 | 1/1/1/0/0                                                                           |
| `check_agent_identity_recovery_retention`                                        | six fixed reads, LIMIT33 effect consumer, LIMIT3 serializer copies, two LIMIT65 role unions and receiving proofs; no Search population query                                  | 174/174/12/65536/0 per guard                                                        |
| Role UPDATE and native retention trigger                                         | fixed original key; complete SQL in the forward migration, four LIMIT65 unions, two LIMIT33 outbox consumer sets, native physical points, G and A                             | M = 460/460/50/180224/0 + G + A = 561/556/70/221184/0                               |

The original role-trigger base includes the UPDATE and both trigger/function mapping reads, root/Account join,
recovery, inventory, obligation, domain and four copy cuts, per-copy aggregate/digest and receiving/seal/locator
joins, durable work and original receipt, original outbox LIMIT3 and its two LIMIT33 consumer loops. The 33rd
consumer and 65th role are refusal sentinels; the reservation includes them. It performs no locator/receiving writes
or invalidation fanout. For a recovery row the trigger calls the separate recovery checker above on both guarded
updates, so the exact addition is 2*(174/174/12/65536/0); full transition reservation is
2*(561/556/70/221184/0)+2*(174/174/12/65536/0)=1470/1460/164/573440/0. The migration is the complete literal SQL
body; linked TypeScript function names identify the dispatch sites. No caller setting or privileged SQL exemption
is added.

The reused full `readAgentIdentitySDKRetirementGap` additionally spends its original mapped RR observation,
pre/post actual SDK fence observations and released durable receiving Rread = 76/75/17/132000/0 + G + A; its existing
entry reservations remain in their original functions. Source read/verify entries remain independently reserved:
current verifier 100/100/22/139264/0 and reached Account 64/64/15/65536/0. The direct final Source verify and H's
Source verify both execute and each spends again. H remains 377/293/57/507904/0; G remains
92/87/11/40960/0 and A remains 9/9/9/0/0. Every outbox receiving invocation repeats its own fanout and associated
receiving guards, including released point/native reads and final point/inventory reads. For q outbox events and
c actual associated consumers, that expansion is q*(33/33/1/65536/0) +
c*(8/8/1/16384/0 + 69/69/4/24576/0 + Rcurrent), with q <= 2 and c <= 64 per complete native cut.
It is additional to each enclosing validator's own rows/control cost.

For k <= 8 keys the two native commands spend 2*C + 2*B(k); each staged key then spends every reached row above.
A refusal before staging still spends its command/root prefix. Staging refusal, SQL failure and rollback spend all
reservations already made; another delivery spends again. The per-key Source stage, original SDK observation,
current point/cut verification, H, Rcurrent, recovery point and M are separate reached calls, not alternative
budgets. Five existing current-verifier entries alone require 696320 bytes, exceeding the unchanged 630784-byte
Source allowance before new recovery receiving calls. The Source recovery branch refuses before foreign recovery
probes or writing. The old 11588/9856/2731/6843136/0 consumer body, 577, 585 and 1198 do not fund the complete
Source/History composition. Preserve directory parent100/200/36/229376 and effective child 50/100/18/114688,
smaller remainder/configuration caps and the native 100-row ceiling. Semantic must reconcile the repeated H/current
Account and Library's literal nested/fence costs before final funding; unknown-SQL refusal stays enabled.

The focused default positive/refusal regression is authored in `agent-verification-reversal.test.ts` and is UNRUN.
It requires genuine lifecycle T, accepted verify/reversal, actual same-Pool SDK admission, the installed selected
History engine and all receiving copies before default native minimization. It checks refusal before closure,
surviving decider attribution, retained technical undo and retry. Original acceptance/native/browser proof and full
Goal completion remain deferred; workspace typing establishes none of those outcomes.

### Selected History original and private transfer

The default History worker calls `history/work.ts:advanceSelectedHistoryOriginal`. Its native producer is
`identity-original-admission.ts:withSelectedHistoryOriginal(deps, body)`, where `deps` contains the actual
`Pool`, `WorkClient` and `HistoryRegistry`, and `body(jobId, transfer)` receives the opaque
`IdentityOriginalTransfer`. The native command locks the selected job and current registry, checks the account's
immutable erasure barrier, and persists its genuine transaction ID, exact job/account/home/phase/cursors, registry
and absolute five-second deadline. The command commits its entire dispatch debit and immutable allocation before
the handle escapes. Operational checkout, a job lease, callback identity and ALS are insufficient independently.

`consumeSelectedHistoryOriginal(deps, transfer, jobId)` commits a one-shot entry before affected work. It locks and
checks the original, job, registry and barrier. Failed validation poisons the live entry; rollback never refunds
its already committed reservation. `lockSelectedHistoryOriginalPosition` checks the same original inside the
real locked operational job transaction. `guardSelectedHistoryOriginalTransaction` checks liveness around each
awaited query, preserving failure ROLLBACK after expiry. Neither adapter issues native command resources or casts
an operational checkout into native authority.

The actual execution records its changed position through `recordSelectedHistoryOriginalProgress` before COMMIT.
Settlement accepts only that recorded position matching the current native job, then marks the original advanced.
A later changed cursor, registry wake/reset, workflow result or callback return alone cannot settle it. A genuinely
advanced native unit can be admitted independently; an unfinished original cannot change its identity, position,
partitions, spent balance or deadline on replay. A pending/complete phase transition is execution progress only.
It never claims physical custody closure.

The complete parent formula is the disjoint inclusive sum:

```
AccountsLocalControl + SourceHistoryNativeAllReachedCalls
                     + LibraryAllReachedCalls + AdditionalOriginalTransferControl
```

`ORIGINAL_AXES` fixes the SQL encoding order to candidate keys, native rows, identity metadata rows, native points,
witness keys, statements, bytes and empty seeks. Every vector requires exactly these eight own safe nonnegative
integer properties; the sum rejects overflow. The SQL representation additionally enforces eight bounded bigint
entries, immutable partitions and monotone entry/progress states. Discovery reserves the finite declared envelope
before its first SQL; native admission durably prepays it before any capability or child IO. The existing local
components remain `HISTORY_ORIGINAL_LOCAL_ALLOWANCE`. Their entire reservation is spent; no remainder of it is a
Source/Library allowance.

`HISTORY_ORIGINAL_TRANSFER_CONTROL` is the literal additional SQL declaration. It includes released discovery's
BEGIN/settings/COMMIT/failure ROLLBACK; allocation INSERT, original guard and FK points; the entry barrier check;
native progress read/write; settlement allocation read; and separate pre-grant/post-callback native commands.
Each transfer command includes original/allocation locks, selected job, registry, barrier, and its irreversible
state update. Their returned JSON/vector/column maxima are bounded independently. The exported sum is
`ADDITIONAL_ORIGINAL_TRANSFER_CONTROL`. Its candidate, identity metadata and witness axes are zero because those
operations do not occur in these control bodies, rather than by conversion from a legacy declaration.

Accounts reads child declarations only from the actual installed owner modules, before discovery:

- `semantic/identity-source-consumer-maintenance.ts:IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION`
- `library/collection-source-work.ts:IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION`

Each has type `IdentityHistoryOriginalBodyDeclaration`, containing `work: WorkDimensions` and `engineRequests: 0`.
The Source declaration must include every reached/repeated History, inventory, receiving, H/G/A, outbox, released,
current and final validator, settings, failed attempt, rollback and settlement body. Library must declare its real
page, verifier, planner, locked-plan, exhaustion, seal and final fence bodies. Five-value declarations do not fill
unclassified axes with zero. Configuration may reduce child limits; it cannot enlarge the original. No public
function accepts a structural funding declaration or caller price. An absent declaration is SQL NULL, not zero.
`identityOriginalRemainder(deps, transfer, jobId)` reports only these actual immutable partitions and the original
ID/deadline/position. Source and Library currently remain null; there is no adopted whole-parent numeric ceiling.

The Accounts private callable is:

```
withIdentityOriginalSourceTransfer(deps, transfer, jobId, body): Promise<T>
body(parent: IdentityOriginalSourceContext): Promise<T>
```

The parent supplies the actual original ID, job ID, exact position, unchanged deadline, prepaid native partition,
opaque `IdentityOriginalSourceGrant` and one cumulative `NativeCollectionWork`. Before callback escape a separate
native commit marks that original's child partition consumed. The callback cannot be reentered, even after failed
checkout, rollback, exception or an unavailable result. Before and after awaits, the producer validates actual
Pool/WorkClient/registry, native original/position/barrier/deadline and callback lifetime. Its final native command
revalidates the current/recorded position and permanently ends the callback. Failure leaves it consumed.

Source calls `reserveIdentityOriginalSourceWork(deps, parent.original, parent.jobId, amount)` before each native
dispatch; only the already prepaid native partition can pay. `identityOriginalLibraryWork` returns the SAME Library
ledger used by all descendants, receiving/current verification, exhaustion and the final same-command fence.
Saved ledger methods and reservation handles validate callback lifetime before dispatch and after awaits. Copies,
wrong dependencies, ended/expired callbacks and attempts to replace private counters fail. No new UUID, second
Library ledger, post-IO funding or refund is introduced.

`withSelectedHistoryOriginalChild` is the selected caller adapter. It requires the actual History private export
`withPrepaidAgentIdentityHistoryUnit` with the exported `PrepaidAgentIdentityHistoryUnit` signature:
`(deps, parent: IdentityOriginalSourceContext, body(funded: IdentitySourceConsumerMaintenanceContext)) => Promise<T>`.
That export must enter the existing History unit under the authentic Source prepaid frame and the same Library
ledger. The current independent configured caller is ineligible. Until the complete real declarations and that
private caller exist, the selected identity dispatch retains
`identity-history-original-source-transfer-unavailable`. Other undeclared artifact children retain
`identity-history-original-artifact-declaration-unavailable`; neither path spends local control work as child money.
Independent admission/allocation/entry/progress machinery remains available.

Only `agent_verification_reversal` with `com.rezics.access.agent-verification.reversing.v1` uses identity fx originals.
Work composition privately binds its existing effect object to the actual Pool/WorkClient without changing the
Semantic-owned verification workflow. The effects wrapper associates both relay and direct-enqueue paths with
one durable original keyed by native event epoch/partition/position/event sequence/effect and exact workflow ID.
The source command checks the real intent, sealed native inventory, SDK obligation, physical receipt/outbox,
undo job, source home/domain and full role union. Its LIMIT 65 sentinel refuses more than 64 account keys before
building the separate full-key barrier read. Source COMMIT/release precedes home-zero receiving, which binds the
actual receiver epoch and domain generation. Replays prepay their repeated local controls against the existing
original, never a renewed deadline or a child receipt.

The fx ten-attempt local ceiling covers only these source/receiving/replay controls, including the encoded scalar
columns outside bounded JSON. Complete SDK/framework dispatch/receiving/replay/rollback work remains a separate
missing child operand. `requireIdentityFxOriginalDispatch` refuses with
`identity-fx-original-child-declaration-unavailable` before wrapper enqueue or effect execution. Receiving retains
`pending-physical-owner`; consumer/workflow completion, SDK observations, registration and EOF never close it.
Source/Library/Search physical custody and private SDK closure remain their independent owner boundaries.

## Native live business copies

`live-copy.ts` implements a distinct `live-copy` lifecycle-coordination purpose for the fixed Commerce creator-sale
and Library subject-listing adapters. It does not reinterpret membership/operator reservations or History's erased
artifact families, and grants no Access/Source permission. Source admission uses the existing native operational
executor, current partition/domain, exact committed business basis and account `FOR UPDATE` serialization. All local
role holds commit with the immutable source transition. Remote roles are admitted one home at a time after release;
no positive receiver effect is eligible before every finite original role has a native hold. Roles come from actual
buyer/creator/Collection facts, write basis and exact native outbox role locators, not copied event role JSON. The
roster merges masks by account, refuses more than 64 accounts or 8 KiB, and never truncates. The coordination's
related account is the held account itself; its transaction is the genuine original business transaction, while
reservation and transition IDs are separate native identities.

Each transition binds module, original home/domain/epoch, business object and revision/transaction/event position,
native effect generation, receiver home/domain/epoch and exact immutable payload/role roster. Native full keys and
a canonical digest are both checked. The digest survives minimization solely as a negative deduplication tombstone;
a retired match refuses a fresh payload. It cannot join another operation or mint permission. Commerce generations
advance only in actual exact-event admission's native work CAS. A resumed locator cannot choose another generation.

The fixed receiver factories release all source checkouts before entering one current receiver home. `openLiveCopyGate`
serializes insert, apply and cancellation through one primary key, including first cancellation. The projection,
role-first inverse entries and `finishLiveCopyGate` terminal result commit together; a deferred native constraint
rejects committed `applying`. A unique partial `(route,applying_transaction)` index admits at most one open gate per
native receiving transaction. Commerce and Library projection triggers seek that exact current transaction and
compare the immutable payload, refusing legacy/prepared positive writers and fresh zero-marker writers without it. Already terminal apply returns its original result without another payload, timestamp,
inventory or receipt write. Superseded source revisions have an immutable no-write result. Cancel creates a terminal
negative gate without copying personal payload; if apply won it returns that applied result, leaving real erasure
obligations intact. Missing rows are never cancellation evidence.

`consumeLiveCopy` independently reads the genuine committed receiver result, releases that checkout, then enters
each role account home under its original account serialization. Full original transition, role, generation,
receiver incarnation and terminal identity must match. Only that hold and coordination row are consumed atomically.
An exact repeat reads the same result. A terminal role gate also bars a delayed first admission when cancellation
preceded that role's hold. Account deletion/operator responsibility changes retain the existing native unresolved
hold trigger; physical account deletion also refuses these holds. No timer, dispatch, absent row, cache or queue
completion releases them. A pending hold yields the existing truthful lifecycle blocked outcome before native T.

The ordinary `erasureWorkModule` registers `access.liveCopy.recover` on the existing maintenance queue/schedule.
A maintained partial `(route,next_run,transition_id)` index supplies one exact pending effect per step. Up to 4096
fixed native homes are visited with locator-only durable continuations. A reservation survives a dead enqueuer;
a receiver-commit/source-consume crash reads its original terminal result without rewriting the copy or restoring
an initiating principal. Retry dispatch time controls scheduling only. Transport ambiguity leaves the original
transition/holds pending. Migration frontiers additionally revisit one existing native Library pair/version and one
creator-sale row per step. Two independent primary-key seeks return at most two raw candidate keys and select one
Library key; both positive rows and zero version markers require genuine role coverage. Native source proof and role enrollment precede their coverage checkpoint. Old Library
observation cuts beyond the available original business-role basis remain an exact historical gap, as do missing
financial source proofs; neither is an empty successful projection. A terminal buyer permits only exact negative
legacy sale removal, never a new positive admission.
Commerce work and receipt keys have separate raw1 native primary-key frontiers. Current work uses the authentic
current order source; each retained historic receipt verifies its original outbox slot and native role inventory.
Unknown or minimized original proof retains that exact frontier. A genuine terminal buyer permits only deletion
of the exact old work or minimization of its receipt after the exact pending-transition check. These source-intent
frontiers cover roles independently of creator-row coverage; observing no creator row cannot discharge them.

### Live-copy inventory and minimization

`live-copy-erasure.ts` adds two append-only discovery groups to existing native erasure: `live_copy_inventory` for
source/hold/receiver payloads, and `live_copy_business_inventory` for exact Commerce work/receipt keys. Every retained
personal role has an inverse keyed by account then native home and exact item. Discovery retains the existing
4096-home, raw100 selected-key, 1 KiB locator and 64 KiB page limits (101st-row lookahead is charged and refused when
oversized). It first verifies the actual terminal account root and releases it. In the selected inventory home,
all four bounded historical role frontiers (Library pairs/versions, creator rows, source work and source receipts)
must be covered before its permanent account seal commits. Unknown coverage
retains an exact blocked native phase while other independent phases advance; it does not certify table exhaustion.
Before returning that pending outcome, a raw100 known-key page (101st-row lookahead charged, the same locator/page
byte refusal) can minimize already enrolled copies in that home using the genuine original native progress/root.
Each selected key uses the same minimizer below. Inverse deletion is its durable progress; the discovery cursor,
home frontier and closure status do not advance. Thus unknown historic coverage or financial participant readiness
does not suppress known-copy minimization. Pending copies remain exact locators for ordinary recovery.
The seal uses its own operational transaction. The checkpoint rechecks that same frontier; a changed frontier retries rather
than crossing homes with a lock. Native inventory admission and permanent per-home account seals serialize late
writers against discovery. A pending transition/hold keeps its exact locator; it cannot disappear via table EOF.

The minimizer rereads the genuine original root/progress and releases it before one selected copy home. It refuses
pending transition/hold/result state, removes or minimizes actual payload children first, then removes only that
role inverse. Commerce receipts lose order/revision, work is deleted only without pending transitions, and sales
are removed under exact creator/order/revision keys. Library pairs decrement the existing public aggregate once;
a real public change emits the ordinary `subject.listed` command event. Later replacement revisions/stamps are not
deleted by an older gate. Terminal gates keep only non-payload exact replay identity/result, and source transitions
scrub payload, role roster and business keys. Hold account links are deleted only after exact terminal consume.
Technical role gates, source digests and receiver tombstones retain the minimum negative replay identity; they
contain no account ID, financial view or original business object keys after minimization. Inverse account
associations themselves are removed. This is an explicit local disposition, not an opaque-key exemption or legal
financial retention rule. Original core receipt/outbox/record/SDK custody, root maintenance and History all-copy
closure remain independent and can keep the participant pending.

### Native domains and restore admission

The narrow Access migration admits domains once at actual `core.partition` node/epoch/committed position and creates
bounded old-pair, old-sale, source-work and source-receipt frontiers. Existing pending intents and projections are retained as coverage debt;
the migration invalidates earlier native-complete checkpoints for the two appended groups. Coverage is established
only by their maintained native scan and authenticated source/receiver outcome, never by missing new inventory rows. Writers cannot insert, rotate
or delete domains. Online partition activation rejects a missing/mismatched domain; online position rollback is
rejected. Routine position advancement adds no domain SQL lookup. Native reads require admitted active domain,
actual active placement and committed position at least the admitted cut. No missing domain is lazily seeded.

A physical backup rollback can restore matching old metadata and evade an online comparison. Database ownership
must therefore keep a restored home isolated/non-writable before service starts, reconcile original backup lineage
and committed tails at BOTH endpoints (transitions, holds, results, role inventory and terminal accounts), or durably
fence the affected old domains at every endpoint before any positive resume. Controlled owner/epoch movement needs
the same isolated migration barrier and row transfer. Replacing the immutable domain guard is Database-owner
migration work after that reconciliation, never application permission. The partition read API supplies placement,
not a universal restore attestation. Unavailable/mismatched lineage stays a specific fenced branch; this module
does not claim an implemented external backup reconciliation service. Fresh migration-admitted default operation
uses the positive native body above.

### New statement and row bounds

These are design bounds on indexed keys/finite fanout, not PostgreSQL invisible-version work or native execution
measurements. They do not allocate a second frame or raise existing Work/command/Source allowances. All dispatched
statements, rejected lookahead, failed attempts, rollback and repeated verification remain charged. An invocation
under Source must fit its SAME actual frame/planned remainder; unknown SQL is refused by that owner. Semantic's
strict footprint is unchanged here and requires composition against these actual bodies before use.

| New primitive                          | Direct statements and nested guard work per attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native protocol read                   | BEGIN, two 2,000ms local statement/lock settings, exact domain/partition point, at most one exact transition/gate/hold join, COMMIT; ROLLBACK on failure. Transition/gate return <=1 KiB key + 8 KiB payload + 8 KiB roster.                                                                                                                                                                                                                                                                                                                                                                                       |
| Standalone recovery/root/frontier read | Existing `withReadTransaction`: BEGIN RR READ ONLY, one remaining-deadline statement timeout (<=5,000ms), bounded exact points/seeks stated below, COMMIT or ROLLBACK. Each dispatch also has the same remaining client query timeout. No unbounded attribution text is fetched.                                                                                                                                                                                                                                                                                                                                   |
| Stage                                  | Domain point, insert transition, lock exact digest/full-key transition, one <=64-row source inverse insert; each inverse insert reaches one seal insert and one seal lock. Then local roles use the hold body below.                                                                                                                                                                                                                                                                                                                                                                                               |
| One role hold                          | Eight direct statements: domain, insert/lock role gate, lock account, insert/read hold, insert coordination, insert inverse. Hold insert guard reaches role gate, account and domain/partition points; coordination guard reaches one hold; inverse guard reaches two seal statements. Total <=14 body statements, plus original operational executor fencing/deadline/commit costs.                                                                                                                                                                                                                               |
| Admission observation                  | One native read per role, <=64 released homes; indexed exact hold/coordination/role-gate join, no account enumeration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Receiver apply                         | Domain point, gate insert/lock, owner projection body, <=64-row inverse insert (two seal statements per row), terminal CAS; deferred commit check is one exact gate point per insert/update trigger firing. Commerce adds account lock, prior revision point and original fenced DAO/CAS; Library retains original exact-pair listing SQL and command/event costs. Each attempted Commerce INSERT/UPDATE or Library pair/version INSERT/UPDATE adds one exact current-transaction gate point (at most one raw gate); ON CONFLICT can fire both row guards.                                                         |
| Cancel                                 | Domain point, gate insert/lock and its deferred exact gate check if inserted. No payload/inverse enrollment for a fresh negative gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| One role consume                       | Domain point, account lock, insert/lock role gate; if open, read hold, repeat domain point, update hold, delete exact coordination (one hold guard point), update role gate. <=10 body statements, plus original executor. Exact closed repeats stop after four. Complete uses domain, native source CAS and exact result read.                                                                                                                                                                                                                                                                                    |
| Inventory page/minimize                | Existing raw100/101 lookahead and byte refusal. Unknown-coverage preparation adds one such indexed known-key seek after its root/frontier read and failed seal attempt; at most 100 selected keys use the identical minimizer without advancing discovery. Each selected key invokes a released root point and one native copy-home body: configuration + inverse point, <=4 child/terminal mutations/probes, inverse delete. Public Library changes may roll back the operational attempt and repeat in the original command envelope; races may repeat within its existing 5,000ms deadline. All attempts count. |

Commerce source staging additionally uses the original four exact source/provenance reads, locked native order,
one exact original identity-basis point, one <=65-row original event-role read and two business inverse inserts (each <=64 roles, two nested seal statements
per role). Library staging uses partition/truth/Collection/write-basis/event points plus <=100 original event-role
reads of <=65 rows each; overflow refuses, and the final distinct roster still caps at 64. Human/delegation roles
come from that native inventory, never a UUID-shaped attribution reference. A missing original personal-role basis
is a specific pending branch; it is not fabricated as a successful empty roster.

Commerce's provenance statement reaches three indexed keys (native order, write basis and the exact trusted checkout
receipt); its source financial statement reaches work/order/account keys. If an original identity write basis is
absent, one additional receipt/order join (two indexed points) verifies the genuine buyer-owned checkout commit.
That receipt supplies provenance, never an invented service principal, financial response truth or permission.
Delegated original attribution requires actual native event-role inventory. No attribution text is fetched or cast.
Existing listing truth examines at most the original 5,000 live Collection occurrences under its exact pair key. No engine/provider IO is
added. Commerce's raw100 backfill locks/checks each selected buyer, inserts an intent, verifies the same four source
reads and their bounded join fanout above, reads original event roles and enrolls the two exact inventories within a savepoint. Missing proof rolls
back that item and checkpoints only the verified prefix with a future retry; fetched suffix and failed dispatch
are still charged. Each new work/receipt insert additionally defers one exact native order/account join and account
lock plus two exact mandatory-role inventory probes to commit (three body statements). Native identity-update
guards add no SQL. Minimized receipts contain no order/revision and bypass only that personal-intent check.
Each historical source-intent frontier attempt adds one locked frontier point, one raw1 work/receipt seek and
one native order/account lock. Active work then uses the four authentic source reads; an active receipt instead
uses one exact byte-capped outbox slot. Both use the same identity-basis point and optional receipt/order
verification above, read <=65 original event-role rows, enroll two <=64-role inverses (two nested seal statements
per role), and checkpoint once. Terminal buyer cleanup adds one exact pending-order
transition probe and one negative mutation instead. A recovery step attempts at most one work and one receipt
frontier in separate transactions, including a failed/rolled-back first attempt; all dispatched costs remain charged.
The legacy creator frontier adds one exact frontier point and one raw1 creator-primary-key seek, followed by the
same native delivery and an exact frontier CAS. Terminal legacy removal uses one released native order/account
point and one receiver delete limited by the observed revision. Library historic coverage adds the two raw1 primary-key seeks above, one exact frontier point and one exact
receiver pair/version probe; an uncovered old source cut refuses coverage. Discovery admission adds one exact four-frontier point,
seal insert/update and the existing executor. Library negative work creates no new transition, payload or missing pair/version. Never-public zero absence uses
a released partition/Collection/truth read and bounded receiver UPDATE/DELETE seeks with no inserted identity.
An existing nonterminal version can only advance its same-source monotone exclusion cut to zero; its personal
inverse remains enrolled for erasure. A genuine terminal curator permits negative-only cleanup of retained pair/version identities: two
released source/account points, one account-domain observation, one exact pair delete plus conditional listing-aggregate update and one exact version delete, within the existing
bounded command/operational retry body and limited by its observed source cut. It never inserts a missing
identity. The exported released-observation compatibility entrypoint re-reads source truth and uses the same native
factory, including equal-stamp conflict refusal. Each positive/negative step stays in one authoritative home,
released before the next.

### Cost: native live-copy admission and terminal consumption

- Touches: the exact transition, role gate, hold, lifecycle coordination, receiver gate and inverse keys listed
  above. Source and receiver domain reads join `core.partition` by its actual primary key; no global role scan
  or account-name/JSON discovery is used. Each role's active account lock serializes hold admission and terminal
  consumption with T. One native domain/hold observation per role is released before receiver acquisition.
- Bound: <=64 roles; transition/gate byte caps and per-primitive direct/nested statement bounds are in the table
  above. All eight axes are accounted separately: `candidateKeys` includes each attempted original event/role
  and rejected lookahead; `identityMetadataRows` includes the actual account/provenance children;
  `nativeRows` and `nativePoints` include guard joins and inverse seal children, not just returned projection rows;
  `witnessKeys` includes the actual original role/Access witnesses; `statements` includes BEGIN/settings/COMMIT,
  deferred triggers, savepoints and ROLLBACK; `bytes` includes capped full key/payload/roster and original selected
  source bytes; `emptySeeks` includes absent holds/gates/frontiers and duplicate negative probes. No value is
  guessed zero because an outer helper hides a child. Failed locks, refused rosters, replay, cancellation and
  partial/rolled-back attempts consume their actual full terms. Parent totals remain explicitly unknown pending
  complete child terms. Existing Accounts selected admission is local and fully spent; it funds no foreign child.
  No Semantic Source or History allowance is borrowed or increased.
- Growth check: `test/access/live-copy.test.ts` is focused source coverage for authentic positive/default paths,
  terminal arbitration, crash/replay/deletion and incarnation fencing. Execution and native examined-work evidence
  remain controller obligations. Existing History source/inventory/custody tests retain their original meaning.

### Cost: copy discovery and minimization

- Touches: the account-first `live_copy_inventory` and `live_business_inventory` indexes, exact native root,
  discovery seal and four historical frontiers, followed by named source, hold, gate or owner payload mutations.
  Unknown historic coverage permits bounded known-key minimization but neither a discovery checkpoint nor ACK.
- Bound: raw100/101 lookahead, <=64-KiB selected locator page and <=1-KiB locator, <=4096 actual homes. Each
  selected key's root and home body is charged independently, including seal refusal, negative/empty probes,
  deferred guards and public Library operational rollback plus ordinary command retry. Each of the eight axes
  above includes these selected keys and actual children; page exhaustion is not free physical completion.
  Aggregate native/DBOS/History work remains unknown until actual complete terms compose; no second allowance
  or erased-artifact receipt supplies live-copy admission, financial retention or all-copy acknowledgment.
- Growth check: retain original Accounts erasure/History custody acceptance and the new live-copy deletion/recovery
  cases. All native and physical execution is deferred; source-code bounds establish no measured closure.
