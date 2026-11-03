# Core web component parity

The retained implementation is compared with both earlier REZICS apps. This is a source comparison and an implementation
plan, not a visual acceptance result. Phone/desktop rendering, browser interactions and frozen acceptance are deferred
to integration. The action-bar and shell dependency commits are ancestors of the retained base. The phone navigation
lives in `apps/web/src/shell/phone-navigation.tsx`; there is no `bottom-nav.tsx` in this implementation.

## References and method

The legacy reference is `legacy-final:apps/web/features/`, read with Git without checking out or merging that branch.
The older repository is `/home/edge/projects/rezics/rezics`, read in place without modifying or running it. Paths in the
next table are relative to each reference root. Only user-facing component families are compared; API clients, test
helpers and translated message files are not separate core components.

| Family                              | Legacy sources inspected                                                                           | Older repository sources inspected                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed and actions                    | `apps/web/features/feed/card.tsx`, `post-row.tsx`, `actions.tsx`                                   | `apps/web/features/content-feed/components/feed-card.tsx`, `feed-card-actions.tsx`, `apps/web/features/content-feed/model/feed-reaction.ts`                           |
| Replies                             | `apps/web/features/feed/reply-tree.tsx`, `reply-composer.tsx`                                      | `apps/web/features/posts/reply-thread.tsx`, `post-list.tsx`                                                                                                           |
| Composer                            | `apps/web/features/post-composer/composer.tsx`                                                     | `apps/web/features/posts/subject-post-composer.tsx`                                                                                                                   |
| Shell                               | `apps/web/features/shell/bottom-nav.tsx`, `empty-state.tsx`                                        | `apps/web/features/application-shell/components/header-actions.tsx`, `apps/web/features/application-shell/header-search.tsx`, `libraries/ui/src/custom/app-shell.tsx` |
| Shared action/navigation primitives | Feed actions and phone navigation above                                                            | `libraries/ui/src/ui/action-bar.tsx`, `bottom-navigation.tsx`                                                                                                         |
| Concepts and tag voting             | `apps/web/features/concept/concept-page.tsx`; feature-path inventory has no dedicated tags feature | `apps/web/features/tags/components/tag-vote-controls.tsx`                                                                                                             |

The supplied older `components/header-search.tsx` path is absent. The actual `application-shell/header-search.tsx`
contains its context and page override registration, and was inspected instead. Large components were inspected by
relevant line ranges and function/interaction declarations. No external product survey or new design system is needed:
the two requested repositories and [the UI design bars](../../packages/ui/README.md) define the comparison.

## Action bar

The best earlier combination is the older app's grouped up/score/down control and legacy's dense, wrapping row,
filled selected arrows, compact Share and explicit primary action. Our shared `FeedActionBar` already keeps the
native reaction engine, report/author ownership, admitted reply and Library destinations, Continue and sign-in return
addresses. Unlike the older connected bar, it never hydrates every feed row with a separate reaction request.

The retained changes close the presentation differences that can be addressed using installed data:

- Vote presentations use a compact smile-plus picker with the same localized React name and complete choice list.
  It keeps additional reaction kinds that our native contract admits. Ordinary reaction-chip surfaces keep their
  text picker. Scores still come exclusively from supplied upvote/downvote counts; missing maps show a dash.
- Share is an icon on phones and keeps its text on wider screens. Successful copying changes its glyph to a check,
  announces success and leaves the Share name stable. Pending work disables the control and exposes `aria-busy`.
  Native cancellation still does not copy; clipboard denial still exposes a selectable URL and returns focus on Close.
- Phone/coarse targets remain at least 44px, fine-pointer desktop votes stay dense, reply pills can remain plain,
  and controls wrap rather than requiring a horizontally scrolling toolbar. Pressed states use the existing ink blue.
- Unknown writes, rollback, source/session retirement and the owner-provided overflow menu retain their existing
  behavior. Reporting stays inside overflow. No local-only hide or mute success is introduced.

The older bar's reply counts and target-specific primary actions need admitted producer fields. Legacy's undoable
feedback also needs delivered commands. These remain in the [feed continuation](../../.temp/continuation/feed-context-parity.md),
including reaction-map production, and are not represented as working capabilities by this presentation change.

## Shell

The strongest earlier combination is the older app's prominent Create and foldable following groups with legacy's
five phone destinations and emphasized center action. Our root already composes one shared shell: persistent rail,
header search, counted notifications, account/display controls, skip navigation and phone navigation.

Create now uses a primary button in the header, with its text at desktop widths, and a primary center capsule on the
phone. Current phone destinations use ink blue. Press feedback and destination/chevron transitions honor reduced
motion. Followed Realm and Space headings independently fold with the installed shadcn Collapsible, start expanded
and preserve their existing names and 44px targets. The heading remains a heading and its trigger exposes expansion
semantics. Folding introduces no new read or preference storage. Unknown sessions reserve account-control space with
skeletons; failed sessions show an explicit visible message instead of appearing to load indefinitely.

The existing shell retains safe-area bottom padding, page-bottom clearance, locale-safe segment matching, unavailable
Library/Collections destinations, private read lifetime guards and the existing desktop rail preference. Menus keep
phone sheets and desktop anchoring through the shared Menu. Category icons deliberately follow the shell owner
contract: earlier following avatars/favorites are not inferred from missing data. Account menu, creation registration,
header search protocols and native route admission remain with their owners.

These decisions are owned by [the shell](../../apps/web/src/shell/README.md),
[feed](../../apps/web/src/features/feed/README.md) and [UI](../../packages/ui/README.md) documents.

## Complete core-family comparison

“Retained” means the installed source already provides the behavior or this change closes its presentation gap.
“Continuation” identifies an actionable brief for the remaining difference. It does not imply browser verification.

| Core component                        | Better earlier behavior                                                                                                                                     | Retained source and comparison                                                                                                                                                                      | Remaining work                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Feed card frame and post row          | Legacy's consistent row rhythm, title above preview, independent actions; older FeedCard separates header, target and action slots                          | `features/feed/home-feed-item.tsx`, `feed-results.tsx` and UI `content-item.tsx` retain semantic ordered rows, title destination, metadata, actions and responsive visuals                          | Retained structure; richer context belongs to feed continuation below                                        |
| Feed metadata and attribution         | Legacy labels why an item is present and its venue; older FeedCard can disclose multiple attribution/Realm contexts                                         | Current Home adapter preserves supplied author/avatar, kind labels, source and occurrence attributes, but cannot reconstruct those earlier context lists or reasons                                 | [Feed context](../../.temp/continuation/feed-context-parity.md)                                              |
| Covers, avatars and attachments       | Both earlier apps separate small identity visuals from a Work target; older target preview is independently linked                                          | Current `Cover`/`ContentItem` reserve visual space, retain media ownership and independent metadata/actions; Home preserves disclosed author images and reviewed-Subject links                      | Multiple attribution and richer target metadata use feed context; no generic cover rewrite                   |
| Rating and review context             | Older target rating identifies Realm/population and count rather than an unexplained score                                                                  | UI rating bars already require population/count/threshold, and Home keeps review destinations and reviewed-Subject context; Home does not receive a rating summary to render                        | Supplied rating projection only, in feed context; never invent aggregates                                    |
| Continue/progress and primary actions | Legacy offers the action appropriate to chapter, release, prompt, review or Work                                                                            | Home preserves its real Continue link and progress; Work Library goes to its installed Subject slot; callers retain extra actions                                                                   | Additional native kinds and admitted primary-action projection in feed context                               |
| Votes/reactions                       | Both have one viewer vote, grouped arrows and score, filled selection; legacy restores refused votes                                                        | `VoteControl`/`ThreadReactions`/UI `Reactions` retain serialized one-slot writes, real settlement, rollback and recovery, plus compact picker                                                       | Retained controls; Home producer map remains feed context                                                    |
| Reply action                          | Older bar includes supplied reply count and opens discussion; legacy keeps inline reply intent                                                              | Current shared bar supports an existing callback or link and preserves thread reply ownership; no reply count is fabricated                                                                         | Supplied counts in feed context                                                                              |
| Share                                 | Legacy uses a check after copying; older app offers native sharing/copy status                                                                              | Current bar adds compact phone icon and check while retaining stronger cancellation, stale-visit and manual-copy recovery                                                                           | Retained                                                                                                     |
| Overflow/report/feedback              | Legacy has undoable hide/mute; older overflow adds save and report                                                                                          | Current overflow reuses report/author ceremonies and Library owners; unavailable feedback is explicit                                                                                               | Actual hide/mute/Undo and projection in feed context                                                         |
| Reply body, byline and parent context | Legacy has readable bodies, parent links, folding and bounded continuation; older reply tree uses branch affordances                                        | `threads/thread-reading.tsx` retains chronological posts, body/media/bylines, anchors and shared actions; `reply-context.tsx` has explicit, guarded parent disclosure                               | [Reply branches](../../.temp/continuation/reply-branch-parity.md); chronology must remain available          |
| Reply trees                           | Legacy folds low-scoring/deep branches and offers continuation; older tree groups supplied parents and paginates                                            | Current thread reader is a flat ordered list with parent context, not an equivalent browsable branch presentation                                                                                   | Reply branches, using only supplied relations; no automatic low-score hiding without a native score contract |
| Composer and editor                   | Legacy recovers local drafts and keeps writing language independent of UI language; older subject composer handles language, subject and publishing context | Current `threads/composer.tsx` supplies rich editing, fallback textarea, media failure recovery, admission and immutable uncertain-write recovery; its local component state is not reload recovery | [Composer recovery/language](../../.temp/continuation/composer-draft-parity.md)                              |
| Tag voting                            | Older TagVoteControls has Fits/Does not fit, clear, score/count, pending state and optional spoiler assessment                                              | Legacy concept page and current source-concept explorer concern classification/exploration, not equivalent viewer tag votes                                                                         | [Tag votes](../../.temp/continuation/tag-vote-parity.md); do not relabel source concepts as community votes  |
| Empty/route/error/loading states      | Legacy EmptyState has an icon, explicit heading/description and next steps; older post lists distinguish pending/error/empty                                | Current `StatusPage`, `PendingPage`, `error-state.tsx` and `FeedResults` retain separate outcomes, localized recovery and noindex/error metadata; route panels have plainer visual hierarchy        | [State panels](../../.temp/continuation/state-panel-parity.md)                                               |
| Header/search/account/unread          | Older header has strong Create, notification count and restoring state; legacy shares global shell                                                          | Current `top-bar.tsx`, root shell and existing header-search retain supplied search, sign-in/account, distinct restoring/unavailable states, display controls and counted inbox                     | Retained; creation emphasis closed here                                                                      |
| Rail and following                    | Older rail collapses and groups following; legacy supplies persistent navigation                                                                            | Current shell retains rail preference and bounded identity-bound following, and now folds named groups                                                                                              | Retained under current category-icon contract                                                                |
| Phone navigation                      | Legacy has five destinations and a raised center action; older primitive reserves safe area and uses real focus targets                                     | Current `phone-navigation.tsx` has five destinations, selected ink blue, emphasized Create, unread count and phone menus; it uses links for destinations                                            | Retained; no conversion of navigation to tabs                                                                |
| Menus, popovers and sheets            | Older components provide motion, dismissal and focus; legacy supplies compact overflow                                                                      | Current shared Menu supplies desktop popover/phone sheet, Escape/back/trigger focus and touch rows; changes continue using it                                                                       | Retained                                                                                                     |
| Selection action bar                  | Older `ui/action-bar.tsx` is a floating **selection** toolbar, not the feed engagement row                                                                  | UI `selection-bar.tsx` supplies count/actions/cancel and phone overflow; its bottom offset relies on a caller CSS variable while our phone shell reserves its own bottom height                     | Shell-safe selection placement in state-panel continuation                                                   |

## Continuations

Each brief copies this assignment's routing front matter, replaces its paths/acceptance/estimate and specifies one
bounded deliverable of roughly 2,000–3,000 changed lines. The estimates are implementation budgets, not instructions
to inflate test or documentation size. Native capabilities that have not landed use explicitly supplied props or
callbacks; the browser must not invent endpoint names, private projections or local success.

| Brief                                                                  | Size                   | User outcome                                                                                                |
| ---------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Feed context](../../.temp/continuation/feed-context-parity.md)        | 2,800 lines / 14 files | Feed cards disclose available reasons, context, reply counts and owner actions; missing data remains honest |
| [Reply branches](../../.temp/continuation/reply-branch-parity.md)      | 2,400 lines / 10 files | Readers can follow and fold supplied reply branches without losing chronological reading                    |
| [Composer recovery](../../.temp/continuation/composer-draft-parity.md) | 2,700 lines / 12 files | Drafts survive reload safely and writing language is explicit                                               |
| [Tag votes](../../.temp/continuation/tag-vote-parity.md)               | 2,200 lines / 10 files | Readers can assess a tag where a real owner supplies voting state and callbacks                             |
| [State panels](../../.temp/continuation/state-panel-parity.md)         | 2,100 lines / 11 files | Empty/error/loading states have consistent hierarchy and selection controls clear phone navigation          |

Stories for the changed controls live in `Patterns/Feed/Action bar` and `Patterns/App Shell`: signed in/out, voted,
refused, plain reply, unavailable votes, copied link, phone/dark/long strings, keyboard, folded communities, counted
notifications, phone Create and restoring/unavailable headers. Existing recovery tests retain the unchanged cancellation/manual-copy and lifetime
assertions. Visual equivalence still requires the integration verifier at phone and desktop widths, both themes,
long localized text and reduced motion; a source comparison alone cannot establish pixel or accessibility parity.
