# Web launch review

Reviewed current development commit `50253f81316a8e975d67971fb62ed42db3145c10` on 28 October 2026.
The site is **not ready for public launch**. Routes and API clients exist for many journeys, but subject content,
the current library contract, SEO and routing integration still have material gaps.

This is a code-and-document review only: no stack, browser, screenshot or check host was run. “Met” means a routed
implementation reaches its owning API; it does not certify deployment configuration or a successful live transaction.
“Partial” includes incomplete journeys and permanent unavailable states. Tests are supporting source evidence,
not results from this review. Paths and line numbers below refer to the reviewed commit.

Primary sources are this [repository revision](https://github.com/rezics/rezics-next/tree/50253f81316a8e975d67971fb62ed42db3145c10)
and its owning documents; the repository carries GNU AGPL v3 (`LICENSE:1`). No external reference clone or copied
implementation was needed. This report is evidence, not a replacement specification.

The common pattern is reusable routes, templates, owner clients and recording infrastructure, with incomplete
adapters at their boundaries (`apps/web/src/kernel/client.ts:43`; `apps/web/src/features/pages/subject-frame.tsx:83`;
`apps/web/src/sitemap/feeds.ts:12`). Reuse those mechanisms and close the five gaps in the order proposed below.

## Foundation and navigation

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| TanStack Start on a site Worker | met | `apps/web/vite.config.ts:4`, `:48`; `apps/web/cloudflare.config.ts:2`; `apps/web/src/server.ts:224` | Deployment configuration still needs operational verification. |
| One documented local command | met | `apps/web/README.md:1`; `apps/web/package.json:6`; `apps/web/src/kernel/client.ts:43` | `bun run dev` from `apps/web` uses the development fake when `KERNEL_ORIGIN` is absent. It is not evidence of a running production API. |
| Paraglide messages for en, zh-Hans, zh-Hant, ja, ko, de, fr, es | met | `apps/web/project.inlang/settings.json:4`; `apps/web/vite.config.ts:47`; `apps/web/messages/en.json:1`; `apps/web/messages/zh-Hans.json:1`; `apps/web/messages/zh-Hant.json:1`; `apps/web/messages/ja.json:1`; `apps/web/messages/ko.json:1`; `apps/web/messages/de.json:1`; `apps/web/messages/fr.json:1`; `apps/web/messages/es.json:1` | Translation and visual review remain a separate condition below. |
| Routed layout and accessible navigation | met | `apps/web/src/router.tsx:39`; `apps/web/src/routes/__root.tsx:54`; `apps/web/src/shell/shell.tsx:65`, `:143`, `:172`; `apps/web/src/features/pages/view-tabs.tsx:40` | Code provides a skip link, named navigation, phone sheet, script-free navigation and linked tabs. Runtime accessibility was not retested. |
| Public API versus development fake | met | `apps/web/src/kernel/client.ts:43`; `apps/web/src/media/kernel.ts:1`; `apps/web/.storybook/cloudflare-workers.ts:1` | Production reads use the generated `@rezics/client`; development and stories use `src/kernel/fake.ts`. The requested `src/kernel/fake/` extension directory has no modules on this revision; do not count story recordings as live integrations. |

## Subject pages and launch verticals

`docs/scope.md` (“First public scope”) does not enumerate verticals. For this review, launch coverage means the 24
concrete profiles in `packages/definitions/README.md` (“Schema.org subject types”), including their editions and parts.
The shared page API and templates are the intended mechanism; a separate route per vertical is unnecessary
(`docs/subject-pages.md`, “Principles”). No vertical is fully met while its required ratings/discussion or list traversal
is incomplete.

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Books, book editions and book series | partial | `packages/definitions/README.md`, “Schema.org subject types”; `apps/web/src/features/pages/subject.tsx:81`; `packages/composition/profiles/platform.json:701` | Real `pages.$read` reaches shared templates; finish the common gaps below, especially full editions traversal. |
| Video games, visual novels, releases and add-ons | partial | Same profile table; `apps/web/src/features/pages/subject.tsx:81`; `packages/composition/profiles/platform.json:285` | Shared base/generic rendering exists; finish full views, scores and contribution entry points. |
| Anime/television series, movies, seasons and episodes | partial | Same profile table; `packages/composition/profiles/platform.json:1162`; `apps/web/src/features/pages/subject.tsx:81` | Ordered parts have templates, but the generic view route does not carry continuation parameters. |
| Manga works and volumes | partial | Same profile table; `apps/web/src/features/pages/subject-frame.tsx:83`; `apps/web/src/routes/subjects/$id_.$view.tsx:76` | Complete parts/editions paging and the common content sections. |
| Characters, story arcs and general series | partial | Same profile table; `packages/composition/profiles/platform.json:2570`; `apps/web/src/features/pages/views.ts:12` | Character templates exist; complete appearances/roles/cast and full traversal, rather than stopping at previews. |
| People and organizations | partial | Same profile table; `packages/composition/profiles/platform.json:1212`, `:1687`; `apps/web/src/features/pages/agent.tsx:30` | Agent account pages use the real page API. Verified subject addresses still need their agent redirect; public self-presentation/member controls are not a complete journey. |
| Software, concepts and concept schemes | partial | Same profile table; `packages/composition/profiles/platform.json:2243`; `apps/web/src/features/pages/subject.tsx:81` | Generic/type templates render facts; finish required details, continuation and contextual behavior. |
| Food, recipes and music albums | partial | Same profile table; `apps/web/src/features/pages/values.tsx:68`; `apps/web/src/features/pages/data.tsx:542` | Generic values/documents render, but common subject gaps and recipe structured-data gaps remain. No end-to-end vertical-specific proof is implied by a type definition. |
| Overview identity, cover, About, facts, reactions and Sources | partial | `apps/web/src/features/pages/data.tsx:383`, `:518`, `:697`; `apps/web/src/features/pages/overview.tsx:638`, `:765`; `apps/web/src/routes/subjects/$id.tsx:126` | Cover/title, description fallback, facts, reactions, library action and sources are routed. Complete the “Overview” sequence: headline score, own rating, next-part/progress action and first-contribution invitations, including title-only subjects. |
| Type-framed covers, placeholders and credits | met | `apps/web/src/features/pages/data.tsx:269`, `:697`; `apps/web/src/features/pages/overview.tsx:589`; `packages/ui/src/components/cover.tsx:200`, `:228` | Routed headers use the shared cover model, type ratio and placeholder; large covers have captions and Sources carries the credit. Phone loading priority is assessed under Performance. |
| Overview, editions, contents, characters, credits, relations, reviews, discussion, lists and details URLs | partial | `apps/web/src/routes/subjects/$id_.$view.tsx:17`, `:76`; `apps/web/src/features/pages/subject-frame.tsx:83`; `apps/web/src/features/pages/view-tabs.tsx:8`; `apps/web/src/features/pages/views.ts:166` | URLs render server-side documents and conditional, counted, sticky, scrolling tabs. Reviews/discussion are placeholders; several full views cannot advance beyond their first page. |
| Traversable previews and full views | partial | `apps/web/src/features/pages/overview.tsx:242`, `:527`; `apps/web/src/routes/subjects/$id_.$view.tsx:36`; `apps/web/src/features/pages/relations-view.tsx:25`, `:116` | Relations has real `subjects.links` cursor paging. Add cursor/filter validation and owner reads to other subject list views; `CollectionList` currently slices even a paged document. Keep overview previews within twelve items. |
| Reader-side relations, roles, credit order, spoilers and custom Context groups | partial | `apps/web/src/subject/relations.ts:41`; `apps/web/src/features/pages/overview.tsx:256`, `:271`, `:362`, `:505`; `apps/web/src/features/pages/values.tsx:31` | Inverse/symmetric labels and spoiler gates exist. Inverse holders become `notes: []`, `gated: false`; carry role/cast/order/spoiler evidence through those reads and label custom Context groups. |
| Ratings, distributions, populations, reviews and active discussions | partial | `apps/web/src/features/pages/overview.tsx:725`, `:738`, `:751` | All three components unconditionally render `Unavailable`. Wire the owning rating/content APIs, real counts, Global/Realm populations and first-contribution actions. Reactions are not ratings. |
| Honest failed reads and contested facts; complete Details | partial | `apps/web/src/features/pages/overview.tsx:213`; `apps/web/src/features/pages/data.tsx:383`, `:697`; `packages/composition/profiles/platform.json:264` | Retry sections exist. Details is a statement rendering template, not a complete competing-claims/history journey; add unresolved-fact presentation and links to claims/history without exposing raw reading-view values. |
| One agent, one page | partial | `apps/web/src/routes/@{$handle}.tsx:10`; `apps/web/src/features/pages/agent.tsx:30`; `apps/web/src/routes/subjects/$id.tsx:68` | Account handles render subjects/activity. Subject loader only redirects to another subject, using 308; add verified-agent 301 redirects to `/@handle`. |
| Realm/Zone subject context and population switch | missing | `docs/subject-pages.md`, “Realm context”; `apps/web/src/features/pages/subject.tsx:83`; `apps/web/src/routes/subjects/$id_.$view.tsx:49` | Page targets contain only subject/view, with no routed Realm/Zone Context or population switch. Add those routes and explicit unpublished-subject fallback. |

## Search, discussion, commerce and media

All “met” integrations here use the generated client against their owner through `KERNEL_ORIGIN`; the development
fake is a fallback, not the only implementation (`apps/web/src/kernel/client.ts:43`).

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Search, facets and discovery | met | `apps/web/src/routes/search.tsx:20`; `apps/web/src/search/search.tsx:212`, `:230`; `apps/web/src/routes/index.tsx:17`, `:49` | Search reaches `subjects.$search`, with type/facet filters and cursors. Home catalogue rows depend on a published composition; absent composition gives only a heading. Routing/SEO compliance remains below. |
| Typeahead against search API | met | `apps/web/src/server.ts:332`; `apps/web/src/search/suggestions.ts:16`; `apps/web/src/search/search.tsx:570`, `:633` | Shell combobox calls the site endpoint and owning suggestion API, with failure/empty states. |
| Boards and thread reading | met | `apps/web/src/routes/boards/$id.tsx:18`; `apps/web/src/routes/threads/$id_.$slug.tsx:28`; `apps/web/src/threads/thread-page.ts:70`; `apps/web/src/identity/page-loaders.ts:38` | Real board/thread/posts reads, authors and continuation are wired. Public/session separation still fails the routing contract below. |
| Posting, replies, editing and deletion | met | `apps/web/src/routes/boards/$id_.new.tsx:14`; `apps/web/src/threads/actions.ts:114`, `:123`; `apps/web/src/threads/post-writes.ts:30`, `:78`, `:123` | Routed composers reach content APIs with session, CSRF and idempotency. Subject-linked reviews/discussions are still separate unfinished journeys. |
| Stripe Checkout start and return | met | `apps/web/src/routes/offers/$id.tsx:7`; `apps/web/src/server.ts:256`; `apps/web/src/checkout/start.ts:58`, `:82`; `apps/web/src/routes/orders/$id.tsx:13`; `apps/web/src/checkout/order.server.ts:19`, `:69` | Offer → commerce order creation → returned checkout URL → buyer order/status reads is wired. Payment/webhook correctness is commerce-owned and was not exercised. |
| Site upload routes and owner completion | met | `apps/web/src/server.ts:349`; `apps/web/src/media/index.ts:8`; `apps/web/src/media/upload.ts:9`, `:72`; `apps/web/src/threads/upload.ts:1` | Reservation, byte upload and completion reach content through the generated media client. |
| FixedLengthStream feeding DigestStream and R2 put | partial | `apps/web/src/media/upload.ts:25`, `:32`, `:56`, `:59` | The upload hashes in a counting transform **before** writing the FixedLengthStream; only R2 receives its output. It is streaming with backpressure/cleanup, but does not implement the stated stream topology. Put the fixed-length stage before the bounded hashing/storage fan-out. |
| Fresh download decision on every GET/HEAD | met | `apps/web/src/media/index.ts:20`; `apps/web/src/media/download.ts:56`; `apps/web/src/media/kernel.ts:8` | Owner authorization occurs before conditional 304, range handling or R2 reads. No permission cache bypass is present in this handler. |
| Workers rate-limit binding, 10-second and 60-second windows | met | `apps/web/cloudflare.config.ts:18`; `apps/web/src/rate-limit/read.ts:21` | Both bindings are consumed concurrently and return 429/Retry-After. Keying and bypass gaps remain in the next row. |
| All site reads keyed by account, anonymous session cookie | partial | `apps/web/src/server.ts:228`, `:275`, `:281`; `apps/web/src/rate-limit/read.ts:9` | Public documents always use IP, server functions/suggestions usually use session ID, and cookie-less traffic gets IP. Account identity is resolved only on selected credential routes. Redirects and crawler files return before limiting. Apply the contract's identity key consistently and establish anonymous session identity without personalizing public HTML. |

## Auth pages Worker

Auth uses its own same-origin HTTP API, not the kernel generated client; this is the owning API for these operations
(`apps/auth/src/api.ts:9`; `apps/auth/README.md`, “Production routes”). It should not be replaced by a kernel fake.

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Separate Auth pages Worker and sign-in | met | `apps/auth/cloudflare.config.ts:19`; `apps/auth/src/server.ts:5`, `:35`; `apps/auth/src/routes/login.tsx:129` | Real password/passkey sign-in is routed to Auth; production API paths remain at the issuer origin. |
| Sign-up behind Turnstile | met | `apps/auth/src/routes/signup.tsx:80`, `:85`, `:180`; `apps/auth/src/signup.ts:37`; `services/auth/src/turnstile.ts:4`, `:81` | Widget proof is sent to Auth signup, checked for signup action/hostname, then sign-in follows registration. Production keys still require configuration. |
| Passkeys with rp.id = rezics.com | met | `apps/auth/src/passkeys.ts:25`, `:46`, `:120`; `apps/auth/src/routes/security.tsx:123`; `services/auth/src/passkeys.ts:18` | Browser uses Auth options; the owner fixes RP ID to `rezics.com`. Local tests using localhost are not the production RP configuration. |
| Consent | met | `apps/auth/src/routes/consent.tsx:43`, `:69`; `apps/auth/src/consent.ts:15` | Client/scopes read and consent write use the Auth API. |
| Security settings and step-up | met | `apps/auth/src/routes/security.tsx:62`; `apps/auth/src/security.ts:71`; `apps/auth/src/routes/step-up.tsx:20`; `apps/auth/src/step-up.ts:15` | Sessions/passkeys and password/passkey reauthentication are routed. No live ceremony was attempted. |
| Account deletion and organization creation | met | `apps/auth/src/routes/account.delete.tsx:89`; `apps/auth/src/routes/organizations.new.tsx:85`; `apps/auth/src/account-operations.ts:57` | Auth approval/execution bridge is wired, including step-up outcomes; this does not supply organization profile/member management. |

## Library and the remaining first-public surfaces

The explicit web assignments in `docs/scope.md` (“First public scope”) are subjects, shared Library/Collections and
SEO. Subjects and SEO have their own tables. The remaining rows distinguish existing site surfaces from missing
journeys whose API/product owners are other modules; those rows do not transfer ownership to web.

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Library profiles and independent labels | partial | `docs/library-and-collections.md`, “Model”; `apps/web/src/library/entries-read.ts:14`, `:23`; `apps/web/src/library/shelf-params.ts:12` | Real entry read/write UI exists, but fixes five states globally and has no independent label model. Consume the definitions profile/revision and expose labels beside the exclusive state. |
| Curated Collections | met | `apps/web/src/routes/collections/$id.tsx:6`; `apps/web/src/routes/collections/new.tsx:36`; `apps/web/src/library/collection-records.ts:84`, `:177`, `:200`, `:223` | Existing API supports creation, visibility, member notes/reorder/removal and paging. The unified surface contract is incomplete below. |
| Built-in dynamic Collections and one list surface | missing | `docs/library-and-collections.md`, “Model”, “Consequences”; `apps/web/src/library/entries-read.ts:49`; `apps/web/src/library/collection-page.tsx:24`; `apps/web/src/routes/library/index.tsx:8` | Shelf remains a separate fixed-state entry view. Implement built-in dynamic membership with the owner, then reuse Collection sorts, filters, layouts, bulk actions and mounting. User-saved dynamic queries are deferred. |
| Collection schema.org ItemList export | missing | `docs/scope.md`, “First public scope”; `docs/library-and-collections.md`, “Model”; `apps/web/src/routes/collections/$id.tsx:6` | This route only reads/renders the collection; add an export action/response backed by paged disclosed membership. |
| Progress and copies | met | `apps/web/src/routes/library/progress.$id.tsx:1`; `apps/web/src/library/progress-reads.ts:351`, `:446`, `:475`; `apps/web/src/routes/library/copies.tsx:1`; `apps/web/src/library/copies-read.ts:289`, `:321`, `:353` | Current owner APIs support start/record/finish and copy CRUD through routed pages. Profile-driven capability/holdings changes still belong to the library gap. |
| Realms and Spaces | partial | `apps/web/src/routes/realms/$id.tsx:9`; `apps/web/src/routes/spaces/$address.tsx:12`; `apps/web/src/community/space.ts:183`, `:225`, `:247` | Reads, My Realms and join/leave reach accounts/community. Creation/management and complete traversable publication/board lists are not supplied by these preview pages. |
| Zones as routed saved scopes and mounted Collections | missing | `docs/scope.md`, “First public scope”; `apps/web/src/routes/curate/presentation.tsx:1`; `apps/web/src/features/pages/route.tsx:39` | A composition renderer/editor is not a Zone route. Add scope/address resolution and mounted Collection navigation against semantic/presentation APIs. |
| Agents and public profiles | partial | `apps/web/src/routes/@{$handle}.tsx:10`; `apps/web/src/features/pages/agent.tsx:30`, `:49`; `apps/web/src/features/pages/agent-actions.ts:25` | Public profile/activity reads and activity continuation exist. Add self-presentation/public-view editing, organization membership representation and verified-subject redirects. |
| Ratings and reviews | partial | `apps/web/src/features/pages/overview.tsx:725`, `:751`; `apps/web/src/features/pages/agent.tsx:64` | Account review lists do not close the missing subject rating/review read and write journeys. |
| Reports, moderator resolution and minimal appeals | partial | `apps/web/src/report/submit.server.ts:49`, `:59`; `apps/web/src/report/content-actions.tsx:1`; `apps/web/src/routes/threads/$id_.$slug.tsx:28` | Thread/post report dialogs reach `reports.post`; subject reporting may be refused by the owner. Add owner-supported cross-system report targets, moderator resolution and appeals routes. |
| Minimal in-app notifications and per-kind preferences | missing | `docs/scope.md`, “First public scope”; `apps/web/src/shell/shell.tsx:93`; `apps/web/src/settings/preferences.ts:9`, `:33` | Navigation has no inbox; settings only models spoiler/suitability. Add notice read/acknowledgement and reply/mention/moderation preference controls against content/accounts. |
| Follows | partial | `apps/web/src/library/mine-following.ts:43`, `:71`; `apps/web/src/library/collection-records.ts:246`; `apps/web/src/library/collection-page.tsx:15` | Collection follow and following/unfollow are wired. Complete other admitted follow targets and owner-only follower-count views. |
| Accounts, authentication, preferences and deletion | partial | Auth table; `apps/web/src/routes/settings.tsx:7`; `apps/web/src/settings/preferences.ts:67`; `apps/auth/src/routes/account.delete.tsx:26` | Auth/deletion and reading preferences exist; notification preferences and public profile controls are still missing. |
| Catalogue contributions, identity resolution, definitions and vertical editors | partial | `apps/web/src/routes/curate/presentation.tsx:1`; `apps/web/src/features/pages/curate-actions.ts:1`; `apps/web/src/subject/definitions.ts:1` | Presentation curation and definition consumption exist. They are not a routed semantic facts/contributions/identity-resolution editor; coordinate those entry points with semantic. |
| Offers, orders and entitlements; import coordination | partial | `docs/scope.md`, “First public scope”; `apps/web/src/routes/offers/$id.tsx:7`; `apps/web/src/routes/orders/$id.tsx:13`; `apps/web/src/checkout/order.server.ts:19`; `services/kernel/src/commerce/README.md:21` | Buyer offer/checkout/order pages exist; add a routed buyer-entitlement read/destination against commerce. Imports belong to imports, not web; no import or seller dashboard is required by this review. Coordinate only the public entry points their owners require. |
| Articles/hosted works/media and deferred systems stay closed | partial | `docs/scope.md`, “First public scope”; `apps/web/src/kernel/platform-closed.ts:1`; `apps/web/src/shell/closed.tsx:1` | Closure handling exists; media transport is not a public hosted-work browser. Do not add feeds, points, algorithmic recommendations or partner API to this launch review. Curated rankings and search rating sort depend on their existing owners. |

## Storybook and visual evidence

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Routed stories driven by recorded API responses | met | `apps/web/src/stories/page.tsx:40`, `:101`; `apps/web/.storybook/cloudflare-workers.ts:1`; `apps/web/src/kernel/fake.ts:2`; `apps/web/README.md`, “Storybook and page recordings” | Stories enter the application route tree and replay committed responses; keep adding recordings as missing journeys become available. |
| Screenshots reviewed in all eight locales | partial | `apps/web/.storybook/preview.tsx:9`; `apps/web/scripts/screenshots.ts:9`, `:61`, `:113`; `apps/web/README.md`, “Storybook and page recordings” | Capture tooling defaults to eight locales and both themes. That is not evidence of completed visual review. Record a revision/story/locale review matrix and resolve findings; this audit intentionally ran no screenshots. |

## SEO: every part of docs/seo.md

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Principles: anonymous HTML and no hidden-data leaks | partial | `docs/seo.md`, “Principles”; `apps/web/src/routes/subjects/$id.tsx:55`; `apps/web/src/features/pages/agent-actions.ts:29`; `apps/web/src/threads/thread-page.ts:70` | Public pages still read reader settings/library/reactions or credential-specific content during SSR. Render anonymous owner data first; fetch personal state only after hydration, and derive metadata from that same anonymous representation. |
| URLs: locale, root negotiation, case and trailing slash | partial | `apps/web/src/server.ts:365`; `apps/web/src/router.tsx:53` | Locale 302 and trailing-slash 301 exist. Add path-case normalization while preserving IDs/handles. |
| Subject/agent URLs and merged/moved statuses | partial | `apps/web/src/routes/subjects/$id.tsx:69`, `:94`; `apps/web/src/features/pages/subject-frame.tsx:127`; `apps/web/src/features/pages/subject.tsx:81` | Subject URLs have no localized slug, and merge handling is survivor-ID comparison followed by 308, not the documented API redirect handling/public 301. Add canonical subject/view slug routes and agent redirects. |
| Thread canonical URLs | met | `apps/web/src/threads/thread-page.ts:87`; `apps/web/src/routes/threads/$id_.$slug.tsx:28`; `apps/web/README.md`, “Routing” | Current thread slug routing implements the documented canonical journey; other page families still need integration. |
| Metadata, cards, canonical/alternate links and html lang | partial | `apps/web/src/shell/head.ts:18`, `:37`; `apps/web/src/routes/__root.tsx:25`, `:54`; `apps/web/src/routes/subjects/$id.tsx:109` | Root emits canonical/eight alternates/x-default and URL lang. Most leaves override only title, leaving generic cards and no localized description/type/year. Supply locale paths and pageHead inputs for every indexed family, including Twitter metadata. |
| Indexing rules: search, filters, pagination, title-only and private contexts | partial | `apps/web/src/routes/search.tsx:52`; `apps/web/src/routes/library/index.tsx:23`; `apps/web/src/routes/subjects/$id.tsx:109`; `apps/web/src/threads/thread-head.ts:170` | Board/thread helper has indexability handling; other routes generally emit no robots meta. Apply noindex/follow and private-page noindex consistently, and canonicalize equivalent Realm/Zone views to Global. |
| Subject JSON-LD, explicit profile class, creators and editions | partial | `apps/web/src/features/pages/jsonld.ts:94`, `:109`, `:124`; `apps/web/src/features/pages/subject.tsx:110`; `docs/seo.md`, “Structured data” | Serializer ignores release schemaOrgType, reduces non-schema profiles to Thing, links related objects to `/id/`, and hardcodes site origin. Use explicit class selection, agent URLs/types, images, sameAs and shown edition/episode data. |
| Native Global aggregateRating; recipe steps; agents and breadcrumbs | partial | `apps/web/src/features/pages/jsonld.ts:65`, `:85`, `:131`; `apps/web/src/routes/@{$handle}.tsx:32`; `apps/web/src/threads/thread-head.ts:171` | Board/thread graphs include breadcrumbs. Subject serializer has no thresholded native aggregate and skips document/media values; agent route suppresses JSON-LD. Add recipe instructions, agent graph, subject breadcrumbs and public-only Global rating data. |
| robots.txt and stored sitemap serving | partial | `apps/web/src/server.ts:228`; `apps/web/src/sitemap/robots.ts:4`, `:15`; `apps/web/src/sitemap/serve.ts:11`; `apps/auth/src/routes/__root.tsx:1` | Site disallows private/editor/API paths and serves R2 index/shards. robots falls back to request origin when configuration is empty; Auth pages also need noindex. Keep all crawler URLs on configured PUBLIC_ORIGIN. |
| Sitemap packing, eight alternates, bounds and meaningful lastmod | partial | `apps/web/src/sitemap/pack.ts:15`, `:18`, `:74`; `apps/web/src/sitemap/xml.ts:52`; `apps/web/src/sitemap/export.ts:225`, `:482` | Helpers support family grouping, gzip/digest bounds, optional page lastmod and atomic publication. No actual page feed supplies those helpers with launch pages. |
| Daily complete sitemap export from owning feeds | partial | `apps/web/cloudflare.config.ts:6`; `apps/web/src/server.ts:84`, `:204`; `apps/web/src/sitemap/feeds.ts:12`; `services/kernel/src/semantic/http/subject-pages.ts:43`; `docs/seo.md`, “Sitemaps” | Workflow/export infrastructure exists but `./feeds/*.ts` has no modules. Wire every indexed family; the subject feed is still a 503 stub. Its owner must implement bounded, signed-keyset, anonymous disclosure and public-change metadata reads. Consume short/empty pages until next=null without scanning in requests. |
| Truthful 404/301/403 and closed-page noindex | partial | `apps/web/src/routes/__root.tsx:16`, `:45`; `apps/web/src/routes/subjects/$id.tsx:68`; `apps/web/src/shell/closed.tsx:1` | notFound and platform-closed 403 exist, but public merge status and closed/private noindex are incomplete. Optional IndexNow is not a gap. |
| Performance: streamed SSR, anonymous cache/ETag, responsive priority cover, stable hydration | partial | `apps/web/src/server.ts:224`, `:381`; `apps/web/src/features/pages/data.tsx:269`; `packages/ui/src/components/cover.tsx:146`, `:175`; `docs/seo.md`, “Performance”; `apps/web/README.md`, “Security headers” | Streaming, reserved cover frames and responsive srcset exist. Large header covers get priority, but the phone cover does not. The nonce policy deliberately forces private/no-store, conflicting with the authoritative SEO and Routing cache rules. Reconcile CSP with anonymous caching/ETags and prioritize the visible phone cover. CWV and hydration shifts have no runtime evidence here. |

## TanStack rules in apps/web/README.md: Routing

| Requirement | State (met, partial, missing) | Evidence | What is left |
| --- | --- | --- | --- |
| Locale URLs and thread URLs | met | `apps/web/src/server.ts:365`; `apps/web/src/router.tsx:53`; `apps/web/src/threads/thread-queries.ts:15`; `apps/web/README.md`, “Routing” | Existing mechanics cover those README rules; the wider subject URL specification remains incomplete above. |
| Public reads anonymous; signed-in guards in beforeLoad | partial | `apps/web/src/routes/subjects/$id.tsx:55`; `apps/web/src/routes/settings.tsx:7`; `apps/web/src/routes/library/index.tsx:16`; `apps/web/src/routes/collections/new.tsx:64` | Move personal reads after hydration. Signed-in pages currently use loader/component signed-out states rather than beforeLoad session checks and return-path sign-in redirects. |
| queryOptions per read, ensureQueryData, suspense/public and browser-only personal queries | partial | `apps/web/src/router.tsx:41`, `:44`; `apps/web/src/kernel/query.ts:1`; `apps/web/src/routes/spaces/$address.tsx:13`, `:20`, `:28`; `apps/web/src/routes/index.tsx:46`; `apps/web/src/routes/search.tsx:40`; `apps/web/src/routes/subjects/$id.tsx:100` | Router intent preload and some factories exist. Search/subject/library loaders call server functions directly; personal Space/Home queries override staleTime to Infinity. Apply the documented one-factory/60-second public/zero personal pattern throughout. |
| Valibot validateSearch and loaderDeps | partial | `apps/web/src/routes/search.tsx:21`, `:34`; `apps/web/src/routes/subjects/$id.tsx:95`; `apps/web/src/routes/collections/$id.tsx:7` | Ad hoc validators/dependencies exist, not the required Valibot schemas. Define schemas with defaults and include all loader-dependent parameters. |
| pageHead at each leaf; root emits links once | partial | `apps/web/src/routes/__root.tsx:25`; `apps/web/src/threads/thread-head.ts:164`; `apps/web/src/routes/search.tsx:52`; `apps/web/src/routes/settings.tsx:9` | Root links and thread/board helpers exist; migrate every remaining leaf head to pageHead with correct data and indexing policy. |
| Statuses, anonymous caching and configured origin | partial | `apps/web/src/server.ts:381`; `apps/web/src/shell/origin.ts:1`; `apps/web/src/features/pages/subject.tsx:118`; `apps/web/src/sitemap/robots.ts:15` | Fix 308 versus public 301, cookie-dependent SSR, blanket no-store, absent document ETags, hardcoded JSON-LD origin and request-origin fallback. |
| Pending, error and not-found defaults | met | `apps/web/src/router.tsx:46`; `apps/web/src/routes/__root.tsx:42`; `apps/web/src/routes/search.tsx:54` | Defaults and route-specific errors are wired. This does not certify every upstream refusal maps to the required status. |

## Five gaps that most block launch

1. **Subject pages stop before the core community experience.** Replace the three permanent unavailable components
   (`apps/web/src/features/pages/overview.tsx:725`) with rating/content reads and rating/review/discussion actions;
   add continuation to the generic view route (`apps/web/src/routes/subjects/$id_.$view.tsx:76`). This is the smallest
   shared implementation that improves every vertical; retain the existing template mechanism.
2. **Public pages cannot yet be safely indexed and cached as specified.** Separate anonymous SSR from personal
   hydration, reconcile nonce CSP with anonymous caching, complete leaf pageHead/indexing and canonical subject routes,
   and register real sitemap feed adapters
   (`apps/web/src/server.ts:381`; `apps/web/src/sitemap/feeds.ts:12`). Finish the subject-feed owner contract before
   enabling export; then reuse the existing packing/workflow code rather than adding another exporter.
3. **The Library UI implements the previous model.** Replace fixed states with release-bound profiles, add independent
   labels, and make built-in dynamic Collections use the existing Collection surface; add paged ItemList export
   (`apps/web/src/library/entries-read.ts:14`; `docs/library-and-collections.md`, “Model”, “Consequences”). This needs
   coordinated owner API work, not another shelf-only component.
4. **Read admission uses the wrong identities.** Resolve account identity for signed-in admission and establish an
   anonymous session key at the Worker boundary; consume both bindings on the required read paths while leaving
   anonymous page rendering independent of session data (`apps/web/src/server.ts:228`, `:295`). Keep the existing
   10/60-second bindings and denial response.
5. **Several first-public destinations have no complete site journey.** Add minimal routed Zones/mounted Collections,
   notification inbox/preferences, and moderation resolution/appeals against their owners, then link them from the
   existing shell (`docs/scope.md`, “First public scope”; `apps/web/src/shell/shell.tsx:93`). Coordinate semantic
   contribution/editor and account profile controls with their owners; presentation curation is not a substitute.
