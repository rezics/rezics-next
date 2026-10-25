Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

Every launch locale, including English, has a URL prefix.
Locale selection uses URL, `rezics_locale` cookie, `Accept-Language`, then English; language tags match exact locale, Chinese script or region, then base language.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`PUT /media/<id>` transports a reserved upload; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
Viewer credentials currently come from `Authorization`; no cookie is read yet.

Set these in the environment of `bun run dev`:

- `KERNEL_ORIGIN`: origin of the content API.
- `AUTH_ISSUER`: issuer identifier used for OpenID discovery and the Worker assertion audience.
- `MEDIA_CLIENT_ID`: the site Worker's OAuth client ID.
- `MEDIA_CLIENT_KEY`: private ES256 JWK JSON, including its `kid`.

Production uses the first three as Worker variables and `MEDIA_CLIENT_KEY` as a Worker secret.
Keep the private key out of config files, build output and the repository. The config declares only the secret's name;
local development obtains its value from the launching environment. The Worker obtains and caches its own short-lived
`media:complete` token with `private_key_jwt`. When any media setting is missing, media routes return 503 while pages continue to work.
