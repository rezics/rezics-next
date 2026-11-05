# Public contribution reading

Posts, Reviews and Discussion remain separate native account views with their own cursors. Discussion uses
Accounts' `publicViews.posts` authority; Reviews uses `publicViews.reviews`. Missing profile publication choices
refuse these views. The receiver caps Content windows at twenty rows and never turns a title into an identity.

Decision: reuse the anonymous page and public profile identity; absent native card context stays unavailable,
without point reads or inferred viewer actions, and return focus belongs to the exact existing history entry.

Decision: when the original contribution or its exact destination no longer survives on return, show and focus a
recovery notice in that public contribution region while preserving the current account page and cursor.

Decision: bind return focus to the public occurrence's native author, place, row, opening, thread and immediate-parent
revision identities in the existing history entry; a repeated row ID and destination URL cannot identify a replacement.

`ContributionRow` uses the shared ContentItem family, bounded public attribution, historical review details,
immediate-parent presentation and document spoiler renderer. Review citations describe publication history, not
the author's current rating. Native thread/post IDs and exact revision IDs select destinations independently of
display labels. A replacement page/revision remounts disclosure controls. Profile return preserves the original
locale, view, cursor and query bytes and restores the exact surviving link without overriding newer focus.

## Native context seam

Content owns `author_posts.list` / `author_threads.list`. Their source response schemas now add bounded
`parentContext` to posts and `conversationActivity` to both lists. Parent states reuse `FeedParentContext`:
no parent is `opening`, admitted parents carry exact revision/language/spoiler/excerpt with a null optional
author, and undisclosed or changed parents are `reply`/`withheld`. Activity reuses the public exact/lower-bound
count and last-contribution clock. The thread schema permits `reviewContext`, but this author-page producer
does not yet assemble historical review context. The receiver can present admitted shared context when supplied.
Missing context has a named unavailable seam (`AUTHOR_CONTRIBUTION_CONTEXT_OWNER`) and retains the original
contribution destination. It never resolves parents recursively or fetches a reviewed Subject per row.

The existing `ContributionRow`, `PublicReplyParent` and `feedConversationActivity` readers accept this additive
source shape through their existing public record seam. Installed declarations remain the shared complete-input
publisher's responsibility; source integration does not assert that a new declaration head is installed.

Content must supply the smallest bounded author-page projection: current admitted reviewed Subject, historical
question/vote revisions, immediate parent with its own spoiler/language and exact revision, and public conversation
activity. Accounts continues to own public identity and publication choices. A separately hydrated native viewer
slot/allowed-action contract is required before this receiver adds private controls; the existing profile/follow
and reader lifetimes keep their current authority. No private state is added to the anonymous document.

The examples are prepared presentation states, including unavailable context. They are not native eligibility
evidence. Native and browser acceptance remains with integration execution.

## Private selected reader

Decision: the local `AuthorContributionActionsWire` defaults to unavailable until the complete-input publisher
installs the native method and DTO; the initial receiver retains only an immutable native selection per episode.

Decision: resume installed row adaptation only when the public client includes both the callable and anonymous
`actionSelection`; retain the prepared native compositions and existing focused host assertions until then.

`contribution-actions/receiver.ts` validates the anonymous page's actual `actionSelection`, caps its cohort at twenty,
retains the original author/view/cursor/proof, and coalesces refreshes. Failure keeps that exact input for retry.
Retirement aborts the read, clears retained private state and guards late completion. It does not normalize missing
own slots or acknowledge writes. The page host now supplies only the anonymous source's actual selection and retires
on page, read, record, publication, credential, locale, QueryClient and navigation replacement. It never derives
native references from rendered rows. When the source selection or installed method is absent, the host stays
unavailable and exposes no inferred controls.

Installed `@rezics/client` resolves to `packages/client` version `0.1.0`. Its mounted Content declarations must
include `author_contributions.actions` and the anonymous page's `actionSelection` before adaptation can begin.
The production wire remains unavailable until the complete-input publisher supplies that public method and DTO.
The closed response adapter and exact native command-owner connections require the admitted native mounted
contract and official installed callable closure. Recorded adapters do not constitute that delivery. Existing
native destinations and their reaction/watch/report/reply writers remain the way to review current native advice.
This reader does not add private fields to anonymous documents.

## Current page custody

The existing host uses Web's `browserObservation` and `subscribeCache`; it has no separate session event policy.
The shared observation retires advice during invalidation/fetching, equal successful replacement and observed
A/B/A, even when React batches the intermediate states. Local address/read/operation leases keep the selected
public account, original cursor, publication, source, locale and bounded rows separate from the signed-in viewer.
A read does not require a mutation credential. An operation lease fences the original reader and credential; it
is not action advice or an authorization grant. Native writers must still admit the exact operation themselves.
Retirement aborts owned reads and releases their listeners, retained response and page references. Unmount cleanup
retires synchronously; effect replay and remount acquire a new page visit. A replacement reader reacquires the
current original selection instead of adopting a previous response or uncertain command.

Decision: show sign-in and private recovery once per contribution page, leaving each original public destination
usable while private advice is unavailable. The sign-in return keeps the actual path, cursor query bytes and hash.
Preparing, unavailable and retired notices describe private advice rather than claiming that the public page failed.
Retry refreshes only the same admitted page input; readback never acknowledges a native write.

## Exact native advice preparation

Decision: prepare exact occurrence and operation selection against the installed native reading-page contract;
leave contribution response adaptation and production controls unavailable until the official mounted callable and
DTO are published, rather than inventing a contribution response type.

`contribution-actions/advice.ts` derives its contribution response alias from the mounted account method. That
alias is `never` on the current installed declaration. Its separate native advice selector uses the existing
`ReadingPageResponse` declaration and does not accept the receiver's unknown wire result. It requires the exact
reader, target, source revision, action and operation together. Missing advice, denied advice, withheld advice,
failure and retirement stay distinct; duplicate references or operations cannot admit a command. A Post's watch
target is its containing thread with the original thread revision. Original-occurrence matching also checks the
author, public availability, place, containing thread and first-post revision against the admitted selection.

`contribution-actions/presentation.tsx` prepares separate denied, missing, withheld, sign-in-required, not-applicable,
unavailable, retired and failed notices. Current allowed advice alone can expose a native control; failed advice
offers a read retry rather than a command retry. These are native reading-contract presentation inputs, never an
adapter for the selected receiver's unknown result. Production does not mount these prepared controls yet.

The prepared watch control also requires an exact surviving occurrence and the original host's current operation
lease. It delegates the command, captured reader/credential, uncertain recovery and deliberate retry to `ThreadWatch`.
A Post uses its original containing thread and opening revision. A status read cannot settle its uncertain command;
the native owner retains that command for exact retry. A successful watch needs fresh advice before its inverse can
appear. No native writer, transport or session observation is copied into this account module.

Decision: the prepared native reaction picker requires both exact set and clear advice, because the existing picker
can issue either operation; one operation's admission cannot stand in for the other.

`contribution-actions/reaction.tsx` composes `ThreadReactions` for original Discussion, Review and Post occurrences.
It requires the original operation lease and the mounted native `reaction:set` action with `thread.set_reaction` /
`thread.clear_reaction` or `post.set_reaction` / `post.clear_reaction` respectively. Slots and counts are explicit
prepared inputs, never parsed from the receiver's unknown response. The native owner retains an uncertain choice,
reader, credential and key through advice/count echoes; deliberate retry replays that command before a current point
read can reconcile its projection. The account module owns no reaction transport or recovery engine. A supplied
projection watermark keeps the native owner's existing settlement rule.

Decision: account replies target the selected post's containing thread and exact row as parent, or the original opening post for a Discussion or Review; reports keep the selected row and revision.

`contribution-actions/report.tsx` composes current `report:create` / `report.create` advice with `PostActions` for
that exact selected row and revision. `PostActions` retains private report details, sender, credential, key and
target across an uncertain result; a later advice read cannot settle it or replace its retry operands. Current
denial prevents a new report while the original report owner remains available for deliberate retry or discard.

`contribution-actions/reply.tsx` composes current `post:create` / `post.create` advice with `PostComposer` and its
existing `ReplyIntent`. The command keeps the original thread, immediate parent, draft and operation lease. Local
draft restoration is off for this private visit; a replaced operation lease remounts the composer with fresh advice
and no earlier uncertain intent. Advice readback never acknowledges the native write. Both compositions are
prepared for the official mounted adapter; production remains unavailable until the publisher installs the public
callable and DTO.

The mounted contribution response adapter and production controls still require the publisher's official callable
and DTO. Existing public links and the shared host retirement and recovery notice continue to own the production
journey meanwhile.
