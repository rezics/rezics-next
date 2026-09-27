# Frontend direction

The current [Goal](../../GOAL.md) centres on the main site and the Accounts site.
This page records the manager's product decisions and their reasons; code
(routes, tokens, components, stories) carries everything else. Revise it as
slices are used in a real browser.

## Principles

Revised 2026-09-28 after the maintainer compared the first slices with the old
site, Reddit and Goodreads: they exposed the model instead of the content.

- **Content first, concepts inside.** Readers see covers, titles, authors,
  ratings in words they know, and what people are saying. Scopes, Contexts,
  generations, exact-or-lower-bound counts and identifiers stay internal. Scope
  appears where it changes meaning (inside a Realm, or when the reader chooses
  another community), not as a label on every shelf; model detail belongs in
  a "Details" or "Cite" affordance.
- **Cover-first catalogue, Goodreads quality.** The cover is the card; no card
  frame around it. When a Work has no cover, generate a typographic cover
  (title, author, a type-appropriate palette), never a single-letter monogram.
  Every card shows the author and one primary action (want to read / add to
  shelf / rate). Shelves are curated by meaning (genre, community, "readers'
  favorites"), not by storage type.
- **A feed home, like Reddit.** Home is where people continue reading and keep
  up with the communities they follow; see [Home](#home).
- **Honest states, quietly.** Pending, stale, partial and unavailable remain
  visible and recoverable, but phrased for people ("Couldn't load ratings ·
  Retry"), not as system status.
- **Identity before action.** The acting Agent is shown before submit and never
  silently replaced; Studio carries its Agent in the route.
- **APIs own behavior.** A missing or awkward read is fixed in Main or Account.
- **Keyboard and CJK.** `/` and Cmd/Ctrl-K; handlers ignore `event.isComposing`;
  `lang` on content blocks; CJK text uses 1.8 line height and `text-autospace`.
- **Reading surfaces are calm.** No grid canvas behind content pages; the Aura
  canvas stays for marketing-style surfaces only.

## Home

Decided 2026-09-28 from research into Reddit, the old site's feed and published
critiques of Goodreads: people come back to track what they read and to get the
next chapter, then to keep up with communities, then to discover.

- **Frame.** Left navigation: followed Zones and Realms with new-activity dots,
  official Zones, Manage for moderators. Centre: a **Continue** strip (Works in
  progress and followed Works with unread chapters, each opening the next
  unread chapter; packages with compatible updates), then the feed. Right rail:
  trending in my Realms, Realms to follow, my moderation queue.
- **Tabs and sort.** `Following` and `All`; sort `Best`, `New`, `Top` (week,
  month, all) is always visible. Following · New is strictly chronological and
  ends with "You're all caught up". Recommendations appear only when Following
  is thin, labelled with their reason, never under Following · New, and can be
  turned off.
- **Best.** Log-scaled net engagement of real readers with a 24-hour decay,
  normalised within each Realm and capped so no Realm holds more than 3 of any
  10 items; the constants are versioned in the API and tested.
- **Cards.** One anatomy for every kind: Realm · person · time, the content,
  and a bottom bar (vote, comments, one kind-specific action such as Read,
  Install, Copy or Want to read, share, menu). Repeated updates collapse into
  one card ("Chapters 212–214"); shelving and ratings without text never become
  cards. Chapter cards hide spoilers past the reader's position.
- **States.** Signed out: All · Best with official-Zone tiles above the feed.
  A new person picks kinds, languages and topics, then follows suggested Realms
  in one step, so home is never empty. Infinite scroll with a "N new posts"
  pill; filters use six human kinds, not the model's types.

## Zones

Decided 2026-09-28 from KadoKado (the maintainer's reference), the old site
and how Reddit, Discourse, Fandom, Tumblr and Shopify admit custom code.

- **A Zone is a Realm's publication.** Its page is built from named editorial
  modules (hero carousel, rankings by day, week and month, editor lists,
  new and rising, reader quotes, recent decisions, genre entry points), each
  reading the Realm's curation; every pick links to the decision behind it.
  Covers carry a one-line hook, as KadoKado's do.
- **Customization tiers.** Every Zone gets theme tokens with presets (Clean,
  Editorial, Vibrant and a KadoKado-like Serial) and a module layout. Filtered
  community CSS is deferred. **Official Zones** may ship full CSS and JS as
  reviewed first-party packages in this repository, rendered server-side
  through named slots and loaded only while their build digest holds an active
  approval. A sandboxed iframe was rejected: it can paint only its own box and
  breaks SSR, SEO, focus and scrolling.
- **Safety.** Each official Zone keeps a complete token-and-layout fallback, a
  reader opt-out and a safe-mode URL; a kill switch works globally, per theme
  and per viewer; a nonce CSP; budgets of 40 KB CSS and 50 KB JS gzipped with
  Core Web Vitals and accessibility checks.
- **Official Zones.** Fiction first, then Books, Mods and AI Workshop, each
  backed by an official Realm so its picks are public decisions; Software and
  Kitchen start on tokens; Screen follows. They use `/r/{slug}` and appear as
  tiles above the signed-out home feed.

## Languages and themes

The UI ships eight locales, as the old site did: English, 繁體中文, 简体中文,
日本語, 한국어, Deutsch, Français, Español (BCP 47 `en`, `zh-Hant`, `zh-Hans`,
`ja`, `ko`, `de`, `fr`, `es`). Content languages are separate from the UI
locale. Missing translations fall back per key to English; translation work
runs on cheap models. Signed out, a language select and a theme button sit in
the header; signed in, "Language" and "Display mode" live in the avatar menu
and in settings. Display mode is system, light or dark; Zones may carry their
own themes (presets and a small set of tokens), which people can turn off.

## Main site routes

The UI locale is a path prefix (`/en`, `/zh-Hant`, ...) so each language version of a
public page has its own indexable URL with `hreflang` alternates; unprefixed
paths redirect by cookie, then `Accept-Language`. Content language belongs to a
version and never appears in the route. Auth and BFF routes stay unprefixed.

| Route | Surface |
| --- | --- |
| `/`, `/discover`, `/search?q` | Home feed (Reddit-like, followed communities and REZICS-wide), discovery shelves, search with include/exclude facets. |
| `/w/{slug\|id}` with `/contents`, `/versions`, `/discussion`, `/history` | Work page: one template whose primary action depends on type (read, install, copy prompt). |
| `/w/{id}/read/{chapter}` | Reader with synced settings, progress per version, chapter discussion. |
| `/r/{realm}` with `/works`, `/discussions`, `/decisions`, `/about` | Realm home through its Zone; Decisions is the public curation log. |
| `/@{handle}`, `/library`, `/notifications` | Profiles for people, pen names and organizations; shelves and lists. |
| `/studio/@{agent}/…` | Authoring as a chosen Agent: drafts, autosave, conflicts, publish dialog. |
| `/manage`, `/manage/r/{realm}/…`, `/manage/o/{org}/…` | Management: queue, log, appeals, members, roles (with impact preview), classification, adoptions, reasons, Zone, settings. |

Slice order: Work page, reader, search and discover, ratings and library with
profiles, Studio writes, contribution review and history, Realm home, Realm
queue with audit log, tag curation, roles editor with impact preview.

## Accounts site

A separate app (`apps/accounts`) on the Account origin, in the spirit of Google
Account: it hosts sign-in, sign-up, recovery and OAuth consent for every
REZICS product, the account centre (home, personal info, security, connected
apps, data and privacy) and the operator admin panel. It proxies the Account
service's API on the same origin, so the Account session cookie never lives on
a product origin. It is not indexed, so its locale comes from `?hl=`, a cookie
and `Accept-Language` rather than a path prefix.

## Stack

React with vinext's Next.js-compatible App Router on Vite, deployed to
Cloudflare Workers; the Workers app hosts rendering, sessions and the BFF,
and domain commands stay in Elysia Main on Bun. The [stack comparison](../research/application-stack.md#frontend-options)
records vinext's compatibility gaps. Data fetching follows
[web organization](../development/web-features.md#data-fetching).

## Verification

A slice counts when it is merged, its typecheck, component tests and Storybook
tests pass, and its flows work in a real browser against the local stack with
screenshots reviewed (light and dark, desktop and phone, en and zh-CN).
