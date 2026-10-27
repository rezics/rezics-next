# Subject sitemap publication: research evidence

Research snapshot: 2026-10-27. This report supports the adopted
[SEO sitemap policy](../seo.md#sitemaps); it is not a mechanism specification or
an implementation completion claim. The existing HTTP and privacy contracts
remain authoritative.

## Finding and recommendation

The owning [SEO policy](../seo.md#sitemaps) adopts a bounded partition-local
candidate range, followed by current public-page disclosure, with separately
maintained **public publication metadata** for `lastModified`. Do not derive it
from the latest editorial revision, the newest surviving fact, a security
counter, a relay checkpoint or sitemap generation time.
This combines two implemented patterns: MediaWiki's fixed page-id ranges and
Wagtail's separation of published timestamps from draft revision timestamps.
It is an adaptation to REZICS, not a claim that either project implements its
partition, cursor or source-fence contracts. [M1][M2][W1][W2][W3]

Open Library demonstrates a second viable pattern: an offline, rebuildable
publication dataset divided into stable identifier buckets. Its complete dump
scan belongs to maintenance, not to a paged API request. Neither it nor MediaWiki
establishes the stronger lastmod semantics REZICS needs under private proposals
and fact-level moderation. Wagtail supplies useful publication metadata evidence,
but even it advances the timestamp on republishing unchanged content. [O1][W2]

The adopted SEO policy uses bounded direct candidate enumeration and publication
metadata. A separate full feed projection remains a possible implementation
choice if its backfill, all change paths and final suppression are specified.
None of the examined implementations licenses treating an eventually updated
sitemap as a privacy enforcement boundary.

## Scope, source provenance and licences

The following repositories were shallow-cloned with `git clone --depth 1` into
`/home/edge/projects/rezics/temp/subject-sitemap-publication-refs/<project>/`.
Only source inspection was performed: no dependencies, builds, tests, services
or reference repository programs were executed. The explicitly requested clone
directory was treated as an exception to the worktree-only writing instruction;
the report is the only changed tracked file in REZICS.

| Reference    | Inspected commit                           | Licence evidence and copying boundary                                                                                            |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Open Library | `37e446827465be2febad416de1bc18753b66997d` | [Root LICENSE][OL], GNU AGPL version 3 text. No code copied.                                                                     |
| MediaWiki    | `387d8ced27f16899afe674749f9890d14987e81d` | [Root COPYING][ML], GPL-2.0-or-later, with separately licensed components. No code copied.                                       |
| BookWyrm     | `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4` | [Root LICENSE.md][BL], Anti-Capitalist Software License 1.4; do not assume a permissive or OSI-approved licence. No code copied. |
| Wagtail      | `57f63027644fff99a1a2b4fb8116a80e851a84a6` | [Root LICENSE][WL], BSD-3-Clause. No code copied.                                                                                |

Source links below use these immutable commit ids. Source inspection establishes
implemented paths at those revisions, not deployment configuration or observed
production behaviour. Documentation was read from the primary publishers on
the snapshot date. Google's documentation states CC BY 4.0 for prose and
Apache-2.0 for samples; no samples are reproduced. The Sitemaps page was used
as a protocol reference, without assuming a code reuse licence. [G2]
Patterns may be followed freely; this task permits copying code only from MIT,
Apache-2.0 or BSD projects, with attribution. This report needs no copied code.

## Protocol and Google's actual guidance

The [Sitemaps protocol][S1] makes URL `lastmod` optional and defines it as the
linked page's modification date, not the generation date. Dates may use W3C
Datetime or a date alone. A sitemap is limited to 50,000 URLs and 50 MB
uncompressed; an index has its own limits. Index-entry `lastmod` describes the
corresponding sitemap file, not its listed pages. XML values require escaping
and the document requires UTF-8. A smaller kernel feed page is independent of
the final XML shard size.

[Google's current sitemap documentation][G1] recommends listing canonical URLs
intended for search. Google uses lastmod when it is consistently verifiable
against significant page changes, including main content, structured data and
links. A cosmetic copyright-date update does not qualify. `priority` and
`changefreq` are ignored.

[Google's lastmod explanation][G2] says the value helps schedule recrawls and
that fabricated freshness eventually loses credibility. It explicitly permits
omitting dates when the publisher cannot establish them. This is guidance,
not evidence that every CMS already implements accurate publication tracking.
This aligns with the adopted [SEO policy](../seo.md#sitemaps): unknown legacy
publication times are omitted until a proven meaningful public change supplies
one, and the web omits URL `lastmod` when the time is absent.

[Google's localization guidance][G3] requires a separate URL entry per localized
page and reciprocal alternates including itself. Alternate child links do not
count toward the URL limit. Label language is therefore not a list of available
page locales: a localized page can render a fallback label. The XML producer
still has to budget bytes as locale alternates enlarge each entry.

The protocol is not an access-control or deletion notification mechanism.
REZICS's established 404 and redirect behaviour remains necessary independently
of sitemap removal. Google's [HTTP guidance][G4] describes redirects and the
eventual removal of URLs returning 4xx; removing an entry is not an immediate
search-engine purge.

## Concrete catalogue evidence

### Open Library: offline current-record summary and stable buckets

The active script path is `scripts/sitemaps/sitemap.py`, invoked by
`scripts/oldump.sh` after the dump stage. Its `process_dump` reads TSV dump
records and admits only `/type/work` and `/type/author`. It builds the canonical
record path with a title/name slug and uses the dump's `last_modified` column.
There is no minimum-content test beyond record type: a title-only work is not
excluded by this function. [O1][O2]

`get_sort_key` divides the numeric identifier by 10,000. The summary is sorted
offline and `generate_sitemaps` groups it into gzip files by that bucket; the
index lists the generated files. This is implemented dataset preparation and
sharding, not an online keyset endpoint. The input scan and external sort are
whole-dataset maintenance. `generate_siteindex` uses generation time for the
sitemap-file timestamps, while URL entries preserve record modification time.
[O1]

Deletion and merges use record types outside the generator's allowlist.
`plugins/upstream/merge_authors.py:make_redirect_doc` builds `/type/redirect` records
with a `location`; `plugins/upstream/models.py:Changeset._get_doc` uses
`/type/delete` for a nonexistent prior version. Consequently, such current dump
records are omitted by the sitemap script. `plugins/upstream/code.py:get_document`
follows redirect records with a five-hop bound. This helper proves resolution,
not a particular public HTTP status. [O3][O4][O5]

There is also an older `openlibrary/data/sitemap.py` utility that groups a supplied
summary into 50,000-row chunks. It is distinct from the script selected by the
dump shell script; its existence is not proof of the current generation route.
The nginx configuration serves static sitemap files. These sources do not
establish synchronous invalidation of a published file on takedown. [O2][O6][O7]

**Timestamp limitation:** the generator trusts record metadata. It neither
compares public renderings nor checks private proposals, hidden individual facts
or technical-only record revisions. Reprocessing an unchanged dump preserves
each URL's timestamp, but that does not prove that an upstream record edit was
a significant public change. Do not infer REZICS-level moderation safety.

### MediaWiki: indexability metadata, bounded ranges and a broad touch clock

`includes/Page/SitemapGenerator.php:getXml` reads `page`, left-joins the
`page_props` row named `noindex`, and excludes matching rows. Namespace inclusion
also respects default and namespace robot policies. Redirect exclusion is
configurable through `skipRedirects`; it is not unconditional. [M1]

The property is persisted metadata: `includes/Deferred/LinksUpdate/PagePropsTable.php`
receives parser-output page properties and reconciles their stored values.
This avoids reparsing every page during sitemap generation. It is an established
projection pattern, but its update lifecycle and cache staleness matter. [M5]

Two different pagination paths must not be conflated:

- The REST `SitemapPageHandler` computes a fixed half-open page-id interval and
  calls `idRange(startId, endId)`. `SitemapHandlerBase` defaults to 10,000 pages
  per sitemap, adjusted for language variants. This bounds the identifier space
  inspected even across gaps and long noindex runs; the SQL still performs its
  noindex join and filters inside that interval. A range can produce empty XML.
  It is not literally a candidate CTE with LIMIT followed by application filters.
- The reusable generator's `limit()` adds a result limit after eligibility
  predicates, with one lookahead row and `nextBatch()` resumption by page id.
  Without an enclosing id range, a result limit alone does not establish a
  bound on rows inspected to find those results. The maintenance generator
  uses this batching facility. Do not copy that cost claim into REZICS.

These are actual implementations, not the XML examples returned by the REST
schema methods. The REST index computes the maximum page id and partitions
identifier space; this is not an offset through an eligible result list or a
signed continuation. The interval bounds the logical candidate domain, not a
measured guarantee about physical SQL reads or the optimizer's chosen plan;
REZICS still needs indexed-plan and growth checks. [M1][M2][M3][M4][M10]

`SitemapHandlerBase:execute` refuses sitemap access when everyone is not allowed
to read the site. This is a site-wide guard, not a per-page final authorization
check. Sitemap XML is cached by the page handler, with an expiry default of
3,600 seconds. These boundaries are weaker than REZICS's current final
disclosure requirement for arbitrary resource grants and source fences. [M2][M4]

**Timestamp limitation:** URL lastmod is `page_touched`. A content revision
updates it, but `WikiPage:doPurge` also calls `Title:invalidateCache`, which
advances it to a purge time or current time. Therefore an unchanged-content
purge can advance sitemap lastmod. `page_latest` and revision timestamps are
separate metadata; simply adopting MediaWiki's selected sitemap clock would
fail REZICS's background-reprocessing case. [M1][M6][M7][M9]

`DeletePage` removes the current `page` row after archival, so subsequent
uncached generation cannot select it. Redirect pages carry `page_is_redirect`,
which the generator can exclude. Cached XML can lag either change. These are
observations about enumeration, not a recommendation to expose MediaWiki's
deletion history or statuses through REZICS. [M1][M6][M8]

### BookWyrm: useful public-page evidence, no sitemap implementation found

A case-insensitive search of the inspected `bookwyrm/` tree found no sitemap
generator or `lastmod` implementation. It would be unsupported to describe
BookWyrm as evidence for a sitemap pagination algorithm at this commit.

Its book view does provide a useful separation: the HTML book lookup uses
`Edition.viewer_aware_objects`, raises 404 when no usable book/work exists,
resolves an absorbed book's old id, and obtains reviews through
`Review.privacy_filter`. `MergedBookDataModel` retains a deleted id for redirect
resolution. These are public page and merge behaviours, not a public publication
clock. The shared model's `updated_date` is `auto_now`, so it is a save clock
and cannot establish meaningful sitemap lastmod by itself. [B1][B2][B3]

### Wagtail: publication metadata separate from editorial revisions

Wagtail is a publishing system rather than a catalogue. It was added to answer
the timestamp question that the catalogue implementations leave unresolved.
`wagtail/contrib/sitemaps/sitemap_generator.py:items` selects `live().public()`
pages, including translated root trees when configured. `lastmod`, and the
page's own `get_sitemap_urls`, use `last_published_at`, falling back to
`latest_revision_created_at` only for legacy rows without the former. [W1][W3]

`PageQuerySet.live` requires `live=True`; `public` excludes restricted trees.
Its implementation gathers all `PageViewRestriction` rows to construct a
predicate. That global restriction enumeration and Django pagination are not
evidence of bounded partition-local cost. Translation prefetch is chunked,
but chunking output processing does not by itself bound database inspection.
[W1][W4]

`save_revision` creates or overwrites an editorial revision; the page-specific
implementation updates `latest_revision_created_at`. The publication
action separately assigns `last_published_at` and `live_revision` when the page
goes live. Scheduling a revision for an already-live object can return without
publishing it. Thus a new draft does not advance sitemap lastmod on a page
whose publication timestamp exists. [W2][W3][W5][W7]

Unpublishing sets `live=False` and clears the live revision; the sitemap's live
filter then excludes the page. Publishing a revision that removes previously
shown text advances publication time, rather than returning the date of an
older surviving field. This is the useful pattern for fact removals. [W2][W6]

**Limitations:** the publish action assigns now whenever it publishes a live
object, including republication without a meaningful content change. The
legacy fallback can also use an editorial timestamp. Wagtail does not prove
fact-level moderation or source-fence handling; REZICS must retain those
stronger conditions rather than copying the action wholesale. [W1][W2]

## Shared patterns and differences from REZICS

| Observed pattern                                                                          | Transferable lesson                                                          | Boundary REZICS must preserve                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Current-record/type filtering in Open Library; live/public and noindex metadata elsewhere | Enumerate publication state, not editorial activity                          | Title-only, hidden, removed, closed and merged-source subjects must be excluded by current public rules |
| Stable numeric buckets or fixed id ranges                                                 | Sparse output is acceptable; advance over candidate space                    | One source partition per range read, signed keyset cursor, no eligible-row OFFSET or hidden global scan |
| Persisted page properties and published timestamps                                        | Maintain small publication metadata instead of parsing all pages per request | Backfill and complete change coverage; metadata alone never authorizes disclosure                       |
| Record, touch and publication clocks differ                                               | Choose a clock with a demonstrated public meaning                            | Nonpublic proposals and unshown-fact moderation cannot signal freshness                                 |
| Regenerated or cached sitemap files                                                       | Discovery can be asynchronous                                                | Current final suppression must still win; cached candidates cannot reveal withdrawn data                |

REZICS evidence inspected at base `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`:

- [SEO](../seo.md#sitemaps) and [subject pages](../subject-pages.md) define
  indexing and anonymous page output. The feed is public
  `GET /v1/subject-pages`, with a signed keyset cursor, limit at most 1,000 and
  envelope `{subjectPages:[{id,labels:[{language,value}],lastModified?}],next}`.
  `lastModified` is optional under the adopted policy: unknown legacy original
  times are omitted until the next proven meaningful public change.
- [Semantic paging SQL](../../services/kernel/src/semantic/page-subjects.sql)
  already materializes a partition-local ordered subject range before label
  filling. It is a useful enumeration shape, not a ready-made public feed:
  it lacks the full indexability and publication-time contract.
- [Search source](../../services/kernel/src/semantic/search-source.ts) reads at
  most 256 specified ids per snapshot; its SQL reconstructs selected descriptive
  statements, suppresses hidden candidates and omits relation statements.
  It exposes no public publication timestamp. Neither a statement count from
  that port nor `securityRevision` proves that a page has a public non-title fact.
- [Semantic contracts](../../services/kernel/src/semantic/README.md) separate
  proposals, Global adoption, current selected candidates and relation projections.
  Relations are not subject to the 512 descriptive-fact cap. Do not scan all
  relations to decide whether any public fact exists.
- [Source fences](../../services/kernel/src/semantic/fences.ts) remove fenced
  candidate entries through provenance and tuple checks. Tuple homes can differ
  from subject homes; checks must use existing bounded owner reads, not a new
  cross-partition SQL join or a scan of all fences.
- [Eligibility](../../services/kernel/src/semantic/eligibility.ts) checks current
  subject visibility/security evidence. [Search disclosure contracts](../../services/kernel/src/search/README.md)
  require current checks before returning indexed results. A publication feed
  needs equivalent final exclusion, including grant closure, rather than merely
  trusting a stale search document or publication row.
- [Label selection](../../services/kernel/src/semantic/language.ts) preserves
  actual stored tags. Web must use public API data and its established locale
  rendering rules; it must not import kernel source to duplicate disclosure.

Unknown, hidden, removed and unreadable ids remain indistinguishable 404s.
The merged API response remains 308, followed by web's public 301. This report
does not reopen either contract or reinterpret platform-grant status handling.

## Adopted policy: publication semantics and bounded work

The owning [SEO policy](../seo.md#sitemaps) adopts these public semantics. This
section records their research basis; it does not specify an implementation.

**Eligibility.** Use the facts the anonymous public page can actually show,
after selection, moderation, source fences and access. A label/title alone
does not qualify. An unselected proposal, a private Context fact or a fenced
fact cannot make a subject indexable. If all non-title evidence disappears,
omit the subject even if stale metadata still marks it eligible. If other
public facts remain, retain it and reflect the removal in its publication time.
Keep merged source ids out; publish the survivor only when it qualifies.

**Time.** The policy uses the publication-clock pattern demonstrated by
Wagtail, with REZICS's stronger rule: advance only for a meaningful change to
the public page. Proposal, acceptance or moderation events are inputs to this
decision, not automatic bumps. Hiding an unshown candidate leaves the public
state unchanged. Hiding a shown fact, retracting it, changing Global selection,
or restoring it changes public state even when the next visible value is older.
Labels used by canonical URLs or rendered metadata also count as public changes.

While foreign-change relays converge, an uncertain candidate may be omitted and
a known time may lag. Finite convergence and the next completed repair pass
correct temporary omissions and times; every returned entry must still be
readable now. If a legacy row has no recoverable original public time, omit
`lastModified` until its next proven meaningful public change. See the adopted
[SEO policy](../seo.md#sitemaps) for these delivery rules.

For example: fact A was published at T10; at T20 it is removed and older B from
T5 remains. The page changed at T20. `MAX(timestamp of surviving facts)` would
report T5 and lose the removal. Conversely, proposing C at T30 without showing
it must leave T20 unchanged. This conclusion follows from the required public
semantics and the publication/draft separation, not from a claim that the
catalogues implement an identical fact model. [G1][W2]

Publication metadata can be small per-subject state; it need not be a second
copy of every rendered fact. Its maintenance must distinguish a public change
from relay replay, compaction, definition reprocessing and rebuilds. The cited
projects do not supply a ready-made comparison algorithm for this fact model;
this report does not prescribe a new hash, schema or event protocol.
Source-fence and related-label changes need explicit coverage when they alter
what the public page shows. A consumer processing time must not replace the
time the public change became effective.

**Labels and locales.** Return only current publicly disclosed labels with
their actual language tags, in deterministic order. Preserve the fixed API
shape. Web expands configured page locales and applies its existing fallback
rules consistently with page rendering; it must not treat the presence of a
stored translation as a requirement for a locale URL. Never fabricate label
translations or use request language/session state to vary the public feed.
Reciprocal alternates and configured public origin remain web responsibilities.

**Cost.** Prefer a subject-id candidate keyset in one partition, materialized
before expensive disclosure. A concrete initial budget to consider is `limit`
candidate subjects plus one key-only existence sentinel. Filter only those
candidate subjects; a short or empty result may carry a continuation. Resume
after the last processed candidate, preserving any unprocessed sentinel.
Do not keep scanning until `limit` eligible results have been found.
This is the candidate-window adaptation of MediaWiki's bounded identifier range,
also consistent with REZICS's existing filtered relation paging. [M1][M2]

An empty partition must complete its explicit source step without probing other
partitions to fill the response. A long run of noindex/title-only/closed subjects
must consume several bounded steps, not cause an unbounded filter before LIMIT.
Partition coordination must remain explicit at the owner boundary. Batch current
reads within their actual limits: the existing 256-id source limit does not
become 1,000 merely because the feed allows 1,000 output entries. Bound fact,
label, relation-evidence and source-tuple inspection too; a bounded subject count
alone cannot bound an unbounded relation neighbourhood.

A full publication projection could instead enumerate a prequalified ordered
range. That established metadata pattern trades read work for maintenance; it
still requires complete change coverage, restart/replay handling and final
suppression. The approved omission rule applies when original public-change
times cannot be recovered. The direct-read option still requires a bounded
inspected set and trustworthy publication metadata; neither option may hide a
whole-catalogue rebuild inside a feed request.

## Implementation details still requiring specification

These mechanism details remain to be specified; the adopted public and privacy
semantics are recorded in [SEO](../seo.md#sitemaps):

- Enumerate which already-rendered facts and views contribute to the shared
  subject timestamp, including relation previews, inverse facts, localized
  labels, covers and summaries. A single subject timestamp must represent that
  declared scope; it cannot silently mean only search's descriptive subset.
- Choose the metadata maintenance boundary and define effective-time handling
  for asynchronous visibility/fence changes, merge/unmerge and restoration.
  Reprocessing unchanged state must preserve the original public time.
- Identify available original-time history and the backfill completeness rule.
  If existing history cannot recover a public-change time, preserve the approved
  omission until the next proven meaningful public change.
- Specify the candidate and dependent-read budgets, continuation bindings and
  partition traversal using the already approved signed-cursor contract. A full
  projection additionally needs a readiness rule and final suppression even
  while its change consumer is behind.

## Suggested mechanism acceptance cases

These are proposed checks for the later mechanism, not evidence of implementation
completion. The `T` values below are effective public-change times. During relay
convergence, an uncertain candidate may be omitted and a known time may lag; the
values converge after finite relay convergence and the next completed repair
pass. Every returned entry remains readable now. Unknown legacy original times
remain omitted until a proven meaningful public change.

| Case                                                          | Required observation                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title only; title plus hidden/unselected/private-Context fact | Subject absent; no label or timestamp leaks from excluded entries                                                                                    |
| First shown non-title fact at T1                              | After convergence, subject is present with current public labels and `lastModified=T1`; uncertainty may temporarily omit it                          |
| New proposal at T2, no public selection change                | After convergence, entry and T1 remain unchanged                                                                                                     |
| Hide/take down/reject a never-shown candidate at T3           | After convergence, public entry and T1 remain unchanged despite security/editorial changes                                                           |
| Publish replacement at T4                                     | After convergence, current selected fact affects eligibility and `lastModified=T4`                                                                   |
| Remove shown A at T5, older B remains                         | After convergence, subject remains and `lastModified=T5`, not B's creation time                                                                      |
| Remove or fence the last shown non-title fact                 | Subject absent immediately at final disclosure, even with a stale positive publication row                                                           |
| Hide/remove/close subject after candidate collection          | Final output omits it, including its labels; point reads retain existing status semantics                                                            |
| Fence a source at a different tuple home                      | Bounded owner checks suppress its evidence without a cross-partition SQL join                                                                        |
| Restore a shown fact at T6                                    | After convergence, eligible again if public, with time reflecting the actual restored public change                                                  |
| Merge source into survivor; reverse merge                     | Source omitted while redirected; existing API 308/web 301 unchanged; reversal follows public eligibility and time policy                             |
| Replay, retry, rebuild, compaction, unchanged import          | Entry and public timestamp unchanged; no clock set to worker execution time                                                                          |
| Edit/remove public locale label                               | Labels and canonical slug agree with rendered fallback; significant public change advances publication time                                          |
| Multiple labels, missing requested-language label             | Deterministic stored tags; configured localized URLs use the same fallback as HTML and reciprocal alternates                                         |
| Empty partition                                               | Empty source result completes that partition step; no scan into another partition to find output                                                     |
| More than ten candidate windows of noindex entries            | Each request inspects at most its declared candidate budget, can return empty plus continuation, and eventually reaches a later eligible id          |
| Eligible sentinel after a fully processed window              | Cursor does not skip it; unchanged fixture traversal returns every eligible id once                                                                  |
| Partition move or cursor tampering                            | Existing signed binding and stale/moved handling apply; never resume against a different unchecked range                                             |
| Large descriptive history and arbitrarily many relations      | Fixed candidate/dependency inspection budget independent of history and relation count; an existence decision cannot scan the complete relation list |
| Projection bootstrap and lag, if selected                     | Preexisting eligible pages are backfilled; all change classes are covered; delayed projection never bypasses final suppression                       |
| XML generation repeated without page changes                  | Known URL lastmod stays stable and absent values are omitted; sitemap-file lastmod is separate; escaping and protocol limits are respected           |

## Primary source links

[S1]: https://www.sitemaps.org/protocol.html
[G1]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
[G2]: https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping
[G3]: https://developers.google.com/search/docs/specialty/international/localized-versions#sitemap
[G4]: https://developers.google.com/crawling/docs/troubleshooting/http-status-codes
[OL]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/LICENSE
[O1]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/sitemaps/sitemap.py
[O2]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/oldump.sh#L223-L234
[O3]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/upstream/merge_authors.py
[O4]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/upstream/models.py#L888-L898
[O5]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/plugins/upstream/code.py#L280-L292
[O6]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/data/sitemap.py
[O7]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/docker/web_nginx.conf#L332-L335
[ML]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/COPYING
[M1]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/SitemapGenerator.php
[M2]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Rest/Handler/SitemapPageHandler.php
[M3]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Rest/Handler/SitemapIndexHandler.php
[M4]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Rest/Handler/SitemapHandlerBase.php
[M5]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Deferred/LinksUpdate/PagePropsTable.php
[M6]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/WikiPage.php#L1219-L1239
[M7]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Title/Title.php#L3164-L3200
[M8]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/DeletePage.php#L563-L585
[M9]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/WikiPage.php#L1301-L1364
[M10]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/maintenance/generateSitemap.php
[BL]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/LICENSE.md
[B1]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/books/books.py#L30-L81
[B2]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/book.py#L198-L215
[B3]: https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/base_model.py#L30-L36
[WL]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/LICENSE
[W1]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/contrib/sitemaps/sitemap_generator.py
[W2]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/actions/publish_revision.py#L102-L184
[W3]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/models/pages.py
[W4]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/query.py#L314-L414
[W5]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/models/revisions.py#L384-L453
[W6]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/actions/unpublish.py#L46-L81
[W7]: https://github.com/wagtail/wagtail/blob/57f63027644fff99a1a2b4fb8116a80e851a84a6/wagtail/models/pages.py#L1080-L1118
