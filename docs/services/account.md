# Account service

Account owns private users, credentials, sessions, email recovery and
OAuth/OIDC. These are separate from public Agents and Access authority.
[Account source](../../services/account/src/auth.ts) and [owner tests](../../services/account/tests/)
carry endpoint and lifecycle contracts; see [recorded qualification](../plan/README.md#current-state).

Main verifies issuer, audience, signature and current Account introspection
for protected requests. Account fences the current key, installation, consent,
recovery, account and user/client grant generations. Access separately checks
the selected acting Agent and its current authority.

## App installations

An installation's scope ceiling is independent of client registration and
user consent. Change a ceiling by revoking and reinstalling; withdrawal of one
user's consent does not revoke the installation. See
[installation admission](../../services/account/src/installations.ts),
[consent admission](../../services/account/src/consent-fence.ts) and the
[connected-app decision](../contracts/connected-apps.md).

## Signing-key operations

Use the Account runtime environment for
[the rotation CLI](../../services/account/src/signing-keys-cli.ts):

```sh
bun services/account/src/signing-keys-cli.ts status
bun services/account/src/signing-keys-cli.ts stage
bun services/account/src/signing-keys-cli.ts activate
bun services/account/src/signing-keys-cli.ts retire <kid>
```

Publish a staged key for 300 seconds before normal activation. Emergency
retirement of an active key requires a staged successor. Reapply a compromise
retirement before routing a backup restored from before it.

## Registration abuse protection

Sign-up, password-reset and verification-email requests pass a server-verified
Cloudflare Turnstile challenge (action `account-enrollment`, hostname of
`ACCOUNT_BASE_URL`) before any account or email effect. Turnstile is abuse
admission, not authentication or proof of ownership. For production set
`ACCOUNT_TURNSTILE_MODE=cloudflare` on the service and Accounts site, configure
`ACCOUNT_TURNSTILE_SECRET_KEY` (service only) and `ACCOUNT_TURNSTILE_SITE_KEY`,
and register the public hostname with Cloudflare; a missing site key disables
the widget and logs the problem. Local stacks use `ACCOUNT_TURNSTILE_MODE=local`,
an always-pass verifier that Account refuses in production. Check live provider
reachability when provisioning the widget; it is not needed for local seeding
or tests.

## Operations

[Account startup and recovery](../../services/account/README.md),
[email rollout](../operations/deployment.md#email-rollout) and the
[recovery runbook](../operations/recovery.md) describe the operational
entry points. The Account origin proxy must preserve cookies, Origin and all
Set-Cookie headers, and set the client IP header from a trusted connection.
Account remains on loopback; public Main routes do not require it.
