# Accounts, authentication and access

REZICS has one account identity and five concepts: account, operator, credential, client and grant.
[Access][access] owns identity and authorization inside the kernel; [Auth][auth] supplies authentication in a
separate service and database. This document states their contract. The linked source carries each rule; the
READMEs describe mechanisms, operational requirements and measured costs. An implementation gap called out here
does not change the contract.

## 1. Accounts

An account's immutable, non-reusable ID identifies its sign-ins, attribution, ownership and grants. There are
exactly two immutable kinds: an `actor` can authenticate and act; an `organization` holds resources and grants
exercised by its members. Human and automated actors share that structure; automation is the presence of an
operator relation, not another kind. The [account schema][schema] and [account reader][account-data] enforce this
model.

The [lifecycle][lifecycle] has `pending`, `active`, `suspended` and terminal `deleted` states. Pending accounts
cannot authenticate or appear publicly. Active actors can authenticate only while unfenced and at or above their
authentication floor. Suspension reasons remain private; the public attribution projection presents a suspended
account as active, rather than disclosing the suspension. See [authentication][authenticate] and the
[public identity read][access-public].

Account state, private data and the authentication floor live on the account's own anchor; so does the relation
to its operator. Organization membership lives on the organization, Realm membership on the Realm, and grants
on the protected resource. Handle uniqueness has its own anchor derived from the normalized spelling. Each
command writes one partition; cross-anchor lifecycle changes use durable work. Placement is defined by the
[schema][schema], [lifecycle commands][lifecycle] and [membership work][membership-work].

### Handles

Actors and organizations share one case-insensitive namespace. The adopted validation in
[handle-policy.ts][handle-policy] case-folds new claims and renames to lowercase, permits 3–64 ASCII letters,
digits, `_` and `-`, requires alphanumeric ends, and rejects whitespace without trimming. Existing 1–64-character
handles remain addressable under the separate lookup rule, including older punctuation-ending names. Display
names are independent of handle syntax. See [Handles][access-handles] and the
[handle policy research](research/account-handles.md#proposed-policy-for-the-account-design-owner); its proposed
3–32 limit is not the implemented adoption.

The reviewed registry in [handle-policy.ts][handle-policy] reserves platform names, authority roles and special
mentions across every claim path. Registry changes require a reason. An ordinary signup cannot bypass it;
`account:assign_reserved_handle` on the Global Context permits an audited exception for the caller or an account
they currently manage. The [reservation command][lifecycle] checks both that action and management authority,
including on replay; [Handles][access-handles] defines the registry and exception receipts.

Renaming publishes the new claim and reserves the former spelling for 30 days; during that window the old name
must redirect to the same account, without alias chains. [lifecycle.ts][lifecycle] provides that internal
resolution, but [public profile lookup][account-data] accepts only active claims and the
[website page loader][agent-page] treats reserved handles as missing: public forwarding is an implementation gap.
After the reservation expires, [reservation SQL][handle-reserve] permits another account to claim the spelling
without waiting for cleanup. The research's permanent retirement, privacy unlinking and dispute/reassignment
procedures remain proposals; the adopted validation and registry do not adopt those additional policies.

### Public identity

The public account page is `/@handle`, outside Realms and Zones. `GET /v1/accounts` accepts exactly one selector:
up to 100 deduplicated IDs, one handle, or one verified catalogue agent ID. Unknown and pending accounts are
omitted; handle and agent lookups also hide deleted accounts. The ID form preserves attribution tombstones.
Accounts are public, enumerable identities; the public projection protects private fields rather than concealing that a live account exists.
[routes.ts][account-routes], [account-data.ts][account-data] and [Public identity read][access-public] define the
projection and its bounds.

The deleted identity contract is exactly `{ id, state, kind }`, with no person/automation label. The base's
[account-data.ts][account-data] meets that shape for organizations but still returns extra null/false fields
for actors; those fields are an implementation gap, not additional public identity policy.

Live attribution exposes `id`, `kind`, `handle`, `displayName`, public state, `automated` and `operatorId`.
The handle profile can also expose biography, links, avatar, verification and the account's public-view choices.
It never selects email, credentials, sessions, consent, controller, birth date or private preferences. Activity
and organization speaker lists respect the account's publication settings; hiding a list does not change
underlying content permissions. See [account-data.ts][account-data], [public-views.ts][public-views] and
[Public profile by handle][access-profile].

## 2. Operators and automated accounts

An automated actor has exactly one operator: a human actor without an operator, or an organization. Automation
cannot operate another account or join an organization; an operator chain cannot grow recursively. Public
identity, account pages and attribution must mark automation and identify its operator, for example
“Automated · operated by @handle”. The [operator commands][operator], [membership inverse][membership-inverse]
and [public projection][account-data] carry the relation and public fields. The website's
[profile reader][web-profile-reader] currently drops `automated` and `operatorId`, and its
[profile header][web-profile-header] does not render that marking; this is a presentation gap.

The operator creates the account and controls whether it has independent credentials. Opening sessions,
changing credentials and managing it require current management authority: the human operator holds that
authority directly, while an organization's owners receive management defaults that can be delegated to other
members. Operator managers also hold `account:delete` through the current relation. Resource permissions are
separate grants to the automated actor; creating or transferring it copies none of its operator's grants.
See [operator.ts][operator], [permission.ts][permission] and [Trusted account effects][auth-effects].

A transfer needs two approvals of the same immutable subject, old relation version and destination: the
destination manager accepts first, then the source manager transfers carrying that acceptance. Each approval
uses its own actor, client, scopes and optional principal through the formula. One person may approve both only
with authority on both sides. The destination responsibility hold precedes publication; the source hold is
released only after terminal proof, and old sessions and relation approvals are invalidated. This is implemented
by [workflow-approvals.ts][approvals], [operator.ts][operator] and [account-workflows.ts][account-workflows]; see
[Account operation ports and ordering][auth-ordering].

Suspending an operator first fences that operator, then fences its operated accounts through receipt-bound,
signed pages. Pending responsibility holds cannot prevent suspension. Reinstatement lifts only fences raised
by that reversed suspension, on accounts still under the same operator reservation; unrelated, newer or
independent fences remain. Authentication floors never decrease. See [suspension.ts][suspension],
[operator-fence-work.ts][operator-fence-work], [reinstatement.ts][reinstatement] and
[Operator reinstatement fanout][access-reinstatement].

An AI assistant acting through someone's session is a client. An agent with its own identity is an automated
actor. The platform importer is an ordinary operated actor and follows the same contribution and permission
paths: [Auth session issuance][auth-service] and the [importer credential client][importer-credentials] provide
no service bypass.

## 3. Credentials, sessions and tokens

Credentials belong to actors, never organizations. A session can be established only by the actor's own
credential or an approved operator opening; the session owner and token subject remain the operated actor.
Humans retain at least one interactive credential. Adding or removing an automated actor's independent
credentials changes neither its kind nor its identity. [Better Auth configuration][better-auth],
[credential effects][credential-effects] and [Auth session hooks][auth-service] implement this boundary.

The credential contract includes passwords, passkeys, TOTP with backup codes and account-owned keys used through
`private_key_jwt`, available to either kind of actor. The base implements passwords and public keys for actors,
but [passkeys.ts][passkeys] and [credential-effects.ts][credential-effects] currently restrict passkeys to a
human's own account, and [better-auth.ts][better-auth] installs no TOTP/backup-code facility. Passkeys use
`rp.id = rezics.com` with verified user presence/verification; operational details are in
[Passkeys and credential freshness][auth-passkeys].

Sensitive operations require fresh authentication from verified session evidence, never caller-provided time.
The standard step-up contract is `x-step-up` beside `x-action`, with maximum authentication age and acceptable
methods; failure is HTTP 401 with a Bearer `insufficient_user_authentication` challenge and `max_age`.
`auth_time` and `amr` carry freshness and methods (`pwd`, `hwk` for passkeys, `otp`, and `mfa` for two factors).
The base's [credential effects][credential-effects] enforce a 600-second own-human freshness bound and its
[website authorization][website] honors OIDC `max_age`; generic route step-up metadata/challenges are not yet
implemented in the [request contract][request-access], and [Auth][auth-service] currently records passkeys as
`pop` instead of `hwk`. See [Kernel claim and verification contract][auth-claims].

Human recovery uses Better Auth's verified recovery token, a bound single-use proof and the Access-first barrier;
unknown, inactive and automated addresses receive the same start response without recovery mail. Automated
accounts have no email recovery: their operators reset credentials or revoke their sessions. Recovery cannot
upgrade a stale session, and only trusted new-establishment evidence can clear its fence. See
[service.ts][auth-service], [barrier-proofs.ts][barrier-proofs], [auth-barriers.ts][auth-barriers] and
[Guarded human recovery][auth-recovery].

Access tokens are ES256 JWTs with `typ: at+jwt` and a `kid`, issued for exactly five minutes. Claims are `iss`,
`aud`, `sub = account_id`, `client_id`, space-separated `scope`, `authn_epoch`, `iat`, `exp`, `auth_time`, `amr`
and optional `requested_by`. The production resource identifier and audience are exactly
`https://api.rezics.com`, without a trailing slash; the website sends that resource on authorization, code
exchange and refresh. Tests use `https://api.rezics.test`. No profile, email, birth date or bearer session secret
belongs in a token. See [signing.ts][signing], [website.ts][website] and [Kernel claim and verification contract][auth-claims].

The kernel verifies issuer, audience, signature, methods and lifetime locally against Auth's cached public JWKS,
then reads the actor's anchored account row once for authentication, rejecting inactive, fenced or below-floor
identities. There is no request-path Auth introspection or consent lookup. Additional principal and command
freshness checks are authorization evidence, not a second authentication service. See
[authenticate.ts][authenticate] and [command-admission.ts][command-admission].

Delegation never impersonates another account. `requested_by` is a verified assignment reference; `act` is
reserved for RFC 8693 exchange, not attribution of the delegator. Own-key sign-in produces short-lived tokens,
not personal access tokens. Device authorization and CIBA are the contract's cross-device approval mechanisms;
the base currently exposes neither, and token exchange is unsupported and `act` rejected by
[Auth][auth-service] and the [kernel verifier][authenticate]. See [Public HTTP contract][auth-http].

Refresh rotation is linearized per family across processes: reuse permanently revokes that family, including a
child racing with replay, and triggers Access invalidation. The approved provider patch uses an exact family
key rather than scanning token history; bounded cleanup never revives a revoked or missing family. See
[website.ts][website], the [provider patch][refresh-patch] and [Refresh families][auth-refresh] for the defect,
two-process probe and removal condition.

The website is the confidential first-party client `rezics-website`, using authorization code, PKCE S256 and
`private_key_jwt`. Its Worker holds the private key and all access, refresh and ID tokens in a server-side
session; the browser holds the session cookie. Media reservation and completion use the uploader's token and
that client; only the website can receive `media:complete`, and completion must match the reservation's uploader
and container. See [Website client][auth-website], [session routes][web-session-routes],
[session store][web-session-store] and [media routes][media-routes].

## 4. Clients, consent, requests and permission

The website, importer, launcher and CLI are first-party clients with standing consent within their registered
scope ceiling, shown as product sessions in Auth's security settings. Third-party clients require explicit
consent and revocation remains available through [Auth's session and consent routes][auth-service]. The importer is
platform-owned, authenticates as its automated actor through the ordinary key/token endpoint, and has only its
four approved import scopes, without website-only completion authority. The base's
[importer credential configuration][importer-credentials] instead requests six scopes, or seven for VNDB;
[Auth client registration and issuance][auth-service] enforce registered scope ceilings. Launcher and CLI device
authorization remain unimplemented, as noted in [Auth's boundary][auth].

The four import authorities are `subject:create`, `subject:batch_write`, `source_fence:read` and
`media:import_from_url` on the Global Context. [importer-credentials][importer-credentials] additionally requests
`statement:propose` and `media:read_reservation`, plus `source_statistic:write` for VNDB; these are the concrete
scope differences from the four-scope decision.

Consent in the permission formula means current consent. Auth issues only for a registered, ready client and
current consent, failing closed when either cannot be read. Every reduction of consent or client rights is
Access-first: an issuance gate prevents new client issuance during client reduction, each live credential owner
is fenced and has its floor advanced, and only confirmed receipts permit the reducing Auth write. Deleted owners
need no new barrier. See [service.ts][auth-service], [account-workflows.ts][account-workflows] and
[Native Auth barriers][access-barriers].

Automated consent is granted only by an approved operator opening, for its bound client and scopes. Consent
endpoints and an operator-opened session may reduce it, never widen it; a later approved opening may grant its
bound scopes again, while tokens below the advanced floor remain invalid. Barrier completion clears only its
own fence, never a fence another operation raised. Fresh sign-in inside that gap is refused. See
[auth-barriers.ts][auth-barriers], [service.ts][auth-service] and [Native Auth barriers][access-barriers].

The token selects the actor (`sub`), client (`client_id`) and optional delegating principal (`requested_by`);
request JSON cannot select a different identity. A principal creates the assignment under its own command,
binding the assigned actor and validity interval. The canonical reference is
`urn:rezics:request:<principal-uuid>:<request-uuid>`. Attribution shows the actor, third-party client when present,
delegator when present, and public operator marking for automation. See [delegation-commands.ts][delegation],
[authenticate.ts][authenticate] and the [command write basis][command].

There is one permission formula:

`effective permission = actor grants ∩ current client-consented scopes ∩ principal grants (if delegated)`.

[permission.ts][permission] checks the scope operand in process; [permission-check.sql][permission-sql] evaluates
both grant operands, current assignment validity and explicit denials. Unknown actions and missing evidence deny.
Modules use Access's supported authorization ports, including page and explicit-action decisions; they do not
copy or intercept the formula. See [Explicit action decisions][access-explicit].

The anonymous floor adds the permissions the action catalogue and resource visibility permit without a login.
An authenticated account gets that same floor without a grant or scope, unless an applicable denial names it
(such as a suspension, resource block or Realm ban). Scopes and grants add to the floor; a token with fewer
scopes does not lose public visibility. [eligibility.ts][eligibility], [permission.ts][permission] and
[permission-check.sql][permission-sql] implement this alongside the normal authenticated branch.

Creation is authorized on the existing parent at the command's T, never on the new ID: a subject's Context,
a thread's board, or media's container. A separately anchored parent check releases its connection before the
new resource transaction. An ordinary active account obtains creation rights through a standing parent grant
to the `active_accounts` principal, installed once and subsequently administered by normal grant commands.
See [parent-creation.ts][parent-creation], [resource-authorization.ts][resource-authorization] and
[standing-parent.ts][standing-parent].

The new-resource transaction calls [initializeResourceGrants][resource-initialization]: the data-defined type
template gives its creator the owner role and active accounts its standing roles. It writes role IDs, not
copied action lists; communal subjects may have an empty template. A parent-authorized manifest may create at
most 16 declared resources in one partition; every declared new insertion must initialize exactly once, and
finalization rolls back incomplete work. Replay initializes none. See [creation-manifest.ts][creation-manifest],
[resource-roles.ts][resource-roles] and [Direct resource role data][access-roles].

The only platform root is the seeded Global Context, route `0`, ID
`00000000-0000-8000-8000-000000000000`. All platform grants, global catalogue creation, bulk import and gates
attach there; there is no additional platform resource. The first governance holder is an explicitly named
active human installed by the deployment-only [bootstrap command][bootstrap], with a one-time marker and audit
event. Subsequent grants use the formula. See [governance-reach.ts][governance] and
[platform-governance.json][platform-governance].

Only the closed governance set `moderation:takedown`, `moderation:read_reports`, `post:erase`, `media:erase` and
`access:grant` may use either authority on the target or the same action held on the Global Context. Global
reach does not imply another action. A command using it records that fact in its own transaction. Grantors need
`access:grant` and cannot grant actions they do not hold, including when granting on the Global Context.
An account may renounce its own direct grant without `access:grant` when the client's scopes cover every
revoked action; that exception cannot revoke group grants or another account's grants. See
[grant-commands.ts][grants], [platform-governance.json][platform-governance],
[Grant rule][access-grant-rule] and [Platform governance reach][access-governance].

Every command attempt authorizes before reading an idempotency receipt, including retries and replays. A revoked
caller receives neither a stored result nor another effect. Catalogue actions that remove their own authority
declare `replay: 'self-account-read'`. Receipt identity is `(principal_kind, principal_id, command_kind,
idempotency_key)`; anonymous commands use the nil UUID as a kind marker and a client-generated UUIDv4 key, with
matching request digest required for replay. The digest binds client and delegation. See the
[command executor][command] and [request catalogue][request-access].

Each command attempt re-reads the actor's anchor before resource checkout and denies any changed state, fence,
floor or operator. Authentication retains its single point read; reads may reuse that snapshot for at most
180 seconds, within the request deadline and bearer lifetime. Each retry prepares new evidence and never
extends the original request deadline. Evidence preparation releases separate anchors in order and stays within
the pool's concurrency. See [command-admission.ts][command-admission], [Access composition][access-index] and
[Evaluator time][access-time].

Durable work records an immutable initiating actor/client/scope/delegation/epoch tuple and native creation
receipt, never a bearer token. Each new person-attributed action calls `restoreInitiator` at that step's T,
rechecking current account, floor, operator, consent, assignment, memberships and grants, with scopes capped to
the original ceiling. Expiry of the original bearer alone does not stop otherwise authorized durable work.
Mechanical completion of a committed platform decision (fetching, transcoding, physical cleanup or projections)
runs as platform work; publication and download still enforce their domain fences. See
[durable-initiator.ts][durable-initiator], [auth-consent.ts][auth-consent] and [Durable initiators][access-durable].

A workflow approval binds its operation key, exact operation, actor, client, scopes, epochs and optional
assignment. New protected effects recheck that authority at their own T; private results go only to the same
currently authorized caller and assignment. Completing one already committed effect uses its committed record;
after restart, resumption authorizes at its new T. Only self-authority-removing actions skip the ordinary
post-workflow result check. Cleanup continuations are narrower: exact allowlisted step, target, key and digest,
at most five minutes, no user-result authority, and only current governance may renew unfinished cleanup.
See [workflow-approvals.ts][approvals], [account-workflows.ts][account-workflows],
[committed-continuations.ts][continuations] and [Workflow approvals][access-approvals]. Auth's
[workflow binding][workflows] carries native refusals through one status-bearing contract, without matching
exception class names.

Unavailability is not denial. Missing facts deny, while elapsed deadlines, exhausted pool waits, connection or
capacity failures and exhausted transaction retries raise Access unavailability and map to retryable HTTP 503
`deadline_exceeded`, `overloaded` or `transaction_retry_exhausted`, without an applied command effect. Other
resource-evidence failures close the request using its domain denial, never an independent permitting branch.
See [unavailable.ts][unavailable], [evidence.ts][evidence], [problem.ts][problem] and
[Resource evidence failures][access-evidence].

## 5. Organizations and memberships

Organizations cannot hold credentials, be a token's subject, or act through shared credentials. Human members
act with their own attribution, or an organization operates an automated actor. Organization roles are `owner`
and `member`, with at least one owner; resource-specific permissions remain ordinary grants. Creating an
organization requires `organization:create` on the Global Context and makes the initiating human its first
owner. See [lifecycle.ts][lifecycle], [operator.ts][operator] and [Organization creation][access-organization].

Permission evaluation starts from the actor's membership inverse on the actor anchor, which is a superset,
never membership authority. Join reserves the inverse first; leave removes authoritative membership first and
the inverse last, through durable work. Only resource-matched organizations or Realms are verified through their
own anchored current-membership reads, never a cross-partition join. Missing inverse coverage or a missing Realm
adapter fails closed. See [membership-inverse.ts][membership-inverse], [membership-work.ts][membership-work] and
[permission.ts][permission]; [Membership work][access-membership] describes the Realm port.

An account may have at most 1,000 role-bearing organization and Realm memberships combined, admitted atomically
on its actor anchor; exceeding the cap returns `membership_limit`. Following a Realm is not membership and does
not consume a slot. This bounds candidates without dropping possible grants as a resource's ACL grows.
[membership-inverse.ts][membership-inverse] and [permission-inverse.sql][permission-inverse] enforce that limit.

## 6. Auth ownership and registration

Auth owns credentials, login/recovery email, native sessions, refresh families, authentication evidence, signing
keys/JWKS, client registration, consent and token issuance. Access owns handles, profiles, state, operator and
membership relations, grants, birth dates, content preferences and private account data. Better Auth's
`user.id = account_id` identifies a credential owner, with inert mandatory profile placeholders rather than a
second public user. Email stays in Auth; other services needing delivery use a trusted Auth port, not an address
copy. See [service.ts][auth-service], [Auth schema][auth-schema], [account schema][schema] and
[Application boundary and configuration][auth-boundary].

Private preferences are self-service account data: even a grant to another account does not bypass the
actor/path equality check. An operator-opened session changes the automated account's preferences as that
account. Spoiler, suitability, shelf and notification settings belong to [preferences.ts][preferences];
[Viewer preferences][access-preferences] defines their defaults and update contract. Notification delivery
checks the recipient's current settings as well as content access; mandatory moderation notices cannot be
turned off, as defined by [notification-kinds.ts][notification-kinds] and [preferences.ts][preferences].

Auth is the configured OIDC issuer at `auth.rezics.com`; signing keys and its database credentials stay out of
the kernel and clients. Login, consent and security pages belong to Auth, with main-site settings reached
through the website BFF. Cookie caching is disabled, so session revocation cannot be bypassed by a cached cookie.
See [issuer.ts][issuer], [better-auth.ts][better-auth], [Website client][auth-website] and
[Ordinary native host assembly][auth-host].

Registration is durable: reserve a pending account and handle in Access, install credentials in Auth for that
same ID, then activate the account and claim. Credentialless automation skips credential installation. Expired
pending reservations release their handle, and orphan credentials cannot authenticate without an active Access
account. See [registration-proof.ts][registration-proof], [lifecycle.ts][lifecycle] and
[workflows.ts][workflows]; [Durable account workflow host][auth-workflows] explains evidence and retry ordering.

Auth owns its bounded session, verification, key and consent-erasure maintenance in its own process and DBOS
system schema. Kernel modules share the kernel worker; they do not receive Auth database credentials or a new
maintenance RPC. [host.ts][auth-host-source] and [maintenance.ts][auth-maintenance] implement the Auth host;
the separate [website-maintenance.ts][website-maintenance] adapter still targets kernel worker composition for
protocol expiry and has not converged on that ownership rule.

## 7. Controllers and catalogue identity

A controller is the private real person or legal entity behind an account. A person's default identity is one
unoperated actor; alternate human identities must declare the same controller, and undeclared alternates are
abuse. Neither public identity nor tokens disclose that association. Independent review
excludes the proposer's controller set, including an automated actor's operator and delegator; organization
managers act as their own controllers. Review approval binds controller and current `authn_epoch`, lasts ten
minutes and is invalidated by a raised floor; there is no separate `control_epoch`. The [account schema][schema]
has private `controller_id`, but [workflow-approvals.ts][approvals] implements operation approvals, not this
independent-review/alternate-controller registry. That part of the contract is not yet implemented.

Controller-domain budgets and reservations use quota accounting, separately from account-class write rate
limits. The base's [write-rate.ts][rate] implements only the latter; no controller-domain quota ledger is
implemented in Access.

Rating counting is a separate implemented relation: [rating-counter.ts][rating-counter] derives a private
counting key from the account's operator at T, or the account itself when unoperated, with relation history for
delayed votes. It does not consume `controller_id` or enforce declared alternate human identities. The
[Rating counting key][access-rating] and [rating README][rating] own the counting and voting details.

Catalogue people, publishers and groups are subjects, not login accounts. A claim needs reviewed representation
evidence, creates a public profile link and grants no catalogue editing rights. Verification is gated and may be
released by the account or revoked by governance; evidence remains private. See
[agent-verification.ts][verification], [agent-verification-work.ts][verification-work] and
[Agent verification policy][access-verification]. An account may claim multiple subjects for its pen names;
the base stores a single current verified subject on the account and does not yet implement that multiplicity.

## 8. Platform gates

Every mounted route declares `x-exposure: public` or `gate:<group>`; composition refuses missing or invalid
declarations. Groups use feature names matching `^[a-z][a-z_]{0,62}$`, excluding `any`, `open` and `close`.
A closed group needs `gate:<group>` or `gate:any` on the Global Context for both actor and optional principal,
within the route action's client scope. Anonymous and ungranted callers receive the same `403 platform_closed`
before domain reads. See [declaration.ts][gate-declaration], [admission.ts][gate-admission] and
[Platform gates][gates].

Ordinary grants administer gate access; `gate:any` covers all gate groups and no unrelated action. Opening or
closing a group changes temporal catalogue data through idempotent
`POST /v1/platform/exposure/{group}:open` or `:close`, authorized by `exposure:open` or `exposure:close`.
Gate state is read at each request's T without caching. Organization creation also uses the `organizations`
group through the internal admission port; deletion is never gated. See [gate routes][gate-routes],
[gate catalogue][gate-catalogue] and [account operation transport][account-transport].

OpenAPI and `visibleOperations(viewer)` omit operations the viewer cannot use. A future MCP adapter must build
its tool list from that same port. `GET /v1/platform/exposure` returns only sorted admitted mounted groups and
uses `no-store`; absence means closed, without revealing inaccessible group names. See
[visibility.ts][gate-visibility], [admitted-groups-route.ts][gate-groups] and [Platform gates][gates].

## 9. Time

One trusted [kernel clock][clock] supplies authoritative T for command attempts and non-command Access checks;
production uses the system clock, without request overrides. Grants, role assignments, memberships and denials
use native `tstzrange` validity at T, with `WITHOUT OVERLAPS`; cleanup is not an expiry correctness barrier.
See [permission-time.sql][permission-time], [permission-check.sql][permission-sql], [schema][schema] and
[Evaluator time][access-time].

Bearer credentials originate outside the kernel: `iat`, `exp` and every bearer-expiry comparison use wall time.
Kernel-issued approvals, operator openings, registration proofs, capabilities and cursors use kernel T. An
identity's expiry retains its issuing clock; crossing clocks carries remaining duration and reconstructs the
deadline on the receiving clock, never compares foreign instants. Thus a kernel approval capped by a bearer
stores its remaining bearer lifetime in kernel time. The base still uses the injected kernel clock for bearer
verification and stores absolute JWT expiry in approvals: [authenticate.ts][authenticate],
[Access composition][access-index], [approved-identity.ts][approved-identity] and
[workflow-approvals.ts][approvals] have not completed this separation; the credential opening in
[operator.ts][operator] also caps kernel expiry with an absolute bearer instant.

Request/evidence deadlines remain real-time budgets; database guards use the database clock and remaining
duration, separately from T. Retries retain the fixed request deadline. [deadline.ts][deadline],
[permission.ts][permission] and [unavailable.ts][unavailable] carry those checks; the
[Evaluator time][access-time] section describes their clock boundary.

## 10. Write rate limits

Write admission is a shared pipeline stage, using account class × operation family; ordinary writes spend one
unit and bounded request batches reserve their units once. Durable chunks restore their initiating identity and
spend once per immutable chunk index, without charging an exact retry twice. Authentication, gates and
authorization remain required even with rate budget. See [write-rate-stage.ts][rate-stage],
[write-rate.ts][rate], [write-rate-budgets.ts][rate-budgets] and [Write rate][access-rate].

Counters and chunk ledgers are partition-led `UNLOGGED` operational data: account route for an actor, a route
derived from the identity digest for anonymous traffic. Crash loss or partition movement may reset budgets;
they are not a global singleton. Bounded expiry retains the 48-hour cleanup grace. A spent budget returns 429
with `Retry-After`; unavailable limiting fails closed as retryable 503. See [write-rate-counter.sql][rate-sql],
[write-rate-expiry.ts][rate-expiry], [write-rate-stage.ts][rate-stage] and [Durable bulk][access-bulk].

Auth separately limits login, recovery and step-up attempts with native Better Auth rate limiting backed by
atomic `UNLOGGED` counters, and guards signup/recovery with Turnstile. Those controls do not replace kernel write
budgets. See [rate-limit.ts][auth-rate], [turnstile.ts][turnstile] and [Auth host][auth-host-source].

## 11. Suspension, takeover and deletion

Suspension and session revocation are Access-first: advance the epoch floor and commit the fence/receipt before
Auth revokes sessions and refresh authority. Revocation is the subject's own freshly authenticated action or
a governance action on the Global Context; an Auth failure returns `revocation-failed` while preserving the
committed fence. Takeover/recovery installs new credentials only against that exact receipt and clears its fence
only after trusted new-establishment proof. Reinstatement never restores old sessions or lowers the floor.
See [session-revocation.ts][session-revocation], [suspension.ts][suspension], [auth-barriers.ts][auth-barriers],
[recovery-completion.ts][recovery-completion] and [Session revocation][access-revocation].

[Deletion](deletion.md) owns erasure: account deletion is final at fresh, typed confirmation, private data is
purged by bounded durable work and retained public contributions have only de-identified `{ id, state, kind }`
attribution, through [lifecycle.ts][lifecycle], [account-workflows.ts][account-workflows] and
[Account deletion policy][access-deletion].
Operators must resolve operated-account responsibilities and organizations their ownership constraints before
the barrier, while statutory erasure requests remain independent; expired cleanup cannot restore identity or
release a hold, and [Auth consent erasure][consent-erasure] removes consent after the access-token lifetime.

[access]: ../services/kernel/src/access/README.md
[auth]: ../services/auth/README.md
[schema]: ../services/kernel/db/access/schema.sql
[account-data]: ../services/kernel/src/access/account-data.ts
[lifecycle]: ../services/kernel/src/access/lifecycle.ts
[authenticate]: ../services/kernel/src/access/authenticate.ts
[membership-work]: ../services/kernel/src/access/membership-work.ts
[handle-policy]: ../services/kernel/src/access/handle-policy.ts
[handle-reserve]: ../services/kernel/src/access/lifecycle-handle-reserve.sql
[agent-page]: ../apps/web/src/features/pages/agent.tsx
[web-profile-reader]: ../apps/web/src/features/pages/account-read.ts
[web-profile-header]: ../apps/web/src/features/pages/account.tsx
[account-routes]: ../services/kernel/src/access/routes.ts
[public-views]: ../services/kernel/src/access/public-views.ts
[operator]: ../services/kernel/src/access/operator.ts
[membership-inverse]: ../services/kernel/src/access/membership-inverse.ts
[permission]: ../services/kernel/src/access/permission.ts
[approvals]: ../services/kernel/src/access/workflow-approvals.ts
[account-workflows]: ../services/auth/src/account-workflows.ts
[suspension]: ../services/kernel/src/access/suspension.ts
[operator-fence-work]: ../services/kernel/src/access/operator-fence-work.ts
[reinstatement]: ../services/kernel/src/access/reinstatement.ts
[auth-service]: ../services/auth/src/service.ts
[importer-credentials]: ../services/importer/src/credentials.ts
[better-auth]: ../services/auth/src/better-auth.ts
[credential-effects]: ../services/auth/src/credential-effects.ts
[passkeys]: ../services/auth/src/passkeys.ts
[website]: ../services/auth/src/website.ts
[request-access]: ../services/kernel/src/request/access.ts
[barrier-proofs]: ../services/auth/src/barrier-proofs.ts
[auth-barriers]: ../services/kernel/src/access/auth-barriers.ts
[signing]: ../services/auth/src/signing.ts
[command-admission]: ../services/kernel/src/access/command-admission.ts
[refresh-patch]: ../patches/@better-auth%252Foauth-provider@1.8.0-beta.2.patch
[web-session-routes]: ../apps/web/src/session/routes.ts
[web-session-store]: ../apps/web/src/session/store.ts
[media-routes]: ../services/kernel/src/content/media-routes.ts
[delegation]: ../services/kernel/src/access/delegation-commands.ts
[command]: ../services/kernel/src/command/command.ts
[permission-sql]: ../services/kernel/src/access/permission-check.sql
[eligibility]: ../services/kernel/src/access/eligibility.ts
[parent-creation]: ../services/kernel/src/access/parent-creation.ts
[resource-authorization]: ../services/kernel/src/access/resource-authorization.ts
[standing-parent]: ../services/kernel/src/access/standing-parent.ts
[resource-initialization]: ../services/kernel/src/access/resource-initialization.ts
[creation-manifest]: ../services/kernel/src/access/creation-manifest.ts
[resource-roles]: ../services/kernel/src/access/resource-roles.ts
[bootstrap]: ../services/kernel/scripts/bootstrap-governance.ts
[governance]: ../services/kernel/src/access/governance-reach.ts
[platform-governance]: ../services/kernel/src/access/platform-governance.json
[grants]: ../services/kernel/src/access/grant-commands.ts
[access-index]: ../services/kernel/src/access/index.ts
[durable-initiator]: ../services/kernel/src/access/durable-initiator.ts
[auth-consent]: ../services/kernel/src/access/auth-consent.ts
[continuations]: ../services/kernel/src/access/committed-continuations.ts
[unavailable]: ../services/kernel/src/access/unavailable.ts
[evidence]: ../services/kernel/src/access/evidence.ts
[problem]: ../services/kernel/src/http/problem.ts
[permission-inverse]: ../services/kernel/src/access/permission-inverse.sql
[auth-schema]: ../services/auth/db/schema.sql
[preferences]: ../services/kernel/src/access/preferences.ts
[notification-kinds]: ../services/kernel/src/access/notification-kinds.ts
[issuer]: ../services/auth/src/issuer.ts
[registration-proof]: ../services/kernel/src/access/registration-proof.ts
[workflows]: ../services/auth/src/workflows.ts
[auth-host-source]: ../services/auth/src/host.ts
[auth-maintenance]: ../services/auth/src/maintenance.ts
[website-maintenance]: ../services/auth/src/website-maintenance.ts
[rating-counter]: ../services/kernel/src/access/rating-counter.ts
[rating]: ../services/kernel/src/rating/README.md
[verification]: ../services/kernel/src/access/agent-verification.ts
[verification-work]: ../services/kernel/src/access/agent-verification-work.ts
[gate-declaration]: ../services/kernel/src/access/gates/declaration.ts
[gate-admission]: ../services/kernel/src/access/gates/admission.ts
[gates]: ../services/kernel/src/access/gates/README.md
[gate-routes]: ../services/kernel/src/access/gates/routes.ts
[gate-catalogue]: ../services/kernel/src/access/gates/catalogue.ts
[account-transport]: ../services/auth/src/account-operations-transport.ts
[gate-visibility]: ../services/kernel/src/access/gates/visibility.ts
[gate-groups]: ../services/kernel/src/access/gates/admitted-groups-route.ts
[clock]: ../services/kernel/src/clock.ts
[permission-time]: ../services/kernel/src/access/permission-time.sql
[approved-identity]: ../services/kernel/src/access/approved-identity.ts
[deadline]: ../services/kernel/src/request/deadline.ts
[rate-stage]: ../services/kernel/src/access/write-rate-stage.ts
[rate]: ../services/kernel/src/access/write-rate.ts
[rate-budgets]: ../services/kernel/src/access/write-rate-budgets.ts
[rate-sql]: ../services/kernel/src/access/write-rate-counter.sql
[rate-expiry]: ../services/kernel/src/access/write-rate-expiry.ts
[auth-rate]: ../services/auth/src/rate-limit.ts
[turnstile]: ../services/auth/src/turnstile.ts
[session-revocation]: ../services/kernel/src/access/session-revocation.ts
[recovery-completion]: ../services/kernel/src/access/recovery-completion.ts
[consent-erasure]: ../services/auth/src/consent-erasure.ts
[access-handles]: ../services/kernel/src/access/README.md#handles
[access-grant-rule]: ../services/kernel/src/access/README.md#grant-rule
[access-preferences]: ../services/kernel/src/access/README.md#viewer-preferences
[access-public]: ../services/kernel/src/access/README.md#public-identity-read
[access-profile]: ../services/kernel/src/access/README.md#public-profile-by-handle
[access-reinstatement]: ../services/kernel/src/access/README.md#operator-reinstatement-fanout
[access-barriers]: ../services/kernel/src/access/README.md#native-auth-barriers
[access-explicit]: ../services/kernel/src/access/README.md#explicit-action-decisions
[access-roles]: ../services/kernel/src/access/README.md#direct-resource-role-data
[access-governance]: ../services/kernel/src/access/README.md#platform-governance-reach
[access-time]: ../services/kernel/src/access/README.md#evaluator-time
[access-durable]: ../services/kernel/src/access/README.md#durable-initiators
[access-approvals]: ../services/kernel/src/access/README.md#workflow-approvals
[access-evidence]: ../services/kernel/src/access/README.md#resource-evidence-failures
[access-organization]: ../services/kernel/src/access/README.md#organization-creation
[access-membership]: ../services/kernel/src/access/README.md#membership-work
[access-rating]: ../services/kernel/src/access/README.md#rating-counting-key
[access-verification]: ../services/kernel/src/access/README.md#agent-verification-policy
[access-rate]: ../services/kernel/src/access/README.md#write-rate
[access-bulk]: ../services/kernel/src/access/README.md#durable-bulk
[access-revocation]: ../services/kernel/src/access/README.md#session-revocation
[access-deletion]: ../services/kernel/src/access/README.md#account-deletion-policy
[auth-effects]: ../services/auth/README.md#trusted-account-effects
[auth-ordering]: ../services/auth/README.md#account-operation-ports-and-ordering
[auth-passkeys]: ../services/auth/README.md#passkeys-and-credential-freshness
[auth-claims]: ../services/auth/README.md#kernel-claim-and-verification-contract
[auth-recovery]: ../services/auth/README.md#guarded-human-recovery
[auth-http]: ../services/auth/README.md#public-http-contract
[auth-refresh]: ../services/auth/README.md#refresh-families-provider-patch
[auth-website]: ../services/auth/README.md#website-client
[auth-boundary]: ../services/auth/README.md#application-boundary-and-configuration
[auth-host]: ../services/auth/README.md#ordinary-native-host-assembly
[auth-workflows]: ../services/auth/README.md#durable-account-workflow-host
