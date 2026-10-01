# Account service

Account owns private users, credentials, sessions, email recovery and
OAuth/OIDC. These are separate from public Agents and Access authority.
[Account source](../../services/account/src/auth.ts) and [owner tests](../../services/account/tests/)
carry endpoint and lifecycle contracts; see [recorded qualification](../plan/README.md#current-state).

Main verifies issuer, audience, signature and current Account introspection
for protected requests. Account fences the current key, installation, consent,
recovery, account and user/client grant generations. Access separately checks
the selected acting Agent and its current authority.

## Birth date and content preferences

Implemented on 2026-10-01: registration does not
require a birth date. A feature that needs age requests it in context and returns
to the initiating action. Account stores a complete calendar date (`YYYY-MM-DD`),
as self-declared information, and the person's independent category preferences. Age is calculated from the date at the required threshold; a
stored integer age cannot remain accurate. UTC birthdays and March 1 anniversaries for February 29 in non-leap years have
owner tests. This declaration does not establish stronger age assurance.

General defaults on without an age check. R15 defaults on once eligible age is
known unless the person has explicitly disabled it. R18 and R18G default off,
with separate opt-ins. A missing birthday is requested when a restricted
category is enabled; cancelling changes neither the date nor the preference.
Birthday corrections cannot erase explicit choices or grant a category for
which the corrected age is ineligible. Registration minimums still apply when
age becomes known, independently of the content switches.
These categories have one Account owner; Main's Person preferences store
profile, following, reading languages and spoiler choices rather than another
adult-content switch.

Account supplies Main only the current age band, country, account and adult
eligibility, and category preferences through `rezics_content_evidence` on live
introspection. Signed JWTs carry neither this changing decision nor the date. Its raw birth date is excluded from
ordinary tokens, public account reads, application consent and analytics.
Only Main's configured confidential introspection credential receives these
derived preferences; another authenticated OAuth client receives no age or
category metadata. Workload credentials receive no person's content evidence.
The date defaults private. The person may explicitly publish the complete date
on an opaque, shareable Account birthday page and withdraw that publication; a private change
does not publish it, and age checks do not depend on publication. Public reads
use `no-store`; the birthday page disallows indexing. Turning publication off
invalidates its identifier; publishing again creates a new link. No public
Account identity, name or email is returned with the date. Account
takeout includes the date and preferences, and erasure removes them under the
existing preservation and recovery boundaries.

The current Account endpoints and revision handling live in
[content preferences](../../services/account/src/content-preferences.ts) and their
[integration tests](../../services/account/tests/content-preferences.integration.test.ts).
Concurrent writes require the current revision; omitted fields preserve intent.
A known age below the registration minimum atomically holds the account and
revokes sessions through the existing security generation. Takeout and recovery
coverage include the new records.

These settings extend the common Account/API contract directly. There are no
production accounts or production records to convert: use one current contract
and recreate disposable development fixtures when its storage shape changes.
Policy re-acceptance after a future material update and recovery of deleted
subjects are ordinary lifecycle responsibilities, independent of schema
compatibility. OAuth authorization always checks the current acceptance receipts.

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
