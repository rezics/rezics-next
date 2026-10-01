# About site

`apps/about` is the public product site: what REZICS is, where it is going and how to hear
when registration opens. It is Astro with React only where a page needs script, styled with
the same tokens, fonts and components as the app (`packages/ui`), in the eight interface
locales. G-480 built the foundation; G-481 set the art direction, the motion system, the
home and flagship pages and every page's English copy; G-485 repositioned the home page
around the whole product (every language, the whole community, fans beyond any platform,
every kind of story) and added Motion for its islands. `apps/about/PATTERNS.md` names the
section patterns new pages are built from.

## Run it

`task about:dev` applies the local D1 migrations and serves the site on
`http://127.0.0.1:4321`. In development the Astro server also does what the Worker does in
production (locale negotiation at `/`, `POST /api/notify`) against a local D1 in
`apps/about/.wrangler/state`. `task about:build` writes `apps/about/dist`; `task about:check`
runs types, lint, format and unit tests; `task about:e2e` builds, serves `dist` with the real
Worker and runs the per-page and per-locale smoke and axe journeys. `astro dev` may start in
the background in an agent session; stop it with `astro dev stop` in `apps/about`.

## Decisions

- **Static pages, one small Worker.** Every page is a static file under `/<locale>/…`.
  `worker/index.ts` runs first only for `/`, the unprefixed page paths and `/api/*`
  (`assets.run_worker_first` in `wrangler.jsonc`, kept equal to the page registry by a test);
  everything else is a plain asset. `/` and `/reading` negotiate a locale from the
  `rezics_locale` cookie, then `Accept-Language`, then English.
- **Complete catalogs, no fallback.** The public site never shows English in another locale,
  so `defineCopy` requires every key in every locale and `tests/catalogs.test.ts` checks keys,
  placeholders and empty text. The eight locales duplicate `apps/web/i18n/define.ts`, as the
  Accounts app does, and a test keeps them equal. While copy is written in English ahead of
  its translation, its catalog uses `defineEnglishCopy`: every locale renders the English text
  inside `<main lang="en">`, and the catalog test names each such catalog. The site is not
  deployed while that list is not empty (G-482 translates the copy G-481 wrote).
- **Only post-launch capabilities get a label.** `src/features.ts` describes the product
  at launch, after the current Goal's M4–M8. Those capabilities carry no label; principles
  and policies such as open source, no advertising trackers and no training on private
  drafts never carry one either. Only capabilities beyond launch say “Later”, in all eight
  locales, with their owner decision recorded in the registry. A milestone is retained
  only for the roadmap's stages and launch inventory; post-launch capabilities have their
  own section when any are advertised. The registry currently has no post-launch claims;
  a test-only fixture covers the Later badge without inventing a product promise. Private
  World maps, relationships and fictional chronologies ship at M7 (decision 28); the public
  wiki expansions deferred in decision 29 are a separate scope. The maintainer chose this
  because the site is published at launch: marking every capability with today's development status adds noise, and calling a principle
  “available” misrepresents what it is. Progress belongs on the roadmap.
- **Copy status is marked.** `src/copy-status.ts` says whether a page's copy is final; it shows
  as `data-copy` on `<main>`. G-481 made every page's English copy final.
- **JavaScript.** Pages ship a 0.5 kB boot script (saved theme before paint, remembers a
  chosen language), the theme button's module and React islands: the notify form on every
  page, which loads when it scrolls into view, and on the home page three Motion islands,
  which load when the browser is idle (`tests/build.test.ts` holds the list, when each
  loads and the size budget: 448 kB of scripts in all, 146 kB gzip, at G-485). Menus are
  `<details>`, the form also works as a plain post without script, and every island is
  server-rendered complete, so it reads the same before it hydrates.
- **Motion: CSS first, then the Motion library in islands.** Scroll-driven animations
  (`animation-timeline: view()`), sticky pinned stories and cross-document view transitions
  stay CSS: no script, 60 fps on a throttled phone. G-481 chose CSS only; G-485 added
  [Motion](https://motion.dev) (MIT, `motion/react`) because the home page's messages are
  things to try, not to watch: swiping a deck, changing a record's language field by field,
  moving your place in a story. Those need gestures, springs, orchestrated sequences and
  layout animation, which CSS cannot drive. Motion stays inside React islands, loads its
  gesture and layout features once through `LazyMotion` (about 43 kB gzip) and takes its
  transitions from one vocabulary (`src/islands/motion.tsx`, described in `PATTERNS.md`).
  Browsers without scroll timelines, and readers who prefer reduced motion, get complete
  static pages; with reduced motion the islands still work and change instantly.
- **Budgets.** LCP under 1 s on a phone with 4× CPU throttling (0.6–0.9 s for the home page
  at G-485) and no layout shift. The page preloads the Latin interface face and work serif,
  because without them text laid out in fallback fonts moved when they arrived (CLS 0.03
  on the home page and `/light-novels` before G-485). On slow 4G as well as 4× CPU the home page's LCP is about
  1.9 s, 0.3 s more than without the preloads; zero shift was the budget. `tests/e2e` holds
  the shift check.
- **Share images are Latin only.** `src/lib/og.ts` draws one 1200×630 image per page with
  Satori. CJK text would need the four Noto CJK font families in the build, so localized pages
  share the English image; their titles and descriptions are localized in the page metadata.
- **Cookies.** `rezics_locale` and `rezics_theme`, both first-party and set from the browser;
  no analytics or third-party requests.

## Policies

The nine policies in `docs/legal/` (Terms, Privacy, Acceptable Use, Content Ratings and Age, AI,
Copyright and DMCA, NCII, Child Safety, API and Agent) are published at `/<locale>/legal/<slug>/`
from those Markdown files through a content loader (`src/legal/loader.ts`); there are no copies.
They stay in English in every locale (a localized notice says the English text governs), and the
creator distribution outline is not published because it is an outline, not a policy. The AI
policy is published because the Terms incorporate it.

- **Facts.** The operator, mailboxes, DMCA agent and every other `[REZICS TO FILL]` answer come
  from `src/legal/facts.ts`, supplied by the maintainer; an empty string means "not supplied" and
  nothing there is invented. A new marker in a source needs a slot in that file, and
  `tests/g-736-legal.test.ts` fails until it has one.
- **Draft and release.** A development build shows every unfilled marker highlighted under a
  "draft, not in force" banner and marks the pages `noindex`. `task about:build -- --release`
  (or `ABOUT_RELEASE=1`) fails while a marker or an empty fact remains, and when the digest of a
  source differs from `services/account/src/policy-versions.ts`. A release lists the policies in
  the sitemap. Editing `terms-of-service.md` or `privacy-policy.md` therefore also means updating
  that file, whose digests are what sign-up records and what re-acceptance compares.

## Tooling notes

- `astro check` needs the TypeScript 6 compiler API, which the native TypeScript 7 the other
  workspaces use does not ship. `apps/about` declares `typescript-6` (an alias of
  `typescript@6.0.2`) and `astro-check.cjs` runs the checker on it; `@emnapi/runtime` is
  declared because `@astrojs/astro2tsx` needs it and does not. Revisit both when Astro's
  language server supports TypeScript 7.
- Tailwind scans the app's files plus only the `packages/ui` components the site imports
  (`@source` lines in `src/styles/global.css`); `tests/ui-sources.test.ts` fails when an
  import is missing or a line is unused.

## Deploying

The `wrangler.jsonc` D1 `database_id` is a local placeholder. Before the first deployment
create the database (`wrangler d1 create rezics-about`), put its id in the file, run
`wrangler d1 migrations apply DB --remote` from `apps/about`, and set `ABOUT_SITE_URL` to the
public origin for the build (default `https://rezics.com`).
