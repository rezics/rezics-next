# Disposable local web authorization

Use a fresh QA stack for a local OAuth PKCE browser journey. The fixture creates
a loopback public client, an Account member and an Access acting grant; it is
not a production browser registration. Production needs its own HTTPS web
client on the deployed origin.

From the main checkout, start a disposable project:

```sh
task dev -- --profile qa --run-id web-demo
```

In a worktree, use `task dev -- --backend --profile qa --run-id web-demo`.
`task urls` reports the Accounts app, Main and web addresses. The Accounts app
is the public Account origin; Main uses the Account service for verification.

The fixture lives in `.temp/stack/rezics-qa-web-demo/web-auth/`:

| File | Use |
| --- | --- |
| `public.json` | Browser OAuth settings, callbacks and acting subject. |
| `private.json` | Member/operator credentials and Main client secret; keep private. |
| `runtime.env` | Account and Main process environment for manual starts; keep private. |

`task dev` reuses a current fixture and loads its credentials. For a separate
process, source `runtime.env` in both Account and Main terminals. The bootstrap
script refuses partly initialized or already attempted projects; inspect the
private `web-auth-bootstrap.log` if owner/graph bootstrap fails, then reset the
QA project. A changed Account issuer retires the old fixture and creates a new one.

Local stack environment generation supplies explicit high Main class/family
budgets in `MAIN_RATE_LIMIT_BUDGETS` for seed, load and QA workloads. Production
defaults remain in the versioned rate-limit table. Override the JSON policy in
the saved Compose environment, or `.env.dev` for dev processes, to exercise
exhaustion. Library's separate daily source budgets use
`MAIN_READER_IMPORT_SEARCHES_PER_DAY` and
`MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY`; local stack configuration raises
these too. Runtime admission has no development/test bypass.

Enrollment uses the offline profile described in [Turnstile](../turnstile.md).
`task dev:seed` reads its local challenge proof from the prepared environment.
The web BFF replaces `x-rezics-client-ip` from `WEB_CLIENT_IP_HEADER` (Cloudflare's
`cf-connecting-ip` by default). The ingress must replace that source header, and
Main accepts the forwarded value only from an exact peer in
`MAIN_RATE_LIMIT_TRUSTED_PROXY_PEERS`. Local stacks trust loopback proxies;
production must configure its proxy peer addresses explicitly. Caller-supplied
X-Forwarded-For never selects a Main budget identity.

Main caches budget class attribution for a verified token's lifetime, bounded
to 300 seconds and 4096 entries. Owner authorization still checks live Account
and Access state. Each limited request performs one atomic counter operation.
Expired counters reset when their key is next used; a separate lifecycle worker
deletes at most 1000 expired rows per second using the expiry index. Anonymous
IPv6 identities share a /64, so rotating interface addresses cannot multiply
capacity. Report/appeal and provider intake use independent IP capacity without making Account verification a
prerequisite; their owning handlers retain intake or signature verification.

WebAuthn refuses IP addresses as relying-party IDs, so a loopback issuer names
passkeys for `localhost` (`passkeyRelyingParty` in
`services/account/src/account-settings.ts`): open the Accounts app at
`http://localhost:<port>` to use passkeys. A stack's Account email, such as
verification and reset links, goes to that stack's own Mailpit (`task urls`).

Stop the AppHost with `task dev:stop -- --profile qa --run-id web-demo` (add
`--backend` in a worktree). To discard the project and its credentials, run
`task stack:reset -- --profile qa --run-id web-demo`, then remove
`.temp/stack/rezics-qa-web-demo/`.
