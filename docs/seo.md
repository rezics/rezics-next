# Search engines and sharing

How public pages are found, understood and shared. This document is the authority for URLs, indexing, metadata,
structured data, sitemaps and HTTP status of public pages. Routing mechanics live in
[apps/web](../apps/web/README.md#routing); subject page content lives in [subject pages](subject-pages.md).
The [public discovery research](research/web-seo-design.md) supplies evidence for the adopted boundaries here;
its checkout observations do not establish current native delivery.

## Principles

- **One URL per page and language.** Every public page has exactly one canonical URL per locale. Language is part
  of the URL; a cookie or `Accept-Language` may suggest a language, never decide what a URL returns.
- **Public pages render the same for every anonymous reader.** The server renders public content without reading
  the reader's session, so the HTML can be cached at the edge and crawlers see what readers see. Personal state
  (library status, own vote, reactions, settings) loads after hydration.
- **Status codes tell the truth.** Unknown, removed and not visible are one 404, moved is 301 to the new URL,
  closed behind a platform grant is not indexed. A page never answers 200 with an error inside.
- **Only pages worth finding are indexed.** Search results, filters, personal pages and thin pages are not.
- **Nothing hidden leaks through metadata.** Titles, descriptions, images, structured data and sitemaps carry only
  what the anonymous page shows.

## URLs

| Page          | Canonical path                                           | Notes                                                                                                                                                                      |
| ------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject       | `/{locale}/subjects/{id}/{slug}`                         | `{slug}` comes from the subject's display label in that locale; a request with a missing or outdated slug redirects 301 to the current one. The id alone decides the page. |
| Subject view  | `/{locale}/subjects/{id}/{slug}/{view}`                  | Views as in [subject pages](subject-pages.md#views).                                                                                                                       |
| Agent         | `/{locale}/@{handle}`                                    | A verified catalogue agent's subject URL redirects 301 here.                                                                                                               |
| Board, thread | `/{locale}/boards/{id}`, `/{locale}/threads/{id}/{slug}` |                                                                                                                                                                            |
| Realm, Space  | `/{locale}/realms/{id}`, `/{locale}/spaces/{address}`    |                                                                                                                                                                            |

`{locale}` is one of the site's locales (`en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `de`, `fr`, `es`). `/` without a
locale picks one from the preference cookie or `Accept-Language` and redirects 302 to it; it is the `x-default`.
Paths are lowercase except ids and handles; trailing slashes redirect to the form without one.

The public origin comes from configuration, never from the request's `Host` header.

Canonical heads, reciprocal locale alternates, visible navigation and sitemap families use the same current
identity and locale mapping. A feed's id and labels alone do not establish every eligible subject view or an
agent's current handle. The canonical subject reader owns merge, alias and original-language fallback resolution;
SEO consumers must not infer missing identity fields or create another resolver.

Former-handle forwarding is mutable current resolution: it uses `private, no-store`, including missing/private
outcomes, and rechecks the active destination and forwarding expiry through the account owner. It is separate
from cacheable canonical public profile HTML. See [accounts](accounts.md) for handle lifecycle and discovery.

## Indexing

Indexed (no `robots` restriction, listed in sitemaps): subject pages and their views, agent pages, public boards,
threads, Realms and Spaces, and public collections.

`noindex, follow`: search and filtered listings, paginated pages beyond the first of a list, a subject that has
only a title and no other public fact, and every page of a Realm or Zone that is not public.

Not crawled (`robots.txt` disallow and `noindex`): account, settings, library, checkout and order pages, editors,
authentication pages, and API paths.
A signed-in or offer page whose path shares a prefix with indexed pages, or that is readable signed out, gets
`noindex` without a robots.txt disallow.

A Realm-routed or Zone-routed view of a subject that shows the same facts as the general page has its canonical
link on the general page.

## Collection rendering and sharing

Collection HTML first reads the current native header and members anonymously, including when the request
carries a session. Authorized private navigation and curator controls load through private/no-store server
functions after hydration. Signed-in public browsing uses the anonymous membership and facet population;
private rules, totals, hidden members and session credentials never enter public HTML or its dehydrated data.
Native complete published output remains the authority for dynamic Collections, including complete A while B
is pending. Web neither evaluates private predicates for publication nor creates a source cache.

Only an explicitly disclosed public, ready first page without active or ignored filters permits public HTML
caching. Unlisted/private, filtered, later, preparing and error results are noindex and private/no-store.
Concealed public 404s retain that status and no metadata, while an authorized reader can recover private content
after hydration. Public HTML requires current disclosure before every reuse, including conditional requests.

A complete ItemList is emitted only for the first unfiltered fully completed public curated result with
`next: null`. Preview rows never stand in for a full count or export; unsafe or pending totals stay absent.
The current Collection feed's `lastModified` is its header update time and does not cover all shown member
changes. Omit Collection sitemap `lastmod` until the owner supplies meaningful public publication time.

## Metadata

Every indexed page sets, per locale:

- a unique `<title>` (subject: title, type and year, then the site name) and a `meta description` from the
  summary in that locale, at most about 160 characters, never a raw identifier;
  Decision: the title year is the same disclosed Gregorian structured date JSON-LD would publish, not a raw
  time string, Julian calendar, uncertain bound, timezone offset or unsupported precision;
- `<link rel="canonical">` to its own canonical URL;
- `<link rel="alternate" hreflang>` to the same page in every locale, plus `x-default`, reciprocal on every
  alternate;
- Open Graph and Twitter card tags: title, description, canonical URL, type, and the cover at a size suited to
  link previews, or a generated card with the cover placeholder when there is no image;
- `<html lang>` matching the URL's locale.

Subject sharing keeps the largest supplied anonymous-readable cover variant, its actual aspect ratio and the
page's localized title as its text alternative. The existing Subject head still uses the static 1200 × 630
`/cards/default.png` (“REZICS”) for withheld, withdrawn and missing covers. It remains the fallback for integrations
without a current anonymous page projection; a caller's title or slug never qualifies that integration.

### Generated placeholder cards

`/{locale}/cards/{subjectId}.png` accepts GET and HEAD for the eight site locales and a subject UUID. It reads the
actual anonymous `pages.read` overview once through `loadSubjectPage`; `readShareCardPage` projects only the planned
subject's current display label, id, type and public cover summary. It uses the page's existing localized/original
language fallback, with no canonical resolver, session, Realm, account lookup or per-row read. The URL carries no
title, slug or asset URL. Query text, cookies, Authorization and conditional headers never enter the native read.

Missing, denied and withdrawn pages, including concealed embedded subject reads, answer the same generic 404.
An unavailable native source, incomplete planned read, unbound alias/account redirect, missing `KERNEL_ORIGIN`,
renderer failure or absent projection answers genuine 503. No development fake fills a missing binding. Both
statuses omit page text. HEAD rechecks the same current disclosure without rasterizing or returning a body.

All card responses use `private, no-store`, without ETags, Last-Modified, 304, stale responses or retained title/PNG
caches. This is the conservative card application of [public withdrawal policy](#public-html-cache): every request
rechecks current anonymous eligibility. Immutable font/WASM modules alone may be retained. An older publicly cached
response elsewhere cannot be purged by this policy; a sharing service's independent captured preview is not a live
authorization decision.

The Worker renderer uses [Satori's standalone entry](https://github.com/vercel/satori#runtime-and-wasm) for SVG and
[`@resvg/resvg-wasm`](https://github.com/thx/resvg-js#webassembly) for PNG, with compiled local WASM modules.
The published entry code was inspected: Satori 0.32.0 accepts the supplied `yoga.wasm` module; resvg 2.6.2 exports
`index_bg.wasm`, requires `initWasm` once and exposes `free` on both raster objects. Satori 0.32.0 is pinned because
newer releases' standalone entry also starts HarfBuzz through dynamic WASM loading; adopting those needs an upstream
compiled-module binding. No Node-native addon, browser rasterizer, remote font, arbitrary image fetch or new service
is used. Bundled Source Serif 4 WOFF title faces match `Cover`; local Noto Serif SC/TC/JP/KR WOFF subsets supply CJK
fallbacks selected by current title script and locale. No system font or network glyph fallback is used.

The shared `ShareCardView` adapts `Cover`'s id-derived colour and light serif title, inset and ruled footer to
1200 × 630. Titles are bounded to 240 Unicode code points (including any ellipsis), after a 1,024-code-unit input
slice, and use at most four lines; unbroken words reduce the type size. The renderer admits at most six font inputs
and 16 MiB of font bytes, one fixed raster and at most 4 MiB of PNG output. Raster allocations are freed after copying
the result. It never enumerates relations, reads creator labels or fetches cover bytes.

Search owns the Subject head and its title/description formula. At its next safe current-page source boundary it may
consume `projectShareCardPage(loaded, {id, locale})`, then pass `shareCardImage(projection)` from
[`shell/share-card.ts`](../apps/web/src/shell/share-card.ts) to the existing `pageHead` image option. The helper takes
an optional `ShareCardProjection`, preserves a genuine public cover first, selects the generated URL only for a
`ready` current anonymous page, and otherwise returns the static REZICS card. It fetches nothing and introduces no
second Subject head renderer. Other public page kinds keep their existing genuine covers/static fallback until
their owners bind their real current anonymous projection.

The focused `apps/web/tests/share-card.test.ts` cases cover real PNG dimensions, fixed page-read count, current rename,
withdrawal/denial, conditional requests, unavailable boundaries and optional head selection. The shared preview is
`patterns-media-share-card--current`, using the existing PatternStory and width, locale and theme globals. These are
source fixtures: native authorization, physical cost, Worker build/deployment, browser rendering and visual approval
remain deferred until integration. Neither a static fallback nor source typing establishes those proofs.

## Structured data

The home page's `WebSite` carries a `SearchAction` with a target URL template and a `query-input` that names its placeholder.

Each indexed page embeds one JSON-LD graph from the same data it renders:

- a subject as the explicitly selected Schema.org class for its concrete catalogue
  profile, with name, alternate names, creators as `Person` or `Organization`
  linked to their agent URLs, dates, image, `sameAs` external identifiers, and
  editions or episodes where the type has them;
- `aggregateRating` only from the Global population of native votes and only above the display threshold, with
  `ratingCount`, `bestRating` and `worstRating`; imported source statistics never appear in it;
- a recipe's ingredients and steps as `recipeIngredient` and `recipeInstructions`;
  Decision: Recipe and software-release overviews publish the current anonymous cook-time, diet, ingredient,
  instruction, platform, date and language statements; JSON-LD matches that projection, `recipeIngredient` is
  Schema.org Text, and released work form is `additionalType` rather than an identifier. Book overviews keep
  the literary reader for author, form, tag and word count. Anonymous Game overviews project admitted work facts
  from the current page so first HTML matches JSON-LD; edition windows stay a later continuation.
  SoftwareApplication identity links overlay the generic template. Focused tests pin overlay HTML and JSON-LD
  and do not replace the composed native publication driver. Locale switches use document navigation through
  the production rewrite so
  canonical heads match the URL. Title years use the same disclosed Gregorian structured date JSON-LD would
  publish. CreativeWork is a released ancestry base, not a bundled type in catalogue page definitions.
  Decision: route `pages:read` uses the same current catalogue release as subject pages so home TypeList
  selectors are admitted; an empty catalogue cannot invent public types. Focused overlay HTML/JSON-LD tests
  pin served facts; the composed native publication driver remains the acceptance suite. Recorded Book pages
  keep creator return origins in HTML and edition identity in JSON-LD; HTML edition rows stay on the literary
  stream once native link assertions are present.
- an agent as `Person` or `Organization` with `sameAs` links the agent published;
- `BreadcrumbList` for type and parent pages.

Creator links, images, external identity links and edition relations require the corresponding actual public
page projection. An external identifier is not automatically a `sameAs` link. A supported Schema.org class does
not grant access to its properties or establish a rich result. Metadata and media withdrawal follow the same
current disclosure boundary as visible content.

A Collection `ItemList` may describe the complete current anonymously disclosed first page only when that page
proves the whole exportable list, with no continuation or active filter. A preview must not claim a full list or
an undisclosed total. Ordered entries have explicit positions. Collection SSR owns its public read mode, filtered
and unlisted head policy, and post-hydration curator state under
[Collection presentation](collection-presentation.md) and [library and Collections](library-and-collections.md).

The 24 concrete profile mappings and the explicit `schema_org_type` annotation
rule are authoritative in the [definitions README](../packages/definitions/README.md#schemaorg-subject-types), with
[research evidence](research/catalogue-schema-org-mapping.md). The optional
`schemaOrgType` release field supplies a full Schema.org IRI. The web consumer
resolves `@type` from `schemaOrgType`, then its existing `schema:` mapping, then
`Thing`. Do not infer a class from a profile name, exact mapping, ancestor or
equivalence claim. This selection leaves native identity, exact mappings and
property semantics unchanged.

## Sitemaps

`/sitemap.xml` is one flat index of gzip sitemap files at the site root, `/sitemap-{type}-{digest}.xml.gz`;
`/robots.txt` names the index. Each file holds pages of one type: at most 3,000 pages with all their locale URLs
(24,000 URLs), and at most 40,000,000 bytes uncompressed, below the protocol's 50,000 URLs and 50 MB. A page's
locale URLs stay in one file.

Every locale URL is its own entry, with URL-level `lastmod` when known, and lists the same page in all eight
locales, itself included, with `xhtml:link`. `x-default` stays in page heads only. `changefreq` and `priority` are
omitted.

The sitemap export runs outside the request path once a day from paged keyset reads of indexable pages. The
server-to-server feed may return up to 1,000 entries per page, above the usual list limit. The export reads each
feed to its end: only `next: null` ends a feed; a short or empty page may still carry `next`. It writes changed
files to object storage under their content digest and replaces the index only after every feed and file succeeds.
A failed export leaves the previous index public. A request never starts a scan.

The export detects a stalled feed by item order, not by cursor tokens.

A page's `lastmod` is its separate public publication metadata for the last meaningful change to what the page
shows. A page whose feed does not know its last change is listed without `lastmod`, and the export never fills
one in. A file's `lastmod` in the index is when that file last changed. Neither is the export time.

Sitemaps are an inventory as of the last successful export. A page that becomes `noindex`, closed or removed
answers its new status at once and leaves the sitemaps at the next export, within about a day.
This inventory is not an ACL: an old shard or a failed export never authorizes an old profile, private member,
withdrawn fact or media response. Retaining immutable historical shards is a separate artifact policy.

The public `GET /v1/subject-pages` feed accepts an optional opaque `cursor` and integer `limit` from 1 to 1,000
(default 20). The 1,000 maximum is an exception to the ordinary list maximum of 100 for server-to-server sitemap
reads. A page contains `subjectPages` entries with `id`, current public display `labels` (`language` and `value`),
optional `originalLanguage` and `lastModified` (UTC ISO 8601 date-time), plus `next` (an opaque cursor or null).
The delivered native producer also supplies `target` (`subject` with `subjectId`, or `account` with `accountId` and
current `canonicalPath`) and offered `views`. These remain optional in the compatibility wire schema; nonempty Web
projection requires valid owner targets and views. Labels alone never establish a page or view family. Omit
`lastModified` when unknown; never return it as `null` or guess the current time. Web omits XML `lastmod` when the
time is absent. The final cursor is a signed keyset token, never a raw id.

Read at most `limit` candidate subject keys and one key-only lookahead from a single source partition, then apply
the existing bounded batch owner reads to those candidates. Continue after the last examined candidate; the
lookahead is not consumed. Short or empty pages may carry `next` and make valid progress through runs of
nonqualifying candidates. Never scan until `limit` eligible pages are found or cross into another partition to fill
a response; partition coordination stays explicit.

The feed has no session personalization. Return only readable, visible, nonmerged subjects in the Global Context
with a currently shown public fact beyond the title; closed, removed, hidden and title-only subjects are excluded.
Title-only pages are `noindex`.
Every returned subject must be readable now. Final current anonymous disclosure overrides candidate and publication
metadata, including when all non-title evidence has become fenced while candidate metadata is stale. A candidate
whose listability is uncertain may be temporarily omitted. Select only the current public display-label set with
its actual language tags. Stored label languages do not set the configured site-locale URL list; the web uses its
consistent locale fallback and alternate rules. Never fabricate labels.

`lastModified` is separate public publication metadata for a meaningful change to what the anonymous page shows,
not an editorial revision, latest surviving fact timestamp, private or security activity, processing or rebuild
time, or compaction time. A shown selected-fact change or removal, restoration, public label change, or source-fence
or related-label change advances it when the rendered page changes; an unshown proposal does not. For example,
removing a shown fact at T20 records that public change even if an older fact remains, while a proposal at T30 that
is not shown does not advance the time. A legacy row with no recoverable original public time omits `lastModified`
until its next proven meaningful public change. Known times may lag while foreign-change relays catch up. Finite
relay convergence and the next completed repair pass correct temporary omissions and times; freshness never uses
processing or rebuild time.

Unknown, hidden, removed and unreadable ids remain indistinguishable 404s. A merged-source API response remains
308, followed by the web's public 301. See the [publication research](research/subject-sitemap-publication.md) for
evidence and [sitemap scale research](research/sitemaps-at-scale.md) for export constraints. The semantic feed
source and default Web canonical projection are delivered; source registration and local typing do not establish
the original native publication, lifecycle, growth or whole-feed acceptance.

## Status and change

- A merged subject read returns 308 with `redirect.to`; web follows it once and answers 301 to the survivor's URL.
  An unmerged subject returns to 200.
- A subject, thread or agent removed by takedown or erasure answers 404 exactly as an unknown or unreadable id
  does, so a response never reveals that something existed; the removal reaches search engines through the 404 and
  its absence from sitemaps.
- A page closed behind a platform grant answers 403 to readers without the grant and carries `noindex`.
- Changes to indexed pages may be announced through IndexNow; this is optional and never required for
  correctness.

## Performance

Indexed pages stream server-rendered HTML and keep Core Web Vitals in the good range on phones: the cover is the LCP image with
`fetchpriority="high"` and responsive `srcset`, layout is reserved by the cover frame, and personal controls never
shift content when they hydrate.

## Public HTML cache

Immediate current disclosure takes precedence over ordinary public freshness after hide, erasure, revocation,
grant closure and private transitions. TTL is retention, never authorization. Mutable public HTML runs the existing
anonymous public renderer and its authoritative owner reads once on every request, before any stored body or 304
can be reused. There is no delivered owner-native currentness fence covering all rendered dependencies, so there
is no warm-cache path that skips those reads. A cached public status, title, copied proof or request header cannot
supply current authority.

Only genuinely anonymous, publicly disclosed HTML from an opted-in public route can receive
`Cache-Control: public, max-age=0, s-maxage=0, must-revalidate` and the public weak ETag. Independent HTTP caches
must revalidate every reuse and cannot serve stale payload on an origin failure. Route opt-in and an HTML 200 or
404 are necessary mechanics, not permission to override the current native result. Native `private`, `no-store`
or revalidation directives, `Set-Cookie`, `Vary: *` and router failures exclude promotion. A private or unknown
Collection's concealed 404 remains private/no-store. Current subject/profile failures also remain private/no-store.
A previously stored positive or negative response never overrides a current withdrawal or restoration.

Cookie or Authorization requests bypass shared lookup, storage and public conditional responses and receive
private/no-store headers. Public SSR still uses anonymous data; credentials do not permit personal data in its
HTML, query dehydration, head or ETag. Session, cookie, credential and CSRF reads are forbidden during public
rendering, including when a route catches the read error. Personal data stays in browser queries after hydration
or in private routes and server functions.
Locale middleware may emit `Vary: Cookie, Accept-Language` even for a locale URL. The anonymous cache key has no
credentials and is reused only for requests with neither Cookie nor Authorization; those Vary fields do not
alone make that anonymous representation personal.

Preparing, unavailable, error and closed fallbacks retain their native status, private/no-store and noindex;
they must not become cacheable successful HTML. A router error or pending fallback that would otherwise be 200
gets a failure status; platform closure is 403. Source owners supply truthful native preparation/unavailability
outcomes. These current results are classified before shared lookup or validator calculation. An uncaught current
read/render error propagates rather than falling back to a stored page. Cache API outages use the current render.

ETags cover the URL, build, current dehydrated data, response status and complete nonce-normalized rendered HTML.
This prevents unchanged titles or omitted loader fields from validating an earlier document or dependency. A
matching public 200 can answer 304 only after current rendering; a current 404 retains its status even with
`If-None-Match: *`. A 304 carries current cache/variant headers and no body or CSP nonce. Stored bodies are reused
only when status and the complete current representation's ETag match, and always with current response headers.
Stored HTML has a nonce placeholder; every served body gets a fresh nonce in CSP, marked attributes and the nonce
meta element.

The Workers Cache API may retain those bodies internally for 60 seconds. Its positive retention header is never
sent to HTTP clients. That retention neither establishes current disclosure nor eliminates a request's normal
render. The mechanism adds no owner reads, per-row probes, duplicate render or identity verifier; existing
composition limits of 16 reads/128 cost and subject-read bounds remain unchanged. Normalizing and hashing HTML
requires work and buffering proportional to that rendered page's bytes.

A future optimization that skips current rendering requires a real source-owner currentness provider bound to
**all** rendered dependencies, including nested documents, metadata and disclosure reductions. It must use a small
server-owned typed adapter with a safe fresh-render default; request-supplied authority, fabricated epochs and
guessed backend exports are not bindings. No such provider is currently installed. Content, Subject, Accounts
and Collection owners retain disclosure/currentness and publication authority. Web introduces no metadata or
custody engine, publication table, purge service or native erasure acknowledgement.

Mutable aliases continue to resolve afresh with private/no-store. Digest-addressed immutable assets and retained
immutable sitemap shards keep their existing separate cache policies; sitemap discovery/export cannot authorize
live HTML disclosure. This policy does not purge public responses already held by clients under an older policy.

## Producer and consumer boundaries

| Join                                      | Owner and remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject publication and eligible families | [Subject pages](subject-pages.md) and the [semantic publication design](../services/kernel/src/semantic/subject-pages-design.md) own positive public evidence, meaningful-change clocks and bounded repair. The canonical reader and family workers own view/profile families, sparse-language agreement and verified agent destinations. Registration or a proposed record is not native delivery.                                                                                                                                                                    |
| Collection source and export              | [Collection source](collection-source.md), [dynamic Collections](dynamic-collections.md) and [Collection presentation](collection-presentation.md) own completed source generations, complete current dependency authorization and canonical export readiness. SSR consumes only delivered contracts; a public header or preview does not prove source completeness.                                                                                                                                                                                                   |
| Community families                        | Community owns each Realm's `canonicalDestination`: `{kind: 'space', spaceId, address}` for a carried Realm, otherwise `{kind: 'realm', realmId}`. The Realm feed owns carried families; the Space feed contains standalone Spaces only. Consumers retain native source ids, cursors and pages. Current head/newest-board clocks do not cover all shown changes; omit sitemap times until meaningful public-change coverage is supplied.                                                                                                                               |
| Metadata projections                      | Subject/profile metadata workers own typed creator, identity, image and edition joins through actual public projections. The current public Subject page adapter and generated placeholder route are source-delivered; optional Subject head integration and native/cost/visual proof remain. Other missing projections retain the static fallback. No native fields or permissions are invented to fill a missing producer. Question-management reads parse generated Client DTOs at a local web contract; Kernel SQL and command modules stay off the browser graph. |
| Withdrawal and restoration                | Web requires a current public render before mutable HTML/304 reuse; a source-owner fence that could safely skip it remains an outstanding binding. Mutable aliases resolve afresh. The daily offline exporter is discovery infrastructure, never live authorization.                                                                                                                                                                                                                                                                                                   |

Reuse the current keyset exporter, immutable shards and atomic index publication. A native feed that is preparing
or unavailable fails the export and preserves the previous inventory; it never becomes a successful empty feed.
The default Subject adapter binds delivered native targets/views to the canonical reader's label fallback and
locale/view path helpers, preserving raw ids, source order and native cursors even across empty continuation pages.
Community destination/standalone adapters are also bound. Missing or invalid required Subject targets/views refuse
replacement; ready empty pages and explicit empty view sets retain progress without inventing families.
Account overview and admitted posts/reviews/collections use the native current
Account path. Native reciprocal verification and the exact current handle claim establish that overview root;
the DTO declares no agents-feed ownership exclusion. The original native Account batch supplies current admitted
views; Semantic intersects them with offered templates, rereads Account identity/path/views and finishes its
original metadata guards afterward. Web validates those four wire names and consumes the intersection through
the same canonical helpers, without evaluating admission flags or hydrating identities or metadata per row.
Original meaningful times are reused when valid and otherwise omitted. This binding does not certify native,
whole-feed, privacy, cost, visual or promoted-main acceptance.
These boundaries adopt the research's owner-defined public set and separate export stage, consistent with its
[Open Library](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/sitemaps/sitemap.py),
[Discourse](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/sitemap.rb)
and [Wagtail](https://github.com/wagtail/wagtail/blob/adafbaf7570d028543aae02cd916aae8410603a7/wagtail/contrib/sitemaps/sitemap_generator.py)
references. Their export and publication clocks do not replace REZICS's native disclosure requirements.
