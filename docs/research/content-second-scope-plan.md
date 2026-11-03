# Content's second scope

[Public scope](../scope.md) opens Realm rating sorts; board pins, slow mode and watch; public Collections,
reviews and Spaces in discovery; and a moderator workbench. This plan assigns eight independently usable slices.
Each continuation lives under `.temp/continuation/`; the controller queues them after this plan lands.
Implementation adopts the detailed behavior in the named owner document in the same change.

## Boundaries and existing behavior

The scope change is present on the retained base. [Content's Goal](../goals/content.md#scope) still calls Realm
rating sorts deferred; public scope now governs their scheduling. The rating slice updates that stale sentence
and the corresponding [capability boundary](../goals/content.capabilities.md#ratings-and-reviews).
Second scope is permission to build, not permission to open an unpolished platform gate.

Existing content work measures first-scope thread, media, membership, rating, report, appeal and notice outcomes;
the other active implementation concerns authored-edition delivery. None of those assignments is repeated here.
Existing reply targeting, revisions, report filters, bulk actions, reporter status, minimal appeals and public Realm
Popular/Trending discovery are retained, rather than rebuilt as new features.

Discovery already has an opt-in [mixed-kind foundation][search-mixed] and [Home consumer][feeds]. Its actual
[registry][registry] and [key/summary union][discovery-types] currently admit catalogue Subjects and Accounts.
Feed support for a Collection summary or Following event does not register Collections in public discovery.
The three new kinds therefore need native eligibility, current hydration and real registry integration.
Search's documented provisional whole-query Source remains a collaborator seam: implement against its owner
contract, preserve unavailable/preparing behavior, and never use returned rows alone as population proof.

## Ready outcomes

| Continuation                        | User outcome and working slice                                                                                                                                                                    | Owning documents and existing seams                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-realm-rating-order.md`          | A reader opens a Realm's Top rated subjects and pages through that population's labelled figures. Publish a bounded population-specific order and a small Realm-home consumer; 500 product lines. | [Rating: aggregates/privacy/display][rating], [Search: Global rating order][search-rating], [Community][community], [Content Goal][goal]. Reuse aggregate components and population totals, not public Global figures as a Realm substitute. |
| `02-board-pins.md`                  | A moderator pins/unpins a thread; readers see a bounded pinned section without changing the normal board sort; 400 product lines.                                                                 | [Content: boards][boards], [Community: resource authority][community], existing `boards.ts`, `board-cursor.ts` and Web's `threads/board-feed.tsx`.                                                                                           |
| `03-board-slow-mode.md`             | A moderator sets a board posting interval; a participant sees when another thread/reply can be submitted and keeps the draft after refusal; 450 product lines.                                    | [Content: atomic commands][atomic], [Community: participation][community], existing `commands.ts`, `threads/post-writes.ts` and composer.                                                                                                    |
| `04-board-watch.md`                 | A signed-in reader watches a board, receives an in-app notice for a new published thread and can stop future notices; 500 product lines.                                                          | [Content: notifications][notices], existing `notice-inbox.ts`, `content-notice` effects and publication events; [Home/Following distinction][feeds].                                                                                         |
| `05-public-collection-discovery.md` | A visitor finds a publicly listed Collection by its own title and opens the existing Collection page; 500 product lines.                                                                          | [Library disclosure][collections], [Library module][library], [Search mixed kinds][search-mixed], [Home][feeds]. Preserve selected public output, curator-erasure policy and current native reads.                                           |
| `06-public-review-discovery.md`     | A visitor finds a currently public review, with its subject and author context, and opens the existing thread; 450 product lines.                                                                 | [Content: reviews][reviews], [review witnesses][witnesses], [Search mixed kinds][search-mixed], [Home][feeds]. Reuse immutable revisions and native subject/thread disclosure.                                                               |
| `07-public-space-discovery.md`      | A visitor finds a currently anonymous-readable Space by its own current metadata and opens its canonical home; 450 product lines.                                                                 | [Community][community], [Realm presentation][presentation], [Search mixed kinds][search-mixed], [Home][feeds]. Reuse the native Space read, not Realm popularity as Space eligibility.                                                       |
| `08-moderator-workbench.md`         | A Realm moderator opens one workspace, chooses a board and reaches its reports, appeals and existing ban-management surface with reliable return context; 400 product lines.                      | [Content: appeals][appeals], [Community: bans][community], [private report lifetime][report-lifetime], [private appeal reads][appeal-reads]. Reuse current board queues, filters and commands.                                               |

## Adopted decisions

Decision: deliver eight independent vertical slices; overlap in registry, routes or READMEs is merge coordination,
so every brief has `after: []` and none requires an invented future task identifier.

- **Realm order:** the initial usable surface is a standard-question Top rated list on the Realm home, using a
  native Realm-population frontier, Bayesian prior from that same population and the existing publication thresholds.
  Publish no score until both thresholds hold; distinguish updating/unavailable from known unscored. Equal scores
  use subject ID ascending. The continuation binds Realm, question, prior/publication version and viewer; current
  Realm/Space/subject disclosure is checked again before output. Protected figures and ordering never enter the public
  index. Search owns generalized Realm-scoped predicate planning against this source; this slice supplies its typed
  source seam and does not take over Search's existing query work. No fetched-prefix reranking or Global fallback.
- **Pins:** at most five per board, newest pin first with thread ID as tie-breaker. A new board-curation action is
  granted to the existing local board moderator/owner roles and containing Realm moderator/owner roles. Check that
  action on the exact board with current containing-Realm authority; it conveys no global authority. Pins cannot
  cross boards and never grant read access. Show the section on the first page; suppress duplicates on that visible
  page while leaving the ordinary stream's cursor and ranking unchanged.
- **Slow mode:** off, 30, 60 or 300 seconds; default off. The interval covers successful new threads and replies by
  one account on one board, across tabs; edits are unaffected. Current board-curation authority exempts moderators.
  Record admission and successful write atomically, with no cooldown charged for failed writes or receipt replays.
  A refusal returns 429 and Retry-After; a displayed deadline only enables an explicit retry.
- **Watch:** board watch means new published thread openings, including reviews on reviews boards; replies, edits
  and historical threads send nothing. Keep private subscriptions in Content, separate from Library follows.
  Use a distinct `board_activity` in-app kind and the existing Accounts preference port/catalogue; no email.
  Watch never grants participation/read access. Exclude the actor, deduplicate per recipient/thread, page recipients
  on the existing worker, and recheck subscription, preference, account standing and current content access at send.
- **Public kinds:** reserve `collection`, `review` and `space` as distinct primary discovery identities. Index only
  owner-approved public metadata and versioned locators, never rules, personal facts, private votes, report evidence
  or copied document bodies. Text uses current title/description or a disclosed review excerpt. Catalogue-only
  predicates remain not applicable for these kinds, including under NOT; do not silently drop predicates. Add kind
  choices to existing Search/Home consumers without a second discovery service or new ranking metric. Existing
  platform gates, native readiness, final disclosure, sparse cursors and canonical destinations still apply.
- **Collections:** only explicitly public/listed Collections with a selected public output qualify; private,
  unlisted, withdrawn and pending-only outputs do not. A pending replacement cannot replace selected public output.
- **Reviews:** one review thread is one `review` result, never a new Subject or a duplicate generic thread result.
  Require independently anonymous-readable current opening, board, Realm/Space and reviewed Subject. A historical
  vote citation is labelled as such and is never today's rating; no numeric rating is required on the card.
- **Spaces:** eligibility is the current anonymous-readable active Space, independent of bearer privileges or
  membership. An optional Realm association is disclosed only through its own current read. A Space without a Realm
  remains a Space; removed containers never fall back to Global or inherit a different container's metadata.
- **Workbench:** begin with an explicitly selected board, using the existing paged Realm board directory rather
  than a new Realm-wide aggregate queue or counts. Reuse Reports/Appeals and their private session lifetimes, separate
  report dismissal from takedown, retain independent appeal review and link to existing ban management. This is a
  navigation and triage workspace, not a new moderation authority or automatic enforcement system.

## Dependencies and delivery

All eight briefs can start against existing contracts. Each includes its native source/commands and consumer where
needed; none consumes code promised by another brief. Shared curation action declarations in pins/slow mode must
merge idempotently. Shared discovery type, mapping and registry edits must compose all delivered kinds; the same
file is not a dependency. Reuse the established complete-generation activation protocol rather than mutating an
active index mapping. Account and Subject behavior and prior wire formats remain covered by their existing tests.

Accounts owns the `board_activity` preference catalogue and standing, Library owns selected Collection output,
Search owns mixed generations and retained Source admission, and Web owns page/session conventions. The briefs
name these seams and include minimal integration changes; missing collaborator runtime support must remain a typed
readiness state, not fabricated empty success. General Realm search predicate planning stays with Search.

Each implementation updates its owner document, writes the few outcome tests named in its acceptance, and updates
an existing nonfrozen test only when its asserted behavior changes. Target 300–500 product lines per slice, fewer
test lines than product lines, and only the named viewer/state stories. Native acceptance and visual integration
remain distinct from source delivery. This planning change contains no product implementation or new test runner.

## Sources read

The linked owner sections and [document contract][document], [deletion contract][deletion],
[board journey research][board-research], [rating journey research][rating-research] and
[moderation journey research][moderation-research] supplied the retained behavior. Source inspection used the
linked registry/type union, board report-placement reader, current Reports reader/page and board moderation route.
Current `git log dev` and Goal status established the scope premise and existing assignments; they are not product
acceptance. No external reference source or legacy implementation is required for these adopted slices.

[goal]: ../goals/content.md
[rating]: ../../services/kernel/src/rating/README.md#aggregates
[search-rating]: ../../services/kernel/src/search/README.md#global-rating-order
[community]: ../../services/kernel/src/community/README.md
[boards]: ../../services/kernel/src/content/README.md#global-boards
[atomic]: ../../services/kernel/src/content/README.md#atomic-content-commands
[notices]: ../../services/kernel/src/content/README.md#notifications
[reviews]: ../../services/kernel/src/content/README.md#reviews
[witnesses]: ../../services/kernel/src/content/README.md#review-backed-question-witnesses
[appeals]: ../../services/kernel/src/content/README.md#appeals
[collections]: ../library-and-collections.md#indexed-filtering-and-disclosure
[library]: ../../services/kernel/src/library/README.md
[search-mixed]: ../../services/kernel/src/search/README.md#mixed-kind-foundation
[registry]: ../../services/kernel/src/search/discovery-registry.ts
[discovery-types]: ../../services/kernel/src/search/discovery.ts
[feeds]: ../feeds.md
[presentation]: ../../services/kernel/src/community/README.md#realm-presentation
[report-lifetime]: ../../apps/web/src/moderation/reports-page-lifetime.md
[appeal-reads]: content-moderation-appeals-design.md#private-appeals-reads-and-recovery
[document]: ../../packages/document/README.md
[deletion]: ../deletion.md
[board-research]: content-threads-boards-design.md
[rating-research]: content-ratings-reviews-design.md
[moderation-research]: content-moderation-appeals-design.md
