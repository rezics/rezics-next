# Bounded sitemap traversal over partitioned Collections

## Recommendation and scope

Use a partition-major, immutable-key walk with a separate examined-candidate budget and partition-probe budget.
Resume after the last candidate actually processed, including candidates rejected by anonymous disclosure. Empty
pages can continue. This combines the bounded evaluation and continuation semantics documented by DynamoDB with
the public-only selection, source timestamps and sitemap sharding seen in established catalogue/community systems.
It does not borrow their offset pagination or offline generation as the endpoint implementation.

Prefer a small partial B-tree on `(route, collection_id)` for active, public Collections. Seek within one partition's
sixteen-route interval, rather than probing every route address. The existing primary key supports a less selective,
bounded identity walk without this index, but its candidates include nonpublic/deleted Collection identities.
Neither solution skips entirely empty partitions globally. A maintained occupancy directory or enumeration projection
would improve that case, but introduces a shared maintenance contract and is not necessary for bounded correctness.

This is evidence and a proposed implementation direction, not an amendment to Library or SEO contracts. The fixed
surface is `GET /v1/sitemap/collections`, `limit` 1–1000, default 1000, returning
`{items: [{id, lastModified}], next}`. At most `4L` candidate identities may be fetched per request for requested
limit `L`. Return only current public, active, anonymously openable Collections, including the platform gate decision,
even when a bearer is supplied. Use existing `updated_at`; add no write-path timestamp. Do not query private entries,
copies, follows, progress, sessions, published logs or member contents to enumerate Collections.

## Sources and method

Inspected REZICS at `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0` and upstream sources on 2026-10-27.
Reference repositories were shallow-cloned with blob filtering and inspected as untrusted text; no reference code,
tests, installation commands, builds or containers were executed. To honor the explicit restriction that all writes
stay inside this worktree, the checkouts are under `.temp/partitioned-sitemap-feeds-refs/{discourse,openlibrary}/`,
rather than the otherwise requested external temporary directory. No reference code is copied into this report.
Patterns may be followed freely; any later code copying is restricted to MIT, Apache-2.0 or BSD sources with attribution.

### Standards and official database documentation

- [Sitemaps protocol][S1]: URL `lastmod` describes the linked page, not generation time; sitemap-index `lastmod`
  describes the sitemap file. XML is UTF-8 and escaped. A sitemap is limited to 50,000 URLs and 50 MB uncompressed.
- [Google Search Central, Build and submit a sitemap][S2]: use canonical, absolute URLs; accurate, verifiable
  `lastmod` should represent significant page updates, including main content, structured data or links. RSS/Atom
  feeds usually describe recent URLs and do not replace complete historical enumeration.
- [DynamoDB Query API][A1]: the partition key is explicit; the sort key orders traversal. `Limit` bounds evaluated
  items before filtering, so a page may be empty and still carry `LastEvaluatedKey`. Its continuation is supplied as
  `ExclusiveStartKey`. [Pagination documentation][A2] says a nonempty continuation does not prove remaining results;
  only an absent continuation establishes completion. These are the closest established semantics for the candidate cap.
- [DynamoDB Scan documentation][A3] and [Scan API][A4]: parallel scan workers resume with the same segment identity;
  even strongly consistent scanning is not snapshot isolation across the complete walk. This supplies an established
  sharded-walk precedent, not a recommendation to perform an unrestricted SQL table scan.
- [PostgreSQL multicolumn B-trees][P1] and [row comparisons][P2]: leading-key range conditions bound an index range;
  tuple inequalities compare lexicographically. These support partition-local `(route, collection_id)` seeks. They
  do not guarantee a particular execution plan or turn residual visibility filtering into a bounded scan.

These documentation pages are cited for facts, not used as a source-code licence grant. The algorithm and cost
derivations below are recommendations/inferences, not claims that those sources implement the REZICS endpoint.

### Discourse: public community topics, numbered shards and a recent supplement

Inspected commit `589325e2b8466178ee83acac9ec411de555a0093`.
[The model][D1], `app/models/sitemap.rb`, selects visible topics in unrestricted categories. Numbered maps order by
immutable topic ID but use `LIMIT/OFFSET`; recent/news maps use time windows. Regeneration counts category topic
totals to decide which numbered maps exist. This is useful selection and shard evidence, not a bounded keyset design:
deep offsets and aggregate regeneration would violate the desired per-request work shape here.

[The XML view][D2], `app/views/sitemap/page.xml.erb`, uses the bump time, falling back to update time, for URL modification.
[The controller][D3], `app/controllers/sitemap_controller.rb`, caches numbered maps for 24 hours, recent maps for one
hour and news for five minutes. [The scheduled job][D4] regenerates hourly. This demonstrates an operational tradeoff
between fresh discovery and serving cost; cached XML does not establish live authorization.

Licence: GPL version 2 or later, as stated by [README.md][D5], with GPLv2 text in [LICENSE.txt][D6]. Follow patterns only;
the task's permitted code-copy licences exclude this project. Tests were read, not executed.

### Open Library: catalogue dump, stable numeric buckets and generated artifacts

Inspected commit `37e446827465be2febad416de1bc18753b66997d`.
[The dump generator][O1], `scripts/sitemaps/sitemap.py`, reads work/author records, derives URL paths, preserves the
dump's record modification time, and groups by resource type plus numeric ID divided into 10,000-ID buckets. It
writes maps for populated groups and indexes generated filenames. Sparse IDs therefore create short buckets without
requiring one output per missing ID. The index timestamp is generation time, distinct from each resource timestamp.

[The older generator][O2], `openlibrary/data/sitemap.py`, groups input into 50,000-URL maps, again using record
modification times for URLs. [The dump script][O3], `scripts/oldump.sh`, invokes generation as offline dump work.
Both show artifact generation outside serving requests. Neither proves live anonymous access checks, nor a bounded
online partition discovery mechanism; sorting/reading the complete dump belongs to offline work.

Licence: GNU AGPL version 3, inspected [LICENSE][O4]. Follow patterns only; no code copying is permitted by this
task from that licence. No generator was run.

### Shared patterns and differences

Both projects enumerate a deliberate public content class, preserve content-derived modification information, split
large output into bounded XML files, and accept freshness/packing compromises outside ordinary page reads. Stable
identity organizes historical traversal; recent material gets a complementary treatment. Neither inspected generator
offers all of candidate-limited keysets, signed continuations, sharded routing and live anonymous disclosure. DynamoDB
supplies the missing evaluation/resume semantics. Do not present either application's full design as a drop-in solution.

## What the current REZICS storage supports

- [SEO](../seo.md#indexing) includes public Collections, excludes closed/removed pages, and
  [Sitemaps](../seo.md#sitemaps) requires paged keyset reads and modification time from what the page shows.
- [Library README](../../services/kernel/src/library/README.md#partitions) places Collections with their curator;
  a partition is `route >>> 4`, not a physical SQL partition. [Route code](../../services/kernel/src/route/route.ts)
  defines 65,536 routes and 4,096 partitions. Collection IDs retain their route; mutable presentation fields are not keys.
- [Library schema](../../services/kernel/db/library/schema.sql) has primary key `(route, collection_id)`.
  `collection_curator_listing` adds curator before ID. The active/public curator-page partial index adds curator and
  mutable `updated_at` before ID. There is no public all-curator `(route, collection_id)` partial index, Collection
  occupancy directory, or all-Collection public enumeration projection in this base.
- The subject membership projection cannot discover empty Collections, and starting from subjects would duplicate
  nonempty ones. The curator index cannot discover the next public Collection in ID order without enumerating
  curators or doing extra work. Neither is an appropriate catalogue-wide discovery index.
- [Partition-binding verification](../../services/kernel/test/support/partition-binding.ts) accepts either an exact
  route parameter or the explicit interval `route >= p*16 AND route < (p+1)*16` bound by one partition parameter.
  [Listing counts](../../services/kernel/src/library/listing-counts.sql) already uses that interval. A local interval
  seek is therefore compatible with existing partition binding; it is not a cross-partition join.
- [Collection reads](../../services/kernel/src/library/collection-reads.ts) provides public eligibility and current
  authority reads. Its ordinary readable class includes unlisted Collections, so it must be narrowed for indexing.
  Also, `disclose` returns public/unlisted rows before testing `allowed`: merely invoking that reader as anonymous
  does not prove that a false Access/platform decision was honored. The feed must require the affirmative Access
  result as well as current public/active authority, rather than inheriting that helper's return value as proof.
- No content sitemap feed schema or sitemap README section was integrated under `services/kernel/src/content/`
  at this revision. The fixed feed envelope above comes from this research contract, not an assumed sibling API.

## Key, timestamps and disclosure

**Recommendation:** walk ascending `(route, collection_id)` within partition order. Use native PostgreSQL UUID order
consistently for both the seek and output sequence. Do not order by title, curator presentation, member ordinal,
`updated_at`, or the last emitted timestamp. IDs are unique within route and do not change on edits; ascending keys
let a deleted checkpoint remain a valid boundary because resumption uses `>` and never requires the row to exist.
Discourse's ID order and Open Library's numeric buckets support identity-based organization; the tuple seek itself
follows PostgreSQL's documented comparison/index behavior. UUID ordering is not a promise of global creation order.

Return `lastModified` from the same current Collection authority observation used for disclosure, serialized as a
UTC timestamp. Do not use generation time, Access evaluation time, cursor issuance, event time or `MAX` over members.
Existing [Collection update SQL](../../services/kernel/src/library/collection-store-collection-update.sql) changes
`updated_at`; member insert/delete and respacing SQL also touch the parent. In
[collections.ts](../../services/kernel/src/library/collections.ts), ordinary member moves and note edits explicitly
call `touchCollection`, so their member-only SQL files are not the whole write path. This supports fidelity for those
visible Collection changes without adding a timestamp. It does not prove coverage of external subject rendering
changes. Do not silently expand the timestamp contract to cover every dependency of hydrated subject cards.

Create an explicit anonymous evaluation context for every candidate, independent of bearer privileges. Require
public visibility, active state, the domain's current anonymous eligibility and the installed Access formula's
platform gate outcome. Failures/unavailable authority are errors or fail-closed outcomes under existing Access rules,
never evidence of eligibility or permission to skip an unavailable partition forever. An unlisted row can be readable
by ID and still must not appear. Account Collections-view flags control that account listing, not a new sitemap veto;
do not infer a curator-profile publication requirement absent from Collection's own openability contract.

Use bounded identity/flag/timestamp authority reads; do not hydrate members or read personal library state. Candidate
discovery or a projection is not disclosure authority. Recheck current public/active state alongside authorization
before emission; never cache a previous positive decision in the continuation. A same-request consistent resource
observation prevents mixing an old public flag with a new timestamp. This is live checking at evaluation time, not a
promise that a page cannot close immediately after a response. Cached downstream XML needs its own freshness policy.

## Bounded walk and exact continuation semantics

**Proposed algorithm, not reference code:** set candidate budget `B = 4L` and a separate small fixed partition budget,
for example `Q = 4` partitions per request. These are maxima, not targets that justify filling a page indefinitely.

1. Begin in the cursor's partition, or partition zero. Resolve/check that partition's ownership and epoch using the
   existing partition mechanism. Restrict each discovery statement to its sixteen-route interval and matching owner.
2. Seek strictly after the processed `(route, id)` in that interval, ordered by the same tuple, limited to the
   remaining candidate budget. At partition start omit the lower tuple boundary; do not invent a resource ID.
   With the proposed partial index, use literal active/public predicates matching its predicate. With the current PK
   fallback, put the identity-only `LIMIT` before visibility/state filtering, then read minimal authority per identity.
   A `WHERE public AND active ... LIMIT B` over the existing PK alone can examine arbitrarily many rejected rows.
3. Process candidates in order and charge every fetched identity, including any lookahead, against `B`. Return up to
   `L` passing items. Advance the consumed checkpoint after each processed candidate whether emitted, denied, missing,
   deleted or newly nonpublic. Stop processing once `L` results are reached. If a batch has an unprocessed suffix,
   resume before that suffix; fetching it did not authorize dropping eligible items that would not fit the response.
4. A discovery batch shorter than its requested candidate count establishes local exhaustion at that observation.
   Mark the partition exhausted and proceed to its successor only while both budgets permit. A full batch alone
   cannot prove exhaustion. Do not perform an unbudgeted `+1` query or an unbounded search for the next populated route.
5. When a budget or output limit stops work, return the signed consumed checkpoint, even if `items` is empty. It may
   lead to another empty page. Return `next: null` only after establishing exhaustion of the last partition; a final
   conservative continuation may require one extra empty request. Consumers stop on null, never on item count.

A checkpoint needs partition plus a tagged position: either `after(route,id)` or `partition-exhausted`. The latter
advances even when the partition had no rows. This avoids looping forever when no item can supply a last ID. It also
avoids using a prefetched, unprocessed key as the boundary. Never discard the suffix after reaching the output limit.

Use [cursor.ts](../../services/kernel/src/tokens/cursor.ts) and
[seal.ts](../../services/kernel/src/tokens/seal.ts): operation/parameter-bound HMAC, key rotation, 15-minute expiry and
at most eight scalar position keys already exist. Bind the feed operation, anonymous mode and traversal format;
binding effective limit too is a reasonable conservative choice. Validate position tags, route/partition range,
`routeOf(id)` and epoch. The seal authenticates but does not encrypt: do not place private IDs/metadata in it.
The PK fallback can checkpoint a rejected private identity, another reason to prefer the public-only partial index.
Even the partial index can yield a public-flagged identity that Access withholds. A raw signed cursor would expose
that rejected key. The manager must resolve cursor confidentiality before adopting such a wire representation:
recommend a confidential position wrapper or a server-held opaque checkpoint if withheld identities must remain
undiscoverable. That needs a key/state lifecycle contract; signing alone does not supply it, and this report does not
edit the shared token format. The bounded traversal itself is independent of which protected representation is chosen.

Retain the epoch of the partition carrying the checkpoint, including an exhausted marker, and validate it on resume.
After moving to another partition, read and carry that partition's epoch. Do not treat one partition's epoch as a
global catalogue epoch, nor preload all 4,096 epochs. A resumed exhausted marker can add one validation read beyond
the `Q` newly visited partitions. A moved/unavailable partition must use existing retry/stale behavior, not become an
empty partition. No long-lived transaction or database snapshot is encoded by these cursors.

## Alternatives and their actual costs

| Approach                                                                     | Benefit                                                                                  | Limitation or additional requirement                                                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact route/address walk with both row and empty-probe caps                  | Works with current PK and exact-route readers; resume by route/ID                        | Without probe cap, empty data can cost 65,536 probes. With cap, sparse deployments need many empty calls. Bounds do not make it efficient.                                          |
| Partition-local interval walk over current PK                                | B-tree skips missing routes inside each partition; no new discovery index                | Must count all Collection identities before filtering; cannot efficiently select only public rows. Private checkpoint identities are visible in signed tokens.                      |
| Partition-local interval walk over active/public `(route,id)` partial index  | Skips nonpublic/deleted rows and empty routes through an ordered seek; no projection lag | Adds one local secondary index maintained by existing Collection writes; live Access checks still required. Entirely empty partitions remain.                                       |
| Indexed nonempty-partition directory                                         | Jump to known populated partitions with bounded keyset reads                             | Needs durable occupancy maintenance, deletion/concurrency semantics, backfill and migration ownership. Stale positives are safe after rechecks; stale negatives can omit resources. |
| Public enumeration projection in one or a fixed set of owned feed partitions | Compact keyset discovery independent of authority placement                              | New shared projection, ownership, delivery/reconciliation and completeness contract; stale entries must be rechecked at authority.                                                  |
| Fan out to every partition and merge top candidates per page                 | Dense globally ordered output                                                            | Thousands of probes and overfetch per request; unacceptable default without a separately bounded shard schedule.                                                                    |
| Offset/count pagination or full dump sorting per request                     | Simple numbered output                                                                   | Work grows with offset/catalogue; offline systems do not justify putting this cost into the feed.                                                                                   |

**Adoptable recommendation:** use the partial-index interval walk with `B = 4L` and an explicit `Q` cap. The closest
bounded pattern using only existing indexes is the PK identity interval walk; prefer it to address walking if an
index-free interim solution is required, but do not claim it avoids private candidates or token leakage. The partial
index is sufficient for public candidate discovery; it does not require a new write timestamp, cross-partition join,
global index or materialized feed. An optional `INCLUDE(updated_at)` is an optimization, not authority or a substitute
for current validation. No existing index supplies efficient global populated-partition discovery.

For a static empty catalogue, `Q = 4` needs about 1,024 interval-walk requests to establish full exhaustion, compared
with about 16,384 requests for a four-address-probe walk. A single interval seek jumps over fifteen empty routes if
the only Collection is in the sixteenth. Thus the draft address walk is a correct fallback only with two budgets and
an exhaustion marker; it is dominated locally by an already-supported partition interval. If thousands of empty
calls are operationally unacceptable, ask for the directory/projection contract instead of secretly widening the scan.

## Mutation, serving compromise and adoption questions

Immutable keysets avoid offset shifts: deleting earlier rows or the cursor row does not shift subsequent boundaries;
edits leave a row's position fixed. Closures/deletions before disclosure are rejected. Rows inserted, restored or made
public behind the boundary can be missed until a new walk. Rows ahead may appear in this walk. Replaying a cursor
can produce different items under live state. With the partial index, a row removed and reinserted behind the boundary
is likewise deferred. Do not promise a snapshot or complete change feed; an updated-at watermark cannot repair this
while preserving immutable enumeration and the fixed timestamp contract. Periodic full walks reconcile omissions.

Keep the online feed bounded and allow short/empty pages. The web's generator can accumulate several such pages into
one useful XML shard, subject to XML URL/byte limits; it must not forward the JSON endpoint as a sitemap. Generate
artifacts or cache output outside the request when acceptable, and optionally supplement complete enumeration with
recent-change discovery. Discourse and Open Library demonstrate this serving compromise, but their cache/dump lag
cannot replace the feed's live checks. A recent-only feed is not complete enumeration. Cursor expiry requires prompt
page consumption or restarting a walk; do not extend the shared token lifetime here to hide slow generators.

**Assumptions and unresolved decisions:** the contract authorizes complete traversal across requests, not unrestricted
cross-partition SQL in one request; partition order is numeric and authority route/ID is immutable. `Q = 4`, limit
binding and partial-index adoption are implementation recommendations for the owning brief. A directory/projection
would require the manager to specify membership, freshness/completeness, atomic maintenance or reconciliation and
partition-move behavior before implementation. Exact whole-walk snapshot guarantees, artifact revocation latency,
timestamps for external rendered-subject changes, and confidential continuation representation are not supplied by
this contract. No new product gate or profile-visibility requirement is proposed. Adopt accepted recommendations in
Library's README/implementation brief.

## Expected cost and suggested growth checks

These are derivations, not measured plans. Let `c <= 4L` be fetched candidates, `h <= c` processed candidates,
`q <= Q` visited partitions, `N` the local relation/index size, and `a` the bounded existing Access work per candidate.
With an ordered partial-index plan, discovery returns at most `c` index entries in at most `q` statements, with
`O(q log(2+N) + c)` shared blocks. Authority rechecks return at most `h` Collection rows in at most `h` point
statements; partition reads add at most `q+1` rows/statements on resume. Access adds `h*a`, including grant/denial
probes and any installed platform evaluation; do not report that cost as zero or as another Collection candidate.
Transaction/time/deadline statements are additional fixed work per local observation. Overall rows/statements are
`O(Q + L*(1+a))`; blocks include `O((Q+L) log(2+N))` plus the existing Access bound. The PK fallback has the same
candidate bound only with the inner unfiltered limit. There is no per-page count, whole-catalogue sort or epoch scan.

SQL `LIMIT` bounds logical candidates, not dead MVCC index entries or physical block visits under arbitrary bloat;
vacuum health and actual generic/custom plans need measurement. Verify tuple bounds are index conditions, no
unbounded residual-filter scan or sort precedes the candidate limit, and partial predicates match in generic plans.
Candidate accounting includes fetched suffixes/lookahead, while continuation uses only the processed prefix.

Suggested growth cases for the owning implementation, without changing acceptance tests here:

- Fix `L` at 1, 20 and 1000; grow public Collections, private/unlisted/deleted Collections, other curators and other
  partitions separately at geometric scales. Check candidate rows, authority rows, statements and shared blocks.
- Put all data at the last route, first in one partition and then at the last partition. Compare empty catalogue,
  mostly empty routes and mostly empty partitions. Assert both budgets and strict checkpoint progress on every call.
- Deny every candidate and alternate denied/allowed rows. Check empty/short pages still continue, and bearer grants
  never change anonymous disclosure. Assert personal library relations are untouched.
- Delete the checkpoint row; edit titles/timestamps; close, delete and restore rows before/after the boundary;
  insert behind/ahead; flip platform access between pages. Check the stated live, nonsnapshot behavior.
- Reach `L` results before the fetched batch ends, and reach `4L` fetched candidates with zero results. Ensure suffix
  rows are revisited and no hidden extra probe occurs. Test final full batches, exhausted markers and terminal null.
- Move a partition or change its epoch mid-walk; tamper with tokens, operation, parameters and position tags; expire
  a cursor. Verify existing invalid/expired/stale handling and no silent data omission.

[S1]: https://www.sitemaps.org/protocol.html
[S2]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
[A1]: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html
[A2]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html
[A3]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html
[A4]: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html
[P1]: https://www.postgresql.org/docs/18/indexes-multicolumn.html
[P2]: https://www.postgresql.org/docs/18/functions-comparisons.html#ROW-WISE-COMPARISON
[D1]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/sitemap.rb#L8-L72
[D2]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/views/sitemap/page.xml.erb
[D3]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/sitemap_controller.rb#L15-L60
[D4]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/jobs/scheduled/regenerate_sitemaps.rb
[D5]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/README.md#L116-L129
[D6]: https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/LICENSE.txt
[O1]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/sitemaps/sitemap.py#L99-L166
[O2]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/data/sitemap.py#L29-L116
[O3]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/scripts/oldump.sh#L223-L234
[O4]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/LICENSE
