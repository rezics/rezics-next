# Native community presentation metadata

Research recommendation, 2026-10-31; pending adoption by the Community, Content and Accounts owners.
This proposes one small producer, not delivered APIs, runtime evidence or completion.

## Primary evidence

- **Lemmy**, commit `1cc23de9ec0baf13dc4f02c47f6722985c0c60d3`, AGPL-3.0
  ([manifest](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/Cargo.toml),
  [licence](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/LICENSE)).
  [Community storage](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_schema/src/source/community.rs)
  separates title, short summary, sidebar, icon/banner, subscribers and activity figures.
  [Community uploads](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/routes/src/images/upload.rs)
  authorize against the community before changing its images.
  [Subscriber triggers](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/diesel_utils/replaceable_schema/triggers.sql)
  derive deltas from actual follow changes; [views](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/community/src/impls.rs)
  filter visibility/removal. Follow totals are evidence for incremental maintenance, not REZICS membership semantics.
  Official [user documentation](https://join-lemmy.org/docs/users/01-getting-started.html) places rules beside subscribing.
- **Discourse**, commit `589325e2b8466178ee83acac9ec411de555a0093`, GPL-2.0-or-later
  ([licensing declaration](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/README.md),
  [licence](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/LICENSE.txt)).
  [Category](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/category.rb)
  owns uploaded logo/background references and links its description to a real topic/first post and revisions.
  [Group](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/group.rb)
  maintains a separate user count and repairs it with a membership tally. That recount strategy is unsuitable for
  a bounded native request. Shared pattern: container-owned optional presentation, real editorial content and
  source-derived statistics; disagreement: Markdown sidebar versus topic-backed description. Adopt the latter
  storage pattern using existing REZICS posts, and incremental statistics using Realm membership.

Reused caches: `.reference/content-moderation-appeals/lemmy/` and
`.reference/partitioned-sitemap-feeds/discourse/` in the main checkout. Paths in the links above are the inspected
source paths; sparse files were read with `git show`, without installing, building or running either project.
No source implementation or passage is proposed for copying.

## Relevant native boundary

[Realm/Space](../../services/kernel/src/community/README.md) already supply revisioned `title`/`summary`,
current read eligibility, direct manage grants and independent Context classification.
[BoardView](../../services/kernel/src/content/model.ts) supplies title, purpose and actual `realmId`.
[Media](../../services/kernel/src/content/media.ts) currently admits `post-image | cover | avatar`; the avatar path
requires an account container. Neither that path nor [post claims](../../services/kernel/src/content/claim-media.sql)
can serve as Realm assets. [Membership](../../services/kernel/src/community/membership.ts) writes real intervals
and committed transition proofs, but exposes no Realm count/version/change-page contract.
[Canonical documents](../../services/kernel/src/content/document.ts), post revisions and
[their disclosure/lifecycle](../../services/kernel/src/content/README.md) already own bodies and licences;
semantic authored-field documents require a semantic candidate and are not a rules store.

## Proposed owner-contract addition — one page

**Ownership/defaults.** Community adds a closed `presentation` field to Realm revisions:
`{ avatarMediaId: UUID|null, bannerMediaId: UUID|null, rules: {postId: UUID, revisionId: UUID}|null }`.
Creation defaults all three to null; omitted `presentation` preserves it, supplied objects require all keys,
and null clears a slot. Extend ordinary Realm settings with its existing head CAS/idempotency and
`realm:manage` at T, including replay. Realm owns these references because community membership, privacy and
editorial grants belong there; Space can also carry a future Zone with different authority. No Space assets,
board overrides, administrator role, new action set or owner engine are needed for this slice.

**Actual labels/disclosure.** Board title/purpose remain native board fields; purpose is not a description.
Community name/description are the current Realm `title`/`summary`, preserving an empty summary.
A Space-only home uses its own current `title`/`summary`, with no community/count/Join claim.
Read each container before enrichment and recheck its current head/state/read signature before disclosure.
A removed/unreadable Realm or Space never becomes Global or another container; only a genuinely null board
`realmId` denotes Global. Preserve the independent `contextId` pointer; classification supplies no editorial grant.

**Assets.** Content adds `realm-icon | realm-banner` purposes, Realm `containerId`, and a same-home permanent
Realm claim. Reserve through proposed `POST /v1/realms/{id}/media` using `parentCreationAuthorization` with
existing `realm:manage` at T and normal new-resource/uploader initialization. Completion retains uploader and
`media:complete` checks and rechecks Realm management. Selection claims only matching-purpose, available,
same-Realm/same-route media uploaded by this actor, inside the Realm settings transaction; claims cannot move.
Reuse reserved → uploaded → reencoded available, existing image limits/variants, erasure and collection.
Downloads, including conditional requests, check current Realm/container and media fences; serve derivatives
through the existing private/no-cache media route. Never borrow account avatars, serve originals or store hotlinks.

**Rules.** Select a published native post in a board of this Realm and pin its exact immutable revision.
Its body stays in `content.post`/`content.revision`, validated by `@rezics/document` and Content's SPDX validator;
select only Text-profile rules of at most 64 KiB canonical bytes for bounded inline presentation.
Authorship/editing retain ordinary board/thread/post permissions; only `realm:manage` changes the adopted reference.
An author's later edit does not silently adopt new rules. Selection prepares exact native post/revision/board
evidence before Realm checkout; subsequent reads repeat ordinary current actor, ancestry, board/Realm and exact
revision disclosure. No Context/global grant, arbitrary proof callback or second document store substitutes.
Erased, hidden or unavailable revisions return no rules; an empty authored body stays empty.

**Members/freshness.** Accounts remains the sole native membership-transition/causal-proof writer, including its
Community adapter. It must add the source/version/removal seam below. Content derives only a same-home count of
actual current Realm memberships, excluding resource owners/roles, follows, visitors and discussion starts.
Expose a number only after initialization/removal coverage is proven and projection version equals the current
source version at final Realm disclosure. Otherwise return unknown/null, never manufactured zero or stale-current.
Current `realm:read`, protected bans and privacy gate the entire result; public discovery gets no protected count.

**Closed response.** Content owns proposed `community-presentation.ts`, composed into existing board detail and
bounded board-list responses; Community reuses its Realm part on the Space home. No per-card metadata HTTP:

```ts
type Optional<T> = { state: 'available'; value: T }
                 | { state: 'none' | 'unavailable'; value: null };
type CommunityPresentation = {
  realmId: UUID; spaceId: UUID; contextId: UUID; name: string; description: string;
  avatar: Optional<ContentImageSummary>; banner: Optional<ContentImageSummary>;
  members: { state: 'current'; count: number; version: string }
         | { state: 'unknown'; count: null; version: null };
  rules: Optional<{ postId: UUID; revisionId: UUID; body: DocumentSnapshot;
                    licence: string; sha256: string }>;
  join: { membership: 'member' | 'nonmember' | 'unknown';
          action: 'join' | 'leave' | 'sign-in' | null };
}; // BoardView adds community: CommunityPresentation|null; reject undeclared fields.
```

Image summaries reuse Content's derivative/placeholder/focal-point/credit shape, with no original URL.
`none` combines unset/erased/concealed data without IDs or denial reasons; `unavailable` means optional dependency
failure or an uninstalled producer, with no cached value. Count proof gaps return `unknown`. Join derives from real current
self-membership plus native join/leave admission; viewer actions alone are insufficient. Protected self-join is
absent; anonymous action is sign-in. Accepted `202` remains pending until existing member/participation reads
confirm settlement; no speculative membership/count increment. All actions still authorize on execution.

## Additive seams and bounded initialization

Accounts supplies a private source port from `community/membership.ts`: current `{version, removalCoverage}`
(`version` is a canonical decimal bigint, coverage is `proven | unknown`) and keyset
`changes(realmId, afterVersion, limit=50)`. Each changed membership commits a contiguous per-Realm
version and `{version, accountId, reservationId, before, after, sourceTransactionId}` in the existing Realm-locked
native transaction, bound to its real committed receipt. Booleans describe actual membership, not actor metadata.
No-change publication/cancellation does not change the count. Actual leave/ban-removal and account-erasure cleanup
must publish actual removals through this same source; a terminal absence proof alone is not a decrement.
Missing removal evidence keeps coverage unknown. Content cannot infer removal from an erased/suspended actor,
write membership proofs, release holds, certify deletion or add another membership/erasure coordinator.
Account-bearing journal retention/minimization stays with the source owner's existing erasure obligations.

Content stores only `{count, throughVersion, initialized, sourceBarrier, cursor}` per Realm, not another member list.
Replay of an applied version has no effect; gaps pause consumption. Apply exact committed deltas in version order.
For existing data, stop old writers using the existing owner deployment barrier and install the source journal
before paging. A private accumulator starts at zero, without publishing a zero count. Under the same Realm lock,
each resumable step either consumes at most 50 next deltas or, once caught up, reads at most 50 open membership
keys after `cursor` using `realm_member_open`. During seeding, apply deltas only for account keys already traversed;
later keys are counted by their eventual current-source page. Thus inserts behind the cursor and removals/rejoins
across pages are accounted exactly once. Save accumulator/cursor/version atomically with a durable page receipt.
An empty indexed tail probe while caught up proves traversal; expose only with current version and owner-proven
removal coverage. A reconciliation uses a fresh generation of the same pages, never a request-time COUNT/scan.
Uncertain legacy provenance or missing native receipt/removal proof remains unknown, not complete.

Content/Community must add purpose constraints, narrow Realm claim validation, Realm-aware media parent/download
checks, response schemas and mounting. Transport must extend
[`apps/web/src/media/reservation.ts`](../../apps/web/src/media/reservation.ts),
[`threads/upload.ts`](../../apps/web/src/threads/upload.ts) and generated client types: today they admit only
post images/account avatars. New reservation declares `realm:manage` on `community.realm`, rather than assuming
`media:create` is granted there; preserve existing completion scopes. Accounts owns any required Auth scope mapping;
missing mapping denies/unavailable, never an invented capability. No Realm-media helper is claimed delivered.

## Cost notes for adoption and later proof

Here R is the relevant same-home indexed relation size; a change does O(log R) work.
All source/Access preparation releases its checkout before another home; final anchors are fixed, never retry loops.
List enrichment preserves the existing maximum of 100 items (the Space home requests 20), deduplicates Realm
references and batches full keys per row kind/database; no joins
across partitions. Rules have one exact source chain, at most 33 posts, one thread, one board and its Realm.

### Cost: presentation read

- Touches: one board, its actual Realm/Space heads, two media points, one aggregate/source-version pair, self state
  and one rules revision chain; final board, Realm/Space and rules-source disclosure anchors before bytes leave.
- Bound: constant work for detail; O(k log R) for k ≤ 100 cards, two images and ≤64 KiB rules per distinct Realm;
  bounded native Access preparation included. A changed final binding fails unavailable/hidden, without fallback.
- Growth check: later extend existing `test/content/growth-realm-board-read.test.ts`, `growth-threads.test.ts`
  and `test/community/growth-realm.test.ts` through their shared measured harness at fixed cards/anchors.

### Cost: presentation settings and rules adoption

- Touches: current Realm authorization/head/CAS, at most two same-home media claims and one prepared exact rules
  source; one revision, receipt and event. Body authoring uses existing native post create/revise operations.
- Bound: constant rows/statements and O(log R) index work, bounded document bytes; no revision-history walk.
- Growth check: later reuse `test/community/growth-realm.test.ts` and `test/content/growth-threads.test.ts`.

### Cost: asset reservation

- Touches: current Realm parent authorization/head, one media/reservation insert, uploader initialization and receipt.
- Bound: constant rows/statements, O(log R) index work; no account-image search.
- Growth check: later reuse `test/content/growth-media.test.ts`, including the Realm parent in its shared harness.

### Cost: asset completion

- Touches: exact uploader reservation, existing completion authority, current Realm management and one receipt/update.
- Bound: constant rows/statements, O(log R); existing byte/digest validation stays bounded by upload limits.
- Growth check: later reuse `test/content/growth-media.test.ts` with the added current parent check.

### Cost: asset image publication

- Touches: one existing image job/media key, current container/fences and at most twelve derivative entries.
- Bound: constant indexed rows/statements, O(log R); existing 20 MiB/40-million-pixel limits bound decoding.
- Growth check: later reuse image publication in `test/content/growth-media.test.ts`.

### Cost: asset download

- Touches: one media/variant, current Realm/container and media fence decisions, including conditional requests.
- Bound: constant rows/statements and O(log R), with fixed before/final disclosure anchors.
- Growth check: later reuse `test/content/growth-media-realm-download.test.ts` through its shared harness.

### Cost: asset collection page

- Touches: existing fixed-page media/object selection and cleanup; permanent Realm claims retain owner cleanup.
- Bound: O(p log R) for the existing fixed page p; no additional retention coordinator or unbounded sweep.
- Growth check: later reuse `test/content/growth-media-native-collection.test.ts`.

### Cost: committed membership source change

- Touches: existing native transition/receipt plus one source version and journal entry in the Realm transaction.
- Bound: O(changes log R), constant added work per actual change; no-change publication adds no count delta.
- Growth check: later reuse `test/access/growth-realm-membership-transition.test.ts`, including source controls.

### Cost: derived membership application

- Touches: exact next committed source change, aggregate version/count and durable application receipt in that home.
- Bound: O(changes log R); duplicates are point checks, gaps stay pending, Accounts' proofs are never rewritten.
- Growth check: later reuse `test/community/growth-membership.test.ts`, including relay and transaction controls.

### Cost: initialization or reconciliation step

- Touches: one Realm lock/version and saved generation; either ≤50 indexed journal entries or ≤50 open-member
  keys plus one bounded tail probe; one accumulator/cursor/receipt update, no account-state fanout.
- Bound: O(50 log R) per step; total O((members + concurrent changes) log R), with no repeated full restart.
- Growth check: later reuse the same membership harness with fixed page size and concurrent behind-cursor changes;
  source removal gaps must remain unknown. No new growth/native/custody suite or fitted allowance is proposed.

The product slice is Realm settings selection/upload, a real native rules post, the Accounts source seam and
Content enrichment; the interface can consume truthful nulls while each optional producer is unavailable.
This report changes no owner document, product code, acceptance test or runtime proof. SPDX identifiers/LicenseRef
remain under the existing validator; [SPDX's normative syntax](https://spdx.github.io/spdx-spec/v2.3.1/SPDX-license-expressions/)
is evidence for licence metadata, not authority to invent a licence for rules.
