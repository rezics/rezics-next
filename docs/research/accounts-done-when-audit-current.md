# Accounts Done-when audit

Audit target: base commit `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f` on the supplied worktree branch. This report audits the nine conditions in the task contract against product code and outcome tests at that commit; it does not infer progress from other branches.

Contract sources: `.temp/ref/accounts-brief.md:42-43` records the account and permission contracts; `:78-92` records the platform-gate Done-when and its final implementation contract; `:52` says modules never write Access SQL; `:115` says unavailability is not denial; and `:119` forbids copies of the permission formula. The design document is background only. Where the gates section first says `platform:use:<group>` (`:86`), its later explicit contract (`:92`) selects `gate:<group>` and `gate:any`; this audit uses that final naming, which matches the implementation and tests.

## Findings

### 1. Authoritative account, operator, credential, client and grant data

**Verdict:** proven.

**Evidence:** `services/kernel/db/access/migrations/20261025041000_access_accounts.sql:4-22` stores the account row, constrains kinds to `actor` and `organization`, and permits an operator relation only on a non-self actor. `services/kernel/db/access/migrations/20261025104716_access_operators.sql:2-21` versions changes to that relation. `services/auth/db/migrations/202610250001_better_auth.sql:3-9` stores Better Auth users, sessions and credential accounts; `services/auth/db/migrations/202610250002_auth_boundaries.sql:2-22` binds passwords to Access account IDs and stores registered clients, consent, and session client IDs. `services/kernel/db/access/migrations/20261025104714_access_permissions.sql:4-29` stores grants and denials.

`services/kernel/src/access/account-data.ts:50-57,103-117` derives the public `automated` flag from the operator relation and returns `operatorId`. `services/kernel/test/access/public-identity-read.test.ts:182-250` proves actor and organization identities and the automated identity/operator fields. `services/kernel/test/access/data.test.ts:52-75` exercises account-kind and identity constraints. `services/auth/test/foundation.test.ts:124-150` proves a person's credential owner is the Access ID and that a persistent Better Auth session yields that subject; `:252-279` proves registered clients and consent constrain session/token scopes. `services/kernel/test/access/gates/granting.test.ts:255-327` proves grants are persisted and revoked through the grant command path.

### 2. Better Auth request identity and person/automated sessions

**Verdict:** proven.

**Evidence:** `services/auth/src/better-auth.ts:21-44` configures Better Auth, enables email/password and disables its public signup endpoint. `services/auth/src/service.ts:324-428` composes Better Auth and only creates sessions inside trusted establishment after an active actor, client/scope, subject, and any operator opening have been checked. `:440-470` obtains the native session without cookie caching and validates its subject, current account, epoch, client and scope before building the session proof. `:1941-1992` implements sign-in through password verification or Better Auth email sign-in.

`services/auth/test/workflows.test.ts:356-382` proves controlled person signup succeeds while arbitrary account authority and raw Better Auth signup are rejected. `services/auth/test/foundation.test.ts:124-150` proves a person's persisted Better Auth credential and session. `:211-234` proves an automated actor can sign in with its own real credential and a credentialless one cannot. `specs/account-authorization-outcomes.test.ts:177-204` proves automated session issuance denies a different or absent credential, permits an exact operator opening, consumes it once, and rejects stale or mismatched openings; `services/kernel/test/access/account-authorization-outcome.test.ts:5-11` binds that outcome suite to the real Auth/Access driver.

### 3. One permission formula and independent operand denials

**Verdict:** partly proven.

**Evidence:** The request authorization path is centralized in `services/kernel/src/access/permission.ts:161-228`; it checks the authenticated action scope at `:193-195,211-228`. `services/kernel/src/access/permission-check.sql:63-75` requires the actor grant and, when present, the principal grant, with current membership and denial checks. Auth binds issued scopes to a registered client's scopes and current consent in `services/auth/src/service.ts:279-299`. `services/kernel/test/access/delegated-auth.test.ts:324-346` begins with permission, then removes the principal grant (`:331-337`), removes the actor grant (`:339-344`), and finally issues a client session without the action scope (`:345-346`); each removal denies on its own. Auth consent/session outcome coverage is also in `services/auth/test/foundation.test.ts:252-279`.

**Missing and smallest closure:** operation discovery uses a second grant evaluator instead of Access's supported formula: `services/kernel/src/access/gates/held-gates.sql:22-80` independently evaluates actor and principal gate grants, role grants and denials; `services/kernel/src/access/gates/visibility.ts:102-130` calls it, while `:147-159` filters discovered operations only by public exposure or the held group. A viewer holding a group's gate can therefore see an operation whose own `x-action` scope or grant they lack. Route this discovery decision through the canonical Access formula and add one outcome case where a viewer has the group gate but lacks a mounted operation's action scope/grant; assert that both `visibleOperations` and generated OpenAPI omit it. This also resolves the duplicate-formula finding under “Other findings.”

### 4. Kernel verification of Auth sessions through the shared contract

**Verdict:** proven.

**Evidence:** `packages/auth-contract/src/index.ts:139-145,305-312,579-584` defines the session authorization input, `SessionProof`, and Auth session port used at the boundary. `services/kernel/src/access/authenticate.ts:181-226` verifies Auth's ES256 JWT issuer, audience, type and required claims, then checks the account anchor, state, fence and authentication floor; `:227-254` resolves an optional principal assignment and constructs the kernel actor. `services/kernel/src/access/auth-session-capability.ts:37-50,66-80` consumes the shared Auth port to obtain the token used for kernel authentication. The cross-Goal contract decision is recorded in `.temp/ref/accounts-brief.md:42`.

`services/kernel/test/access/auth-session-capability.test.ts:40-45,102-108` issues an Auth token through the shared port and authenticates it through the real kernel Access verifier. `services/kernel/test/access/auth-bindings-contract.test.ts:61-99` checks the shared session/binding boundary, account kinds and denial behavior.

### 5. Exposure metadata on every route and construction-time rejection

**Verdict:** partly proven.

**Evidence:** `services/kernel/src/access/gates/declaration.ts:6-20` accepts only `public` or a valid `gate:<group>`. `services/kernel/src/http/kernel.ts:374-397` validates route metadata during construction. Existing hidden routes also declare exposure (`services/kernel/src/http/app.ts:268`; `services/kernel/src/commerce/webhook-routes.ts:43-49`). `specs/platform-gates-outcomes.test.ts:132-150` proves invalid exposure is rejected for fixture routes, and `:152-160` checks declarations on production routes that are not hidden.

**Missing and smallest closure:** `services/kernel/src/http/kernel.ts:392-396` skips `parseExposure` before checking a route with `hide: true`. Kernel construction therefore accepts a hidden route without `x-exposure`, and the production-route test filters hidden routes at `specs/platform-gates-outcomes.test.ts:152-160`. Validate metadata before the hidden-route branch and add a constructor outcome case with a hidden route missing the field.

### 6. Typed closed-operation denial and gate admission

**Verdict:** proven.

**Evidence:** `services/kernel/src/access/gates/admission.ts:15-43` reads exposure state and, while closed, authorizes `gate:<group>` or `gate:any` on `GLOBAL_CONTEXT`; anonymous callers receive the same closed error. `services/kernel/src/http/app.ts:115-130` renders that as the typed 403 `platform_closed` response. `specs/platform-gates-outcomes.test.ts:164-185` compares anonymous and ordinary-account denials and proves no domain read occurs, then proves a gated tester and platform staff succeed. `:188-215` exercises actor and principal grants on Global Context and their revocation; `:217-246` proves platform staff can use every closed group. The final gate contract uses `gate:<group>`/`gate:any` (`.temp/ref/accounts-brief.md:92`), not the earlier provisional spelling at `:86`.

### 7. Ordinary grant/revoke commands and delegation ceiling

**Verdict:** proven.

**Evidence:** `services/kernel/src/access/routes.ts:349-355,1141-1194` mounts grant creation, change and revoke through the ordinary routes, marked with `access:grant`. `services/kernel/src/access/grant-commands.ts:89-100` includes the management action and every new/previous action in authorization; `services/kernel/src/access/grant-command.ts:89-120` checks those actions through Access and allows `gate:any` to cover only `gate:<group>` administration on the Global Context. `services/kernel/test/access/gates/granting.test.ts:255-292` proves `access:grant` alone cannot grant a gate, gate authority cannot exceed the grantor's held actions, and `gate:any` covers the groups while remaining exact itself. `:294-327` proves revocation through `/v1/grants:revoke`. `specs/platform-gates-outcomes.test.ts:217-246` proves one staff `gate:any` permission works across closed groups and can grant a group gate to another account.

### 8. Viewer-filtered OpenAPI and visible operations

**Verdict:** partly proven.

**Evidence:** `services/kernel/src/access/gates/openapi-route.ts:35-49,78-95` projects generated OpenAPI paths from `visibleOperations` for the current viewer. `services/kernel/src/access/gates/visibility.ts:147-159` supplies the visible-operation list. `specs/platform-gates-outcomes.test.ts:285-317` proves public operations remain visible and closed-group operations are omitted for anonymous/ordinary viewers, then proves group-gated and staff visibility.

**Missing and smallest closure:** the implementation filters by exposure only: `services/kernel/src/access/gates/visibility.ts:151-158` does not check the operation's action through Access. The current test fixture does not include a viewer who passes the exposure gate but lacks a specific operation's action scope/grant (`specs/platform-gates-outcomes.test.ts:285-317`). Add that fixture and use the canonical formula to filter by operation action before projecting both OpenAPI and visible operations. This is the same concrete gap described under section 3.

### 9. Public opening changes catalogue data

**Verdict:** proven.

**Evidence:** `services/kernel/src/access/gates/catalogue.ts:33-59` reads the time-indexed exposure catalogue; `:70-129` commits open/close commands against it. `services/kernel/src/access/gates/routes.ts:53-73,75-110` exposes the public open/close routes and calls those catalogue commands. `specs/platform-gates-outcomes.test.ts:263-283` opens and closes a group, proves exposure state changes, and asserts the route path and `x-exposure` metadata stay unchanged while public access follows the catalogue state.

## Other findings

- **Second permission evaluator.** `services/kernel/src/access/gates/held-gates.sql:22-80` evaluates gate grants separately from `services/kernel/src/access/permission-check.sql:46-75`; `services/kernel/src/access/gates/visibility.ts:102-130` uses the separate query. This breaks the “one formula, no copies” decision in `.temp/ref/accounts-brief.md:119` and is the visibility gap described in sections 3 and 8.
- **Access SQL in the Web recording script.** `apps/web/scripts/record.ts:479-494,861-869,1049-1058` directly inserts or updates `access.account` and `access.resource_grant`; `apps/web/package.json:5-10` exposes it as `bun run record`. The script is a recording/fixture tool, not a runtime route, but it writes Access-owned data outside Access and conflicts with the decision that modules never write Access SQL (`.temp/ref/accounts-brief.md:52`).
- **Barrier read outage becomes an authentication denial.** `services/kernel/src/access/auth-barriers.ts:163-168` catches every `lifecycle.confirmBarrier` failure and returns `false`; `services/kernel/src/access/lifecycle.ts:441-464` can throw while acquiring a connection or reading the receipt; `services/auth/src/service.ts:581-590` turns `false` into `Denied`. The test at `services/auth/test/barrier-confirmation.test.ts:9-89` covers a genuine negative receipt only, not a rejected/unavailable read. This contradicts `.temp/ref/accounts-brief.md:115` and its 503 rule at `:114`; the smallest closing test makes `confirmBarrier` reject with a classified outage and asserts a retryable 503 with no barrier effect, then preserves `false` as a denial.
- **Session establishment also collapses failures into 401.** `services/auth/src/service.ts:398-423` wraps the current account and consent/client reads (`:224-238,279-299`) in a catch-all and emits Better Auth `UNAUTHORIZED`. A classified database/deadline failure from those reads is therefore indistinguishable from invalid credentials, contrary to `.temp/ref/accounts-brief.md:114-115`. Add an injected unavailable-read outcome test and preserve the 503 classification through the Better Auth hook while retaining 401 for actual denials.
