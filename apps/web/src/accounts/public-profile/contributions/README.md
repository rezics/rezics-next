# Public contribution reading

Posts, Reviews and Discussion remain separate native account views with their own cursors. Discussion uses
Accounts' `publicViews.posts` authority; Reviews uses `publicViews.reviews`. Missing profile publication choices
refuse these views. The receiver caps Content windows at twenty rows and never turns a title into an identity.

Decision: reuse the anonymous page and public profile identity; absent native card context stays unavailable,
without point reads or inferred viewer actions, and return focus belongs to the exact existing history entry.

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

`contribution-actions/receiver.ts` validates the anonymous page's actual `actionSelection`, caps its cohort at twenty,
retains the original author/view/cursor/proof, and coalesces refreshes. Failure keeps that exact input for retry.
Retirement aborts the read, clears retained private state and guards late completion. It does not normalize missing
own slots or acknowledge writes. The page host now supplies only the anonymous source's actual selection and retires
on page, read, record, publication, credential, locale, QueryClient and navigation replacement. It never derives
native references from rendered rows. When the source selection or installed method is absent, the host stays
unavailable and exposes no inferred controls.

At declaration head `25f7c27445d37078c22b4066a7fe9f64396b53c4`, installed `@rezics/client` resolves to
`packages/client` version `0.1.0`; `src/kernel/zones/http.d.ts` has no `author_contributions.actions` declaration.
The production wire remains unavailable until the complete-input publisher supplies that public method and DTO.
The closed response adapter, existing native command-owner connections and accessible action presentation remain
for the continuation. This reader does not add private fields to anonymous documents.
