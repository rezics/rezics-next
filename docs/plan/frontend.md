# Frontend direction

The current [Goal](../../GOAL.md) centres on the main site and the Accounts site.
This page records the manager's product decisions and their reasons; code
(routes, tokens, components, stories) carries everything else. Revise it as
slices are used in a real browser.

## Principles

- **A reference work you can read inside.** Wikipedia's versioned trust,
  Modrinth/npm's version clarity, AO3's tag model and the Qidian/Royal Road
  reader, on the Rezics Aura theme ([design system](../development/design-system.md)).
- **Scope is always visible.** Ratings, classification and adoption are scoped
  (Global, a Realm, Mine). A scope bar sits under every entity header and
  beside the search box; empty states name their scope and offer the
  neighbouring one. A Realm view never silently falls back to Global.
- **Honest states.** Pending, stale, partial and unavailable are shown
  ("Ratings from 1 Realm unavailable · retry"); search states whether counts are
  exact and what was excluded. Recoverable input survives errors.
- **Identity before action.** The acting Agent is shown before submit and never
  silently replaced; Studio carries its Agent in the route and never changes
  the session Agent.
- **APIs own behavior.** A missing or awkward read is fixed in Main or Account,
  not worked around in the client.
- **Keyboard and CJK.** `/` and Cmd/Ctrl-K for search and the command palette;
  shortcut handlers ignore `event.isComposing`. Set `lang` on content blocks;
  CJK text uses 1.8 line height and `text-autospace`.
- **Comfortable public pages, compact management pages.**

## Main site routes

The UI locale is a path prefix (`/en`, `/zh-CN`) so each language version of a
public page has its own indexable URL with `hreflang` alternates; unprefixed
paths redirect by cookie, then `Accept-Language`. Content language belongs to a
version and never appears in the route. Auth and BFF routes stay unprefixed.

| Route | Surface |
| --- | --- |
| `/`, `/discover`, `/search?q&scope` | Home (continue reading, followed updates, scoped shelves), discovery, search with include/exclude facets and a completeness line. |
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
