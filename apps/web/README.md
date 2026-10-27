Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.
Vite pre-bundles browser dependencies by scanning the site routes and their imported components before the first page load.
Run `bun run storybook` to browse the page stories. Run `bun run record` to create committed page recordings; it needs Docker with permission to start a disposable PostgreSQL container and Bun, and does not use a development kernel or database.
The Worker inspector is off by default; `WORKER_INSPECTOR_PORT=<port> bun run dev` opens it on that port for DevTools.
Browser tests wait for `html[data-hydrated]` before interacting with a page.
Subject page reads and public collections work without JavaScript; Library writes use JavaScript and stay disabled until the page hydrates.

`bun run test` runs tests in a private network namespace containing only loopback, so host interface changes do not interrupt browsers.
Tests needing the host network, such as a container's published port, are named `*.host.test.ts` and run on the host through `bun run test:host`; never put a browser in one.

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
Only routes that use the credential resolve tokens, currently `/media` and `/media/…`, `POST /checkout`, and order reads.
Offer pages and other pages read the session's presence, lifetime and CSRF token from its Durable Object alongside theme
preferences, without refreshing tokens or contacting Auth. Missing, invalid, expired or unreadable sessions render as signed
out without changing the cookie. Media requests, checkout start and order reads resolve before calling the kernel, so
unreachable Auth returns 502 even for downloads that otherwise conceal upstream errors. An explicit
`Authorization` header skips credential resolution; an unsafe request with a session cookie still validates its token.
Unsafe requests carrying that cookie require an exact allowed `Origin` and the session's CSRF token in
`X-CSRF-Token`. The only form-field exception is the sign-out form's `csrf_token` field. The signed-in document head
contains the token in a `csrf-token` meta element; it is never placed in a cookie.

Sign-in uses `GET /auth/sign-in?return_to=/ja`, followed by `GET /auth/callback`. Sign-out uses `POST /auth/sign-out`.
The header offers a sign-in document link returning to the current path and query, or an account menu with a security
settings link at `<AUTH_ISSUER origin>/security` and a sign-out form that revokes the session and ends it at Auth. The
menu and form work without JavaScript. When session configuration is missing, neither sign-in nor account controls
appear.
Login transactions expire after 10 minutes; sessions expire 30 days after sign-in. The `SESSIONS` Durable Object binding
stores both in SQLite, with one instance per login transaction or session. Development simulates the objects locally.
Reads use two Worker rate-limit bindings: `READS_10S` has namespace `1001`, limit `100`, and period `10` seconds;
`READS_60S` has namespace `1002`, limit `300`, and period `60` seconds. GET and HEAD requests consume both. Active
sessions share `account:<sub>` limits, signed-out requests with a well-formed session or login cookie use
`session:<id>`, and other requests use `ip:<CF-Connecting-IP>`.

Configure these variables in the environment of `bun run dev`:

- `AUTH_ISSUER`: Auth's exact OpenID issuer identifier. HTTPS is required except for loopback development issuers
  (`127.0.0.1`, `localhost`, or `[::1]`).
- `API_RESOURCE`: the API's RFC 8707 resource identifier and access token audience, exactly `https://api.rezics.com`
  in production, with no trailing slash. Tests use `https://api.rezics.test`.
- `WEBSITE_SCOPES`: exactly the space-separated scopes registered for the website client, including `openid offline_access`, never a wildcard.
  Media routes need `media:create`, `media:read_reservation`, `media:read`, `media:complete` and `media:erase`;
  posting routes need `thread:create` and `post:create`; reactions need `reaction:set`; presentation curation needs `presentation:publish` and
  `presentation:activate`; checkout start needs `order:create` and the order return page needs `order:read`.
  Offer pages and other public reads need no scope. Sign-in requests
  `openid offline_access` followed by these scopes, each once.
- `WEBSITE_CLIENT_ID`: the confidential website client id, `rezics-website`.
- `SITE_ORIGINS`: comma-separated exact origins (scheme, host and optional port, with no trailing slash). Production
  requires this variable. Development uses the dev server's own origin when it is unset.
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
    'openid',
    'offline_access',
    ...[...mountedWebsiteActions].filter(([, action]) => !action.anonymous).map(([name]) => name),
  ],
};
await auth.internal.registerWebsiteClient(registration);
// Deploy this exact string as the Worker's WEBSITE_SCOPES text variable.
const websiteScopes = registration.scopes.join(' ');
```

The catalogue must include the five media scopes above, the posting scopes `thread:create` and `post:create`,
`reaction:set`,
the curation scopes `presentation:publish` and `presentation:activate`, and `order:create` and `order:read`.
Registration and `WEBSITE_SCOPES` must change together
when more protected site features are mounted. Auth's [website contract](../../services/auth/README.md#website-client)
defines registration and key rotation.

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
`http://127.0.0.1:3000/`, and exactly these scopes for the current media, posting, presentation curation and checkout routes:
`openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read`.
From `apps/web`, run:

```sh
AUTH_ISSUER=http://127.0.0.1:4200 \
API_RESOURCE=https://api.rezics.test \
WEBSITE_CLIENT_ID=rezics-website \
WEBSITE_CLIENT_KEY="$(cat .temp/website-private.jwk)" \
WEBSITE_SCOPES='openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read' \
KERNEL_ORIGIN=http://127.0.0.1:4300 \
bun run dev --host 127.0.0.1 --port 3000 --strictPort
```

Use the same hostname throughout so Auth's session cookie reaches `/authorize` and `/logout`.
Sign in with the person's password at Auth before following the site's sign-in link. Local HTTP changes neither
the HTTPS API resource nor the issuer audience in client assertions. The automated proof needs Docker and runs
from the repository root with `bun test apps/web/tests/auth-binding.host.test.ts`; it creates and removes its own
migrated database, Auth listener and site process, and waits for the real five-minute token's refresh threshold.

Set `KERNEL_ORIGIN`, the content API's origin, in the environment of `bun run dev`, for example
`KERNEL_ORIGIN=http://127.0.0.1:3000 bun run dev`. Production supplies it as a Worker variable. When it is missing,
media routes return 503 while the rest of the site continues to work. Subject pages read through `@rezics/client`; in
development, when `KERNEL_ORIGIN` is unset, subject reads use the local route fixtures. Production requires it for
subject reads.

### Storybook and page recordings

Run `bun run storybook` from this directory to browse the page stories. The browser stories replay the committed
kernel responses and run as part of `bun run check`. To refresh those responses, run `bun run record`. It needs Bun,
Docker access to start a disposable PostgreSQL container and a disposable OpenSearch container, and permission to run
the kernel. The recorder migrates the disposable database, creates a recording account with governance authority,
signs a short-lived test token, and creates the launch subject through `POST /v1/subjects`. It then inserts a published
board and a published thread with three posts, and records the board, its first thread page, the thread, and its first
post page. The kernel server does not mount subject search, so the recorder indexes that subject in its OpenSearch
node and records `POST /v1/subjects:search` through an in-process kernel: one query that matches the subject and one
that matches nothing. It also records the subject read and a missing ID. It stops the kernel and removes the containers
it started on success and failure; it does not use a development kernel, the shared search node, or a shared database.

Run `bun run screenshots` to capture every story in all eight locales and both themes for review by eye.
The command builds Storybook once into a temporary directory, serves that build on a free port, and writes a
full-page PNG after the story has rendered and fonts have loaded. The default viewport is 1280×720 CSS pixels.
Files are named `<story id>.<locale>.<theme>.png` and land in `.temp/screenshots/` at the repository root.
A subject-page capture at that viewport is 1280×721 pixels. Choose a story id or glob, and repeat locale and theme,
with:

```sh
bun run screenshots [--story <id or glob>] [--locale <code>]... [--theme light|dark]... [--width <px>] [--out <dir>]
```

The defaults are every story, `en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr` and `es`, both `light` and `dark`,
1280 pixels wide, and `.temp/screenshots/`. The script captures four pages at a time, prints one path per file and
then the total, and stops the server when it exits.

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

## Cost

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

Follow-ups below are proposed tests in `tests/request-cost.test.ts`, counting calls through the fake kernel and session
at s = 1, 8, 64; they are not existing coverage or measurements. Existing tests cited cover only the stated call assertion.

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

- **Touches:** Two local Cloudflare rate-limit bindings before route handling, keyed by active account, valid
  session/login cookie, or client IP
- **Bound:** 2 `limit()` calls; 0 added K/D/R/A; the request's existing session read supplies the signed-in key;
  refusals stop before K
- **Growth check:** `tests/checkout-cost.test.ts`: `read rate limits stay within their bound as s grows`

### Platform gates

- **Touches:** Shared kernel-client recognition checks the problem body from an existing gated read; the root error
  component renders the localized closed page. Media reservation and checkout start keep the kernel's 403 problem.
- **Bound:** One single-read page request uses exactly 1 existing K and at most 1 existing D for signed-in root session
  state; 0 R/A. Board and thread pages use at most 2 existing K. Recognition adds 0 K/D/R/A and inspects one bounded
  problem body, with no work per catalog entry.
- **Growth check:** `tests/platform-closed-cost.test.ts`: `closed page reads keep K/D/R/A fixed as existing page data grows`

### Locale resolution (`/`)

- **Touches:** URL, locale cookie, then weighted `Accept-Language`, then English; redirect before page loaders
- **Bound:** K/D/R/A = 0; no body buffered; header parsing/sorting depends on header length, not database size
- **Growth check:** `tests/request-cost.test.ts`: `locale resolution stays within its bound as s grows`

### Search page (`/<locale>/search`)

- **Touches:** In parallel: one `POST /v1/subjects:search` and one `POST /v1/subjects:facets`; active definitions digest
  cached for 60 s and release cached by digest without expiry
- **Bound:** 2 K and 0 D per search; result page is at most 100 entries and facet work is bounded to 8 properties × 10
  values; 0 R/A
- **Growth check:** `tests/search-facets.test.ts`:
  `searches read the definitions release once per digest and make two kernel reads each`

### Suggestions (shell typeahead)

- **Touches:** One site GET route calls `subjects:suggest` with a constant cap; browser waits 200 ms after typing pauses
  and cancels stale requests
- **Bound:** 1 K per request with a constant result cap, 0 D, 0 R and 0 A. The browser sends at most one request per
  pause
- **Growth check:** `tests/request-cost.test.ts`: `suggestions stay within their bound as s grows`

### Home page (`/<locale>`)

- **Touches:** Root preferences → D `signedIn` with a valid configured session cookie; one `POST /v1/pages:read`
  for route `/`, including the platform search box, vertical links and type lists
- **Bound:** ≤1 K (four searches of at most 12 subjects each inside the page read), ≤1 D, 0 R/A; O(t) session bytes
  and O(document + read results) rendering, bounded by composition limits; no result, label or media calls per item
- **Growth check:** `tests/session-controls.test.ts`:
  `pages read the signed-in state without contacting Auth or refreshing tokens` asserts zero A;
  `tests/request-cost.test.ts`: `home page stays within its bound as s grows` for D/K

### Board page (`/<locale>/boards/<id>`)

- **Touches:** Root preferences/D and public board plus thread-page K reads; preserve kernel thread order and pass
  `next` as the paging cursor
- **Bound:** ≤2 K (board and one page of at most s ≤ 100 threads), ≤1 D, 0 R/A; work and buffered JSON are O(s)
- **Growth check:** `tests/request-cost.test.ts`: `board page stays within its bound as s grows`

### New-thread page (`/<locale>/boards/<id>/new`)

- **Touches:** Root preferences/D and one public board K read; no thread list is loaded
- **Bound:** ≤1 K, ≤1 D, 0 R/A; constant
- **Growth check:** `tests/posting.test.ts`: `a signed-in member starts a thread from its board and lands on it` records
  the page and write kernel calls

### Thread page (`/<locale>/threads/<id>`)

- **Touches:** Root preferences/D and thread plus post-page K reads started together; render each page body locally with
  `DocumentBody`. Reactions add no read, because counts and the viewer's kind come with the thread and post-page reads.
  A signed-in page read resolves the session credential once and sends it on those two reads
- **Bound:** ≤2 K started together (thread and one page of at most s ≤ 100 posts), ≤1 D, 0 R/A; work is O(total body
  size of the page), each body capped at 2 MiB (ADR-0036)
- **Growth check:** `tests/request-cost.test.ts`: `thread page stays within its bound as s grows`
- **Growth check:** `tests/reactions-cost.test.ts`: `thread page reads stay within their bound as s grows`

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

### My collections and following

- **Touches:** Each page reads one signed-in session and one `GET /v1/collections?curatorAccountId=…&view=FULL` or
  `GET /v1/follows?view=FULL`; unfollow sends one `DELETE /v1/follows/<targetId>` with an idempotency key. Labels are
  embedded in the list response.
- **Bound:** Each page uses 1 K, 1 D, 0 R and 0 A and returns at most 100 entries. Unfollow uses at most 1 K and 1 D;
  no page does one read per collection or followed target.
- **Growth check:** `tests/library-mine-cost.test.ts`: `my collections and following stay within their bound as list size grows`

### Personal library

- **Touches:** One session read and `GET /v1/libraryEntries?view=FULL` for one page of at most 100 entries. A state
  change is one `PUT /v1/libraryEntries/<subjectId>` or `DELETE /v1/libraryEntries/<subjectId>?revision=` after that
  session read.
- **Bound:** A view is 1 D, 1 K, 0 R and 0 A. A state change is 1 D and 1 K write, 0 R and 0 A. The list is one page of
  at most 100 entries. No per-entry reads.
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
- **Growth check:** `tests/new-thread-media-cost.test.ts`: `a new thread's opening image keeps K/D/R/A fixed as stored media grows`

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

- **Touches:** Root preferences → D `signedIn`; one anonymous K `GET /v1/offers/<id>`; the price is formatted locally from `unitAmountMinor` and the currency's minor-unit digits. The page renders one idempotency key and reuses it for retries
- **Bound:** 1 K, ≤1 D, 0 R and 0 A. Constant offer; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `offer page stays within its bound as s grows`

### Checkout start (`POST /checkout`)

- **Touches:** CSRF origin and token checks, then D `credential` → one K `POST /v1/orders` with `{ offerId }` and the page's `Idempotency-Key`
- **Bound:** ≤1 D (credential, with any refresh's A) → 1 K. Constant body; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `checkout start stays within its bound as s grows`

### Order return (`/<locale>/orders/<id>`)

- **Touches:** `/orders/<id>` redirects with the same locale rules as `/` and keeps the query. The buyer read is D `credential` → K `GET /v1/orders/<id>`. Pending settlement rechecks every 2 s for at most 30 s
- **Bound:** ≤1 D → 1 K per read, and at most 16 reads per return visit because of the pending rechecks. Constant order; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `order status read stays within its bound as s grows`. The 16-read visit limit is derived from the page's polling constants.

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
