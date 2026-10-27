# Search engines and sharing

How public pages are found, understood and shared. This document is the authority for URLs, indexing, metadata,
structured data, sitemaps and HTTP status of public pages. Routing mechanics live in
[apps/web](../apps/web/README.md#routing); subject page content lives in [subject pages](subject-pages.md).

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

## Indexing

Indexed (no `robots` restriction, listed in sitemaps): subject pages and their views, agent pages, public boards,
threads, Realms and Spaces, and public collections.

`noindex, follow`: search and filtered listings, paginated pages beyond the first of a list, a subject that has
only a title and no other public fact, and every page of a Realm or Zone that is not public.

Not crawled (`robots.txt` disallow and `noindex`): account, settings, library, checkout and order pages, editors,
authentication pages, and API paths.

A Realm-routed or Zone-routed view of a subject that shows the same facts as the general page has its canonical
link on the general page.

## Metadata

Every indexed page sets, per locale:

- a unique `<title>` (subject: title, type and year, then the site name) and a `meta description` from the
  summary in that locale, at most about 160 characters, never a raw identifier;
- `<link rel="canonical">` to its own canonical URL;
- `<link rel="alternate" hreflang>` to the same page in every locale, plus `x-default`, reciprocal on every
  alternate;
- Open Graph and Twitter card tags: title, description, canonical URL, type, and the cover at a size suited to
  link previews, or a generated card with the cover placeholder when there is no image;
- `<html lang>` matching the URL's locale.

## Structured data

Each indexed page embeds one JSON-LD graph from the same data it renders:

- a subject as the explicitly selected Schema.org class for its concrete catalogue
  profile, with name, alternate names, creators as `Person` or `Organization`
  linked to their agent URLs, dates, image, `sameAs` external identifiers, and
  editions or episodes where the type has them;
- `aggregateRating` only from the Global population of native votes and only above the display threshold, with
  `ratingCount`, `bestRating` and `worstRating`; imported source statistics never appear in it;
- a recipe's ingredients and steps as `recipeIngredient` and `recipeInstructions`;
- an agent as `Person` or `Organization` with `sameAs` links the agent published;
- `BreadcrumbList` for type and parent pages.

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
A failed export leaves the previous index public. A request never starts a scan. Feed and export implementation,
including bounded-cost tests, remain required pending work.

A page's `lastmod` is its separate public publication metadata for the last meaningful change to what the page
shows. A page whose feed does not know its last change is listed without `lastmod`, and the export never fills
one in. A file's `lastmod` in the index is when that file last changed. Neither is the export time.

Sitemaps are an inventory as of the last successful export. A page that becomes `noindex`, closed or removed
answers its new status at once and leaves the sitemaps at the next export, within about a day.

The public `GET /v1/subject-pages` feed accepts an optional opaque `cursor` and integer `limit` from 1 to 1,000
(default 20). The 1,000 maximum is an exception to the ordinary list maximum of 100 for server-to-server sitemap
reads. A page contains `subjectPages` entries with `id`, current public display `labels` (`language` and `value`),
and an optional `lastModified` (UTC ISO 8601 date-time), plus `next` (an opaque cursor or null). Omit
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
implementation is pending: valid requests currently return `semantic_not_ready` (503), and the stub does not
verify cursors or establish indexability.

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

Indexed pages stream server-rendered HTML, send `Cache-Control` and an `ETag` for anonymous responses so the edge
can serve them, and keep Core Web Vitals in the good range on phones: the cover is the LCP image with
`fetchpriority="high"` and responsive `srcset`, layout is reserved by the cover frame, and personal controls never
shift content when they hydrate.
