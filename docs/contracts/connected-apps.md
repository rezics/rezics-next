# Connected applications, OAuth and MCP

An App is a declared integration identity; an OAuth client is a protocol
registration; an installation and a user's consent are separate authority
ceilings. Registration, ownership and endpoint reachability grant no Resource
rights. Account authenticates; Main and Access check the current selected
acting Agent for each protected operation. A token does not select an Agent.

The installed authorization-code profile uses exact redirects, PKCE, a
session-bound consent decision and live installation/consent introspection.
The [Account owner](../../services/account/src/auth.ts),
[installation fence](../../services/account/src/installations.ts),
[consent fence](../../services/account/src/consent-fence.ts),
[code guard](../../services/account/src/oauth-code-guard.ts) and
[Account integration tests](../../services/account/tests/consent-revocation.integration.test.ts)
carry its executable contract. The separate
[Main connected-app tests](../../tests/qa/integration/connected-app-api.test.ts)
cover observed MCP tool schemas, consent ceilings and bounded invocation.

The extra profiles below remain prospective; the current OAuth and MCP tests
do not qualify them:

- External consumers need purpose- and audience-scoped private subjects.
  Pairwise explicit-consent clients need a signed internal subject binding
  before Account can admit them.
- Capability revisions must bind actions, target scopes and egress
  destinations. Schema drift requires renewed validation and consent; input
  content cannot grant itself tools. Outbound requests need URL, redirect,
  private-address, size and timeout limits and must not forward REZICS tokens
  to unrelated providers.
- Webhooks need exact subscription scope, signed bounded envelopes,
  destination checks, current disclosure at delivery, idempotent retries
  and recovery of uncertain or dead-letter outcomes.
- Native clients and browser BFFs must store credentials securely and
  consume their own callback state, issuer and PKCE verifier.

The selected Better Auth 1.7.5 provider did not revoke refresh tokens when
consent was deleted. The product's separate generation fence is therefore
required. [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) is the
security basis; provider behavior is qualified against the selected build.

## First-party sessions and developer extras

Decision 8's first-party consequence and decision 33, 2026-09-29: the authority
model is the maintainer's; the product manager under that delegation deferred
developer extras. First-party REZICS shows no OAuth consent and appears in
Accounts as a product session. External apps still receive explicit, scoped
authorization. The reason is to distinguish signing into a REZICS product from
granting another application access; [Google's connection management](https://support.google.com/accounts/answer/13533235?hl=en)
is the product precedent, and RFC 9700 above remains the security basis.

GitHub-style developer settings, OAuth apps, Realm-level OAuth installations and
MCP management are non-core extras, sequenced after the shared authority model
(M7 in the production-readiness Goal). Their UI does not create a second grant
model; the [identity owner](identity-and-access.md#one-authority-model) owns it.
