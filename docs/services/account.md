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

The authorization-code guard holds its advisory-lock connection from a small
pool of its own (four connections by default, five-second connect wait). The
provider exchange it protects draws on the owner pool, so guards taken from that
pool would starve every exchange once concurrent codes reached its size. Excess
exchanges now answer `503 temporarily_unavailable` without consuming their code;
the [code-guard fixture](../../tests/qa/integration/account-boundary-code-guard.test.ts)
drives twelve exchanges through a three-connection owner pool.

### App installations

An installation admits one registered App (OAuth client) to request tokens up
to an explicit scope ceiling ([migration 005](../../services/account/migrations/005_oauth_installations.sql)).
Operator registration installs the client at its declared user and
client-credential scopes. A later App update, including an owner's
`/oauth2/update-client` scope change, alters the registration only: an
authorization request beyond the installed ceiling fails with `invalid_scope`
before consent is recorded, and token issuance checks the same ceiling. Every
access token carries the signed `rezics_installation_id` of the installation
that admitted it; authorization codes and refresh families keep the
installation current at their first issuance, and each refresh write
share-locks it. Workload (`client_credentials`) tokens are scoped the same way.

An operator reads `GET /api/account/installations/{clientId}` and changes it
through `POST /api/account/installation-changes`, from Account's own origin with
an operator session. `{ "change": "revoke", "installationId" }` is terminal and
idempotent: every token of that installation is inactive at the next
introspection, its refresh families and pending codes fail, new authorizations
return `unauthorized_client`, and the user's consent and other Apps are
untouched. `{ "change": "install", "clientId", "scopes", "changeKey" }` creates a
new installation identity inside the App's current registration and never
replaces an active one, so changing a ceiling is revoke then install and every
family re-authorizes; the change key replays an exact retry and rejects a
different intent. A revoked installation's tokens never regain access through
refresh or reinstallation. Each change is O(1) indexed statements, and
introspection reads the installation by primary key regardless of history.

Tokens carry no Agent. A request selects its acting Agent explicitly and Main
evaluates it against current Access; a refresh neither carries a previous
selection forward nor restores a withdrawn representation. App-pinned Agent
selection through a consent reference is not part of this profile.

### Signing-key generations

Account owns the JWT signing-key lifecycle ([migration 004](../../services/account/migrations/004_signing_key_generations.sql)).
The pinned JWT plugin keeps key material in `jwks`; its custom keyring adapter
shows it only live generations. A **staged** key is published in JWKS but never
signs. Exactly one **active** key signs. Activating a staged key makes the
previous key **retiring**: it stops signing, its private material is destroyed,
and it verifies only the tokens it could have signed, until the 300-second
access-token lifetime plus a five-second in-flight allowance has passed. A
**retired** key is neither published nor accepted. Account introspection checks
the token's key generation and that its `iat` lies in that key's signing window,
and both Account and Main reject resource tokens issued more than five seconds
in the future or with an expiry beyond 300 seconds from issuance,
so a retired key's token is inactive at once even while the provider's or Main's
300-second JWKS cache still holds the key. Main's verifier refetches JWKS when a
token names an unseen key.

Operators rotate with the root procedure, using the Account runtime environment:

```sh
bun services/account/src/signing-keys-cli.ts status
bun services/account/src/signing-keys-cli.ts stage
bun services/account/src/signing-keys-cli.ts activate   # after 300 s of publication
bun services/account/src/signing-keys-cli.ts retire <kid>
```

`activate` refuses a key published for less than 300 seconds unless a shorter
minimum is given. `retire` takes a staged, retiring or active key out of use at
once; retiring the active key requires a staged successor, which starts signing
immediately. Output never contains key material. Browser sessions and refresh
families are not signed by these keys and continue across rotation; clients
refresh or mint once after a compromise retirement. ID tokens are verified by
clients at receipt and are not accepted by Main; one signed by a retired key no
longer verifies against JWKS. Restoring an Account backup older than a
compromise retirement restores that key, so the retirement must be reapplied
before the restored Account serves. The [rotation fixture](../../tests/qa/fault-recovery/account-key-rotation.test.ts)
stages, activates, expires and retires keys while session and workload clients
run against Main, and checks audience, expiry, pre-activation and staged-key
forgeries made with real key material.

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
engine to store passwords or serve login. Main reaches Account only through the
issuer's public JWKS and introspection endpoints with its own client credential;
no Main owner role can read Account's database. Each Main exchange with Account
is bounded (three seconds by default), so a partitioned Account fails protected
admission closed with `503 dependency_unavailable` while public Main routes and
readiness keep serving, and the same process admits again after the partition
heals. A refused Main credential, an Account error or a redirect is likewise
unavailable, never an allow or a denial of the presented token. Account's
readiness reports its own database loss within two seconds. Account observes idle
PostgreSQL connection errors so a network cut does not terminate the process;
the authorization-code guard keeps an explicit database password when it opens
its separate bounded pool. The
[remote placement fixture](../../tests/qa/fault-recovery/account-key-remote-placement.test.ts)
puts Account behind a Docker-network hop and its database behind another,
partitions each, and rotates Main's credential. Test SSO across products, tab isolation,
CSRF/redirect/issuer rejection, concurrent linking, key rotation, logout/revocation,
recovery and partial provisioning. Sources:
[Elysia integration](https://better-auth.com/docs/integrations/elysia),
[OIDC provider](https://better-auth.com/docs/plugins/oauth-provider),
[OAuth BCP](https://www.rfc-editor.org/rfc/rfc9700.html).
