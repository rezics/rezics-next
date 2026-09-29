# About site

`apps/about` is the public product site: what REZICS is, where it is going and how to hear
when registration opens. It is Astro with React only where a page needs script, styled with
the same tokens, fonts and components as the app (`packages/ui`), in the eight interface
locales. G-480 built the foundation; G-481 writes the final copy and page designs on it.

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
  Accounts app does, and a test keeps them equal.
- **One registry for feature claims.** `src/features.ts` lists every capability statement with
  its status (available, in development, planned Next or Later); pages render the status
  beside each statement and the roadmap groups by it. The initial statuses are the
  maintainer's to confirm: only "no trackers" is marked available, because nothing else is
  public yet.
- **Placeholder copy is marked.** `src/copy-status.ts` says which pages still carry
  placeholder copy; it shows as `data-copy` on `<main>` and a test fixes the value until G-481
  flips a page to `final`.
- **JavaScript.** Pages ship a 0.5 kB boot script (saved theme before paint, remembers a
  chosen language), the theme button's module and one React island, the notify form, which
  loads only when it scrolls into view (`tests/build.test.ts` holds this and the size budget).
  Menus are `<details>`, and the form also works as a plain post without script.
- **Share images are Latin only.** `src/lib/og.ts` draws one 1200×630 image per page with
  Satori. CJK text would need the four Noto CJK font families in the build, so localized pages
  share the English image; their titles and descriptions are localized in the page metadata.
- **Cookies.** `rezics_locale` and `rezics_theme`, both first-party and set from the browser;
  no analytics or third-party requests.

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
