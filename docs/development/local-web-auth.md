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
corepack yarn stack:up --profile qa --run-id web-demo
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

The web app must perform a fresh S256 PKCE challenge for each sign-in, request
`openid work:create` for the configured Main resource, exchange the code using
the public client ID and exact callback, and send the resulting bearer token to
`POST /v1/works` with a unique `Idempotency-Key`. The request body includes
`profile: "metadata-only-v1"`, a title, and `actingSubject` from `public.json`.
The generated representation and grant expire after eight hours; resource
access tokens expire after five minutes. Create a new QA project after expiry.

`yarn dev --profile qa --run-id <id>` creates or loads this fixture and launches
Account, Main and the web development app with its registered credentials.
The built-Worker QA tier uses the same fixture in its own isolated stack. The
integration test proves the registered PKCE client can issue a member token and
that Main accepts it for a
real Work command using the Access grant; it does not certify the browser UI.

When finished, stop the host processes and remove the disposable project.
`stack:reset` removes containers and volumes but retains private configuration;
delete that directory too to discard generated passwords and client secrets:

```sh
corepack yarn stack:reset --profile qa --run-id web-demo
rm -r .temp/stack/rezics-qa-web-demo
```
