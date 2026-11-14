# Web and Auth interfaces

## Outcome

People can discover, contribute, discuss, collect and buy through accessible, localized interfaces, using the same
capabilities and disclosure rules on every page and device.

This is the manager-facing scope and acceptance index. Linked module documents own detailed contracts and current
producer availability. Read the relevant owner section for an assignment; do not load every linked document into a
manager opening or worker prompt. Operational evidence and unresolved handoffs belong in the current continuation.

Decision: this documentation-only relocation preserves product, native and visual acceptance under the linked
owners; verification here covers the diff, formatting, links and headings, with manager-opening measurement separate.

## Delivery constraints

Deliver complete independent frontend outcomes through Goal; confirm worker process and first product source, and
refill while workers write. Preserve original attempts and singular owners. The campaign target is 50,000 useful
added product lines/hour under [efficiency](../development/efficiency.md#output-and-flow); never manufacture volume.
During the authorized source-only window, optional checks/review do not hold unrelated coding. Keep strict product,
authorization and money contracts. Source, installation, checks, visual review, publication and promotion are distinct.

## Done when

- The site and Auth applications run locally through documented commands. Routing, navigation, localization and
  shared UI/document components provide a usable shell in every launch locale.
- Every launch vertical has subject pages from shared definitions/composition, search, facets and typeahead, plus
  boards, threads, posting/replies and scoped community, Zone, moderation and notification surfaces.
- Collections, personal Library, independent labels, holdings, progress and explicit publication work through their
  real APIs. Filters remain available wherever the common Collection abstraction appears.
- Book discovery/catalogue, personal Library, complete books and hosted-novel authoring and reading work through
  their owners' real APIs. One shared Studio serves books and columns with drafts, editing, revision history and
  comparison, preview and explicit publication. Books add ordered nested TOC, chapter add/reorder/move and navigation;
  columns retain article/series presentation. Authors publish a frozen TOC selection with exact body revisions.
  Later draft edits leave public reading unchanged and unselected drafts private under ordinary authorization.
  Public readers get frozen chapters, stable exact chapter links, progress and continue reading. Mounted author and
  reader journeys are a separate gate from [Content native acceptance](content.md#acceptance). Record parity meeting
  or exceeding read-only `../rezics` at `95167ceab` and a demonstrable improvement, such as exact links surviving moves
  with atomic published-revision selection. A flat first slice is insufficient. This does not open paid publishing,
  Notion, Concept, unrelated article rollout or general Search expansion.
- The Collection editor supports bounded destination/occurrence-anchor browsing, exact duplicate-preserving transfer
  review, atomic native transfer and bounded source/destination recovery. A Subject reader inspects containing public
  Collections using native exact total/opaque continuation, opens one and returns, and adds the Subject to a later
  owned curated Collection. Composed Members nodes provide explicit bounded continuation, canonical deduplication,
  actual new-visible announcements and keyboard focus recovery under their owner contract.
- Checkout start/return and entitlements expose commerce outcomes without treating redirects as fulfilment. Creator
  Sales supports exact supplied-sale inspection, localized offer/Subject navigation and fresh admitted browser return
  to the same opaque cursor. Charged unit/tax meaning, settlement, timestamp and payout remain distinct; statements
  retain independent period/line authority. Fixed-Edition buyers return to the exact order/entitlement detail and both
  independent list positions through route state and fresh private admission, leaving canonical reader URLs public.
- Auth supports sign-in, sign-up, consent, security settings and step-up through Accounts. Signed-out private routes
  keep safe sign-in redirects; indeterminate sessions show unavailable with a safe sign-in link and run no private
  loader. Session BFF, upload completion and every download preserve caller identity and current API decisions.
- Private Library export and separate entry/private-label, Collection and progress recovery visits work through
  installed owner APIs. Completed export bytes stay bound to the signed-in owner; another account cannot inherit
  them. Upload the original archive admitted by the installed native version contract. Native Web owner and other-
  member fixtures prove export-to-restore through actual pages and Kernel readback. Unsupported fields confer no
  action. Personal provider imports retain explicit reviewed Library-state and independent score consent.
- Realm appearance retry retains the original file only in that caller and finishes the same reservation for that
  Realm. Purpose stays the caller slot; a rejected image drops retry without saving appearance.
- Pages provide useful preparation, empty, denied and unavailable states. Metadata, sitemaps, sharing and safe JSON-LD
  reflect only permitted public representations and agree with rendered content.
- Reviewed running pages and recorded-response stories demonstrate accessible phone/desktop layouts, both themes,
  representative content and all eight launch locales. Scoped outcomes are on main with recorded checks covering the
  promoted commit. Specified, implemented, exposed, tested and promoted remain distinct states.

## Scope

Owns `apps/web/**`, `apps/auth/**`, `packages/ui/**` and `packages/document/**`: shell, product routes, shared
UI/documents, Library pages, BFF/media transport and SEO. Follow [public scope](../scope.md),
[Subject pages](../subject-pages.md), [catalogue editing](../catalogue-editing.md) and [SEO](../seo.md).

Web owns the shared book/column Studio and reader. Content owns hosted structures, Post revisions, publication and
large-serial scale, reusing Knowledge structure; Semantic owns Book/Series/Edition bibliography; Commerce owns
personal Library. [UI](../../packages/ui/README.md) and [document](../../packages/document/README.md) own shared
components. Search owns Search composition and templates; agree named slots and sequence edits in shared features.
Accounts owns Auth behavior; Content owns media and communities; Semantic owns definitions and Zones. Correct shared
visual defects as a class while retaining domain differences.

<a id="mixed-home-delivery"></a>
<a id="home-content-item-presentation"></a>

### Mixed Home

The [Home owner](../../apps/web/src/features/feed/home.md) owns selectors, lifetime, bounded return, cost and positive
default acceptance; [mixed cards](../../apps/web/src/features/feed/README.md#reading-a-mixed-home-card) and
[ContentItem](../../packages/ui/src/components/content-item.md#public-api) own presentation. [Feeds](../feeds.md)
owns native wire, predicates and disclosure. Search owns retained Source/Space coverage; Content owns feed/review
witnesses and question admission; Web keeps the sole consumer. Preserve conjunctive exact kind/Space/question,
page20/candidate160, independent ready sources, private no-store/current-reader fences, and no browser qualification,
refill or per-row hydration. A directory, helper or safe refusal does not prove the positive installed default path.

### Second-scope interfaces

The complete admitted second scope remains required: saved dynamic queries, advanced Collection facets, resource
scopes, Realm rating order, board pins, native Board opening, slow mode, thread watch, Following target reading,
Collection/review/Space discovery, Home return and moderator workbench. The
[second-scope plan](../research/web-second-scope-plan.md) is supporting decomposition, not another contract authority.
Extend existing routes independently against stable owner seams; only truly missing producer APIs hold final binding.

<!-- prettier-ignore -->
| Journey | Detailed owner |
| --- | --- |
| Saved query create, reopen, owner management and explicit publication | [Saved-query directory](../../apps/web/src/library/saved-query-directory.md#save-and-reopen-a-query), [results](../../apps/web/src/library/saved-query-results.md) |
| Common advanced facets and retained operands | [Library filters](../../apps/web/src/library/README.md#collection-filters) |
| Reviewed resource scopes, selected labels and rating populations | [Scope editor](../../apps/web/src/search/resource-condition-editor.md), [Search](../../apps/web/src/search/README.md#filters-and-condition-authoring), [rating population](../../apps/web/src/search/rating-population.md) |
| Pins, opening, slow mode and watch | [Pins](../../apps/web/src/threads/board-pins.md), [opening](../../apps/web/src/threads/board-opening.md), [slow mode](../../apps/web/src/threads/slow-mode.md), [watch](../../apps/web/src/threads/README.md#thread-watch) |
| Following inspection and public discovery | [Following](../../apps/web/src/library/following-reading/README.md), [Collection directory](../../apps/web/src/library/public-collection-discovery.md), [mixed discovery](../../apps/web/src/search/discovery-public-results.md) |
| Moderator directory, queues, exact cases, appeals, history and affected-author receipt | [Directory](../../apps/web/src/moderation/workbench-queue/README.md), [cases](../../apps/web/src/moderation/workbench-case.md), [moderation](../../apps/web/src/moderation/README.md) |
| Bulk review keyboard recovery and bounded-memory integration regression | [Moderation regression](../../apps/web/src/moderation/README.md#bulk-review-focus-regression) |

## Owner contracts

These are authoritative detail destinations, not mandatory opening reads. Current installed interfaces and remaining
producer gaps live with these owners; do not copy historical availability snapshots back into this index.

<!-- prettier-ignore -->
| Journey | Detailed owner |
| --- | --- |
| Shared navigation and Subject purchase entry | [Shell navigation](../../apps/web/src/shell/README.md#navigation-contributions), [purchase slot](../../apps/web/src/features/pages/README.md#subject-purchase-entry-slot) |
| Composed member continuation | [Page composition](../../apps/web/src/features/pages/README.md#composed-member-continuation) |
| Collection placement and containing-Collection return | [Placement](../../apps/web/src/library/collection-placement-journey.md), [Subject Collections](../../apps/web/src/library/subject-collection-journey.md) |
| Library shelves, native preferences, active progress and descriptive facts | [Library](../../apps/web/src/library/README.md), [Progress index](../../apps/web/src/library/progress-index-windows.md), [episode checklist](../library-episode-progress.md) |
| Export, archive recovery and personal list import | [Private export](../../apps/web/src/library/private-export/README.md), [entry/labels](../../apps/web/src/library/archive-entry-recovery.md), [Collections](../../apps/web/src/library/archive-collection-recovery.md), [imports](../../apps/web/src/library/personal-list-import.md) |
| Commerce reader lifetimes, offer/Edition review, sales and buyer return | [Creator reading](../../apps/web/src/checkout/creator-sale-reading.md), [buyer history](../../apps/web/src/checkout/buyer-history-navigation.md) |
| Realm members, current bans, claim review and My Realms | [Members](../../apps/web/src/community/members/README.md), [bans](../../apps/web/src/community/realm-ban-lifetime.md), [claims](../../apps/web/src/community/realm-claim-current-review.md), [My Realms](../../apps/web/src/community/my-realms-lifetime.md) |
| Realm/Space current composition, catalogue/ranking handoff and selected publication | [Page lifetime](../../apps/web/src/community/space-page-lifetime.md), [catalogue entry](../../apps/web/src/community/realm-catalogue-navigation.md), [publication](../../apps/web/src/community/realm-publication-lifetime.md) |
| Graph selection, exact return and catalogue family recovery | [Graph](../../apps/web/src/features/pages/graph-browser/README.md#selection-and-return), [catalogue editing](../catalogue-editing.md) |
| Resource/acting-as/transfer identity and lifecycle fixture reconciliation | [Resource access](../../apps/web/src/accounts/resource-access/README.md#recognizable-and-exact-identity), [lifecycle](../../apps/web/src/accounts/lifecycle-controls/README.md) |
| Auth transfer hierarchy and action-adjacent warnings | [Auth](../../apps/auth/README.md#operator-transfer) |
| Subject ratings, populations and sourced classification/Character identity | [Subject pages](../subject-pages.md#scores-on-pages) |
| Private ratings and classification inventories | [My ratings](../../apps/web/src/ratings/own-votes/README.md), [classifications](../../apps/web/src/ratings/own-classifications/README.md) |
| Subject community citations/actions and native conversation activity | [Community](../../apps/web/src/features/pages/subject-community-entry/README.md), [activity](../../apps/web/src/threads/thread-activity/README.md) |
| Server drafts and current-context post history | [Drafts](../../apps/web/src/threads/own-drafts/README.md), [history](../../apps/web/src/threads/post-history-lifetime.md) |
| Settings watch inventory and current Inbox context/individual acknowledgement | [Settings](../../apps/web/src/settings/README.md#watches), [Inbox](../../apps/web/src/inbox/README.md) |
| Ordered Source closure and useful default coverage | [Search Source delivery](../../services/kernel/src/search/README.md#source-closure-delivery-order) |

<a id="adopted-quality-round-three-requirements"></a>
<a id="adopted-core-page-experience-requirements"></a>

### Adopted experience requirements

[Quality round three](../research/quality-round3-backlog.md), its 91-class crosswalk,
[family migrations](../research/home-and-list-items.md#ordered-complete-implementation-slices) and the
[core-page audit](../research/page-needs-api-render-audit.md) remain adopted under the linked owners. The
[shared identity/disclosure contract](../../packages/ui/README.md#identity-and-disclosure) and
[bounded page experience](../../apps/web/src/features/pages/README.md#bounded-page-experience) retain common rules;
module owners retain every unique requirement. Missing producers, dropped admitted fields and withheld fields
require different remedies. Source-present repairs keep original acceptance; stale publication creates no duplicate
writer. Settings/Inbox stay Performance-owned, Search controls Search-owned and native authority producer-owned.

## Dependencies and evidence

Use installed typed client/owner APIs, exposure discovery, session BFF, definition releases, presentation profiles and
composition slots. Validate at HTTP, imported-record, external-file and third-party boundaries. Agents/internal
callers are trusted; repair resolve/merge/regenerate/normalize failures where the right result can be produced. Keep
strict authorization and money guards. A necessary refusal must identify its prevented defect and attempts/hour cost.

Consumer source may proceed against settled contracts while producer installation is tracked separately. Missing
methods stay explicit and unavailable until normally generated publication arrives; do not invent browser endpoints,
handwritten client declarations or success authority. Recorded fixtures refresh with their producers. Illustrative
success and unavailable seams cannot prove positive native delivery. Preserve original task/dependency identities.

The [quality review](../research/terra-period-quality-review.md),
[critical-path review](../research/critical-path-attempts-review.md) and
[catalogue follow-up](../research/catalogue-family-quality-followup.md) retain their bounded evidence, revisions,
capture counts and rejected images. Source inspection, authored fixtures, historical captures and matching filenames
prove neither current native/browser/visual/privacy/growth acceptance nor public delivery. Never reuse rejected or
wrong-viewport captures as proof. Keep one authority per topic.

## Ownership

Web owns Storybook publication, publisher/capture custody and reconciliation of retained handles. A handle without
its original live process is dead. Keep one finite build/deployment, preserve terminal failures, return the complete
artifact, then verify public `build.json` and canonical story indexes before reporting live links. Metadata clients use
a descriptive application User-Agent. Follow [publication transport](../development/storybook.md#review-publication-cadence).
Review publication does not establish native journey, visual or main-promotion acceptance.

## Acceptance

Mounted Book acceptance separately proves discovery/catalogue and personal Library through real owner APIs, then
Studio drafts, nested TOC/chapter moves, revision editing/comparison, preview and explicit frozen publication. Public
readers follow exact chapters after moves, save progress and continue; later private drafts stay private and do not
change the publication. Record the parity/improvement required above. Neither Content's native gate nor a flat slice
substitutes for these mounted journeys.

Run focused interface/integration suites through owning app/package runners. Connect native
[page](../../specs/pages-outcomes.test.ts), [Search](../../specs/search-outcomes.test.ts),
[Library](../../specs/library-outcomes.test.ts) and [media](../../specs/content-media-outcomes.test.ts) outcomes to their
running pages. Review screenshots and Storybook in all launch locales, both themes and phone/desktop, including
keyboard, assistive technology, reflow, loading, empty, preparing, unavailable and hidden-resource states.
[Verification](../development/verification.md) owns commands/cadence; automated assertions do not establish visual
quality. Auth capture filenames keep existing desktop names and the light-login phone name; other phone captures
use `<state>.<locale>.<theme>.phone.png`. A full Web check is required only when the task contract names it.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit; local passes,
source delivery and publication alone do not complete this Goal.

## External conditions

Production Worker bindings, storage, abuse prevention and deployment configuration arrive through supported
interfaces. Private provisioning is external; functional and visual acceptance uses isolated fixtures.
