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

- a subject as its schema.org type (`Book`, `Movie`, `TVSeries`, `VideoGame`, `Recipe`, `MusicAlbum`,
  `CreativeWork` and so on, from the type's mapping), with name, alternate names, creators as `Person` or
  `Organization` linked to their agent URLs, dates, image, `sameAs` external identifiers, and editions or episodes
  where the type has them;
- `aggregateRating` only from the Global population of native votes and only above the display threshold, with
  `ratingCount`, `bestRating` and `worstRating`; imported source statistics never appear in it;
- a recipe's ingredients and steps as `recipeIngredient` and `recipeInstructions`;
- an agent as `Person` or `Organization` with `sameAs` links the agent published;
- `BreadcrumbList` for type and parent pages.

## Sitemaps

`/sitemap.xml` is one flat index of gzip sitemap files at the site root, `/sitemap-{type}-{digest}.xml.gz`;
`/robots.txt` names the index. Each file holds pages of one type: at most 3,000 pages with all their locale URLs
(24,000 URLs), and at most 40,000,000 bytes uncompressed, below the protocol's 50,000 URLs and 50 MB. A page's
locale URLs stay in one file.

Every locale URL is its own entry with `lastmod` and lists the same page in all eight locales, itself included,
with `xhtml:link`. `x-default` stays in page heads only. `changefreq` and `priority` are omitted.

Sitemaps are generated outside the request path once a day from paged keyset reads of indexable pages. The
server-to-server feeds may return up to 1,000 entries per page, above the usual list limit. The export reads each
feed to its end: only `next: null` ends a feed; a short or empty page does not. It writes changed files to object
storage under their content digest and replaces the index only after every feed and file succeeded. A failed
export leaves the previous index public. A request never starts a scan.

A page's `lastmod` is the last change of what the page shows, as its feed reports it. A file's `lastmod` in the
index is when that file last changed. Neither is the export time.

Sitemaps are an inventory as of the last successful export. A page that becomes `noindex`, closed or removed
answers its new status at once and leaves the sitemaps at the next export, within about a day.

The evidence is in [docs/research/sitemaps-at-scale.md](research/sitemaps-at-scale.md).

The public `GET /v1/subject-pages` feed accepts an optional opaque `cursor` and integer `limit` from 1 to 1,000
(default 20). The 1,000 maximum is an exception to the ordinary list maximum of 100 for server-to-server sitemap
reads. A page contains `subjectPages` entries with `id`, `lastModified` (UTC date-time) and public display `labels`
(`language` and `value`), plus `next` (an opaque cursor or null). The final cursor is a signed keyset token, never a
raw id. The feed has no session personalization and includes only visible, nonmerged, indexable subjects with a
public fact beyond the title; closed, removed, hidden and unreadable subjects are excluded. `lastModified` records
the last change to a shown fact. The semantic feed implementation is pending: valid requests currently return
`semantic_not_ready` (503), and the stub does not verify cursors.

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
