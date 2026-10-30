# Ratings and reviews: proposed owner-contract changes

**Recommend:** connect the existing private vote, published Global figure and immutable review citation; replace
the empty subject review component with the real Content list. Content should adopt the three product slices below
with Web and Search. This report proposes changes; it does not establish completion.

## Primary evidence and tradeoffs

- [IMDb's ratings FAQ](https://help.imdb.com/article/imdb/track-movies-tv/ratings-faq/G67Y87TFYYP6TWAV)
  separates a replaceable personal rating, periodically updated public figure and external critic score. Its chart
  formula shrinks a title mean toward a population mean. Explain publication delay; retain REZICS's adopted
  same-question/population prior rather than importing IMDb's undisclosed title weighting or chart eligibility.
- [Letterboxd's FAQ](https://letterboxd.com/faq/) says later ratings do not rewrite ratings on earlier reviews.
  Distinguish “rating when written” from “your rating now”; retain REZICS's one-live-review-per-author/subject/board.
- [Steamworks user reviews](https://partner.steamgames.com/doc/store/reviews) names the recommendation question,
  aggregate time windows and moderation consequences. Its binary, playtime-qualified score couples reviews and
  ratings differently. REZICS retains independent voting, without a purchase gate or recent-score window.

The shared pattern is an identifiable opinion, explained aggregate and readable review. Sources inspected
2026-10-31 are copyrighted official help pages; no reuse licence is asserted or text proposed for copying.
Repository source is [AGPL-3.0](../../LICENSE). Existing [Content](content-done-when-review.md),
[Web](design-status-web.md) and [epoch](search-rating-epochs.md) research is input, not journey proof.

## Proposed adoption and product slices

**1. Honest figures and question.** Add to [Rating, Display](../../services/kernel/src/rating/README.md#display):
subject headline and search card consume existing `PublicFigure`, showing its mean with Global/count; rating order
uses its separately explained Bayesian score. Null is not zero; zero votes draw no figure, while a vote of zero is
valid. Explain delayed publication and retain the producer's ready snapshot during pending work. Web owns changes
under `apps/web/src/features/pages/` to `subject-ratings.ts`, `subject-ratings-view.tsx`, `rating-control.tsx`,
`subject-head.ts`/`jsonld.ts`, plus `apps/web/src/search/results.tsx`/`search.tsx`. Load the actual standard question
label/revision/scale; use `/figure` for headline/metadata and `/ratings` for distribution details. Dependencies are
existing question/figure APIs and Search's hit DTO. Two focused Web outcomes: question-driven save/clear including
zero; subject/search ready, pending and below-threshold rendering with Global/count/units and separate imports.

**2. A served review list and explicit destination.** Add to
[Content, Subject threads](../../services/kernel/src/content/README.md#subject-threads), linked from
[subject pages](../subject-pages.md): preview and full view use the existing
`GET /v1/subjects/{id}/threads?place=…&kind=review`, preserving its cursor and explicit place. Web wires
`features/pages/overview.tsx`, `subject-queries.ts`, `views.ts` and `routes/subjects/$id_.$slug_.$view.tsx` to Content's
single producer, distinguishing empty, failed and continuation states. In `subject/write-review.tsx`, label Realm
board destinations, page memberships with the existing cursor and link success to the actual thread/board.
Known Global boards use the existing composer. Empty-Global-board discovery is absent: do not invent an endpoint
or substitute Realm reviews for Global. Dependencies are Content's list/board APIs, Accounts membership pages and
Semantic's canonical identity/Context metadata. Unbound Realm page producers remain closed under the
[Context freeze](../subject-pages.md#realm-context). One focused outcome follows a known-board review through subject
first/continuation pages to its thread, including a now-unreadable candidate and labelled Realm destination.

**3. Visible citation, private current vote.** Clarify
[Rating, Reviews](../../services/kernel/src/rating/README.md#reviews): permitted readers see the immutable citation;
only the authenticated author sees “your rating now” when different, through the existing own-vote GET. Flag for
adoption: “shows the current vote beside it” is ambiguous against adopted private-vote policy; resolve it in favor
of privacy, with no public author-vote endpoint. Web owns rendering in `routes/threads/$id_.$slug.tsx`,
`threads/post-history.tsx` and the review list; `threads/review-vote.ts` supplies only author-private comparisons.
No citation means an unscored review. One focused outcome preserves the citation after a vote change for both
readers, shows comparison only to its author and omits comparison when the private read is unavailable.

## Current UI/API/storage journey

Web paths below are relative to `apps/web/src/`; kernel paths to `services/kernel/src/`.

- **Entry and vote:** `routes/subjects/$id_.$slug.tsx` → `features/pages/subject-queries.ts:subjectRatingQuery` →
  `subject-ratings.ts` currently reads `/ratings` and `/source-statistics`. `RatingControlView` hardcodes 0–20 and
  `/2`, without reading `/v1/rating-questions/{id}`. `rating-actions.ts:changeSubjectRating` sends PUT/DELETE
  `/v1/subjects/{id}/ratings/{questionId}/vote` with session credentials and an action idempotency key. GET selects
  only the caller; PUT returns units/revision/time. Native `rating:vote`, `personal_library` admission and account
  state remain authoritative. [votes.ts](../../services/kernel/src/rating/votes.ts) writes
  [rating.vote](../../services/kernel/db/rating/schema.sql) on the voter route, keyed by voter/question/original
  target; clear is a null-unit tombstone and `counted_target` handles merges.
- **Publication and search:** [rating/work-module.ts](../../services/kernel/src/rating/work-module.ts) registers
  idempotent aggregate and serial figure effects. Vote events update sharded population components; the drain writes
  `rating.public_figure` on the subject anchor and emits `com.rezics.rating.public_figure.changed.v1`.
  [Rating's contract](../../services/kernel/src/rating/README.md#public-figure) owns thresholds, pending/ready state,
  frozen prior and bounded republication. `search/indexer.ts` consumes figure events through the rated subject source;
  `search/public-figures.ts` enriches kept hits with `figure: PublicFigure`. Web `search/results.tsx` instead expects
  `publicRating.score`, without count, while the subject headline bypasses `/figure`: actual consumer mismatches.
- **Review author:** the subject review route's `WriteReviewAction` offers Realm boards from only the first
  membership page. A known board works through `routes/boards/$id_.new.tsx`: `ReviewFields` reads the author's vote;
  `threads/post-writes.ts` POSTs `/v1/threads` with `kind: review`, one subject and optional citation, retaining the
  composer idempotency key. Native `thread:create` applies; 409 may identify the author's existing review.
  [content/commands.ts](../../services/kernel/src/content/commands.ts) validates citation units/revision against the
  current vote in the transaction. Thread/posts/immutable `content.revision.vote_citation` live on the author route;
  [content/schema.sql](../../services/kernel/db/content/schema.sql) enforces the live-review slot.
- **Review reader:** `content/board-projection.ts` and `subject-thread-index.ts` asynchronously publish candidates;
  Content's subject-thread API rechecks current disclosure. Web `overview.tsx:ReviewList` renders `FeatureEmpty`;
  `packages/composition/src/registry.ts` assigns it no read and `presentation/reads.ts` has no subject-thread
  descriptor. Stories do not establish a served list. Direct `routes/threads/$id_.$slug.tsx` → `threads/thread-page.ts`
  reads real thread/post APIs, but that route and `PostHistory` omit the returned citation.
- **Moderator and imports:** report actions and `routes/boards/$id_.moderation.tsx` use existing Content
  report/takedown commands, native target storage and idempotent receipts; subsequent reads conceal removed material.
  The independent vote is not removed with the review. Existing retention, authorship, ownership and appeal policy
  wins. `rating/source-statistics.ts` separately reads `rating.source_statistic`, resolving subject aliases and exact
  source/facts fences. Preserve identities, source scale/count/date/licence/attribution; never infer native votes.

Each slice primarily changes runtime product code with small outcome coverage. Reuse already owned
`review-from-vote` and `subject-rating-context` in [Content's capability contract](../goals/content.capabilities.md#ratings-and-reviews);
discard duplicate producer, epoch, moderation and acceptance-driver proposals. Search owns ordering, Accounts owns
eligibility/authority, Semantic owns identity/Context; Realm rating sorts remain deferred. Wire details stay in the
linked module contracts. This research changes only this report.
