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

Decision: retain only accepted cursor coordinates in tab-local memory, keyed by canonical account, contribution
view, locale and publication state; keep eight predecessors plus the current coordinate, reuse the localized First
page label, and translate Previous in all eight supported locales.

## Public contribution window navigation

Posts, Reviews and Discussion navigate through the existing named account route. One explicit movement retains the
route's existing anonymous plan: `POST /v1/pages:read` for the named composition and overview, then one replacing
`GET /v1/accounts/{id}/posts?limit=20&cursor=…` or
`GET /v1/accounts/{id}/threads?kind=review|discussion&limit=20&cursor=…`. First omits the cursor. The list endpoint
is Content's `author_posts.list` or `author_threads.list`; no cursor chain, row point reads or additional page bodies
are retained. Collections and Realms keep their current readers.

The live visit stores at most eight accepted predecessor cursor strings and one current coordinate (nine coordinates
total), each within the route's 4096-character cursor limit. A direct cursor address starts with no predecessor.
Only an admitted native replacement moves the history; failure keeps the exact attempted target for Retry and leaves
the last accepted coordinates in place. The rendered replacement contains at most twenty contributions. Tab-local
state does not contain rows, excerpts, disclosures, private advice or action state, and does not survive a reload.
Canonical handle redirects carry a pending coordinate only when the resolved canonical account, view and locale match;
a different account retires the prior visit.

## Cost: public contribution cursor movement

- **Touches:** One named `POST /v1/pages:read`, one overview `POST /v1/pages:read` and one anonymous native list read for the selected cursor; Posts use `author_posts.list`, Reviews and Discussion use `author_threads.list` with the selected `kind`.
- **Bound:** At most 20 contributions replace the displayed body; at most 9 cursor coordinates are retained. Reads do not grow with cursor depth or account history.
- **Growth check:** The served-route acceptance advances and rereads exact native cursors on Posts, Reviews and Discussion, checking the bounded request set and replacing row window.

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

## Private selected actions

Decision: use one installed-callable adapter per surviving public occurrence, keep native command owners on their
original operation lease through advice/projection failure, and preserve exact profile return in the existing history entry.

`contribution-actions/wire.ts` derives both request and response from the installed public
`accounts({accountId})['contribution-actions'].post` callable. The BFF prepares the viewer's current credential;
its private no-store response never enters the anonymous document. `receiver.ts` consumes only that document's
actual `actionSelection`, caps the cohort at twenty, freezes author/view/cursor/proof/references and coalesces refreshes.
Failure retries that input. Retirement aborts reads, clears private advice and rejects late completion.
`getSnapshot` returns the last published state by identity until a subscription fires; origin away is fenced by
`isCurrent` and `subscribeCache`, never by a paired React read. Existing host/receiver tests pin that; no extra stories.

The host uses Web's `browserObservation` and `subscribeCache` plus address/read/operation leases. Session fetching,
invalidation, equal successful replacement and A/B/A retire the original reader synchronously. The named anonymous
source query has the same custody: fetching, invalidation, removal or any successful replacement retires its advice,
even when structural sharing retains equal response objects. Page, source, row, publication, credential, locale,
QueryClient and navigation replacement cannot adopt an earlier unresolved command. Unmount retires immediately;
remount acquires a new visit. Public links remain usable while private advice is unavailable.

Sign-in and private read recovery appear once per contribution page. Sign-in preserves the actual path, cursor,
query bytes and hash. Advice retry reads only the same selected input; counts, advice and independent durable readback
never acknowledge a write.

`contributions/row-actions.tsx` matches the original public author, view, place, thread/opening and selected revision
against the anonymous selection and the private selected response. Missing, withheld, denied, sign-in-required,
not-applicable, unavailable, failed and retired remain distinct. Reaction counts and the own slot must be explicit;
a missing own slot is not null and missing counts are not zero. Both exact set and clear operations are required.

- Watch uses `ThreadWatch`; a Post watches its containing thread and opening revision.
- Reactions use `ThreadReactions` and its native one-slot queue, freshness and receipt recovery.
- Report uses `PostActions` with the exact selected resource/revision and current page verification. Its native owner
  retains private text, body, sender, credential and key across uncertainty.
- Reply uses `PostComposer` and `ReplyIntent`, targeting the selected Post as immediate parent or the original opening
  Post for a Discussion/Review. Its thread, parent, draft, credential, key and operation lease remain original.
  Private visit drafts are not restored from another visit.

A refresh may disable new commands without replacing an admitted owner. The row keeps its last known watch/reaction
projection for that occurrence when a section becomes unavailable, while current advice controls new admission.
The existing native owner alone offers deliberate exact retry/discard. A replacement lease receives fresh advice
and no retained intent. Exact profile view/cursor/query/hash and surviving occurrence focus remain owned by
`contributions/navigation.ts`; changed or missing occurrences use its existing recovery notice.
