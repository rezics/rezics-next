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

The earlier grouped vote control and dense wrapping action row remain useful presentation references. The retained
`FeedActionBar` keeps native reaction, report, author, reply and Library ownership. It uses installed data only and
does not hydrate every feed row with a separate reaction request. Phone targets remain at least 44px, controls wrap,
unknown writes retain their recovery, and clipboard refusal exposes a selectable URL with a deliberate close action.
The delivered feed projection and its reserved data seams are documented in the
[Feed owner](../../apps/web/src/features/feed/README.md).

## Shell

The shell keeps one shared rail, header search, notifications, account/display controls, skip link and phone
navigation. Create emphasis, selected phone destinations and independent following-group folding use current shell
contracts. Phone-navigation clearance now observes one shell-owned navigation element and supplies a scoped value to
fixed selection surfaces; [the shell owner](../../apps/web/src/shell/README.md#phone-navigation-clearance) records
safe-area, SSR fallback, desktop and standalone behavior. This source review does not establish rendered parity.

## Delivered and reserved component owners

| Component family | Retained behavior and owner |
| --- | --- |
| Feed rows and attribution | Ordered rows, supplied authors, source labels and occurrence attributes are owned by the [Feed implementation](../../apps/web/src/features/feed/README.md). Missing producer data is not reconstructed in the browser. |
| Reply context and branches | Chronological reading stays with [thread reading](../../apps/web/src/threads/README.md); guarded parent disclosure and bounded page branches are owned by [reply context](../../apps/web/src/threads/reply-context.md). |
| Composer and draft recovery | The [thread owner](../../apps/web/src/threads/README.md#browser-only-writing-recovery) documents browser-only writing recovery, current-visit retry and the limits of recovery across reloads. |
| Empty and route states | Feed empty, preparing, unavailable and error states belong to the [Feed owner](../../apps/web/src/features/feed/README.md); shell route-state presentation remains in the [shell owner](../../apps/web/src/shell/README.md). |
| Generic tag controls | Generic tagging remains reserved by the [Semantic capability contract](../../docs/goals/semantic.capabilities.md); source-concept browsing does not imply community tag votes. |
| Selection review and results | The [Library owner](../../apps/web/src/library/README.md) records exact bounded selection, native review ownership and distinct supplied outcome groups. |
| Shared selection bar and navigation | The [UI SelectionBar](../../packages/ui/src/components/selection-bar.tsx) composes with the [measured shell clearance](../../apps/web/src/shell/README.md#phone-navigation-clearance). |

## Review boundary

This document records source review and links each behavior to its delivered or reserved owner. It does not claim
rendered review, browser interaction, screenshot parity or frozen acceptance. Those checks run through the integration
workflow at phone and desktop widths, both themes, long localized labels, keyboard focus and reduced motion.
