Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

Every launch locale, including English, has a URL prefix.
Locale selection uses URL, `rezics_locale` cookie, `Accept-Language`, then English; language tags match exact locale, Chinese script or region, then base language.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`PUT /media/<id>` transports a reserved upload; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
Viewer credentials come from an explicit `Authorization` header, forwarded unchanged, or from the person's server-side
session. Access and refresh tokens stay in the Worker; the browser holds an opaque `__Host-rezics_session` cookie.
Only routes that use the credential resolve the session, currently `/media/`. Page requests do not contact the
session store or Auth. Media requests resolve before calling the kernel, so unreachable Auth returns 502 even
for downloads that otherwise conceal upstream errors. An explicit `Authorization` header skips session resolution.
Unsafe requests carrying that cookie require an `Origin` equal to the site's own origin.

Sign-in uses `GET /auth/sign-in?return_to=/ja`, followed by `GET /auth/callback`. Sign-out uses `POST /auth/sign-out`.
Login transactions expire after 10 minutes; sessions expire 30 days after sign-in. The `SESSIONS` Durable Object binding
stores both in SQLite, with one instance per login transaction or session. Development simulates the objects locally.

Configure these variables in the environment of `bun run dev`:

- `AUTH_ISSUER`: Auth's exact OpenID issuer identifier. HTTPS is required except for loopback development issuers
  (`127.0.0.1`, `localhost`, or `[::1]`).
- `API_RESOURCE`: the API's RFC 8707 resource identifier and access token audience, exactly `https://api.rezics.com`
  in production, with no trailing slash. Tests use `https://api.rezics.test`.
- `WEBSITE_SCOPES`: the space-separated API scopes registered for the website client, never a wildcard.
  Media routes need `media:create`, `media:read_reservation`, `media:read`, `media:complete` and `media:erase`;
  public reads need no scope. Sign-in requests `openid offline_access` followed by these scopes, each once.
- `WEBSITE_CLIENT_ID`: the confidential website client id, `rezics-website`.
- `WEBSITE_CLIENT_KEY`: a private P-256 JWK with a `kid`, used for ES256 client assertions. In production this is a
  Worker secret; supply it through Cloudflare's secret management, never through a config file or build output.
  `AUTH_ISSUER`, `API_RESOURCE`, `WEBSITE_SCOPES` and `WEBSITE_CLIENT_ID` are production Worker text variables.

Auth must register the website client's redirect URI `<site origin>/auth/callback`, its post-logout redirect URI
`<site origin>/`, and the `private_key_jwt` authentication method with the corresponding public key and `kid`.
Pass the same API scope list from `WEBSITE_SCOPES` to Auth's `registerWebsiteClient`.
Auth's discovery `scopes_supported` lists every available scope. The Worker sends `resource=API_RESOURCE` on the
authorization request, authorization code exchange and every refresh; revocation takes no resource. Client assertions
keep `AUTH_ISSUER` as their audience, and ID tokens keep the client id as theirs. Discovery supplies all Auth endpoints,
so connecting the Worker to Auth later requires configuration only. If any auth variable is missing, `/auth/` routes return 503
`dependency_unavailable`, session cookies confer no credential and are left intact, and the rest of the site keeps working.

Set `KERNEL_ORIGIN`, the content API's origin, in the environment of `bun run dev`, for example
`KERNEL_ORIGIN=http://127.0.0.1:3000 bun run dev`. Production supplies it as a Worker variable.
When it is missing, media routes return 503 while the rest of the site continues to work.
