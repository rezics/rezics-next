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

Content owns `author_posts.list` / `author_threads.list`. Their installed schemas currently omit a bounded parent
card and public conversation activity; the thread schema permits `reviewContext`, but the author-page producer
does not assemble it. The receiver can present admitted shared review/parent context when supplied by the owner.
Missing context has a named unavailable seam (`AUTHOR_CONTRIBUTION_CONTEXT_OWNER`) and retains the original
contribution destination. It never resolves parents recursively or fetches a reviewed Subject per row.

Content must supply the smallest bounded author-page projection: current admitted reviewed Subject, historical
question/vote revisions, immediate parent with its own spoiler/language and exact revision, and public conversation
activity. Accounts continues to own public identity and publication choices. A separately hydrated native viewer
slot/allowed-action contract is required before this receiver adds private controls; the existing profile/follow
and reader lifetimes keep their current authority. No private state is added to the anonymous document.

The examples are prepared presentation states, including unavailable context. They are not native eligibility
evidence. Native and browser acceptance remains with integration execution.
