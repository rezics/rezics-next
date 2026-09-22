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
