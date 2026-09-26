# Account service

## Responsibilities and stack

Use TypeScript/Bun, Elysia 2.0 and Better Auth for private accounts, login methods,
sessions, credential recovery and OAuth/OIDC. Keep framework adapters thin and
pin qualified versions. Better Auth's user is not a public Person/Agent; its
organization plugin does not define REZICS Realm/Org authority.

Follow Main's [runtime baseline](main.md#runtime-and-framework) and the shared
Yarn workspace policy. Mount Better Auth through its Fetch handler; its examples
may use Elysia 1 syntax and must be adapted to the pinned 2.0 API. Account's
OAuth/OIDC, cookie and recovery flows need their own integration qualification;
framework handler compatibility alone does not establish them.

The Main resource also exposes six source scopes: `source:intake`,
`source:acquire`, `source:convert`, `source:propose`, `source:adopt` and `source:read`. Main checks the current
Account assertion and Access principal state for each operation; these scopes
do not replace the separate `work:create` scope and Access admission required
to create a native Work from a source proposal.

The first executable [Account service](../../services/account/README.md) now
binds Better Auth 1.7.5, Elysia 2.0.0-beta.16 and PostgreSQL. Its local
integration test covers a signed resource token, authorization code with PKCE,
Main-side JWKS/introspection and sign-out denial. Broader obligations below
remain pending.

For the IAM02 backend boundary, Account requires one nonempty `state` in the
authorization request, checks the registered redirect and resource, and binds
the code to the client, redirect, resource and PKCE challenge. Main checks signed
issuer and audience plus current Account introspection.

Better Auth 1.7.5 consumes a pending code before it checks the presenting
client, redirect, resource, client authentication and PKCE verifier. Account's
token boundary serializes exchanges of one code across replicas with a
PostgreSQL advisory lock and snapshots the pending verification row. When the
provider issues no tokens, Account deletes any token rows that exchange wrote
and restores that exact row; [migration 002](../../services/account/migrations/002_restored_code_basis.sql)
keeps the code's issuance basis, so a restored code never rebinds to a later
consent generation. A wrong client, redirect, resource, client credential or
verifier therefore leaves the code redeemable once by its own client and leaves
sessions, consents, grants and refresh families unchanged. A replayed redeemed
code is rejected before the provider can delete the tokens it issued, and mints
nothing. If the restore itself fails, the code stays consumed and the client
authorizes again. The state precheck scans only the request query. The code
guard parses one request body and performs one advisory lock and one indexed
verification snapshot; a rejection adds two indexed token deletes, one basis
lookup and one row insert. None depends on account or token history.

The registered client owns these IAM02 concerns, which Account HTTP cannot
certify:

- binding `state` to its own login transaction and browser session, comparing
  it once at the callback and discarding it; Account sees only that one exists;
- comparing the callback `iss` with the expected issuer before the exchange
  ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html));
- generating a secret PKCE verifier per transaction, which makes an
  intercepted or injected code unusable by anyone else;
- registering a redirect that names the product and routing its callback only
  to that product. Native loopback redirects match any port
  ([RFC 8252 section 7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)),
  so a port does not separate two products; a path or host does;
- keeping codes and tokens out of logs, referrers and history, and checking
  token issuer and audience at every resource it calls.

The IAM02 probe drives two registered native products, each with its own
callback, transaction store and cookie, and swaps their client IDs, redirects,
verifiers, state and cookies. It proves Account's side and the reference client
pattern; it does not qualify every deployed product callback.

PostgreSQL stores private credential/protocol state. Public profiles, content and
representation grants remain with Main/Access. Store provider issuer/subject
bindings only after verified linking; email/name equality alone does not merge
accounts. Passkeys, federated login and recovery methods have explicit enrollment,
removal, assurance and last-method protection.

## Browser and client flow

Products use OIDC authorization code + PKCE and establish their own sessions.
Account uses Secure/HttpOnly host-only cookies with appropriate SameSite and CSRF
protection. Validate issuer, audience, redirect, state, nonce and token lifetime.
An Account session may avoid another password prompt but does not bypass consent
or step-up checks. Native/CLI clients use admitted redirects and protected tokens.

Request-selected Agent/authority context belongs to Access and is bound per tab/
request; changing it does not mutate every product session. Public responses expose
only consented claims and eligible Agent data. External subjects can be pairwise
or audience-scoped; private global account graphs remain undisclosed.

## Lifecycle and integration

Account creation, verified method linking, session creation/rotation, credential
revocation, enforcement and erasure are idempotent audited commands. Commit private
state/outbox together; publish minimal revocation/principal lifecycle events.
Access consumes current enforcement through a freshness/fence contract, not an
eventually delivered event alone for strict admission.

Recovery proves control under an explicit policy, protects remaining methods,
notifies eligible channels and invalidates compromised sessions/refresh paths.
Erasure fences identity immediately, then removes private material in bounded
steps without deleting shared Agents. Avoid user-enumeration in public errors.

## Deployment and acceptance

[Email delivery](../email-delivery.md) and [registration abuse protection](../turnstile.md)
define the corresponding provider-independent operational contracts.

Account may share the principal host or use the API/other host after origin,
network, latency, storage and failure assessment. It does not require the graph
engine to store passwords or serve login. Test SSO across products, tab isolation,
CSRF/redirect/issuer rejection, concurrent linking, key rotation, logout/revocation,
recovery and partial provisioning. Sources:
[Elysia integration](https://better-auth.com/docs/integrations/elysia),
[OIDC provider](https://better-auth.com/docs/plugins/oauth-provider),
[OAuth BCP](https://www.rfc-editor.org/rfc/rfc9700.html).
