# Content product journey design status

Planning snapshot, 31 October 2026. [Public scope](../scope.md) includes the five systems below;
[Content's Goal](../goals/content.md) and [capability acceptance](../goals/content.capabilities.md) own their outcomes.
This report recommends the next actions under existing owners. It adopts no new product policy or scope.

Twelve earlier product slices are integrated on dev: board continuation, targeted replies, revision provenance,
community setup, publication shelves, membership/follow settlement, bans, question/figure presentation, opening-post
mentions, descendant report queues, reporter receipts and appeal retry/confirmation. This is delivered source,
not proof of served native behavior. The manager snapshot and current assignments describe pending work, not passes.
The member Space error screen and bare board layout have source repairs. The supplied ten English Page views at
phone 390 and desktop 1280 in light/dark, plus the phone Pattern regions, correct the earlier visible thread
reply-target/draft findings only within that coverage. Desktop Patterns, other locales, native behavior and the
whole journey remain pending. Moderator queue, setup and reporter layouts still need current visual review.

Content owns these journeys end to end. Web owns visual design, review at phone 390 and desktop 1280 through globals,
and group screenshots. Story IDs below identify existing review surfaces, not screenshot or native acceptance.
Interface typing, fixtures and source integration establish neither current privacy nor asynchronous completion.

## Existing primary-source coverage

Reuse the six integrated reports; their historical gap lists precede some delivered slices. No new external survey,
reference build or source-copy proposal is needed. Linked source files and licences are recorded in those reports.

| System / existing report                                                 | Primary evidence already researched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared pattern and recommendation                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Threads and boards](content-threads-boards-design.md)                   | Discourse `app/serializers/post_serializer.rb`, `app/controllers/posts_controller.rb`, `lib/post_revisor.rb` ([pinned source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/serializers/post_serializer.rb), GPL-2.0-or-later); [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1), [SPDX expressions](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/), [ActivityPub deletion](https://www.w3.org/TR/activitypub/#delete-activity-outbox)                                           | Stable reply/revision identity, separately controlled availability. Retain canonical documents, stored licences and bounded traversal.         |
| [Realms and Spaces](content-realms-spaces-design.md)                     | Discourse `lib/guardian/category_guardian.rb` ([source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/guardian/category_guardian.rb), GPL-2.0-or-later); [Lemmy API](https://join-lemmy.org/api/main), AGPL-3.0; [SKOS schemes](https://www.w3.org/TR/skos-reference/#schemes), W3C document terms                                                                                                                                                                                                                              | Separate reading, participation, management, attention and editorial authority; make the existing Space the usable home.                       |
| [Ratings and reviews](content-ratings-reviews-design.md)                 | Official [IMDb ratings FAQ](https://help.imdb.com/article/imdb/track-movies-tv/ratings-faq/G67Y87TFYYP6TWAV), [Letterboxd FAQ](https://letterboxd.com/faq/), [Steamworks reviews](https://partner.steamgames.com/doc/store/reviews); copyrighted help pages, no reuse licence asserted                                                                                                                                                                                                                                                                                     | Distinguish personal opinion, published aggregate and recorded review citation; explain delay and population.                                  |
| [Moderation and appeals](content-moderation-appeals-design.md)           | Discourse `app/models/reviewable_flagged_post.rb` ([source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/reviewable_flagged_post.rb#L61), GPL-2.0-or-later); Lemmy `crates/db_schema/src/source/post_report.rs` ([source](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_schema/src/source/post_report.rs), AGPL-3.0); [Reddit appeals](https://support.reddithelp.com/hc/en-us/articles/23511059871252-Content-Moderation-Enforcement-and-Appeals), copyrighted help        | Discoverable queue, submitted reference distinct from current target, understandable decision and independent review; no copied target bodies. |
| [Notifications](content-notifications-design.md)                         | Discourse `app/controllers/notifications_controller.rb`, `app/models/notification.rb`, `app/serializers/notification_serializer.rb` ([source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/notifications_controller.rb), GPL-2.0-or-later); Mastodon [notifications](https://docs.joinmastodon.org/methods/notifications/) and [markers](https://docs.joinmastodon.org/methods/markers/), documentation GFDL-1.3; [RFC 8941 strings](https://www.rfc-editor.org/rfc/rfc8941.html#section-3.3.3), IETF Trust/BCP 78 | Recipient-owned activity, forward-only position and current presentation checks; keep delivery separate from display.                          |
| [Realm discovery](content-realm-discovery-design.md), within communities | Lemmy `crates/db_views/community/src/impls.rs` ([source](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/community/src/impls.rs), AGPL-3.0); Discourse `app/models/top_topic.rb`, `app/models/category_list.rb` ([source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/top_topic.rb), GPL-2.0-or-later)                                                                                                                                                                 | Real completed windows, derived ranks, current permissions and batched summaries; discussion volume, never person tracking.                    |

Across the sources, adopt the interaction patterns in REZICS's existing API, document, Access and durable-work stack.
External ranking formulas, permission bypasses and retention periods do not replace the owning contracts.

## Posts, threads and boards

Authority: [Content README](../../services/kernel/src/content/README.md), its `routes.ts`/`schemas.ts`, and
[`db/content/schema.sql`](../../services/kernel/db/content/schema.sql). Web's existing route/components consume them.

| Actual page / Pattern → user step                                         | Existing API → authoritative source/storage                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space home → `/boards/{id}`; Board Continuation → Active/Hot/New and Next | `GET /v1/boards/{id}`, `GET /v1/boards/{id}/threads`; native board plus asynchronous `content.board_thread` candidates and rank work.                                                                                                                                      |
| `/boards/{id}/new` → `PostComposer`; thread page → Thread replies         | `POST /v1/threads`, `POST /v1/threads/{id}/posts` with optional `parentId`; `content.thread`, `post`, immutable `revision`, receipt and outbox commit on the thread route. Discussion `subjectIds` are additive; reviews retain one subject and an optional vote citation. |
| Inline edit → history / Revision provenance → delete or undo              | `POST /v1/posts/{id}/revisions` with `If-Match`; revision list and exact revision GET; `DELETE /v1/posts/{id}`, `POST /v1/posts/{id}:restore`. Native revisions and tombstone/purge state remain authority.                                                                |

Protected-board new-thread preparation calls `prepareSession`, uses `viewerCredential` for one authorized GET of the
requested board, and checks the returned board ID; it has no anonymous fallback. Discussion creation uses the existing
multi-select `EntityPicker` for zero through 128 subjects, shows a removable query preset, retains selected subjects
when suggestions are unavailable, and reports over-limit input without silently truncating it. `PostComposer`'s
`submissionContext` and `onIntentLockChange` freeze the exact review kind/subject/optional citation or discussion
`subjectIds` with the body, media IDs and idempotency key across pending and uncertain retry. Existing slices also
preserve selected reply context and stable retry intent, inherit the stored licence on ordinary edits, show
revision-specific references, and distinguish empty-with-next from terminal empty board pages. These are delivered
source connections; current native and visual outcomes remain unproved here.

**Boundary.** Candidate indexes never authorize disclosure. Reads check current post ancestry, thread, independently
anchored board and Realm before final output; protected denial exposes no old body or hidden parent preview.
Sort-bound opaque continuation advances over examined candidates without refill or ancestry walks. History pages
retain 20 revisions. Author deletion immediately hides bytes/history; replies keep parent placement, opening title
becomes null, undo ends at 30 days, then bounded purge is irreversible. Account erasure has its separate immediate
rules. Stable command keys do not bypass current authorization; edit conflicts retain the draft.

**Next action and proof.** The Global board directory producer and consumer are integrated:
`GET /v1/boards?purpose=discussion|reviews` → `{boards,next}` and Web's `createNativeBoardDirectoryAdapter` serve
`/boards`. The public-only source examines at most `4 × limit` candidates, limit at most 100, with current final
disclosure. Reuse this directory for discussion/review destinations; do not create another permission writer.
Web reviews `pages-community-board-directory--current`, `pages-community-board-continuation--continue-hot` and
`pages-community-thread--selected-reply-target`, retaining the supplied thread review's limited coverage above.
The directly addressable `/posts/{id}/revisions/{revisionId}` reader and remaining feed/header review stay pending.
Later native proof must follow compose → reply → edit → exact history → delete/restore, continuation after an empty
page, and revocation before final output; screenshots must show the actual shared components at both widths.

Native fixed-edition commands, returning-creator inventory and Web's creator list/draft resume are integrated source.
`content-editions/edition-create-native.ts` consumes `POST /v1/contentEditions`, exact edition metadata and keyed
publication; `/editions/new?editionId=…` resumes the stored ID/version without another create. The creator inventory
uses the declared own-account native route. Review `pages-content-creatoreditions--editions` and
`pages-content-editionpublication--resumed-draft`, `--reloaded-published`, `--resumed-conflict`, `--uncertain-publish`.
Only confirmed publication exposes the separate Commerce offer next step. End-to-end native use, current source
rights, fixed bytes, inventory disclosure, sale/entitlement and visual review remain unproved; no new writer is needed.
Author erasure now has a usable entry contract: explicitly opening or refreshing its dialog reads the original
private `GET /v1/threads/{id}` envelope's `authorErasure { authorId, mayErase }`, bound to the exact actor and thread;
stale reads are invalidated. Admission requires the current caller's first selected native post and the original
`post:erase` grant. Thread ownership or edit/delete rights are not substitutes, and no grant is guessed. Existing
Page stories cover `pages-community-author-erasure--current-admission-available`, `--current-admission-denied` and
`--current-admission-unavailable`. The original command and workflow remain unchanged: physical cleanup is
irreversible and asynchronous, with no upfront total, and enqueue/running counters do not establish completion.
Response/parser fixtures are illustrative and corrected to the canonical viewer response; the frozen served preview
predates that correction, so it supplies no visual pass. Native API/persona, database and acceptance proof remain
unrun; visual, main and physical-cleanup closure remain unproved.

## Realms and Spaces

Authority: [Community README](../../services/kernel/src/community/README.md), its `routes.ts`, and
[`db/community/schema.sql`](../../services/kernel/db/community/schema.sql). Accounts owns native membership/roles;
Semantic owns the separate live Context and Realm subject-page binding.

| Actual page / Pattern → user step                                                  | Existing API → authoritative source/storage                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/realms/new` / Space Setup → addressed home                                       | `POST /v1/spaces`, `PUT /v1/spaces/{id}/address`, `POST /v1/realms`, Realm PATCH and board-scheme PUT, Realm board POST; Space/Realm immutable heads, address claims and native grants.                                                                                  |
| `/spaces/{address}`, `/realms/{id}`, `/realms` → join/leave and independent follow | Address/Space/Realm reads; membership POST/DELETE, `members/me`, `participation`, `GET /v1/me/realms`; Realm `realm_member` intervals are authoritative, account inverse is candidate-only. `GET/PUT/DELETE /v1/follows/{spaceId}` uses Library's separate follow store. |
| Realm Publications / home shelf → later boards/subjects → publish/withdraw/reject  | Realm boards/publications GETs and publication POST/`:withdraw`/`:reject`; Realm-home `publication`/`publication_head` and Content board records, never Context grants.                                                                                                  |
| Realm bans / lifecycle region → ban/unban or container management                  | Realm bans GET and keyed PUT/DELETE; native ban records and Accounts removal workflow. Lifecycle UI consumes actual admission/commands; an unavailable native adapter grants nothing.                                                                                    |

Delivered setup, shelf, participation/follow and ban slices extend these existing surfaces. Separate shelf cursors
retain 20-board/12-publication windows and recovery states. Membership acceptance is `202 {workflowId}`, followed by
at most four authoritative refreshes and manual read retry; it is never displayed as completed solely from enqueue.

**Boundary.** Owners/moderators are resource roles, not invented memberships. Follow grants no reading rights; leave
does not unfollow, explicit unfollow survives implied follow, unban does not rejoin. Bans immediately deny protected
reads despite independent grants while removal runs; public reads retain the anonymous floor. Hidden/failed reads
never become empty lists. Curation requires native `realm:publish`, current subject visibility and head CAS, including
replay. A retained Context pointer survives removed/restored containers; publication binding needs its version/fence
before and at final output. A removed container never produces Global fallback. A separate live Context retains
its own authority. The shared Published/RealmShelf renderer now retains the exact Realm selector on canonical
localized subject links, including continued shelves, and explains opening the Realm's published view. The existing
Subject reader owns current Realm/publication/Space/Context checks and reader partitioning; shelf metadata grants
no later access, and the shelf adds no Global rescue or transport reads. This is source, not native or visual proof.

Native Accounts has only its installed roles: no invented administrator. Its explicit-holder guard, atomic native
ownership helper, erasure succession and claim approval source have been handed off; these remain the sole
ownership authorities. Community's locked source/state application ports and Web's claim reviewer are integrated.
The reviewer transport's current binding remains pending; source availability proves no approval or succession.
Orphan state is read-only; a claim request after 30 days confers no ownership.

Leave recovery is prepared in the existing `RealmMembership`, pending source integration, native runtime and Web
review. Only Accounts' declared closed `409 realm_last_owner`, `retryable:false`, `effect_status:not_applied`
problem supplies its specific reason. The current generic guard and native leave caller still need the owning
producer/binding integration; unrelated refusals cannot identify an owner. The original `ResourceAccessLink`
performs a current authorized Access read after explicit recovery interaction; the existing Access page can add
another eligible explicit owner. It is not an atomic transfer route. A fresh membership/participation read is
required before a new leave intent after refusal; an uncertain response retains its original action/key and offers
current-state checking or explicit same-request retry. Accepted workflows still wait for authoritative settlement.

**Next action and proof.** Review the repaired member Space route and existing setup at
`pages-community-space--member` and `pages-community-space-setup--new-community`. The same setup now contains the
Context directory picker, constrained scheme/concept picker and shared publication EntityPicker; the native Context
directory producer and production consumer are connected through the installed generated GET. Native behavior,
current privacy, physical cost, visual review and main proof remain pending. The scheme/
concept and publication consumers reuse their existing sources and commands. No second setup or publish writer is needed.
Container lifecycle HTTP, binding fences and `container-lifecycle-native.ts` are integrated source: current
`/lifecycle`, `/removal` and `/restoration` calls retain head/version CAS, independent Context authorization and
restored-destination validation. Content later verifies create → addressed home → board → membership settlement →
publication → ban/unban → remove/restore with native personas and current denial races.

Realm-owned presentation is adopted in the Community/Content READMEs: revisioned settings select native exact
rules, and the shared current-authorized reader enriches board responses and the Space home. The original native
member-count module `member-count.ts::readRealmMemberCount` is integrated, including source version, temporal
frontier, removal coverage and bounded initialization. Count remains unknown unless its actual current read is
covered; source availability is neither zero nor native proof. Content compares the fixed before/final Realm anchors
and withholds changed final counts without refill. Exact rules retain native author/editor and disclosure authority.
Native image-summary/claim, byline-avatar, thread-media/rules-byte and Worker-delivery connections remain pending
source/runtime/review at their owning stages; optional failures retain honest fallback. Realm-home presentation and
header integration likewise remain pending source/runtime/review. The appearance main now renders, but its controls
and header defects remain open; the assigned controls repair is pending source/runtime/review. Web still owns
normal 390/1280 light/dark review. Semantic's existing writer owns Realm page binding; do not duplicate it or claim
contextual publication from a shelf.

The original-public discovery source, aggregate/API and shared discovery section are integrated source; their native
privacy, rollover, physical and served navigation proof remains deferred. Popular counts qualifying originally
public discussion starts in the prior 30 complete UTC days; Trending uses the prior one complete UTC day.
No memberships, views, unique people or tracking contribute. The settled interface uses the genuine committed
source generation/predecessor log and gate; source recovery alone resolves its exact fence. Aggregate disclosure
also needs matching applied/current generation, epoch, settled gate, current rollover and final anonymous public
Realm/Space/carried-slot chain. Board changes touch at most 31 buckets; catch-up and due work at most 50 keys/step.
The integrated `GET /v1/realms/discovery` response is `{realms, next}`, superseding the research's proposed `items`;
it examines at most `min(limit,20)` candidates, permits sparse continuation, and returns `avatar:null` until genuine
selection authority exists. No demo runtime or temporary unavailable seam is native proof. Reuse the existing
source/API and shared section; later prove UTC expiry/replay/privacy and both-width navigation.

The carried-Realm sitemap `canonicalDestination` native producer is integrated; Web remains the sole consumer.
Its closed Space-address or Realm-ID destination follows current anonymous Realm/Space/slot and exact address-claim
validation. Native privacy and sitemap consumer integration proof remain pending. No per-row HTTP, guessed address
or protected-slot leak substitutes for it.

## Ratings and reviews

Authority: [Rating README](../../services/kernel/src/rating/README.md), Content's review/subject-thread contracts,
and [`db/rating/schema.sql`](../../services/kernel/db/rating/schema.sql). Search owns public rating order.

| Actual page / Pattern → user step                                 | Existing API → authoritative source/storage                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject Rating on the subject page → save/clear, inspect figure   | Rating-question GET; own `GET/PUT/DELETE /v1/subjects/{id}/ratings/{questionId}/vote`; subject `/figure`, `/ratings`, `/source-statistics`. Private `rating.vote` on voter home; aggregate components and published `rating.public_figure` on subject anchors; independent source-statistic/facts binding. |
| Write Review → known reviews board → Thread / Revision provenance | Thread POST cites the author's exact vote revision optionally; immutable `content.revision.vote_citation`, author-route live-review slot. Native citation validation occurs with the write.                                                                                                                |
| Subject review preview/full list → review thread, next page       | `GET /v1/subjects/{id}/threads?place=…&kind=review`; asynchronous subject-thread candidates, then current Content disclosure. A working thread route alone does not establish a served subject review list.                                                                                                |

The integrated question/figure and provenance slices connect delivered APIs: zero is a vote, clear is separate,
published mean differs from Bayesian order, imported figures remain labelled separately. Public citations are
immutable; only the authenticated author receives a differing current vote via their private own-vote read.

**Boundary.** One live review per author/subject/board, stable retry keys and ordinary current board/Realm authority
apply. Deleting/restoring the opening post releases/reclaims the slot, with conflict rather than overwrite.
Public standard-question figures require 5 work/release or 10 finer-grain votes; below threshold no mean/histogram
leaks. Bayesian prior is from the same question/population with at least 50 votes. Ready snapshots retain published
values during pending work; a successful vote write does not prove aggregate convergence. Global public figures
alone feed public Search; private Realm figures never do, and Realm rating sorts remain deferred. Subject-thread
cursors bind subject/place/kind/viewer/epoch, examine at most `4 × limit`, and retain empty continuation.

**Next action and proof.** Web's existing subject review-list/destination writer joins Content's list to the actual
subject surface and the integrated Global board directory, including later membership/destination pages. Content
supplies the existing producer, not another list. Review `patterns-subjects-subject-rating--save-clear-zero`,
`patterns-subjects-subject-rating--below-threshold` and `patterns-community-revision-provenance--changed-vote`.
Later native proof follows private save/clear → actual drain → public subject/Search figure → review/citation →
paged subject list, including author-only comparison and current loss of access; visual proof includes that served list.

## Moderation, reports and appeals

Authority: [Content reports/appeals](../../services/kernel/src/content/README.md#appeals), its report/moderation routes,
and [Web's receipt and queue contracts](../../apps/web/README.md#report-receipt-moderationreportsid).

| Actual page / Pattern → user step                                          | Existing API → authoritative source/storage                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Post report dialog → `/moderation/reports/{id}` / Reporter status          | `POST /v1/reports`, `GET /v1/reports/{id}`; command-derived report home stores submitted references/reason/evidence and outcome. Reporter ownership is exact native authority, not queue membership.                                    |
| `/boards/{id}/moderation` → inspect descendant reports → dismiss/take down | Board/thread/post reports GET; report `:dismiss`, target `:takeDown`; board-local `board_report_candidate` and exact-target projections are candidates only. Native report and target decision remain authoritative in their own homes. |
| `/moderation/decisions/{id}` → appeal → Appeal Resolution confirmation     | Decision GET/`:appeal`, board/thread appeals GET, appeal `:resolve`; native `moderation_decision`/`moderation_appeal`, pending board projection, atomic lift-takedown on reversal and mandatory notices.                                |

Delivered slices add descendant discovery, the reporter destination, one reason field and stable retry/visible appeal
confirmation. The integrated `DecisionPageView` now supplies kind-specific outcome and appeal recovery in one main;
its current review IDs are `pages-community-moderation-decision--open`, `--native-denied`, `--conflict`,
`--uncertain-retry` and the same suffixes under `patterns-moderation-decision`. Their source availability is not
visual or native approval. The queue's complete reusable review Pattern was missing from the earlier handoff; its current writer
owns that repair and layout. The reporter layout also has an assigned refinement; neither is visually accepted here.

**Boundary.** The reporter owns submitted target/revision/reason/evidence and current outcome with `targetAvailability`;
loss of target access retains their own submission, never hidden target text, moderator notes or other reporters.
Availability authorizes no link or future body read. Unrelated/missing private reports return 404; dependency errors
remain errors. Inspection checks each target independently and does not grant ordinary body access. Queue cursors
advance over denied candidates; at most `limit + 1` candidates are admitted. One nonempty takedown reason is at most
1,024 characters. Unchanged actions retain retry keys and authorize again before replay. Only the author appeals
once, through the inclusive 183-day deadline; the original decider cannot resolve. Reversal restores ordinary
readability, not erased bytes, and does not rewrite an actioned report disposition. Account erasure minimizes private
evidence; retained moderation material requires its owner's explicit fields/purpose/expiry inventory.

**Next action and proof.** Existing queue/reporter writers finish their product layouts; Web reviews
`pages-community-moderation-reports--open-reports`, `pages-reporter-status--submitted-report` and
`patterns-appeal-resolution--lost-response-retry`, plus the new queue Pattern. Content later proves submission →
board discovery → exact submitted revision/current target distinction → resolution → reporter receipt → independent
appeal → confirmed outcome, including unavailable targets, unrelated viewers and native refusal/retry behavior.

## Minimal in-app notifications

Authority: [Content notifications](../../services/kernel/src/content/README.md#notifications),
[Web Inbox](../../apps/web/README.md#notifications-inbox-inbox), Accounts preferences and account lifecycle.

| Actual page / Pattern → user step                                         | Existing API → authoritative source/storage                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread authoring → recipient notice                                       | Existing thread/post commands commit first-publication events; durable reply/mention/outcome effects write text-free recipient-route `content.notice`, unique by recipient/kind/source, and delivery decisions. Opening-post mention handling is integrated. |
| Shell badge → `/inbox` / Inbox states → target or report/decision receipt | Account notifications list/count GETs; existing post, decision or report GET per distinct target; recipient notice candidates, current native target disclosure and mandatory outcome source.                                                                |
| Open Inbox → seen/retry; settings → optional preferences                  | `POST /v1/accounts/{id}/notifications:markSeen` with owned `through`; `content.notice_seen` forward-only marker. Accounts preference GET/PATCH uses current version and stable command key.                                                                  |

**Boundary.** Reply precedes mention before preferences; first ten distinct mentions only, no self-notices or later-edit
resends. Optional sends check current source access and preference/account authority at recipient commit; mandatory
moderation outcomes remain readable without target access. Display rechecks current full target chain and suppresses
hidden notice/target identities. Private viewer-bound list cursors scan at most `4 × limit` (limit at most 50), allow
empty continuation; count examines 101 retained unread keys and caps at 100, so it need not equal visible items.
Mark seen moves forward only; retry must not acknowledge later arrivals. Notices/delivery decisions retain at most
180 days, with bounded recipient erasure and marker cleanup. Email remains out of scope.

**Next action and proof.** Web's sole Inbox/deep-link writer owns recovery and actual destination integration:
preserve `post-{id}` through redirects, use one exact post read for an unloaded selected post, never walk pages;
reuse the existing reporter receipt. Keep one valid quoted key per seen intent and explicit retry/count refresh.
Review existing Inbox mixed/hidden/unavailable states and the actual later-page post landing at both widths.
Content later proves first-publication send → actual relay → private Inbox → currently readable destination → seen
marker/count, preference changes before commit, revocation before landing, mandatory outcomes and recipient erasure.

## Remaining proof and recommendation

Finish the named existing product writers and their genuine native seams, then join each journey to Web's visual
review. Optional metadata and provisional unavailable adapters stay honestly unavailable until their producers land.
Do not dispatch duplicate writers or substitute another interface/typing pass for the missing product result.

Original Content, Community, Rating and notice cleanup/retention and physical-cost outcomes remain open for later
verification under [deletion](../deletion.md). Membership-erasure environment setup and notice/rating cleanup tooling recovery remain control-plane-owned.
The original native role-predecessor source correction is delivered; its physical cost verdict and the original
physical outcomes remain unproved, not waived requirements or evidence of cleanup.
Queued or integrated cleanup does not establish residue removal, succession or final acknowledgement.

Native API/persona, acceptance, database, browser, remote and visual proof remain deferred. Promotion, main, root and
final erasure closure remain unproved. No whole scope row or Goal is declared complete.
