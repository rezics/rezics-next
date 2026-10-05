# Home timeline selection

Decision, G-1025, 2026-10-04. Following New seeks the reader's followed-target
activity indexes. It never seeks global recency and then discards unrelated
posts. Best retains `home-best-v1` and its existing bounded ranking cohort.

## Evidence and alternatives

[Mastodon's fan-out service](https://github.com/mastodon/mastodon/blob/main/app/services/fan_out_on_write_service.rb)
queues a home-feed insertion for each local follower. Its
[configuration documentation](https://docs.joinmastodon.org/admin/config/#home-feeds)
describes Redis home feeds, expiration of inactive readers, and expensive
regeneration. A reader inbox makes reads cheap, but adds follower-sized writes,
follow backfill and removal work. REZICS also follows Works, Spaces and credited
authors whose relationships can change after a post; an inbox would replicate
those corrections across readers.

[Bluesky's current timeline implementation](https://github.com/bluesky-social/atproto/blob/main/packages/bsky/src/api/app/bsky/feed/getTimeline.ts)
obtains a viewer-specific skeleton before batched hydration and applies blocks
and mutes afterwards. Its current public code delegates selection to its data
plane; it does not establish that the present production database uses SQL
fan-out on read. We retain that separation between selection and live disclosure.

[Raffi Krikorian's Twitter timeline presentation](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/)
is historical operator evidence about timeline, social-graph and delivery work
at Twitter scale (2013), not a specification of current X. It motivates treating
selection, hydration and relationship mutation as separate costs. Neither that
scale nor Mastodon's Redis deployment establishes a capacity requirement here.

We choose a shared target activity index rather than per-reader inboxes. A
request merges at most `P+1` entries from each current followed key, expanding
canonical Space aliases before seeking. Its single SQL query costs
`O(F log N_target + F P log(F P))`, with `F` the reader's relevant followed keys;
unrelated corpus adds no visits or extra pages. Row/byte work remains proportional
to the selected page. This is a design derivation; the profile and SQL plan
tests qualify the actual implementation at three diagnostic scales.

## Realm Best and Top

Decision, G-1034, 2026-10-04. A Realm ranks its complete current discussion
population. The former newest-256 cohort excluded an older winner and caused
page-two graph response bytes to grow with the Realm. We reuse the admitted
score relation and shared target-index pattern: immutable references discover
current slots in saved-key batches; graph and Content events invalidate only
the affected reply, Work or Realm. The existing Home refresh worker owns this
work, including migration and restored-epoch backfill. A request reports
unavailable until its source cut and population are complete.

Best retains `bestKey(netVotes, placementTime)`. Its common `-now/24h` term
cancels in comparisons, so advancing time needs no full-relation rescore.
Reply changes maintain the root's count and latest activity with deltas and an
indexed latest-child probe; they do not change the vote/age formula or rejuvenate
an old placement. Votes update the current placement's order rows in the same
Access transaction. A Realm revision binds keyset cursors and is checked again
after page hydration; it moves with the population, not with scores (see
[Votes and paging](#votes-and-paging)). Ordering normalizes descending score/time to an ascending
tuple, with placement IRI in PostgreSQL's C collation as its final key.

Top has independent all/week/month populations. Rolling periods use exact
placement time plus seven/thirty days. A bounded expiry worker removes elapsed
entries; an indexed expiry probe refuses a page while its population contains
elapsed entries. Daily bucket merges would either approximate the boundary or
filter a potentially unbounded high-score prefix of the boundary bucket. We
choose maintenance work and explicit readiness instead.

Private history from admission also needs an admitted population before LIMIT.
Equal immutable admission cuts share an index; current Access obtains the cut
and still fences every private read. Its first build seeks reply keys in batches
and evaluates the slot's first-publication rule off the request path. New slots
queue exact cut-admission jobs, while edits, votes, gates and Top expiry mirror
existing admissions transactionally. This adds writes/storage proportional to
the retained distinct cuts in that Realm, rather than to followers. It avoids
an after-LIMIT history filter and does not retain a member roster or grant.

The diagnostic PostgreSQL planner chose bitmap-plus-sort for a small Top tail.
The bounded seek therefore uses a function with local `enable_bitmapscan=off`
and `enable_seqscan=off`; PostgreSQL restores the settings on function exit
([CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html),
[planner methods](https://www.postgresql.org/docs/18/runtime-config-query.html)).
The guards execute the seek algebra under those same function settings and
reject sorts, excess rows and filtered prefixes. This qualifies the tested
plans, not an assertion that PostgreSQL always chooses an ordered index from
ORDER BY/LIMIT alone. Trigger maintenance participates in the source transaction
([trigger behavior](https://www.postgresql.org/docs/18/trigger-definition.html)).

`g-1034-realm-ranking.test.ts` profiles 100/1,000/10,000 real current placements,
with retained graph history, against an independently sorted score oracle.
The scale snapshot imports complete owner records from an API-created approved
template; it is not command-throughput or stopped-backup/restore evidence.
G-1024's native request profile measures round trips and bytes, while real
PostgreSQL EXPLAIN measures its index visits. First/warm are not engine-cold;
neither those counters nor SPARQL algebra claim native TDB2 operator visits.
The public header's recovery-fenced atomic probes and one rules/link cut hold
six anonymous or nine signed-in SQL statements across rules/moderators/roles;
the tests also retain live link invalidation and current principal denial.

## Votes and paging

Decision, 2026-10-05. A vote locks only what it changes: its principal's vote
key and the group leader row that carries the score. It reads the projection
epoch without a lock. The Home checkpoint `revision` and a Realm's ranking
revision change with their population: ingested activity, reviews, restore
copies, placements entering or leaving an order, and changed placement or time
keys. A score change moves neither. Previously each vote took the singleton
checkpoint FOR UPDATE and replaced its revision, so the platform's votes ran
one at a time, refresh blocked every voter, and one vote anywhere ended every
open page with "Feed changed". Every vote in a popular Realm also met on that
Realm's state row.

Continuation therefore pins the population and a keyset position, never a
score snapshot. New and Following New seek `(sort_time, id)`; Top seeks
`(score, sort_time, id)`; Best recomputes `home-best-v1` over its cohort and
continues after the last served `(rank, time, id)`; Realm Best and Top seek
their order keys. An item whose score changed after it was served may appear
again, and one that rose past the position is passed over on that traversal.
The web feed drops repeated ids. A fresh first page always reflects current
scores. A restore's retained copy share-locks the rows it copies, so no score
written under the prior epoch is lost.

## Current relationships and invalidation

Direct keys name the Work, poster, Realm and Zone. Author keys name the current
first three credited authors for author-news kinds, using the same credit order
and Source-reported fallback as card presentation. Overlapping direct/author keys
coalesce to one activity in a target index; group members index their stable
group leader and creation time.

Follow/unfollow is applied at read time from Access's current inventory. Its
revision binds cursors; no reader-inbox rebuild or cleanup is needed. Credited
author changes queue the affected Work, delete/rewrite only its author keys in
indexed history batches, and retain direct keys. The job seeks its saved item
key and never rescans a completed prefix. Writes cost `O(H_work × A)` for the
changed Work's history and at most three authors, independent of followers.
Following New serves its bounded indexed subset while the target projection is
incomplete, including migration/restore backfill. It reports `catching-up` and
`projecting`, including an empty partial result, and never calls that index caught
up. Its cursor includes the target revision; a backfill changes the population
and requires a fresh first page. The closing cut checks that same revision:
[PostgreSQL Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)
gives each statement a snapshot, not a snapshot spanning graph and SQL reads.
`/health/feed-ready` reports indexing until references, reviews and target/author
history all reach the source cut. Both indexes receive one bounded worker turn
so a Realm backfill cannot starve Home's target history. Every selected activity still passes current graph, Content and Access
disclosure, so an index entry is not an authorization grant.

## Ranked populations

Rankings use a separately indexed admitted population, before score order and
LIMIT. Raw private Book progress remains a valid owner signal but never enters
the public score seek. Global and public-Realm admission keys are refreshed for
the changed Work set, and score changes maintain their mirrored order rows.
Strong Work gates and governance enforcement update admission in the same
Access transaction. Live graph/Content disclosure still fences the selected
page; an outdated admission is a moved outcome, not a scan into another raw
candidate batch.

This follows PostgreSQL's
[ORDER BY/LIMIT index mechanism](https://www.postgresql.org/docs/18/indexes-ordering.html):
the physical ordered relation must contain the requested population. Sorting a
raw relation and rejecting its prefix afterwards would restore the measured
growth. The real-engine guard creates 4/16/64 privately read Books through API
commands, executes the former raw-score scan and checks one admitted seek plus
the visible result. SQL plans and request profiles remain separate from native
Jena operator measurements.
