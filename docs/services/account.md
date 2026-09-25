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

The Main resource also exposes five source-staging scopes: `source:intake`,
`source:acquire`, `source:convert`, `source:propose` and `source:read`. Main checks the current
Account assertion and Access principal state for each operation; these scopes
do not authorize adopting a source fact into a native Work.

The first executable [Account service](../../services/account/README.md) now
binds Better Auth 1.7.5, Elysia 2.0.0-beta.16 and PostgreSQL. Its local
integration test covers a signed resource token, authorization code with PKCE,
Main-side JWKS/introspection and sign-out denial. Broader obligations below
remain pending.

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
