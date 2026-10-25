Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

Every launch locale, including English, has a URL prefix.
Locale selection uses URL, `rezics_locale` cookie, `Accept-Language`, then English; language tags match exact locale, Chinese script or region, then base language.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`PUT /media/<id>` transports a reserved upload; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
Viewer credentials currently come from `Authorization`, forwarded unchanged for reservation reads, completion and
download decisions. This is a development stand-in for the website's server-side session. The browser will hold only a
session cookie; access and refresh tokens will stay in the Worker. No cookie is read yet, and introducing the session
must add cross-site request protection for these routes.

Set `KERNEL_ORIGIN`, the content API's origin, in the environment of `bun run dev`, for example
`KERNEL_ORIGIN=http://127.0.0.1:3000 bun run dev`. Production supplies it as a Worker variable.
When it is missing, media routes return 503 while the rest of the site continues to work.
