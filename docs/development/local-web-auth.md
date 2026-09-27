# Disposable local web authorization

Use this fixture only with a new QA Compose project. It registers an actual
operator-managed public OAuth client requiring authorization-code PKCE, creates a
member Account user, and grants that member's acting Agent `work.create` through
Access. It also registers a confidential Main introspection client. Account's
operator-only registration and Main's token verification remain in force.

The pinned OAuth provider requires web clients to use HTTPS callbacks on a
non-loopback host. For this disposable localhost exercise, the public client is
registered as **native** with exact HTTP loopback callbacks. The local browser
uses PKCE and receives no client secret. Production browser deployments need a
separate `application_type: web` client on a real HTTPS origin; this fixture is
not that production registration.

From the repository root, with the pinned toolchain installed:

```sh
task stack:up -- --profile qa --run-id web-demo
bun scripts/dev/web-auth-bootstrap.ts --run-id web-demo \
  --redirect-uri http://localhost:3000/auth/callback \
  --redirect-uri http://127.0.0.1:3003/auth/callback
```

Each callback must be an exact `http://localhost:<port>/...` or
`http://127.0.0.1:<port>/...` URL with no query or fragment. The command uses the
existing QA owner/graph bootstrap on a fresh project, or verifies that a
previously initialized project has the same graph epoch. It refuses an absent,
partly initialized or previously attempted project. The project directory under
`.temp/stack/rezics-qa-web-demo/` is private and disposable.

The command prints paths to these files under that project's `web-auth/`
directory; all have mode `0600`:

| File | Use |
| --- | --- |
| `public.json` | OAuth issuer, authorization/token endpoints, resource, public client ID, exact callbacks, scopes, acting subject and Main URL for the local web app. It contains no client secret. |
| `private.json` | Generated operator/member sign-in credentials and registered Main introspection credentials. Keep it out of the browser and Git. |
| `runtime.env` | Complete QA process environment with the registered Main client ID/secret and operator ID replacing the generated placeholders in `apps.env`. Start both host Account and Main using this file. |

For separate Account and Main terminals, source `runtime.env` in each before
starting the service:

```sh
set -a
. .temp/stack/rezics-qa-web-demo/web-auth/runtime.env
set +a
bun services/account/src/index.ts
# In another terminal with the same environment:
bun services/main/src/index.ts
```

The client is registered with the main site's scopes
(`apps/web/features/auth/scopes.ts`) and the refresh-token grant; registration
is its installation ceiling. When those change, `task dev:prepare` (and so
`task dev`) registers a replacement client for an existing stack and points
`public.json` at it. The web session layer in `apps/web/features/auth/` owns the
PKCE sign-in, refresh and sign-out; see its code for the details. A direct API
caller sends the bearer token to `POST /v1/works` with a unique
`Idempotency-Key`, `profile: "metadata-only-v1"`, a title, and `actingSubject`
from `public.json`. The generated representation and grant expire after eight
hours; resource access tokens expire after five minutes and the web app
refreshes them. Create a new QA project after the grant expires.

`task dev -- --profile qa --run-id <id>` creates or loads this fixture and launches
Account, Main, the Accounts app and the web development app with its registered
credentials.

Wherever `task dev` runs, the Accounts app (`apps/accounts`) is the public
Account origin: `ACCOUNT_BASE_URL`, the OAuth issuer and the web app's
`ACCOUNT_ORIGIN` point at it (port 3004 in the main checkout, the stack's own
`ACCOUNTS_PORT` in a worktree backend), and it proxies the service's
`/api/auth`, `/api/account`, `/oauth2` and `/.well-known` paths so the session
cookie stays on its origin. Main still reads JWKS and introspection from the
service. QA tier stacks run the service alone and keep it as the public origin.
Access principals are bound to the issuer, so when a stack's issuer moves,
`task dev` keeps the old fixture as `web-auth.retired-<time>` and registers a
new one; principals created under the old issuer no longer match.
The built-Worker QA tier uses the same fixture in its own isolated stack. The
integration test proves the registered PKCE client can issue a member token and
that Main accepts it for a
real Work command using the Access grant; it does not certify the browser UI.

When finished, stop the host processes and remove the disposable project.
`stack:reset` removes containers and volumes but retains private configuration;
delete that directory too to discard generated passwords and client secrets:

```sh
task stack:reset -- --profile qa --run-id web-demo
rm -r .temp/stack/rezics-qa-web-demo
```
