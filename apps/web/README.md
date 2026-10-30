Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.
Local Worker values are opt-in: `bun run check --prepare-only` creates ignored `.dev.vars` from `.dev.vars.example` only when absent. Normal checks and isolated test startup leave it untouched.
Vite pre-bundles browser dependencies by scanning the site routes and their imported components before the first page load.
Run `bun run storybook` to browse the page stories. Run `bun run record` to create committed page recordings; it needs Docker with permission to start a disposable PostgreSQL container and Bun, and does not use a development kernel or database.
The Worker inspector is off by default; `WORKER_INSPECTOR_PORT=<port> bun run dev` opens it on that port for DevTools.

## Testing

For a focused fake, component, route-loader or story-render test that does not need native services, run it locally:

```sh
bun scripts/focused.ts -- bun test tests/<focused-file>.test.ts
```

The focused runner prepares generated messages and routes, gives the command an owned temporary Worker state root, and
removes that root after its process tree stops. It runs directly on the worker and does not request stack placement,
database leases, Docker, a database or remote dispatch. Add `--private-network` before `--` when a focused browser test
needs the normal loopback-only browser namespace.

Browser tests wait for `html[data-hydrated]` before interacting with a page.
Browser tests start the dev server through `tests/support/dev-server.ts`, whose errors name the phase that failed; a test never imports another test file.
Subject page reads and public collections work without JavaScript; Library writes use JavaScript and stay disabled until the page hydrates.
The settings page at `/settings` shows the signed-in person's spoiler level and cover suitability and saves each change
when chosen, with the version it read; a stale version keeps the choice on screen and offers a reload. Its Privacy
section reads the signed-in person's Collections after hydration, one page at a time, and lets them change visibility.
It links to security settings on the Auth site and offers sign-out. Its controls stay disabled until the page hydrates.

`bun run test` runs tests in a private network namespace containing only loopback, so host interface changes do not interrupt browsers.
Tests needing the host network, such as a container's published port, are named `*.host.test.ts` and run on the host through `bun run test:host`; never put a browser in one.
The host command routes `auth-binding.host.test.ts` through Auth's existing placed database lane. From the repository root,
run only that fixture with `bun apps/web/scripts/check.ts --auth-binding-host`.

`bun run check` runs each non-host test file in its own `bun test` process. Browser and dev-server tests run through
`scripts/isolated.ts`, which takes a host-wide stack slot for each file. Their separate pool has six lanes by default,
matching the check host's memory limit; set `WEB_BROWSER_CHECK_CONCURRENCY` to change that upper bound. The host lease
sets the actual stack concurrency from `REZICS_STACK_SLOTS` (eight by default on this host). When the check already
holds a stack slot, browser and dev-server files run one at a time inside that slot. Pure unit tests run directly,
without the isolated wrapper or a slot, in a wider ten-lane pool configurable with `WEB_UNIT_CHECK_CONCURRENCY`. Both
pools schedule files by their latest recorded wall time, longest first, and update
[`check-timings.json`](check-timings.json) after the run. Each isolated test also gets private temporary Cloudflare
Durable Object state, so parallel servers do not share SQLite data.
Test Vite processes allocate that state separately under the operating system's temporary directory. `WEB_TEST_STATE_DIR`
marks an inherited test root; it is not passed to Cloudflare as the instance's database path. A caller that needs one
instance's state to survive a sequential restart can pass `WEB_TEST_STATE_INSTANCE_DIR`; that caller-owned path is kept
after the server stops. Outside test mode, local development keeps the Cloudflare plugin's default `.cloudflare/state`.
The wrapper generates Paraglide messages when they are missing or older than the message files; branches do not change
`scripts/isolated.ts` to add their own generation step.
Generation retries a Lix timeout twice in a new process.

Test runs through `scripts/isolated.ts` or `check.ts` create `.dev.vars` from the committed development values in `.dev.vars.example` when it is absent, leaving existing local configuration untouched.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

Set the `TURNSTILE_SITE_KEY` text binding to the public Turnstile site key for the site's hostname.
Thread and post reports work for signed-in and anonymous readers. The explicit Turnstile script loads once per
page, only after a report dialog opens; every report includes a one-use proof and a UUIDv4 idempotency key.
In development only, `TURNSTILE_SCRIPT_URL` can point to a locally served test script; production always uses
Cloudflare's Turnstile script. Rights-holder notices will use a separate, later form.

Every launch locale, including English, has a URL prefix.
Locale selection uses URL, `rezics_locale` cookie, `Accept-Language`, then English; language tags match exact locale, Chinese script or region, then base language.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`POST /media` reserves a website upload; `GET /media/<id>` reads its state; `PUT /media/<id>` transports the bytes; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
To upload, reserve with `POST /media`, sending an `application/json` object of at most 4 KiB with exactly
`containerId`, `purpose` (`post-image`), `mediaType`, `byteCount` and optional `sha256`. The `201` response includes
`Location: /media/<id>` and `{ media: { id, state, mediaType, byteCount, sha256, containerId } }`.
Upload to that site address with `PUT /media/<id>`, giving the reserved `Content-Type` and exact `Content-Length`.
Read `GET /media/<id>` until the state is `available` or `rejected`; it returns the same metadata shape to the uploader
only. A `401` means the session has ended. Reservation responses use `Cache-Control: private, no-store`.
This transport is for website uploads; imported covers use content's own server-side fetch command.

Viewer credentials come from an explicit `Authorization` header, forwarded unchanged, or from the person's server-side
session. Access and refresh tokens stay in the Worker; the browser holds an opaque `__Host-rezics_session` cookie.
Only routes that use the credential resolve tokens, currently `/media` and `/media/…`, `POST /checkout`, order reads,
and the signed-in buyer's private `/orders` history. The history page requests one bounded `GET /v1/orders` cursor page
per visit and links each captured order to its existing known-ID page.
After hydration, the shell reads session presence, lifetime and CSRF token once through the private browser session query,
without refreshing tokens or contacting Auth. The root and public home, Space and board renders do not read session or preference cookies. Missing, invalid, expired or unreadable sessions render as signed
out without changing the cookie. Media requests, checkout start and order reads resolve before calling the kernel, so
unreachable Auth returns 502 even for downloads that otherwise conceal upstream errors. An explicit
`Authorization` header skips credential resolution; an unsafe request with a session cookie still validates its token.
Unsafe requests carrying that cookie require an exact allowed `Origin` and the session's CSRF token in
`X-CSRF-Token`. The only form-field exception is the sign-out form's `csrf_token` field. The browser session query supplies the token to controls and imperative transports; no page emits a `csrf-token` meta
element, and the token is never placed in a cookie.

Sign-in uses `GET /auth/sign-in?return_to=/ja`, followed by `GET /auth/callback`. Sign-out uses `POST /auth/sign-out`.
The header offers a sign-in document link returning to the current path and query, or an account menu with a security
settings link at `<AUTH_ISSUER origin>/security` and a sign-out form that revokes the session and ends it at Auth. The
menu and form appear after hydration. Without JavaScript, an Account link opens the server-checked settings page.
When session configuration is missing, the hydrated account slot remains empty.
Login transactions expire after 10 minutes; sessions expire 30 days after sign-in. The `SESSIONS` Durable Object binding
stores both in SQLite, with one instance per login transaction or session. Development simulates the objects locally.
Reads use two Worker rate-limit bindings: `READS_10S` has namespace `1001`, limit `100`, and period `10` seconds;
`READS_60S` has namespace `1002`, limit `300`, and period `60` seconds. Admitted GET and HEAD site reads consume both. Public documents use `ip:<CF-Connecting-IP>` without reading session cookies. Credential reads, server functions and suggestions use `account:<sub>` for a signed-in reader, shared across active sessions. Other non-document reads with a well-formed session or login cookie use `session:<id>`, and other requests use the IP key.

Configure these variables in the environment of `bun run dev`:

- `AUTH_ISSUER`: Auth's exact OpenID issuer identifier. HTTPS is required except for loopback development issuers
  (`127.0.0.1`, `localhost`, or `[::1]`).
- `API_RESOURCE`: the API's RFC 8707 resource identifier and access token audience, exactly `https://api.rezics.com`
  in production, with no trailing slash. Tests use `https://api.rezics.test`.
- `WEBSITE_SCOPES`: exactly the space-separated scopes registered for the website client, including `openid offline_access`, never a wildcard.
  Media routes need `media:create`, `media:read_reservation`, `media:read`, `media:complete` and `media:erase`;
  posting routes need `thread:create` and `post:create`; reactions need `reaction:set`; presentation curation needs `presentation:publish` and
  `presentation:activate`; checkout start needs `order:create` and order pages and purchase history need `order:read`; the settings page needs
  `account:read`, `account:update`, `collection:read` and `collection:update` (for the owner Collection list and visibility writes).
  Auth's create-organization and self-deletion pages also need the exact operation scopes `organization:create`,
  `account:manage` and `account:delete`.
  Offer pages and other public reads need no scope. Sign-in requests
  `openid offline_access` followed by these scopes, each once.
- `WEBSITE_CLIENT_ID`: the confidential website client id, `rezics-website`.
- `SITE_ORIGINS`: comma-separated exact origins (scheme, host and optional port, with no trailing slash). Production
  requires this variable. Development uses the dev server's own origin when it is unset.
- `PUBLIC_ORIGIN`: the absolute HTTP origin used for canonical URLs and cards, without a path or trailing slash.
  Set it to the public site origin and include that origin in `SITE_ORIGINS` in production.
- `WEBSITE_CLIENT_KEY`: a private P-256 JWK with a `kid`, used for ES256 client assertions. In production this is a
  Worker secret; supply it through Cloudflare's secret management, never through a config file or build output.
  `AUTH_ISSUER`, `SITE_ORIGINS`, `API_RESOURCE`, `WEBSITE_SCOPES` and `WEBSITE_CLIENT_ID` are production Worker text
  variables.

Auth must register the website client's redirect URI `<site origin>/auth/callback`, its post-logout redirect URI
`<site origin>/`, and the `private_key_jwt` authentication method with the corresponding public key and `kid`.
Pass exactly the registered scope list, including `openid offline_access`, as `WEBSITE_SCOPES`.
Auth's discovery `scopes_supported` lists every available scope. The Worker sends `resource=API_RESOURCE` on the
authorization request, authorization code exchange and every refresh; revocation takes no resource. Client assertions
keep `AUTH_ISSUER` as their audience, and ID tokens keep the client id as theirs. Discovery supplies all Auth endpoints,
and the host binding test exercises Auth's real handler, password sign-in, code exchange, rotation and logout.
If any auth variable is missing, `/auth/` routes return 503
`dependency_unavailable`, session cookies confer no credential and are left intact, and the rest of the site keeps working.

A refresh that Auth refuses with `invalid_grant` ends the session. Any other refresh failure keeps it, and
credential-using routes answer 502 `dependency_unavailable` until Auth answers again.

For production, set `WEBSITE_CLIENT_ID=rezics-website`, `SITE_ORIGINS=https://rezics.com`,
`API_RESOURCE=https://api.rezics.com`,
and `AUTH_ISSUER` to the deployment's canonical Auth issuer origin, without a trailing slash.
Register exactly `https://rezics.com/auth/callback` and post-logout URI `https://rezics.com/`.
The trusted Auth bootstrap entry is `createAuthService(options)` followed by
`auth.internal.registerWebsiteClient(registration)`; it has no public registration endpoint.
Use the mounted protected action catalogue supplied to Auth as `siteActions`:

```ts
const registration = {
  publicJwks: { keys: [websitePublicJwk] },
  redirectUris: ['https://rezics.com/auth/callback'],
  postLogoutRedirectUris: ['https://rezics.com/'],
  scopes: [
    ...new Set([
      'openid',
      'offline_access',
      ...[...mountedWebsiteActions].filter(([, action]) => !action.anonymous).map(([name]) => name),
      'organization:create',
      'account:manage',
      'account:delete',
    ]),
  ],
};
await auth.internal.registerWebsiteClient(registration);
// Deploy this exact string as the Worker's WEBSITE_SCOPES text variable.
const websiteScopes = registration.scopes.join(' ');
```

The catalogue must include the five media scopes above, the posting scopes `thread:create` and `post:create`,
`reaction:set`,
the curation scopes `presentation:publish` and `presentation:activate`, `order:create` and `order:read`, the settings page's `account:read`, `account:update`, `collection:read` and `collection:update`, and Auth's account-operation scopes `organization:create`, `account:manage` and `account:delete`.
Registration and `WEBSITE_SCOPES` must change together
when more protected site features are mounted. Auth's [website contract](../../services/auth/README.md#website-client)
defines registration and key rotation.
Rating writes also require the documented website client scope `rating:vote`.

Generate the website's own P-256 key from `apps/web`, keeping intermediate files under `.temp/`:

```sh
mkdir -p .temp
umask 077
bun -e 'import { generateKeyPair, exportJWK } from "jose";
const pair = await generateKeyPair("ES256", { extractable: true });
const metadata = { kid: crypto.randomUUID(), alg: "ES256", use: "sig" };
await Bun.write(".temp/website-private.jwk", JSON.stringify({ ...await exportJWK(pair.privateKey), ...metadata }));
await Bun.write(".temp/website-public.jwk", JSON.stringify({ ...await exportJWK(pair.publicKey), ...metadata }));'
chmod 600 .temp/website-private.jwk
```

Install the private JSON as the `WEBSITE_CLIENT_KEY` Worker secret through Cloudflare's secret management.
Pass only `.temp/website-public.jwk` to the Auth bootstrap as `websitePublicJwk`; Auth refuses private key material.
Keep Auth's issuer signing key separate. Retain the website private key in deployment secret storage and remove
the intermediate private file after installing it. Rotate by registering both old and new public keys, switching
the Worker secret, then removing the old public key from registration.

For local Auth, migrate a separate PostgreSQL database with Auth's documented `db migrate` command, then run
the same trusted bootstrap with `issuer: 'http://127.0.0.1:4200'`, `audience: 'https://api.rezics.test'`,
Auth's own signing key/secret and the trusted Access ports. Serve `auth.handler` on that exact loopback origin.
Register the generated website public key with redirect `http://127.0.0.1:3000/auth/callback`, post-logout URI
`http://127.0.0.1:3000/`, and exactly these scopes for the current media, posting, presentation curation, checkout, settings and account-operation routes:
`openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read account:read account:update organization:create account:manage account:delete`.
From `apps/web`, run:

```sh
AUTH_ISSUER=http://127.0.0.1:4200 \
API_RESOURCE=https://api.rezics.test \
WEBSITE_CLIENT_ID=rezics-website \
WEBSITE_CLIENT_KEY="$(cat .temp/website-private.jwk)" \
WEBSITE_SCOPES='openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read account:read account:update organization:create account:manage account:delete' \
KERNEL_ORIGIN=http://127.0.0.1:4300 \
bun run dev --host 127.0.0.1 --port 3000 --strictPort
```

Use the same hostname throughout so Auth's session cookie reaches `/authorize` and `/logout`.
Sign in with the person's password at Auth before following the site's sign-in link. Local HTTP changes neither
the HTTPS API resource nor the issuer audience in client assertions. The automated proof needs Docker and runs
through the placed Auth database lane from the repository root with `bun apps/web/scripts/check.ts --auth-binding-host`;
it creates and removes its own migrated database, Auth listener and site process, and waits for the real five-minute
token's refresh threshold.

Set `KERNEL_ORIGIN`, the content API's origin, in the environment of `bun run dev`, for example
`KERNEL_ORIGIN=http://127.0.0.1:3000 bun run dev`. Production supplies it as a Worker variable. When it is missing,
media routes return 503 while the rest of the site continues to work. Subject pages read through `@rezics/client`; in
development, when `KERNEL_ORIGIN` is unset, subject reads use the local route fixtures. Production requires it for
subject reads.

The subject overview reads the public Global rating aggregate and imported source statistics in parallel with the
page. Signed-in readers also request their own vote. The overview does not read Realm memberships, so it shows Global
alone; imported figures retain their source's scale.

### Storybook and page recordings

Add new fake routes, recordings and fixtures as new files under `src/kernel/fake/`, `src/kernel/recorded/` and
`src/kernel/fixtures/`; add no new routes or entries to `fake.ts` or `fixtures.json`. Each route module exports a
`routes` array typed as `FakeRoute[]` from `fake-modules.ts`: each route has a `method`, an exact pathname or regular
expression `path`, and a `story` answer, a `fixture` answer, or both. Answers receive `{ request, recordings, match }`
(plus `fixtures` for fixture answers) and return a `KernelRecording` or decline with `undefined`; async answers work
too. Read recordings by filename without `.json`, for example `recordings['new-page']`. Fixture JSON files contain
`subjects` and/or `accounts` arrays, appended after the base fixtures and demo accounts in filename order. Modules
are also tried in filename order before the existing routes, preserving their exported route order; explicit replay
recordings override discovered recordings for module answers. Bun tests, Storybook and the dev server discover the
files automatically once per process, with no shared index or import line.

The recording check is in `tests/recorded-responses.test.ts`; it type-checks every committed kernel response against `@rezics/client`.
A file under `src/kernel/recorded/` is a response the recorder received from the kernel; a state the recorder stack cannot produce through the API is a fake route module under `src/kernel/fake/`, never constants written out by `record.ts`.
Page stories draw subjects from `src/kernel/story-subjects.ts` by ID, and recordings that embed subject labels exist for each story locale.

Treat the bundled definitions release and its `definitions-active` and `definitions-release` recordings as one generated
change: whenever the bundled release changes, run `bun apps/web/scripts/record.ts definitions-active definitions-release`
in that same change.

Run `bun run storybook` from this directory to browse the page stories. The browser stories replay the committed
kernel responses and run as part of `bun run check`. To refresh those responses, run `bun run record`. It needs Bun,
Docker access to start a disposable PostgreSQL container and a disposable OpenSearch container, and permission to run
the kernel. The recorder migrates the disposable database, creates a recording account with governance authority,
signs a short-lived test token, and creates the launch subject through `POST /v1/subjects`. It then inserts a published
board and a published thread with three posts, and records the board, its first thread page, the thread, its first
post page, and the public identities used by their bylines. The kernel server does not mount subject search, so the
recorder indexes that subject in its OpenSearch node and records `POST /v1/subjects:search` through an in-process
kernel: one query that matches the subject and one that matches nothing. It also records the subject read and a
missing ID. A second thread of two posts belongs to the recording account, and the story visitor stands in for that
account so that the post editor can edit it. The checkout pages are recorded through an in-process kernel over the same
database with a local Stripe fixture: three offers (one with a long CJK title, one delisted) and three orders that reach
the paid, pending and failed settlements. It stops the kernel and removes the containers it started on success and
failure; it does not use a development kernel, the shared search node, or a shared database. Name recordings to write
only those files, for example `bun run --cwd apps/web record -- offer order-paid`; with no names the recorder writes
every recording. Set `WEB_RECORD_OUTPUT` to write them to another directory.
The recorder opens the `collections` exposure group through the platform API before the subject page reads
`GET /v1/subjects/:id/collections`. It starts the kernel worker and waits for the two edition links to be projected.

The thread and subject recordings carry story content the recorder keeps when it re-records: the thread's `subjectIds`,
a cover `summary` on the recorded subject and a second recorded subject without a cover (`subject-uncovered.json`), so
the thread page shows an image and a placeholder. The one cover image is generated, not copied, and lives in
`.storybook/media/`, which Storybook serves at `/media/`. The recordings hold only the kernel contract's fields; the
Storybook kernel adds the board row's reply count and last activity time, derived from the recorded posts.

The `board-realm*.json` recordings hold a Realm board for the Realm crumb: the recorder creates a Space, a Realm and a
board in it through the kernel's public API, inserts one thread of two posts, and records the board, the Realm, the
board's threads, the thread and its posts. Name all five to write only them.

Run `bun run screenshots` to capture every story in all eight locales and both themes for review by eye.
The tool uses Storybook's test build, which has no docs pages.
The run captures every job, then lists the stories that failed and exits non-zero.
The command builds Storybook once into a temporary directory, serves that build on a free port, and writes a
full-page PNG after the story has rendered and fonts have loaded. The default viewport is 1280×720 CSS pixels.
Files are named `<story id>.<locale>.<theme>.png` and land in `.temp/screenshots/` at the repository root.
A page that fits the viewport, such as the missing-subject page, is captured at 1280×720 pixels; a longer page is
captured whole. Choose a story id or glob, and repeat locale and theme, with:

```sh
bun run screenshots [--story <id or glob>] [--locale <code>]... [--theme light|dark]... [--width <px>] [--out <dir>]
```

The defaults are every story, `en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr` and `es`, both `light` and `dark`,
1280 pixels wide, and `.temp/screenshots/`. The script captures four pages at a time, prints one path per file and
then the total, and stops the server when it exits.

## Routing

[Search engines and sharing](../../docs/seo.md) is the authority for URLs, indexing, metadata, structured data, sitemaps and statuses. These mechanics apply to web routes.

**Locale URLs**: Every page path starts with a site locale. A path without one redirects 302 to the reader's locale, selected from the `rezics_locale` cookie, then `Accept-Language`, then `en`, with `Vary: Cookie, Accept-Language` and `Cache-Control: private, no-store`. A trailing slash redirects 301 to the path without it. The `x-default` alternate is the page path without the locale.

**Thread URLs**: A thread's canonical path is `/threads/{id}/{slug}`. `{slug}` is `slug(title)` from `@rezics/definitions/slug`, or `thread` when the title is null. `/threads/{id}` and any other slug redirect 301 to that path and keep `cursor`. Links use `threadHref`.

Renamed handles redirect 302 to the current handle for 30 days; afterwards, like a deleted account's handle, they answer the same 404 as an unknown handle.

**Public and signed-in routes**: Public routes render on the server without reading the session or any cookie. The session, CSRF token and personal state (library status, own vote, reactions, membership and edit controls) load in the browser after hydration through queries. Signed-in routes check the session in `beforeLoad` and redirect to sign-in with a return path; components never check it themselves.

Subject pages and views follow the same boundary: the server ensures locale and view keyed public page, type-frame, relation-label, reaction-count and rating-figure queries. Library slot, reading preferences, own reaction and own rating queries are browser-only and enabled after the session query reports signed in. Keep their control space reserved from the first render, and update or invalidate the corresponding query after a write. Subject server renders use anonymous defaults for spoiler and suitability preferences. These rules govern current subject routes and supersede older subject-specific read placement details below; the route checks own the current total read bounds.

**Data reads**: Each kernel read has one `queryOptions` factory beside its loader code. Loaders call `context.queryClient.ensureQueryData`; components use `useSuspenseQuery` for public reads and `useQuery` for personal reads in the browser only. Public reads keep `staleTime` 60 s, personal reads 0. The router preloads on intent.

`tests/public-cache-routes.test.ts` guards which routes use `staticData.publicCache` and verifies their server HTML is reader-independent.

The home route reads its page through the public `homePageQuery`. Its server render reads no session; after hydration, a signed-in visitor starts the personal Continue query, which reserves its section height while it loads. Signed-out visitors see no Continue section or personal read.

Space and Realm pages start from anonymous reads on the server. A signed-in visitor loads membership and participation in the browser. When the anonymous Space response does not expose a carried Realm, the browser makes one bounded session read of that Space page; protected Realm boards and publications are requested only if the session can read the Realm. A denied or unavailable response never becomes a false empty list. The Realm id route resolves its native Realm and Space, then redirects to the Space's address when one exists.

**Search params**: Every route that reads search params declares a Valibot schema in `validateSearch`, with defaults for missing or invalid values. A loader that depends on them declares `loaderDeps`.

The search route keeps its schema in `search/search-params.ts`; its query key includes the locale and every validated read param, and its results page is `noindex, follow` without JSON-LD.

**Head**: Every route's `head()` builds tags with `pageHead()` from `apps/web/src/shell/head.ts`: title, description, card, robots and JSON-LD. Canonical and `hreflang` alternates are emitted once for the page by the root, from the leaf route's locale paths.

### Top rated search

- **Touches:** One `POST /v1/subjects:search` with `sort: rating` for each page. An outdated cursor causes one additional first-page search request; the result envelope and facet reads stay the same.
- **Bound:** One search read per page view, two at most after a stale cursor. The public Global score is displayed only when the result contains a score; a missing figure stays blank.
- **Presentation:** Relevance remains the default and is omitted from the URL; Top rated preserves the query and filters. The page follows returned facet order and displays no search total, facet value count or count-relation metadata under either sort.
- **Growth check:** `apps/web/tests/search-rating-sort.test.ts` covers the rating request, the single stale-cursor restart, retained facet retry control, absent count display and result-row targets.

**Collections**: `/collections/{id}` renders anonymously with the collection title, its locale description, the first member's cover (or the default card), and a `CollectionPage`/`ItemList` plus site-curator-collection breadcrumbs. Cursor pages are `noindex, follow`. The route validates `cursor` and declares it in `loaderDeps`. Curator state and controls come from a `personalRead` after hydration; a private collection stays 404 to anonymous readers and is retried with the browser session after a signed-in not-found.

**Statuses**: Loaders end with real statuses: `notFound()` for 404, with unknown, unreadable and removed ids answering alike; `redirect({ statusCode: 301 })` for moved pages and outdated slugs; and the closed page for 403. A page never answers 200 with an error inside.

**Subject URLs**: A subject's canonical path is `/{locale}/subjects/{id}/{slug}`, where `slug` comes from the display label in that locale. Views append their view name; an id without a slug and an outdated slug redirect 301 while retaining the view and search params. Use `apps/web/src/subject/subject-href.ts` for every subject link. The id selects the page, and the loader supplies every locale's slug for canonical and alternate tags.

**Caching**: Anonymous responses of public routes carry `Cache-Control: public, max-age=0, s-maxage=60` and a weak `ETag`, never `Set-Cookie`. A deleted, restored, or withheld record can remain in shared cache for at most 60 seconds. Server functions that read the session answer `private, no-store`.

**Origin**: Absolute URLs use the configured `PUBLIC_ORIGIN`, never the request's `Host` header.

A route module reads Worker bindings only inside server functions; `head()` and components take those values from loader data.

**Pending and errors**: Routes declare `pendingComponent`, `errorComponent` and `notFoundComponent` where they differ from the router defaults.

## Security headers

Page HTML receives a fresh base64 nonce from one 16-byte cryptographic random draw. Request middleware keeps
it with the request and passes it to TanStack Router's `ssr.nonce`, including its streamed scripts. Client
navigation reuses the document's nonce. Pages remain private and uncacheable; media downloads retain their
separate `default-src 'none'; sandbox` policy.

The rich-text editor disables Tiptap's runtime CSS injection. Its ProseMirror base rules ship in the UI
package's static `prose.css`, imported by `styles.css`, so editors and their menus work under the same policy.

The sole route-scoped exception is the `inlineStyleExceptionPaths` list in `src/security/headers.ts`, for
`/<locale>/curate/presentation` and its descendants. Puck 0.23 injects styles for its drag overlay and preview
iframe interaction, and dnd-kit injects a root style; these style producers do not accept a nonce. The preview is a
same-origin `srcdoc` iframe that fetches nothing, so it requires no `frame-src` change.

The production Content Security Policy is defined in `src/security/headers.ts`:

| Directive                                                                 | Purpose                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default-src 'self'`                                                      | Restrict unspecified resource types, including fonts, to the site. Vite emits font files instead of data URLs.                                         |
| `script-src 'nonce-…' 'strict-dynamic' https://challenges.cloudflare.com` | Trust scripts carrying this response's nonce and scripts they load. The Cloudflare host supports Turnstile in browsers without strict-dynamic support. |
| `style-src 'self' 'nonce-…'`                                              | Permit site stylesheets and explicitly nonced style elements; the curator editor route uses the documented exception above.                            |
| `style-src-attr 'unsafe-inline'`                                          | Permit React's server-rendered style attributes.                                                                                                       |
| `img-src 'self' blob: data:`                                              | Permit site media, local upload previews and embedded image data.                                                                                      |
| `connect-src 'self'`                                                      | Browser requests go through the site; the Worker calls Auth and the kernel.                                                                            |
| `frame-src https://challenges.cloudflare.com`                             | Permit Turnstile's challenge frame.                                                                                                                    |
| `form-action 'self' <AUTH_ISSUER origin>`                                 | Permit local forms and sign-out's redirect to Auth; issuer paths are excluded. There is currently no checkout form redirecting to Stripe.              |
| `base-uri 'none'`                                                         | Prevent an injected base element from changing relative URLs.                                                                                          |
| `object-src 'none'`                                                       | Disable plugin content.                                                                                                                                |
| `frame-ancestors 'none'`                                                  | Refuse embedding the site in any frame.                                                                                                                |
| `upgrade-insecure-requests`                                               | Upgrade insecure resource URLs on secure pages.                                                                                                        |

Development adds only the dev server's exact WebSocket origin to `connect-src` for Vite's module reloading.
`html.cspNonce` marks Vite's injected assets; development middleware replaces that marker with the request
nonce while streaming HTML. It never adds a nonce to unmarked content. Production has no WebSocket allowance
or HTML rewriting. Neither environment permits script `unsafe-inline`, `unsafe-eval` or wildcard hosts.

Pages also send `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` and
`Cross-Origin-Opener-Policy: same-origin`. HTTPS pages send
`Strict-Transport-Security: max-age=31536000; includeSubDomains`; HTTP pages do not. HSTS deliberately excludes
`preload`, since preloading is hard to undo.

To add an outside origin, identify the browser request and its directive, add only its exact scheme/host/port
in `src/security/headers.ts`, document why it is needed, and update the exact policy expectation and production
browser coverage in `tests/security-headers.test.ts`. Keep server-only upstreams out of browser directives.
Configure `AUTH_ISSUER` rather than hardcoding an Auth host. Give new inline script or style producers the
document nonce explicitly; do not relax the policy to accommodate them.

## Deletion

Web stores no records of its own, so it soft-deletes, restores and purges nothing itself.
References to deleted, withheld or unavailable records render with `Tombstone`; a withheld part renders with
`Withheld`, leaving the other fields visible. A deleted or withheld page answers 404, following
[the SEO policy](../../docs/seo.md). Sitemaps drop the URL at the next export, and a shared cache serves a page
at most `s-maxage` (60 s) after its record goes. Restore and Undo call the owner's restore route only once
that route exists.

## Cost

### Signed-in routes

Signed-in routes use `beforeLoad: requireSignedIn`; an unavailable session store shows the existing error page.
The guard shares `sessionQuery` with the browser. Hydration reuses its session and CSRF token, so the first personal
action needs no additional session read.

- **Touches:** One session read in `beforeLoad` per server render of a signed-in route; none on client navigation
  within the session's cached state. A signed-out reader's request ends at the redirect, with no page read.
- **Bound:** Constant per request; no loader runs for a signed-out reader.
- **Growth check:** `tests/signed-in-routes.test.ts` counts kernel and session reads for a signed-out GET of each
  signed-in route: one session read and no kernel read.

### Page cache

- **Touches:** One Cache API lookup per anonymous GET of an opted-in route; on a miss, the page's usual reads and one Cache API put.
- **Bound:** A hit makes no kernel request; the HTML rewrite is linear in the page's bytes. A deleted, restored, or withheld record appears everywhere within 60 seconds.
- **Growth check:** The acceptance test counts kernel requests for two GETs of an opted-in page within the TTL: the first makes the page's reads, the second none.

The web Goal owns this Worker app. These bounds follow `src/server.ts`, `src/routes/`, `src/kernel/`,
`src/session/` and `src/media/`; they count outbound work, not the kernel's internal query cost.
The criterion is a bounded neighbourhood per request, about changes × log N; constant engine overhead is acceptable,
while dependence on all subjects, sessions or a person's history is not. No path here enumerates those totals.
K means kernel API requests, D means `SESSIONS` Durable Object method calls, R means R2 operations and A means Auth
HTTP requests; omitted categories are zero. Arrows mean sequential work. Bounds include early exits as smaller costs.

Let s count the subject payload's entries (including labels, aliases, statements, qualifiers, references and related
subjects, even entries filtered out before display), the board page's threads, or the thread page's posts, as applicable;
M is one media object's bytes, and t is tokens or stored entries in one session object. Home reads one route template
and renders its bounded search results. The kernel caps s at 512 facts per subject and returns current revisions only, so
the page needs no cap of its own. Board and thread reads use the kernel's default page size, at most 100 entries.
Each SQLite object has one `record` and an expiry alarm: a login record holds state, nonce, PKCE verifier, return path
and expiry (10 minutes); a session record holds subject, access/refresh/ID tokens, a 128-bit CSRF token and expiries
(30 days from sign-in).
Thus t is capped by one fixed-shape record with three OAuth token slots and one CSRF token; refresh overwrites tokens rather
than appending history.
Metadata, text and token lengths have no explicit byte caps here, so O(s) and O(t) byte bounds assume fixed-size entries;
otherwise use their actual encoded bytes. Constant buffers below mean independent of s, M and t, excluding those inputs.
Auth discovery is cached per configuration and execution context, with failed discovery evicted; A below names endpoint
work plus cache-miss discovery and, for signed token validation, SDK JWKS fetching, rather than assuming warm caches.
This is constant endpoint work in s/M/t; cache misses must be exercised independently of page size.
Browser redirects to authorization/logout are separate Auth requests, not Worker fetches.
The development-only fixture kernel scans fixture arrays; it is not evidence for production kernel complexity.
Every kernel read carries the reader's language chain (at most four tags) as `Accept-Language`; this adds no request,
and the kernel chooses embedded labels from it.

Follow-ups below are proposed tests in `tests/request-cost.test.ts`, counting calls through the fake kernel and session
at s = 1, 8, 64; they are not existing coverage or measurements. Existing tests cited cover only the stated call assertion.

### Page head

- **Touches:** No kernel read; the head uses the loaded page and matched route.
- **Bound:** Constant per page: eight alternates, one canonical and at most one JSON-LD script.
- **Growth check:** Page head rendering does not add a kernel request.

### Anonymous reads

- **Touches:** A server render of these pages makes their usual reads without a credential and no session read. A
  signed-in reader of a marked route, or of a page they could not read anonymously, makes the page's reads once more
  from the browser with the session.
- **Bound:** At most one extra set of the page's reads per page load, only signed in; once the edge cache serves the
  server render, a signed-in view costs one set of reads as on base.
- **Growth check:** The acceptance test counts kernel and session requests for anonymous, signed-in member and
  signed-in non-member views of a protected Realm's Space page: one set, two sets and two sets of reads.

### Sitemap files

- **Touches:** Memory and processor time only: no kernel, storage or network operation.
- **Bound:** Linear in the families passed; memory holds one shard's families and its compressed bytes, at most
  3,000 families and about 4 MB of gzip for 40,000,000 bytes of XML.
- **Growth check:** The acceptance test packs 300, 3,000 and 30,000 synthetic families and checks that shard count
  and uncompressed bytes grow linearly and that no shard exceeds 3,000 families or 40,000,000 bytes.

### Data reads

Each server render and browser session has its own query cache. Public reads stay fresh for 60 seconds, so preloaded client navigations reuse them without another kernel read. Server renders make the same reads as before, once per page, and dehydrate only the queries they used.

### Page security headers

- **Touches:** Request-local nonce → SSR and response headers
- **Bound:** 0 added K/D/R/A; one 16-byte random draw and a fixed-size header string per response; no production body
  buffering
- **Growth check:** No growth check applies

### Curator editor style policy

- **Touches:** URL pathname → constant `inlineStyleExceptionPaths` list
- **Bound:** 0 reads and 0 added K/D/R/A; one path match against eight constant paths per response
- **Growth check:** No growth check applies

### Read rate limits (GET/HEAD)

- **Touches:** Two Cloudflare rate-limit bindings for admitted reads before route handling. Public documents use the client IP without
  reading cookies. Credential reads use the account resolved by their existing session read; server functions and
  suggestions read session identity before admission so signed-in sessions share an account key. Other reads use a
  valid session or login cookie, then the client IP.
- **Keys:** public page documents are keyed by client IP alone, since they never read the session; signed-in pages, server functions and suggestions by active account, then session, then login cookie, then IP.
- **Bound:** 2 `limit()` calls; at most one `SESSIONS.signedIn()` read for a server function or suggestion with a
  session cookie, reused by its session query; 0 K/R/A; refusals stop before K
- **Growth check:** `tests/checkout-cost.test.ts`: `read rate limits stay within their bound as s grows`

### Sitemaps and robots.txt (serving)

- **Touches:** One R2 `get` on the `SITEMAPS` binding (bucket `rezics-sitemaps`, simulated locally) per sitemap request;
  `robots.txt` touches nothing. `/sitemap.xml` reads `index.xml`; `/sitemap-{type}-{digest}.xml.gz` reads
  `shards/{type}-{digest}.xml.gz`; other keys are the export's private state and are never served.
- **Bound:** Constant per request: no kernel request, no session read, no cookie, no list operation; the body streams
- **Growth check:** `tests/sitemap-serve.test.ts`: `sitemap requests make exactly one R2 get whatever the number of stored files`

### Platform gates

- **Touches:** Shared kernel-client recognition checks the problem body from an existing gated read; the root error
  component renders the localized closed page. Media reservation and checkout start keep the kernel's 403 problem.
- **Bound:** One single-read page request uses exactly 1 existing K and at most 1 existing D for signed-in root session
  state; 0 R/A. Board and thread pages use at most 2 existing K. Recognition adds 0 K/D/R/A and inspects one bounded
  problem body, with no work per catalog entry.
- **Growth check:** `tests/platform-closed-cost.test.ts`: `closed page reads keep K/D/R/A fixed as existing page data grows`

### Admitted controls

- **Touches:** One kernel `GET /v1/platform/exposure`, using the kernel's existing open-groups and held-gates reads.
- **Bound:** At most one anonymous kernel read per isolate per 60 seconds; one viewer read per active query client
  per 60 seconds, shared across controls and navigations. Neither bound grows with pages or stored data.
- **Growth check:** `tests/closed-controls.test.ts` counts reads over ten anonymous server renders and a signed-in
  load followed by three client navigations, and checks that public renders read no session RPCs.
- **Visual check:** `Pages/Exposure` stories show the subject, personal library, progress and offer with all groups
  admitted and with none, in either locale and at either viewport width.

### Progress route admission

- **Touches:** After `requireSignedIn`, the progress index and session routes call the existing anonymous
  `prepareExposure` prefetch. It reuses the platform exposure query and its per-isolate cache; it adds no viewer
  read or additional progress, session, changes, units, logs or suggestion request.
- **Bound:** At most one additional anonymous kernel read per isolate per 60 seconds across both routes. The
  pre-hydration form remains closed when public exposure is absent, unknown or unavailable; authenticated browser
  exposure continues to gate the hydrated controls.
- **Growth check:** `tests/progress-pages-layout.test.ts` checks the pre-hydration and hydrated Unit control and
  bounds anonymous exposure reads across the existing 10, 1,000 and 10,000 row fixtures.

### Locale resolution (`/`)

- **Touches:** URL, locale cookie, then weighted `Accept-Language`, then English; redirect before page loaders
- **Bound:** K/D/R/A = 0; no body buffered; header parsing/sorting depends on header length, not database size
- **Growth check:** `tests/request-cost.test.ts`: `locale resolution stays within its bound as s grows`

### Search page (`/<locale>/search`)

- **Touches:** In parallel: one `POST /v1/subjects:search` and one `POST /v1/subjects:facets`; the search read asks for
  descriptions, the reader's language chain (at most four languages) and the properties that give each hit its year
  (at most four time properties across types, the type's first on a single-type search) plus, for a single-type search,
  at most two facet properties; the facets read of a single-type search asks for the type's facet properties, and that
  of a search across types asks for the type counts, so the types are listed by count; active definitions digest
  cached for 60 s and release cached by digest without expiry
- Non-English requests send the locale and its related scripts without English; English requests send `en` alone, so the kernel can choose a Japanese original title before falling back to English.
- **Bound:** 2 K and 0 D per search; result page is at most 100 entries and facet work is bounded to 8 properties × 10
  values; the response stays O(page size), with each description at most 200 grapheme clusters in at most four languages
  and at most 3 properties × 3 values per hit, one cover summary per hit and no media call; 0 R/A
- **Growth check:** `tests/search-facets.test.ts`:
  `searches read the definitions release once per digest and make two kernel reads each`
- **Growth check:** `tests/request-languages.test.ts` keeps search and home request counts fixed at 1, 10 and 100
  matching subjects

### Top rated search

- **Touches:** One `POST /v1/subjects:search` with `sort: rating` for each page. An outdated cursor causes one additional first-page search request; the result envelope and facet reads stay the same.
- **Bound:** One search read per page view, two at most after a stale cursor. The public Global score is displayed only when the result contains a score; a missing figure stays blank.
- **Presentation:** Relevance remains the default and is omitted from the URL; Top rated preserves the query and filters. The page follows returned facet order and displays no search total, facet value count or count-relation metadata under either sort.
- **Growth check:** `apps/web/tests/search-rating-sort.test.ts` covers the rating request, the single stale-cursor restart, retained facet retry control, absent count display and result-row targets.

### Suggestions (shell typeahead)

- **Touches:** One site GET route calls `subjects:suggest` with a constant cap and the reader's language chain, and
  names the suggested types from the cached definitions release; browser waits 200 ms after typing pauses and cancels
  stale requests
- Suggestions use the same locale and related-script list as search and carry the chosen title's language on the row.
- **Bound:** 1 K per request with a constant result cap, plus the definitions reads that the digest and release caches
  absorb, 0 D, 0 R and 0 A; each suggestion carries one cover summary and no media call. The browser sends at most one
  request per pause
- **Growth check:** `tests/request-cost.test.ts`: `suggestions stay within their bound as s grows`

### Site shell (navigation column and header)

- The header owns the site's one search field, centred within a bounded 40rem width on desktop. Pages do not render
  their own query field. A route may supply a removable scope chip; removing it widens the query, and Backspace in an
  empty field removes it. Scope conditions enter the shared filter protocol only when the kernel supports that kind.
  The field's filter button opens the current search filters, with the active condition count; on phones the header
  search button opens a full-screen search view with the same query and filter controls.
- **Touches:** A nonce-bearing inline head script applies theme and navigation cookies before first paint. The
  shell renders three fixed destinations, header controls and one navigation column; the column background and
  link underlines are CSS. The account slot reserves the same space while session state is unknown
- **Bound:** 0 server K/D/R/A; at most 3 destinations and 8 locales per page, independent of s, M and t;
  navigation background is one stretched element, with no per-line work
- **Growth check:** `tests/public-render.test.ts` checks pre-paint preferences, the account slot and script-free Account

### Session state

- **Touches:** One browser GET server function reads session state and CSRF with `Cache-Control: private, no-store`;
  a valid configured session cookie causes one D `signedIn` read, with no credential resolution or Auth request
- **Bound:** Once per document load; client navigations reuse `sessionQuery`. The existing sign-in and sign-out
  document redirects create a fresh query client and read the new session state. Server renders remain unknown
- **Growth check:** `tests/public-render.test.ts` counts one session-state read across hydration and three navigations

### Home page (`/<locale>`)

- **Touches:** One anonymous `POST /v1/pages:read` for route `/`, including platform search and type lists.
  The personal Continue row starts its separate browser read after the session is known
- The page read sends the reader's language list once; the kernel applies it to each planned search read inside the page.
- **Bound:** ≤1 K (four searches of at most 12 subjects each inside the page read, each hit with its cover summary),
  0 D/R/A for the server render; O(document + read results) rendering, bounded by composition limits;
  no result, label or media calls per item
- **Growth check:** `tests/public-render.test.ts` asserts identical HTML with and without a session cookie and zero
  session/Auth reads; `tests/request-cost.test.ts` checks the public K bound as s grows

### Home Continue row

- **Touches:** for a signed-in visitor, one `GET /v1/libraryContinue?limit=6` and one `POST /v1/pages:read` with at most 6
  `subject` reads; none for a signed-out visitor.
- **Bound:** two kernel requests per home view and at most 6 cards, whatever the size of the library or the number of
  active sessions; no per-subject requests.
- **Growth check:** `continue-runtime.test.ts`, "the row makes at most two kernel reads per view, none of them per
  subject, with 0, 6 and 300 subjects in progress", counting fake kernel requests.
- **Card:** each card is a `CoverCard`: the cover edge to edge, the title, the subject's type as the one secondary
  line, and one `ProgressRow`. The card is one link to the progress session, named "Continue <title>", and its ⋯ menu
  holds "Open subject page"; nothing else on it is interactive. The row shows the unit form the kernel's progress
  allows ("Ep 3/12", "p. 120/310") with a bar for the share where there is a total, a percent as its own bar, the
  amount alone with no bar where there is no total, and the state label "In progress" where only a reading position is
  known or the session could not be read. Below `sm` the cards form a `CoverRow`; from `sm` up a `CoverGrid`. The
  home story's recorded sessions cover each case. The catalogue rows of the home page are `CoverRow`s of `CoverCard`s
  at every width, with the type under the title.

### Board page (`/<locale>/boards/<id>`)

- **Touches:** Root preferences/D and public board plus thread-page K reads started together, then one batched
  identity read for the page's authors; preserve kernel thread order and pass `next` as the paging cursor. Each row
  is compact: author, reply count and last activity come from the thread row itself, with no read per thread. The
  `sort` search parameter (`hot` or `new`, Active when absent or unknown) is the threads read's `sort` query, `new`
  sending none
- **Bound:** ≤3 K (board and one page of at most s ≤ 100 threads, then at most one identity read), ≤1 D, 0 R/A;
  work and buffered JSON are O(s)
- **Growth check:** `tests/request-cost.test.ts`: `board page stays within its bound as s grows`

### New-thread page (`/<locale>/boards/<id>/new`)

- **Touches:** Root preferences/D and one public board K read; no thread list is loaded
- **Bound:** ≤1 K, ≤1 D, 0 R/A; constant
- **Growth check:** `tests/posting.test.ts`: `a signed-in member starts a thread from its board and lands on it` records
  the page and write kernel calls

### Thread page (`/<locale>/threads/<id>`)

- **Touches:** Root preferences/D and thread plus post-page K reads started together, then one batched identity read
  for the page's authors; render each page body locally with `DocumentBody`. Reactions add no read, because counts and
  the viewer's kind come with the thread and post-page reads. Each post draws its byline with the shadcn `avatar` and
  puts its reactions beside the overflow menu, which holds copy-link and report (or edit and delete for the author).
  A signed-in page read resolves the session credential once and sends it on those two reads
- **Bound:** ≤3 K (thread and one page of at most s ≤ 100 posts started together, then at most one identity read),
  plus the subject reads of Thread subjects, ≤1 D, 0 R/A; work is O(total body size of the page), each body capped at
  2 MiB (ADR-0036)
- **Growth check:** `tests/request-cost.test.ts`: `thread page stays within its bound as s grows`
  `tests/reactions-cost.test.ts`: `thread page reads stay within their bound as s grows`

### Board and thread personal state

- **Touches:** Board and thread HTML reads use anonymous kernel requests and do not resolve the reader's session. Once
  hydrated, a signed-in thread reader makes one `personalRead` for the reader id and one reaction read for the thread
  plus each post on the visible page. It supplies own-post edit/delete controls, reaction selections and the reply
  composer. Signed-out readers make no personal thread read and receive the sign-in reply link.
- **Bound:** At most `s + 1` personal kernel reads for a thread page with `s` posts, independent of reaction counts;
  0 personal reads for a signed-out reader. The board and thread public HTML is identical across session states apart
  from the CSP nonce.
- **Growth check:** `tests/thread-personal.test.ts` verifies anonymous server rendering, browser-only personal data,
  reserved personal-control space and query updates after reply, edit, delete and reaction.

### Thread page mentions

- **Touches:** One additional public `GET /v1/accounts?ids=` in the thread page's server read when a rendered post mentions someone; none otherwise. All posts share the resulting current-handle map, with a plain `@` for missing or deleted accounts
- **Bound:** At most 100 distinct account ids, collected in document order in O(page document nodes); ids beyond that bound remain unresolved. This adds at most 1 K to the thread page bound above. The post composer's exact `GET /v1/accounts?handle=` lookup waits for a 200 ms typing pause and aborts stale requests, with at most one request in flight
- **Growth check:** `tests/mentions.test.ts` loads pages mentioning 0, 1, 10, 100 and 120 distinct accounts; `packages/ui/tests/editor-mention.test.ts` covers one lookup for a quickly typed ten-character handle, cancellation, selection and accessibility

### Realm crumb

The line above a thread title reads `Realm › Board`, and the line above a board title names the Realm. Both are links:
the Realm to `/<locale>/realms/<id>`, the board to its page. A board view carries `realmId`, which is `null` for a
board outside every Realm. `readBoardRealm` in `threads/board-context.ts` makes the one Realm read, in the reader's
language through the client's `accept-language`.

- **Touches:** one `GET /v1/realms/<id>` K read per thread or board page view when the board has a Realm, none
  otherwise. On the thread page it follows the board read and runs beside the post-page read, with the reader's
  credential when there is one; on the board page it follows the board read and runs beside the thread-list read. A
  Realm that cannot be read is left out of the line and the page renders without it
- **Bound:** +1 K, constant per page view, independent of the number of threads and posts
- **Growth check:** `tests/board-realm-crumb.test.ts`: a thread with one post and a thread with a full page of posts
  each make one Realm read, and a board page makes one

### Thread subjects

- **Touches:** the first four ids of the thread's `subjectIds` each get one `GET /v1/subjects/<id>` K read, started
  together with the identity read once the thread has loaded. The cover summary, types and labels of that read feed
  `Cover` (`sharedRatio` for the strip) and the title; a read that fails leaves that subject out of the strip
- **Bound:** ≤4 K per page view whatever the number of attached subjects (at most 128 ids); no D, R or A; work is O(1)
- **Growth check:** `tests/threads-subjects-cost.test.ts`: a thread page reads at most four of its subjects, together,
  whatever the number attached

### Page authors

- **Touches:** one `GET /v1/accounts?ids=` per thread or board page view, for the page's distinct author ids.
- **Bound:** at most 1 K per page view (0 when the page has no authors) whatever the number of posts, threads or
  authors on it (at most 100 ids, one call); 0 D, R and A.
- **Growth check:** `tests/bylines-cost.test.ts`: a thread or board page reads its authors in one request at every size

### Reaction

- **Touches:** One `PUT` or `DELETE` `/v1/{threads|posts}/<id>/reaction`/K after the session read. `PUT` sends
  `{ kind }` and every change sends a new `Idempotency-Key`
- **Bound:** ≤1 K, ≤1 D; constant
- **Growth check:** `tests/reactions-cost.test.ts`: `setting or clearing a reaction stays within its bound as s grows`

### Collection page

- **Touches:** One session read and, started together, `GET /v1/collections/<id>?view=FULL` plus
  `GET /v1/collections/<id>/members?view=FULL` for one members page. FULL embeds the curator and each member's subject.
- **Bound:** 1 D, 2 K, 0 R and 0 A. The members read is one page of at most 100 entries. No per-member reads.
- **Growth check:** `tests/library-collection-cost.test.ts`: `collection page stays within its bound as its member page grows`

### Dynamic Collection page

- **Touches:** One Collection read and one members page read per document for dynamic and curated Collections with 0, 20 and 100 members; a preparing answer adds at most 3 rereads.
- **Bound:** Two kernel requests per document plus at most 3 rereads, at most the page size of members, whatever the Collection's size.
- **Growth check:** `collection-dynamic.test.ts`, "one Collection read and one members read per document for dynamic and curated Collections with 0, 20 and 100 members; a preparing answer adds at most 3 rereads", counting fake kernel requests.

### Library type names

- **Touches:** After a collection, personal library, copies, reading progress, published log or following page is read,
  one definitions lookup (active digest cached for 60 s, release cached by digest without expiry) names each distinct
  subject type of that page in the reader's language chain
- **Bound:** 0 K, 0 D, 0 R and 0 A beyond the page's own reads; at most 1 definitions fetch when the digest is cold and
  none when warm; local work is one lookup per distinct type among at most 100 rows. A type with no name is left out
- **Growth check:** `tests/library-collection-cost.test.ts`: `collection page stays within its bound as its member page grows`

### Collection members filter

- **Touches:** One `GET /v1/collections/{collectionId}/members` per page view and per filter change, with the admitted filter added; tag suggestions use the existing suggestion read, one per typed query after the debounce.
- **Bound:** One members read per page of at most the page size, whatever the number of members or filters; at most 3 rereads while preparing.
- **Growth check:** `tests/collection-filters.test.ts`: `one members read per filter change and per page, with 0, 20 and 100 members on the page and 0, 1 and 2 filters`

### Realm page

- **Touches:** The anonymous page render reads `GET /v1/spaceAddresses/<address>`, then `GET /v1/spaces/<id>`. Only
  when its `realmId` is non-null it reads the Realm, one boards page (`limit` 20), one publications page (`limit` 12),
  and one `GET /v1/subjects/<id>` per published subject shown, started together. `/realms/<id>` reads the Realm and
  Space instead and redirects when the Space has an address. After hydration, a signed-in reader gets one personal
  membership query (`members/me` and `participation` together). If the anonymous payload hides its Realm, that same
  browser query rereads the bounded Space page using the session and requests boards, publications and subjects only
  after the native Realm read admits the reader. A denied read keeps the protected page hidden; a failed page read
  renders the route error rather than a false empty list.
- **Bound:** 2 K anonymous without a Realm, 5 K anonymous with a Realm, plus one K per published subject shown (at
  most 12). Membership adds 2 K and 1 D. If the anonymous page has no readable Realm, a signed-in session read adds
  one page set: 2 K without a readable Realm, or 5 K plus at most 12 subject reads when the Realm is readable; it
  also adds 1 D. Boards and publications are single pages, never walked.
- **Growth check:** `tests/realm-pages-cost.test.ts`: `the Realm page reads its fixed set once, however many boards, publications and memberships there are` at 1, 10 and 100

### Community page head

- **Touches:** Builds title, description, the first available published cover (or default share card), robots and one JSON-LD graph from the Space and
  public Realm data already rendered by the page. A protected Realm marks the page `noindex, follow`.
- **Bound:** 0 additional K, D, R or A; constant local work per page.
- **Growth check:** `tests/community-seo.test.ts`: unique localized metadata, public visibility, one WebPage and
  BreadcrumbList graph, and no server session reread.

### My Realms

- **Touches:** One session read and `GET /v1/me/realms` for one page of at most 20 Realms; the next page is a cursor.
  Each link goes to `/realms/<id>`, which resolves it when followed. Joining or leaving sends one
  `POST` or `DELETE /v1/realms/<id>/membership` with an idempotency key.
- **Bound:** 1 K and 1 D for the page, and 1 K and 1 D for a join or leave; 0 R and 0 A. No per-Realm reads.
- **Growth check:** `tests/realm-pages-cost.test.ts`: `my Realms is one page read, however many Realms the person has joined` at 1, 10 and 100

The signed-in Account menu links to My Realms. The page remains private and `noindex, nofollow`; it renders only the
current account's native membership page and links each Realm by its native id. `space.stories.tsx#Unavailable` uses
the recorded Space and board responses plus named failure responses for membership and a deleted published subject;
`space.stories.tsx#BoardsUnavailable` injects a native-shaped 503 to verify the route does not present an empty board
list. `realms.stories.tsx#AccountMenuNavigation` uses the recorded My Realms response and exercises the menu link by
keyboard. The native browser receipt additionally covers a real empty My Realms response and the real zero-board
Space response at 390 and 1280 pixels.

### Collection editing

- **Touches:** One session read, then one kernel write: `POST /v1/collections`, `PATCH` or `DELETE
  /v1/collections/<id>?revision=…`, `POST …/members/<memberId>:move`, `PATCH` or `DELETE …/members/<memberId>`, or
  `PUT`/`DELETE /v1/follows/<id>`. A move sends only the member and its `after` neighbour and never reads the member
  list. The collection page of a signed-in person who is not the curator of a public collection adds one
  `GET /v1/follows/<id>?view=FULL` after its own two reads, with the session credential it already holds.
- **Bound:** 1 D, 1 K, 0 R and 0 A for each change, independent of the collection's size. The follow state is one more
  kernel read, and the curator's page has none.
- **Growth check:** `tests/library-collection-editing-cost.test.ts`: `collection editing stays within its bound as the collection grows`

### Collection page

- **Touches:** One anonymous `GET /v1/collections/<id>?view=FULL` and one members page of at most 100 entries. After hydration, a signed-in reader gets one personal collection read to determine curator status; a non-curator public reader may also get the follow read.
- **Bound:** The anonymous render uses no session read. The hydrated personal read adds at most one collection read and one members page, independent of total collection size.
- **Growth check:** `tests/library-collection-cost.test.ts` bounds the page reads at increasing member counts; `tests/collection-seo.test.ts` checks the rendered metadata and cursor indexing.

### My collections and following

- **Touches:** Each page reads one signed-in session and one `GET /v1/collections?curatorAccountId=…&view=FULL` or
  `GET /v1/follows?view=FULL`; unfollow sends one `DELETE /v1/follows/<targetId>` with an idempotency key. Labels are
  embedded in the list response.
- **Bound:** Each page uses 1 K, 1 D, 0 R and 0 A and returns at most 100 entries. Unfollow uses at most 1 K and 1 D;
  no page does one read per collection or followed target.
- **Growth check:** `tests/library-mine-cost.test.ts`: `my collections and following stay within their bound as list size grows`

### Settings page

- **Touches:** One session read and `GET /v1/accounts/<id>/preferences` for the signed-in account. Each change is one
  `PATCH /v1/accounts/<id>/preferences` after that session read, carrying the version the person read and an
  idempotency key. A reload after a stale version repeats the page's two reads.
- **Bound:** A view is 1 D and 1 K, 0 R and 0 A. A change is 1 D and 1 K write, 0 R and 0 A. The account is the
  session's own, so no cost depends on the number of accounts, preferences or earlier changes.
- **Growth check:** `tests/settings-page-cost.test.ts`: `the settings page stays within its bound as the stored version grows`,
  `a settings change is one write however often the settings changed before` and
  `three repeated loads each cost the same`

### Collection privacy settings

- **Touches:** One session read and one owner `GET /v1/accounts/<id>/collections?limit=20` for each page the person requests.
  A visibility change is one `PATCH /v1/collections/<id>` with its revision and an idempotency key. Reloading after a
  conflict reads only that Collection.
- **Bound:** At most 20 Collection rows per requested page and one kernel read per page. A visibility change is one
  kernel write. No read cost depends on Collections beyond pages the person opens.
- **Growth check:** `tests/settings-privacy.test.ts`: `first-page cost stays fixed for 5 and 50 Collections, then grows
  by one read per requested page`; the paging test also checks one additional read for Load more.

### Settings notifications

- **Touches:** The preferences read the page already makes; one PATCH per change.
- **Bound:** The map holds a few kinds; rendering is linear in it.
- **Growth check:** The acceptance test counts kernel requests for one settings render: equal to base.

### Personal library

- **Touches:** One session read and `GET /v1/libraryEntries?view=FULL` for one page of at most 100 entries. A state
  change is one `PUT /v1/libraryEntries/<subjectId>` or `DELETE /v1/libraryEntries/<subjectId>?revision=` after that
  session read.
- **Bound:** A view is 1 D, 1 K, 0 R and 0 A. A state change is 1 D and 1 K write, 0 R and 0 A. The list is one page of
  at most 100 entries. No per-entry reads.
- **Growth check:** `tests/library-entries-cost.test.ts`: `personal library view and state change stay within their bounds as entries grow`

### Library navigation

- **Touches:** One `GET /v1/libraryPins?limit=8` and one owner Collections first-page read per signed-in Library document, after hydration; each pin target comes in the pins response.
- **Bound:** One pins request and one Collections request, with at most 8 pins rendered and no per-Collection reads.
- **Growth check:** `tests/library-pins.test.ts` counts the pins and owner Collections reads with 0, 8 and 100 pins and no per-Collection read.

### Library pins

- **Touches:** One `GET /v1/libraryPins?limit=100` on All Collections or a Collection page.
- **Bound:** One request; at most 100 pins, the list's maximum.
- **Growth check:** `tests/library-pins.test.ts` counts one pins read on All Collections with 0, 8 and 100 pins.

### Tracked entries

- **Touches:** One `GET /v1/libraryEntries?view=FULL` page, optionally filtered by an exact profile state ID and cursor.
  A state change or removal sends one write with the current revision and, when present, entry incarnation.
- **Bound:** One request and at most 100 entries per page; no per-entry reads. A mutation is one write, with a bounded
  current-entry read only when resolving a conflict or stale incarnation.
- **Growth check:** `tests/library-entries-cost.test.ts`: `personal library view and state change stay within their bounds as entries grow`

### Copies

- **Touches:** One session read, then `GET /v1/copies?view=FULL` with `subjectId` when the URL names a subject,
  for one page of the viewer’s copies. The subject also pre-fills the Edition field in the add form. Adding, editing and
  deleting each send one write with an `Idempotency-Key`; an edit sends the revision in the body and a deletion sends
  `?revision=`.
- **Bound:** 1 D and 1 K for a view, which reads at most 100 copies, whatever the number of copies or subjects;
  1 D and 1 K for each change; 0 R and 0 A with a fresh credential.
- **Growth check:** `tests/library-copies-cost.test.ts`: `copies stay within their bound as the copy list grows`

### Reading progress

- **Touches:** One session credential read, then GET session, one changes page and one completed-units page started
  together (`view=FULL`). A record is one POST `:record` after that credential read.
- **Bound:** Session view: 1 D and 3 K in parallel, 0 R, 0 A. Each history read is one page of at most 100. A record is
  1 D and 1 K carrying at most 100 unit ids. No per-unit or per-change reads.
- **Growth check:** `tests/library-progress-cost.test.ts`: `reading progress stays within its bound as its pages and unit batches grow`

### Progress subject picker

- **Touches:** One `GET /v1/subjects:suggest` per settled keystroke (250 ms pause; a newer keystroke aborts the older
  read). The page's own reads are unchanged.
- **Bound:** At most one suggestion read in flight per picker, each answering a fixed number of suggestions,
  independent of the catalogue's size and the reader's sessions.
- **Growth check:** `tests/progress-pages-layout.test.ts`, 'both pages render without JavaScript and make the same kernel reads as on base, plus at most one suggestion read per settled keystroke in the picker'

### Published logs

- **Touches:** A public log page reads one `GET /v1/publishedLogs/<id>?view=FULL`. The owner's progress page reads one
  `GET /v1/publishedLogs?accountId=…&view=FULL&limit=100` page. Publishing and deleting each use one idempotent kernel
  write after the session credential read.
- **Bound:** A public log page is 1 K, 0 D, 0 R and 0 A; an owner's view adds 1 D. The owner list is 1 D and 1 K;
  publish and delete are each 1 D and 1 K. The list returns at most 100 logs, with no per-log reads; all operations use
  0 R and 0 A.
- **Growth check:** `tests/library-logs-cost.test.ts`: `published log reads and writes stay within their bound as an account log list grows`

### Start a thread

- **Touches:** One `POST /v1/threads`/K after the session read; send the published thread draft and stable idempotency
  key
- **Bound:** ≤1 K write, ≤1 D; work is linear in the draft, which the kernel caps at 2 MiB
- **Growth check:** `tests/posting.test.ts`: `a signed-in member starts a thread from its board and lands on it` records
  the single write

### Reply

- **Touches:** One `POST /v1/threads/<id>/posts`/K after the session read; render the post returned by the kernel
  without rereading the thread
- **Bound:** ≤1 K write, ≤1 D; work is linear in the draft, which the kernel caps at 2 MiB
- **Growth check:** `tests/posting.test.ts`: `a signed-in member replies to a thread and sees the reply` records the
  single write

### Report

- **Touches:** The report server function reads the session credential, then sends one `POST /v1/reports`/K with
  the target, optional revision and evidence, reason, bot token and stable `Idempotency-Key`
- **Bound:** ≤1 K, ≤1 D; 0 R/A with a fresh credential (token refresh follows its separate bound). Constant in the
  number of stored reports and sessions; details are capped at 4096 characters. The browser loads the Turnstile
  script once per page and only after opening a dialog
- **Growth check:** `tests/report-cost.test.ts`: `report submission keeps K/D/R/A fixed as stored reports and sessions grow`

### Notifications inbox (`/inbox`)

- **Touches:** One private notification page read, then at most one existing post, decision or report read per distinct target; the navigation badge reads the capped count after hydration.
- **Bound:** A page contains at most 20 notices; at most `1 + D + 1` kernel reads for `D` distinct targets, plus one count read per navigation inside its 60-second stale time. Opening marks the newest notice once.
- **Growth check:** `tests/notifications-inbox.test.ts` checks pages of 5 and 20 notices naming three repeated posts and limits reads to the list, distinct targets and count.
- **Visual check:** Inbox stories cover empty, mixed, unavailable and more-than-99 unread states in English and Simplified Chinese; use light and dark themes at 390 and 1280 pixels.

### Moderation decision (`/moderation/decisions/<id>`)

- **Touches:** One private decision read and one existing read of its post or thread; one appeal write and one decision re-read after submission.
- **Bound:** Exactly two kernel reads per page view. The author can appeal through the decision's `:appeal` method through the inclusive 183-day deadline; successful and terminal-conflict submissions use the next decision read to show current state.
- **Growth check:** `tests/moderation-decision.test.ts` checks the two-read bound, author and deadline gates, pending appeal state, overlong draft preservation and refreshed late/duplicate states.
- **Visual check:** Decision stories cover open, pending and expired appeals in English and Simplified Chinese at 390 and 1280 pixels.

### Board moderation reports (`/boards/{id}/moderation`)

- **Touches:** One page of at most 20 reports for the selected board, thread or known post, then one existing target read for each distinct target on that page. A post-specific report page uses `?post=<id>`; report APIs are target-scoped, so the page does not discover child reports by walking the board.
- **Bound:** Reports use at most `1 + D` kernel reads for `D` distinct targets on the selected page. The appeals tab uses one page of at most 20 native appeals with the decision statement and target included in each row, then one existing target read per distinct post or thread; it makes no per-appeal decision reads. Each submitted moderator action issues one write.
- **Growth check:** `tests/moderation-reports.test.ts` pages repeated targets and confirms one target read per distinct identity and preserves the cursor. `tests/native/native-moderation.host.test.ts` fixes the appeal page and target while adding 1, 8 and 64 unrelated posts; the page still makes one appeal request, one target read and no decision reads.
- **Visual check:** Report stories cover open and resolved reports in English and Simplified Chinese. Appeal stories cover a pending native appeal in all launch locales and the empty queue in English and Simplified Chinese; use light and dark themes at 390 and 1280 pixels.

### Post edit

- **Touches:** One `POST /v1/posts/<id>/revisions`/K after the session read; send the current revision in `If-Match`
  and render the returned post. A stale head gets one `GET /v1/posts/<id>`/K so the author can choose to load it.
- **Bound:** Exactly 1 K for a successful edit and at most 1 additional K after a 412; ≤1 D; 0 R/A; constant as
  the thread's post count grows
- **Growth check:** `tests/post-editing-cost.test.ts`: `post edits keep K/D/R/A fixed as post data grows`

### Post delete

- **Touches:** One `DELETE /v1/posts/<id>`/K after the session read; preserve the erased post's thread slot.
- **Bound:** Exactly 1 K and ≤1 D; 0 R/A; constant as the thread's post count grows
- **Growth check:** `tests/post-editing-cost.test.ts`: `post deletions keep K/D/R/A fixed as post data grows`

### Reply image

- **Touches:** Per image, one site `POST /media`, one `PUT /media/<id>` and at most 32 `GET /media/<id>` state reads
  (the backoff reaches 2 s within 2 s of starting, over 60 s at most); each is a single kernel call behind the
  credential prelude. A new thread reserves with `newThread` in place of `containerId`; a 409 means that thread
  already exists, and the same upload reserves again with `containerId`. The reply and thread creation are unchanged
  apart from `mediaIds` (at most 32)
- **Bound:** Per image, 1 reserve K, ≤2 K and ≤1 R for the put, and ≤32 state-read K, each behind ≤1 D; waits start at
  250 ms and double to at most 2 s, stopping by 60 s. The reply and thread creation each remain ≤1 K write
- **Growth check:** `tests/composer-media.test.ts`:
  `a member adds an image to a reply, which uploads through the site and is sent with its media id` records the reserve,
  the put, the state reads and `mediaIds`
  `tests/new-thread-media-cost.test.ts`: `a new thread's opening image keeps K/D/R/A fixed as stored media grows`

### Subject page (`/<locale>/subjects/<id>`)

- **Touches:** Root preferences/D and the subject loader are independent; one public K `POST /v1/pages:read` supplies the
  template, the subject and the template's planned reads; local rendering follows; a merged id redirects without
  another K
- **Bound:** ≤1 K (`pages:read`) and ≤1 D (preferences) for the page itself, plus the Subject library slot's initial reads (1 K signed out; 2 K and 1 D signed in), so ≤2 K and ≤1 D signed out, ≤3 K and ≤2 D signed in, per page view; the kernel behind that read is one subject read
  plus the template's planned reads (at most 16); 0 R/A; O(s) bytes parsed, buffered and rendered, with s at most 512
  facts
- **Growth check:** `tests/request-cost.test.ts`: `subject page stays within its bound as s grows`;
  `services/kernel/test/semantic/growth-reads.test.ts`: `the fact writer refuses more than 512 facts for one subject`;
  `Anchored subject read stays within its bound as the subject's history grows`

### Subject reactions

- **Touches:** In parallel with the subject page, one K `GET /v1/subjects/<id>/reactions` for the counts (at most five
  total rows) and, for a signed-in reader, one K `GET /v1/subjects/<id>/reaction` with the session token for their
  own kind; a change is one `PUT` or `DELETE` `/v1/subjects/<id>/reaction`/K with a new `Idempotency-Key`. A failed
  counts read shows a sentence in place of the cluster and does not break the page
- **Bound:** 1 K signed out and 2 K signed in per page view, 1 K per change; counts and kinds are at most five whatever
  the number of reactions; 0 D/R/A
- **Growth check:** `tests/subject-reactions.test.ts`: `reading a subject costs one counts read, plus one own-reaction read when signed in, at 1, 10 and 100 reactions`

### Subject overview presentation

- **Touches:** The same page read and reaction reads as above; rendering only.
- **Bound:** Unchanged. The header compares its description with the chosen summary once, in linear time in the two
  texts' lengths; the alternate names are filtered against two titles.
- **Order:** header, About (summary, key facts, tags), editions, relations, ratings, reviews, discussion, lists,
  sources. About is the `Summary` node's section: it also draws the first `Statements` node's facts and the subject's
  `schema:keywords` as tags, and that `Statements` node then draws nothing. The header leaves out a description that
  is the summary or starts it (compared as words, ignoring case, spaces and punctuation), and leaves out alternate
  names equal to the title or the original title.
- **Phones:** Below `sm` the reaction row keeps the two most used kinds and the reader's own, on one line; the picker
  lists every kind with its count. `sm` and above show every kind as before. The Library state select is the page's
  one filled primary button; Add to collection is an outline button.
- **Recording:** `bun run record subject-page` rewrites only `src/kernel/recorded/subject-page.json`. It reads the page
  from the spawned kernel after the collections gate is open and the relation and listing projections ran. The
  subject's own statements stay those of `subject.json`.
- **Growth check:** the subject page cost tests above stay as they are.

### Subject page header and reading settings

- **Touches:** One definitions read for the type's name and cover frame, served from the cache when warm (the active
  pointer for 60 s, a release by digest for good). For a signed-in reader, in parallel with the page read, one session
  credential read and one `GET /v1/accounts/<id>/preferences` for `spoilerLevel` and `suitability`; an anonymous reader
  uses the defaults and reads nothing. The header, value views, reveal controls and Sources render locally from the
  page read's subject, cover summary and related fills
- **Bound:** at most 2 K for definitions on a cold cache and 0 when warm, whatever s is; signed in, 1 more K and at most
  1 more D, and a failed settings read shows the default (hidden) page; 0 R/A. Cover images load through the media
  route, one image per cover variant the browser picks, counted under Download. Rendering stays O(s)
- **Growth check:** `tests/request-cost.test.ts`: `subject page stays within its bound as s grows`

### Subject data components

- **Touches:** No request of their own. `Cover`, `Summary`, `Sources`, a forward `Appearances` or `Credits`, and the
  subject header share the page's one subject read; `RelationGroups`, an inverse `Appearances` or `Credits` and
  `CollectionList` render the bodies of the template's planned `links` and `collections` reads. `RatingSummary`,
  `ThreadList` and `ReviewList` plan no read. A read that did not succeed renders its section as a failed state with a
  retry link, and the other sections render from their own reads
- **Bound:** 0 K, D, R and A beyond the page read, and no more than the template's 16 planned reads. A preview renders
  at most its `limit` items (24 for links, 6 for collections) whatever the read returned, so rendering is
  O(limit × sections) plus O(s) for the shared subject read
- **Growth check:** `tests/subject-data-components.test.ts`: `Cover, Summary, RelationGroups, Appearances, Credits, CollectionList and Sources render from their page reads with a bounded preview, a count and a link to the full view`

### Subject relations and lists

- **Touches:** No request of their own beyond the subject route's definitions read for relation labels, which the type
  frame read already warms (the active pointer for 60 s, a release by digest for good). `RelationGroups` and
  `SubjectList` render the bodies of the template's planned inverse `links` reads; `TypeList` renders its `search`
  read. A directed property reads under its inverse label and a symmetric one under its own, a property without a
  relation definition under its own label in the other group. The first `RelationGroups` node renders every
  `RelationGroups` node of the page by relation group. Every list draws its subjects as `CoverCard`s through
  `features/pages/cover-list.tsx`: a preview is one snapping `CoverRow` below `sm` and a `CoverGrid` from `sm` up, a
  full view is a `CoverGrid` at every width. A preview emits both layouts and CSS shows one, so the page needs no
  viewport width on the server
- **Bound:** 0 K, D, R and A beyond the page read and at most 2 K for definitions on a cold cache, 0 when warm. A
  preview renders at most its `limit` items per read (24) whatever the in-degree, twice (row and grid), so rendering is
  O(limit × reads);
  the count is the read's exact or "at least" count, never a total computed here
- **Growth check:** `tests/subject-relations-lists.test.ts`: `SubjectList and TypeList show an exact or at-least count and a See all link to a paged view`

### Subject relations view (`/<locale>/subjects/<id>/relations`)

- **Touches:** In parallel, one subject read for the title, one `GET /v1/subjects/<id>/links` page of at most 100
  holders for one property (`?property=`) or all of them, and for a signed-in reader one preferences read; then the
  cached definitions read for the labels of the properties on the page. The continuation is the kernel's opaque cursor

Full subject views page through their owner list read with the first page's parameters and a cursor. Pages beyond the first are marked `noindex, follow`.

- **Bound:** 2 K (+ 1 K signed in for the session credential, 1 D for preferences) and at most 2 K for definitions on a
  cold cache; one page of at most 100 rows however large the in-degree, so rendering is O(page) and independent of the
  count; 0 R/A
- **Growth check:** `tests/subject-relations-view-cost.test.ts`: `the relations view renders one page of the continuation however large the relation count grows`

### Subject views (`/<locale>/subjects/<id>/<view>`)

- **Touches:** One public K `POST /v1/pages:read` for the view's document and its planned reads, and one for the
  overview, whose previews decide the tab bar (an interim until the per-subject view-count read exists). Root
  preferences/D, the type's definitions (cached) and the tab bar's rendering are local. The overview route computes the
  tab bar from its own read and spends no extra K
- **Bound:** ≤2 K (`pages:read`) and ≤1 D for a view page, plus 1 K more for the reader session when signed in; the
  kernel behind each read is one subject read plus the document's planned reads (at most 16, cost 128); 0 R/A. A full
  view reads one page at the component's `limit` (at most 24), so rendering stays O(limit × sections) plus O(s)
- **Growth check:** `tests/subject-views.test.ts`: `the host renders a tab bar of the views that have data in the documented order, with counts, scrolling on phones without wrapping`; the preview bounds of
  `tests/subject-data-components.test.ts`

### Subject view frame (every `/<locale>/subjects/<id>/<view>` and `/relations`)

- **Touches:** Nothing beyond the reads above: the compact header (xs cover, title, original title, type, date) and
  the view tabs are built from the overview page read the view already makes. The Relations view takes its subject
  from that overview page read (`POST /v1/pages:read`) instead of `GET /v1/subjects/<id>`, so its request count is
  unchanged; type frame and relation labels come from the cached definitions
- **Bound:** A constant number of fields of one subject, however large it is; the same ≤2 K for a view page and 2 K
  for Relations; 0 R/A
- **Growth check:** `tests/subject-view-frame.test.ts`: `the compact header and tabs render without JavaScript and add no kernel read beyond what the view already makes`

### Agent page (`/<locale>/@<handle>` and `/<locale>/@<handle>/<view>`)

- **Touches:** One public K `POST /v1/pages:read` for the account target: the kernel reads the handle once and, chained
  on the account id, the overview's previews. A view page adds one for the overview, whose previews decide the tab bar,
  and a `?cursor=` page adds one `GET /v1/accounts/<id>/posts|threads|collections` for the list's next page. Root
  preferences/D, the subject's definitions (cached) and the rendering are local
- **Bound:** ≤2 K (+ 1 K for a continuation, + 1 K signed in for the session) and ≤1 D; the kernel behind the page
  read is the handle probe plus the document's planned reads (at most 16, cost 128), each list bounded by its `limit`
  (4 in the overview, at most 20 posts, 20 reviews or 24 collections in a view), so the page is O(limit × lists)
  whatever the account's history; 0 R/A
- **Growth check:** `tests/agent-pages-cost.test.ts`: `an agent page reads and renders what its limits bound at 1, 10 and 100 threads, posts and collections`
- **Routing and metadata:** `agentPageQuery` and `agentViewQuery` are public reads ensured by the route loaders and
  reused with `useSuspenseQuery`. The reader's preferences use `agentReaderQuery` with `personalRead`, start in the
  browser after hydration, and keep the server render session-free. The overview and each view supply their own
  locale paths; `pageHead()` describes the public identity with the localized summary, profile card and one
  `ProfilePage` plus `BreadcrumbList` graph.

### Subject library slot

- **Touches:** In parallel with the subject page, read one session credential, the viewer's FULL library entry when
  signed in and the first FULL public-collections page; load the viewer's first 100 FULL collections only when the add
  menu opens
- **Bound:** Initial slot read is 2 K and 1 D signed in with a fresh credential, or 1 K and 0 D signed out; opening
  the add menu adds 1 K and at most 1 D. 0 R/A with a fresh credential. Each list is one page of at most 100 entries,
  independent of account and subject history
- **Growth check:** `tests/library-subject-slot-cost.test.ts`: `subject library slot stays within its bound as its collections grow`

### Credential resolution (media prelude)

- **Touches:** Explicit Authorization bypasses D; otherwise valid configured cookie → D `credential` → media handler
- **Bound:** ≤1 D per request, including malformed media paths; O(t) record/token bytes; no extra K/R; fresh access
  token means 0 A; add the refresh row when due
- **Growth check:** `tests/request-cost.test.ts`: `credential resolution stays within its bound as s grows`

### Token refresh

- **Touches:** Within D: read record → A token grant when access expiry is less than 60 seconds away → replace tokens;
  concurrent callers share one promise
- **Bound:** No additional D/K/R; ≤1 refresh grant per shared attempt plus cold discovery/JWKS work; O(t) bytes, no
  accumulated tokens; only `invalid_grant` deletes the record; any other failure keeps it and returns unavailable
- **Growth check:** `tests/session.test.ts`:
  `the session refreshes its tokens once under concurrent requests, and ends when refresh fails` asserts one refresh for
  five concurrent calls and none after deletion

### Sign-in (`GET /auth/sign-in`)

- **Touches:** Auth configuration/discovery → D login `create` → browser authorization redirect
- **Bound:** 1 D, no token grant; cold discovery only in Worker, then one browser authorization request; constant
  record/body size relative to s/M/t (return path length is input-dependent)
- **Growth check:** `tests/request-cost.test.ts`: `sign-in stays within its bound as s grows`

### Callback (`GET /auth/callback`)

- **Touches:** D `takeLogin` consumes transaction → A code exchange/ID-token validation → D session `create` → redirect
- **Bound:** ≤2 D; ≤1 token grant plus cold discovery/JWKS work; O(t) token/record bytes; mismatched state or declined
  authorization stops before exchange
- **Growth check:** `tests/session.test.ts`: `a callback that does not match the sign-in it answers is refused` asserts
  no token request for forged/missing state or declined authorization; `tests/request-cost.test.ts`:
  `callback stays within its bound as s grows`

### CSRF validation (unsafe requests with a session)

- **Touches:** Exact `SITE_ORIGINS` check and constant-time token comparison before dispatch; token is carried by the
  existing `signedIn`, `credential` and `end` reads
- **Bound:** No new Durable Object method or write; one existing session read for unsafe Start requests; fixed-size
  token work
- **Growth check:** Existing `tests/request-cost.test.ts` bounds remain unchanged

### Sign-out (`POST /auth/sign-out`)

- **Touches:** D `end` waits for in-flight refresh, deletes record/alarm → A refresh-token revocation → Worker builds
  browser logout redirect
- **Bound:** ≤1 D; ≤1 revocation plus cold discovery in D and Worker contexts; any already-running refresh has the bound
  above; ≤1 browser logout request; O(t) bytes, no scan of other sessions
- **Growth check:** `tests/request-cost.test.ts`: `sign-out stays within its bound as s grows`

### Reserve (`POST /media`)

- **Touches:** Credential prelude → K reserve on the named container
- **Bound:** ≤1 D by unguessable session id, exactly 1 K for a valid reservation; 0 R; body bounded at 4 KiB; constant
  in N media objects and U × t uploads over time, no lists or scans; add credential A; kernel work follows content's
  reserve bound
- **Growth check:** `tests/media-reserve.test.ts`:
  `a signed-in uploader reserves through the site and uploads to the address it returns` records the reserve call;
  shared performance harness growth check pending

### Reservation state (`GET /media/<id>`)

- **Touches:** Credential prelude → K read of the named reservation
- **Bound:** ≤1 D by unguessable session id, exactly 1 K; 0 R; constant in N media objects and U × t uploads over time,
  no lists or scans; add credential A; kernel work follows content's read bound
- **Growth check:** `tests/media-reserve.test.ts`: `reservations are read through the site by their uploader only`
  records every read call; shared performance harness growth check pending

### Upload (`PUT /media/<id>`)

- **Touches:** Credential prelude → K reservation read/permission → count/hash stream → R `put` → K `:complete`; failure
  after write begins → R `delete`
- **Bound:** ≤2 K, ≤1 put + ≤1 cleanup delete; add credential D/A; constant buffering per stage, independent of M; O(M)
  bytes streamed and hashed once, bounded by reserved byteCount
- **Growth check:** `tests/upload-memory.test.ts`:
  `an upload holds a bounded number of bytes ahead of storage as the file grows` bounds read-ahead at 1 MiB for 1, 8 and
  64 MiB uploads

### Download (`GET`/`HEAD /media/<id>/<variant>`)

- **Touches:** Credential prelude → K `:authorizeDownload` every request, including conditional → R `head` → R `get` for
  GET only → stream body directly
- **Bound:** ≤1 K; ≤1 head + ≤1 get; add credential D/A; 304/denial uses 0 R, HEAD/416 uses no get; constant media
  buffering, ≤M bytes streamed (0 for HEAD/304), no arrayBuffer/blob read
- **Growth check:** `tests/media.test.ts`:
  `a download asks the kernel on every request and serves ranges, validators and the decided cache policy` asserts one
  decision for 304 and zero for invalid variant; `tests/request-cost.test.ts`:
  `download stays within its bound as s grows` for R

### Offer page (`/<locale>/offers/<id>`)

- **Touches:** Root preferences → D `signedIn`; one anonymous K `GET /v1/offers/<id>?languages=<locale>`, which returns the sold subject's summary (title in the visitor's language, types, cover) in the same response; the price is formatted locally from `unitAmountMinor` and the currency's minor-unit digits. The page renders one idempotency key and reuses it for retries. The browser then loads at most one cover variant through the media route (one K `authorizeDownload`, the media download row). An unknown, hidden or unreadable subject (`null`) never fails the page: the cover area shows the typographic placeholder with the offer title
- **Bound:** 1 K, ≤1 D, 0 R and 0 A for the page; ≤1 download per visit. Constant offer; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `offer page stays within its bound as s grows`, at s = 1, 8 and 64, asserts the one call and its `languages` query

### Checkout start (`POST /checkout`)

- **Touches:** CSRF origin and token checks, then D `credential` → one K `POST /v1/orders` with `{ offerId }` and the page's `Idempotency-Key`
- **Bound:** ≤1 D (credential, with any refresh's A) → 1 K. Constant body; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `checkout start stays within its bound as s grows`

### Order return (`/<locale>/orders/<id>`)

- **Touches:** `/orders/<id>` redirects with the same locale rules as `/` and keeps the query. The buyer read is D `credential` → K `GET /v1/orders/<id>?languages=<locale>`, which returns the order's title and the sold subject's summary in the same response. Pending settlement rechecks every 2 s through `/orders/<id>/status`, which reads without `languages` and answers `{ id, offerId, settlement }`; a recheck never reloads the cover. The browser loads at most one cover variant through the media route on the first render (one K `authorizeDownload`)
- **Bound:** ≤1 D → 1 K per read, and at most 16 reads per return visit because of the pending rechecks; ≤1 download per visit. Constant order; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `order status read stays within its bound as s grows` asserts the one call per status read and the one call, with its `languages` query, per page read. The 16-read visit limit is derived from the page's polling constants.

### Storybook (`bun run storybook`)

- **Touches:** Static story modules replay committed kernel responses, including the board, thread page, post page,
  matching search and empty search, through `createRecordedKernelFetch`; page and shell browser checks use local
  Chromium
- **Bound:** No request-path work; development tooling only; each recording is one kernel request per listed entry
- **Growth check:** `tests/page-stories.test.ts`: browser accessibility and replay checks run through the root gate

### Recording (`bun run record`)

- **Touches:** Start disposable PostgreSQL, OpenSearch and the kernel; create the account, subject, board and thread,
  then record the subject, missing subject, board, thread page, thread, post page, matching search and empty search as
  status and JSON in `src/kernel/recorded/`
- **Bound:** Subject create, the listed reads, and one in-process search kernel for the two search responses;
  development tooling only; disposable database and search node removed after recording
- **Growth check:** `scripts/record.ts`: fixed request list; prerequisites documented above

### Presentation curation (`/<locale>/curate/presentation`)

- **Touches:** Credential prelude → K active pointer → K immutable profile; publish → K profile write → K activation at
  expected head
- **Bound:** Opening: 2 K reads (immutable profile cacheable forever); publishing: 2 K writes; add credential D/A.
  Listing and editing are linear in the profile, bounded by `MAX_PROFILE_TEMPLATES` (128 keyed templates) and
  `MAX_PROFILE_BYTES` (1 MiB); no public-page work
- **Growth check:** `tests/curate-presentation.test.ts`: template listing, immutable edits, publish/activate order and
  refusal handling

### Zone pages (`/<locale>/zones/<id>`)

- **Touches:** One anonymous `POST /v1/zones/<id>:readPage` returns the public Zone header and the existing page
  presentation. Subject pages add the subject page reads used by their global routes. The shared presentation renderer
  applies the Zone's appearance tokens around each page, with page tokens taking precedence. Subject canonicals point
  to `/<locale>/subjects/<id>`.
- **Bound:** One Zone read per page view, plus the common subject page reads. A server render follows no more than four
  `202` continuations. If work remains, it returns a no-store `503` preparing page and the browser resumes with the last
  cursor. Personal subject controls load after hydration.
- **Growth check:** `tests/zone-shell.test.ts` asserts that a home uses one Zone read and that a subject page adds one
  request to the existing common subject reads.

### Sitemap export

- **Touches:** One daily Workflow normally walks each feed once in cursor order, with one full restart if a cursor is
  rejected. A feed step reads at most 20 pages, targets 2,000 families, and holds at most 3,000 when its last page fills
  the gap; each shard gets one R2 `head` and a
  `put` only when it is absent. Each feed keeps its file list in `runs/`; publication stages a run record and
  conditionally puts `index.xml` after every feed finishes, then lists `shards/` and `runs/` for retention cleanup.
- **Bound:** Feed requests are about N / 1,000 plus empty pages, a possible full restart, and retries. Each instance
  runs at most 4,990 feed steps before continuing in a new instance with its cursor. At 50 million families a run
  reads about 50,000 pages and writes up to about 17,000 shards when everything changed. Workers Free's 10 ms CPU
  limit cannot run these steps; the export requires Paid Workers.
- **Growth check:** `tests/sitemap-export.test.ts` runs 3,000, 30,000 and 300,000 synthetic families and checks linear
  feed reads, R2 operations and steps, plus the maximum families held by one step.
- **Feeds:** Boards, threads, Realms and Spaces use their typed kernel sitemap feeds; stalled pages are detected by
  item order rather than cursor tokens.

## Admitted controls

`src/kernel/exposure.ts` maps the site's gated operation IDs to the groups declared in OpenAPI. Controls use
`useOperation` or `Exposure` with an operation ID. Missing groups, pending reads and failed reads hide the controls;
the kernel still enforces admission and the existing `platform_closed` responses handle a stale admitted set.

Public renders share one anonymous exposure promise per isolate for 60 seconds, including failures and concurrent
requests. This read uses no session or credential, so a session cookie cannot change the public admitted set. After
hydration, a signed-in viewer uses one GET server function through TanStack Query, with a 60-second `staleTime` next
to the session query. No personal admitted set enters the server-rendered query cache. Anonymous browser reads
reuse the isolate's anonymous entry. The fake defaults to no admitted groups: set `Fixtures.admitted`, or call
`setFakeAdmitted` for recorded stories. Storybook's `admitted` parameter selects the review set.

Its cost is under Cost.

Public composition previews keep their readable content when a group is closed. Links to individual collections
require `collection.get`; an account collection list's continuation requires `account.collections`, since later
pages use that standalone operation rather than the public composition read.
