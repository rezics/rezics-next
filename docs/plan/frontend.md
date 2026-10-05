# Frontend direction

The current [Goal](../../GOAL.md) centres on the main site and the Accounts site.
This page records the manager's product decisions and their reasons; code
(routes, tokens, components, stories, browser tests) carries the rest, and
[design principles](../product/design-principles.md) the lasting intent.
Revise it as slices are used in a real browser.

## Principles

Revised 2026-09-28 after the maintainer compared the first slices with the old
site, Reddit and Goodreads: they exposed the model instead of the content.

- **Content first, model inside.** Readers see covers, titles, authors,
  ratings in words they know, and what people are saying. Scopes, Contexts,
  generations, count bounds and identifiers stay internal; scope appears only
  where it changes meaning, and model detail sits behind "Details" or "Cite".
- **Cover-first catalogue, Goodreads quality.** The cover is the card; no card
  frame around it. A Work without a cover gets a typographic cover (title,
  author, a type-appropriate palette), never a single-letter monogram. Every
  card shows the author and one primary action. Shelves are curated by meaning
  (genre, community, "readers' favorites"), not by storage type.
- **Honest states, quietly.** Pending, stale, partial and unavailable remain
  visible and recoverable, but phrased for people ("Couldn't load ratings ·
  Retry"), not as system status.
- **Identity before action.** The acting Agent is shown before submit and never
  silently replaced; Studio carries its Agent in the route.
- **APIs own behavior.** A missing or awkward read is fixed in Main or Account.
- **A feed home, like Reddit**; see [Home](#home).
- **Keyboard and CJK.** `/` and Cmd/Ctrl-K; handlers ignore `event.isComposing`;
  `lang` on content blocks; CJK text uses 1.8 line height and `text-autospace`.
- **Reading surfaces are calm.** No grid canvas behind content pages; the Aura
  canvas stays for marketing-style surfaces only.

## Home

Decided 2026-09-28 from research into Reddit, the old site's feed and published
critiques of Goodreads: people come back to track what they read and to get the
next chapter, then to keep up with communities, then to discover.

- **Frame.** Left: the sidebar (see [Sidebar](#sidebar)). Centre: a **Continue** strip (each item opens
  the next unread chapter or a compatible package update), then the feed.
  Right rail: trending in my Realms, Realms to follow, my moderation queue.
- **Tabs.** `Following`, `All`, then the Saved Filters a reader pins (usually
  one Concept) and `+`, as X pins topic timelines; see
  [Concepts and value pages](../contracts/queries.md#concepts-and-value-pages).
  Following · New is strictly chronological and ends with "You're all caught
  up". Recommendations fill a thin Following, labelled with their reason,
  never under Following · New, and can be turned off.
- **One compact control line** under the tabs, as Reddit's: a `Best ▾` menu
  (Best, New, Top; Top adds its period menu on the same line), a `Filters`
  popover (a sheet on phones) with active filters as removable chips on the
  same line. Sorts are not spread into separate buttons. The maintainer
  revised this on 2026-09-28: the separate sort pills and chip rows cost two
  rows of density. Home has one view and no card/compact switch (maintainer,
  later that day): copying Reddit's view modes adds a choice nobody needs.
- **Best** rewards real readers and recent activity but keeps small Realms
  visible: scores are normalised within each Realm and no Realm fills a page.
  The versioned constants live in `services/main/src/modules/feed/ranking.ts`.
- **Posts: X's treatment, Reddit's anatomy** (maintainer, 2026-09-28). No card
  frame and no framed feed container: rows separated by a divider, the whole
  row clickable and tinted on hover (X uses about 3% ink). REZICS posts have
  titles, belong to a Realm and are about a Work, so they keep Reddit's order
  rather than X's avatar column: one meta line (Realm · person · time · what
  happened, with Follow and the overflow menu), the post's own title, at most
  three lines of preview, the Work as an attachment (cover thumbnail and one
  line of title and author), and a bare icon action bar with counts and one
  kind-specific action. The title is the post's subject: a discussion's title,
  "Chapter 212 · its title", a review. Main's feed item has a single `target`
  today, so a discussion shows its Work's title and its own title as the
  excerpt; the API separates the post from the Work it is about. A text post
  measured 237–303 px tall on desktop with seven stacked rows. The first
  rework went too far, to about 80–110 px, and the maintainer found it cramped:
  posts breathe like X's, with X's padding, type size and line height, and
  generous space between meta, title, preview, attachment and actions.
  Comfort wins over fitting more rows. Dense lists belong to catalogues
  (search results, shelves), which may offer a list or grid of Works; they are
  not a feed mode. Repeated updates collapse into
  one post; shelving and ratings without text never become posts; chapter
  posts hide spoilers past the reader's position.
- **Who a post leads with** (maintainer, 2026-09-28). REZICS is not purely
  Realm-centric. Reddit locks a person's identity inside subreddits, which is
  why no CEO's official account, head of state or individual creator is known
  there; on REZICS the person is the speaker and the Realm the venue that
  hosts them. A post's meta line shows both, and either may come first; the
  one that leads gets the icon, the first place and bold type:
  1. the person, when the reader follows them;
  2. *future feature*: the person, when they are a verified or notable
     identity, for every reader (a manually granted flag at first, later a
     follower threshold computed offline; Main has no such flag yet);
  3. the person, when the post has no Realm;
  4. otherwise the Realm: a stranger's name says nothing yet, and Follow sits on
     the same line.

  A Realm's own acts (picks and decisions) lead with the Realm, and a pick
  never names its curator. The rule is deterministic and cheap: Main matches
  a page's cards against the reader's follows in one bounded read, in All as
  in Following, and puts a followed poster ahead of a followed Realm
  (`followIdentities`). A random or weighted choice was rejected: the same
  post would change shape between visits, and readers scan by position.
  Personalising the lead per reader waits for behaviour data. Every person's
  name links to their profile, so a person is as reachable as a Realm. The
  reason pill stays rare: only inside Following, for a followed author's
  news and for suggestions.
- **Never empty.** Signed out: All · Best. A new person picks languages and
  Concepts, which become follows and pinned tabs, and follows suggested Realms
  in one step. Broad fields are Zones, listed in the left navigation; Home has
  no kind chips and no official-Zone chip row.
- **Styled controls only.** No native `<select>`, radio or checkbox in
  features: selects, menus, radio groups, checkboxes and pickers come from
  `@rezics/ui`, enforced by ast-grep rules that `task check` runs, so every
  control matches the design in every browser and theme.

## Sidebar

Maintainer, 2026-10-02. The sidebar is built from the reader's relationships
([Follow, Join and notification](../contracts/community-interactions.md#follow-join-and-notification)),
in this order:

1. **Pinned**: anything followed that the reader pinned, in their order.
2. **Communities and sites**: joined and followed Spaces, most recently active
   first, with new-activity dots. A few show by default; "Show all" expands an
   inline list with a name filter and continuation, and **Manage** opens a page
   for sorting, pinning, notification levels and bulk unfollowing at any count.
3. **Moderation**, for Spaces the reader manages.
4. **Official Zones**, only while the reader follows nothing; afterwards they
   live in Discover.

People, Works and Concepts reach the Following feed, the Continue strip and
Home tabs instead, unless pinned. Each Follow or Join button carries the
notification bell (All, Highlights, Off) and an overflow with Mute and Block.

## Discover

Maintainer, 2026-10-02. Discover is one browse over every resource type, the
same capability as a Zone's browse with the whole catalogue as its population:
one Query compiler, one card set. Type is a Facet: All, Works, Communities,
Sites, People, Lists and Topics. The communities directory is Discover's
Communities tab; `/r` redirects there.

- The first screen is search, then topic chips (followed topics first), then
  sections Main returns, each with its reason: popular in followed topics,
  communities in the reader's languages, new sites. Things the reader already
  follows are not recommended. The frontend names no type: the former Books,
  Guides and Recipes shelves were hardcoded storage types.
- The header's search box is Discover's search (2026-10-03): it opens Discover
  on All with the query, and the former works-only `/search` redirects there
  keeping its query. One search, one result vocabulary.
- Each result uses its type's shared card, the same one rails and lists use (a
  Work shows its cover, authors and rating), never a generic initial tile.
- Personalization uses explicit signals only (follows, languages, library), as
  the [recommendation contract](../contracts/recommendations.md) requires, and
  can be turned off.
- **Topics** use the shared picker below: typing searches Concepts in every
  language; an empty field shows followed and frequently used topics, never an
  alphabet; each result shows its broader Concept and a count; several topics
  combine as removable include or exclude chips that apply at once through the
  URL, without an Apply button.

## Collections at any size

Maintainer, 2026-10-02. An unbounded collection never renders as a fixed slice.
Wherever a list can grow (Realms, Concepts, members, follows, chapters,
editions, rating populations), the UI offers search, continuation, a meaningful
order and an exact or "at least" count; a preview of a few items links to the
complete traversal. Pickers over such lists use the shared asynchronous
`EntityPicker` (a combobox over Main's list convention: `q`, `cursor` and
`limit` in, `items`, `nextCursor` and `complete` out). Main's list reads accept
those parameters, which contract tests check.

- **Rating scope.** Global, the reader's communities and the communities with
  the most ratings for this target come first; "Other communities…" opens the
  picker over every population that rated it.
- The same rule covers choosing a Realm to submit to, the wiki position chooser
  and a community's related communities.

## Work page

Maintainer, 2026-09-30: the Work page is a core entry and the hub; the wiki Zone
is its deep end ([wiki+](../product/goal.md#wiki-the-flagship)). Bangumi's
subject page is the reference; its density is not. The order below comes from
R52's benchmark of Bangumi, VNDB, AniList, MyAnimeList, Douban, Letterboxd,
Goodreads, The StoryGraph and Steam; sections a type does not support are
omitted, and the rest keep stable anchors.

1. **Identity and your next action**: cover, localized name with the original
   quietly, kind, date and linked principal creators; a rating that names its
   scale, count and scope; the selected edition, personal status and progress,
   with one primary action (Continue, Start, Choose release). Follow and Add to
   list stay separate.
2. **About**: a spoiler-safe synopsis, essential facts, a few tags and content
   warnings; full facts, sources and Propose correction on expansion.
3. **Your edition and availability**: the selected release first, a short
   matching list, then "Compare all" into a paginated inventory.
4. **Parts and connections**: the next unfinished part, ordered volumes or
   episodes, then typed sequels, adaptations and relations; publication order is
   distinct from a curator's reading order.
5. **Explore the wiki**: main characters, substantial credits, a timeline or
   chapter-guide preview within the reader's position, and named route links;
   a wiki shortcut also sits near the header.
6. **Ratings and reviews**: the distribution, counts, and the question,
   population and target behind them, the population chosen with the
   [rating scope picker](#collections-at-any-size); filters by release and review language;
   a review never requires a score.
7. **Discussion and communities**: active Work, part and release threads with
   "Discuss this episode" actions; reading needs no membership.
8. **Lists and discovery**: curated lists and reading orders with reasons, then
   explained recommendations; identifiers, provenance and history below.

On phones the cover is a thumbnail beside the title, so identity, edition,
status and the primary action fit the first viewport, and an "On this page"
control replaces overflowing tabs. Status, progress, rating and lists edit in
place with undo; facts and relations edit through proposals. Interface
language, displayed name, release language, review language and voice or
subtitle language stay distinct, and a translated title never implies an
available translation.

Kinds override slots, never add backend products: books and light novels show
translator, publisher, format and volume contents in availability; visual
novels put availability first, where one release must satisfy language,
platform and coverage together, and keep routes and endings behind spoiler
boundaries; anime shows seasons, episodes, broadcast schedule and
subtitle-versus-dub availability; games show platforms, stores, requirements
and DLC; LLMs use Versioned and Measured sections and never a universal star
score; events and places use Scheduled, Located and Offered sections with
calendar and directions actions instead of reading controls. Fan discussion,
review conversation and fact-editing discussion stay visibly distinct, and
moving between them keeps the selected release and spoiler position.

Today the page falls back to books for unknown types, shows a large cover first
on phones, places recommendations before reviews, and requires a Work-level
score for every review; the release schema lacks platform, territory and
structured coverage. The first increment is one bilingual franchise hub (a
volume in two editions, an adaptation, a small wiki and discussion) proving four
journeys on phones and through the API: choose a usable release, update
progress and return to the right next part, open a wiki route within the
spoiler boundary, and read or write a review that names its target.

## Zones

Decided 2026-09-28 from KadoKado (the maintainer's reference), the old site
and how Reddit, Discourse, Fandom, Tumblr and Shopify admit custom code.

- **A Zone is a routed site over shared resources**: its own routes,
  navigation, templates, documents and saved views over the one catalogue, as
  a franchise wiki or a specialist catalogue needs
  ([routed sites](../product/platform-thesis.md#zones-are-routed-sites),
  revised 2026-09-30). A Realm's publication is one preset: named editorial
  modules that read the Realm's curation, where every pick links to the
  decision behind it and covers carry a one-line hook, as KadoKado's do. A
  single configurable home page on fixed Realm tabs could hold neither a wiki
  nor a catalogue.
- **Each Zone presents information the way its field's best site does**
  (maintainer, 2026-09-28). The point of a Zone is its information layout,
  not its colours, and it is never Home's post feed. Fiction and Books follow
  novel sites such as 起点, 晋江, KadoKado and Royal Road: rankings, categories,
  update lists with the latest chapter, status and length. Games follow Steam.
  Mods follow the best mod platform, Modrinth before CurseForge and Nexus:
  search-first browsing by game version, loader and category, with versions
  and dependencies. Software follows the best software directories. Each
  vertical needs a fitting listing, browse and detail presentation, with fields
  from Main's generic projection, never a per-domain payload: per-domain
  payloads are how per-domain fact tables entered the backend. The
  maintainer's 2026-09-29
  [vertical-engine decision](../product/platform-thesis.md#the-vertical-engine-is-the-product)
  refines how: shared default pages and templates, with slot overrides for the
  core families, rather than copied per-vertical implementations. Under
  [backend one, frontend free](../product/goal.md#backend-one-frontend-free)
  a Zone may also ship bespoke presentation code that consumes only public APIs
  and holds no business logic.
- **One visual language.** Zones use REZICS's shared visual language for now.
  A Zone changes colours or type only when it explicitly asks to; until one
  can, the host applies only a Zone's structure tokens, and a test keeps
  package CSS to the platform's colours and faces.
- **Browse beside the home** (2026-09-28, after Modrinth's search). Every Zone
  has a browse route, by default `/z/<space>/browse`
  ([routers](../contracts/space.md#surfaces-and-routers)): search, Facet Conditions, sort and a list or grid,
  each a link with its own URL. Every browse Condition is an admitted Facet
  from Main's registry: type, Concept, status and length. Mod loader, game
  version, environment and dependency Conditions are deferred to correlated
  release statements. A Condition outside the registry is a vocabulary no
  other Zone, client or agent can reuse; Zone browse admits Conditions through
  the shared Query compiler.
  The home leads with its search and those values; the Works tab became
  Browse's grid. Keyset pages traverse all adopted Works through the listing
  projection. Counts say ‘at least’ until traversal finishes with a current
  projection. Title queries match titles in adoption order until ranked title
  search exists; the response records the applied sort and text matching.
  REZICS counts no downloads, so nothing sorts or shows them.
- **Customization tiers.** Every Zone gets theme-token presets and a module
  layout; filtered community CSS is deferred. **Official Zones** may ship full
  CSS and JS as reviewed first-party packages in this repository, rendered
  server-side through named slots and loaded only while their build digest
  holds an active approval (`packages/zone-sdk`). A sandboxed iframe was
  rejected: it can paint only its own box and breaks SSR, SEO, focus and scrolling.
- **Zones that read at a position** (2026-10-01, the franchise wiki). A package
  may declare `positions: { mount }`; the host then puts a position control in
  the Zone's frame, sends the reader's position with every read and leaves all
  withholding to Main, so a slot never filters. The control is links, so the
  choice lives in the address (`?position=<chapter>` or `all`) and each page
  the reader moves to keeps it. Main's default for a reader who has finished no
  chapter, and for an anonymous visitor, is the start, where it withholds every
  record that has a position. The host therefore starts that reader at the
  story's first chapter and says so, since an empty wiki teaches nothing and
  chapter 1 is what any first page of the book reveals. Pages that are not
  Works are the generic resource page inside the frame or the package's
  `entity` slot, chosen by Main's page projection and never by a type; their
  data are the reads Main returned, and a read that failed leaves its part out.
- **Scoped judgments on pages** (2026-10-05, decisions 51–53 of the
  [semantic model](../contracts/semantic-model.md#identities-variants-and-projections)).
  A subject's page keeps its own question and every place it has been rated in
  apart: one region holds the subject's figure, the choice of a place to rate it
  in, each place's figure and, per Work, a combined view that names its formula
  and coverage. A place has a page of its own (a projection) that leads with the
  subject and where, then the facts that hold there grouped by how far each
  reaches, most specific first (Main's `frameMatch`, never a web rule), then its
  questions, reviews and discussion. Every score, on every page, is one figure
  with one set of rules (`scoped-rating/score.ts`): the mean only when Main
  published it, to two decimals; below the display threshold the count and how
  many more ratings reveal it; with none, nothing drawn, never a zero or an empty
  histogram. A person's own rating is read from Main (`scope=mine`) and a stale
  write retries once on the head Main names, so no device remembers either.
  A continuity is read as the address says (`?continuity=<id>`, `off` to turn a
  default off), is off unless chosen, and reaches Main as the reads' `frame`; a
  Zone package may name a default by the name its Work gives it
  (`continuity: { default: 'Canon' }`), and the switch sits beside the position
  control. Event pages look for their participants through Main's reverse
  statement read (who takes part in the event or in one it belongs to), because
  Main lists no projections by frame; where that read refuses or answers
  nothing, or the reader is not signed in, the page ranks no one rather than
  guess.
- **Safety.** Each official Zone keeps a complete token-and-layout fallback, a
  reader opt-out and a safe-mode URL; a kill switch works globally, per theme
  and per viewer; a nonce CSP; gzipped budgets with Core Web Vitals and
  accessibility checks.
- **Official Zones.** Fiction first, then Books, Mods and AI Workshop, each
  backed by an official Realm so its picks are public decisions; Software and
  Kitchen start on tokens; Screen follows.

## Languages and themes

The UI ships the old site's eight locales (`apps/web/i18n/define.ts`), separate
from content languages. Translation may use cheap models; English fallback is
not acceptance of an incomplete catalog under the
[native-language decision](../contracts/content-languages.md#one-native-language-contract).
"Realm" stays a product name in English, like Reddit's
"subreddit"; other locales use their plain word for a community, since readers
should not have to learn the model's vocabulary. The locale is a path prefix so
each language version of a public page has its own indexable URL with
`hreflang` alternates; content language belongs to a version and never enters
the route. [URLs and SEO](../product/urls-and-seo.md) owns durable identifiers,
aliases and readable suffixes, canonical redirects and eligible alternates. Signed out, a
language select and a theme button sit in the header; signed in, they live in
the account menu and settings. The account menu (maintainer, 2026-10-02) puts
identity first (the acting Agent and switching), then profile, library, Studio
and notifications, then **Language ›**, **Appearance ›** and **Content
preferences ›**, then settings, account and sign out. On desktop the arrows
open submenus; on phones the bottom sheet pushes a second panel with a back
control, as YouTube's account sheet does. Content languages and adult-content
switches are settings, reached from Content preferences, not quick toggles. Zones may carry their
own themes, which people can turn off.

**Natively multilingual, not bilingual** (manager, 2026-09-28, after the
maintainer's review and a full audit found en and zh-Hans complete and the six
other locales about a quarter English). Every UI string ships in all eight
locales in the change that adds it; a missing key fails the check instead of
falling back silently. Content takes any BCP 47 language: no shape, enum,
check constraint or seed type may fix a set of languages, and no text is
stamped `en` unless it is English. Server-sent text (email, notifications,
consent) is written in the recipient's locale. Search analyzes each language
on its own terms (CJK segmentation, Simplified/Traditional folding, accent
folding). The demo seed is native too: Works, people, communities and reviews
in several languages with translated titles and more than one language version,
each in its own language, never two glued together.

**Names show in the reader's language, one at a time** (maintainer,
2026-09-28, after "Fiction · 小说" appeared site-wide). Realm, Zone,
Organization and Concept names, rule titles and descriptions are stored per
language (open BCP 47 tags, one marked original), never glued into one string.
A read picks each field independently in this order: the page's explicit
`?language=`, the reader's ordered content languages, the UI locale, the
browser's languages, then the object's original name. A tag matches exactly
first, then by language and script (`zh-TW` is `zh-Hant`), then by primary
language only as a marked fallback (`zh-Hant` may show a `zh-Hans` name, never
presented as Traditional; see
[vocabulary labels](../contracts/content-languages.md#vocabulary-labels-are-graph-content)). Reads return the chosen
value with its language, direction and whether it was a fallback, so pages
set `lang`/`dir`. The original appears as a quiet second line only where
identity matters (a Work's or Realm's own page), never in lists. People keep
the one display name they choose; a romanization is an alias on the author
page. The old site's order (`../rezics`, `use-localization-languages.ts`)
is the precedent; unlike it, fields fall back one by one.

## Identity and administration

The Studio Agent switcher, the publish dialog and Realm role impact previews
are in code. These decisions wait for their surfaces and follow the
[acting identity layers](../contracts/identity-and-access.md#acting-identity-layers):

- **First sign-in** asks for the public name on an empty, required field and
  fills nothing from the Account; no Person exists until it is submitted, and
  handle suggestions come from the typed name only. The Account's own name and
  email appear on no page, and the identity picker lists every Agent Main
  returns for the person, whatever it may publish.
- **Publishing defaults** are set per task and content profile in settings,
  prefill the publish form for that operation only, and say which Agent is
  used when a saved default is no longer eligible.
- **Organization administration** keeps members, groups, roles, bindings and
  representation distinct; presets may bundle administration with
  representation for small organizations. Granting to an organization differs
  from granting to its eligible members. People pick an identity and a task;
  the server finds the proof and never reveals other controllers' accounts.
- **Institutional voting** shows the seat, its current weight, the chosen
  representative and the approval rule, never a copy of the weight per
  representative ([votes](../contracts/votes-and-references.md)). A prepared
  ballot survives expired authority or another representative's change and
  asks for refresh and reapproval.

## Accounts site

A separate app (`apps/accounts`) on the Account origin, in the spirit of Google
Account: sign-in, sign-up, recovery and OAuth consent for every REZICS product,
the account centre and the operator admin panel. It proxies the Account
service's API on the same origin, so the Account session cookie never lives on
a product origin. It is not indexed, so its locale comes from `?hl=`, a cookie
and `Accept-Language` rather than a path prefix.

Maintainer, 2026-10-01: sign-up uses **Display name**, email, password and
confirmation in separate full-width rows, followed by the policy acceptance
and submit action. Account's name is a nickname/display name, not a legal-name
requirement or automatic public Agent name. Birth date is requested when a
feature needs it, rather than as a required sign-up field. Keep the applicable
registration admission and policy acceptance at the API boundary.

Content settings offer four independent switches: **General**, **R15**,
**Adult sexual content (R18)** and **Graphic/grotesque content (R18G)**.
General starts on and never asks for age. Each restricted switch requests a
missing birth date when enabled; cancellation preserves the previous setting.
Return to the initiating setting or content after the request is completed.
When any other flow records an eligible birth date, R15 defaults on only if the
person has not explicitly set its preference. Explicitly switching it off
survives later birthday edits and age checks. The adult switches default off
and never enable one another. A known birthday is reused across these flows,
although a market may require stronger evidence for a particular feature.

Personal information accepts a complete calendar birth date and lets the
person choose whether to publish it. It defaults private; recording a birthday
or enabling a content category never publishes it. Publication is an explicit
choice that creates a shareable birthday page, with a preview of the complete
date and a way to invalidate the link. It does not publish Account identity. Birthday visibility and age eligibility are independent.
The [suitability owner](../contracts/classification-judgments.md#suitability-and-disclosure)
and [Account owner](../services/account.md#birth-date-and-content-preferences)
record the API responsibilities. The Accounts implementation includes tested
cancellation, independent adult choices, complete-date editing and publication
states. Main consumes the latest Account qualification for reads and internal
search; public indexing and previews retain the anonymous audience.

## Stack

React with vinext's Next.js-compatible App Router on Vite, deployed to
Cloudflare Workers; the Workers app hosts rendering, sessions and the BFF,
and domain commands stay in Elysia Main on Bun. The [stack comparison](../research/application-stack.md#frontend-options)
records vinext's compatibility gaps. Data fetching follows
[web organization](../development/web-features.md#data-fetching). Screens are
reviewed in light and dark, desktop and phone, English and a CJK locale.

## Presentation modes and settings

Decision 16, product manager under maintainer delegation, 2026-09-29.
Simple, Advanced and reserved Agent mode are viewing Account preferences:
feature override, then global default, then Simple. The API never takes a mode,
and modes grant no authority. Advanced increases density in the spirit of GitHub;
settings on both sites are searchable. Material consequences remain visible in
every mode and ordinary edits retain advanced saved state.

The reason is to make common tasks direct while keeping the full capability
available. [WAI disclosure guidance](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
supports accessible progressive disclosure; it is not evidence that a particular
layout or density has passed usability testing.
