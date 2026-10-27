# Sitemaps for a large multilingual catalogue

Research date: 2026-10-27. This is evidence and a proposed design, not an amendment to
[the SEO requirements](../seo.md#sitemaps). Adoption belongs in that owning document.

**Recommendation:** build a complete export outside the request path, consuming each opaque feed to `next: null`.
Pack each page's eight locale URLs together, targeting 3,000 page families per shard, with an independent
40,000,000-byte uncompressed ceiling. Store immutable gzip shards in R2 and publish the root index only after
every feed and shard succeeds. Start a full export daily; serve previously completed files through the Worker.

## Scope, terminology and evidence

A **page family** means one indexable page before locale expansion, not an entire subject and all its views.
Each indexable subject view is another family. The calculations assume one feed item supplies one family and
the information needed to construct all eight canonical URLs. If a feed item expands to multiple views, count
those families separately. A family produces eight `<url>` records and 64 alternate links. Both interpretations
of “one million pages” are costed below.

Six reference repositories were shallow-cloned and read without installing, building or running their code.
To honor the instruction that all writes stay in this worktree, clones are in `.temp/sitemaps-refs/<project>/`,
rather than the requested shared `/home/edge/projects/rezics/temp/sitemaps-refs/`. No main-checkout file was
written. The pinned revisions and source paths below make the observations reproducible without those clones.
Repository contents were treated as untrusted reference material, not instructions.

Observations concern the pinned source, not an assurance that every public deployment runs that revision.
Absence claims are bounded to the searched repository and relevant generators, routes and templates. In particular,
neither multilingual labels nor an alternate JSON/RDF representation establishes a localized canonical URL.

## Protocol and search-engine requirements

| Question                  | Finding and primary source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File limits               | A sitemap has at most 50,000 top-level URL records and 50 MB uncompressed. The protocol defines that size as 52,428,800 bytes; measure serialized UTF-8 bytes, not characters or gzip size. An index also has at most 50,000 children and the same byte limit. [Sitemaps protocol](https://www.sitemaps.org/protocol.html#sitemapIndex).                                                                                                                                                                                                                                                                                                      |
| Compression               | Gzip is supported; compression does not relax the uncompressed limit. Bing also recommends gzip to reduce transfer. [Protocol](https://www.sitemaps.org/protocol.html#sitemapIndex), [Bing's current guidance](https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/).                                                                                                                                                                                                                                                                                                                     |
| Index nesting             | Google rejects an index pointing to itself or another index. Use a flat index of URL-set files. If necessary, submit separate root indexes independently, rather than nesting them. [Search Console error reference](https://support.google.com/webmasters/answer/7451001?hl=en#zippy=%2Cincorrect-sitemap-index-format-nested-sitemap-indexes).                                                                                                                                                                                                                                                                                              |
| Location                  | Use absolute canonical URLs. Google recommends root placement; an index references shards on the same site, in its directory or below, unless cross-site submission is configured. Root-level shard URLs avoid directory-scope questions for `/{locale}/...` pages. [Build a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [large sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps).                                                                                                                                                             |
| Locale accounting         | Each locale needs its own `<url><loc>`. Every such record lists every alternate, including itself, with the XHTML namespace. Alternate child elements do **not** count against the 50,000-URL limit, but their serialized bytes count against the size limit. Eight locales therefore mean eight counted URLs, not 64, per family. [Google localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions#sitemap).                                                                                                                                                                                 |
| Where alternates belong   | Google treats HTML, HTTP headers and sitemaps as equivalent ways to declare alternates; using all three adds maintenance work. REZICS already requires HTML heads and sitemaps, so generate both from the same locale URL mapping. [Google localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions).                                                                                                                                                                                                                                                                                         |
| Page `lastmod`            | Google uses consistently verifiable dates of significant changes to content, structured data or links; a copyright-date change does not qualify. This is an accurate content-change signal, not a build clock. The protocol permits a date without time; use a UTC timestamp where available. Neither engine specifies a millisecond-exact tolerance. [Google XML notes](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap#xml), [protocol](https://www.sitemaps.org/protocol.html#xmlTagDefinitions).                                                                                                       |
| File `lastmod`            | An index entry describes when the **shard file** changed, independently of its pages' timestamps. Google permits up to 500 index submissions per Search Console site. [Google index reference](https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps#sitemap-index-reference).                                                                                                                                                                                                                                                                                                                                  |
| Bing limits and dates     | Bing documents 50,000 URLs/50 MB and recommends refreshing at least daily. Its current guidance emphasizes truthful date-and-time values, explicitly warns against substituting generation time, and says it typically revisits sitemaps at least daily. This is crawler behavior, not a fetch-time guarantee. [Bing index coverage](https://blogs.bing.com/webmaster/2023/9/How-to-Use-the-new-Sitemap-Index-Coverage-to-Improve-Your-Site-s-Index-Coverage/), [Bing 2025 guidance](https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/).                                               |
| Cadence and unused fields | Google provides no mandatory regeneration interval. Update the inventory when content changes; daily is Bing's explicit recommendation. Google and current Bing guidance ignore `changefreq` and `priority`; omit both. Sitemaps aid discovery without guaranteeing indexing or a crawl schedule. [Google](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Bing on lastmod](https://blogs.bing.com/webmaster/2023/2/The-Importance-of-Setting-the-lastmod-Tag-in-Your-Sitemap/), [Bing 2025](https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/). |

The 40,000,000-byte recommendation is deliberately below both common interpretations of “50 MB.” It includes
the declaration, namespace attributes, closing tags, XML escaping and all alternates. Validate gzip by decompressed
size. Never infer validity from how small the compressed object happens to be.

## Established implementations

### MusicBrainz: daily inventory and hourly content-aware updates

The builder partitions by entity type and URL suffix/view. `Overall.pm::build_one_entity` initially groups numeric
IDs into 50,000-ID ranges, then coalesces sparse ranges when their actual counts fit. Additional paginated URLs
are split by count. These boundaries are possible because the process can query IDs directly.
`docker/musicbrainz-sitemaps/crontab` schedules the overall job daily and incremental work hourly. Both cron
scripts invoke `bin/rsync-sitemaps`; output is XML/gzip files in a sitemap directory, with an index, not XML rendered
on each crawler request. [Pinned sitemap implementation][mb-sitemap], [cron configuration][mb-cron].

`Incremental.pm::get_changed_documents` fetches JSON-LD, hashes its canonical representation, and updates
per-URL database `last_modified` only when that representation changes; replication metadata supplies the time,
with a database-time fallback. `Builder.pm::create_url_opts` emits known timestamps for eligible views.
The builder compares uncompressed file hashes and preserves the old shard modification time if unchanged.
This is stronger than using every database write as a page change, but JSON-LD is still a chosen content projection,
not proof that every visible HTML dependency is covered. The inspected serializer and HTML `Head.js` contain no
locale hreflang set. [Builder and incremental code][mb-sitemap], [HTML head][mb-head]. Licence: GPL-2.0-or-later.

### MediaWiki: distinguish the maintenance command from the current API

`maintenance/generateSitemap.php` is a batch command writing numbered files and an index to `--fspath`, with gzip
on by default and a default 50,000-URL limit. The command does not schedule itself. The current shared
`SitemapGenerator` reads pages in `page_id` order, resumes from the next ID, excludes the `noindex` page property,
and supports namespace selection and redirect skipping. It divides the page limit by the number of language
variants, since each variant gets a separate URL record. `lastmod` comes from `page_touched`, which can reflect
cache invalidation as well as revision changes; the index uses the generation timestamp. [Command][mw-command],
[shared generator][mw-generator], [page invalidation implementation][mw-page].

The newer REST implementation instead computes fixed ID ranges, defaulting to 10,000 URLs' worth of IDs per
shard, adjusted for variants. It generates XML on request from a replica, caches it in WANObjectCache, and sends
public expiry headers; the default expiry is one hour. No object-store export is involved in this route.
The XML contains variant URLs but no `xhtml:link` set. HTML head code emits hreflang for language-conversion
variants where applicable; interlanguage links are handled in the body. These are separate mechanisms, not a
general eight-locale catalogue scheme. [REST handlers][mw-rest], [HTML alternates][mw-head]. Licence: GPL-2.0-or-later.

### Wikidata: deployment evidence supports the REST pattern

[Wikidata's robots.txt](https://www.wikidata.org/robots.txt), fetched during this research, advertises
`https://www.wikidata.org/w/rest.php/site/v1/sitemap/0` and explicitly allows the sitemap API path.
The production configuration enables that API by default, except for private, closed and explicitly unindexed
wikis. The shared implementation above therefore provides the source-supported pattern for Wikidata: ID-range
shards, generated on demand, database reads plus cache, and `page_touched` dates. [Configuration][wm-config].

Direct requests to the advertised index and first shard returned HTTP 403 “Sitemap Restricted” to the research
client. Consequently, the exact deployed shard size and XML were **not** verified live; the defaults above are
source defaults, not measured production settings. The generator has no sitemap hreflang output, and these sources
do not establish eight distinct locale canonicals or a Wikidata-specific page-head hreflang policy.
Do not equate multilingual entity labels with eight independently indexed pages.

[Wikimedia's historical sitemap note](https://wikitech.wikimedia.org/wiki/Sitemaps) describes earlier cron-generated
files, periods of disuse, and a later manually uploaded experiment. It is historical evidence, not evidence that
Wikidata currently runs that file-export pipeline. Core code is GPL-2.0-or-later; no repository-wide licence was
found for the inspected production configuration, so treat it as reference-only.

### Open Library: dump-driven files with stable ID buckets

`scripts/sitemaps/sitemap.py` consumes a dump, keeps works and authors, carries the dump's record modification
timestamp into each URL, sorts a summary, and groups by type plus numeric ID divided by 10,000.
It writes gzip files and a gzip index to disk, using generation time for the index entries. The dump orchestration
invokes this script; the nginx installation script documents rsync of **monthly** sitemaps between hosts.
This establishes a dump/batch pipeline and documented monthly file distribution, not request-time generation.
[Generator][ol-generator], [dump job][ol-dump], [distribution note][ol-distribution].

The separate `openlibrary/data/sitemap.py` helper groups by 50,000 records; it should not be confused with the
10,000-ID-bucket script actually invoked by the inspected dump job. Neither XML template emits language
alternates. Searches of the application templates found no hreflang declaration; the head and view templates
instead support canonical links and alternate data representations. Record timestamps may miss changes in
related rendered data, so this timestamp strategy alone is insufficient for REZICS's rendered-content requirement.
[Other helper][ol-helper], [HTML shell][ol-head]. Licence: AGPL-3.0; no code copied.

### Discourse: database metadata and cached request-time shards

`Sitemap.regenerate_sitemaps` maintains enabled sitemap rows; an hourly job refreshes them. Ordinary shards use
page count, ascending topic IDs and SQL `LIMIT/OFFSET`, with a default page size of 10,000. A separate recent
shard selects activity from the last three days; a news route is separate again. XML is rendered on request and
cached through Rails.cache: ordinary shards for 24 hours, recent shards for one hour, news for five minutes.
The database stores sitemap metadata, not an object-store corpus. [Model][dc-model], [controller][dc-controller],
[schedule][dc-schedule], [default setting][dc-settings].

The ordinary XML template chooses `bumped_at || updated_at` for URL `lastmod`, while the index metadata uses the
maximum topic `updated_at`. This is an activity-oriented forum heuristic, not a generic semantic timestamp rule.
The sitemap template has no locale alternates. With content localization enabled and supported locales configured,
the crawler HTML head emits hreflang, including `x-default`. Thus the locale mechanism is in HTML, conditionally,
rather than repeated in the inspected sitemap. [XML templates][dc-views], [hreflang partial][dc-head].
Licence: GPL-2.0-or-later.

### Mastodon: no sitemap generator found

At the pinned revision, repository searches found no sitemap generator, route, scheduled sitemap job or sitemap
file. `public/robots.txt` advertises none. Therefore shard scheme, generation cadence, storage and sitemap
`lastmod` are **not applicable**; this is not an example of scaling sitemaps. The application layout and account/
status head templates do not declare locale hreflang sets. Their alternate RSS, ActivityPub and oEmbed links are
representation links, not language alternates. [Repository][ma-root], [robots][ma-robots], [account/status views][ma-views].
Licence: AGPL-3.0-or-later. The research requirement's Mastodon-or-Lemmy case is covered by this negative finding.

### Pinterest engineering and Shopify platform documentation

Pinterest's engineering write-up, [How we built our HTML sitemap](https://medium.com/@Pinterest_Engineering/how-we-built-our-html-sitemap-3120471b38ec)
(2014), describes hundreds of millions of pages partitioned first by content type, then username initial and
alphabetical ranges. Hadoop MapReduce sorts the data; reducers build bounded leaf pages and then parent pages
bottom-up, balancing underfilled tails. This is an offline batch approach. The article does not specify its
refresh interval or backing storage, and HTML navigation has no XML `lastmod` policy. It does not describe
hreflang. **Its nested HTML navigation is not a precedent for nested XML indexes.**

A later [Pinterest internationalization engineering article](https://medium.com/pinterest-engineering/how-switching-our-domain-structure-unlocked-international-growth-e00c8184d5dd)
(2018) explicitly describes page-markup hreflang and sitemaps for discovery across country domains. It does not
disclose XML sharding, job cadence, storage or timestamp maintenance. Those details remain unknown rather than
being inferred from its HTML sitemap article. These are primary engineering accounts from a large visual-media
platform, with no permissive code licence stated; they supply patterns only.

[Shopify's official sitemap documentation](https://help.shopify.com/en/manual/promoting-marketing/seo/find-site-map)
provides an additional commerce comparison: separate product, collection, blog and page sitemaps; automatic
updates as resources are added; sitemaps for international domains; and automatic inclusion of published languages.
It does not disclose the storage backend, count/range boundaries, internal scheduling or exact `lastmod` algorithm.
Language inclusion is documented, but that page alone does not establish every hreflang serialization detail.
No reusable code licence is stated.

## Shared patterns, differences and their causes

The catalogue examples generate from structured data, not by crawling their own rendered HTML. They divide
inventory by type and then use bounded numeric ranges or counts. Files, database metadata and caches all appear;
there is no single storage backend common to mature implementations. Modification signals generally originate
in the content system, while shard timestamps describe the generated artifact. MusicBrainz's hashing makes the
distinction especially explicit.

Stable ID ranges help incremental rebuilding when the generator can query arbitrary ranges. Dump consumers favor
offline files because a scan is already available. Discourse can accept request-time queries and cache expiry for
its forum workload; its OFFSET queries should not be copied into a multi-million-page remote keyset walk.
MediaWiki's current API can jump straight to an ID interval; REZICS's cursor contract cannot. Pinterest's
MapReduce partitioning solves parallel sorting with full data access, which web's seven paged APIs do not provide.

No inspected open-source generator implements the exact REZICS eight-by-eight alternate matrix. Several rely on
HTML or have no distinct localized canonical URLs. REZICS must implement its own expansion from its canonical
URL contract. Ordinary periodic inventory APIs also do not become change feeds merely because they include
`lastmod`; deletions and changes behind a cursor require another complete walk.

## Cloudflare capabilities and constraints

These are the published limits on the research date; paid-plan limits are relevant to the proposed generator.
Deployment should pin its plan and configuration rather than assume limits are permanent.

| Capability              | Documented behavior and implication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled work          | Cron Triggers call a `scheduled()` handler on UTC schedules. Use it to start/coalesce an export. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cron limits             | Paid cron CPU: 30 seconds for intervals under one hour; 15 minutes for intervals of at least one hour. Cron wall time: 15 minutes. Workers Free CPU: 10 ms. Network waiting is not CPU. A single daily cron invocation is not a durable home for a 50,000-request walk. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).                                                                                                                                                                                                                                                                                                                                                                      |
| Request/resource limits | Paid HTTP CPU defaults to 30 seconds and can be configured to five minutes. Memory is 128 MB; current paid subrequest default is 10,000; six outgoing connections can be establishing simultaneously. Stream and checkpoint bounded units. Request `waitUntil()` lasts only up to 30 seconds after response/disconnect. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).                                                                                                                                                                                                                                                                                                                      |
| Workflows               | Durable steps support retries and long elapsed execution. Paid steps have 30-second default CPU, configurable to five minutes; non-stream results are limited to 1 MiB, instance persisted state to 1 GB. Paid instances default to 10,000 steps, configurable to 25,000, and 10,000 subrequests, configurable higher. A page-per-step 50-million-family walk exceeds defaults: split instances or batch steps and store payloads in R2. [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/).                                                                                                                                                                                                |
| Queues                  | Queue messages are at most 128 KB. Consumers have 15 minutes wall time, 30 seconds default CPU configurable to five minutes. Delivery is at least once, with no ordering guarantee. Messages should carry work references, not XML; consumers must make retries idempotent. [Limits](https://developers.cloudflare.com/queues/platform/limits/), [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).                                                                                                                                                                                                                                                                           |
| R2 writes               | A Worker binding supports streamed `put`, object HTTP metadata and conditional operations. Successful object writes are strongly consistent. This supports writing children first and replacing one index object last, but is not a transaction spanning many objects. [Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/).                                                                                                                                                                                                                                                                              |
| KV                      | Ordinary Workers KV supports writes from Workers, but values are limited to 25 MiB and writes to one key to one per second. Its normal model is eventual consistency, with cached reads potentially stale for 60 seconds or more. Compressed shards might fit, but KV adds size and publication-consistency constraints. Choose R2 for artifacts and the authoritative index. [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/).                                                                                                                                                                                        |
| Gzip delivery           | R2 HTTP metadata can describe `contentType` and `contentEncoding`; `writeHttpMetadata` copies it to response headers. Workers supports gzip `CompressionStream`. For an already encoded HTTP response, `encodeBody: "manual"` prevents recompression. A `.xml.gz` file served as `application/gzip` instead represents a gzip **file**, without `Content-Encoding`. Keep these two delivery conventions distinct. [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [compression streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/#compression-streams), [Response](https://developers.cloudflare.com/workers/runtime-apis/response/#the-encodebody-option). |
| Caching                 | An R2 custom domain supports CDN caching and tiered cache; `r2.dev` is for development. A private binding does not automatically provide that public CDN path. The Worker's Cache API is local to each data center, and `cache.put` does not use tiered caching. Configure caching explicitly. [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).                                                                                                                                                                                                                                                                 |

## Choosing shard size with eight locales

Use two independent counters: top-level URL records and uncompressed serialized bytes. At most 6,250 complete
eight-URL families fit the protocol URL ceiling, but the byte ceiling often binds much earlier.

For an explicit estimate, use compact XML, UTC timestamps of 20 bytes, the eight locale codes from `docs/seo.md`,
and a mean escaped, absolute URL length `U` bytes. Assume each locale's mean URL length is the same. With links
serialized as `<xhtml:link rel="alternate" hreflang="en" href="URL"/>` and no per-entry whitespace:

```text
one locale record = <url> + <loc> + URL + </loc> + <lastmod> + timestamp + </lastmod>
                    + eight xhtml:link elements + </url>
                  = 479 + 9U bytes
one family        = 8 × (479 + 9U) = 3,832 + 72U bytes
```

At `U = 100`, this is 1,379 bytes per URL record and 11,032 bytes per family. A 50,000-record shard would be about
68.95 MB before its wrapper, exceeding the byte limit. At `U = 120`, a family is 12,472 bytes.
Thus a target of **3,000 families / 24,000 URL records** yields approximately 33.10 MB or 37.42 MB respectively.
The target is an operational choice with margin, not a new search-engine limit.

Close a shard before adding a family that would exceed 3,000 families **or 40,000,000 bytes including the XML
wrapper**. Use actual byte lengths after URI encoding and XML escaping. Long percent-encoded slugs can make
`U` much larger; then flush earlier. Keep a family together for reciprocity checks, although Google does not require
alternates to occupy the same shard. A family that cannot fit a valid file is an export error, not permission to
truncate URLs or omit alternates. Validate the protocol's URL-length constraint too.

Sitemap links should contain the eight locale alternates including self. Retain the SEO document's additional
`x-default` in HTML heads. The sitemap requirement specifies the eight locale alternates; it does not require
adding a ninth fallback link there. This choice avoids inventing per-page locale-neutral routes from the `/`
homepage redirect. Adding any future fallback must use a valid equivalent-page URL and enter the byte budget.

## Proposed REZICS generation and publication

1. **Start one daily full generation**, with an authenticated operational trigger for retries and urgent refreshes.
   Coalesce overlapping starts with one durable coordinator and an expiring run lease. Record start time, feed and
   generator versions, locale set, configured origin and per-feed status. Cron starts work and returns. Use Queues
   for bounded work and a Durable Object coordinator for durable progress; Workflows is a viable alternative if
   instance/step/subrequest limits are planned explicitly. These are proposed components, not existing contracts.

2. **Walk all seven feeds independently**, serially within each feed. Request 1,000 items. Persist each returned
   page and its exact `next` before advancing. An empty or short `items` array is not EOF: only `next === null`
   finishes a feed. Never decode a cursor, synthesize a boundary, seek to a guessed ID, or issue a request per
   locale. Parallelism is between independent feeds and later packing tasks, bounded by kernel capacity.

3. **Stage normalized family records in private R2 objects** under a run/feed/page sequence. Store the returned
   cursor, item count and checksum with each checkpoint. Queue messages carry only run/feed/sequence references.
   The coordinator accepts one result per expected sequence and advances once. Conditional first-write wins and
   reading an existing result on retry prevent duplicate delivery from replacing an already accepted page.
   Persist the next-work intent durably before acknowledgement; use coordinator recovery/alarm work to re-enqueue
   pending intents after a crash. Queue delivery alone is not an atomic checkpoint-and-enqueue transaction.
   [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) are also at least once;
   keep that recovery idempotent and have the scheduled watchdog detect exhausted alarm retries.

4. **Pack by feed type and emitted sequence**, consuming staged records in traversal order after that feed
   completes. Use ordinal shard numbers in the private manifest, not cursor-derived IDs. Fully rebuild each run;
   insertions/deletions may move later boundaries. Do not hash IDs into buckets requiring unbounded buffering or
   rescan each feed for every shard. Validate canonical origin, URL uniqueness, valid timestamps and eight reciprocal
   mappings. Missing/invalid required data fails the generation. Eligibility comes from the indexable feeds; no
   HTTP rendering request is needed for each page. External sorting/validation, if needed, must also be bounded.

5. **Serialize and gzip with bounded memory**, checking both ceilings before upload completion. Store shards by
   type plus the hash of their uncompressed canonical XML; keep a private generation manifest mapping sequence
   to object, counts, sizes and timestamps. Reuse identical existing artifacts and preserve their file modification
   date. This deduplicates unchanged shards without claiming incremental reads: the full feeds were still walked.
   Publish at same-origin root paths such as `/sitemap-subjects-{digest}.xml.gz`; R2's internal keys may be deeper.
   The Worker streams stored files. An ordinary sitemap request does not initiate a kernel scan.

6. **Serve gzip as gzip files** at those `.xml.gz` URLs with `Content-Type: application/gzip`, no `Content-Encoding`,
   a stable ETag and `Cache-Control: public, max-age=86400, immutable`. Serve `/sitemap.xml` as XML. If delivery is
   later changed to `.xml` with HTTP content coding, set `Content-Encoding: gzip`, use manual encoding and provide
   correct negotiation/identity behavior and `Vary: Accept-Encoding`. Use an explicitly configured Worker Cache API
   for the binding-based route; a dedicated R2 custom-domain origin plus `fetch` caching is an alternative when
   tiered caching is needed. Avoid caching private staging objects or setting session cookies on these responses.

7. **Publish one flat root index only after all seven walks and every shard validate.** Verify object existence,
   checksums, URL/byte counts, namespace declarations, completed-feed markers and the index's own limits. The
   coordinator fences stale publishers; conditional replacement of one authoritative R2 index object is the commit
   point. Keep the old index until then. Unchanged XML keeps its ETag. Use shard artifact-change time in index
   `lastmod`; page records retain kernel content-change time. `/robots.txt` names `/sitemap.xml`.

8. **Cache the index briefly**, for example five minutes with ETag revalidation, so publication has a bounded cache
   delay. Retain unreferenced complete shards for seven days after replacement, exceeding the configured cache
   lifetimes; keep manifests to identify all objects still referenced. Garbage-collect abandoned staging objects
   separately after the run is terminal. Cache invalidation must not be mistaken for durable storage deletion.

9. **Treat failures as incomplete exports.** Retry transient feed/R2 failures with exponential backoff and jitter,
   honoring `Retry-After`; resume only from an accepted checkpoint. Detect cursor repetition, malformed responses
   and sustained lack of progress; a watchdog aborts the run instead of treating a time budget as EOF. Expired or
   rejected cursors require restarting that feed from its beginning under a new attempt namespace. Never combine
   its old prefix with a restarted suffix. Exhausted retries leave the last complete generation public, record the
   failure and alert on age; a first-ever failed export returns a retryable service error, not a fake empty index.

`lastmod` must come from the kernel's last change to what the page shows, including relevant related facts,
locale labels, slug/canonical changes and public structured data. Do not substitute row-update time, export time,
cache fill time or the maximum timestamp encountered in the walk. If only a shared family timestamp exists, use
it for all locales; locale-specific timestamps are preferable only if the feed actually supplies them. Do not
fetch millions of HTML pages to recreate a timestamp the feed already promises.

The present feeds do not promise a consistent snapshot, cursor lifetime, changed-since reads or deletion events.
Consequently this proposal provides an inventory observed during a walk, **not a point-in-time database snapshot
or instantaneous removal guarantee**. Pages continue to enforce current visibility and 404/403 behavior immediately;
periodic exports remove stale entries on successful refresh. During an outage the prior export ages explicitly.
Adoption should document this freshness boundary alongside `docs/seo.md`'s exclusion requirement. If exclusions
must disappear from sitemap bytes immediately, the owning design additionally needs invalidation/tombstone input
and affected-shard rebuilding; the given APIs alone cannot supply that property. Do not silently add that feed.

At 50 million families, keep daily full walks as the initial feasible design, but measure runtime, feed load and
compression CPU before selecting the production window. Alert if completion falls behind the daily target; do not
overlap unlimited scans. A later incremental design needs a separately specified change stream with deletions and
a reconciliation full walk. Stable ID-range generation also needs a range-readable kernel contract. Neither can
be inferred from the existing opaque cursors.

## Cost per complete generation

These are estimates with explicit inputs, not measurements or upper bounds guaranteed by the feed contract.
Use decimal GB. Let `N` be families, `R` actual feed responses, `B` mean encoded JSON item bytes, `C` mean response
envelope/cursor bytes, `U` mean escaped URL bytes, `H` XML wrapper bytes per shard, `S` shard count, and `r` measured
gzip-size/uncompressed-size ratio:

```text
feed response bytes = N × B + R × C
uncompressed XML    = N × (3,832 + 72U) + S × H
gzip artifact bytes ≈ r × uncompressed XML
nominal shards      = sum over feed types of ceil(N_type / 3,000), before byte-driven splits
```

| One run, assuming N counts families                                               |  1,000,000 |    50,000,000 |
| --------------------------------------------------------------------------------- | ---------: | ------------: |
| Canonical locale URL records                                                      |  8,000,000 |   400,000,000 |
| Alternate-link elements                                                           | 64,000,000 | 3,200,000,000 |
| Ideal feed requests at 1,000 items, before rounding/empty/terminal/retry overhead |      1,000 |        50,000 |
| Example at 500 items per nonempty response                                        |      2,000 |       100,000 |
| Feed item bytes at assumed B = 1,500                                              |   1.500 GB |     75.000 GB |
| Envelope bytes at illustrative C = 300 and ideal R                                |  0.0003 GB |      0.015 GB |
| XML at U = 100, excluding wrappers/index                                          |  11.032 GB |    551.600 GB |
| Nominal shards at U = 100                                                         |    334–340 | 16,667–16,673 |
| Gzip at illustrative r = 0.10, excluding wrappers/index                           |  1.1032 GB |     55.160 GB |

The shard interval allows up to six extra tails from separating seven nonempty feed types. Larger URLs trigger
earlier byte splits: at `U = 200`, raw XML is 18.232 GB / 911.600 GB, and 3,000-family shards no longer fit the
40 MB target. Real gzip ratios must be sampled with representative identifiers and slugs; compression reduces
storage and crawler transfer but not the uncompressed protocol accounting or bytes processed by the serializer.

The ideal request counts assume full pages. Actual requests equal the sum of complete traversals, including
every empty response with a non-null cursor, optional separate terminal responses and retries. With mean nonempty
page occupancy `a`, budget approximately `N/a + E` plus per-feed rounding and retries, where `E` counts empty
responses. The contract provides **no finite request upper bound in N alone**. Request count and response bytes
must therefore be measured; an arbitrarily underfilled feed cannot be costed honestly as exactly `ceil(N/1,000)`.

If “pages” already counts all localized URLs, divide the family count by eight:

| One run, input count means localized URLs  | 1,000,000 |  50,000,000 |
| ------------------------------------------ | --------: | ----------: |
| Families                                   |   125,000 |   6,250,000 |
| Ideal feed requests, before overhead above |       125 |       6,250 |
| Feed item bytes at B = 1,500               | 0.1875 GB |    9.375 GB |
| XML at U = 100, excluding wrappers/index   |  1.379 GB |   68.950 GB |
| Nominal shards                             |     42–48 | 2,084–2,090 |
| Gzip at illustrative r = 0.10              | 0.1379 GB |    6.895 GB |

The staged design also writes and later reads roughly `N × B` bytes of family data if stored uncompressed:
1.5 GB / 75 GB in each direction for the first table, plus envelopes and private manifests. It streams the expanded
XML through gzip without storing another 11 GB / 552 GB raw copy. In an all-changed run, roughly `S` compressed
objects plus an index are written; spool objects add roughly `R` writes and reads. Unchanged shard reuse reduces
artifact writes, not full-walk traffic. Retaining several generations multiplies changed-artifact storage; abandoned
attempts and retries add transfer. Crawler downloads, request headers, queue operations, coordinator state and
provider billing are additional costs, not hidden inside the feed-byte estimate.

At the nominal 50-million-family size, one flat index is ample. Still enforce both index limits: unusually long URLs
can create many more shards. If a run needs more than 50,000 shards, fail publication and retain the prior export;
additional independently advertised root indexes would require adoption in the owning requirement. Never nest.

## Source revisions, paths and licences

All findings above are paraphrased; no implementation code was copied. Patterns may be followed freely. Under
this task's copying rule, only MIT, Apache-2.0 or BSD implementation code may be copied, with attribution and its
licence obligations. The GPL/AGPL generators here are reference-only regardless of their availability in public.

| Repository / pinned revision                                                                                                                                                            | Source paths examined                                                                                                                                                                                                                                             | Licence evidence                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MusicBrainz server](https://github.com/metabrainz/musicbrainz-server/tree/bade3a567e20ec69323ac7850fca9d0ee113f87d) `bade3a567e20ec69323ac7850fca9d0ee113f87d`                         | `lib/MusicBrainz/Server/Sitemap/{Constants,Overall,Incremental,Builder,Utils}.pm`; `admin/Build{,Incremental}Sitemaps.pl`; `admin/cron/{daily,hourly}-sitemaps.sh`; `docker/musicbrainz-sitemaps/crontab`; `bin/rsync-sitemaps`; `root/layout/components/Head.js` | [COPYING.md](https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/COPYING.md): GPL-2.0-or-later for this code; unrelated BSD assets do not relicense the generator. |
| [MediaWiki](https://github.com/wikimedia/mediawiki/tree/387d8ced27f16899afe674749f9890d14987e81d) `387d8ced27f16899afe674749f9890d14987e81d`                                            | `maintenance/generateSitemap.php`; `includes/Page/{SitemapGenerator,WikiPage}.php`; `includes/Rest/Handler/Sitemap{HandlerBase,IndexHandler,PageHandler}.php`; `includes/Output/OutputPage.php`                                                                   | [COPYING](https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/COPYING): GPL-2.0-or-later.                                                                                    |
| [Wikimedia production configuration](https://github.com/wikimedia/operations-mediawiki-config/tree/1fcded64d168a651f865c8d1b0a06c9ea918c58f) `1fcded64d168a651f865c8d1b0a06c9ea918c58f` | `wmf-config/InitialiseSettings.php` (`wmgEnableSitemapApi`); `wmf-config/CommonSettings.php`; `robots.txt`; `README.md`                                                                                                                                           | No repository-wide licence declaration found; inspected files used only as configuration evidence. Wikitech's linked history page states CC BY-SA 4.0 for its prose.                                          |
| [Open Library](https://github.com/internetarchive/openlibrary/tree/37e446827465be2febad416de1bc18753b66997d) `37e446827465be2febad416de1bc18753b66997d`                                 | `scripts/sitemaps/sitemap.py`; `scripts/oldump.sh`; `scripts/install_nginx.sh`; `openlibrary/data/sitemap.py`; `openlibrary/templates/shell/head.html.jinja`; application templates                                                                               | [LICENSE](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/LICENSE): GNU AGPL version 3.                                                                          |
| [Discourse](https://github.com/discourse/discourse/tree/589325e2b8466178ee83acac9ec411de555a0093) `589325e2b8466178ee83acac9ec411de555a0093`                                            | `app/models/sitemap.rb`; `app/controllers/sitemap_controller.rb`; `app/jobs/scheduled/regenerate_sitemaps.rb`; `app/views/sitemap/*.xml.erb`; `app/views/common/_hreflang_tags.html.erb`; `config/site_settings.yml`                                              | [COPYRIGHT.md](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/COPYRIGHT.md), `LICENSE.txt`: GPL-2.0-or-later.                                                           |
| [Mastodon](https://github.com/mastodon/mastodon/tree/4e7c02372b1e26e1a237739243ccdc4820c32fd5) `4e7c02372b1e26e1a237739243ccdc4820c32fd5`                                               | `public/robots.txt`; `config/routes.rb`; `app/views/layouts/application.html.haml`; `app/views/{accounts,statuses}/show.html.haml`; repository searches for sitemap/hreflang                                                                                      | [README licence statement](https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/README.md#license), `LICENSE`: AGPL-3.0-or-later.                                               |

Documentation licensing: the [Sitemaps specification terms](https://www.sitemaps.org/terms.html) state CC BY-SA 2.5.
Google Search Central pages state CC BY 4.0 for prose and Apache-2.0 for samples; that sample licence does not
extend to all Google Help content. [Cloudflare's documentation licence](https://github.com/cloudflare/cloudflare-docs/blob/production/LICENSE)
is CC BY 4.0. Bing, Pinterest and Shopify pages above have no permissive implementation-code licence stated;
they are cited as primary documentation, not code-copy sources. This report contains independent analysis,
calculations and short technical identifiers rather than reproduced source implementations or documentation.

[mb-sitemap]: https://github.com/metabrainz/musicbrainz-server/tree/bade3a567e20ec69323ac7850fca9d0ee113f87d/lib/MusicBrainz/Server/Sitemap
[mb-cron]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/docker/musicbrainz-sitemaps/crontab
[mb-head]: https://github.com/metabrainz/musicbrainz-server/blob/bade3a567e20ec69323ac7850fca9d0ee113f87d/root/layout/components/Head.js
[mw-command]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/maintenance/generateSitemap.php
[mw-generator]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/SitemapGenerator.php
[mw-page]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Page/WikiPage.php
[mw-rest]: https://github.com/wikimedia/mediawiki/tree/387d8ced27f16899afe674749f9890d14987e81d/includes/Rest/Handler
[mw-head]: https://github.com/wikimedia/mediawiki/blob/387d8ced27f16899afe674749f9890d14987e81d/includes/Output/OutputPage.php#L4486
[wm-config]: https://github.com/wikimedia/operations-mediawiki-config/blob/1fcded64d168a651f865c8d1b0a06c9ea918c58f/wmf-config/InitialiseSettings.php#L7861
[ol-generator]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/sitemaps/sitemap.py
[ol-dump]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/oldump.sh#L220
[ol-distribution]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/install_nginx.sh#L6
[ol-helper]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/data/sitemap.py
[ol-head]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/shell/head.html.jinja
[dc-model]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/sitemap.rb
[dc-controller]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/sitemap_controller.rb
[dc-schedule]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/jobs/scheduled/regenerate_sitemaps.rb
[dc-settings]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/config/site_settings.yml#L537
[dc-views]: https://github.com/discourse/discourse/tree/589325e2b8466178ee83acac9ec411de555a0093/app/views/sitemap
[dc-head]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/views/common/_hreflang_tags.html.erb
[ma-root]: https://github.com/mastodon/mastodon/tree/4e7c02372b1e26e1a237739243ccdc4820c32fd5
[ma-robots]: https://github.com/mastodon/mastodon/blob/4e7c02372b1e26e1a237739243ccdc4820c32fd5/public/robots.txt
[ma-views]: https://github.com/mastodon/mastodon/tree/4e7c02372b1e26e1a237739243ccdc4820c32fd5/app/views
