# Social reading and comfortable feeds

Observed 2026-09-28. This is product evidence for the [frontend direction](../plan/frontend.md), read beside the [query contract](../contracts/queries.md) and the current web implementation. I used one new BrowserOS tab for public pages and saved viewport captures in `.temp/research/social-reading/`. A visible page supports a layout observation; a site's own help or product page supports a feature description. Neither establishes that a feature is pleasant in regular signed-in use. I did not create an account or interact with an external form.

## References

### Goodreads — a Work is the centre of the social graph

[Pride and Prejudice](https://www.goodreads.com/book/show/1885.Pride_and_Prejudice) leads with a large cover, title, author, rating and one prominent **Want to Read** action. Counts of people reading and planning to read make the Work feel inhabited; author, highlights, related books, then reviews extend that path. The public [home](https://www.goodreads.com/) offers title/author/ISBN search, genres and editorial lists before sign-in. The book's review area separates friends/following from community reviews, so a known person's opinion has a place before the aggregate. Captures: `goodreads-book-clear.jpg`, `goodreads-book.jpg`.

The first visit also produced a sign-up modal over the book. After dismissal, a large advertisement still pushed the author and reviews below the initial viewport. The useful lesson is the cover/action/review sequence, not the interruption. Its book-specific ISBN, editions and purchase controls cannot be the generic REZICS Work template.

### StoryGraph — choose by reading feel and reflect on habits

The public [Explore page](https://app.thestorygraph.com/browse) lists cover, title, author, edition facts, reading status and mood/pace labels in each row; its filter opens from one compact control. The public [product page](https://www.thestorygraph.com/) shows reading charts and describes mood search, private reading journal, challenges, content warnings, DNF/owned states, lists and progress-gated buddy-read reactions. These are distinct needs: discovery, private reflection and social reading. Captures: `storygraph-browse.jpg`, `storygraph-about.jpg`.

The [public profile](https://app.thestorygraph.com/profile/thebookendreviews) and [challenge listing](https://app.thestorygraph.com/reading_challenges) met a security-verification page in BrowserOS. I did not inspect their live layouts; the captures `storygraph-profile.jpg` and `storygraph-challenges.jpg` record the limit. The site's [changelog](https://roadmap.thestorygraph.com/changelog/private-books-) also documents private books staying in personal totals while leaving profile, shelves and the news feed. That separation is more useful than copying the charts' visual style.

### Letterboxd — make a person's taste visible

Letterboxd's [Welcome guide](https://letterboxd.com/welcome/) describes the diary (a dated log), reviews, watchlist, favorite films, public lists, followed people's activity and stats. Its [public profile example](https://letterboxd.com/moviediarycc/) exposes favorites, diary, reviews, lists, activity and a rating distribution. The first route into a meaningful feed is to find a review you like, follow its author, then see that person's activity. Lists and a diary also make a quiet profile worth returning to; they do not depend on posting every rating into a global feed.

BrowserOS showed security verification for the [home](https://letterboxd.com/), Welcome guide and profile, so these feature descriptions come from Letterboxd's published pages, not a live visual inspection. Capture: `letterboxd-welcome.jpg` shows the access limit. The guide's paid stats are a product packaging choice, not evidence that REZICS should gate personal reading history.

### X — repeatable feed rhythm and a clear timeline choice

The public [Goodreads profile on X](https://x.com/goodreads) shows an avatar/header, short bio, follower counts, follow action, post tabs and a narrow centre column with side suggestions. Posts did not finish loading in this session, so the capture `x-public-profile.jpg` supports the profile anatomy only. X's [timeline guide](https://help.x.com/en/using-x/x-timeline) documents the simple **For you / Following** switch, recommendations from outside the network and returning to the last open tab. Its [thread guide](https://help.x.com/en/using-x/create-a-thread) describes connected posts and a route to the full thread. The useful pattern is a stable text column with one obvious way to choose recommendation versus follow scope, and context preserved when a post opens.

The guide itself met security verification in BrowserOS; `x-timeline-help.jpg` records that limit. I used the published guide for timeline behavior and did not use the account-specific Home that the browser session could access.

### Bluesky — profiles are navigation, starter packs solve the cold start

The public [Bluesky profile](https://bsky.app/profile/bsky.app) has readable divided posts, a pinned orientation post, media/video/feed/starter-pack tabs and a compact right rail. Its [orientation thread](https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l) gives the opening post more space and engagement detail, then repeats a compact avatar/name/time → body → actions rhythm for each continuation. Link previews have a bounded card within the text column; consecutive posts and replies stay together. Captures: `bluesky-profile.jpg`, `bluesky-thread.jpg`.

Bluesky's [starter-pack explanation](https://bsky.social/about/blog/06-26-2024-starter-packs) combines recommended people **and** feeds in one shareable entry point. Its [notification controls](https://bsky.social/about/blog/07-02-2025-more-notification-control) distinguish interaction kinds and who may trigger them. The transferable idea is a community-curated start plus reader control over attention, not an unrestricted feed-generator platform.

### Reddit — a community has a recognizable front door

The public [r/books page](https://www.reddit.com/r/books/) pairs a banner and identity with highlighted recurring threads, a post list, community description/rules and bookmarks. The [weekly FAQ thread](https://www.reddit.com/r/books/comments/1wrhcg3/weekly_faq_thread_september_27_2026_how_do_you/) opens with a clear title, context and flair, then offers comment sort/search above the nested discussion. The [home](https://www.reddit.com/) can show posts before a person follows anything. Captures: `reddit-books.jpg`, `reddit-thread.jpg`, `reddit-home.jpg`.

This is a strong pattern for a Realm's front door: tell a newcomer what happens here, which conversations recur, and where to start. On the sampled desktop page, the banner, highlights, post list and side rail competed for space; Home need not repeat the entire community frame for every post.

### Discord forums — a thread has a purpose before it has replies

Discord's public [Forum Channels article](https://discord.com/blog/forum-channels-space-for-organized-conversation) and [FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ) show titled posts, tags, search, post guidelines, list/gallery layouts, pins and topic-specific notifications. A moderator's first example post teaches what belongs in a forum. Captures: `discord-forums.jpg`, `discord-forum-faq.jpg`. A live forum channel required a server context; I studied the published screenshots and guidance, not an authenticated channel.

For REZICS, Realm discussion should have a named question and Work context where applicable. Forum tags help navigation, but Concepts and query Facets must retain their meaning; a moderator's tag vocabulary should not silently become a universal classification.

### What makes the sampled feeds comfortable

- **One reading measure.** X and Bluesky reserve a stable centre column for posts; Reddit uses a wider one because titles and comment previews need it. REZICS's signed-in Home already has that central lane. Test its mixed CJK and Latin post line length on a phone before changing widths.
- **Predictable row order.** A brief identity/context line, body, bounded media or Work attachment, then quiet actions lets the eye learn where to look. Bluesky's thread repeats it; Reddit's post adds a title. REZICS needs Reddit's subject and Work context with the breathing room of its current Home direction.
- **Keep context on the next screen.** A full Bluesky thread retains its opening post, while Reddit carries the community, title and rules into the discussion. REZICS should keep Realm and Work context when opening a feed item, and preserve the reader's route back to the feed.
- **Attention is selectable.** X distinguishes recommended and followed timelines; Bluesky has pinned feeds and notification controls; Reddit highlights recurring threads. The reader needs predictable Following, explicit recommendations and control over which events interrupt them.

## First five minutes: the combined lesson

| Moment | Evidence | REZICS implication |
| --- | --- | --- |
| Before sign-in | Goodreads search, StoryGraph Explore and Reddit Home all expose real material. | Keep `All · Best` useful and let a visitor open a Work, Realm, review and thread. |
| First choice | StoryGraph asks what feels right; Bluesky starter packs add people and feeds together; Letterboxd suggests following through a review. | Ask for reading languages and a few Concepts, show example Works and voices, then offer Realms to follow in one step. |
| First return | Goodreads shelves, Letterboxd's diary and StoryGraph's journal/challenges give a reason to return without writing a post. | Lead with Continue and the reader's Library; separate private tracking from public expression. |
| Empty state | A feed is thin until follows exist, while public discovery remains available. | Show a sample of the chosen scope and a concrete follow action; state when chronological Following is caught up. |

These are design inferences from visible and published flows. A first-run session with actual new REZICS users is still needed to test whether the proposed choices can be made quickly and understood later.

## What REZICS should adopt

The labels below distinguish **keep** (already in code or the current frontend direction) from **build**. “Main” answers whether new server-owned data or a new read contract is needed; a UI-only change is marked “No.” Proposed behavior should be verified in a browser with seeded first-run and returning-reader journeys before promoting it to a product decision.

| Priority | Surface | Concrete change and reason | Main |
| --- | --- | --- | --- |
| P0 · keep | Home, Work page, reader | Keep the unframed, comfortably spaced post rows and cover-first Work header; retain one shelf/read action, reviews, ratings, Continue and spoiler-aware chapter handling. These already answer much of the Goodreads/X lesson. Do not bring Goodreads's modal or ad placement into reading pages. | No; existing feed/Work/reader APIs. |
| P0 · build | Onboarding, Home | Replace the current six fixed `InterestKind` choices with Main-served Concepts/Saved Filters as the query contract requires. Show one example Work and a sample post for each choice, preselect suggested Realms with an explanation, then land on a populated Following view. The current three-step picker already handles languages and bulk follows; this changes what the first step means. | **Yes:** Saved Filter identities, labels, preview/suggestion read and follow targets; retire fixed kind matching. |
| P0 · build | Home, Realm, Work page | Make a feed row's post title, author, Realm and linked Work distinct from the Work attachment. On opening, keep the post's parent/thread and Work context visible. This completes the direction already recorded for Main's single-target feed limitation and makes review/chapter/discussion posts legible without guesswork. | **Yes:** post/Work references and typed attachment summary in a versioned feed read. |
| P0 · build | Profile | Add a public, permission-aware **Recent activity** section after the person's Works or shelves: written reviews, curated lists and substantive Realm posts, with a compact Work cover and a link to the original. Allow the owner to hide private reading. Current profile code leads with credited Works and shelves but has no activity section, so it tells what someone owns/read more clearly than what their voice is like. | **Yes:** bounded agent activity read joining existing reviews/posts and disclosure; new stored data only for new activity types. |
| P1 · build | Work page, profile | Put reviews from people the reader follows ahead of the broad review list when any are readable; expose the broader list and current rating/review filters unchanged. Goodreads makes a familiar opinion easy to find, while the aggregate still helps a new reader. | **Read contract:** follow-filtered review page with the same policy and cursor guarantees; no new stored relation. |
| P1 · build | Library, profile, Discover | Give a public list its own title, short reason, ordered Works, curator and shareable page. Keep today's private/custom shelves for personal organization; publish a list by explicit choice. Letterboxd lists make taste and discovery visible without turning every shelf edit into a post. | **Yes:** list identity, ordered membership, visibility, revisions and discovery read. |
| P1 · build | Realm, Zone, Manage | Place a short purpose, posting guidance, pinned starting thread and recurring discussions above a Realm's forum list. Keep Zone's editorial layout distinct. Reddit's highlights and Discord's post guidelines let a newcomer read and contribute with context. | **Yes:** if pinned/recurring thread and guidance fields are absent; use existing thread data and Realm permissions for the rest. |
| P1 · build | Notifications | Add reader-facing controls for replies/mentions, followed people, followed Realms, reviews and recommendations, including “people I follow” where meaningful. Keep today's grouped rows, unread marking and mark-all-read; the Main preference route already exists, so first wire it through the UI. | **No new stored data initially:** use `/v1/me/notification-preferences`; extend purpose/actor policy only for a demonstrated missing category. |
| P1 · build | Reader, Library | Add optional private progress notes and an explicit “share as review/post” action. A mark-read event stays quiet. StoryGraph's journal and Letterboxd's diary show that reflection may precede publication; REZICS already tracks chapter progress. | **Yes:** private, versioned notes tied to a readable chapter or Work; publication remains a separate command. |
| P2 · build | Search, Discover, Zone | Offer mood, pace and relevant content warnings as admitted Facets for book-like Works only, with visible provenance and an “unknown” state. StoryGraph's browse works because the descriptors help choose a read; fixed client-side mood chips would violate the query contract. | **Yes:** attributed values, Facet definitions and bounded query support. |
| P2 · build | Profile, Library | Add a small opt-in favorites row and a dated reading history, with private items excluded and honest totals. Letterboxd gives a visitor a quick taste signal and the owner a memory aid. Do not equate a book finished with a public recommendation. | **Yes:** favorite ordering and a disclosure-aware history read; existing progress/shelf events may supply the history. |
| P2 · evaluate | Library, Realm | Pilot one personal reading goal and one Realm challenge, with clear progress and privacy. StoryGraph demonstrates a return loop, but challenges should follow evidence that readers want them across REZICS's varied Work types. | **Yes if piloted:** challenge identity, eligibility, progress and visibility. |

**Already as good or better for this product:** the [frontend direction](../plan/frontend.md#home) gives Following · New a real end, labels recommendations and keeps them out of its chronological lane; Home's unframed post rhythm and one control line avoid extra feed modes. The [Work implementation](../../apps/web/features/work-page/work-views.tsx) already connects ratings, reviews, discussion and reading, while the [reader](../../apps/web/features/work-page/reader-client.tsx) has per-chapter progress. The [Library](../../apps/web/features/library/library-page.tsx) has status and custom shelves, privacy and Continue; [notifications](../../apps/web/features/shell/notifications/notifications-view.tsx) already group repeated events; [profiles](../../apps/web/features/profile/profile-page.tsx) already show credited Works and readable shelves. These should be completed and observed before adding new decorative controls.

The signed-out local [Home](http://localhost:3000/en) shows the planned three-column structure, a first-visit follow invitation, one sort/filter line and post rows (`rezics-home.jpg`). Signed in locally as seeded Daniel, Home opens with Continue and a Following feed (`rezics-home-daniel.jpg`); [Library](http://localhost:3000/en/library) offers status and custom shelves, current reads, followed authors and row actions (`rezics-library-signed-in.jpg`). His [profile](http://localhost:3000/en/@daniel_chen) leads with credited Works and reading shelves, but no recent reviews or posts (`rezics-profile-daniel.jpg`). These were desktop snapshots of seeded data, not a first-run usability study.
