# Public Realm discovery: proposed Community owner contract

**Recommend for Community's README:** Popular ranks public discussion starts over the previous 30 complete UTC
days; Trending uses the previous complete UTC day. Sort count descending, then Realm ID ascending; omit zero.
Trending means recent volume, not acceleration or audience size. No population normalization, members, unique-person
tracking, votes or views. This smallest signal favours prolific discussion; it does not measure reach. Empty
aggregates yield empty lists. A separate truthful public directory may be Explore, never Popular.

**Evidence.** Lemmy's [official API](https://join-lemmy.org/api/main) separates subscribers, posts and daily/monthly
activity sorts with opaque cursors; its
[`crates/db_views/community/src/impls.rs`](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/community/src/impls.rs)
orders stored aggregates with ID ties. Its [ranking documentation](https://join-lemmy.org/docs/contributors/07-ranking-algo.html)
uses cached day/week/month activity; logarithmic community-size normalization concerns post ranking. Discourse's
[`app/models/top_topic.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/top_topic.rb)
materializes daily through all-time scores using logarithmic views/posts and capped likes per post;
[`app/models/category_list.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/category_list.rb)
secures categories, preloads assets and permits fixed or recent-topic ordering. Shared patterns: real windowed
inputs, derived ranks, permission filtering and batched presentation. Neither defines universal Realm trends;
adopt windows without weighted scores or person tracking. Inspected 2026-10-31, reusing main `.reference/` clones:
`content-moderation-appeals/lemmy` at `1cc23de9ec0baf13dc4f02c47f6722985c0c60d3` (AGPL-3.0: `Cargo.toml`, `LICENSE`);
`partitioned-sitemap-feeds/discourse` at `589325e2b8466178ee83acac9ec411de555a0093` (GPL-2.0-or-later:
`README.md`, `LICENSE.txt`). Learn the patterns; copy no implementation.

**Actual inputs.** Native [Content events](../../services/kernel/src/content/events.ts) supply
`com.rezics.content.thread.created.v1`: count only discussions whose thread/root are available/published and whose
`placeId` board is published under an active public Realm and publicly readable active Space. Capture qualification
and Realm public epoch at the creation command's authoritative T; delayed events cannot infer this from later public
state. The existing payload lacks this evidence: add a closed internal delta carrying Realm/epoch, board/thread,
creation day, delta and source version, without actor IDs. Drafts, protected/Global boards, reviews, replies, edits,
membership and publication events never contribute. Native [moderation events](../../services/kernel/src/content/moderation-events.ts)
`moderation.takedown.v1`, `post.erased.v1`, `moderation.erasure.v1`, `moderation.restored.v1` and `post.restored.v1`
retract/restore only the original qualifying contribution. [Community events](../../services/kernel/src/community/events.ts)
`space.created/updated.v1` and `realm.created/updated.v1` refresh candidates; protected-to-public starts a fresh
public epoch, counting subsequent public creations only. All event names carry their catalogue's `com.rezics` prefix.

**Project/retract/expire.** Community owns Realm/epoch totals, 31 day buckets per board, version deduplication and
two B-tree indexes `(sort,count DESC,realm_id ASC)` on one designated routed discovery partition. Content retains
qualification/day beside each thread. Before invalidating a contribution, durably fence that Realm generation;
ordered idempotent deltas update totals/index entries carrying that generation, then clear only their own pending
operation. Failed-source recovery resolves that operation before clearing. Pending/mismatched generations are never
served. Board removal subtracts its buckets; Realm visibility changes reset the epoch atomically with its head.
An indexed due queue rolls over/expires affected buckets; no global sweep/rebuild. **Touches:** exact source keys,
one board's buckets, one Realm gate/aggregate, two rank entries, through separate single-partition commands.
**Bound:** 31 buckets/change, 50 due keys/step; O(changes log R) ranking work, including scheduled changes, for R Realms.
**Growth check:** later use the existing growth harness with unrelated Realm/membership/thread growth; no new suite.

**List.** Add anonymous public `GET /v1/realms/discovery?sort=popular|trending&cursor=…`, with closed query/DTO:
`{items:[{realmId,spaceId,name,description,avatar:null}],next:string|null}`. Use native routed UUIDs, current Realm
title (1024 characters maximum), and current summary collapsed to single spaces, trimmed and truncated to 160 Unicode
characters. Expose no scores, counts or account IDs. Seek exactly one candidate page of at most 20 by count/Realm ID.
Authenticate opaque cursors bound to sort, definition version, UTC cutoff day, partition epoch and last examined key;
changed day/epoch requires restart. Retractions can reorder pages; clients deduplicate IDs. Rejected candidates advance
the cursor; short/empty pages may continue, without refill scans. Batch current Realm/Space heads, carried-Realm slots
and gates; require explicit public Realm visibility, matching host and anonymous `realm:read`/`space:read` through
native [Realm](../../services/kernel/src/community/realm.ts)/[Space](../../services/kernel/src/community/space.ts)
eligibility. Recheck heads/gates before serialization; privileged grants never widen results. Withhold overdue rollovers.
**Touches:** one index range, at most 20 anchored Realm/Space pairs and gates, batched in per-database snapshots.
**Bound:** 20 examined candidates, fixed statements/row-kind/database, no membership/thread scans or per-card HTTP.
**Growth check:** existing harness later covers sparse pages, stale projections, protection races and unrelated growth.

**Delivery and missing owner decision.** Adopt the contract in Community's README; add native delta/fence hooks,
projection/due work, route/generated client, then one producer request per phone-sheet label. Title/summary already
exist in [Community DTOs](../../services/kernel/src/community/routes.ts). Neither Realm nor Space has an avatar
selection. [Content's avatar port](../../services/kernel/src/content/avatar.ts) batches summaries, but upload/selection
authority is account-only. Return null/initials until owners choose a Realm-versus-Space reference and extend existing
Content container authorization; never substitute an owner's image or create another media authority. Later delivery
acceptance must cover real windows/expiry, replay/reordering, removal/restoration, private-input exclusion, current
Realm/Space disclosure, bounded cursors and truthful summaries/avatar absence. Research does not prove runtime delivery.
