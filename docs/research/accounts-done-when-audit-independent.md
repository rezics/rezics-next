# Independent accounts completion audit

Audited on 2026-10-28 at base commit `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f`.
The completion claim is not fully supported: five bullets are proven by implementation and outcome assertions;
four are partly proven. Discovery duplicates authorization and misses inputs used by admission. Authentication
also has an availability-to-denial conversion and uses the wrong clock for external bearer expiry.

## Basis and recommendation

This is a source audit of that commit, not of other branches or subsequent work. “Proven” below means the product
implementation and executable outcome assertions exist and agree. No database, check host, product suite or root
gate was run. Consequently, merging on main and passing the root gate remain unverified for every bullet.
The gate discovers workspace checks at `scripts/gate.ts:92`; the default plans include all outcome wrappers under
`test/` (`services/kernel/scripts/check.ts:67`, `services/auth/scripts/check.ts:23`).

Authority is the supplied brief's original Done when (`.temp/ref/accounts-brief.md:9`) and gates Done when
(`.temp/ref/accounts-brief.md:78`), interpreted through its later decisions. In particular:

- The later gates decision means visible routes, uses `gate:<group>` / `gate:any`, and makes `visibleOperations`
  the interface for a future MCP adapter (`.temp/ref/accounts-brief.md:92`). Hidden routes and an absent MCP
  adapter are therefore not missing work in this audit.
- An absent principal removes that operand; the anonymous floor is an explicit exception to required scopes
  and positive grants (`.temp/ref/accounts-brief.md:48`). Current consent is enforced through issuance and
  Access-first epoch barriers, not a kernel-to-Auth consent lookup on every request
  (`.temp/ref/accounts-brief.md:131`).
- The later wall-time bearer decision supersedes the earlier general kernel-clock decision
  (`.temp/ref/accounts-brief.md:117`). Infrastructure failure must remain unavailability, not denial
  (`.temp/ref/accounts-brief.md:115`).

The common working pattern is durable authoritative rows, authenticated identities bound to those rows, ordinary
grant commands, and temporal exposure data. The exception is discovery's separate grant evaluator. Recommendation:
retain those boundaries, route discovery through a supported Access formula port, preserve availability errors
through Better Auth session establishment, and separate bearer time from kernel-issued lifetimes before proposing
completion. Then establish the merge-on-main prerequisite and run the root gate. These are recommendations for
adoption, not changes to the owning contracts.

Primary source is the [repository at the audited commit](https://github.com/rezics/rezics-next/tree/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f).
All product and test citations below are repository-relative `path:line` references at that commit. Its licence
text is [GNU AGPL version 3](https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/LICENSE)
(`LICENSE:1`). The supplied Chinese design document was background; the brief's decisions take precedence.
No external implementation was copied and no reference repository was needed.

### 1. Five authoritative concepts, account kinds and public automation identity

Verdict: proven.

Evidence:

- Account and operator are authoritative Access data: `services/kernel/db/access/schema.sql:382` defines the
  account table, `services/kernel/db/access/schema.sql:391` stores the operator on the operated account, and
  `services/kernel/db/access/schema.sql:421` constrains that relation. The only kinds are actor and organization
  (`services/kernel/db/access/schema.sql:425`). Grants live in Access, including temporal primary keys
  (`services/kernel/db/access/schema.sql:1002`, `services/kernel/db/access/schema.sql:1382`).
- Credentials and persistent sessions belong to Better Auth (`services/auth/db/migrations/202610250001_better_auth.sql:5`,
  `services/auth/db/migrations/202610250001_better_auth.sql:7`). Credential ownership uses the Access account ID,
  and Auth's profile fields are inert (`services/auth/db/migrations/202610250002_auth_boundaries.sql:2`).
  Client registration and account/client consent are durable tables
  (`services/auth/db/migrations/202610250002_auth_boundaries.sql:9`,
  `services/auth/db/migrations/202610250002_auth_boundaries.sql:14`).
- The public identity query derives `automated` and `operatorId` from the account row's operator
  (`services/kernel/src/access/public-identity-page.sql:1`). Public profile reading uses an allowlist
  (`services/kernel/src/access/account-data.ts:157`).
- Outcomes prove registration and matching credential/account IDs (`specs/account-lifecycle-outcomes.test.ts:78`),
  only two immutable kinds (`specs/account-lifecycle-outcomes.test.ts:131`), organizations without credentials
  (`specs/account-lifecycle-outcomes.test.ts:157`), and public automation attribution without private-data leaks
  (`specs/account-lifecycle-outcomes.test.ts:168`). The driver reads the real public HTTP identity endpoint
  (`services/kernel/test/access/account-lifecycle-outcome-driver.ts:892`), bound by
  `services/kernel/test/access/account-lifecycle-outcome.test.ts:7`.
- Persistent registered clients and consent are asserted at `services/auth/test/foundation.test.ts:252`;
  persisted ordinary gate grants are asserted at `specs/platform-gates-outcomes.test.ts:232`.

### 2. Better Auth person sessions and exclusive automated-session authority

Verdict: partly proven.

Evidence:

- Better Auth owns password/session mechanics (`services/auth/src/better-auth.ts:22`). The session creation hook
  requires private establishment context and checks active actor, client, consent and any approved opening
  (`services/auth/src/service.ts:393`). Password sign-in verifies the subject's own credential
  (`services/auth/src/service.ts:1941`); operator establishment consumes an exact Access opening before issuing
  the automated subject's session (`services/auth/src/service.ts:1021`).
- Person registration is a DBOS workflow (`services/auth/src/workflows.ts:499`), with pending-account creation,
  Auth credential provisioning and Access activation steps (`services/auth/src/workflows.ts:370`,
  `services/auth/src/workflows.ts:409`, `services/auth/src/workflows.ts:443`).
- Real Better Auth credential rows, cookies, session persistence and same-ID tokens are asserted at
  `services/auth/test/foundation.test.ts:124`. Durable registration interruption and retry are covered at
  `services/auth/test/workflows.test.ts:274` and `specs/account-lifecycle-outcomes.test.ts:100`.
- The lifecycle outcome suite covers person-only own credentials, automated own credentials, current operator
  opening, strangers, another operator, revoked management and credentialless automation
  (`specs/account-lifecycle-outcomes.test.ts:213`, `specs/account-lifecycle-outcomes.test.ts:223`,
  `specs/account-lifecycle-outcomes.test.ts:245`). The driver calls native Auth sign-in and opening ports
  (`services/kernel/test/access/account-lifecycle-outcome-driver.ts:592`,
  `services/kernel/test/access/account-lifecycle-outcome-driver.ts:611`). Exact one-use opening and stale
  operator rejection are additionally asserted at `specs/account-authorization-outcomes.test.ts:177` and
  `specs/account-authorization-outcomes.test.ts:190`, with native driver binding at
  `services/kernel/test/access/account-authorization-outcome.test.ts:7`.

Missing and smallest closure: the happy-path authority is supported, but the session creation hook catches every
failure of `activeActor` / `allowed` and converts it to `UNAUTHORIZED` (`services/auth/src/service.ts:421`).
Those functions perform authoritative Access and Auth reads (`services/auth/src/service.ts:224`,
`services/auth/src/service.ts:279`). Email sign-in returns the resulting authentication denial
(`services/auth/src/service.ts:1977`). Add an HTTP email/password sign-in test that injects an Access-read
unavailability error and an Auth consent-read connection failure during this hook: require retryable 503 and no
session/cookie, retaining 401 for a genuinely wrong credential. Preserve the failure classification through the
native Better Auth boundary instead of the catch-all denial. Existing refresh/issuance availability tests
(`services/auth/test/website-token-errors.test.ts:328`, `services/auth/test/website-token-errors.test.ts:350`)
do not exercise this hook. This gap violates the brief's availability decision even though normal session
ownership is covered.

### 3. One permission formula and independent operand denials

Verdict: partly proven.

Evidence:

- Normal Access authorization checks the scope in process (`services/kernel/src/access/permission.ts:192`),
  prepares current account, assignment and membership evidence (`services/kernel/src/access/permission.ts:264`),
  then invokes the actor/principal formula (`services/kernel/src/access/permission.ts:212`). The SQL combines
  temporal grants, role grants, explicit denials and assignment evidence
  (`services/kernel/src/access/permission-check.sql:22`, `services/kernel/src/access/permission-check.sql:63`).
- The frozen outcome suite first proves the fixture can execute (`specs/permission-outcomes.test.ts:74`), then
  independently removes only actor grant, only consent, and only principal grant
  (`specs/permission-outcomes.test.ts:90`, `specs/permission-outcomes.test.ts:93`,
  `specs/permission-outcomes.test.ts:96`). Different scopes and wrong actor/client consent also deny
  (`specs/permission-outcomes.test.ts:117`, `specs/permission-outcomes.test.ts:120`).
  The suite is wired to the native driver at `services/kernel/test/access/permission-outcome.test.ts:8`;
  consent reductions go through Auth's real consent endpoint
  (`services/kernel/test/access/permission-outcome-driver.ts:482`,
  `services/kernel/test/access/permission-outcome-driver.ts:533`).
- Closed-operation admission reuses `permissionAccess` for gates
  (`services/kernel/src/access/index.ts:247`, `services/kernel/src/access/index.ts:267`). Protected workflow
  steps also have per-operand revocation outcomes (`specs/account-authorization-outcomes.test.ts:112`).

Missing and smallest closure: discovery issues a second grant/denial decision through
`services/kernel/src/access/gates/visibility.ts:118` and `services/kernel/src/access/gates/held-gates.sql:22`.
It does not use the supported formula port and does not supply client scopes or organization-role evidence.
Thus the independent operand outcomes exist, but “one formula serves every request” is not true for discovery.
Replace that evaluator with an Access-owned batch/variant of the existing formula, preserving the bounded
catalogue read. Add discovery/admission parity outcomes for a missing operation scope and for a gate granted
only through organization membership, including an organization-role denial. These are the specific gaps in
bullet 8; no replacement operand suite is needed.

### 4. Kernel verification of the agreed Auth session contract

Verdict: partly proven.

Evidence:

- The agreed bearer shape and local verification boundary are recorded in `.temp/ref/accounts-brief.md:42`.
  Auth emits a session-bound token (`services/auth/src/service.ts:1994`) and checks claims/lifetime in its
  outcomes (`services/auth/test/foundation.test.ts:281`).
- Kernel verification uses cached public JWKS, verifies signature and claims, and performs a single anchored
  actor read for active state, fence and epoch floor (`services/kernel/src/access/authenticate.ts:151`,
  `services/kernel/src/access/authenticate.ts:181`, `services/kernel/src/access/authenticate.ts:214`).
  It resolves optional delegation from authoritative assignment data
  (`services/kernel/src/access/authenticate.ts:228`).
- Outcomes exercise real Auth tokens and a public JWKS fetch
  (`services/kernel/test/access/authenticate.test.ts:191`), cached verification through a JWKS outage without
  introspection (`services/kernel/test/access/authenticate.test.ts:229`), forged/expired/wrong-audience tokens
  (`services/kernel/test/access/authenticate.test.ts:256`), the single state/epoch read
  (`services/kernel/test/access/authenticate.test.ts:324`), and actual delegated assignments/principal grants
  (`services/kernel/test/access/authenticate.test.ts:380`).

Missing and smallest closure: the later clock contract is unmet. Kernel construction injects its domain clock
into Access (`services/kernel/src/http/kernel.ts:208`), which passes it to the bearer verifier
(`services/kernel/src/access/index.ts:108`). JWT `currentDate` and subsequent bearer expiry use that clock
(`services/kernel/src/access/authenticate.ts:185`, `services/kernel/src/access/authenticate.ts:237`), as do
later permission expiry checks (`services/kernel/src/access/index.ts:136`,
`services/kernel/src/access/index.ts:208`). A wall-valid bearer can therefore be rejected when kernel time is
advanced. The existing assertion actually requires that rejection
(`services/kernel/test/access/permission-kernel-clock.test.ts:162`), contrary to the newer brief decision.
Add a regression with a wall-valid bearer and kernel time two years ahead, plus a wall-expired bearer with
kernel T still inside its former validity interval; require acceptance and 401 respectively. Keep kernel-issued
approval expiry on kernel time. Separate issuing clocks in identity expiry and carry remaining bearer duration
across clock boundaries, as the decision requires. The owning implementation change must reconcile the old contrary assertion; this
audit changes no tests.

### 5. Exposure metadata and rejection during kernel construction

Verdict: proven.

Evidence:

- Exposure parsing rejects missing/invalid declarations (`services/kernel/src/access/gates/declaration.ts:7`).
  Construction validates every visible mounted route and throws with method/path
  (`services/kernel/src/http/kernel.ts:392`).
- Construction outcomes reject absent/invalid metadata and allow public or valid named gates
  (`specs/platform-gates-outcomes.test.ts:132`). Every production visible route is enumerated and checked
  (`specs/platform-gates-outcomes.test.ts:152`). The wrapper binds the native driver
  (`services/kernel/test/access/gates/platform-gates-outcome.test.ts:1`), whose invalid-route check really
  invokes kernel construction (`services/kernel/test/access/gates/platform-gates-outcome-driver.ts:574`).
- Product-specific tests additionally check mounted production routes and generated OpenAPI metadata
  (`services/kernel/test/access/gates/declaration.test.ts:93`,
  `services/kernel/test/access/gates/declaration.test.ts:109`). The hidden-route exemption is explicit
  (`services/kernel/test/access/gates/declaration.test.ts:81`) and agrees with the later visible-route decision.

### 6. Typed closed-operation denial and all four personas

Verdict: proven.

Evidence:

- Admission reads temporal exposure, admits open groups, otherwise requires the group's gate or `gate:any`
  on the fixed Global Context (`services/kernel/src/access/gates/admission.ts:19`,
  `services/kernel/src/access/gates/catalogue.ts:19`). Both anonymous and ungranted accounts throw the same
  `PlatformClosedError`; the HTTP layer maps it to the same typed 403 `platform_closed` problem
  (`services/kernel/src/http/app.ts:115`). Admission precedes the domain handler
  (`services/kernel/src/http/app.ts:250`).
- The frozen outcome compares anonymous and ordinary replies, proves no fixture domain read on denial, then
  grants tester and principal gates and permits tester and platform staff
  (`specs/platform-gates-outcomes.test.ts:164`). It separately checks loss of either actor or principal gate
  (`specs/platform-gates-outcomes.test.ts:188`) and staff use of every fixture group
  (`specs/platform-gates-outcomes.test.ts:217`). Invalid bearer remains a distinct 401, as expected.
- The native driver creates the product kernel (`services/kernel/test/access/gates/platform-gates-outcome-driver.ts:338`)
  and its grant method uses ordinary HTTP grant routes
  (`services/kernel/test/access/gates/platform-gates-outcome-driver.ts:469`).

### 7. Ordinary grant/revoke commands, administrative ceiling and platform permission

Verdict: proven.

Evidence:

- Grant commands collect management plus every affected action
  (`services/kernel/src/access/grant-commands.ts:89`). Each must pass the grantor's ordinary formula check
  before execution (`services/kernel/src/access/grant-command.ts:89`,
  `services/kernel/src/access/grant-command.ts:140`). The narrow Global Context gate exception allows
  `gate:any` to cover named gates, without covering unrelated actions
  (`services/kernel/src/access/grant-command.ts:101`). Revocation is the same command family
  (`services/kernel/src/access/grant-commands.ts:195`).
- Frozen outcomes prove ordinary grant/revoke and persisted temporal authority, denial when only
  `access:grant` is held, and staff granting a named gate through `gate:any`
  (`specs/platform-gates-outcomes.test.ts:188`, `specs/platform-gates-outcomes.test.ts:217`,
  `specs/platform-gates-outcomes.test.ts:248`).
- The real grant-route outcome additionally checks a delegated named-gate administrator cannot grant another
  group, `gate:any`, or an unrelated thread action, then checks HTTP revocation and the inactive stored grant
  (`services/kernel/test/access/gates/granting.test.ts:255`,
  `services/kernel/test/access/gates/granting.test.ts:276`,
  `services/kernel/test/access/gates/granting.test.ts:294`). The general administrative ceiling has an
  independent frozen outcome at `specs/permission-outcomes.test.ts:310`.

### 8. Viewer-filtered OpenAPI and visible operations

Verdict: partly proven.

Evidence:

- The served OpenAPI projects method/path pairs from `visibleOperations`
  (`services/kernel/src/access/gates/openapi-route.ts:35`,
  `services/kernel/src/access/gates/openapi-route.ts:84`). Visibility excludes hidden routes and reads current
  opening/grant data (`services/kernel/src/access/gates/visibility.ts:37`,
  `services/kernel/src/access/gates/visibility.ts:88`).
- Frozen outcomes compare served OpenAPI and visible operations for anonymous, ordinary, gated tester with
  principal, and staff (`specs/platform-gates-outcomes.test.ts:285`). Their driver calls the product visibility
  implementation, then restricts assertions to fixture operations
  (`services/kernel/test/access/gates/platform-gates-outcome-driver.ts:553`,
  `services/kernel/test/access/gates/platform-gates-outcome-driver.ts:561`).
- A product outcome compares discovery with HTTP admission, including delegation without and with a principal
  gate (`services/kernel/test/access/gates/discovery.test.ts:422`). This is useful coverage, but does not vary
  the operation scope or organization membership/role grant used for a gate.

Missing and smallest closure: discovery filters by admitted group alone
(`services/kernel/src/access/gates/visibility.ts:152`), whereas actual closed-route admission also requires
the route's action in the client's scopes (`services/kernel/src/access/index.ts:251`). A viewer holding a gate
but lacking that operation scope is listed although admission denies it. The separate SQL recognizes direct
identity/standing grants and direct denials (`services/kernel/src/access/gates/held-gates.sql:22`,
`services/kernel/src/access/gates/held-gates.sql:45`); it omits the authoritative organization-role evidence used
by the normal formula (`services/kernel/src/access/permission.ts:341`). A gate held only through an eligible
organization role is consequently omitted even when admission permits it; role denials can diverge too.
These are deductions from the compared code paths, not executed reproductions.

The smallest closure is one shared Access decision for discovery and admission, evaluated per distinct route
action as well as group, with the current scope and role evidence. Extend the existing parity suite with
same-gate/different-scope operations, an organization-only gate grant, and an organization-role denial; assert
both served OpenAPI and `visibleOperations` match admission. The future MCP adapter is not an additional
acceptance gap under the later decision.

### 9. Public opening through exposure catalogue data

Verdict: proven.

Evidence:

- Ordinary `:open` / `:close` routes authorize exposure commands
  (`services/kernel/src/access/gates/routes.ts:76`, `services/kernel/src/access/gates/routes.ts:94`). Commands
  write temporal opening data in the Global Context transaction
  (`services/kernel/src/access/gates/catalogue.ts:95`, `services/kernel/src/access/gates/catalogue.ts:110`),
  using the opening SQL (`services/kernel/src/access/gates/opening-open.sql:1`). Admission reads this data at T
  (`services/kernel/src/access/gates/catalogue.ts:34`, `services/kernel/src/access/gates/admission.ts:29`).
- The frozen HTTP outcome opens an existing group, checks the catalogue and unchanged route path/exposure,
  permits the anonymous call, closes it and restores the denial (`specs/platform-gates-outcomes.test.ts:263`).
  OpenAPI/visible-operation updates across opening and closing are also covered
  (`services/kernel/test/access/gates/discovery.test.ts:373`). No redeclaration or alternate handler is needed.

## Other findings

- **Second permission evaluator:** `services/kernel/src/access/gates/visibility.ts:118` calls
  `services/kernel/src/access/gates/held-gates.sql:22` to decide actor/principal grant and denial operands rather
  than using Access's formula. This breaks “One formula, no copies” (`.temp/ref/accounts-brief.md:119`), with
  concrete discovery differences described in bullets 3 and 8.
- **Unavailability becomes authentication denial:** `services/auth/src/service.ts:421` catches failures from
  authoritative account/client/consent reads and emits `UNAUTHORIZED`; email sign-in preserves the failure as
  authentication denial at `services/auth/src/service.ts:1977`. This breaks the unavailable-is-not-denial and
  authentication deadline decisions (`.temp/ref/accounts-brief.md:114`, `.temp/ref/accounts-brief.md:115`).
  The missing regression and minimal change are in bullet 2.
- **External bearer checked against kernel time:** `services/kernel/src/access/authenticate.ts:189` uses the
  injected kernel clock for JWT verification, and `services/kernel/src/access/index.ts:208` uses it again for
  identity expiry. `services/kernel/test/access/permission-kernel-clock.test.ts:162` encodes that old behavior.
  These contradict the later issuing-clock decision (`.temp/ref/accounts-brief.md:117`); see bullet 4.
- **Commerce writes Access grants directly:** the royalty-recording command invokes its module's SQL
  (`services/kernel/src/commerce/payouts.ts:240`), which inserts `access.resource_role_grant` itself
  (`services/kernel/src/commerce/payout-record.sql:40`). This breaks “Modules never write Access SQL”
  (`.temp/ref/accounts-brief.md:52`). Move that grant write behind an Access-owned transactional port, preserving
  its creator-account anchor and atomicity, and cover the payout read entitlement in the commerce outcome suite.
  This is existing base code; no commerce or Access implementation was changed for the audit.
