# URLs and search indexing

Settled research adoption, product manager under maintainer delegation,
2026-09-29. Identity must survive renaming; readable addresses must not reveal
material the anonymous viewer cannot see. These are target decisions; existing
[address operations](../../services/main/src/routes/addresses.ts) and
[public resource reads](../../services/main/src/routes/resources.ts) remain the
implementation owners.

## Durable addresses

Maintainer and manager, 2026-10-03, revising the 2026-09-29 adoption: one
address model for every resource, with an opaque identity, optional aliases and a
canonical form that each alias scope tunes. Identity must survive renaming, and
a page must open whether or not anyone chose an alias for it.

| Layer | What it is | Set by | Used to resolve |
| --- | --- | --- | --- |
| `sid` | All 128 UUID bits as a fixed, case-sensitive 22-character Base58 value with a frozen alphabet | Main, at creation | Always |
| Alias | A unique key a person chose within a scope: an Agent or Space handle, a Work address, a Zone route title | Holder or editors; optional | Yes |
| Readable suffix | Readable words from the name the page shows in its language | Derived when rendering | Never |

| Resource | Alias form | Identity form |
| --- | --- | --- |
| Agent (person or organization) | `/@{handle}` | `/a/{sid}[-{suffix}]` |
| Space as a community (Realm) | `/r/{handle}` | `/r/{sid}[-{suffix}]` |
| Space as a site (Zone) | `/z/{handle}` | `/z/{sid}[-{suffix}]` |
| Work | `/w/{address}` | `/w/{sid}[-{suffix}]` |
| Concept | none | `/concepts/{sid}[-{suffix}]` |
| Any other resource | none | `/e/{sid}[-{suffix}]`; a Work redirects to `/w/` |
| A Zone's detail route | `/z/{space}/{route}/{title}` on an alias-keyed route | `/z/{space}/{route}/{sid}[-{suffix}]` |

Every form sits under `/{locale}`; following segments are tabs and actions.
Keep UUIDs and canonical entity IRIs; the `sid` is an encoding, not a second
identity, and is never truncated. A reversible codec such as
[short-uuid](https://github.com/oculus42/short-uuid) avoids another registry.
Opaque, permanent identifiers that carry no meaning follow
[Cool URIs don't change](https://www.w3.org/Provider/Style/URI) and lesson 4 of
[McMurry et al. 2017](https://journals.plos.org/plosbiology/article?id=10.1371%2Fjournal.pbio.2001414);
a permanent ID beside changeable human names is how
[Matrix rooms](https://spec.matrix.org/v1.1/client-server-api/) (room ID,
aliases, one canonical alias) and the
[AT Protocol](https://atproto.com/specs/handle) (DID and handle) work.

**Canonical form, alias first by default.** Each alias scope declares a policy.
`alias` makes the current alias canonical when one exists and is the default for
Agents, Spaces and Works, because handles and titles are what people share and
type. `id` makes `{sid}-{suffix}` canonical, the pattern of Stack Overflow and
Reddit posts, for content whose titles are not unique or not chosen; a Zone
picks `alias` or `id` per detail route, so a franchise wiki can use titles as
Fandom and Wikipedia do. Resolution reads the `sid` or the alias and ignores the
readable suffix. Any other form (a bare or stale-suffix `sid`, an old alias, a UUID link)
answers one 301 to the canonical URL, which answers 200; a page without an alias
is complete at its identity form. Keep tab and meaningful language or version
selections, and preserve anchors where applicable. Normalize host, HTTPS and
trailing slash without redirect chains. Share copies the canonical URL; a short
link is the bare `sid` form.

**Aliases.** One registry and one resolver serve every scope; scopes differ only
in policy: character set, reserved words, cooldown and who may claim.
The registry stores one normalized key per alias; it does not retain a second
display spelling. A resource’s display name is independent of its aliases.

- Handles (Agents and Spaces) use ASCII letters, digits, `_` and `-`, 3–30
  characters, starting and ending with a letter or digit, compared without case
  as the [PRECIS username profile](https://www.rfc-editor.org/info/rfc8265/)
  recommends. Display names and readable suffixes already carry every script, and a handle
  is the namespace where impersonation pays. Single-script native handles may
  open later under the "Highly Restrictive" level of
  [UTS #39](https://unicode.org/reports/tr39/).
- Work addresses and Zone route titles accept any script, NFC-normalized, compared
  without case, with whitespace as `-`, and limited to the UTS #39 "Highly
  Restrictive" mixtures so that one title cannot impersonate another.
- No alias may decode as a valid `sid`, so each segment has one reading.
- A rename keeps the old alias as a permanent redirect to the same resource. A
  retired or replaced alias is never given to another holder: abandoned Twitter
  handles were reclaimed for malicious content and SEO
  ([Mariconti et al., WWW 2017](https://arxiv.org/abs/1702.04256)). Merges
  redirect only to equivalent successors.
- The same handle in the Agent and Space scopes may belong only to one
  controller, so `@kadokawa` and `/r/kadokawa` cannot be different parties;
  confusable skeletons are compared across both scopes.
- Later: an organization may prove a handle against a domain it controls, by
  the AT Protocol's bidirectional DNS or `/.well-known` binding.

**Readable suffixes are derived, not stored.** The suffix comes from the name an anonymous
reader of that locale sees ([language order](#language-and-anonymous-representation)),
NFC-normalized, keeping native script, with whitespace and punctuation collapsed
to `-` and cut at a word boundary near 60 characters. Because resolution never
reads it, a title change or a new translation moves the canonical URL with one
301. This replaces the 2026-09-29 store of approved per-language suffixes: it
needed an editorial workflow for a value that identifies nothing, and Stack
Overflow shows that derived suffixes with redirects suffice.

**Addresses never grant reading.** Private resources answer 404 to readers
Access does not admit, unless their Space shows a join request page
([Space visibility](../contracts/space.md#visibility-listing-and-history)).
Unlisted resources open for anyone with the link, carry `noindex`, stay out of
sitemaps, search, Discover and recommendations, and send
`Referrer-Policy: no-referrer`. Unlisted means hard to find, not secret
([Hartzog and Stutzman 2013](https://www.ssrn.com/abstract=1597745)): a UUIDv7
keeps about 74 random bits and reveals its creation time
([RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html)), below the 120 bits
the [W3C TAG](https://www.w3.org/2001/tag/doc/capability-urls/) asks of a
capability URL, and short tokens have been enumerated in practice
([Georgiev and Shmatikov 2016](https://arxiv.org/abs/1604.02734)). If link-only
access to private material is ever offered, it uses its own revocable, expiring
token of at least 120 random bits, never a `sid` or a short link. Address
resolution is rate limited per principal class. Missing or inaccessible,
retired and failed reads keep distinct appropriate HTTP outcomes; unavailable
infrastructure must not become an indexable empty page.

**Draft, not scheduled: hosts.** A site may later be served on its own host.
Subdomains would sit under a separate registrable domain listed in the
[Public Suffix List](https://publicsuffix.org/), as `github.io` is, so that one
site cannot read or set another's or the main site's cookies
([RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html)); custom domains would
follow. The `/z/` path form stays canonical until a host is bound, then
redirects to it.

[Google's URL guidance](https://developers.google.com/search/docs/crawling-indexing/url-structure)
supports audience-language words and correct percent-encoding; it does not show
romanized suffixes rank above CJK. [Permanent redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects)
and canonical annotations are signals, not indexing guarantees.

## Language and anonymous representation

The path locale is interface language; `?language=` selects content through the
shared BCP 47 contract. Canonical public content is deterministic from the URL
and public policy, not private preferences. Main supplies eligible alternate
representations; use reciprocal, self-inclusive `hreflang` and a configured
`x-default` only where justified. Never manufacture eight translated bodies by
changing navigation. [Google's localized-page guidance](https://developers.google.com/search/docs/specialty/international/localized-versions)
allows localized templates but may consolidate untranslated main content.

Page, metadata, readable suffix, share preview, JSON-LD and sitemap consume the same
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
