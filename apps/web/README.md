Run the site locally with `bun run dev` from `apps/web`. Run `bun run check` to generate, type-check, test, and build.
Browser tests wait for `html[data-hydrated]` before interacting with a page.

The Cloudflare Vite plugin deploys with `cf deploy` (not run here).

Every launch locale, including English, has a URL prefix.
Locale selection uses URL, `rezics_locale` cookie, `Accept-Language`, then English; language tags match exact locale, Chinese script or region, then base language.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`PUT /media/<id>` transports a reserved upload; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
Viewer credentials come from an explicit `Authorization` header, forwarded unchanged, or from the person's server-side
session. Access and refresh tokens stay in the Worker; the browser holds an opaque `__Host-rezics_session` cookie.
Only routes that use the credential resolve tokens, currently `/media/`. Pages read the session's presence and lifetime
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
subjects, even entries filtered out before display), M be one media object's bytes, and t be tokens or stored entries
in one session object. Home shows only a heading; subject reads have no pagination or app-side cap on s.
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

| Operation                                     | Touches                                                                                                                                                                                         | Bound                                                                                                                                                                                                                          | Growth check                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locale resolution (`/`)                       | URL, locale cookie, then weighted `Accept-Language`, then English; redirect before page loaders                                                                                                 | K/D/R/A = 0; no body buffered; header parsing/sorting depends on header length, not database size                                                                                                                              | Follow-up: `locale resolution stays within its bound as s grows`                                                                                                                                                                                                            |
| Home page (`/<locale>`)                       | Root preferences → D `signedIn` with a valid configured session cookie; static heading                                                                                                          | ≤1 D, 0 K/R/A; O(t) record bytes, constant page output; no result, label or media calls per item                                                                                                                               | `tests/session-controls.test.ts`: `pages read the signed-in state without contacting Auth or refreshing tokens` asserts zero A; follow-up: `home page stays within its bound as s grows` for D/K                                                                            |
| Subject page (`/<locale>/subjects/<id>`)      | Root preferences/D and subject loader are independent; one public K `GET /v1/subjects/<id>` supplies subject and related labels; local rendering follows; merged ID redirects without another K | ≤1 K + ≤1 D; 0 R/A; O(s) parsing/rendering and buffered JSON plus O(t) session bytes; **exceeds the criterion** for a bounded neighbourhood because the full subject payload has no s cap; no N+1 for results, labels or media | Follow-up: `subject page stays within its bound as s grows`                                                                                                                                                                                                                 |
| Credential resolution (media prelude)         | Explicit Authorization bypasses D; otherwise valid configured cookie → D `credential` → media handler                                                                                           | ≤1 D per request, including malformed media paths; O(t) record/token bytes; no extra K/R; fresh access token means 0 A; add the refresh row when due                                                                           | Follow-up: `credential resolution stays within its bound as s grows`                                                                                                                                                                                                        |
| Token refresh                                 | Within D: read record → A token grant when access expiry is less than 60 seconds away → replace tokens; concurrent callers share one promise                                                    | No additional D/K/R; ≤1 refresh grant per shared attempt plus cold discovery/JWKS work; O(t) bytes, no accumulated tokens; invalid grant deletes record, transport failure returns unavailable                                 | `tests/session.test.ts`: `the session refreshes its tokens once under concurrent requests, and ends when refresh fails` asserts one refresh for five concurrent calls and none after deletion                                                                               |
| Sign-in (`GET /auth/sign-in`)                 | Auth configuration/discovery → D login `create` → browser authorization redirect                                                                                                                | 1 D, no token grant; cold discovery only in Worker, then one browser authorization request; constant record/body size relative to s/M/t (return path length is input-dependent)                                                | Follow-up: `sign-in stays within its bound as s grows`                                                                                                                                                                                                                      |
| Callback (`GET /auth/callback`)               | D `takeLogin` consumes transaction → A code exchange/ID-token validation → D session `create` → redirect                                                                                        | ≤2 D; ≤1 token grant plus cold discovery/JWKS work; O(t) token/record bytes; mismatched state or declined authorization stops before exchange                                                                                  | `tests/session.test.ts`: `a callback that does not match the sign-in it answers is refused` asserts no token request for forged/missing state or declined authorization; follow-up: `callback stays within its bound as s grows`                                            |
| Sign-out (`POST /auth/sign-out`)              | D `end` waits for in-flight refresh, deletes record/alarm → A refresh-token revocation → Worker builds browser logout redirect                                                                  | ≤1 D; ≤1 revocation plus cold discovery in D and Worker contexts; any already-running refresh has the bound above; ≤1 browser logout request; O(t) bytes, no scan of other sessions                                            | Follow-up: `sign-out stays within its bound as s grows`                                                                                                                                                                                                                     |
| Upload (`PUT /media/<id>`)                    | Credential prelude → K reservation read/permission → count/hash stream → R `put` → K `:complete`; failure after write begins → R `delete`                                                       | ≤2 K, ≤1 put + ≤1 cleanup delete; add credential D/A; constant buffering per stage, independent of M; O(M) bytes streamed and hashed once, bounded by reserved byteCount                                                       | `tests/upload-memory.test.ts`: `an upload holds a bounded number of bytes ahead of storage as the file grows` bounds read-ahead at 1 MiB for 1, 8 and 64 MiB uploads                                                                                                        |
| Download (`GET`/`HEAD /media/<id>/<variant>`) | Credential prelude → K `:authorizeDownload` every request, including conditional → R `head` → R `get` for GET only → stream body directly                                                       | ≤1 K; ≤1 head + ≤1 get; add credential D/A; 304/denial uses 0 R, HEAD/416 uses no get; constant media buffering, ≤M bytes streamed (0 for HEAD/304), no arrayBuffer/blob read                                                  | `tests/media.test.ts`: `a download asks the kernel on every request and serves ranges, validators and the decided cache policy` asserts one new decision for 304 and zero for invalid variant; follow-up: `download stays within its bound as s grows` for session/R counts |

The subject JSON body and rendered data grow with uncapped s, even though related labels arrive in the same response and there are no per-item server calls.
