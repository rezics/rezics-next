# Account service

## Responsibilities and stack

Account owns private identities, sign-in methods, sessions, email recovery and
OAuth/OIDC. Better Auth users are not public Persons or Agents; Main and Access
own those identities and their authority. The pinned Elysia/Better Auth versions
are in the [toolchain](../development/toolchain.md). The implementation and
executable contracts live in [services/account](../../services/account/README.md).

Main verifies issuer, audience, signature and **current introspection on every
protected request**. Account checks signing-key, installation, consent, recovery,
account and user/client grant generations. Suspension, password reset and app
withdrawal therefore stop already-issued Main tokens, including trusted-client
tokens. Expiry, unsuspension and re-consent never revive older generations.

The provider consumes authorization codes before validating every presenter.
[The code guard](../../services/account/src/oauth-code-guard.ts) serializes a code
and restores its exact original basis after a rejected exchange. It has a
separate bounded connection pool: sharing the provider pool would starve exchanges
when all connections were held by guards. A failed restoration leaves the code
consumed and requires a new authorization flow.

### App installations

An installation admits a client up to an explicit scope ceiling. Registration
changes do not silently widen that ceiling; changing it is revoke then install.
Installation revocation is terminal and affects workload and user tokens. User
app withdrawal is separate: it revokes only that user's consent, refresh tokens
and grant generation. [Connected apps](../contracts/connected-apps.md) records the
reason for the product fence around the pinned provider.

Tokens carry no selected Agent. Each Main request selects its acting Agent;
Access evaluates current representation and grants independently of OAuth scope.

### Signing-key generations

A staged key is published without signing. Activating it stops the previous key
signing and destroys that key's private material. A retiring key verifies only
its bounded issuance window; a retired key is denied even if a client's JWKS
cache still contains it. Access tokens last five minutes, with a five-second
signing allowance around rotation. These rules are executable in
[signing-keys.ts](../../services/account/src/signing-keys.ts).

Use the Account runtime environment for rotation:

```sh
bun services/account/src/signing-keys-cli.ts status
bun services/account/src/signing-keys-cli.ts stage
bun services/account/src/signing-keys-cli.ts activate
bun services/account/src/signing-keys-cli.ts retire <kid>
```

Publish a staged key for 300 seconds before normal activation. Emergency
retirement of an active key requires a staged successor. Session and refresh
credentials are independent of signing keys. Reapply any compromise retirement
before routing a restored backup that predates it.

## Browser and client flow

The Accounts site owns the Account origin and proxies the authentication/API
paths without exposing provider or SMTP secrets. Preserve cookies, `Origin` and
all `Set-Cookie` headers. Strip incoming `x-rezics-client-ip` and set it from a
trusted connection before forwarding; Account uses it for coarse network labels.
Without it, location is unknown. An IP prefix is not a claimed city or country.

Import `AccountApp` **as a type** from `@rezics/account/app` for Eden.
Validated request and response schemas are in the route modules and
[views.ts](../../services/account/src/views.ts); stable Account error codes are
in [http.ts](../../services/account/src/http.ts). Collections use `items` and
`nextCursor`, default 25 and maximum 100, with cursors bound to the user and
filters. Directory search is case-insensitive prefix search over email, name and
ID. Created-date ranges include their lower bound and exclude their upper bound.
`GET /api/account/openapi.json` emits these contracts. Better Auth's separate
schema is at `/api/auth/open-api/generate-schema`.

Use Better Auth's `createAuthClient` with `passkeyClient` from
`@better-auth/passkey/client`, `twoFactorClient` from `better-auth/client/plugins`
and `oauthProviderClient` from `@better-auth/oauth-provider/client`, all on the
pinned 1.7.5 line. The provider owns WebAuthn/TOTP ceremonies, passwords, email
verification and session cookies. The Account HTTP boundary adds product policy:

- Signup acknowledges with `{status: true}` for existing and new addresses;
  it does not sign in until email verification. Reset and verification requests
  avoid public address enumeration and have an atomic per-address budget.
- `/api/account/consent` reads a signed `oauth_query` and accepts or denies it.
  Display its verified client, bilingual scope descriptions and resources.
  A decision is single-use and session-bound. A stale/interrupted decision starts
  a new authorization flow. The old provider `update-consent` path accepts this
  signed decision contract; raw grant editing remains denied.
- `/api/account/methods` summarizes password, passkeys and the TOTP authenticator.
  Password/passkey removal cannot remove the last primary method. TOTP and backup
  codes are second factors. Passkeys must verify the user on the authenticator.
- Sensitive changes require authentication within five minutes. Password users
  can use `/api/account/reauthenticate` (including TOTP when enabled); passkey
  users sign in again with their passkey. `step_up_required` means preserve the
  draft while completing that step. TOTP names use `/methods/totp/name`.
- `/security-activity`, `/sessions` and `/connected-apps` under `/api/account`
  expose private security state without credential material. Session revocation
  accepts one `sessionId` or `{others: true}`. App revocation uses its client ID.
  Last-use time means successful resource introspection, recorded at most once
  per minute; null means it has not been observed.

Product callbacks still must consume their own session-bound `state`, compare
`iss`, keep a fresh secret PKCE verifier, and protect codes/tokens from logs and
referrers. Account's presence check for `state` cannot establish those client
properties. See [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) and
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3).

## Lifecycle and integration

Operator roles and their typed permission table live in
[operators.ts](../../services/account/src/operators.ts). `ACCOUNT_OPERATOR_USER_IDS`
is only a one-time first-owner bootstrap source; restarting never restores a
removed role. Owners manage roles, admins manage accounts/clients, and support
can inspect accounts, revoke sessions, resend verification and add notes.
Support/admin cannot mutate an operator account. The last available owner cannot
be removed, suspended or forced into password reset. There is no impersonation.

The `/api/account/admin` routes provide `me`, directory/user detail, clients and
audit reads. User actions require a reason and a client-generated UUID `commandId`;
retry the same command ID and body after a lost response. A changed body conflicts.
Notes are operator-only. User detail includes bounded previews; sessions, apps
and security activity also have paginated subresources.

OAuth client mutation endpoints keep the Better Auth client contract and require
`x-account-reason`. Their journal appends an intent before the provider write and
an outcome afterwards; an intent without an outcome is **uncertain**, never a
successful action. Account-owned administrative changes, notes, queued verification
messages and their audit/command receipt commit together. Audit and security
history reject updates/deletes. Audit entries never retain client secrets or
credential material.

Account deletion first fences Access and retains its relay tombstone. Only then
may the provider remove the final credential. Failed deletion remains fenced and
needs retry/reconciliation. Recovery manifests include every Account table,
including methods, role/audit history and revocation generations; older manifests
must be recaptured after this schema migration. Retain the current deletion and
revocation frontier before restoring or routing Account.

## Deployment and acceptance

[Email delivery](../email-delivery.md) owns SMTP setup and uncertain sends. The
HTTP process always requires verification and constructs a sender. Embedded
protocol fixtures can omit a sender; that fixture mode is not the deployed HTTP
configuration. A frontend fixture that creates users without email must explicitly
mark its test identities verified before signing into the deployed process.

Account listens on loopback behind its origin proxy and does not need the graph
engine for sign-in. Main's bounded JWKS/introspection calls fail closed when
Account is unavailable. Public Main routes remain independent. The Account
integration suite exercises SMTP, consent, real Chromium WebAuthn, TOTP, sessions,
revocation, operators and physical PostgreSQL recovery. This establishes backend
behavior; the Accounts app still needs its own browser-flow qualification.

Primary references checked against the installed 1.7.5 source in September 2026:
[password/email](https://better-auth.com/docs/authentication/email-password),
[passkeys](https://better-auth.com/docs/plugins/passkey),
[TOTP](https://better-auth.com/docs/plugins/2fa),
[OAuth provider](https://better-auth.com/docs/plugins/oauth-provider) and
[OAuth BCP](https://www.rfc-editor.org/rfc/rfc9700.html).
The rolling OAuth docs describe a query verifier that 1.7.5 does not export;
our small version-bound adapter is checked against actual provider redirects.
