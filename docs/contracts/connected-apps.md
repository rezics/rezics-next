# Connected applications, OAuth and MCP

## Scope and identities

An App is a declared software/integration identity; an OAuth client is a protocol
registration; an installation grants that App scoped operation; a user consent
delegates an explicitly selected authority context. Developer ownership, client
registration and endpoint reachability grant no Resource rights.

Account provides OAuth/OIDC. Use authorization code with PKCE, exact redirect
matching, state/nonce and audience/issuer validation. Product sessions are local
to their hosts; Account uses a host-only secure session cookie. Browser BFFs hold
refresh credentials where appropriate. Native clients use admitted redirects and
secure credential storage. Account login can avoid another password prompt while
consent or additional assurance remains explicit.

## Delegation and privacy

Tokens identify authenticated subject/session/client and the selected authority
context, not an unbounded list of Resource permissions. Verify current consent,
installation, representation, principal enforcement and ceilings at protected
admission. Do not trust an arbitrary client-provided Agent ID or change all browser
tabs by mutating one global acting-identity session field.

Use purpose/audience-scoped private subjects for external consumers. Public Agent
correlation does not disclose its controllers or other personas. The standard
OAuth `act` claim is an object with delegation semantics; use an explicitly named
private authority claim unless implementing RFC 8693 correctly.

## Lifecycle and capabilities

Capability revisions declare actions, target scopes, redirect/egress destinations
and executable effects. Installation or consent widening requires renewed approval;
an App update cannot silently widen an existing ceiling. Rotation, refresh, logout,
revocation and deletion have distinct scopes and durable audit. Token refresh never
resurrects a revoked basis. Workload principals are scoped to their installation.

REST, SDK and MCP operations share domain authorization. MCP metadata/tool schemas
are observed and versioned; schema drift requires validation before use. Input
content cannot grant itself tool access. Outbound requests enforce URL/redirect,
DNS/private-address, size and timeout policies and never forward REZICS-audience
tokens to unrelated providers.

### Explicit-consent refresh fence

The pinned `@better-auth/oauth-provider` 1.7.5 deletes only `oauthConsent` in
`/oauth2/delete-consent`; its refresh grant reads `oauthRefreshToken` without
rechecking consent (selected build files `dist/authorize-riRRCSbC.mjs` and
`dist/introspect-njKASm3q.mjs`). Before the fence, an isolated real HTTP test
on 2026-09-25 deleted consent, successfully refreshed the old token and passed
Main's Account assertion verifier with the new access token. The
[provider documentation](https://better-auth.com/docs/plugins/oauth-provider)
calls deletion revocation, but the selected build required a separate product
fence.

The first Account fence uses the durable `oauthConsent.id` and a database
generated revision UUID as the basis for one user, client and optional
reference. The pinned provider edits an existing consent row in place after
new consent and through `/oauth2/update-consent`; every row update advances
the revision, including narrowing and later widening. Account blocks the
direct update endpoint in this first profile because it permits scope widening
without the authorization/consent round trip. Users change consent through
that explicit flow or withdraw it through delete. The
[PostgreSQL migration](../../services/account/migrations/001_consent_refresh_fence.sql)
stores ID and revision on refresh tokens. Its insert/rotation trigger locks the
matching consent row, checks the current scope and resource ceiling, and
rejects an older family's revision after re-consent. Consent update or delete
takes the conflicting lock: a provider token write commits before the change
or waits and fails after it. A refresh split across adapter writes can produce
a token only before the change; [Account introspection](../../services/account/src/consent-fence.ts)
then checks the signed access token's consent ID, revision, subject, client,
scopes and audience against the current row, so an earlier token becomes
inactive after withdrawal or re-consent. Missing database evidence is
unavailable, not an allow.

The pinned provider stores authorization codes as hashed-identifier
`verification` rows and consumes them before minting tokens. An insert trigger
captures each code's consent ID and revision in a private code-basis row; the
claim contributor reads that exact basis from the token request's code, and
the first refresh insert checks it again. A code issued before an edit, delete
or re-consent cannot inherit the newer basis. Trusted `skip_consent` codes
carry a distinct mode and never borrow a consent row. The code-basis table is
included in Account recovery coverage, cascades on user/client deletion and
drains at most 128 expired rows on each new code issuance. The product pins
the provider's SHA-256/base64url code storage format for this binding.

This supported profile is explicit authorization-code consent with a
resource-bound JWT and a public subject. The pinned provider rewrites `sub`
for pairwise clients at introspection presentation, so explicit-consent
issuance rejects pairwise clients until Account has a signed internal subject
binding. Opaque user access tokens from explicit-consent clients
are inactive at Account introspection because the provider re-derives their
custom claims and cannot prove their issuance generation. `skip_consent` and
client-credentials clients have separate semantics and no consent row; app
installation and selected acting-Agent revocation remain future basis types.
The [Account HTTP integration fixture](../../services/account/tests/consent-revocation.integration.test.ts)
checks client, subject and scope isolation, old refresh rejection, in-place
narrow/widen re-consent, stale authorization-code exchange, deletion and a
refresh/delete race. It is queued for
the next central QA batch; source/type checks alone do not qualify IAM09. The broader
[RFC 9700 refresh-token guidance](https://www.rfc-editor.org/rfc/rfc9700.html)
remains the security basis.

## Delivery and recovery

Webhooks use exact subscription scope, signed bounded envelopes, destination
verification and current disclosure at delivery. Retry with idempotent IDs; expose
uncertain outcomes and dead-letter recovery. Suspension stops future admission
before asynchronous credential/queue cleanup. Lost responses, refresh races,
scope changes and recovery must preserve the selected authority context.

Basis: [OAuth security](https://www.rfc-editor.org/rfc/rfc9700.html),
[token exchange](https://www.rfc-editor.org/rfc/rfc8693.html) and
[Better Auth provider](https://better-auth.com/docs/plugins/oauth-provider).
Provider feature support must be qualified with the selected build and adapters.
