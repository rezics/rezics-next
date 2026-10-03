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
Following New reports unavailable while its target projection is incomplete,
including migration/restore backfill; it never calls an incomplete index caught
up. Every selected activity still passes current graph, Content and Access
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
