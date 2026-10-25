Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.
The Worker inspector is off by default; `WORKER_INSPECTOR_PORT=<port> bun run dev` opens it on that port for DevTools.
Browser tests wait for `html[data-hydrated]` before interacting with a page.

`bun run test` runs tests in a private network namespace containing only loopback, so host interface changes do not interrupt browsers.
Tests needing the host network, such as a container's published port, are named `*.host.test.ts` and run on the host through `bun run test:host`; never put a browser in one.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

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
Only routes that use the credential resolve tokens, currently `/media` and `/media/…`. Pages read the session's presence and lifetime
from its Durable Object alongside theme preferences, without refreshing tokens or contacting Auth. Missing, invalid,
expired or unreadable sessions render as signed out without changing the cookie. Media requests resolve before calling
the kernel, so unreachable Auth returns 502 even for downloads that otherwise conceal upstream errors. An explicit
`Authorization` header skips session resolution.
Unsafe requests carrying that cookie require an `Origin` equal to the site's own origin.

Sign-in uses `GET /auth/sign-in?return_to=/ja`, followed by `GET /auth/callback`. Sign-out uses `POST /auth/sign-out`.
The header offers a sign-in document link returning to the current path and query, or a sign-out form that revokes
the session and ends it at Auth. Both work without JavaScript. When session configuration is missing, neither appears.
Login transactions expire after 10 minutes; sessions expire 30 days after sign-in. The `SESSIONS` Durable Object binding
stores both in SQLite, with one instance per login transaction or session. Development simulates the objects locally.

Configure these variables in the environment of `bun run dev`:

- `AUTH_ISSUER`: Auth's exact OpenID issuer identifier. HTTPS is required except for loopback development issuers
  (`127.0.0.1`, `localhost`, or `[::1]`).
- `API_RESOURCE`: the API's RFC 8707 resource identifier and access token audience, exactly `https://api.rezics.com`
  in production, with no trailing slash. Tests use `https://api.rezics.test`.
- `WEBSITE_SCOPES`: exactly the space-separated scopes registered for the website client, including `openid offline_access`, never a wildcard.
  Media routes need `media:create`, `media:read_reservation`, `media:read`, `media:complete` and `media:erase`;
  public reads need no scope. Sign-in requests `openid offline_access` followed by these scopes, each once.
- `WEBSITE_CLIENT_ID`: the confidential website client id, `rezics-website`.
- `WEBSITE_CLIENT_KEY`: a private P-256 JWK with a `kid`, used for ES256 client assertions. In production this is a
  Worker secret; supply it through Cloudflare's secret management, never through a config file or build output.
  `AUTH_ISSUER`, `API_RESOURCE`, `WEBSITE_SCOPES` and `WEBSITE_CLIENT_ID` are production Worker text variables.

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

For production, set `WEBSITE_CLIENT_ID=rezics-website`, `API_RESOURCE=https://api.rezics.com`,
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

The catalogue must include the five media scopes above. Registration and `WEBSITE_SCOPES` must change together
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
`http://127.0.0.1:3000/`, and, for the current media routes, exactly these scopes:
`openid offline_access media:create media:read_reservation media:read media:complete media:erase`.
From `apps/web`, run:

```sh
AUTH_ISSUER=http://127.0.0.1:4200 \
API_RESOURCE=https://api.rezics.test \
WEBSITE_CLIENT_ID=rezics-website \
WEBSITE_CLIENT_KEY="$(cat .temp/website-private.jwk)" \
WEBSITE_SCOPES='openid offline_access media:create media:read_reservation media:read media:complete media:erase' \
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

## Cost

The web Goal owns this Worker app. These bounds follow `src/server.ts`, `src/routes/`, `src/kernel/`,
`src/session/` and `src/media/`; they count outbound work, not the kernel's internal query cost.
The criterion is a bounded neighbourhood per request, about changes × log N; constant engine overhead is acceptable,
while dependence on all subjects, sessions or a person's history is not. No path here enumerates those totals.
K means kernel API requests, D means `SESSIONS` Durable Object method calls, R means R2 operations and A means Auth
HTTP requests; omitted categories are zero. Arrows mean sequential work. Bounds include early exits as smaller costs.

Let s count the subject payload's entries (including labels, aliases, statements, qualifiers, references and related
subjects, even entries filtered out before display), the board page's threads, or the thread page's posts, as applicable;
M is one media object's bytes, and t is tokens or stored entries in one session object. Home shows only a heading;
subject reads have no pagination or app-side cap on s. Board and thread reads use the kernel's default page size, at most
100 entries.
Each SQLite object has one `record` and an expiry alarm: a login record holds state, nonce, PKCE verifier, return path
and expiry (10 minutes); a session record holds subject, access/refresh/ID tokens and expiries (30 days from sign-in).
Thus t is capped by one fixed-shape record with three token slots; refresh overwrites them rather than appending history.
Metadata, text and token lengths have no explicit byte caps here, so O(s) and O(t) byte bounds assume fixed-size entries;
otherwise use their actual encoded bytes. Constant buffers below mean independent of s, M and t, excluding those inputs.
Auth discovery is cached per configuration and execution context, with failed discovery evicted; A below names endpoint
work plus cache-miss discovery and, for signed token validation, SDK JWKS fetching, rather than assuming warm caches.
This is constant endpoint work in s/M/t; cache misses must be exercised independently of page size.
Browser redirects to authorization/logout are separate Auth requests, not Worker fetches.
The development-only fixture kernel scans fixture arrays; it is not evidence for production kernel complexity.

Follow-ups below are proposed tests in `tests/request-cost.test.ts`, counting calls through the fake kernel and session
at s = 1, 8, 64; they are not existing coverage or measurements. Existing tests cited cover only the stated call assertion.

| Operation                                     | Touches                                                                                                                                                                                         | Bound                                                                                                                                                                                                                                      | Growth check                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locale resolution (`/`)                       | URL, locale cookie, then weighted `Accept-Language`, then English; redirect before page loaders                                                                                                 | K/D/R/A = 0; no body buffered; header parsing/sorting depends on header length, not database size                                                                                                                                          | `tests/request-cost.test.ts`: `locale resolution stays within its bound as s grows`                                                                                                                                                                                         |
| Search page (`/<locale>/search`)              | One kernel `POST /v1/subjects:search` for a non-empty query, at most 100 results; an empty query renders only the form                                                                          | 1 K (one page of at most s ≤ 100 results), ≤1 D, 0 R and 0 A. Work and buffered JSON are O(s), and an empty query makes 0 K                                                                                                                | `tests/request-cost.test.ts`: `search page stays within its bound as s grows`                                                                                                                                                                                               |
| Suggestions (shell typeahead)                 | One site GET route calls `subjects:suggest` with a constant cap; browser waits 200 ms after typing pauses and cancels stale requests                                                            | 1 K per request with a constant result cap, 0 D, 0 R and 0 A. The browser sends at most one request per pause                                                                                                                              | `tests/request-cost.test.ts`: `suggestions stay within their bound as s grows`                                                                                                                                                                                              |
| Home page (`/<locale>`)                       | Root preferences → D `signedIn` with a valid configured session cookie; static heading                                                                                                          | ≤1 D, 0 K/R/A; O(t) record bytes, constant page output; no result, label or media calls per item                                                                                                                                           | `tests/session-controls.test.ts`: `pages read the signed-in state without contacting Auth or refreshing tokens` asserts zero A; `tests/request-cost.test.ts`: `home page stays within its bound as s grows` for D/K                                                         |
| Board page (`/<locale>/boards/<id>`)          | Root preferences/D and public board plus thread-page K reads; preserve kernel thread order and pass `next` as the paging cursor                                                                 | ≤2 K (board and one page of at most s ≤ 100 threads), ≤1 D, 0 R/A; work and buffered JSON are O(s)                                                                                                                                         | `tests/request-cost.test.ts`: `board page stays within its bound as s grows`                                                                                                                                                                                                |
| Thread page (`/<locale>/threads/<id>`)        | Root preferences/D and thread plus post-page K reads started together; render each page body locally with `DocumentBody`                                                                        | ≤2 K started together (thread and one page of at most s ≤ 100 posts), ≤1 D, 0 R/A; work is O(total body size of the page), each body capped at 2 MiB (ADR-0036)                                                                            | `tests/request-cost.test.ts`: `thread page stays within its bound as s grows`                                                                                                                                                                                               |
| Subject page (`/<locale>/subjects/<id>`)      | Root preferences/D and subject loader are independent; one public K `GET /v1/subjects/<id>` supplies subject and related labels; local rendering follows; merged ID redirects without another K | ≤1 K + ≤1 D; 0 R/A; O(s) parsing/rendering and buffered JSON plus O(t) session bytes; **exceeds the criterion** for a bounded neighbourhood because the full subject payload has no s cap; no N+1 for results, labels or media             | Follow-up: `subject page stays within its bound as s grows`                                                                                                                                                                                                                 |
| Credential resolution (media prelude)         | Explicit Authorization bypasses D; otherwise valid configured cookie → D `credential` → media handler                                                                                           | ≤1 D per request, including malformed media paths; O(t) record/token bytes; no extra K/R; fresh access token means 0 A; add the refresh row when due                                                                                       | `tests/request-cost.test.ts`: `credential resolution stays within its bound as s grows`                                                                                                                                                                                     |
| Token refresh                                 | Within D: read record → A token grant when access expiry is less than 60 seconds away → replace tokens; concurrent callers share one promise                                                    | No additional D/K/R; ≤1 refresh grant per shared attempt plus cold discovery/JWKS work; O(t) bytes, no accumulated tokens; only `invalid_grant` deletes the record; any other failure keeps it and returns unavailable                     | `tests/session.test.ts`: `the session refreshes its tokens once under concurrent requests, and ends when refresh fails` asserts one refresh for five concurrent calls and none after deletion                                                                               |
| Sign-in (`GET /auth/sign-in`)                 | Auth configuration/discovery → D login `create` → browser authorization redirect                                                                                                                | 1 D, no token grant; cold discovery only in Worker, then one browser authorization request; constant record/body size relative to s/M/t (return path length is input-dependent)                                                            | `tests/request-cost.test.ts`: `sign-in stays within its bound as s grows`                                                                                                                                                                                                   |
| Callback (`GET /auth/callback`)               | D `takeLogin` consumes transaction → A code exchange/ID-token validation → D session `create` → redirect                                                                                        | ≤2 D; ≤1 token grant plus cold discovery/JWKS work; O(t) token/record bytes; mismatched state or declined authorization stops before exchange                                                                                              | `tests/session.test.ts`: `a callback that does not match the sign-in it answers is refused` asserts no token request for forged/missing state or declined authorization; `tests/request-cost.test.ts`: `callback stays within its bound as s grows`                         |
| Sign-out (`POST /auth/sign-out`)              | D `end` waits for in-flight refresh, deletes record/alarm → A refresh-token revocation → Worker builds browser logout redirect                                                                  | ≤1 D; ≤1 revocation plus cold discovery in D and Worker contexts; any already-running refresh has the bound above; ≤1 browser logout request; O(t) bytes, no scan of other sessions                                                        | `tests/request-cost.test.ts`: `sign-out stays within its bound as s grows`                                                                                                                                                                                                  |
| Reserve (`POST /media`)                       | Credential prelude → K reserve on the named container                                                                                                                                           | ≤1 D by unguessable session id, exactly 1 K for a valid reservation; 0 R; body bounded at 4 KiB; constant in N media objects and U × t uploads over time, no lists or scans; add credential A; kernel work follows content's reserve bound | `tests/media-reserve.test.ts`: `a signed-in uploader reserves through the site and uploads to the address it returns` records the reserve call; shared performance harness growth check pending                                                                             |
| Reservation state (`GET /media/<id>`)         | Credential prelude → K read of the named reservation                                                                                                                                            | ≤1 D by unguessable session id, exactly 1 K; 0 R; constant in N media objects and U × t uploads over time, no lists or scans; add credential A; kernel work follows content's read bound                                                   | `tests/media-reserve.test.ts`: `reservations are read through the site by their uploader only` records every read call; shared performance harness growth check pending                                                                                                     |
| Upload (`PUT /media/<id>`)                    | Credential prelude → K reservation read/permission → count/hash stream → R `put` → K `:complete`; failure after write begins → R `delete`                                                       | ≤2 K, ≤1 put + ≤1 cleanup delete; add credential D/A; constant buffering per stage, independent of M; O(M) bytes streamed and hashed once, bounded by reserved byteCount                                                                   | `tests/upload-memory.test.ts`: `an upload holds a bounded number of bytes ahead of storage as the file grows` bounds read-ahead at 1 MiB for 1, 8 and 64 MiB uploads                                                                                                        |
| Download (`GET`/`HEAD /media/<id>/<variant>`) | Credential prelude → K `:authorizeDownload` every request, including conditional → R `head` → R `get` for GET only → stream body directly                                                       | ≤1 K; ≤1 head + ≤1 get; add credential D/A; 304/denial uses 0 R, HEAD/416 uses no get; constant media buffering, ≤M bytes streamed (0 for HEAD/304), no arrayBuffer/blob read                                                              | `tests/media.test.ts`: `a download asks the kernel on every request and serves ranges, validators and the decided cache policy` asserts one decision for 304 and zero for invalid variant; `tests/request-cost.test.ts`: `download stays within its bound as s grows` for R |

The subject JSON body and rendered data grow with uncapped s, even though related labels arrive in the same response and there are no per-item server calls.
