## Local public app

Decision: `bun run dev` starts the product app on loopback; `bun run storybook` remains the separate interface catalogue.

Use the Bun version pinned by the root `packageManager` and installed dependencies (`bun install --frozen-lockfile`
from the repository root when preparing a fresh checkout). With dependencies already installed, select the installed
runtime before starting, so child commands also use it:

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
bun run --cwd apps/web dev
```

Run this from the repository root. Vite logs its ready endpoint at `http://127.0.0.1:3000/`; requesting `/` follows
the normal locale routing to the public shell. Stop this owned server with Ctrl-C. To use another loopback port,
pass `--port 3001`; an occupied port fails instead of silently changing the endpoint. Localization is generated
automatically during startup, and TanStack generates routes. Producer-owned client declarations in
`packages/client/src/kernel/` must be prepared with `bun run --cwd services/kernel client` if absent or stale;
this is generation, not native service startup.

The public shell needs no invented credentials or copied test keys. Configure real services and registered website
credentials only for the journeys that need them, as described below. Auth and Kernel availability remain separate
prerequisites; a ready shell does not establish sign-in, native authorization or checkout. This command does not
start producers, publish Storybook, capture pages or register checks. Finite test callers retain their existing
check admission, including callers of `dev` with `REZICS_TEST_RUNTIME=1`; the `--web` launcher remains finite-only.

From `apps/web`, use `bun run storybook` for interface development and `bun run check` to generate, type-check, test,
and build through the supported check route.

## Prepared remote Web checks

`scripts/check-placement.ts` is the Web receiving adapter. `routeWebCheck` prepares one invocation through the trusted
Performance driver, records the caller's expected source, argv, environment, return declarations and private paths,
then requires the producer's prepared status to register the exact snapshot before `run-prepared` can start. The
prepared descriptor and its eleven-field binding stay tied to that original invocation. The native-terminal and
final-settlement records arrive on FD 3 using closed message schemas; each message is limited to 64 KiB.

The semantic overlay omits ambient desktop, shell and tooling paths and all `KERNEL_CHECK_` controls,
including `KERNEL_CHECK_AFFECTED`. Direct kernel `--affected` and an explicit driver `--env-file` remain the
supported selectors. The trusted driver retains its original placement environment, while unknown host
dependencies remain errors.

The receiver fsyncs the original FD 3 bytes before validating each message and records their byte ranges plus raw,
body and decoded-object SHA-256 digests in the private `web-custody.json` and append-only `receipts.ndjson` files.
Caller prepare/run lifetime, source and returns validation, producer final custody, private input disposal, Web private
directory cleanup and cancellation/reconciliation remain separate evidence. Delivery callbacks alone do not admit a
final. Unknown, pending, partial, rejected, duplicate, out-of-order or mismatched evidence keeps the original private
descriptor occupied. The producer's aggregate final custody is derived from its delivery, private-file and
reconciliation dimensions; any unknown dimension remains unknown. Its original final and invocation identity are
immutable during later reconciliation.

`reconcileWebCheckCustody(descriptorFile)` and the CLI
`bun apps/web/scripts/check-placement-custody.ts reconcile --descriptor <absolute-private-descriptor>` operate only on
that saved descriptor and evidence. Recovery helpers have a 30 second observation deadline, then a 5 second TERM grace,
a 5 second KILL/closure settle deadline and an unconditional 5 second final settlement deadline whenever any helper
lifetime fact remains unresolved. Closed stdout does not suppress that final deadline. An observation timeout therefore
returns within 45 seconds at most. At most 16 helper attempts are journaled, and an unresolved helper PID, process group
or output pipe stays occupied even when another dimension is known closed. Late close events update the journal but
never dispose the Web private directory by themselves. Reconciliation cannot replace the invocation or turn a recovery
timeout into disposal authority. When a timeout or caller cancellation leaves custody unresolved, Web preserves any
original nonzero native code; otherwise it returns the caller's cancellation code or 75. It does not claim that a timer,
parent exit or closed output proves another process-lifetime dimension. Observation buffers are bounded, and their
overflow state does not reconstruct omitted output.

The actual `run-prepared` command has no elapsed observation cutoff, so a slow native check can finish under its own
driver lifetime. Explicit cancellation sends TERM to the driver caller, escalates to KILL after 15 seconds and waits
up to 5 seconds for caller and FD 3 closure. If they remain unresolved, Web retains the original descriptor until the
driver's native and final custody evidence is known. Web never retries locally, scans processes, fabricates a receipt
or starts a replacement invocation.

## Creator edition return page

`/editions` uses the ordinary AppShell, shared buttons and full available main width. It reads one bounded own-account
page from the declared `GET /v1/accounts/:accountId/editions`, with `limit=20` and an unchanged optional `cursor`.
Only the current native session chooses the account and credential. Responses and native requests are private/no-store;
the page never uses the development kernel fixture transport. Missing native delivery is typed unavailable, never an
empty success. The consumer-local adapter in `content-editions/creator-editions.ts` consumes the producer's closed
`ContentEditionView` metadata from `services/kernel/src/content/edition-model.ts`; it adds no producer implementation.
The producer remains responsible for current native listing admission and disclosure. The account listing route is
declared for this consumer but is not implemented in this checkout yet.

Next, refresh and retry each request one native page. Sparse and empty pages with a continuation retain Next; there is
no refill, count, per-row read, body fetch or title enrichment.
Unavailable continuations retain same-page retry and offer explicit first-page restart through the existing localized
links; route errors use the current validated cursor, and restarting drops only the cursor before a fresh session-bound read.
Next and first-page restart use a native fragment on the existing, ready-only inventory boundary; its localized heading names the focus target without hydration or refresh focus effects.
The rows display the native edition reference, state,
edition version, fixed revision, licence and plain subject identifier. Drafts link to the declared resume destination
`/editions/new?editionId=…`. Published editions link separately to buyer reading `/editions/{id}` and the declared
Commerce destination `/creator/offers/new?editionId=…`. The resume consumer and Commerce form own those destination
implementations; this page sends only the real edition ID. Withdrawn editions expose neither action. Listing metadata
never grants reading or sale permission; native delivery and sale validate current authority independently on use.

Interface review uses `Pages/Content/CreatorEditions` and `Patterns/Content/CreatorEditions`: `Editions`, `Sparse`,
`Denied`, `Unavailable`, `Empty`, `Loading` and `SignIn`. The Pages stories mount the actual route component inside
AppShell; Patterns render the same view. Constructed closed DTOs are explicitly interface fixtures, not native proof.
Web owns ordinary 390/1280 light/dark review using these stories; no separate width, locale or theme story variants
are exported. The focused contract is `tests/creator-editions.test.ts`. Minimal delivery runs only the Web workspace
typecheck; acceptance, native execution and screenshots remain integration evidence.

Source read for this surface: the native edition model, routes, reads and fixed-edition README contract; the existing
edition publication route/controls and shell-integrated stories; and the existing creator-offer list transport/view.
No external reference-project source applies to this metadata list.
Local Worker values are opt-in: `bun run check --prepare-only` creates ignored `.dev.vars` from `.dev.vars.example` only when absent. Normal checks and isolated test startup leave it untouched.
Vite pre-bundles browser dependencies by scanning the site routes and their imported components before the first page load.
Run `bun run storybook` to browse the page stories. Run `bun run record` to create committed page recordings; it needs Docker with permission to start a disposable PostgreSQL container and Bun, and does not use a development kernel or database.
The Worker inspector is off by default; `WORKER_INSPECTOR_PORT=<port> bun run dev` opens it on that port for DevTools.

## Testing

For a focused fake, component, route-loader or story-render test that does not need native services, run it locally:

```sh
bun scripts/focused.ts -- bun test tests/<focused-file>.test.ts
```

Session BFF caller identity is asserted by `tests/session-bff-identity.test.ts`. The Vite `session.test.ts` and Playwright `session-controls.test.ts` suites remain integration evidence.

The focused runner prepares generated messages and routes, gives the command an owned temporary Worker state root, and
removes that root after its process tree stops. It runs directly on the worker and does not request stack placement,
database leases, Docker, a database or remote dispatch. Add `--private-network` before `--` when a focused browser test
needs the normal loopback-only browser namespace. An explicit `bun test tests/*.host.test.ts` through this runner uses
the same `--path-ignore-patterns=node_modules/**` override as `bun run test:host`, so bunfig's host-file exclusion does
not hide a named file.

Browser tests wait for `html[data-hydrated]` before interacting with a page.
Browser tests start the dev server through `tests/support/dev-server.ts`, whose errors name the phase that failed; a test never imports another test file.
Subject page reads and public collections work without JavaScript; Library writes use JavaScript and stay disabled until the page hydrates.
The settings page at `/settings` presents one category at a time using the existing hashes: `reading`, `display`,
`notifications`, `privacy`, `verification`, `profile`, `public-activity` and `account`. Reading is the default, including
unknown or unavailable hashes; a managed-account query without a hash opens Account. Explicit category hashes,
reload and Back/Forward retain their destination and unrelated locale/query state. The wrapping phone grid and
desktop rail mark the current destination. Deliberate changes focus its heading; initial rendering leaves focus and
scroll alone. Signed-out and failed-session recovery keep browser Display choices available.

Each admitted category mounts on its first visit. Visited panels remain mounted but hidden and inert while another
category is selected, preserving drafts, upload reservations, unresolved originals and restart guards. Their shared
navigation provider guards leaving Settings and beforeunload, permits category changes without a discard dialog and
never blocks native sign-out. Changing the current viewer or CSRF session epoch releases all mounted categories and
their guards. No unseen category starts its producer; selection adds no native IO or command identity.

Reading saves spoiler level and cover suitability when chosen, with the version it read; a stale version keeps the
choice on screen and offers a reload. Reload keeps the draft for review; only “Use confirmed settings” replaces it,
and an unresolved write still requires its separate exact retry. Privacy reads the signed-in person's Collections
after selection and hydration, one page at a time, and lets them change visibility. Account links to security settings
on the Auth site and offers sign-out. Controls stay disabled until the page hydrates.

`pages-account-settings--focused-categories` is the default `PageStory` regression for “Settings shows one selected
category and retains the same viewer's drafts and unresolved commands across category navigation”. It edits the
actual Profile field, visits Reading, uses Back/Forward and checks retained text, heading focus, one visible/current
category, zero Profile saves, no repeated Profile read and an identical explicit retry of an unresolved Reading
original. Existing page-story assertions visit their real categories before checking their controls. These stories
are authored for integration; native, browser, visual and original acceptance execution remain deferred. Local Web
workspace typing is the permitted verification and does not establish those outcomes.

`bun run test` runs tests in a private network namespace containing only loopback, so host interface changes do not interrupt browsers.
Tests needing the host network, such as a container's published port, are named `*.host.test.ts` and run on the host through `bun run test:host`; never put a browser in one.
The host command routes `auth-binding.host.test.ts` through Auth's existing placed database lane. From the repository root,
run only that fixture with `bun apps/web/scripts/check.ts --auth-binding-host`.

The original personal outcome suite binds to
`tests/native/web-personal-driver.ts#createWebPersonalDriver`. Its explicit later integration gate is
`bun apps/web/scripts/check.ts --personal-host`, which loads
`tests/native/web-personal-driver.host.test.ts` and the unchanged `specs/web-personal-outcomes.test.ts`.
The wrapper retains all 23 cases, each independent `beforeEach` factory, the original 180-second case bounds,
and per-case owned cleanup. Ordinary host discovery and Auth database placement are unchanged.
For the original root command, set `WEB_PERSONAL_DRIVER` to the absolute path of that driver and run
`bun test specs/web-personal-outcomes.test.ts` in the normal native integration environment.

The adapter composes `startNativeWebStack`, `startAuthStack`, the existing Auth TLS/WebAuthn setup,
the integrated discussion fixture and the verified Stripe provider fixture. Browser contexts begin with no login;
served forms create their cookies. Setup uses native HTTP, profile choices come from the activated bundled release,
and bounded read-only database snapshots observe personal facts independently. The stack's optional Access observer
records actual authentication and permission results on its installed Access object, preserving its registrations;
direct fixture requests are marked and excluded from BFF transport observations. The production worker owns queued
work; settlement only waits for this fixture's delivered orders. No exposure group is opened by this adapter.

This binding is not a claim that the original outcomes pass. Current source gaps stay visible in native problem
responses or missing rendered controls: the proposed `rezics:characterCount` is not in the bundled release;
advanced member filters and mounted Zone membership/page execution need their genuine native owner ports;
the existing Book Zone starter supplies no invented mounted-members renderer. The original character-only fixture
still requests its distinct count and never substitutes a word count. The shell exposes no rendered account UUID;
the subject slot exposes no copy count or scalar progress summary; the progress form/native intent has no note
contract; there is no Web `/security` return route or emitted Auth return link to that target; sign-out currently
registers only the Web root return. The driver does not navigate back to repair either lost security/sign-out return.
Commerce has a rendered receipt heading but no financial receipt ID/download link or independent visible entitlement
marker. Those observations remain absent rather than borrowing a command receipt or inferring a grant from payment.
Unavailable controls fail with their served URL/body and any native HTTP refusal. Frozen expectations remain intact.

Fixture wire decisions follow `packages/definitions/src/released-discovery-fixtures.md` and
`services/kernel/test/support/released-discovery.ts`: signed integer quantities, expanded native minute units,
source-labelled controlled assertions, monolingual ingredients and licensed authored instruction documents.
The protected discussion helper runs on the same stack with the moderator as setup owner and Alice as an ordinary
member, so the ban does not target a protected owner. No reference-project source is used for this binding.
Minimal verification typechecks the Web workspace only; native, browser, database and outcome proof is deferred
to integration.

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

### Fixed Content edition reader

Commerce's owned `content.edition` benefit opens `/<locale>/editions/<benefit.resource.id>` (served route
`/editions/$id`). Use the actual edition ID, never a subject, post, image, file or origin URL. The buyer's current
server-resolved credential is the delivery actor on SSR, navigation and manual retry. The existing AppShell supplies
the sole page main and locale routing. The route retains no loader cache, hides prior bytes while re-reading, and
marks responses private/no-store and noindex. Anonymous readers see refusal and a sign-in return link.

The assigned, closed native wire is:

```ts
// GET /v1/contentEditions/{id}
{
  editionId: string;
  editionRevision: string;
  state: 'draft' | 'published' | 'withdrawn';
  targetSubjectId: string;
  creatorAccountId: string;
  revisionId: string;
  sha256: string;
  licence: string;
}
// GET /v1/contentEditions/{id}/revision
{
  editionId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  body: DocumentSnapshot;
}
```

`DocumentSnapshot` is the existing `@rezics/document` contract. Unknown fields, invalid documents and different
edition/revision/digest/licence bindings prevent rendering. SHA-256 is also checked against the canonical document
serialization used by native Content. Only published metadata can proceed to the revision read. Withdrawal, current
refusal, missing source and dependency failure discard document bytes and attribution; retry starts with metadata
again. There is no alternate revision, current-post, cached-body or seller-preview fallback.

The runtime edge is `content-editions/edition-read.ts` → `createNativeEditionApi(client)` in `edition-api.ts` → the
installed first-party `kernelClient()` Eden transport → Content's two exact protected endpoints. The same client
carries native session headers between reads, uses the server-resolved buyer credential and refuses redirects.
Requests and page responses use no-store. Delivery requires `KERNEL_ORIGIN`; development fixture transport is never
used for edition bytes. Without a configured native transport, the explicit unbound `nativeEditionApi` remains a
typed `native-pending` result, not the served default.

The isolated adapter follows the original `content/edition-routes.ts` path/parameter declarations and the closed
`ContentEditionView` / `ContentEditionRevisionView` field sets declared in `content/edition-model.ts`. It retains
the existing strict Web decoders without importing database-backed Kernel source into the Web compiler. The native
route implementation is mounted by `content/routes.ts`; the installed generated client declarations still await
these endpoints. Eden's installed runtime proxy transports the mounted paths without casting an undelivered client
type. The served default reaches this native producer; a deployed missing route returns unavailable.
Native Content and Access own entitlement, stored seller restoration, current source/ancestry/subject/version and final disclosure.
Web never turns Commerce capture, an ownership badge or an opaque benefit into permission or a licence grant.
This interface alone proves no real buyer use, native integration or reviewed visual result.

The bounded current subject point supplies the heading/backlink only for the exact target ID, without redirect
following. The existing single-account identity batch supplies a visible creator name; deleted or missing identities
are omitted. Optional identity failure leaves a neutral Edition heading and the successfully read document intact.
No profile, avatar, history or unrelated edition read enriches the page. Licence and fixed revision attribution follow
the existing Web `document-body.tsx` wrapper. After the exact fixed document passes validation, its actual image nodes
supply original media IDs for one independent shared `loadDocumentMedia(client, ids, authorization)` read. Repeated
references share that read, external URLs are excluded, and more than 32 unique image IDs leave images unavailable
without starting a partial batch. An empty document image set makes no media request. Returned entries must match
the exact requested IDs; omission conveys only unavailability. Media failure retains the independently authorized
fixed document and visible subject/creator labels.

Media decoration belongs only to the server consumer page, whose `media` field contains native image DTOs or typed
unavailability. The closed edition metadata and revision HTTP representations above remain unchanged. The original
`threads/document-media.ts` module owns the loader and re-exports `NativeDocumentImage` from `document-media-image.tsx`.
The explicit DocumentBody image callback passes that component only its matching DTO, recorded alt text and locale.
Its returned derivative variants use the existing authorized Worker download route through `coverSrc`; media source,
container, ancestry, fence and lifecycle authorization remain independent of edition delivery. The renderer owns
native media credit and download failure display. Edition permission grants no generic post or image access.

Those original shared media files and Kernel's `content/media-presentation.ts` are absent in this checkout.
`content-editions/edition-media.tsx` is an isolated consumer boundary using the declared exact DTO/export shapes.
It resolves only the original shared module when present, using Vite's exact-path module glob and a direct original
module import for Bun. Until it is present, reads return typed unavailable and the existing localized unavailable
image remains visible. This boundary adds no native endpoint, permission authority or derivative renderer. Other
document references retain shared renderer behavior; unresolved mentions reveal no inferred identity.

Cost per visit or manual retry: at most two exact protected edition reads, followed by at most one exact subject point,
one creator identity point and one shared media batch of at most 32 unique original IDs. Media has no per-image
requests, retries or refill; derivative bytes separately use the existing current-authorized download route.
Draft/withdrawn or malformed metadata stops after the first read; unconfigured
delivery issues no native edition requests. Identity calls cannot authorize bytes. Native bounds remain owned by the source producer;
there are no lists, page walks or per-reference fanouts. Local validation/rendering is linear in the one document.

The reusable `stories/patterns/content-edition` folder and Page stories use the same served reading component and
explicit constructed exact API responses inside AppShell for Pages. Web scheduled review and Commerce handoff IDs are:

- `patterns-commerce-contenteditionreader--published`
- `patterns-commerce-contenteditionreader--publishedimages`
- `patterns-commerce-contenteditionreader--missingimage`
- `patterns-commerce-contenteditionreader--longtext`
- `patterns-commerce-contenteditionreader--loading`
- `patterns-commerce-contenteditionreader--unavailable`
- `patterns-commerce-contenteditionreader--refused`
- `patterns-commerce-contenteditionreader--withdrawn`
- `patterns-commerce-contenteditionreader--versionmismatch`
- The same suffixes with prefix `pages-commerce-contenteditionreader--`.

The new Page IDs are `pages-commerce-contenteditionreader--publishedimages` and
`pages-commerce-contenteditionreader--missingimage`. Their source is
`src/stories/content-edition.stories.tsx`, reusing
`src/stories/patterns/content-edition/content-edition.stories.tsx` and `content-edition-fixtures.tsx` in that folder.
Use Web's normal 390/1280 light/dark review with existing locale/theme/viewport globals; there are no new width,
theme or locale story exports. Published checks fixed attribution and keyboard navigation; Publishedimages supplies
an independent native-shaped image response and document illustration with actual 320/640 WebP fixture derivatives.
Missingimage omits that same reference, covering missing or revoked media without inferring either cause.
The isolated consumer boundary keeps Publishedimages unavailable until the original shared renderer lands; the story
assertions require the actual image afterward. Unavailable retries fresh exact responses by keyboard.
Refused/Withdrawn/Versionmismatch conceal bytes. Constructed fixtures establish neither native buyer delivery nor
visual approval. `tests/content-edition.test.ts` adds the named authorized-image acceptance and bounded-reference
cases for later integration; acceptance execution and visual review remain pending.
Decision: keep the existing `ReaderUnavailable` export in `src/stories/entitlement.stories.tsx` as the actual
PageStory journey from the constructed mapped entitlement to the served `/editions/$id` unavailable result; it remains
presentation evidence, not buyer delivery proof.
The local Web workspace typecheck passes with the consumer boundary; the acceptance command was not run.
The implementation reuses the repository's exact-revision reader, shell, subject point and public identity boundary.
The UI README's external shelf references do not apply to this document surface; no external reference project was used.

Media bytes use the `MEDIA` R2 binding for the `rezics-media` bucket. Development simulates this bucket locally.
`POST /media` reserves a website upload; `GET /media/<id>` reads its state; `PUT /media/<id>` transports the bytes; `GET` and `HEAD /media/<id>/<variant>` ask content for permission on every request.
To upload, reserve with `POST /media`, sending an `application/json` object of at most 4 KiB with exactly
`containerId`, `purpose` (`post-image`), `mediaType`, `byteCount` and optional `sha256`. The `201` response includes
`Location: /media/<id>` and `{ media: { id, state, mediaType, byteCount, sha256, containerId } }`.
Upload to that site address with `PUT /media/<id>`, giving the reserved `Content-Type` and exact `Content-Length`.
Read `GET /media/<id>` until the state is `available` or `rejected`; it returns the same metadata shape to the uploader
only. A `401` means the session has ended. Reservation responses use `Cache-Control: private, no-store`.
This transport is for website uploads; imported covers use content's own server-side fetch command.

The shared client in `src/threads/upload.ts` retains the actual reservation ID as `UploadRefusal.mediaId` when byte
upload, processing or preview decoding fails after reservation. A failure before reservation has no media ID, and
cancellation remains an abort. Consumers keep the original target and `File` locally. On an explicit retry of a known
post-image reservation, call `resumeReplyImageUpload(mediaId: string, file: File, signal: AbortSignal): Promise<UploadedImage>`
from that module. It reads only the original `/media/<id>` using the existing limit of 32 reads, 60 seconds and
exponential delays from 250 ms to 2 seconds; it never reserves, uploads or completes again. Only native `available`
state resolves to `{src, width, height}`, with the original media ID and the original file's natural dimensions.
Rejected, missing, expired and unavailable reservations stay failures and retain their ID for the consumer. The ID
and file grant no permission or reference ownership: native uploader and container checks still govern reads and
claims. The existing shared avatar upload also retains failures' IDs; this adds no avatar retry API or account UI.
Focused cases live in `tests/thread-upload.test.ts`. This helper adds no Pages or Patterns surface.

Viewer credentials come from an explicit `Authorization` header, forwarded unchanged, or from the person's server-side
session. Access and refresh tokens stay in the Worker; the browser holds an opaque `__Host-rezics_session` cookie.
Only routes that use the credential resolve tokens, currently `/media` and `/media/…`, `POST /checkout`, order reads,
and the signed-in buyer's private `/orders` history. The history page requests one bounded `GET /v1/orders` cursor page
per visit and links each captured order to its existing known-ID page.
Purchase-history, receipt and owned-benefit links carry separate bounded `ordersCursor` and `entitlementsCursor`
URL positions; each list consumes only its own opaque cursor, retries that exact page, and clears only its own
position on restart. Optional malformed return positions are ignored. These positions never authorize use or
alter the original credentials of an enrolled mutation.
Malformed order-list positions offer an explicit first-page link before any order read, preserving only a valid entitlements return position.
Malformed owned-benefit list addresses stop before a private read and offer a first-page repair while preserving a valid
orders return position.
After hydration, the shell reads session presence, lifetime and CSRF token once through the private browser session query,
without refreshing tokens or contacting Auth. The root and public home, Space and board renders do not read session or preference cookies. Missing, invalid, expired or unreadable sessions render as signed
out without changing the cookie. Media requests, checkout start and order reads resolve before calling the kernel, so
unreachable Auth returns 502 even for downloads that otherwise conceal upstream errors. An explicit
`Authorization` header skips credential resolution; an unsafe request with a session cookie still validates its token.
Unsafe requests carrying that cookie require an exact allowed `Origin` and the session's CSRF token in
`X-CSRF-Token`. The only form-field exception is the sign-out form's `csrf_token` field. The browser session query supplies the token to controls and imperative transports; no page emits a `csrf-token` meta
element, and the token is never placed in a cookie.

Sign-in uses `GET /auth/sign-in?return_to=/ja`, followed by `GET /auth/callback`. Sign-out uses `POST /auth/sign-out`.

Account recovery refreshes the browser session before an explicit rename retry; sign-out recovery only refreshes the
session and requires another explicit native form submission, preserving failed or uncertain outcomes without replay.

The private Settings Account section offers handle rename at exactly `<AUTH_ISSUER origin>/account/rename`,
only when `/account/rename` is declared in `AUTH_MANAGEMENT_PAGE_ROUTES`. Its self context comes from the existing
session account key, `GET /v1/accounts/{accountId}/profile` and `POST /v1/viewerActions`; only an exact self
`account:update` entry advertising installed `account.update`, together with deployment availability, enables
navigation. Missing context, issuer, route declaration or capability stays unavailable. Handleless accounts use
the same private key, never a public handle lookup.
This is navigation only: no target, scopes, approval, return URL, website credentials or operation body travel
to Auth, and the anchor suppresses the referrer. Auth owns `GET /account/rename`: it must load its actual native
account/session, choose a separate exact rename management profile, and require explicit confirmation and current
native authorization before execution. The fixed organization/deletion page profile is unchanged. That Auth route
is an owner port, not implemented or proved by the Web entry; native rename, integration and visual acceptance
remain separate. Former handles forward for 30 days and remain permanently unavailable to other accounts.

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
- `AUTH_MANAGEMENT_PAGE_ROUTES`: optional trusted website deployment configuration, a JSON string array of at most
  four unique literal paths and at most 1024 UTF-8 bytes: `/account/rename`, `/organizations/members`,
  `/operators/transfer`, `/organizations/delete`. Missing, malformed, unknown or duplicate entries make all these
  new management pages unavailable; there is no wildcard, default or inferred availability. The deployment owner
  lists only pages actually deployed with production triggers and real native transport. This change enables none.
  `session/auth-page-routes.ts` exports `AuthManagementPagePath` and `authManagementPageHref(env, path, targetId?)`:
  server callers receive a nullable href on the validated issuer's origin. Rename accepts no target; members and
  organization deletion require a UUID as `organizationId`, and transfer requires a UUID as `accountId`. A target
  selects a resource and supplies no authority. The server passes nullable hrefs to the UI; request, browser and
  route parameters and issuer claims never supply this configuration. Availability grants no permission or native
  outcome proof; current native capabilities, consent, gates and Auth final route/step-up validation still apply.
  Existing `/security` and `/account/delete` links retain their behavior.
- `API_RESOURCE`: the API's RFC 8707 resource identifier and access token audience, exactly `https://api.rezics.com`
  in production, with no trailing slash. Tests use `https://api.rezics.test`.
- `WEBSITE_SCOPES`: exactly the space-separated scopes registered for the website client, including `openid offline_access`, never a wildcard.
  Private creator sales use the mounted exact `commerce_sale:list` scope. Register it
  and request renewed consent for this journey; an old consent or refresh token never widens.
  Media routes need `media:create`, `media:read_reservation`, `media:read`, `media:complete` and `media:erase`;
  posting routes need `thread:create` and `post:create`; reactions need `reaction:set`; presentation curation needs `presentation:publish` and
  `presentation:activate`; checkout start needs `order:create` and order pages and purchase history need `order:read`; the explicit known-order status check separately needs `order:reconcile`; the settings page needs
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
Pass exactly the registered scope list, including `openid offline_access`, as `WEBSITE_SCOPES`. Register and obtain renewed consent for `order:reconcile` before offering the order status-check action; an existing read/create token or first-party client does not acquire it automatically.
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
import { websiteRegistrationScopes } from './src/session/website-scopes.ts';

const registration = {
  publicJwks: { keys: [websitePublicJwk] },
  redirectUris: ['https://rezics.com/auth/callback'],
  postLogoutRedirectUris: ['https://rezics.com/'],
  scopes: websiteRegistrationScopes([
    ...[...mountedWebsiteActions].filter(([, action]) => !action.anonymous).map(([name]) => name),
    'organization:create',
    'account:manage',
    'account:delete',
  ]),
};
await auth.internal.registerWebsiteClient(registration);
// Deploy this exact string as the Worker's WEBSITE_SCOPES text variable.
const websiteScopes = registration.scopes.join(' ');
```

The catalogue must include the five media scopes above, the posting scopes `thread:create` and `post:create`,
`reaction:set`,
the curation scopes `presentation:publish` and `presentation:activate`, `order:create`, `order:read` and `order:reconcile`, the settings page's `account:read`, `account:update`, `collection:read` and `collection:update`, and Auth's account-operation scopes `organization:create`, `account:manage` and `account:delete`.
Registration and `WEBSITE_SCOPES` must change together
when more protected site features are mounted. Auth's [website contract](../../services/auth/README.md#website-client)
defines registration and key rotation.
Rating writes also require the documented website client scope `rating:vote`.
The shared registration helper retains only real mounted scopes, including `commerce_sale:list`.
The existing native Web bootstrap uses that helper and deploys its exact joined list as `WEBSITE_SCOPES`;
sign-in uses `websiteRequestedScopes` on that configured list. Auth refuses unknown scopes. Registration, configured scope requests and renewed consent must agree with the
mounted catalogue; refreshing an old credential never adds this scope.

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
`openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read order:reconcile account:read account:update organization:create account:manage account:delete`.
From `apps/web`, run:

```sh
AUTH_ISSUER=http://127.0.0.1:4200 \
API_RESOURCE=https://api.rezics.test \
WEBSITE_CLIENT_ID=rezics-website \
WEBSITE_CLIENT_KEY="$(cat .temp/website-private.jwk)" \
WEBSITE_SCOPES='openid offline_access media:create media:read_reservation media:read media:complete media:erase thread:create post:create reaction:set presentation:publish presentation:activate order:create order:read order:reconcile account:read account:update organization:create account:manage account:delete' \
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

### Native account-operation fixture

`tests/native/native-agent-identity-fixture.ts` uses the semantic driver's existing Auth host and database.
The driver retains the actual Kernel `access(config)` result after final route composition, and binds
`createNativeAccountBindings` plus `createWorkflowApprovals` with that Access, pool, routing key and reference keys.
The Auth database supplies the native provisioning, barrier and staged `creationBinding` proof readers. Closing
the driver releases registration, trusted Access and account-operation ports before closing the Kernel pool.
When a caller supplies a runtime pool, native bindings use that same pool as the captured Access. Isolated Auth
callers retain their existing registration-only child process; an omitted account-operation port stays unbound.

The identity fixture opts into a private supervisor transport with `NATIVE_AUTH_FIXTURE_KEY`, scoped to the child
environment captured by `startNativeWebStack`. `startAuthStack` mounts the served Auth app on that host's listener
and unmounts it on cleanup, keeping the original workflow executor and native bindings. Other callers retain the
existing page bridge. The supervisor wraps a public transport facade retaining the actual Auth internal capabilities
and verifier; the host's own service fallback remains intact, preventing recursive host dispatch. No second Auth
host or database is created for account operations.

Organization creation and erasure use the ordinary served confirmation and step-up forms, their exact pending
body/key and the dedicated `rezics-auth-account-operations` client. Its only registered actions remain
`organization:create` and `account:delete`; the server's action catalogue adds no client scopes. Automation setup
uses the selected operator's actual native API bearer and served human session, checks that both identify the same
account, obtains an exact native automated-creation approval and calls the existing Auth workflow. The generated
registration must resolve through the Auth-owned staged creation binding. The supervisor key itself grants no
account authority, and no bearer is injected into a browser.

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

Renamed handles redirect 302 to the current handle for 30 days; afterwards, like a deleted account's handle, they answer the same 404 as an unknown handle. Mutable resolution uses `private, no-store`; canonical public profile HTML has its own cache classification under [SEO](../../docs/seo.md#public-html-cache).

**Public and signed-in routes**: Public routes render on the server without reading the session or any cookie. The session, CSRF token and personal state (library status, own vote, reactions, membership and edit controls) load in the browser after hydration through queries. Signed-in routes check the session in `beforeLoad` and redirect to sign-in with a return path; components never check it themselves.

Subject pages and views follow the same boundary: the server ensures locale and view keyed public page, type-frame, relation-label, reaction-count and rating-figure queries. Library slot, reading preferences, own reaction and own rating queries are browser-only and enabled after the session query reports signed in. Keep their control space reserved from the first render, and update or invalidate the corresponding query after a write. Subject server renders use anonymous defaults for spoiler and suitability preferences. These rules govern current subject routes and supersede older subject-specific read placement details below; the route checks own the current total read bounds.

**Data reads**: Each kernel read has one `queryOptions` factory beside its loader code. Loaders call `context.queryClient.ensureQueryData`; components use `useSuspenseQuery` for public reads and `useQuery` for personal reads in the browser only. Public reads keep `staleTime` 60 s, personal reads 0. The router preloads on intent.

`tests/public-cache-routes.test.ts` guards which routes use `staticData.publicCache` and verifies their server HTML is reader-independent.

The home route uses the public `homePageQuery` for anonymous mixed discovery. Its server render reads no session. After hydration and actual session readiness, a signed-in visitor reads one private mixed feed. Continue is an item in that stream, with its original owner session and resume destination.

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

**Caching**: [SEO](../../docs/seo.md#public-html-cache) owns disclosure and withdrawal policy. Eligible anonymous public routes receive `Cache-Control: public, max-age=0, s-maxage=0, must-revalidate` with a weak URL/build/data/status/normalized-HTML `ETag`. Every request first runs the ordinary anonymous renderer and its current owner reads once, including warm entries and conditional GETs. Only a current eligible public 200 can answer 304; stored bodies also require the same current status and complete representation validator, with current headers. Native private/no-store directives and failures survive classification; the Worker never promotes `Set-Cookie`. Cookie/Authorization requests bypass shared reuse and remain private/no-store. Server functions that read a session remain `private, no-store`. Internal 60-second body retention does not grant independent proxies public freshness. No complete owner-native currentness provider is installed, so rendering cannot be skipped. Immutable assets and sitemap shards retain their separate policies.

**Origin**: Absolute URLs use the configured `PUBLIC_ORIGIN`, never the request's `Host` header.

A route module reads Worker bindings only inside server functions; `head()` and components take those values from loader data.

**Pending and errors**: Routes declare `pendingComponent`, `errorComponent` and `notFoundComponent` where they differ from the router defaults.

## Security headers

Page HTML receives a fresh base64 nonce from one 16-byte cryptographic random draw. Request middleware keeps
it with the request and passes it to TanStack Router's `ssr.nonce`, including its streamed scripts. Client
navigation reuses the document's nonce. Eligible public HTML uses the cache's nonce placeholder rewrite on storage
and a fresh nonce on delivery; private pages remain uncacheable. Media downloads retain their
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
asset-marker rewriting. Public-cache nonce replacement applies in both environments. Neither environment permits script `unsafe-inline`, `unsafe-eval` or wildcard hosts.

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
[the SEO policy](../../docs/seo.md). Sitemaps drop the URL at the next export; they never authorize page disclosure.
Warm HTML and validators require [current public rendering](../../docs/seo.md#public-html-cache) before reuse; a TTL never authorizes withdrawn content.
Restore and Undo use the native author's restore route. Its 204 confirms the write, while the existing current
thread-page read alone supplies body, title, author, media and placement. Pre-command page cache entries are retired
before that read, so navigation cannot reuse their old bodies after a failed refresh. A failed read after 204 offers a read retry;
it does not repeat the confirmed write or reveal an earlier local body. An uncertain restore retains its original
key and checks the current native tombstone before a deliberate retry. Session, actor or target changes retire the
local intent and any pending disclosure. A private refresh must identify the current session actor; missing or
mismatched actor data stays unavailable. Delete immediately substitutes a byte-free placeholder, then reads the
current owner tombstone for its actual deadline. Until that read succeeds, the deadline is explicitly unknown;
the browser clock never creates it. Native author, permission, expiry, purge and takedown rules remain authoritative.
A restore conflict links to an existing review only when the native optional `existingThreadId` is supplied; other
conflicts offer a generic current-state refresh.

## Cost

### Render current member presentation

Search `ResultList` and subject/related `CoverList` use the shared member row/card renderers. Their optional
`listPresentationFor` callback consumes the already available release, using `releasedListPresentation` from
`src/media/type-presentation.ts` as a narrow adapter for effective compiled annotations. This does not claim that
current generated definitions publish `listPresentation`. Older releases use exact current member-Type fallbacks;
no label matching or Collection-kind mutation selects a member's Type. The joint field contract remains owned by
[Collection presentation](../../docs/collection-presentation.md).

`CoverList.memberFacts` optionally accepts already supplied current-page facts keyed by member ID, using the
existing Search Fact union. It makes no reads. The member-fact batch producer remains pending. Missing input stays
absent; no year, creator, runtime or episode count is fabricated. Explicit empty key-fact hints clear the fact line.
Existing relation notes remain visible. Search keeps its separately supplied publication-year metadata.

- **Touches:** Only the current page's supplied Types, effective release annotations, covers and facts.
- **Bound:** O(current bounded page), at most four selected properties, three supplied values per property and four
  visible values per member, zero added network or detail reads. Effective release lookup uses the supplied Type
  sequence with no client ancestor expansion. Source/protocol page limits and continuation remain unchanged.
- **Growth check:** `tests/type-presentation.test.ts` renders the actual Search and cover-list callers at catalogue
  sizes 1, 100 and 10,000 through one bounded page request, retaining the 100-member cap and zero enrichment reads.
- **Visual handoff:** `patterns-type-presentation--mixed` reuses the actual callers. The ten
  `components-list-presentation` behavior IDs are documented in UI's README. Every ID needs phone390/desktop1280,
  en/zh-Hans and light/dark review through globals. Worker typing is not visual approval; controller review remains
  pending.

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

- **Touches:** The page's usual anonymous reads/render once on every opted-in request, including a warm cache or conditional GET. After current public classification, at most one Cache API lookup and one put for a new representation. Credentialed requests do neither cache operation.
- **Bound:** No extra source/detail read, duplicate renderer or per-row probe. Existing composition limits remain 16 reads/128 cost and subject-read bounds are unchanged. Nonce normalization, HTML buffering and ETag hashing are linear in rendered page bytes. Internal retention is 60 seconds; HTTP clients must revalidate every reuse. A native fence covering all rendered dependencies remains unbound.
- **Growth check:** The focused cache tests require one current render per GET and retain nonce, credential, native-policy and error guards. Warm positive/negative entries cannot mask current withdrawal, closure or preparation; complete-HTML/status validators distinguish changed dependencies and restoration.

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

- The header mounts one responsive HeaderSearch owner, with one actual query input in a token-styled pill. Focus
  expands the same region into a panel; its footer has Filters and submit. Escape/outside dismissal preserves the
  query. On a phone the trigger opens the same structure as a full-screen sheet with contained focus and return.
- Routes register their existing named filters through `search/header-search/filter-region.tsx`; unavailable
  controls leave Filters disabled. Search retains its supported Type/facet/sort URL fields and drops the old cursor
  when the query changes. Pages never add a second query box.
- A removable scope chip needs an existing localized scoped search action before it can submit. Unsupported scope
  labels stay unavailable, including suggestions; empty-input Backspace and the remove button explicitly return
  to global search. The global suggestion operation never receives scoped text. The named `slots.ask` slot is empty.
- [Header Search states](src/stories/header-search/README.md) lists every exact Patterns ID and the pending Root
  review matrix for phone390/desktop1280, en/zh-Hans and light/dark. `search-field.stories.tsx` retains an import
  compatibility entry. The stack-free presenter/request regressions live in `tests/header-search-panel.test.ts`.
- **Touches:** A nonce-bearing inline head script applies theme and navigation cookies before first paint. The
  shell renders three fixed destinations, header controls and one navigation column; the column background and
  link underlines are CSS. The account slot reserves the same space while session state is unknown
- **Bound:** 0 server K/D/R/A; at most 3 destinations and 8 locales per page, independent of s, M and t;
  navigation background is one stretched element, with no per-line work
- **Growth check:** `tests/public-render.test.ts` checks pre-paint preferences, the account slot and script-free Account

### Route loading and recovery

Route replacement stays inside AppShell's existing `main-content` skip target. `RouteState` composes the shared
Empty header, icon, description and content slots with one page heading and localized Home/Search links. Missing
and platform-closed routes stay distinct and never become planned-route announcements. No loader payload, error
message, cause, request URL or diagnostic body becomes page content. Existing root error head handling keeps
noindex, private/no-store, sanitized sharing metadata and native numeric response status.

`PendingPage` reads only a fixed presentation map keyed by explicit route IDs (`page`, `feed`, `detail`,
`form`). Unregistered routes use generic page loading; no pathname guessing or candidate-specific label is used.
Skeletons contain at most eight blocks, have no interactive controls or data reads, adapt at phone/desktop widths
and animate only with `prefers-reduced-motion: no-preference`. Data size never determines their shape.

Decision: honor native Retry-After with one local wake-up for delays up to five minutes; longer delays offer safe
navigation and ask the reader to return later, without a timer or automatic retry.

Recovery reads only sanitized outcome metadata and an explicit native `retryable: false`, never status text.
One explicit retry invalidates the original router loader synchronously, suppresses duplicate clicks before React
renders, and resets the boundary only after success for the same visit and current session owner. Failed retries
announce failure without exposing diagnostics. Leaving the route or replacing the account retires reset intent;
loader/session owners retain authority over current private data. Same-address retries preserve focus; navigation
continues to focus the existing skip target. Controls wrap long strings and retain 44px phone targets.

Prepared interaction stories live in `15-route-state-recovery.stories.tsx`; ordinary recorded loader recovery also
remains in `shell-errors.stories.tsx`. The bounded fixtures cover direct entry, contextual loading, missing/closed,
failed retry, recovery and leaving a pending visit, including account replacement. Tests live in
`tests/15-route-state-recovery.test.tsx` and the existing shell pending and page-head regressions.

### Session state

- **Touches:** One browser GET server function reads session state and CSRF with `Cache-Control: private, no-store`;
  a valid configured session cookie causes one D `signedIn` read, with no credential resolution or Auth request
- **Bound:** Once per document load; client navigations reuse `sessionQuery`. The existing sign-in and sign-out
  document redirects create a fresh query client and read the new session state. Server renders remain unknown
- **Growth check:** `tests/public-render.test.ts` counts one session-state read across hydration and three navigations

### Home page (`/<locale>`)

`home-queries.ts` and `HomeFeedConsumer` use Content's mounted `GET /v1/feedItems` with
`stream=home|following` and `limit=20`. `home-feed-read.ts` infers the actual generated client response type;
no server runtime enters the browser. The public loader requests only anonymous discovery, never session,
Continue or follows. Personal reads prepare the existing session, verify its current subject and use
`private, no-store`. A viewer/session change remounts the private window before rendering prior rows;
sign-out immediately returns to the public page. Private rows and cursors never enter the shared query cache
or hydration payload. No Home per-row reads or vocabulary enumeration occur. Thread/post rows render only supplied author display
name, handle, avatar and plain-text excerpt. The handle links independently to the localized profile beside
the primary destination; absent identity fields have no identifier fallback. Excerpts are capped by Content
at 160 Unicode code points on a grapheme boundary. No row ratings are shown. Until dev regenerates the client,
`home-feed-read.ts` adds only these optional summary fields to the generated response type.

One ordered list preserves the producer's stable item identities, deduplication, source order and original
signed frontier. Next replaces the current page rather than accumulating DOM or cached pages. Changing
Home/Following discards the previous cursor. A source can be ready, preparing, unavailable or not requested;
ready plus empty is the only successful empty state. Partial pages retain their usable rows. Request,
authentication, denial, closed platform, cursor restart and deadline failures have distinct recovery messages.
Following explains its last-30-days/newest-2,000-reference horizon and links to the existing followed-source
and Continue destinations; full histories belong to each object's owner page. Discovery makes no personalized
recommendation or recency claim. Continue links to the actual session, or the owner's subject progress entry,
and displays only supplied native progress through the shared formatter.

- **Touches:** one native feed GET per page after the existing session preparation for personal reads.
- **Bound:** at most 20 rendered items in one page; one supplied source reason per item; zero per-row requests.
  Backend candidate, source admission, ordering and cursor budgets remain Content's authority.
- **Regression:** `tests/home-feed-composition.test.tsx` crosses the default public route query and renderer,
  then the same window/native consumer for mixed order, partial source state, unchanged continuation,
  Following and viewer reset. It supplies selected HTTP responses; it does not establish native acceptance.
- **Stories:** canonical SignedIn/SignedOut plus partial, preparing, unavailable, empty and Following use the
  actual root route and consumer. Their feed envelopes are explicitly illustrative compositions of recorded
  owner summaries, not native feed recordings. Locale/theme and 390/1280 viewports remain globals.
  `PageStory.homeFeedFixture` is the single explicit Home fixture hook; the PageStory provider owner must
  retain this hook when changing its recording setup. No global provider behavior changes.

### Global board directory (`/<locale>/boards`)

Choose Discussions or Reviews, then Open a returned board to use its existing reading and creation flow. Listing
supplies a destination, never creation permission. There is no automatic board creation or Realm-board substitution.
The URL retains `purpose` and opaque `cursor`; changing purpose resets the cursor. Retry preserves the query and
leaves drafts alone. Previous remembers one predecessor reached through a returned Next cursor; direct cursor URLs
invent no predecessor. Loading, terminal empty, sparse empty with continuation, unavailable/Retry and native
closed/denied remain distinct. Pending and refused reads hide previous rows and all hidden metadata.

`src/threads/board-directory.ts` derives rows from the generated native collection's BoardView. The source contract is
`GET /v1/boards?purpose=discussion|reviews&cursor&limit` → `{ boards, next }`, limit 1–100, default 20.
The served loader and explicit retries use `createNativeBoardDirectoryAdapter` with the actual `client.boards.get`.
The server-only default resolves the current first-party session credential on each action and forwards the incoming
request's abort signal. Session or native failures never retry anonymously or become an empty directory. Native
anonymous FINAL disclosure owns the public Global result for every caller, including authenticated callers. The
defensive client filter retains only available, published boards with native `realmId: null` and the requested
purpose. Global `community: null` supplies no description or Realm membership. Navigation/review owners can link
to `/boards?purpose=reviews` or `/boards?purpose=discussion`.

- **Touches/bound:** One page per load, retry or explicit continuation; zero per-board requests or automatic refill.
  Client work/storage O(limit), one predecessor. The producer owns the signed range/current disclosure neighborhood:
  ≤4 × limit candidates, O(limit × log R), R = N + U × t + M. No second search or permission authority.
- **Focused outcomes:** `tests/board-directory.test.ts` covers purpose/cursor to the actual recorded board destination
  and unavailable/sparse/current refusal, plus generated-client transport, credential/signal forwarding, one-call
  continuations and fresh retry refusal. These source/adapter checks do not establish native acceptance; existing
  native bound/privacy suites remain later integration proof.
- **Stories:** `patterns-community-board-directory--current`, `--select-purpose`, `--continue`, `--open`, `--retry`,
  `--loading`, `--empty`, `--sparse`, `--unavailable`, `--denied`, `--closed`; the same suffixes under
  `pages-community-board-directory` reuse the region in AppShell. Use phone390/desktop1280 and locale/theme globals.
  Patterns includes attached docs and action plays. Story-only DTO fixtures reuse the committed Global discussion
  board; they do not establish native acceptance or screenshot review.

### Board page (`/<locale>/boards/<id>`)

- `BoardThreads` in `src/threads/board-continuation/` renders one returned page. An empty page with `next` says
  no discussions are visible on this page and retains Next; only `next: null` uses the terminal empty-board copy.
  Next preserves the opaque cursor and current Active, Hot or New choice. It never fetches more pages automatically.
  Active and Hot show the supplied `rankRefreshedAt` as a refresh time, with an exact timestamp available on the time;
  an absent timestamp supplies no freshness claim. New shows no rank freshness. Rows use only returned activity data.
  The Patterns/Community/Board Continuation folder documents empty, terminal and keyboard continuation behavior.
  Review the same IDs at phone390/desktop1280 using locale and theme globals:
  `patterns-community-board-continuation--empty-page`, `--continue-hot`,
  `--terminal-empty`; the composed page is `pages-community-board-continuation--continue-hot`.
  `tests/board-continuation.test.ts` covers traversal and current board/page read failures; native integration and
  Root screenshot review remain separate proof.
- **Touches:** Root preferences/D and public board plus thread-page K reads started together, then one batched
  identity read for the page's authors; preserve kernel thread order and pass `next` as the paging cursor. Each row
  is compact: author, reply count and last activity come from the thread row itself, with no read per thread. The
  `sort` search parameter (`hot` or `new`, Active when absent or unknown) is the threads read's `sort` query, `new`
  sending none
- **Bound:** ≤3 K (board and one page of at most s ≤ 100 threads, then at most one identity read), ≤1 D, 0 R/A;
  work and buffered JSON are O(s)
- **Growth check:** `tests/request-cost.test.ts`: `board page stays within its bound as s grows`

#### Community presentation

`BoardCommunity` is the actual route region and the reusable Community Feed pattern. Its token-surface banner and
initials are explicit image fallbacks. The header retains the board title and uses the containing Realm's actual
name and description from supplied community presentation, otherwise its readable title and summary. An authored
empty description stays empty. The About column sits beside the feed on desktop and follows it on phones. Cards use the existing byline,
adaptive Menu and ListRow, with a two-line preview drawn only from the returned, available opening document's text
nodes (at most 128 nodes and 280 characters). Erased or withheld openings retain their returned slot without a body
preview. Reactions and reply counts appear only when supplied; omitted aggregates make no zero claim. Optional rank
freshness now lives in the expandable order help, retaining the exact supplied timestamp.

The existing board source boundary consumes the adopted `BoardView.community: CommunityPresentation | null`
when supplied by Content's presentation producer. `threads/board-community-source.ts` isolates the exact closed
consumer declarations and runtime validation until the native model and generated client exports are installed.
Only a genuinely null `realmId` yields null/Global. An absent, invalid or unavailable Realm presentation produces an
explicit unavailable adapter, without a cached positive value. The existing optional Realm read supplies only
readable active Realm labels, state and visibility; a failed read never changes board identity.

The supplied DTO names the Realm independently of its carrying Space, classification Context and account owner.
Selected Realm icon/banner summaries use only their available derivatives through the current-authorized site media
route; none/unavailable and failed bytes use token surfaces or initials. No original URL or owner avatar is used.
Only `members.state: current` renders a supplied count; unknown explains that the count is unavailable, never zero.
The actual current-membership aggregate remains unknown until its Accounts source/version/removal coverage producer
is installed. Available rules render the exact supplied native Text revision and link to the existing revision
reader; none and unavailable have distinct explanations. An empty rules document remains empty. There is no rules
store, detail lookup or guessed metadata endpoint in Web. These consumer declarations are a temporary seam for
`services/kernel/src/content/community-presentation-model.ts` and `realm-media.ts`, not delivered native APIs.

The existing `threadActivity` adapter accepts supplied reply counts, while the
current native `ThreadView` has no reply-count field. The feed never derives a count by reading replies. Opening
`mediaIds` are references without safe preview summaries, so they do not become thumbnail URLs or extra media reads.

`readPageAuthors` keeps one `GET /v1/accounts?ids=...` for the page. `Byline` uses only an avatar summary included in
that response, with published variants through the site's `/media` route and initials on failure. The current ids
producer, `services/kernel/src/access/account-data.ts::readPublicIdentities`, returns basic identities without
avatars. Native `services/kernel/src/content/avatar.ts::readAvatarSummaries` is the bounded existing enrichment port
for a real batch producer; the page never requests individual profiles to fill this gap.

Join/Joined reuses `RealmMembership` and its native command/standing-refresh behavior. The creation entry shares its
existing browser-only membership and participation query: a refused, pending or unavailable current read offers no
Start action. Supplied presentation admission also restricts the existing Join/Leave controls; it never overrides
the fresh personal standing or authorizes a command. No cached success is actionable during a standing refresh.
A successful public participation read can allow a nonmember to enter the existing composer; the
native command still authorizes submission. A Global board has no Join and retains the existing signed-in composer
entry. Missing Realm metadata never converts a Realm board into Global Context. The public read cost remains the
existing board, page and batched identities, plus one optional Realm read; current personal participation uses the
existing two native point reads, shared by both actions. No per-card request is added.

The owned folder `src/stories/patterns/board-community/` documents the actual component and interaction states.
Review `patterns-community-community-feed--feed`, `--realm`, `--overflow`, `--sort`, `--open-thread`, `--start-thread`,
`--continue-hot`, `--empty`, `--protected`, `--source-unavailable`, `--loading`, `--error` and `--closed` through the
same phone390/desktop1280, locale and theme globals. Actual Pages are `pages-community-community-board--global`,
`--realm` and `--continue-hot`; `pages-community-board-continuation--continue-hot` also uses this component.
The two focused cases in `tests/board-community.test.ts` cover disclosed previews/counts, sort/cursor continuation,
removed slots and primary/optional source failures. Recorded responses do not prove native authority or signing.
The additional `--presentation` and `--no-optionals` states pass explicit producer-contract fixtures through the
actual loader, covering current/unknown counts, exact rules, authored empty description and none/unavailable images.
They are review inputs while the native producer is pending. Web/Root review uses the same IDs at 390/1280 in light
and dark; no screenshot approval or acceptance pass is claimed by local typing.

- **Touches:** Existing board and bounded thread-page reads, optional current Realm labels and one author batch.
  Presentation enrichment arrives in the existing board response; participation keeps its existing personal reads.
- **Bound:** O(returned page size) feed rendering plus at most one supplied Text rules revision of 64 KiB and two
  image summaries of at most twelve variants each. No per-card HTTP, count query, hidden-body read or ancestry scan.
- **Growth check:** Existing board request-cost, native cursor/privacy and membership suites remain the integration
  proof; this consumer adds no growth harness or allowance.

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
  `{ kind }` and each new intent sends a new `Idempotency-Key`; uncertain retries retain the original actor, target,
  desired kind and key. Recovery locks other choices until a current point read reconciles the slot and projected
  counts, including after a conflict or an older replay receipt. Session/target replacement retires recovery.
- **Decision:** Recovery is explicit and local to the mounted visit; a failed reconciliation retries only the read.
- **Bound:** Ordinary change ≤1 K, ≤1 D; recovery ≤3 K and ≤2 D (one write plus at most two point reads),
  independent of reaction count. `REACTION_RECOVERY_READS` records the producer bounds: thread/post 1, Subject 2.
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

### Realm claim review

The existing Space/Realm home mounts `community/realm-claim-controls.tsx` in its management area. The native Realm
GET continuity is retained in `RealmHome.continuity`, so an orphan's settings, board creation, publication and
management stay frozen from the first render while readable boards remain available. A later current owned read
releases that freeze without claiming that this viewer is the owner or granting an action. Native container
removal remains separate; denied Realm reads conceal its old shelves and request reference, without selecting
Global or changing its Space or Context pointer.

The default panel uses the first-party BFF/session/CSRF transport. Current admission comes from the existing
`GET /v1/realms/{realmId}/participation`, which checks both participation and read eligibility, bracketed by native
Realm reads with matching head, carrying Space, Context and continuity. Missing continuity or admission offers
only unavailable request status. Signed-out readers use the existing sign-in return route. No role label,
creator, membership, Global authority or browser clock grants the request action.

`POST /v1/realms/{realmId}/claimRequests` sends `{}` with the exact retained `Idempotency-Key` and displays only the
returned pending request reference. The original 720-hour date is informational; native command time decides
eligibility. Pending means submission awaiting a platform decision, never approval, queue priority or ownership.
A lost reply retains the same intent and key for explicit retry. Current denial preserves the intent but removes
the retry action; conflict requires a fresh native read and explicit review before a new intent. Refresh does not
rebase a saved intent or replace its key. Request references are selectable and copyable when current admission
still permits their display. No claimant list, approval control, staff flag or second ownership source is added to
the home panel.
An updated native page payload replaces the displayed source while preserving its saved intent and requiring
current personal admission again.

One read runs after hydration, then only explicit manual refreshes. The existing admission read makes two
Realm point reads and one participation check; an anonymous refresh uses one Realm read. For a signed-in readable
orphan, the panel also makes the bounded own-request recovery read described below, independent of board, member
or request count. Each request or explicit retry makes one native POST. No list, per-row admission, refill or
repeated polling is added. `tests/realm-claim.test.ts` covers the native client boundary, retained page source,
refusal, missing metadata, closure, uncertain retry and before/final binding; integration runs its acceptance.

Review IDs are `patterns-community-realm-claim--journey`, `--uncertain-retry`, `--refused` and
`pages-community-realm-claim--journey`, with the existing phone390/desktop1280 and light/dark globals. The Pages
story reuses AppShell and the same Space page and controls. Explicit transport fixtures augment an existing Realm
recording; they do not prove native approval or visual acceptance. New messages use English base-locale fallback.
No external reference-project source was needed. Native, browser, regression and visual proof remain integration
work under the minimal verification policy.

### Own Realm claim request status

`/realms/{id}/claim-requests/{requestId}` renders `RealmClaimStatusView` in the existing AppShell main.
The same `RealmClaimControls` that displays the native submission receipt links its actual request ID to this
page. It also links a recovered native own receipt after reload. No public owned state, role, profile or Space
address creates a request reference. The only return link is the ordinary Realm route.

The declared producer reads are `GET /v1/realms/{realmId}/claimRequests/{requestId}` and
`GET /v1/realms/{realmId}/claimRequests/mine`, returning the closed `{claimRequest}` response. The point requires
a request; only mine permits null, meaning known no current own request. The exact request fields are `realmId`,
`requestId`, `state: pending|approved`, `orphanedAt`, `requestedAt`, `approvedAt: string|null`, and `currentEpisode`.
The original producer owns current claimant identity and episode selection. These GETs are absent from the
current generated client, so `realm-claim-status-native.ts` supplies an isolated typed consumer transport to those
exact routes using `KERNEL_ORIGIN`. The original generated reader takes its place when integrated. Missing source,
503, malformed responses and transport errors remain unavailable; none become an empty successful lookup.

Each invocation prepares the current real session, forwards only its bearer credential and performs two fixed
Realm/participation rounds around one exact own-request GET. Matching native Realm/head, Space, Context and
continuity are required before disclosure. Closure, revoked reads and revoked participation conceal the receipt.
The original native GET must enforce own-request identity before/final; the consumer adds no claimant store or
permission authority. Reads are private no-store, omit cookies and redirect following, and never call the
platform review queue. Approval is historical request outcome only. Current ownership and management still use
ordinary Access; the page offers no ownership mutation. All dates render the original native values in UTC.
An older pending episode is explicitly separate from current pending and approved outcomes. No approval timer,
new waiting period, new claim, enqueue, regrant or inferred approval is introduced.

On the existing panel's mount or explicit refresh, a signed-in readable orphan gets at most one current-episode
mine lookup. A matching native receipt blocks a duplicate start; null enables an explicit new request only under
the existing admission rules. Unknown recovery blocks a new start while preserving the original uncertain
submission's exact intent and key for native retry. A late lookup cannot replace a newer page source, episode,
intent or query. Updated unreadable page data also fences in-flight reads. Recovery is one bounded point, with
no request history, list, refill, drain or per-row reads. Status pages read once on mount and then only on manual
Check again: zero automatic settling refreshes, within the four-refresh maximum. There is no polling or progress count.
The existing empty-body native POST and platform approval component remain the sole writers.

Review IDs are `pages-community-realm-claim-status--pending`, `--approved`, `--unrelated`, `--unavailable`,
`--reload`, `--obsolete-episode`, and the matching `patterns-community-realm-claim-status--…` IDs. The Reload
Pattern exercises the existing receipt controls; the Page reload reads the same status component. Fixtures are
explicit declared response examples based on the existing Realm recording, not native outcome recordings.
Web owns ordinary 390/1280 light/dark review and screenshots. No native or visual pass is claimed here.
`tests/realm-claim-status.test.ts` adds the named return journey and focused identity, recovery, stale-response,
unknown/null, historical outcome and privacy cases; it is intentionally not run under the current verification policy.
`bun run --cwd apps/web typecheck` passed locally on the final implementation. No external reference-project
source was needed; this surface uses the native community continuity contract, existing claim controls and
existing platform-review transport pattern.
Original permission/privacy/replay/erasure and physical/growth proof remain deferred, never waived.

### Platform Realm claim review

`/realms/{id}/claims` renders `community/realm-claim-review-page.tsx` inside the existing AppShell main. The direct
route requires a server session and is private, no-store and noindex. No home navigation link is inferred from a
role, membership or orphan date: the current home response supplies no permission-bearing review link.

The declared native `RealmClaimReviewPage` contains only `{claimRequests,next}`. Its pending rows carry
`realmId`, `requestId`, `claimantAccountId`, `state`, `orphanedAt`, `claimEligibleAt` and `requestedAt`. The consumer
rejects extra disclosure, malformed identifiers and more than 20 rows. Each next action replaces the visible page
with exactly one native page; an empty page with a next cursor remains sparse. Failed reads remain unavailable.
There is no refill, total count, per-account profile lookup or polling.

The generated client in this checkout has the actual approval method but no queue GET. The isolated consumer-local
transport in `community/realm-claim-review-native.ts` now connects the default session read to the declared
`GET /v1/realms/{realmId}/claimRequests?limit=20&cursor=…` at the configured `KERNEL_ORIGIN`. Each invocation prepares
the actual request session and supplies its current bearer. The original opaque cursor is encoded unchanged and
returned rows must match the scoped Realm. One page, query or explicit retry sends at most one GET, with no-store
and no redirect following; the BFF response remains private, no-store. Missing configuration, malformed responses,
503 and stale/invalid cursor 400 responses remain unavailable and conceal the prior page. A 401 is signed out;
403/404 are denied, except the native `platform_closed` refusal, which stays closed. There is no cursor reset or
automatic retry. Replace this local transport with the original generated reader when delivered. Native sparse
selection, current/final DIRECT Global `realm:approve_claim` admission and original orphan episode remain producer
authority; a pending row supplies no approval permission. This connection implements no producer or native proof.

Review request refreshes the same page and compares the exact original source before opening an inline confirmation.
Confirm sends the existing generated `claimRequests({requestId}).$approve.post` method, which resolves to
`POST /v1/realms/{realmId}/claimRequests/{requestId}:approve`. The BFF prepares the current session, enforces the
existing CSRF policy and quotes the saved idempotency key. It supplies no actor, role, ownership proof or permission
engine. Accounts' existing command alone decides current Global authority and installs the grant.

Only the exact native `{claim:{realmId,requestId,claimantAccountId,state:'owned',orphanedAt,approvedAt}}` receipt
matching the selected claimant and original episode renders success. A lost reply preserves the same intent and
key. Explicit retry first reads current access, then replays the same command even if its applied request has left
the queue. Current denial conceals identifiers and retry; conflict requires a fresh queue and deliberate review.
Success refreshes the first queue page before allowing deliberate review of further actions. No second claimant is
automatically approved. Failed refresh after an approval withholds the receipt presentation and further actions.

Story IDs are `pages-community-realm-claim-review--pending`, `--empty`, `--sparse`, `--denied`, `--conflict`,
`--uncertain-retry`, `--success`, and the corresponding `patterns-community-realm-claim-review--…` IDs. Pages use
the actual AppShell and integrated review source, with existing phone390/desktop1280 and light/dark globals.
Fixtures are explicitly declared response examples, not native recordings or claims of authority. The focused
acceptance file is `tests/realm-claim-review.test.ts`; acceptance, native and visual proof run after integration.
No external reference-project source was required.

The added transport cases cover the default current-session GET, exact cursor/Realm scope, sparse continuation,
native failures and malformed disclosure. Local `bun run --cwd apps/web typecheck` passed with no type errors;
acceptance, native and visual execution remain deferred to integration.
Web's review sources remain `src/stories/realm-claim-review.stories.tsx` and
`src/stories/patterns/realm-claim-review/realm-claim-review.stories.tsx`, using the IDs above at normal 390/1280 widths
in light/dark. This transport change adds no renderer or story export and claims no visual approval.

### Space and Realm lifecycle controls

`community/container-lifecycle-controls.tsx` composes one lifecycle region per container on the existing Space page.
The default adapter uses `community/container-lifecycle-native.ts` through the existing first-party server functions,
session preparation and CSRF header. It calls the generated `/lifecycle`, `/removal` and `/restoration` methods on
Spaces and Realms. Active commands intersect the native `mayRemove` verdict with the exact installed viewer action
and catalogue operation (`space:manage` / `space.remove`, `moderation:takedown` / `realm.remove`). Removed resources
use the private lifecycle reader's `mayRestore`: ordinary viewer-action discovery deliberately withholds them.
No custom-method alias, client role policy or browser clock substitutes for native admission. Presentation fixtures
remain examples, with no claim to native authority.

Removal records the entered reason and confirms the named target. The native producer decides moderator removal and
the 30-day restore window, including current remover/higher-role/platform eligibility. Spaces have direct owners;
Realm moderator authority never becomes Space management authority.
Membership, creator identity and browser time never substitute for that decision. Each intent retains its target,
Context pointer, reason, exact expected head, decimal lifecycle version and request key across uncertain retries.
The command body carries `expectedVersion`; `If-Match` and `Idempotency-Key` carry quoted strings. Lifecycle versions
are compared as integers without conversion to JavaScript numbers. A conflict retains the draft; a fresh read and
explicit review are required before a new request accepts different CAS values. Native refusal status/code stay
visible. No platform claim action is offered without its actual endpoint. Orphaned Realms keep ordinary reading while
publication, setup and management controls are frozen.

Confirmed removal hides the old container content without changing routes or selecting Global. A restored link
requires fresh ordinary container reads and an independent native `contexts({id}).get` authorization for that exact
live Context. The pointer comes from the ordinary Realm read, including the authorized carried Realm on
a Space; the lifecycle response supplies no pointer. Removed reads retain the observed pointer as data only.
Destination preparation compares both current Realm/Space heads, lifecycle versions and their exact binding before
and after the independent Context read. A changed host version, missing permission, changed pointer or hidden
container withholds the link. The destination is the existing Realm page, with no subject/publication disclosure.
Failure keeps the link unavailable and the entered work intact. Navigation
reloads the page rather than redisplaying the previous payload. Context identity and independent Global identity stay
separate. Work is constant per container: an active refresh uses at most seven point/admission requests, a removed
refresh uses one private lifecycle request, and a command uses one POST. After restoration, destination preparation
uses at most thirteen requests, independent of list size. There is no per-card authority fanout, refill or scan.
The delivered `readContainerBinding` / `revalidateContainerBinding` data port takes an `AccessClient` and native
`AuthoritativeTime`; it is not an HTTP client or a Context grant. This Web consumer compares generated authorized
reads instead of importing database authority. Both private lifecycle readers must be accessible for a destination;
a Realm moderator without Space lifecycle access can still remove/restore the Realm, while its destination stays
unavailable. Broader destination availability needs an authorized HTTP exposure of the native binding read/revalidate
port carrying both versions; the existing independent Context GET is already available.

The complete pattern folder is `stories/patterns/community-lifecycle/`; its `Patterns/Community/Container lifecycle`
states include confirmation, removed, uncertain retry, native refusal, conflict, orphaned, read-only, loading and
unavailable. `pages-community-container-lifecycle--management-journey` reuses that region inside AppShell. Review the
same story IDs with phone390/desktop1280 viewport globals and locale/theme globals. Native acceptance and Web/Root
visual review remain required after producer integration.

### Community page head

- **Touches:** Builds title, description, the first available published cover (or default share card), robots and one JSON-LD graph from the Space and
  public Realm data already rendered by the page. A protected Realm marks the page `noindex, follow`.
- **Bound:** 0 additional K, D, R or A; constant local work per page.
- **Growth check:** `tests/community-seo.test.ts`: unique localized metadata, public visibility, one WebPage and
  BreadcrumbList graph, and no server session reread.

### Realm leave recovery

The existing `RealmMembership` keeps participation unchanged after a refused leave. Its recovery region in
`community/realm-leave-recovery.tsx` separates an explicit native RFC 9457 `effect_status:not_applied` from a lost,
malformed or otherwise uncertain response. Only a leave response matching Accounts' declared `409 realm_last_owner`,
standard type/title, `retryable:false` and `not_applied` supplies the specific ownership explanation. Generic denial
offers conditional policy guidance; membership, creator identity, role data and error details supply no ownership
verdict. The consumer is ready for the declared problem; the native guard producer and same-Realm leave admission/
publication binding remain owning integration work, with no native pass inferred from this interface.

An explicit Review ownership and access action mounts the original Accounts `ResourceAccessLink`. It reads genuine
current `readResourceAccess` authority only after signed-in hydration, then links to localized `/access/{resourceId}`.
Denied or unavailable Access hides that link and retains the explanation. The existing Access page can add another
eligible explicit owner; it does not expose the native atomic transfer helper as an HTTP/UI operation. After resolving
a refusal elsewhere, Check membership reads both native membership and participation before releasing the old intent
and allowing a new leave request. An uncertain still-member/pending/denied read retains the original action/key;
explicit retry reuses it. Checking never sends another leave. A `202 {workflowId}` still enters the existing pending
flow with at most four authoritative refreshes and manual read retry. Independent Space following is unchanged.

Review the same controller through Page IDs `pages-community-realm-leave-recovery--owner-required`,
`--generic-refusal`, `--access-denied`, `--uncertain-retry`, `--accepted-pending` and the same suffixes under
`patterns-community-realm-leave-recovery`. Pages use the actual Space route in AppShell with one main; Patterns mount
the same membership component. Existing viewport/theme/locale globals supply normal 390/1280 review. Story-only native
problem/acceptance envelopes exercise refusal, denied Access, retained retry keys and pending settlement; they fabricate
no grant, transfer or successful leave. The existing acceptance in `tests/realm-leave-recovery.test.ts` is retained,
with a focused closed-problem case added. Acceptance, native, browser, visual, physical and privacy/replay proof remain
deferred under the current minimal verification contract.

Cost: one native leave per explicit intent/retry, no automatic command retry; one existing membership + participation
read per recovery check, and one current Access read per explicit review mount. There are no per-row reads, permission
mirrors, grant writes or new membership workflows.

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
  list. The collection page of a signed-in person who is not the curator of a public or unlisted collection adds one
  `GET /v1/follows/<id>?view=FULL` after its own two reads, with the session credential it already holds.
- **Bound:** 1 D, 1 K, 0 R and 0 A for each change, independent of the collection's size. The follow state is one more
  kernel read. The curator's collection loader has none; its browser control reads the own edge separately.
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

### Follow controls

The control placement from [follow research](../../docs/research/accounts-design-follows.md) is adopted for existing
Subject, linked agent Subject, Space, curated/dynamic Collection and private Following pages. An agent page uses its
actual catalogue Subject ID; there is no Account target or required handle navigation. Removal uses `follow.delete`
independently of `follow.put`, edge-read or target-read availability. It retains the stored original edge ID,
including when Following's embedded target is unavailable. Native own-edge removal corrections belong to Commerce;
the interface preserves a refused removal and never bypasses the native command.

Controls mount after browser session preparation. A new target control shares one keyed private BASIC edge read;
Collections and Following reuse their existing private read, with no read per row or per button. A Collection
curator gets one browser BASIC read. Missing edges and failed reads remain distinct. Each write uses one prepared
session and one native PUT/DELETE with CSRF and an idempotency key retained across ambiguous retries. Conflicts and
permission failures stay visible. Follows convey no read grant, membership, Library fact or entitlement, and these
controls read no follower counts.

`Patterns/Following/Follow control` uses the real presenter in `Pages`, with IDs
`patterns-following-follow-control--follow-and-remove`, `--delete-only`, `--unavailable-target`, `--loading`,
`--pending`, `--ambiguous-retry`, `--conflict` and `--revoked`. Review the same IDs at 390/1280 through locale and
theme globals. `Pages/Library/Following` adds `--remove-unavailable-target` using the recorded list plus its existing
contract-shaped DELETE fake. Root screenshot review and postintegration acceptance remain pending; typing alone
does not establish either outcome.

### Settings page

Verification recovery starts a fresh private status query and rejects request identities or revisions older than the latest observed read or receipt; receipts remain unresolved until an identified current readback, and rendered diagnostics use bounded public identifiers and standard Retry-After forms.

Profile name, biography, links and avatar remain a local draft until **Save profile**. The visible live unsaved
indicator compares only those Profile fields, never Public activity. It yields to pending or unknown command
outcomes; existing save, confirmed readback and recovery announcements retain their separate meanings.
Local preview requires both supplied link approval and a safe HTTPS destination; stale approval keeps invalid destinations inert without rewriting them.
Link labels must contain non-whitespace text; validation preserves the exact draft for correction before saving.
Notifications and Collection visibility explain automatic saving inside their own sections.
Public activity choices remain local until **Save activity choices**; its unsaved announcement compares only activity fields.
An uncertain activity save keeps its original operation for explicit retry; later choices remain editable and require a separate save after recovery.
Opening, closing or updating the local Profile preview neither saves nor replaces activity choices.
Recovery still requires the existing explicit review and confirmation controls when indicated.
Save and reload readbacks retain later explicit field edits, including a return to the original value; retries
retain that same draft protection for the original command.

Profile callers give short inputs and actions a minimum 44px target. Actions wrap long labels and grow in height;
biography keeps its multi-line control. No shared primitive defaults or save transports change.

The focused default-composition regression is `pages-account-settings--saving-boundaries`, using the installed
`PageStory` route and recorded fake-fetch boundary. It checks initial guidance, a live unsaved announcement with
zero writes, one explicit Profile PATCH with confirmed status, and one separate Public activity PATCH with no
Profile resend, plus the rendered short controls' minimum-target classes and styles. Browser and native execution
are deferred to integration; local workspace typing does not establish visual or native acceptance.

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

- **Touches:** The preferences read the page already makes; one PATCH per change. An uncertain save retains its
  original input, expected version and idempotency key. Each explicit retry replays that PATCH and, after success,
  makes one fresh private preferences GET. A historical receipt never replaces newer native values. Draft edits
  remain separate until the original outcome is known; conflict reload and newer readback require review before
  deliberate resubmission. Preferences affect future optional sends, never notices already in the Inbox.
  Moderation decisions, report outcomes and appeal outcomes remain mandatory.
- **Recovery choice:** Native failures retain their immutable operation in a private response body; reviewed retries write only deliberately changed kinds, and Restore remains a null patch.
- **Bound:** The map holds a few kinds; rendering is linear in it. Missing or malformed notification preferences show an unavailable state; the client never supplies enabled values for absent native fields.
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

Private Copy notes use multiline entry and keep exact text through Stay and recoverable refusal. The existing write
adapter enforces the 1,000-Unicode-character note bound; browser UTF-16 length limits would reject valid text.

- **Touches:** One session read, then `GET /v1/copies?view=FULL` with `subjectId` when the URL names a subject,
  for one page of the viewer’s copies. The subject also pre-fills the Edition field in the add form. Adding, editing and
  deleting each send one write with an `Idempotency-Key`; an edit sends the revision in the body and a deletion sends
  `?revision=`.
- **Bound:** 1 D and 1 K for a view, which reads at most 100 copies, whatever the number of copies or subjects;
  1 D and 1 K for each change; 0 R and 0 A with a fresh credential.
- **Growth check:** `tests/library-copies-cost.test.ts`: `copies stay within their bound as the copy list grows`

### Reading progress

Decision: After a definitive index-row finish refusal, explicit review uses the existing viewer-bound index read at the same subject and cursor; only a matching returned row unlocks a separate new confirmation, while uncertain retries retain their original sender, credential, revision, action and key.

Active corrections and clearing use a confirmation showing exact captured operands. A clear sends
`{revision, clear: true}` to the existing record API, retaining session identity, lifecycle, accepted meaning,
captured total and history. Drafts survive closing the editor; retries retain the original revision, key and
operands. After a definite conflict, explicit latest-progress review retains the draft and creates a new intent.
Decision: Stay keeps the editor open with its exact fields; confirmed Discard closes it and drops only the unsent update.
Decision: Stay keeps the editor open with its exact fields; confirmed Discard closes it and drops only the unsent update.

- **Touches:** One session credential read, then GET session, one changes page and one completed-units page started
  together (`view=FULL`). A record is one POST `:record` after that credential read.
- **Bound:** Session view: 1 D and 3 K in parallel, 0 R, 0 A. Each history read is one page of at most 100. A record is
  1 D and 1 K carrying at most 100 unit ids. No per-unit or per-change reads.
- **Growth check:** `tests/library-progress-cost.test.ts`: `reading progress stays within its bound as its pages and unit batches grow`

Explicit empty or non-string Progress address operands are invalid; correcting one field retains every other requested field. Cursor admission uses the native 4096-character bound without decoding, and malformed addresses read no private history.

### Progress subject picker

- **Touches:** One `GET /v1/subjects:suggest` per settled keystroke (250 ms pause; a newer keystroke aborts the older
  read). The page's own reads are unchanged.
- **Bound:** At most one suggestion read in flight per picker, each answering a fixed number of suggestions,
  independent of the catalogue's size and the reader's sessions.
- **Growth check:** `tests/progress-pages-layout.test.ts`, 'both pages render without JavaScript and make the same kernel reads as on base, plus at most one suggestion read per settled keystroke in the picker'

### Published logs

The Progress correction editor and a non-whitespace publication note share one page-level departure choice. Stay
preserves the local drafts; when no command is unresolved, Discard clears them without submitting. A confirmed
publication follows its Read log destination without a stale draft warning.

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

The thread page follows the adopted [targeted reply slice](../../docs/research/content-threads-boards-design.md).
Reply to this post selects its identity and focuses the existing composer. Cancel clears the target and keeps the
draft. After a known refusal, selecting a different target, cancelling, or changing an attempted draft starts a new
command intent; retrying an unchanged draft preserves its parent, body, media and idempotency key. An uncertain post
retains the original command and key. A changed draft, session or target must be restored before that command can be
retried; only a known refusal permits a different intent. Controls cannot change a pending intent.
The returned post identity is rendered once, with neutral reply context. A loaded parent links to its local slot,
including its tombstone; an unloaded parent has no link or copied text. Deleted and withheld parents never supply
preview text. Removed replies retain their own parent context too.

Target selection adds no reads: one O(page limit) identity map serves all reply contexts. The existing reply command
sends the optional `parentId` through `replyToThread` to `POST /v1/threads/{id}/posts`; native current authorization,
same-thread validation and the 32-parent ancestry bound remain authoritative. No ancestry fetch is introduced.
The focused outcomes are in `tests/thread-replies.test.ts`. The reusable `Patterns/Community/Thread replies` folder
documents selection, cancellation, retry, refusal and unloaded/deleted/withheld context. Review the same story IDs
at phone390 and desktop1280 through viewport, locale and theme globals.

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

### Report receipt (`/moderation/reports/<id>`)

The existing report notice destination, `/moderation/reports/<id>`, is a private receipt. Its shared
`ReporterStatusPage`/`ReporterStatusView` presents the owner's reason and evidence separately, explains the native
pending/actioned/dismissed disposition, and shows Submitted/Reviewed times without inventing a review date.
Actioned is the report disposition and survives an appeal. Current target availability never authorizes a target
read or a guessed target link; unavailable targets retain the reporter's own submission. Reference IDs and any
submitted revision expand for copying with explicit clipboard success/failure. The contextual return link uses the
existing Inbox route. The source remains one exact report GET with private no-store responses, unrelated/missing
404s and explicit retry for dependency failure; presentation adds no kernel, count, identity or content reads.
`Patterns/Reporter status` documents its states and interactions; `Pages/Reporter status` uses the real route and
shared shell. The same IDs use phone390/desktop1280 and locale/theme globals for later visual review.

### Notifications inbox (`/inbox`)

- **Touches:** One private notification page read, one optional batched public identity read for its distinct actors, then at most one existing post, decision or report read per distinct target; the navigation badge reads the capped count after hydration.
- **Bound:** A page contains at most 20 notices (`INBOX_PAGE_SIZE`) and at most 22 page kernel reads (`INBOX_PAGE_KERNEL_READ_CEILING = 2 + INBOX_PAGE_SIZE`): one private list read, one batched actor identity read and at most one target read per notice. The navigation badge adds one capped count read inside its 60-second stale time. Opening marks the newest notice once; a failed mark offers explicit retry. Dependency or malformed count/list unread data stays unavailable and never becomes zero, read, or a successful empty Inbox.
- **Refresh:** From a successfully loaded continuation page, refresh retires older pages and reads the native first page. It does not mark anything seen or change an uncertain mark-seen target or idempotency key.
- **Continuation:** An explicit successful continuation focuses the existing Inbox heading and announces its result; sparse pages offer Next, pending activation is guarded, and failure retains the same focused control as the exact retry. Background updates and retired viewers never trigger the handoff.
- **Growth check:** `tests/notifications-inbox.test.ts` checks pages of 5 and 20 notices naming three repeated posts and limits reads to the list, distinct targets and count. The native notification acceptance measures the served inbox at 1, 8 and 64 unrelated boards with its selected page fixed.
- **Visual check:** Inbox stories cover empty, mixed, hidden targets, preparing, closed, unavailable and more-than-99 unread states. Review the reference state in all eight launch locales at 390 and 1280 in light theme and in English and Japanese at both widths in dark theme; review each other state in English and Simplified Chinese at both widths and themes.

### Moderation decision (`/moderation/decisions/<id>`)

The route uses the existing `DecisionPageView` inside AppShell's single main. The same view supplies the reusable
Pattern and Pages stories. The latest recorded outcome leads the page; the original takedown reason/date and the
independently read current content availability have separate sections. A reversed appeal never implies a readable
target. Unknown, withheld, erased, removed or mismatched targets expose no preview, target identifier or link. Only
the authorized native decision's own reference is displayed. Available post text uses the shared document reader.

The deadline is the native DTO's inclusive 183-day deadline. The local clock and any readable author identity only
control the form hint; an unavailable target cannot establish authorship. Native commands recheck current author,
deadline and single-appeal admission. Pending and resolved states come only from a native decision read, including
independent reviewer statements and resolution times. A successful write without a visible appeal remains uncertain.

Current denial, known conflict and uncertain confirmation have distinct messages. Drafts survive each failure.
Only uncertainty offers an explicit retry with the identical statement and command UUID. Denials and conflicts
require a fresh read before another attempt. Every write attempt hides the previous target link until an explicit
current-state refresh; a failed refresh keeps content hidden. Late responses from an old page are ignored.

- **Touches:** The page reads its private decision, one post/thread and the private decision again for final disclosure.
  An appeal sends one command and, after success or conflict, at most one decision read. Refresh repeats the page read.
- **Bound:** At most three native reads per page/refresh, no history or target fallback. Each submit/retry sends one
  command and at most one exact decision read, using the existing native command authorization and quoted key.
- **Acceptance:** `tests/moderation-decision.test.ts` retains the original cases and adds the named receipt/appeal
  outcome, unavailable-byte/final-denial race and denial/conflict/uncertain-confirmation cases. Execution is deferred
  to integration under the current minimal verification policy.
- **Local verification:** `bun run --cwd apps/web typecheck` passes. Acceptance and story plays were not executed.

Review the same IDs with the existing phone390/desktop1280 and light/dark globals:

- `pages-community-moderation-decision--open`, `--pending`, `--reversed-unavailable`, `--upheld`, `--available`,
  `--expired`, `--native-denied`, `--conflict`, `--uncertain-retry`
- `patterns-moderation-decision--open`, `--pending`, `--reversed-unavailable`, `--upheld`, `--available`,
  `--expired`, `--native-denied`, `--conflict`, `--uncertain-retry`

Pages compose the served `DecisionPageView` in the actual AppShell; Patterns use that same component without the
shell. Focused plays cover the single main, current outcome, hidden target, confirmed pending receipt, retained draft,
terminal refusal and exact lost-response retry. Constructed native DTO fixtures establish presentation only. Web owns
390/1280 light/dark visual review; this delivery runs no browser, screenshot or native acceptance. English messages
use the configured base-locale fallback pending localization review. Source references read for this surface were
`services/kernel/src/content/{README.md,moderation-decisions.ts,appeal-routes.ts,schemas.ts}` and the existing shell,
report queue and reporter views. No external reference-project source was named or needed.

### Appeal retry and reviewer confirmation

The decision form, report actions and independent appeal resolution keep one browser command UUID for an unchanged
intent across uncertain responses. Server functions validate and forward that UUID as the existing quoted
`Idempotency-Key`; each attempt still uses the current session and native command authorization. Editing a statement
or changing the action or target starts a new intent. Draft text survives failures and the author retains the existing
success/conflict decision reread, inclusive 183-day deadline and single-appeal rules.

An independent reviewer sees the confirmed upheld/reversed result and statement in the queue row until navigation;
the page does not immediately reload the pending-only queue. Denied, unknown and conflicting commands never display
confirmation. This uses existing command responses and queue DTOs, without additional queue or per-card reads.
`Patterns/Appeal Resolution` documents pending, uncertain-response retry, confirmed outcomes, current-authority refusal,
conflict and read-only states, with shared locale/theme/viewport globals and the same component used by the page.

### Board moderation reports (`/boards/{id}/moderation`)

- **Touches:** One page of at most 20 reports for the selected board, thread or known post, then one existing target read for each distinct target on that page. A post-specific report page uses `?post=<id>`; report APIs are target-scoped, so the page does not discover child reports by walking the board.
- **Bound:** Reports use at most `1 + D` kernel reads for `D` distinct targets on the selected page. The appeals tab uses one page of at most 20 native appeals with the decision statement and target included in each row, then one existing target read per distinct post or thread; it makes no per-appeal decision reads. Each submitted moderator action issues one write.
- **Growth check:** `tests/moderation-reports.test.ts` pages repeated targets and confirms one target read per distinct identity and preserves the cursor. `tests/native/native-moderation.host.test.ts` fixes the appeal page and target while adding 1, 8 and 64 unrelated posts; the page still makes one appeal request, one target read and no decision reads.
- **Visual check:** Report stories cover open and resolved reports in English and Simplified Chinese. Appeal stories cover a pending native appeal in all launch locales and the empty queue in English and Simplified Chinese; use light and dark themes at 390 and 1280 pixels.

### Catalogue moderation reports (`/moderation/catalogue`)

Decision: the shell shows signed-in readers a link to this route; native Global authority admits every queue read and command, and denied reads reveal no report evidence.

Decision: use one private catalogue queue at `/moderation/catalogue`; `/moderation/reports/<id>` remains the
reporter's own receipt. This is the consumer of Content's Subject-report contract, not another native producer.
The existing native Subject-report owner supplies `subject_report.list` and `catalogue_report.list`; the
interface follows that delivery. Catalogue inspection requires `moderation:read_reports` on the Global Context.
Use newest-first native keyset pages of at most 50 reports, without board traversal or browser refill.
Keep submitted evidence separate from currently readable Subject content. Reuse native dismissal and Semantic's
existing Subject visibility/takedown operations; never offer a Content appeal for a catalogue sanction.
An actioned report stays actioned after restoration. Private-reader retirement clears evidence and action drafts
on viewer or credential replacement; uncertain writes retain their original intent and idempotency key for
explicit recovery. A denied queue stays concealed and a dependency failure offers explicit retry.

### Exact recorded revision (`/posts/{id}/revisions/{revisionId}`)

History version links address the returned post and revision IDs. The read-only page uses that exact native GET,
then one current thread GET for its actual back-link identity and, for an opening post, a differing-head notice.
Neither today's document nor its subject/vote references replace the recorded revision. Current refusal discards
all previously readable content; missing, removed and withheld responses stay neutral without an inferred reason.
Dependency problems offer an explicit fresh retry. Route entries and retries bypass cached revision data; responses
are private/no-store, and the existing shell supplies locale/canonical routing and one header search.

The bound is one exact resource and one thread point read, plus at most two existing public account batches for
author/mentions. No parent, history, directory or per-reference requests run. Independent subject labels have no
admitted batch-summary transport here, so provenance retains stable recorded IDs without links. Immutable citations
need no private vote read. `Patterns/Community/Exact revision` and its Page stories share the product reading region;
constructed native DTO examples do not establish native acceptance. The two focused outcomes live in
`tests/exact-revision.test.ts`.

#### Document images in exact revisions and history

Exact revision and native history reads expose a consumer-local `documentMedia: { kind: 'unavailable' }`
boundary in `threads/exact-revision-media.ts`. The original `threads/document-media.ts`, its
`document-media-image.tsx` re-export and the native `content/media-presentation.ts` source are absent from this
checkout. This boundary makes no media requests and introduces no renderer, variant list or download URL.
Both readers retain the actual Web `DocumentBody` wrapper and its localized, accessible unavailable image state.
An unavailable image says nothing about erasure, permission, copies or the existence of the original.

The consumer needs the original shared exports, without a second adapter or provider API:

- `loadDocumentMedia(client, ids, authorization?)` returning
  `{ kind: 'ready'; images: ReadonlyMap<string, DocumentImagePresentation> } | { kind: 'unavailable' }`.
- `NativeDocumentImage({ image: DocumentImagePresentation | null, alt, locale })`, re-exported by that module.

When those exports are delivered, replace the isolated absence boundary with the original import and supply
`NativeDocumentImage` as the explicit `DocumentBody.renderImage` callback in exact revision and `PostHistory`.
The canonical native presentation contains only original ID, container ID, digest, dimensions, actual AVIF/WebP
variants, placeholder, focal point and native credit. Select only returned variants through `coverSrc`; the
authorized Worker download remains the final media authority. No guessed derivative, original, external URL,
per-image GET, renderer fetch, retry or refill belongs in these consumers. Paid content and an author's current vote
do not supply generic post or image authority.

`revisionDocumentImageIds` selects at most 32 distinct original IDs from available bodies on the delivered page,
intersecting each body's image references with that revision's own declared `mediaIds`. Withheld/erased bodies,
unused declarations, current-head substitutions and other history pages contribute nothing. Overflow images stay
unavailable. Each independent history request still asks for 20 revisions with the original cursor and does not
drain subsequent pages. The existing exact resource and thread reads, native before/final document disclosure,
immutable provenance and current author/mention disclosure remain independent of media.

The named acceptance journey and focused current-denial/page-bound cases are in `tests/exact-revision.test.ts`;
execution remains deferred to integration. Web can review the actual unavailable-image Page at
`pages-community-exact-revision--document-media-unavailable`, from `src/stories/exact-revision.stories.tsx`, using
the normal phone390/desktop1280 and light/dark globals. Its DTO is constructed; it proves neither native media
authorization nor visual approval. No external reference-project source was named for this connection. Source
reads were the shared document wrapper/renderer, exact/history reads, native content schemas/routes/document
contract, media import credit type and the existing Worker `coverSrc` route.
Local verification: `bun run --cwd apps/web typecheck` passed with no type errors in 1,146 files. Acceptance,
native, browser and screenshot checks were not run under the minimal verification contract.

The reusable [Moderation report queue](src/stories/patterns/board-report-queue/board-report-queue.mdx) is the
actual report review region. It separates submitted evidence, the exact ordinarily readable revision and the
current target. Review actions open on demand; one nonempty takedown reason is capped at 1,024 characters, while
dismissal needs no reason. Failed commands keep the draft and unchanged command intent. Pending and confirmed
commands remain visible; a takedown confirmation does not claim that projected report outcomes have finished.
Confirmed takedowns hide both body surfaces for that target throughout the returned page without another read.
Native outcomes and resolution times stay visible until navigation. Empty pages retain native continuation.
The route supplies Back to board from its known board ID without a header lookup or invented community metadata.
Loading/error states expose no report details. Appeal and reporter-status destinations remain separate.

Use the same `patterns-moderation-queue--open`, `--resolved`, `--target-unavailable`, `--revision-differs`,
`--native-denied`, `--uncertain-retry`, `--retry-confirmed`, `--confirmed-takedown`, `--confirmed-dismissal`,
`--empty-with-next`, `--loading` and `--error` IDs at phone390/desktop1280 with locale/theme toolbar globals.
Pages keep `pages-community-moderation-reports--open-reports` and `--resolved-reports`, and provide
`--target-unavailable`, `--revision-differs`, `--native-denied`, `--uncertain-retry`, `--empty-with-next`, `--loading`
and `--error`. These are interface review inputs; native proof and visual approval remain separate.

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

The existing Editor upload callback uses `media-upload-recovery.ts` for both the composer and inline revision editor.
Its mounted, at-most-32-entry map retains only the original File, immutable thread/container or future board/key,
actual signed-in subject/session CSRF identity and the reservation ID returned by `UploadRefusal.mediaId`. Editor Retry
uses the original producer's declared `resumeReplyImageUpload(mediaId, file, signal)`, never another reservation or
byte upload. This checkout lacks that export and the original post uploader does not yet return its known reservation
on failure: the isolated consumer returns unavailable until those original producer declarations arrive. It does not
guess an ID or reserve again when a failure supplies none. A target/session change invalidates the old upload and asks
for removal/reselection; native abandoned-object collection retains its original 24-hour ownership. Rejection requires
a deliberate fresh file selection. Success, Editor dismissal/abort and unmount release pending entries and abort work.

After native `media_unavailable`, the draft keeps its text, alternative text, title, subject/citation selections, target
and command key. Processing, rejected, erased, missing/inaccessible, already-used and unknown statuses remain distinct.
Unknown status retains the actual draft ID and blocks Send/Save. Check again calls one private server function for at
most 32 unique actual draft IDs through the existing uploader-only native metadata reader; it sends no post command.
Reading available metadata never grants claimability. Publishing still requires a separate action and the current
native validator. Denied/closed writes do not trigger metadata reads. No presentation DTO, media catalogue, document
reader fallback, persisted draft, bearer cache or new Editor implementation participates in recovery.

The focused integration acceptance is `tests/thread-media-recovery.test.ts`. Review the actual Page ID
`pages-community-thread--reply-media-unknown` and existing `pages-community-thread--reply-media-unavailable`.
The existing target lifetime Patterns remain `patterns-community-thread-replies--selected`, `--cancelled` and `--retry`.
Web owns ordinary phone390/desktop1280 light/dark review and screenshots through the existing globals. This delivery
runs local Web typing only: `bun run --cwd apps/web typecheck` passed with no type errors. Acceptance, native, browser
and visual evidence remain deferred to integration.
Source read: the existing native media claim contract, Web reservation/state/upload boundaries, Editor upload manager,
reply intent/target composer, current document image contract and thread recordings/stories. No reference project is
named for this recovery surface, and none was needed.

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

### Publish Recipe structured data

- **Touches:** Only the public subject, related identities and validated document snapshots already supplied to the
  page. No network request, Source read or metadata lookup is added. `schema:cookTime` uses the released integer
  minute unit (`http://www.wikidata.org/entity/Q7727`): `+25` becomes `PT25M`, including zero and safe large integers.
  Unknown units, malformed or unsafe amounts and uncertain bounds cannot produce a duration. Other quantities retain
  their existing representation. Instructions use the page's rank and document language selection, document reading
  units and language attributes. Paragraphs, including those in nested lists and tables, become ordered `HowToStep`
  items, grouped under authored
  headings as `HowToSection` items. Concealed statement and inline spoiler branches stay out; opaque components supply
  only their visible fallback. A related diet keeps its disclosed identity; a label alone supplies no ontology mapping.
- **Bound:** O(public statement and document bytes), with the existing page descriptor limits (16 reads, cost 128) and
  document caps unchanged. Serialization adds no cached authority or aggregate. JSON-LD escapes HTML-sensitive text.
- **Growth check:** `tests/recipe-page-structured-data.test.ts` counts the composed page request with unrelated records
  held outside the selected Recipe and checks exact public instruction text and serialized byte growth.
  `tests/native/recipe-publication.host.test.ts` creates actual released Recipes through the ordinary APIs and compares
  public/page reads and served HTML/JSON-LD, including unrelated record growth, a Japanese instruction body in an
  English page and authored-document owner erasure. The released instruction property stays single-valued; language
  cases create separate Recipes. The erasure control uses the existing document owner grant, without changing scopes.
  These counters describe this publication slice, not whole backend or private population cost.

The native authored-document producer currently replaces an input snapshot with `{language, document: id, digest}`
(`services/kernel/src/semantic/authored.ts`). Ordinary subject reads and `pages:read` retain that reference, while the
page's document renderer requires an inline validated snapshot. The native instruction cases intentionally require
that missing public body; a reference alone is never permission to emit text. Satisfying those cases requires an
owner-approved public body producer within the existing page-read and disclosure contract. The serializer does not
fetch `/v1/documents/:id`. Diet enumeration mapping metadata is also absent; public related identities remain usable.

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

### Creator read and command admission

The shared creator origin admits offers, Sales and statement reads and read-only refresh from the current signed-in
subject and its advertised operation, independently of CSRF. Session epochs and exposure changes retire old callbacks
and delayed responses, including same-subject ABA; missing or closed authority conceals private reads. Healthy
same-viewer session renewal may retain an accepted read after fresh exposure admission. New commands require a current
mutation credential. Read recovery never resolves or renews an uncertain command, its captured offer terms or statement
reference. The statement consumer keeps its existing reader and guard/intent API; no parallel reader is added.

Decision: explicit uncertain retries require current command admission but reuse the original captured sender, CSRF,
key and operands; a new read or token never replaces that original. Statement evidence refresh requires only read
admission, including while its command credential is missing.

### Creator offer address recovery

Malformed owned-offer cursors stop before a private read and offer an explicit first-page link. Malformed,
repeated or conflicting edition selectors display all requested aliases and a blank edition correction form;
submitting that GET form opens the exact chosen edition without issuing an offer command. Valid `editionId` and
`contentEditionId` aliases, including equal aliases, retain their exact identity. Requested selectors remain
visible during preparation and denied reads. Current read admission remains independent of CSRF; existing
session/address retirement and captured uncertain command operands are unchanged.

Decision: edition correction starts blank so resolving an ambiguous address always requires an explicit choice.

### Creator offer drafts

Create and reprice forms compare exact raw fields to their empty baseline and announce unsaved changes live.
Internal router and same-origin anchor departures ask Stay or Leave once for all edited offers; supported document
unload uses the browser warning. Stay preserves fields, edition and field focus. Leaving discards only unsent
local edits and sends no command. Pending or uncertain commands may already have committed; leaving preserves
the existing request and intent store without retrying. Pristine, exactly reverted and confirmed saved forms do
not warn. Current-origin retirement continues to hide private fields immediately.
Decision: an unresolved departure retains the existing in-memory intent only; this feature adds no persistence.

### Confirming creator offer availability

After a successful reprice or delist response, the creator offer controls request one fresh, bounded owned-offer
page. Only a matching row with a revision newer than the captured draft replaces the displayed price and
availability. An uncertain write retains its original payload and key; it does not start this confirmation read.
Failed, missing-row or old-revision confirmation reads keep the recorded result and draft visible with read-only
recovery. They never replay the saved command. A confirmed active row permits another edit with a new key; a
confirmed delisted row removes the public offer link while preserving history and the recorded result.
Existing sales keep their accepted terms and benefits; these controls change future availability only.

Seller changes now submit the reviewed `expectedRevision` for both price and withdrawal. A native revision
conflict preserves the price draft and original request, disables mutations and offers explicit reload/review.
That action fetches the current permitted owned-offer row without a mutation credential requirement. Only a newer
matching row ends review; failed or absent reads preserve the conflict. Review retains the typed price, allocates
new command keys and requires a separate action against the displayed revision. Background refreshes never rebase
an uncertain or conflicted command. Uncertain retries retain the original CSRF token as well as key and operands;
current-origin admission and a current mutation credential remain required.

Decision: preserve trusted native command compatibility with optional preconditions internally, while both seller
HTTP operations require the revision reviewed by the creator. No Web preflight replaces the native row lock.

### Checkout start (`POST /checkout`)

- **Touches:** CSRF origin and token checks, then D `credential` → one K `POST /v1/orders` with `{ offerId, expectedOfferRevision }` and the page's `Idempotency-Key`
- **Bound:** ≤1 D (credential, with any refresh's A) → 1 K. Constant body; no list
- **Growth check:** `tests/checkout-cost.test.ts`: `checkout start stays within its bound as s grows`

The offer conflict/review and original uncertain-intent retry paths remain separate. Decision: a successful native
create/replay result navigates to its exact order when settled, unresolved or without a usable hosted Checkout URL;
only pending orders with a usable URL enter hosted Checkout. The BFF validates the returned full order ID and
offer binding, and emits only `{orderId}` or `{checkoutUrl}`. Uncertain transport responses retain the original
operands, revision and key. No offer refresh, replacement key, price acceptance or additional create follows recovery.
With fresh credentials the composed recovery ceiling is one D credential call plus one K create/replay call:
two outbound operations, with zero follow-up reads, list pages or fan-out. Refresh retains the separately documented
[token refresh](#token-refresh) work when due. `tests/offer-consent-recovery.test.ts`
checks the single exact create/replay call at 1, 8 and 64 unrelated records; native producer bounds remain unchanged.

### Order return (`/<locale>/orders/<id>`)

- **Touches:** `/orders/<id>` redirects with the same locale rules as `/` and keeps the query. The buyer read is D `credential` → K `GET /v1/orders/<id>?languages=<locale>`, which returns the captured order title and sold subject summary. The detail composes this existing order read with zero or one K `GET /v1/entitlements/<entitlementId>` using the same prepared credential and only the exact ID returned by that order. Both reads share request-local promises. The current response must match both entitlement ID and order ID and contain a boolean `active`; denied, missing, unavailable, malformed and unrelated responses show unavailable access, distinct from a native null ID. A revoked entitlement leaves the paid receipt intact. Pending settlement rechecks every 2 s through `/orders/<id>/status`, which reads without `languages` and answers `{ id, offerId, settlement }`; a recheck never reloads access or the cover. When polling changes settlement, the page requires a refresh for current access. The browser loads at most one cover variant through the media route on the first render (one K `authorizeDownload`)
- **Bound:** ≤1 D → 1 K order read plus zero or one exact entitlement read for the initial detail. At most 15 further order reads (16 total) per return visit, including transitions between pending and unknown; zero entitlement reads on polls. Null entitlement ID makes zero entitlement calls. ≤1 download per visit. O(1) in buyer history, unrelated orders and grants; no lists, account joins, offer or price refetches, mutations or shared viewer cache. All detail/status outcomes remain private, no-store
- **Growth check:** `tests/checkout-cost.test.ts`: `order status read stays within its bound as s grows` retains the existing selected-order helper/status read counts at 1, 8 and 64 unrelated records. `tests/checkout-pages.test.ts`: `selected order current access uses one associated point read and keeps failures distinct from null` exercises the composed detail through the generated client, counts null/known/denied/malformed/mismatched calls, shared reads and the prepared credential, and verifies status polling makes no entitlement read. The settlement-transition case requires current refresh. Component examples in `src/stories/order.stories.tsx` cover active, revoked, unavailable, null and refresh states inside PatternStory plus AppShell; these remain pattern evidence and do not prove native authority. Refunded, long-receipt, unknown settlement/money, current-access and reconciliation actual-route cases wait on Commerce producer-owned matching responses. Promotion owns the existing native buyer/stranger/anonymous/cursor/provider/refund/growth cases and visual review.

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

Removing a keyed template requires confirmation; afterward the editor selects the generic template, preserving the
selected view when generic defines it. Publication resolves through the existing route, type, structural-base and
generic order.

### My Zones (`/<locale>/my/zones`, `/<locale>/my/zones/new`)

The authenticated workspace reads one native owner-index page with `limit=20`, `deleted` and opaque
`cursor`; it offers Active, Trash, next-page and first-page links without a client list walk or totals.
Open uses the current Zone reader. Configure and confirmed creation use
`/<locale>/my/zones/<id>/edit`, the editor slice's selected destination. No extra configuration read is
needed for the list. The existing session guard, request-scoped SDK, CSRF and private/no-store transport
remain in force. `features/zones/manage/navigation.ts` exports `zonesNavigation` for the shell's existing
`AppShellProps.navigation` insertion point; these static contributions contain no private state.

Creation requires an explicit inert definitions starter, retains all eight editable names and original
pages/scopes, and submits empty mounts with private visibility. Native Access/Scope/feature denial and
source readiness remain authoritative. Trash commands use quoted CAS revisions and retained idempotency
keys; the native original 30-day deadline is displayed without extending it. Uncertain delivery retries the
same command; conflicts offer refresh, and expired restores stay unavailable. There is no hard delete.

Focused stack-free proof is `tests/zones-owner-workspace.test.ts`. Review stories with Web at phone 390
and desktop 1280, every locale and theme: `pages-zones-owner-workspace--list`, `--empty`, `--trash`,
`--loading`, `--denied`, `--actor-denied`, `--feature-closed`, `--missing`, `--stale-cursor`, `--unavailable`,
`--expired`, `--move-to-trash`, `--restore`, `--conflict`, `--write-fenced`, `--uncertain-retry`; and
`pages-zones-create--choose-starter`, `--names`, `--created`, `--loading`, `--signed-out`, `--validation`,
`--denied`, `--actor-denied`, `--feature-closed`, `--conflict`, `--rejected-names`, `--uncertain-retry`,
`--saving`. Each suffix uses the full prefix of its group. Responses are synthetic, instance-local
fixtures; these stories do not claim visual, browser or native completion.

### Static Zone pages (`/<locale>/zones/<id>`)

- **Touches:** The home and configured relative routes read one static page through `POST /v1/zones/<id>:readPage`.
  The shared presentation renderer applies the Zone's appearance tokens around the configured document. A subject link
  leaves the Zone and uses the subject's global URL.
- **Closed source routes:** Zone subject targets, saved-scope and mounted-Collection reads, and source preparation are
  not exposed by the web routes. Direct `/zones/<id>/subjects/<subjectId>` URLs are not found while those capabilities
  remain closed. The header has no search box or scope control until the matching search capability is ready.
- **Bound:** A static route reads its selected page once and does not enumerate other Zones, subjects, or Collections.
  Private and unknown Zones render the same not-found outcome to an anonymous reader. Current read-time withholding is
  reflected in the next page and metadata response; page reads use `private, no-store` so an authorized response cannot
  be reused for another viewer.
- **Growth check:** `tests/native/native-static-zones.host.test.ts` measures the same configured page at 1, 8, and 64
  unrelated Zones and asserts one `readPage` request at each size.
- **Story data:** `src/zones/static-fakes.ts` supplies explicitly contract-shaped static pages in all launch locales;
  the subject link uses the existing `subject.json` recording. These fakes do not establish native authorization.
  The native fixture preserves its real response capture in `.temp/native-static-zones-recording.json` for later
  recording adoption. A fresh loader result replaces retained page content, including after a concealed read.
- **Focused regression:** `bun test apps/web/tests/zone-static-component.test.ts` renders the shared composition
  through the fake route-loader boundary in all eight locales without starting a service. It checks static content,
  localized links, the current navigation item, appearance overrides and concealed/unavailable states. Existing browser
  and native suites retain their scenarios for the promotion gate; this regression supplies no native or visual proof.

### Sitemap export

- **Touches:** One daily Workflow normally walks each feed once in cursor order, with one full restart if a cursor is
  rejected. A feed step reads at most 20 pages, targets 2,000 families, and flushes at most 3,000 families at a time
  while finishing its final native source page; each shard gets one R2 `head` and a
  `put` only when it is absent. Each feed keeps its file list in `runs/`; publication stages a run record and
  conditionally puts `index.xml` after every feed finishes, then lists `shards/` and `runs/` for retention cleanup.
- **Bound:** Feed requests are about N / 1,000 plus empty pages, a possible full restart, and retries. Each instance
  runs at most 4,990 feed steps before continuing in a new instance with its cursor. At 50 million families a run
  reads about 50,000 pages and writes up to about 17,000 shards when everything changed. Workers Free's 10 ms CPU
  limit cannot run these steps; the export requires Paid Workers.
- **Growth check:** `tests/sitemap-export.test.ts` runs 3,000, 30,000 and 300,000 synthetic families and checks linear
  feed reads, R2 operations and steps, plus the maximum families held by one step.
- **Feeds:** Boards, threads, Realms and Spaces use their typed kernel sitemap feeds; stalled pages are detected by
  item order rather than cursor tokens. The default Subject adapter consumes the delivered native `target`, `views`,
  labels, optional original language and meaningful change time in one anonymous, no-store request of at most 1,000
  source items. It reuses the reader's label fallback and canonical view paths, retains source order/ids and sparse
  continuation, and flushes expanded view families within the existing 3,000-family packing bound. Account overview
  and admitted posts/reviews/collections use the current native `canonicalPath` unchanged. The native target proves
  a current canonical overview root and declares no agents-feed ownership exclusion; Web does not suppress that family.
  Semantic intersects template views with the original native Account batch's admitted names and rereads that batch
  before its final metadata guards. Web validates the closed four-name Account contract without evaluating flags.
  Explicit empty views retain raw source progress with no URL family; missing/invalid targets or views fail
  replacement. No per-row discovery, permission evaluator or fallback subject identity is added. This source
  binding and focused fixtures do not establish native, whole-feed, privacy, cost, visual or promoted-main acceptance.

## Collection browse and editor

Curated and dynamic Collection descriptions use a measured four-line preview and the note reader's explicit, focus-retaining expand/collapse pattern; short text needs no control, and expansion preserves the complete plain text locally without reads or writes.

The existing Library Collections route composes `CollectionBrowseRow` or `CollectionPreview`, the shared Library
navigation, and a compact toolbar. Each row has one Open action and the disclosed native total. Genuine built-ins
come from the owner list; a current Collection title is not another tab. Pin management remains available in a
collapsed section. The compact search action focuses the shell's single query field; the current shell exports no
scope-registration or phone-search activation port. The header owner must deliver that port before this action can
register a Library scope or open the phone header search. It adds no second body query field.

The Collection page uses shared `ListRow` members and an owner-only menu Edit action. At rest, member selection,
reorder buttons, note inputs and removal controls are absent. Editing is a local draft, including details, loaded
occurrence order, notes and selection removal; Cancel discards it without writes. Note drafts stay keyed by occurrence
ID, so duplicate subjects and opening another note do not replace unfinished text. During a partial save, each
accepted per-member PATCH stays marked on its occurrence so the curator can see which note was saved. Keyboard
buttons accompany drag handles. Later pages cannot move their first loaded anchor or claim the Collection's first
position. Save retains the numeric metadata revision and stable
per-operation idempotency keys; an unavailable retry reuses the captured command. Current native member operations
are independent: saving stops at the first refusal or transport failure and reports earlier accepted changes. A
revision conflict retains the draft until explicit reload. No atomic bulk success or exact Undo is claimed for
current per-member commands.

Decision: keep notes as occurrence-keyed local drafts, mark a note saved only after its PATCH is accepted, replay
unavailable retries with the captured command, and resolve conflicts through explicit reload.

The presentation selector offers Mixed immediately when no explicit released Type is selected; clearing an
explicit Type returns to Mixed. Each member retains its own Type and hints, including while cover readiness is
pending. A consumer-local source bridge accepts mixed until the controller refreshes the generated client; the
shared automatic cover label and native metadata revision/idempotency commands remain independent.

Member images use their own actual Type and the exact fallback in
[Collection presentation](../../docs/collection-presentation.md), then existing valid release `coverRatio` hints.
No new release fields are cast into existence. Current FULL summaries lack creator and other key facts, so rows show
only the real localized Type and any real note. Public and private disclosure, hidden subject concealment, cursor
bounds, session credentials and private no-store responses retain their existing authorities. Visitor totals stay
unknown on filtered or partial pages; an unfiltered complete page can disclose its admitted visible size. Owner and
browse totals retain the native total rather than the preview/page length.

The four-versus-five defect was a fake-route collision: `collection-filters.ts` intercepted the recorded Collection's
unfiltered members request with five unrelated filter fixtures while the recorded header correctly held four.
Filter stories now use a separate Collection with its own matching five-member header. The original recording and
its four members are unchanged. The duplicate-occurrence story independently has five occurrences and a total of
five. Collection detail fake routes now match their exact Collection so dynamic and other Collection stories can
reach their own handlers. Stateful editor fakes exercise only existing metadata/note/reorder/removal commands,
including receipt replay, pending, failure and conflict, without pretending to prove native authorization.

### Producer handoff

The generated client and native definitions remain the delivery boundary. These are required from their existing
owners before the complete selected surface can be enabled:

- Commerce: bounded list previews containing the first three actual admitted member summaries in native order,
  in the list response or one bounded batch for the current page. Current owner lists have no previews or cover.
  Real browse rows show unavailable covers/previews; pattern stories use actual recorded member summaries. No
  per-Collection detail/member fanout is added.
- Commerce and Content: the selected optional `cover`, `coverSource`, owner `coverMediaId`, and create/PATCH
  `coverMediaId` contract, including current imported-media reference/download authority. The editor explicitly
  explains that cover choice is unavailable; there is no Collection upload or arbitrary URL input.
- Commerce and Semantic: generated `presentationKind`, `presentationKindSource`, optional release
  `listPresentation`, and the bounded FULL Fact-union producer described in the joint contract. No partial-page
  dominant-Type vote, author guess or per-row subject-detail request substitutes for these producers.
- Commerce: `members:batchRemove {revision,memberIds}` and same-curator
  `members:move {revision,memberIds,destinationCollectionId,destinationRevision,after}`, with the documented
  result envelopes, CAS, receipt and current member lifecycle/Undo authority. Current removal uses explicit loaded
  occurrence IDs and existing independent commands. Cross-Collection move stays visibly unavailable; add-then-delete
  would lose identity and is not a transfer implementation.
- Commerce: saved dynamic create and `PUT /v1/collections/{collectionId}/rule {revision,filter,sort?}` using the shared
  admitted filter protocol. Built-in dynamic rules remain immutable; the collapsed shared Filters panel changes the
  current view only. There is no member editor for dynamic results.
- Existing interaction owners: a Collection-target Like and Report capability. Current reaction/report targets do
  not support Collections. Copy link, personal pinning and public follow use actual operations; none is relabelled
  as Like or used as a fake successful report.

These are precise missing producer capabilities, not new Web Kernel endpoints or evidence of runtime delivery.
The joint document remains the sole API contract authority.

Selected occurrence removal is confirmed at Save with the occurrence count and retained Undo window. The native
batch command consumes the loaded parent revision before any other draft write; a rejected selection cannot save
metadata or another edit. A removal-only save sends no metadata PATCH. Other draft edits remain independent writes
after successful removal, and each returned deletion episode has its own exact Undo action.

### Story handoff

The following complete Pattern folders expose autodocs and state plays using the real presenters/editor. Each
**same ID** is handed off for both **phone390 and desktop1280**, with **en and zh-Hans**, in **light and dark** via
review toolbar globals. No export encodes locale, width or theme.

| Folder             | State IDs                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection Row     | `patterns-collection-row--public`, `patterns-collection-row--private`, `patterns-collection-row--empty`, `patterns-collection-row--menu-open`                                                                                                                                                                                         |
| Collection Preview | `patterns-collection-preview--members`, `patterns-collection-preview--empty`, `patterns-collection-preview--unavailable`                                                                                                                                                                                                              |
| Collection Editor  | `patterns-collection-editor--details`, `patterns-collection-editor--members`, `patterns-collection-editor--selection`, `patterns-collection-editor--reordering`, `patterns-collection-editor--note`, `patterns-collection-editor--save-pending`, `patterns-collection-editor--save-error`, `patterns-collection-editor--dynamic-rule` |

The owner browse-route editor join is `apps/web/src/stories/library-collection-editor.stories.tsx#OwnerEdit` through
PageStory and AppShell. Canonical Storybook IDs for that export stay unconfirmed until an admitted index names them;
retain the Pattern IDs above for visual review.

`Pages/Library/Collections` and Collection page stories remain actual component compositions. Menu Edit, keyboard
reorder, selection, note, Save, Cancel and shared filter opening use real play interactions. Dynamic Rule demonstrates
the current immutable built-in and its actual view filter; saved rule editing awaits its producer.
`tests/collection-browse-editor.test.ts` is the focused stack-free presenter/fake regression, including native-total
preservation, fixture isolation, hidden notes, finite selection, Cancel draft isolation, first-failure accounting and
constant read counts. Existing older layout/filter-fixture tests remain under controller custody for integration;
the separate filter fixture identity supersedes their recorded-Collection filter assumption.

Local typing or focused fake results do not establish native outcomes or visual approval. All screenshot review by
Root remains pending. Worker acceptance, browser/native/database/remote checks, Storybook builds, publication and
promotion are intentionally deferred to integration under the current verification instruction.

### Collection browse/editor cost

- **Touches:** Existing owner Collection page and pins reads; inner metadata and one FULL members page, cached
  definitions for labels/ratios, plus existing follow state where applicable. Preview and cover rendering cause no
  added kernel detail reads.
- **Bound:** Existing cursor pages cap at 100; preview presenters render at most three supplied members. An editor
  draft contains at most one loaded page, never all pages. A save plan has at most 299 independently receipted
  operations, derived from 100 removals + 100 note writes + 99 moves. Every member command seeks by the full
  Collection and occurrence IDs and stops on failure. No account scan, cross-Collection fanout or new physical
  allowance.
- **Growth check:** The focused regression records one owner-list request at 1/8/100 Collections, two public inner
  reads with withheld partial/filtered totals, and stops finite mutation plans on a refused or thrown write. The note
  regression plans 100 note writes and 99 moves from one 100-occurrence page and rejects more than 299 composed
  commands. Native privacy, growth and lifecycle proof remain gate-owned.

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

### Guided community setup

`/realms/new` reuses the `Patterns/Community/Space Setup` component inside the existing shell. It progresses through
Space name/address, Realm settings and existing Context, board scheme, and the first board. Each step issues the
existing ordinary command independently; the compact summary distinguishes saved resources from unfinished steps.
Back keeps drafts, and Cancel pauses the editor with Resume on the same page. Unsaved entries, including unresolved
selection references, survive those controls but are not persisted across navigation. Saved commands are not undone.

The production transport uses `changeSpaceSetup`, `readSpaceSetup`, `resolveSpaceSetupChoice` and
`searchSpaceSetupContexts`, plus `readSpaceSetupBoardChoices`, in `community/space-actions.ts`. The Context region uses
`community/setup-context-picker-field.tsx`, backed by the consumer-local `ContextChoiceSource` in
`community/setup-context-picker.ts`. Its `search({ query, cursor?, signal? })` returns one page of
`{ contexts: readonly { id, label }[], next: string | null }`; `resolve(id)` returns one current readable choice or
`null`. These are presentation data, never permission evidence. The page binds `SetupTransport.contexts` through
`community/setup-context-native.ts` to the declared native directory: `GET /v1/contexts` accepts an optional prefix
`query`, `limit` (1–100, default 20), `cursor` and `deleted` (default false), and returns `{ contexts, next }`.
Each entry has exactly `id`, `kind` (`global` or `community`), `labels`, `state` (`active` or `deleted`),
`deletedAt` and `purgeAfter`. The adapter requests 20 entries with `deleted=false` and the current session credential,
omitting an empty query and preserving the opaque cursor, including an empty cursor. Each query, Next or retry
makes one directory request; it never resolves result rows or fills a filtered page. Only active entries become
choices, including restored entries retaining their completed deletion window. The native directory owns current
readability; its display page grants no authority to save a Realm.

The native directory producer and production consumer are connected through the installed generated
`kernelClient().contexts.get` port. Response types come from that declaration; `NativeContextDirectory` retains
only a narrow structural seam for explicit injection. The strict Web decoder validates the native entry schema.
Source delivery and local typing leave native behavior, current privacy, physical cost, visual review and main
proof pending. The generated `GET /v1/contexts/{id}/lifecycle -> { context: entry }` is independent of the existing point GET,
creation, deletion and restoration commands; the picker issues none of those lifecycle reads or writes.
Missing, preparing, malformed and 500/503 responses remain unavailable with Retry, never an empty final page.
Both directory labels and independently verified selection labels use the shared `pickText` locale fallback,
ending with the exact ID when there is no label. A match in another language never replaces the canonical label.
The page memoizes the source for its viewer and locale; a changed session disposes old searches and resolutions.
Selection still uses the authenticated `resolveSpaceSetupChoice` point reader, never the directory's cached label
or a cached permission verdict. New submissions require the same live selection generation; reference edits and
current-Context rechecks invalidate queued submits, interrupted choices clear, and settled name-search choices remain
explicit until replaced. Uncertain retries retain their original command. The shared EntityPicker was inspected: it requires subject
types/covers, hides IDs and has no continuation, so this Context region reuses shared Field/Input/Button controls.
Known-reference loading remains optional recovery alongside name search.

The scheme/topic regions use `community/setup-board-picker-control.tsx`, with shared Input, RadioGroup, Field and
Button controls. `community/setup-board-picker.ts` owns the consumer-local `BoardChoiceSource` display interface:
`schemes({query,cursor?})` returns `{schemes: readonly {id,label}[], next: string|null}`, and
`concepts({schemeId,query,cursor?})` returns the analogous `concepts` page. The real setup page supplies the native
source through the authenticated, private/no-store `readSpaceSetupBoardChoices` server function.
`community/setup-board-native.ts` infers the installed Search input/catalogue hit and Semantic incoming-page types.
Scheme discovery calls `subjects.$search.post` with `filter.type.in=['skos:ConceptScheme']`, relevance order,
limit 20 and the reader's languages, omitting representation. Literal names use the closed Search phrase escaping;
blank input omits text for genuine type-only discovery. Labels use current `base.title`, summary and catalogue
labels. Search retains its own gate admission; `as_of` is observation metadata, never readiness or permission.
There is no untyped suggestion filter, global top-ten postfilter, count or catalogue scan.

Concepts use the saved scheme's actual `GET /v1/subjects/{schemeId}/links` with `property=skos:inScheme`,
`type=skos:Concept` and limit 20. Choices use each native holder summary's identity and label, never a raw edge
masquerading as a Subject. Exact Concept types are eligible; the native write still revalidates identity and
membership. The response's freshness is retained, with an updating notice when it is not caught up. Incoming links
have no arbitrary name predicate, so this source declares `conceptQuery='loaded-page'`: typing filters only names
on the loaded page and retains its native continuation. Empty local matches do not mean the scheme has no matching
Concepts. Next loads exactly one native page with the same body/query/language and unchanged signed cursor; sparse
pages never trigger refill or per-row hydration. Source/query/scheme changes hide late results. Native denial,
invalid input, stale cursors and unavailability stay distinct from successful empty pages; an explicit stale-page
retry restarts the current query. A standalone form without a choice transport keeps the isolated typed unavailable
fallback. Choice labels are display data, never
permission, publication or membership verdicts. Neither picker supplies a default Context, Realm, owner, Concept,
membership or Global grant.
The current server still checks parent creation grants, role authority, scheme membership and current readability.
The existing Space home and lifecycle/removal controls remain the destination, rather than a second home layout.

Uncertain requests lock editing and replay the entire saved command with its original key and expected head.
Conflicts and current refusals preserve work and require an explicit current-state refresh before another write.
A confirmed write keeps its returned identity even if the following read fails; recovery refreshes instead of
replaying that confirmed write. Invalid selections and unavailable readers retain entered values. A pending topic
is bound to its exact saved scheme. Choosing a different scheme or refreshing a changed saved scheme clears that
topic with an explanation, preserving title, purpose and visibility. No existing board is remapped or created by
selection. Source replacement clears pending display selections; search changes preserve the chosen label.

The complete Pattern folder has autodocs, a Journey docs page and these state IDs, shared across phone390 and
desktop1280 through viewport, locale and theme globals:

- `patterns-community-space-setup--rest`
- `patterns-community-space-setup--entered-data`
- `patterns-community-space-setup--selection`
- `patterns-community-space-setup--loading`
- `patterns-community-space-setup--saving`
- `patterns-community-space-setup--retry-preserves-work`
- `patterns-community-space-setup--configured-realm`
- `patterns-community-space-setup--head-conflict`
- `patterns-community-space-setup--current-authority-refused`
- `patterns-community-space-setup--selection-unavailable`
- `patterns-community-space-setup--unavailable`
- `patterns-community-space-setup--created`

Focused board-choice IDs use the actual AppShell and the existing form, with explicit display/response contract
fixtures: `patterns-community-space-setup-board-choices--selection`, `--stale-scheme`, `--denied`, and
`--uncertain-retry` (each suffix uses that full prefix). Review these same IDs at ordinary 390/1280 widths in
light/dark through existing Storybook globals; there are no width, locale or theme exports.

The page composition ID remains `pages-community-space-setup--new-community`. Plays advance, select, save, retry,
refresh a conflict/refusal, pause/resume and reach links containing returned native IDs. They use explicit typed
transport fixtures; production uses the installed generated native directory GET, the actual Context point reader,
and the native board source above.
Native acceptance and Web screenshot review follow integration; local typing does not establish those outcomes.

Focused Context review IDs are `patterns-community-space-setup-context--unavailable`, `--denied` and `--loading`.
The full AppShell compositions are `pages-community-space-setup-context--unavailable-search` and
`pages-community-space-setup-context--current-context-denied`. They reuse the existing setup fixture and the exact
shared form, without successful write fixtures or fabricated result catalogues. The actual route remains
`pages-community-space-setup--new-community`, through `community/space-setup-page.tsx`. Use ordinary phone390 and
desktop1280, light/dark globals for Web's later review; there are no width, locale or theme variants. These boundary
states establish neither native source availability nor visual approval. No external reference source is required
for this selector surface.

The saved Context is resolved independently of an explicitly chosen replacement; neither search nor failure changes
the stored pointer. Both readable labels and exact IDs are shown. Selecting a result resolves only that ID before
enabling Realm save; the ordinary command still verifies current Context disclosure and Realm authority with CSRF,
head CAS and the original pending intent. Denied or unavailable lookups hide old results and preserve drafts and
saved creation steps. Back and pause retain the query, reference and choice. Removed Realm reads remain failures,
never Global fallback. The focused `tests/setup-context-picker.test.ts` records these selection, denial, bounded-page
and late-response outcomes for later integration execution, including
`Bind delivered Context picker to exact declared native active directory` against the declared transport boundary.

The journey keeps the existing two-resource snapshot and viewer-action batch. A saved Context gets one exact read
per pointer/head change or explicit recheck. Each chosen Context gets one exact read; no result row is resolved
until selected. Search waits 250 ms, aborts outstanding requests on query change/selection/disposal and ignores late
resolutions. Each Next or retry requests exactly one source page and replaces it; an empty page retains its returned
continuation without refill. The source owns page bounds and cursor validity. No catalogue scan, count, membership
probe, automatic page walking or new authority store is introduced.

Board search debounces 250 ms; each search or Next requests one bounded producer page and replaces the displayed
page. It never walks all cursors, refills per row or counts the catalogue. Cancelled awaits ignore late
source/query/scheme responses; the exact board display interface has no I/O abort signal, so cancellation cannot
promise to stop producer I/O. Native scheme save and board creation still verify the current installed release,
readability, membership, lifecycle, admission, current actions and CAS. `tests/setup-board-picker.test.ts` names the
acceptance and covers paging/isolation, unavailable versus empty, changed-scheme invalidation, refusal and stable
uncertain retry through the existing generated command client. Native proof remains integration work. No external
reference-project source was needed for these existing controls and command surfaces.

## Thread reading

Canonical thread links retain `?post=<id>#post-<id>` through both redirects. A linked post takes precedence over a
supplied cursor: one private native `post.locate` read supplies a signed predecessor cursor, then the existing post
page independently admits current content. There is no page scan or exact-body fallback. An unavailable or
foreign-thread link shows the ordinary first page with neutral recovery to the thread beginning; a withdrawal after
location shows only the ordinary reader's current result and the same recovery. Next drops the locator. Query and
caller identities include the linked post so navigation cannot reuse another anchor's page. The generated client
remains controller-owned; `thread-page.ts` isolates the declared locator transport seam.

The optional locator adds one kernel request to the ordinary thread page bound. Its producer bound is two exact
native post disclosures (ancestry capped at 33 each) plus one target key and one predecessor, followed by the existing
page's at most 200 candidates and at most 100 returned posts. `POST_LOCATION_BOUNDS` records the producer constants;
composition is `2 * nativePostRead + 2 indexed keys + ordinaryThreadPage`, independent of the target's page number.
Focused destination coverage is `tests/thread-post-location.test.tsx`; native and browser acceptance run at integration.

The slug route composes `threads/thread-reading.tsx` with its native post/header regions and one composer across
parent selection/cancellation. Replies render command results and refresh the existing private personal read.
Reactions, reports, edits, history and restoration retain their command paths. Current bodies never fall back to
history; citations stay revision-specific and only the signed-in author gets a current-vote comparison. Fragment
targets and signed continuation retain their route/navigation owner. Filtered empty pages retain continuation.
The shared document measure and site media routes integrate readable content. Phone cards use the available width.
Desktop About uses only a supplied nonempty Realm summary, otherwise the column stays centered. The existing board/
Realm and batch identity reads supply context; absent rules/images are omitted and identity uses honest fallbacks.
Rendering is linear in the returned page and adds no data requests.

`src/stories/patterns/thread-reading` holds the complete Pattern docs/behaviors. Pages reuse them inside `AppShell`.
Both use `phone390`/`desktop1280` and existing locale/theme globals. The shared stories cover signed-in and signed-out
reading, rich documents with edited and unedited posts, community context, an existing recorded reply relationship,
parent selection/cancellation, deleted and withheld posts, a deleted organization byline with readable posts, own edit,
both recorded history versions, reporting, loading, unavailable and current denial states. These are review inputs;
typing alone establishes no native or visual pass.

`pages-community-thread-reading--restorable-post` and `patterns-community-thread-reading--restorable-post` add a
constructed native owner tombstone with a fixed source deadline to the same reading region. The fixture establishes
presentation only, without claiming a successful native restore. Existing `--deleted-post`, `--withheld-post` and
`--current-denial` states remain review inputs. The focused `tests/thread-undo-current-read.test.ts` covers withheld,
erased, missing, denied and unavailable reads after restore; a native deadline versus a fake browser clock; read
retry after a known write; original-key retry after uncertainty; and optional native review hints. Native disclosure
and visual review remain deferred. No external reference-project source applies to this existing command/read repair.

### Delete and restore current read

- Touches: one native command per explicit intent, followed after 204 by one existing fixed thread-page read at the
  current cursor and credential mode. That page retains its established identity, context and media batches. A read
  retry sends no write. An uncertain command retry first reads the current page and writes with the original key only
  when that page still supplies an eligible native tombstone.
- Bound: one visible page per read, no continuation drain, ancestry traversal, extra exact-body reader or per-post
  request. The native reader continues to own current authorization and source fences.
- Growth check: the focused consumer cases establish read/write separation only; native growth and physical proof
  remain deferred under the minimal verification contract.

### Current document images

`threads/document-media.ts` is Web's sole document image consumer. It exports `loadDocumentMedia(client, ids,
authorization?)`, `DocumentImagePresentation`, `DocumentMediaPage`, `DocumentMediaRead` and the re-exported
`NativeDocumentImage({ image, alt, locale })`. The declared native source is `POST /v1/media/presentations`, with
strict `{ ids: string[] }`, at most 32 unique original IDs, and a closed `{ images }` response. The producer module
`services/kernel/src/content/media-presentation.ts` is absent in this checkout, so its exact declared DTO is isolated
in this consumer until the original declaration is delivered. The adapter uses the original client's transport;
an absent source, a failed read or an invalid response is typed unavailable. An omitted image means unavailable,
without an explanation or any inference about its existence or the viewer's rights.

The existing authorized thread page read collects a union from available current post bodies only, intersecting
actual image node references with each post's declared `mediaIds`. It makes one media batch for that delivered page,
using the same current server credential and no-store transport. The server function retains private/no-store
responses; no credential enters page data. Over 32 distinct references makes every image on that page unavailable,
preserving every document body and making no media request. No truncation, refill, per-image read or automatic retry
is used. Summaries are bound to the exact returned post, thread, revision and document digest. Local edits and newly
returned replies remain unavailable until an ordinary page refresh supplies summaries for their current documents.

The ordinary post's existing Web `DocumentBody` wrapper receives an explicit `NativeDocumentImage` callback. Only
actual returned derivative formats, widths and dimensions select `picture`/`img` sources through `coverSrc`. There
are no original, external or object-store image sources and no rendering-time reads. Missing or failed images retain
their accessible alternative; delivered credit remains visible after a byte failure. The Worker download route
retains independent current media authorization, and media metadata grants no document or paid-content rights.
Exact revisions, history and editions can reuse these same exports with their own independent document authority.

Review `src/stories/thread-media.stories.tsx`: `pages-community-thread--available`,
`pages-community-thread--unavailable`, `pages-community-thread--overflow` and
`pages-community-thread--image-failure`. These mount the actual thread reading region and post component in
the existing AppShell, using normal 390/1280 light/dark globals. They are constructed interface DTO examples using
the existing recorded derivative asset, not native disclosure or visual approval. The focused acceptance lives in
`tests/document-media.test.ts`; it is deferred to integration under the current minimal verification policy.
Source read: the native post/media contracts, shared document renderer, Web read/credential/download boundaries and
the existing thread recordings and Storybook fixture contract. No external reference source is needed for this
remaining connection.

### Author erasure in a thread

`threads/author-erasure-entry.tsx` is the narrow author action region mounted by `ThreadReading`. Opening its
explanation and closing it leave the existing composer, reply target and draft mounted. Confirmation explains that
only the acting account's posts and revisions in this thread are selected, physical cleanup is asynchronous and
irreversible, and neither other authors' posts nor the account are deleted. Single-post deletion and restoration
keep their existing native paths.

Like the composer, an in-flight erasure intent stays mounted but hidden/inert during a transient personal-query gap;
reloading personal permissions cannot discard an uncertain request's key. Operation hydration retains its refresh budget.
An uncertain intent remains scoped to the same thread and actor across a temporary session gap; changing either starts a
new intent.
Decision: same-author session recovery keeps the open confirmation and original key; explicit retry uses current credentials.

Opening or explicitly refreshing the region makes one current generated `threads({id}).get(options)` read through
`readThreadAuthorErasureAdmission`, the safe server-side BFF session and private/no-store responses. No read runs
on render, per post or in an operation polling loop, and no bearer reaches the browser. The exact producer-owned
optional envelope field is `authorErasure: {authorId: string, mayErase: boolean}` from Kernel's
`content/schemas.ts` `ThreadResponseSchema` and `content/author-erasure-admission.ts`. The parser narrows the
existing generated response through `unknown`, checks the exact thread and session subject and allowlists only
this field. Absence, malformed data or mismatched identity remains unavailable; ownership/edit/delete flags
cannot supply admission. Native signed-out, denied and unavailable responses keep their separate presentation.

Admission is bound to the current thread, personal viewer identity and open region. Closing or changing that
scope discards late reads; each refresh clears the old value before requesting a replacement. A denied or
mismatched refresh clears presentation authority. The separately held uncertain command intent/key survives a
transient personal-query gap or admission failure and can be explicitly retried with its original request. Every
native POST still checks current `post:erase`; a true presentation read is never sent as proof.

- **Touches:** One existing generated thread GET per explicit open/refresh and ordinary safe session preparation;
  no lists, counts, per-post reads or new transport.
- **Bound:** Fixed native fields, one in-flight result per interaction and constant local state; no upfront total.
- **Growth check:** The producer's focused native admission suite owns indexed statement/row growth. Consumer
  tests cover missing/mismatched fields and late results after close, thread/account change and refresh refusal.

The binding consumes the generated `threads({id}).$erase.post({authorId}, options)` and
`operations({id}).get(options)` methods, after inspection of Content's `operations.ts`, `operation-contract.ts` and
mounted `moderation-routes.ts`. The POST server function uses the ordinary server session and CSRF preparation,
derives the author exclusively from that session's subject and passes its credential to native Content. One explicit
intent retains its key after an uncertain enqueue response. Only a valid 202 with the matching native selection and
an actual operation name can open `/operations/{id}`. A successful enqueue is not completed cleanup. A lost or
malformed response keeps the original request available for explicit retry.

The authenticated operation route uses a private, no-store native GET. Rendering allowlists native AIP-151 metadata
`processedPosts`, `erasedRevisions` and `steps`, and the terminal response or RPC error code. It never renders native
error text/details, authored bodies or workflow logs. Zero reported progress is labelled queued/waiting for progress;
positive native counters indicate running. These labels describe the DTO's reported progress, without claiming an
unexposed workflow scheduler state. Only native `done` plus its successful response establishes completion. Terminal
permission denial, source changes and dependency failures have fixed, useful copy. An inaccessible or unavailable
current read removes previous progress rather than implying success or displaying stale counts.

Opening the route costs one authenticated operation point read. It performs at most four further point reads, two
seconds apart while visible, stopping on terminal state or read failure, then exposes **Check again**. Hidden time
does not spend the refresh budget. Each manual check reads the same ID once; no thread/post enumeration, upfront
total, percentage, automatic enqueue retry or client workflow restoration is involved. Native Content alone restores
the initiating account and checks each cleanup step. Rendering is constant in the three supplied counters.

Review the integrated source through these story pairs, using the ordinary `phone390`/`desktop1280` viewport and
light/dark globals. Pages wrap the same delivered regions in `AppShell`, which supplies the sole page main:

- `pages-community-author-erasure--current-admission-available` / `patterns-community-author-erasure--current-admission-available`
- `pages-community-author-erasure--current-admission-denied` / `patterns-community-author-erasure--current-admission-denied`
- `pages-community-author-erasure--current-admission-unavailable` / `patterns-community-author-erasure--current-admission-unavailable`
- `pages-community-author-erasure--enqueue-lost-response` / `patterns-community-author-erasure--enqueue-lost-response`
- `pages-community-author-erasure--running-counters` / `patterns-community-author-erasure--running-counters`
- `pages-community-author-erasure--terminal-permission-denial` / `patterns-community-author-erasure--terminal-permission-denial`
- `pages-community-author-erasure--completed` / `patterns-community-author-erasure--completed`

The stories use isolated wire illustrations for admission, lost response, counters and terminal outcomes; they do not
establish native authority or physical cleanup. The lost-response play retains the actual thread composer, retries
the same intent and opens the queued operation. The running play reaches the bounded manual check without a total.
`tests/author-erasure.test.ts` adds focused generated-client, session/CSRF, denial, current-source, counter validation,
refresh-bound and presentation cases. Native, acceptance, browser and visual proof remain deferred under the current
minimal verification contract. No screenshots are produced by this slice.

### Realm appearance and rules

Realm appearance departure treats a changed draft, a nonempty or previewed source reference, and an active or reserved upload as unsaved; opening an empty selector does not prompt.

#### Carried Realm on Space home

`community/space.ts` loads the ordinary Space and readable carried Realm before
`realm-home-presentation-native.ts` makes one independent `GET /v1/realms/{realmId}/presentation` read. The
declared response is `{community: CommunityPresentation}` from Content's original `readCommunityPresentations`.
The installed generated client does not yet declare that route; the isolated consumer-local route type yields to
the original declaration when delivered. Missing routes, incomplete native ownership and source failures remain
unavailable. They never consume the Space's embedded presentation as a fallback or infer ownership. This binding
establishes no native route availability or native pass.

The consumer uses Board's existing `board-community-source.ts` parser and the original native DTO types. One final
ordinary Realm/Space read pair binds the result to the same heads, current active/readable containers, ownership,
Context and carried-Realm relationship, including when the optional source fails. A changed or denied binding
discards the region. The original presentation reader owns source lifecycle/version fences and the exact rules
disclosure. There are no per-board/source HTTP reads, count requests, retries, refill or retained positive source
values. Rendering is linear in the one bounded DTO: two images with at most twelve variants each and one Text rules
document of at most 65,536 canonical UTF-8 bytes.

`SpacePage` presents one dominant community identity through `RealmHomeHeader`, using the existing shared native
image, count, rules and credit parts. Follow and Join/Leave sit beside that identity, followed by boards and published
subjects. Matching Space and community names share one heading and description; a differing Space name and summary
remain compact routed context above the community identity. The Space address and routed identity remain stable.
Native concealed/erased images and rules may be `none` even with a selected reference; optional failures remain
unavailable. Members display only the supplied current count/version or unknown, without a fabricated zero.
`RealmMembership` retains its separate native personal state and all existing admission/pending behavior; neither
the count nor presentation join metadata supplies an action. Its status uses a card foreground/background pair,
and outline controls explicitly own their background and ink in both themes. Space identity text uses the shared
placeholder pair and a uniform cover scrim, independent of arbitrary image placeholder colours.

An active orphan's `governanceReadOnly` freezes writes without revoking its independent read authority. The same
native presentation read and final Realm/Space checks may disclose its current title, description, selected images,
count and rules. Native missing, denied or removed responses (including presentation 404) hide the region; source
errors remain unavailable. Neither an original owner nor an account avatar/profile supplies fallback data.

`SpacePage` keeps that current presentation visible while an orphan's setup, publication, appearance, bans,
grant-write and participation controls remain frozen. A lifecycle observation that newly orphans an owned page
cannot expose its old presentation. A changed claim source, approval or orphan episode also discards the old region
until a matching current page arrives; the existing personal claim admission and original 720-hour wait are
unchanged. Public removal/orphan notices remain independent of management. Personal ownership recovery appears only
for a current native-admitted orphan or an already attempted recovery; an ordinary owned page has no ownership panel.

Management is an explicit secondary same-page disclosure. Only a current signed-in subject with at least one native
admission receives its entry: appearance `canManage`, the existing successful ban-list read, lifecycle `actions`, or
setup `permitted`. Each operation remains independent; membership, readability, role names and client scopes grant
no authority. The same mounted bans control supplies both admission and its first private page, with explicit native
cursor pagination. Visitors see no private loading, denial or unavailable panels. These fixed point reads do not grow
with boards, members or history. Native command checks, CAS and uncertain request keys remain authoritative.

Closing management hides and inerts its mounted controls, retaining selection, upload, confirmation and recovery
state. Current native denial removes the affected actions while an entered panel retains its recovery message.
Changing the Space, Realm or session subject discards private controllers, admissions and cached reads; late results
cannot populate the new viewer's surface. `RealmAppearancePanel` remains the sole editor. Its image previews have
independent sizes and its controls use the available width at both ordinary review widths; selection and upload
protocols remain unchanged.

Web's ordinary 390/1280 light/dark review inputs use these exact CSF sources and IDs:

- `src/stories/board-community-pages.stories.tsx`: `pages-community-community-board--space-home-signed-out`,
  `--space-home-member`, `--space-home-source-unavailable`, `--space-home-membership-unavailable`.
- `src/stories/realm-home-presentation.stories.tsx`: `patterns-community-realm-home-presentation--available`,
  `--without-images`, `--optional-unavailable`, `--source-unavailable`, `--current-denied`.
- The same Pattern source adds `patterns-community-realm-home-presentation--orphan-readable`,
  `--orphan-protected-denied`, `--orphan-removed`, `--orphan-optional-unavailable`. These anonymous cases load the
  existing native-shaped responses through the same adapter and render the actual `SpacePage` region. Its existing
  claim reader consumes the same responses; the stories supply no claim admission or successful command.
- The existing management composition remains `pages-community-realm-appearance--management` from
  `src/stories/realm-presentation-page.stories.tsx`.

These reuse the existing page main and Pattern. Incomplete native ownership responses remain unavailable rather
than being upgraded to owned/ready by the consumer. No screenshot, browser, native or visual approval is claimed.
`tests/space-home-presentation.test.ts` retains its original cases and adds the orphan read/write separation
acceptance, actual denial/removal/source-change and optional availability cases for integration. Verification for
this slice is limited to the local Web type check: `bun run --cwd apps/web typecheck` completed with no type errors.
Acceptance execution remains with integration.

Source reading for this connection: the original Content presentation reader/model, Community Realm/Space routes,
Board parser/shared presentation parts, native claim/lifecycle binders, and the adopted research's read-only Lemmy
`crates/db_schema/src/source/community.rs` plus Discourse `app/models/category.rb`, `app/models/group.rb` and
`lib/guardian/category_guardian.rb` (separate read and post admission). Reference sources were read under the main
checkout's `.reference/` directory without modification. No external implementation was copied.

#### Appearance management

`community/realm-presentation-settings.tsx` owns the reusable `RealmAppearanceSettings` Pattern, inserted into
Space/Realm management beside the existing bans region. Setup, membership, publication, lifecycle and the Context
pointer retain their existing owners. This adopts the Web consumption decisions from
[the presentation research](../../docs/research/content-community-presentation-contract.md); that report is evidence,
not a second interface authority. Realm title/summary and Board title/purpose remain distinct. Space images and Board
overrides are outside this interface. There is no member-count editor or substitute membership authority.

The selected native boundary is ordinary `PATCH /v1/realms/{id}` with the closed
`presentation: { avatarMediaId, bannerMediaId, rules: { postId, revisionId } | null }` object. All three keys are required
when supplied; omitted presentation preserves current settings and null clears a slot. The command changes only
presentation and keeps the ordinary quoted `If-Match` head and `Idempotency-Key`. Current `realm.update` admission
from the actual Realm's viewer actions controls management visibility; native `realm:manage` executes every command,
including receipt replay. Read-only Pattern fixtures demonstrate the same component without offered changes.

`realm-presentation-native.ts` now consumes the mounted generated Realm GET/PATCH and Realm-media reservation
client. Reads use the current Realm, its exact viewer-actions batch, the native Space `community` DTO and a final
Realm/head/Space/Context binding read. Only current admitted managers see management. Orphaned, read-only, removed
and unreadable containers hide the region. A missing dependency is unavailable without synthetic empty settings.
Image types come from the generated native producer declarations. Native image/rules disclosure remains the sole
source authority; members remain unknown until Accounts' count source is covered. No member-count request is added.

Selection previews real derivative DTOs or initials. `none`, `unavailable` and failed image transport have distinct
presentation; missing producer always stays unavailable. No object URL, original, hotlink, borrowed account avatar or
browser token serves a preview. Optional metadata is used only when supplied; null stays null. The board/header owner
consumes `realmPresentationAssets`' exact optional image DTOs through its existing enrichment boundary; this slice adds
no feed/header layout or alternate enrichment route. A summary never authorizes downloads: every image still requests
the existing media-id/variant
transport with current native download authorization.

The site `/media` reservation accepts an exact Realm target with `realm-icon` or `realm-banner`, then delegates to the
mounted `POST /v1/realms/{id}/media` adapter. It never falls through to the post/account reservation. The browser reuses
the existing uploader-bound PUT, byte hashing, completion and bounded processing reads. It retains a known reservation
on an uncertain upload, and manual retry reads that reference instead of reserving again. A processed same-Realm
matching-purpose uploader reservation can be staged as a reference, with an explicit
preview-after-save notice. It supplies no invented dimensions or derivative. The ordinary native PATCH permanently
claims that reference; only its subsequent current community read supplies an available preview. Canceling a chooser
or upload changes no setting.
Replacing or clearing an upload retires its pending selection; replaying an uncertain save after a newer head
preserves the current read and requires explicit conflict review when the replay describes an older revision.
Clear asks for confirmation and clears only the selected reference on save, without deleting the source.

Rules select an exact published native post and immutable revision, with a readable producer-supplied summary and a
link to the existing revision reader. Existing post composition/revision is the only authoring path. The chooser reads
the exact native revision and its actual board, checks this Realm, published/readable Text,
canonical bytes at most 64 KiB and the returned digest, then repeats exact revision and Realm binding reads.
SPDX and authored-document validation remain with ordinary Content storage and native PATCH rules preparation.
The current community rules preview uses the native exact rules resolver, including final source disclosure. The
interface stores no body or licence and never fabricates
a selection from IDs alone. Later post edits do not change the adopted revision.

A lost save response retains the complete request, expected head, key, selected references and draft. Manual retry
replays that request; a refresh cannot silently rebase it. A definite conflict retains the draft, requires a current read,
shows current selection summaries, and offers an explicit review before a new save uses the new head/key. Drafts are
local to the mounted region. New current data or a refreshed CSRF token does not reset an in-flight intent. Current
native removal, orphaning or denial hides the region and prevents changes. Refreshed unavailable reads conceal
retained previews immediately; an older in-flight save response cannot replace that current read.

Story review uses the existing `phone390`/`desktop1280`, theme and locale globals, with no dimension/locale exports:

- `patterns-community-realm-appearance-settings--manage`
- `patterns-community-realm-appearance-settings--readonly`
- `patterns-community-realm-appearance-settings--available`
- `patterns-community-realm-appearance-settings--cleared`
- `patterns-community-realm-appearance-settings--uploading`
- `patterns-community-realm-appearance-settings--conflict`
- `patterns-community-realm-appearance-settings--uncertain-retry`
- `patterns-community-realm-appearance-settings--unavailable`
- `patterns-community-realm-appearance-settings--optional-unavailable`
- `patterns-community-realm-appearance-settings--selection-cancelled`
- `patterns-community-realm-appearance-settings--native-source`
- `patterns-community-realm-appearance-settings--processed-image`
- `pages-community-realm-appearance--management`

The focused fixture interactions cover draft retry, canceled selection and processed references awaiting save.
Native-source and management-page stories consume the mounted source adapter over explicit native HTTP DTO fixtures.
Available image facts in stories are explicit
fixtures using the existing derivative transport, not evidence of native Realm-media availability. New message keys use
the configured English base-locale fallback until owner localization review. Web owns screenshots and visual review;
this delivery runs only local typing. `tests/community-presentation.test.ts` records boundary assertions, without claiming
native privacy, physical/growth, cleanup, browser or promoted-source acceptance. All later proofs remain required.

Cost: appearance read and selection

- Touches: one current Realm, one exact Realm viewer-action batch, its Space presentation and one final Realm binding;
  the exact same-Realm image or post/revision selection and fixed source/final disclosure anchors.
- Bound: four native calls per management read; image choices add at most one uploader reservation and one final
  Realm read; rules choices add at most two exact revision reads, one board and one final Realm read. No catalogues,
  history walks or per-card enrichment. Source reads remain bounded by two images, twelve variants each and one
  exact rules source of at most 64 KiB. Native work is O(changes log R).
- Growth check: retain later native `test/community/growth-realm.test.ts`, `test/content/growth-realm-board-read.test.ts`
  and `test/content/growth-threads.test.ts` through their existing measured harness. Interface typing proves no growth result.

Cost: appearance save and retry

- Touches: one ordinary Realm PATCH with current management, head/CAS, at most two media claims, one exact rules source,
  receipt and event. An uncertain retry reuses its original request; conflict review reads current settings explicitly.
- Bound: one command per user action plus four reads for confirmation, constant source/final anchors and
  O(changes log R) indexed native work. An uncertain response retains its original PATCH and quoted head/key headers.
  No automatic retry/rebase loop, new authority store or body/licence copy.
- Growth check: later reuse native `test/community/growth-realm.test.ts` and `test/content/growth-threads.test.ts`.

Cost: Realm image upload and download

- Touches: one Realm reservation, existing byte PUT/digest/completion, bounded uploader reads and an exact derivative
  summary; each derivative request follows the existing current authorized media download operation.
- Bound: existing 20 MiB limit, at most 32 processing reads within 60 seconds per manual attempt, twelve derivative
  variants; constant buffering in the BFF and fixed native source/final anchors. Native index work is O(changes log R).
  Known references survive uncertainty without another reserve; new selection claims occur only in native PATCH.
- Growth check: later reuse `test/content/growth-media.test.ts`, `test/content/growth-media-realm-download.test.ts` and
  `test/content/growth-media-native-collection.test.ts`; existing uploader and download evidence remains required.

### Authored revision to fixed edition publication

`/editions/new` is the creator handoff. The existing exact-revision route adds a distinct publication region after
its unchanged document/provenance region. The action passes only the exact native post and revision IDs to the creator
route. A creator can also select a same-site exact-revision link; the browser never turns a pointer into document bytes.
A current native exact read, the real session subject and current `post:revise` viewer action admit the preview. The
native command independently verifies both the post author and immutable revision write basis. No caller ownership,
rights assertion, new post, cover selection or source mutation is sent.

`content-editions/edition-create-native.ts` consumes the actual producer's `edition-routes.ts`, `schemas.ts`,
`edition-commands.ts` and `edition-store.ts` contracts. Creation sends only `{postId, revisionId, targetSubjectId}` to
`POST /v1/contentEditions`; `content_edition.create` returns the flat `{editionId, editionRevision}` command schema.
Publishing sends `{}` to `POST /v1/contentEditions/{id}:publish`, with structured-string `Idempotency-Key` and the
actual quoted numeric `If-Match` edition revision. `content_edition.publish` requires current edition sell and source
revise admission; native execution captures the seller initiator and receipt. The browser never uses mechanical sale
authority. A matching current metadata read must confirm the source revision, SHA-256, licence, creator, chosen original
subject, edition ID, state and command version before the UI reports a draft or publication.

The selector retains the original immutable revision's bounded subject IDs and displays those identifiers without
per-row enrichment. Exactly one selected subject receives a current native point read, with redirects refused, before
each command. Today's post head never supplies extra subjects. Native source reads retain live Context and ancestor
authority; the UI constructs no fallback Context or permission formula. The existing Web DocumentBody wrapper renders
the canonical snapshot with an explicit NativeDocumentImage callback from the sole `threads/document-media.ts`
export. That component owns actual variant selection, native credit, accessible alt and the authorized Worker
download route through `coverSrc`.

The creator source binds one media result to the exact delivered document. Only original declared media IDs actually
referenced by its image nodes enter one batch, with at most 32 unique declarations. Repeated images share that batch;
undeclared references and omitted results render unavailable. Commands and source-entry admission do not load image
presentations. The original exact source and action checks remain independent; final source disclosure repeats the
body digest, licence, subjects and declared-media binding after the media read. Media success supplies no publication
permission or licence inference. A new selection or refresh clears the old source and images synchronously; a late
read cannot replace the newly selected version.

This checkout lacks both `threads/document-media.ts` and Content's `media-presentation.ts`. An isolated consumer-local
declaration follows the specified DocumentImagePresentation shape, and exact optional Vite bindings consume only the
original `loadDocumentMedia` and `NativeDocumentImage` exports when delivered. Absent exports and source errors are
typed unavailable. The consumer adds no media HTTP reader or derivative renderer. It supplies no object key, original
variant, guessed width, external image URL or fabricated image. Native media presentation and each Worker byte
download retain their own current media/container/ancestor/fence/lifecycle authorization; paid edition access grants
no generic post or image rights. These bindings do not prove the missing native presentation source is available.

Returning creators open `/editions/new?editionId=<native ID>`. This parameter takes precedence over source
selection, even if malformed; missing, hidden or removed editions never fall through to creation. The signed-in
route loader reads fresh private metadata, with no router stale/cache retention. The same controller adopts the
exact existing edition ID and numeric version. Visiting or reloading this route sends no create or publish command.
Draft, published and terminal withdrawn states have separate paths. Only a currently confirmed published edition
shows the reader and Commerce offer links.

Resume deliberately uses the producer's exact `ContentEditionView`: it exposes the immutable revision ID, original
subject, SHA-256, creator and licence, but no post ID or draft body. The saved-edition section displays those fixed
values without a source selector, document copy, latest-post lookup or invented source object. It does not call the
buyer revision delivery endpoint to obtain draft bytes. Current native metadata and sell admission are required;
missing action registration is typed unavailability. Identity matching selects the creator surface and grants no
permission. The publish command remains the authority for ordinary current `post:revise`, `edition:sell`, original
authorship, subject, source and ancestry checks. The consumer adds no backend or buyer-delivery change.

Creation and publication have separate stable intent keys. Uncertain responses retain the original request, source
preview and selection; explicit retry replays the same operation, payload, key and CAS. A draft has no published reader
link and is not sellable. A definite conflict requires a fresh current source/edition read and explicit review before a
new intent can use a new edition version. Refresh conceals previous source bytes immediately; an older pending command
cannot replace the fresh read. Source denial retains the pointer, subject and unresolved intent, while concealing the
preview. An unknown create result cannot be discarded by a refresh. An uncertain mounted request keeps its original key and version even after a current read; only explicit retry
settles it. A full route reload reads native state and never automatically replays a command. Only the confirmed published section links to the assigned
`/creator/offers/new?editionId=<published ID>` route, localized with `localizeHref` and carrying the encoded current
native edition ID. Both links remain hidden during pending or uncertain work and require the edition to match the
current immutable source binding. Resume binds directly to the returned native edition metadata. Its separate `/editions/{id}` link opens the reader. Navigation creates no offer,
payment or buyer fact and grants no role. The offer editor retains fresh native sale metadata and rights checks under
[Content's fixed-edition authority](../../services/kernel/src/content/README.md#fixed-authored-paid-editions), plus
capture, current consent and financial policy under the [Commerce contract](../../services/kernel/src/commerce/README.md#what-is-bought).
The assigned route can be developed in parallel; this link does not establish its runtime availability.

The isolated typed wire binding uses configured `KERNEL_ORIGIN`, the existing session/Origin/CSRF boundary and private,
no-store native transport with read-after-write session headers. It never uses the development fake. Without the native
origin it returns typed `native-pending`. Native Content edition routes are mounted in this checkout, while the
generated client still has no edition routes and Content post and edition resources are absent from the installed
viewer-action registry; these are remaining producer integration edges. Missing native action resources return typed
`admission-pending`, never invented permissions. The configured wire
binding already calls real native operations when those resources are present; generated composition should replace the
isolated transport when delivered. Native refusal or missing original authorship remains a refusal. These interface
fixtures do not prove native availability, disclosure, physical growth, publisher receipts or buyer delivery.

The reusable EditionPublication Pattern and actual creator-route Pages expose these exact review IDs:

- `patterns-content-editionpublication--selection`
- `patterns-content-editionpublication--draft`
- `patterns-content-editionpublication--published`
- `patterns-content-editionpublication--refused`
- `patterns-content-editionpublication--conflict`
- `patterns-content-editionpublication--uncertain`
- `patterns-content-editionpublication--resumed-draft`
- `patterns-content-editionpublication--reloaded-published`
- `patterns-content-editionpublication--resumed-conflict`
- `patterns-content-editionpublication--uncertain-publish`
- `patterns-content-editionpublication--image-preview-unavailable`
- `pages-content-editionpublication--selection`
- `pages-content-editionpublication--draft`
- `pages-content-editionpublication--published`
- `pages-content-editionpublication--refused`
- `pages-content-editionpublication--conflict`
- `pages-content-editionpublication--uncertain`
- `pages-content-editionpublication--resumed-draft`
- `pages-content-editionpublication--reloaded-published`
- `pages-content-editionpublication--resumed-conflict`
- `pages-content-editionpublication--uncertain-publish`
- `pages-content-editionpublication--image-preview-unavailable`

Selection and Uncertain retain their focused interaction cases. ResumedDraft reads a saved wire resource into a new
controller and confirms publication of that same ID without source reconstruction. ReloadedPublished reads current
publication without writes; ResumedConflict requires explicit version review; UncertainPublish retries the original
key and quoted version. Published checks readiness of the localized offer
link for the confirmed native edition and the separate reader link. These stories exercise the real controller and
wire adapter with constructed closed producer responses. Pages mount `EditionCreateRoute` in the existing AppShell
with one main. ImagePreviewUnavailable adds an actual declared image reference to the authored snapshot and shows
its accessible unavailable state while independent native publication remains possible. ResumedDraft continues to
show saved immutable metadata: there is no native creator draft-body source in this checkout, so it has no image
references to resolve. It never maps the revision to today's post or calls buyer delivery for draft bytes. Use
existing phone390/desktop1280, light/dark and locale globals; Web owns visual review. English messages use the configured
base-locale fallback pending localization review. `tests/edition-publication.test.ts` records the assigned boundary
journey and privacy/late-response case for integration; acceptance, native, browser and visual execution are deferred by
the current minimal verification policy. No external reference-project source was needed for this document surface.
The scoped local verification command is `bun run --cwd apps/web typecheck`; acceptance and visual review run after integration.

Cost: entry and source selection

- Touches: one exact native post/revision, one current native action batch of one post, one final exact revision.
- Bound: three native requests per entry/read, one document of at most the native 2 MiB limit and at most 128 original
  subject IDs. No history walk, head substitution, refill, per-subject HTTP or additional document renderer.
- Growth check: native Content's existing source/ancestor bounds remain producer-owned; interface typing is no proof.

Cost: draft resume and resumed publication

- Touches: one exact metadata GET and, for drafts, one current native action batch for the same edition. Published
  and withdrawn reads use one GET. The metadata loader never enumerates posts, history, subjects or draft bytes.
- Bound: two requests per draft load/review; one per other state read. Each resumed publish/retry reads metadata,
  reads sell admission, sends at most one publish command, then confirms metadata: at most four native requests.
  The native command owns current source revise, author, original subject and ancestor checks and their existing bounds.
- Growth check: these consumer boundary fixtures establish no native cost or disclosure proof.

Cost: create, publish, review and uncertain retry

- Touches: the same fixed source read, one chosen current subject, one native command and one current metadata read;
  publication adds one native action batch of one edition. Review reads the source and at most one known edition.
- Bound: at most six requests per create/retry, seven per publish/retry, four per explicit review. One user action sends
  at most one command. Original keys/CAS remain fixed on uncertain retry. No automatic retry, new authority store,
  Commerce reads, history scan or source mutation. Native commands own admission before receipts and final disclosure.
- Growth check: later native edition outcomes and physical checks remain required; these fixture tests claim no growth
  or promoted-source result.

## Public Realm discovery

`community/realm-discovery/index.ts` exports the sole `RealmDiscoverySection`, `loadRealmDiscovery` and the adopted
`RealmDiscoverySort`, `RealmDiscoveryCard`, `RealmDiscoveryState` and `RealmDiscoverySectionProps` types. Search and
Web import this same module for their existing placements; this delivery adds no page, shell or source caller.
The section consumes only public state, locale and optional continue/retry callbacks. It never fetches.

`loadRealmDiscovery(client, { sort, cursor?, limit? })` calls the installed generated
`client.realms.discovery.get` once for each valid page request. Its strict closed response is `realms` plus `next`.
It validates the native card shape and the selected image summary from `threads/board-community-source`, including
the exact Realm/container binding and at most twelve published derivatives. The installed native response supplies
the selected same-Realm image summary or `null`; both are accepted without extra lookups. Rows use the existing
guarded `MediaImage` and derivative site route, or initials. No account avatar, external image, count, score or
identity tracking is introduced. Empty authored descriptions stay empty; links use localized `/realms/{realmId}`.

The [native Community contract](../../services/kernel/src/community/README.md#public-realm-discovery) owns original
qualification, complete UTC windows, ranking, expiry and current/final anonymous disclosure. Popular covers the
previous 30 complete UTC days; Trending covers the previous complete UTC day. The client supplies no timestamp,
Explore fallback, permission or popularity estimate. Native failures become unavailable, and `platform_closed`
becomes closed; neither becomes an empty success. Empty pages keep their continuation. Callers replace outdated
state and deduplicate Realm IDs if accumulating multiple pages. Both installed callers retain accumulated public
rows and the exact cursor on a failed continuation, retry that page manually and allow only one pending page;
`platform_closed` still clears prior rows. Sparse pages advance only through their returned continuation.

The attached [Realm discovery Pattern](src/stories/patterns/realm-discovery/realm-discovery.mdx) has the shared IDs
`patterns-community-realm-discovery--available`, `--image`, `--initials`, `--sparse`, `--empty`, `--loading`,
`--unavailable` and `--closed`. Sparse continues the returned page; Unavailable retries the real adapter. The fixtures
use recorded Realm metadata and explicit source-contract responses, without claiming native rank qualification.
They do not establish native or visual approval. Search/Web own their actual Pages IDs and placement review.

Cost: public Realm discovery

- Touches: one generated native GET per sort/page invocation; no per-row HTTP, account batch, permission read or refill.
- Bound: at most `min(limit, 20)` returned cards, matching the native examined-candidate cap; native query limits remain
  1–100 with default 20. Invalid local input sends no request. Continuations are preserved without automatic walking.
- Growth check: later use the existing native Community discovery acceptance; the focused local boundary cases in
  `tests/realm-discovery.test.ts` establish adapter/presentation behavior only.

## Realm publication subject choice

The existing Space/Realm `RealmShelf` integrates `community/publication-controls-view.tsx`. Its shared `EntityPicker`
uses `publicationSubjectSearch` to present Search's existing authorized, private, no-store `/api/search/suggestions`
response. There is no second query endpoint, subject lookup, prefill or permission producer. The shared picker owns
its 250 ms debounce, cancellation and failure/retry UI; the consumer checks cancellation again after the source
returns and retains the existing eight-result bound. Search failure stays unavailable, with the draft intact.

Choosing a disclosed subject shows its real label, type and cover and requires a separate Publish here action.
Clear selection discards recovery intent and remounts an empty picker. Choosing a subject unmounts the search so a
late prior query cannot replace the selection. Realm, reader and locale changes reset the draft; current lifecycle
freezes retire it and prevent in-flight replies from updating the shelf. Native publication still checks current
subject readability and `realm:publish`, including replay and final disclosure. Suggestions, membership, management
and Context grants supply no publication or read authority.

Each command captures the exact subject, action, expected head and idempotency key. Uncertain retry uses that same
intent; a conflict requires an explicit current-head decision with a new key. An unreadable current head offers
reload. Native denial clears the selected summary. Withdraw/reject keep their existing native commands and receive
kind-specific confirmation/recovery text. The independent 20-board/12-publication windows and cursors are unchanged.

Web owns ordinary phone390/desktop1280, light/dark review using the existing globals. Actual review IDs are:

- `pages-community-realm-publication--selection`
- `pages-community-realm-publication--chosen`
- `patterns-community-realm-publication--selection`
- `patterns-community-realm-publication--chosen`
- `patterns-community-realm-publication--clear-selection`
- `patterns-community-realm-publication--search-unavailable`
- `patterns-community-realm-publication--frozen`

Pages mount the actual Space route in `AppShell` with its single main. Patterns load the recorded Space/Realm shelf
through the same source and render `RealmShelf`; only Search failure is constructed. Focused plays cover selection,
intentional clearing, unavailable versus empty and the frozen surface. They invent no permission or successful
publication. `tests/publication-subject-picker.test.ts` records the assigned acceptance journey and focused
retry/conflict/late-response boundaries for integration. Acceptance, native, browser and screenshot execution are
deferred by the current minimal verification contract. Local `bun run --cwd apps/web typecheck` passes with no
type errors.

Source read: the existing review picker, Search suggestions loader, shared EntityPicker, native Community shelf
contract and the community design's referenced Discourse `lib/guardian/category_guardian.rb` at
`/home/edge/projects/rezics/rezics-next/.reference/partitioned-sitemap-feeds/discourse/` (read-only). The latter separates
reading from posting; no external source was copied.

Cost: one existing Search request per settled query or explicit retry, at most eight summaries; selection and clearing
make no request. Publication sends one native command per explicit action; conflict alone adds one existing point
read. There are no new per-row reads, refill walks, semantic writes or shelf query changes. Interface typing and
constructed story responses do not establish native disclosure or growth proof.

## Per-view presentation authoring

`/curate/presentation` edits each locally defined view of the active generic, structural-base, type and route
templates using the same Puck registry, schema-derived fields and layout renderers. The closed native view list
supplies the order; missing views are not materialized automatically, so native route/type/nearest-base/generic
fallback stays intact until a curator explicitly adds an override. Route templates retain their overview-only
contract. Adding a type or route template starts with a copy
of the current generic overview. No subject labels, private data or extra page reads populate these controls.
Adding a companion view to a generic, base or type template explicitly offers only that template's local overview or an empty valid document as its source. Add stays callable only while that view is still missing and an overview-copy source still has a local overview; reset confirmation binds to the reviewed override document, so a sibling edit keeps it and a replaced or removed override retires it.

Each template/view keeps both its composition and its raw Puck editing data in memory. Switching selections retains
unfinished language fields, node IDs and uncommitted edits. The selected locale controls the preview; editing one
language preserves the others. Publish sends the complete profile through the existing typed `publishProfile`/BFF
boundary and native immutable publish/activate API. Composition and whole-profile validation retain native JSON
pointers, closed appearance/slots, Heading levels 1–4 and the 16-read/128-output-slot refusal. The delivered
`CurationPublication` and `CurationPublicationRecovery` own publication intent, retry and unknown-outcome recovery.
A stale head retains every view draft until explicit review chooses to keep it at the reviewed head or load the
active profile. Retrying an original publication advances its exact snapshot; later per-view edits remain dirty.
Local discard restores the last loaded or confirmed snapshot. Closing the editor retains its raw draft. Reload
replaces drafts only after a successful read and asks before losing unpublished changes; while an original
publication remains unresolved, reload inspects its active head without replacing drafts or the publication intent.
The editor opens by choosing a template/view or the selected template's button. The delivered published-page
preview stays in its own region, with its existing Context and prepared BFF read. Inspecting or closing that preview
does not replace the selected editor, pass draft documents to the public read, or alter publication recovery.

The interface and Puck controls use the eight shared message catalogues and interface typography. Preview data
components are explicitly labelled placeholders, with no authority or synthetic source data. Drafts are local to
the mounted editor; navigation does not persist them.

Behavior story IDs for Web's shared phone390/desktop1280, locale and theme globals:

- `pages-curate-presentation-view-editor--authoring`
- `pages-curate-presentation-view-editor--retained-view-draft`
- `pages-curate-presentation-view-editor--stale-profile`
- `pages-curate-presentation-view-editor--native-validation`
- `pages-curate-presentation-view-editor--discard-confirmation`
- `pages-curate-presentation-view-editor--reload-unavailable`

`tests/presentation-view-editor.test.ts` covers independent view edits, native resolution, raw drafts, language
preservation, discard, pointers and budget refusal. `tests/presentation-view-editor-publication.test.ts` covers
draft confirmation and explicit current-head review through the delivered publication helper. Stories mount the actual editor in `AppShell`; their inert
profile and failure responses are constructed behavior inputs, not native publication or visual evidence.
Source read: the existing composition/profile/view/schema code, Puck 0.23's installed public types, existing Web
editor/converters/BFF/session integration, delivered publication helper/recovery UI, published preview panel and
resolution stories, UI control index and shared story shell. No external reference-project
source is named for this authoring surface, and none was used. Native freshness/recovery obligations remain in
their original acceptance contract for the later integration gate; no harness or authority was added here.

Cost: changing a selection or field makes no request. Local draft conversion/validation is bounded by the existing
composition/profile limits. Reload uses the existing active/profile reads; explicit publication uses the existing
immutable profile POST and activation POST. There are no new descriptors, grants, private reads or background walks.

## Recipe release recovery

After a definite released-definition refusal, the Recipe editor requires an explicit current-definition read before retry;
compatible draft values remain intact, while changed or removed fields stay visible and read-only until removed, and
uncertain commands retain their original payload and key.

## Creator statements and external-payment evidence

An unsent reference warns only while it satisfies the existing non-blank, 256-character validator; clearing it removes the warning, and a captured `markPaid` attempt remains command custody.

### Creator statement recovery

Creator statement list/detail pages use the private owner-self payout statement APIs, with at most 20 rows per
page and no per-line enrichment. The point read precedes the line read; refusal of either conceals the inspector.
Recorded money units, signed amounts and zero remain unchanged. Missing unit facts render amounts unavailable.
The delivered external-payment evidence consists only of the statement's recorded reference and time; it does
not establish receipt, provider bank payout, reserves or payability. Richer payment attestations remain unavailable.

Recovery discards only the cursor explicitly rejected by its paginated API; point-read failures and pending
navigation retain the original line cursor and list return cursor. An `invalid_cursor` (400) or `stale_cursor` (409)
restarts that list or line page. Other failures retry the exact requested page. Line restart preserves `from`,
and Back uses it only as the statement-list cursor. Pending detail navigation carries the same statement ID and
return address. No recovery follows a provider redirect or refreshes a cursor automatically.
A later stale or empty line page keeps the admitted paid point, captured amounts and list return address;
list later-empty stays a separate list composition.

Source contracts: the Commerce owner README's financial-evidence and recorded-display sections, payout route DTOs,
the generated payout client and existing statement fixtures/pages. No external reference source applies.
Focused recovery acceptance lives in `tests/creator-statement-current-read.test.ts` and `tests/creator-statements.test.ts`.

Decision: statement recovery uses the
[shared creator read and command admission contract](#creator-read-and-command-admission); healthy reads require
no CSRF, and payment mutations retain their original credential, operands and request identity.

Decision: the later-empty list story starts from a nonempty first page with its opaque next, and that empty later page still supplies a next cursor so zero visible rows do not complete the list or hide continuation.

### Creator statement addresses

Decision: restart malformed list/evidence positions before reading; discard a malformed return hint while preserving the statement ID and exact valid evidence position.

## Private creator Sales

`/creator/sales` uses the existing signed-in route and list/card family. Its current read prepares one server
session, requires the advertised Sales operation and calls `kernelClient().commerceSales.get` with that
credential, a 20-row limit and the signed cursor. Every call sets `cache: no-store` and `redirect: manual`;
responses are private/no-store/noindex/nofollow and route retention is zero. Native authorization remains final.
An exposure refusal stops the sales request and preserves its denied, error or stale outcome; transport failure,
redirect or missing exposure data remains unavailable. Losing authority between session preparation and exposure
does not become an empty sales page.
The shared current-origin observer retires viewer, admission and locale/cursor replacements synchronously,
including ABA before React commits. A healthy credential renewal may retain accepted same-viewer data while
retiring its in-flight read. No caller-selected creator, token or CSRF value enters the returned page envelope.
A completed refresh for a different viewer or cursor replaces the prior page with unavailable and clears its
continuation. Initial loader data cannot become a fallback after that refresh or a healthy credential renewal.
Malformed saved sales addresses preserve the URL until explicit correction or restart; string cursor values are
safely prefilled, while non-string values are not echoed.

The endpoint DTO owns the sanitized boundary: captured amounts and historic unknowns, separate currencies,
preparing versus complete empty, and genuine denied/error/stale/unavailable states. There are no buyer details,
Library telemetry, guessed current-offer links, mixed-currency totals or payout/entitlement claims. The mounted
operation uses the existing selling gate and exact action/catalogue/website scope helpers without widening consent.
The existing client transport uses a narrow consumer-local typed bridge until canonical OpenAPI/client generation
lands through dev integration; standalone ambient declarations are not another contract.
Named Sales Storybook states remain constructed PatternStory plus AppShell examples; ActualRoute mounts the served
path without claiming admitted producer-owned availability.
Decision: the later-empty Sales ready projection keeps the original incoming cursor and supplied next, so a page with
no visible rows is distinct from preparing or incomplete and does not mean zero revenue or finished history.

Cost: current sales read

- Touches: one session preparation, one existing exposure GET and one sales GET, at most 20 displayed
  rows, signed continuation only; no per-row HTTP, source/backfill dispatch, buyer reads or prefetch.
- Bound: per-call restrictive transport, source DTO validation and zero personal query retention; repeats and
  failures charge their actual calls. The native owner's eight-axis composed SQL/Work total remains explicitly
  unknown until actual complete terms arrive; existing local Accounts admission supplies no child funding.
- Growth check: `creator-sales-native.test.ts`, `creator-sales-current-outcomes.test.ts` and
  `creator-sales-current-viewer.test.tsx` author default transport, current preparation, genuine exposure failures,
  healthy rotation, delayed viewer/admission/address ABA and foreign-empty rejection.
  `creator-sales-current-refresh.test.tsx` covers replacement of a seeded page after a foreign refresh and
  subsequent healthy rotation.
  Native/browser/visual/full acceptance remains controller-owned after integration.

## Mounted cross-media catalogue navigation

Home now includes the existing native route TypeLists without replacing the Home feed or Search adapters. Realm
catalogues continue through the delivered Space composer and native publication shelf. The real seed must have
independently admitted Realm publications; a source import alone never creates that authority. Subject overviews mount the authenticated Connections
reader for work relations, character appearances/qualified voice credits and incoming person credits. It uses the
current release and actual native `relations`, `links` and explicitly requested bounded graph method; it never
loads a canned Imports manifest or hydrates related endpoints per row.

The reader owns three independently replaceable 12-row pages, bounded no-store response windows and a single
optional native graph. Target, selected reading and current session/CSRF replacement erase old pages and pending
results. Existing editors keep command and immutable retry authority. Eight launch locales include selection,
preparing, empty, denied, stale, unavailable and recovery text. Links retain one validated public return destination
and acquire fresh authority when followed. Graph exploration remains unavailable in Realms until Semantic supplies
a Context selector; qualifiers remain on the native relation streams. Imports source gaps and unresolved endpoints
keep their exact producer identities.

The [Subject owner contract](../../docs/subject-pages.md#mounted-cross-media-visits) defines caps, disclosure,
return navigation and the final native capture. Focused boundary tests live in `tests/subject-connections.test.ts`;
they are response-double coverage, not a native execution claim. Native `tests/native/cross-media-pages.test.ts`
requires a retained mounted stack and authentic selected full-graph seed via `REZICS_CROSS_MEDIA_VISIT`; it creates
no replacement native stack and preserves the existing browser and native handles. Its final 56-image core set
must cover 390/1440 light/dark after the native journey. Landing defers that acceptance and capture to integration.
