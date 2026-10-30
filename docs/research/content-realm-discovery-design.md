# Public Realm discovery: proposed Community owner contract

**Recommend for Community's README.** Popular ranks public discussion starts over the previous 30 complete UTC
days; Trending uses the previous complete UTC day. Order count descending, Realm ID ascending; omit zero. Trending
means recent volume, not acceleration. No membership, unique-person tracking, votes, views or population normalization:
this measures discussion activity, favours prolific participants and cannot measure reach. Empty evidence means empty
lists; a separate public directory may be Explore, never Popular.

**Primary evidence, inspected 2026-10-31.** Lemmy's [API](https://join-lemmy.org/api/main) and
[`crates/db_views/community/src/impls.rs`](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/community/src/impls.rs)
separate subscribers/posts/windowed activity, order aggregates with ID ties and use opaque cursors. Its
[ranking documentation](https://join-lemmy.org/docs/contributors/07-ranking-algo.html) describes cached day/week/month
activity; size normalization concerns post ranking. Discourse's
[`app/models/top_topic.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/top_topic.rb)
materializes daily-to-all-time scores with logarithmic views/posts and capped likes/post;
[`app/models/category_list.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/category_list.rb)
secures categories and preloads assets, with fixed/recent-topic ordering. Shared pattern: real windows, derived ranks,
permission checks, batched summaries. Adopt windows without weighted formulas or person tracking. Reused main
`.reference/content-moderation-appeals/lemmy`, commit `1cc23de9ec0baf13dc4f02c47f6722985c0c60d3`, AGPL-3.0
(`Cargo.toml`, `LICENSE`), and `.reference/partitioned-sitemap-feeds/discourse`, commit
`589325e2b8466178ee83acac9ec411de555a0093`, GPL-2.0-or-later (`README.md`, `LICENSE.txt`); copy no implementation.

**Actual inputs.** [Content events](../../services/kernel/src/content/events.ts): `com.rezics.content.thread.created.v1`,
only discussions with available/published thread/root, published `placeId` board, active public Realm and publicly
readable active Space. Capture qualification/Realm public epoch at creation's authoritative T; delayed delivery must
not infer eligibility from later public state. Existing events lack this evidence: add a closed internal delta
(Realm/epoch, board/thread, creation day, delta, source version; no actor IDs), emitted through ordinary commands.
Drafts, protected/Global boards, reviews, replies, edits, membership and publication events contribute nothing.
[Moderation events](../../services/kernel/src/content/moderation-events.ts) `moderation.takedown.v1`, `post.erased.v1`,
`moderation.erasure.v1`, `moderation.restored.v1`, `post.restored.v1` retract/restore only original qualifying starts.
[Community events](../../services/kernel/src/community/events.ts) `space.created/updated.v1`, `realm.created/updated.v1`
refresh candidates. Names use their catalogue's `com.rezics.content`/`com.rezics.community` prefix. Returning from
protected starts a fresh public epoch, counting subsequent public creations only.

**Project/retract/expire.** Community owns Realm/epoch totals, 31 day buckets/board, version deduplication and two
B-tree indexes `(sort,count DESC,realm_id ASC)` on one designated routed discovery partition. Content stores each
thread's qualification/day. Before invalidating contributions, durably fence the Realm generation; idempotent ordered
deltas update totals/index generations, then clear only their own pending operation. Failed-source recovery resolves
that operation before clearing. Pending/mismatched generations never serve. Board removal subtracts its buckets;
visibility changes reset the Realm epoch atomically with its head. Indexed due work rolls over/expires affected
buckets, without global sweeps. **Touches:** exact source keys, one board's buckets, Realm gate/aggregate, two rank
entries, via separate single-partition commands. **Bound:** 31 buckets/change, 50 due keys/step; O(changes log R)
ranking work for R Realms, including scheduled changes. **Growth check:** later use the existing growth harness with
unrelated Realm/membership/thread growth; no new suite.

**List.** Add anonymous public `GET /v1/realms/discovery?sort=popular|trending&cursor=…`, closed query/response:
`{items:[{realmId,spaceId,name,description,avatar:null}],next:string|null}`. Native routed UUIDs; current Realm title
(maximum 1024 characters), current summary whitespace collapsed/trimmed/truncated to 160 Unicode characters.
No counts, scores or account IDs. Seek one candidate page, fixed maximum 20. Authenticate opaque cursors bound to
sort, definition version, UTC cutoff day, partition epoch and last examined count/Realm ID; changed day/epoch restarts.
Retractions can reorder pages; clients deduplicate IDs. Advance past rejected candidates; allow short/empty pages with
continuation, without refill scans. Batch current Realm/Space heads, carried-Realm slots and gates; require explicit
public visibility, matching host and anonymous `realm:read`/`space:read` using native
[Realm](../../services/kernel/src/community/realm.ts)/[Space](../../services/kernel/src/community/space.ts) eligibility.
Recheck heads/gates before serialization; privileged grants never widen discovery; withhold overdue rollovers.
**Touches:** one rank range, at most 20 anchored Realm/Space pairs/gates, batched in per-database snapshots.
**Bound:** 20 examined candidates, fixed statements/row-kind/database, no membership/thread scans or per-card HTTP.
**Growth check:** existing harness later covers sparse pages, stale projections, protection races and unrelated growth.

**Delivery/owner gap.** Adopt in Community's README; add native delta/fence hooks, projection/due work, route/generated
client, then one producer call per phone-sheet label. [Native title/summary](../../services/kernel/src/community/routes.ts)
exist. Neither Realm nor Space selects an avatar; [Content's avatar port](../../services/kernel/src/content/avatar.ts)
batches summaries but upload/selection authority is account-only. Return null/initials until owners choose a
Realm-versus-Space reference and extend existing Content container authorization; never borrow an owner's image or
create another media authority. Later delivery acceptance covers windows/expiry, replay/reordering, removal/restoration,
private-input exclusion, current disclosure, cursor bounds and truthful summaries/avatar absence. Research does not
prove runtime delivery.
