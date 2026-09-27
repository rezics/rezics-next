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

Stop the AppHost with `task dev:stop -- --profile qa --run-id web-demo` (add
`--backend` in a worktree). To discard the project and its credentials, run
`task stack:reset -- --profile qa --run-id web-demo`, then remove
`.temp/stack/rezics-qa-web-demo/`.
