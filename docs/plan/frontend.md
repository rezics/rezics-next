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

- **Frame.** Left: followed Zones and Realms with new-activity dots, official
  Zones, Manage for moderators. Centre: a **Continue** strip (each item opens
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
  happened, with Join and the overflow menu), the post's own title, at most
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
- **Never empty.** Signed out: All · Best. A new person picks languages and
  Concepts, which become follows and pinned tabs, and follows suggested Realms
  in one step. Broad fields are Zones, listed in the left navigation; Home has
  no kind chips and no official-Zone chip row.
- **Styled controls only.** No native `<select>`: menus and selects use
  `@rezics/ui` Select and Menu, enforced by a lint rule, so every control
  matches the design in every browser and theme.

## Zones

Decided 2026-09-28 from KadoKado (the maintainer's reference), the old site
and how Reddit, Discourse, Fandom, Tumblr and Shopify admit custom code.

- **A Zone is a Realm's publication**, built from named editorial modules that
  read the Realm's curation; every pick links to the decision behind it, and
  covers carry a one-line hook, as KadoKado's do.
- **Each Zone presents information the way its field's best site does**
  (maintainer, 2026-09-28). The point of a Zone is its information layout,
  not its colours, and it is never Home's post feed. Fiction and Books follow
  novel sites such as 起点, 晋江, KadoKado and Royal Road: rankings, categories,
  update lists with the latest chapter, status and length. Games follow Steam.
  Mods follow the best mod platform, Modrinth before CurseForge and Nexus:
  search-first browsing by game version, loader and category, with versions
  and dependencies. Software follows the best software directories. Each
  vertical needs its own listing, browse and detail presentation, and the
  fields to fill them come from Main.
- **One visual language.** Zones use REZICS's shared visual language for now.
  A Zone changes colours or type only when it explicitly asks to.
- **Customization tiers.** Every Zone gets theme-token presets and a module
  layout; filtered community CSS is deferred. **Official Zones** may ship full
  CSS and JS as reviewed first-party packages in this repository, rendered
  server-side through named slots and loaded only while their build digest
  holds an active approval (`packages/zone-sdk`). A sandboxed iframe was
  rejected: it can paint only its own box and breaks SSR, SEO, focus and scrolling.
- **Safety.** Each official Zone keeps a complete token-and-layout fallback, a
  reader opt-out and a safe-mode URL; a kill switch works globally, per theme
  and per viewer; a nonce CSP; gzipped budgets with Core Web Vitals and
  accessibility checks.
- **Official Zones.** Fiction first, then Books, Mods and AI Workshop, each
  backed by an official Realm so its picks are public decisions; Software and
  Kitchen start on tokens; Screen follows.

## Languages and themes

The UI ships the old site's eight locales (`apps/web/i18n/define.ts`), separate
from content languages; missing keys fall back to English, and translation runs
on cheap models. "Realm" stays a product name in English, like Reddit's
"subreddit"; other locales use their plain word for a community, since readers
should not have to learn the model's vocabulary. The locale is a path prefix so
each language version of a public page has its own indexable URL with
`hreflang` alternates; content language belongs to a version and never enters
the route. Signed out, a language select and a theme button sit in the header;
signed in, they live in the avatar menu and settings. Zones may carry their
own themes, which people can turn off.

## Identity and administration

The Studio Agent switcher, the publish dialog and Realm role impact previews
are in code. These decisions wait for their surfaces and follow the
[acting identity layers](../contracts/identity-and-access.md#acting-identity-layers):

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

## Stack

React with vinext's Next.js-compatible App Router on Vite, deployed to
Cloudflare Workers; the Workers app hosts rendering, sessions and the BFF,
and domain commands stay in Elysia Main on Bun. The [stack comparison](../research/application-stack.md#frontend-options)
records vinext's compatibility gaps. Data fetching follows
[web organization](../development/web-features.md#data-fetching). Screens are
reviewed in light and dark, desktop and phone, English and a CJK locale.
