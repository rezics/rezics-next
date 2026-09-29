# URLs and search indexing

Settled research adoption, product manager under maintainer delegation,
2026-09-29. Identity must survive renaming; readable addresses must not reveal
material the anonymous viewer cannot see. These are target decisions; existing
[address operations](../../services/main/src/routes/addresses.ts) and
[public resource reads](../../services/main/src/routes/resources.ts) remain the
implementation owners.

## Durable addresses

Use `/{locale}/{type}/{sid}[-{slug}]`, leaving following segments for tabs and
actions. `sid` reversibly encodes all 128 UUID bits in a fixed, case-sensitive
22-character Base58 value with a frozen alphabet. Keep UUIDs and canonical entity
IRIs; do not allocate a second identity, truncate IDs or use a display suffix.
A reversible codec such as [short-uuid](https://github.com/oculus42/short-uuid)
avoids another registry; [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html)
also makes clear that UUIDv7 timing is not concealed by encoding.

Resolve the ID before the optional slug. Store approved slugs per language,
preserving native script, normalized Unicode and hyphenated spaces; romanization
is optional. A title or library update does not automatically rename published
URLs. Missing or stale slugs 301 directly to the current canonical address when
one exists; a canonical bare ID returns 200. Keep tab and meaningful
language/version selections, and preserve anchors where applicable. Normalize
host, HTTPS and trailing slash without redirect chains. Share copies the canonical
URL; a short link omits the slug.

Keep legacy UUID links and handle/wiki-title aliases, with durable rename
redirects and no automatic retired-name reuse. Merges redirect only to equivalent
successors. Confusable protection follows [UTS #39](https://unicode.org/reports/tr39/).
Missing/inaccessible, retired and failed reads retain distinct appropriate HTTP
outcomes; unavailable infrastructure must not become an indexable empty page.

[Google's URL guidance](https://developers.google.com/search/docs/crawling-indexing/url-structure)
supports audience-language words and correct percent-encoding; it does not show
romanized slugs rank above CJK. [Permanent redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects)
and canonical annotations are signals, not indexing guarantees.

## Language and anonymous representation

The path locale is interface language; `?language=` selects content through the
shared BCP 47 contract. Canonical public content is deterministic from the URL
and public policy, not private preferences. Main supplies eligible alternate
representations; use reciprocal, self-inclusive `hreflang` and a configured
`x-default` only where justified. Never manufacture eight translated bodies by
changing navigation. [Google's localized-page guidance](https://developers.google.com/search/docs/specialty/international/localized-versions)
allows localized templates but may consolidate untranslated main content.

Page, metadata, slug, share preview, JSON-LD and sitemap consume the same
general-eligible anonymous representation. Private, unassessed or adult material
cannot leak through a derivative. Policy changes invalidate hosted derivatives;
previously delivered independent copies cannot be recalled by assertion.

## Indexing and sitemaps

Search results, arbitrary facets, cursors, history/diffs, personal views and empty
shells default to `noindex` and stay out of sitemaps. Useful curated Concept/Zone
pages can qualify independently; no arbitrary word count excludes a useful short
catalogue record. Equivalent tracking/sort variants canonicalize together;
materially different filtered bodies do not. Let crawlers observe `noindex` before
blocking an infinite crawl space in robots rules. See Google's
[faceted-navigation](https://developers.google.com/crawling/docs/faceted-navigation)
and [noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)
guidance.

Build sitemap shards asynchronously from a checkpointed projection and serve
cached XML. Partition by type, locale and stable bucket; only eligible canonical
200 URLs enter it. Stay below 50,000 URLs and 50 MB uncompressed per shard;
`lastmod` records substantive change, not generation time. Update affected shards
on publication, rename and removal. An HTTP sitemap request never scans the
catalogue. These limits follow the [sitemap specification guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

## Structured data by meaning

Use stable entity `@id`, actual content language, visible eligible facts and
breadcrumbs from real navigation. [Schema.org](https://schema.org/docs/schemas.html)
supplies vocabulary, not a promise of rich results:

| Resource | Representation |
| --- | --- |
| Work | Book, VideoGame, TVSeries, Recipe, SoftwareApplication or CreativeWork as appropriate |
| Edition/release | Its concrete publication type and Work relation, with truthful version and coverage |
| Chapter/series | Chapter with its parent; BookSeries, TVSeries or CreativeWorkSeries |
| Person/organization | Person/Organization; ProfilePage only for an affiliated profile |
| Realm/Zone | CollectionPage; Organization only when true |
| Post/reply | DiscussionForumPosting/Comment |
| Concept/wiki/list | DefinedTerm; Article/WebPage with about; CollectionPage and ItemList |
| Skill/Prompt/MCP Work | CreativeWork, or a software subtype only when applicable |

[Profile](https://developers.google.com/search/docs/appearance/structured-data/profile-page)
and [forum](https://developers.google.com/search/docs/appearance/structured-data/discussion-forum)
guidance qualify those mappings. Never invent offers, reception or ratings, label
imported scores as native reviews, or mark a product release as an attendance
event for search features. Acceptance requires raw SSR HTML, actual HTTP
redirect/error status, CJK/RTL and non-UI languages, renamed links, withdrawal,
filtered pages and complete sitemap traversal. Search-engine selection still
needs observation after deployment.
