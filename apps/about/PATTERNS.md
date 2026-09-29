# About site patterns

How the about site's pages are built, so every page reads as one site. The home page,
`/light-novels`, `/wikis` and `/agents` are the reference pages; copy them before inventing
anything. Add a pattern here only when a page truly needs one.

## Art direction

- **Type is the picture.** REZICS has no video. Its spectacle is type across scripts (Latin,
  Han, kana, Hangul, Cyrillic, Devanagari), book spines and typographic covers
  (`@rezics/ui/work-cover`), and real product UI. Never copyrighted art, logos or screenshots
  of other products.
- **The ribbon marks your place.** The red bookmark ribbon (`.ribbon`, logo red) is the one
  recurring mark: the reader's place in a series, the stage being built, the call to action.
  It is a mark, never text; coloured text is ink blue (`text-primary`).
- **Surfaces.** Paper is the page. `dark band` is a full-bleed band for statements: deep ink
  in daylight, warm lamplight after dark. `dark cloth` with `--cloth: var(--cloth-<page>)` is a
  product line's book cloth (cream type); each line has one in `src/styles/about.css`.
- **Type scale** (`src/styles/about.css`): `type-hero` (home h1), `type-chapter` (a line's
  giant name), `type-statement` (bands), `type-section` (section h2), `type-title` (page h1 on
  line pages, story steps), `type-lede`, `type-body`. CJK sizes set themselves.
- **Restraint.** One spectacle per section, then quiet: a pinned story or a band is followed
  by plain grids and lists. No eyebrow labels, no all-caps labels, no numbered markers unless
  the content is a sequence.

## Page order

A product line page is `LinePage.astro` over its `LinePageCopy` catalog
(`src/i18n/messages/page.ts`), in this order: chapter hero, pinned story, showcase, compare,
statement, ledger, call to action. Pass pictures as named slots:

```astro
<LinePage locale={locale} page="light-novels" tileSpans={{ omnibus: 3, calendar: 3 }} clothTiles={['zone']}>
  <SeriesShelf slot="hero" words={words} />
  <SeriesBoard slot="step-lined" words={words} />         <!-- one per story step key -->
  <Vignette slot="tile-omnibus" page="light-novels" tile="omnibus" words={words} />
</LinePage>
```

Pages whose copy does not fit the order (home, roadmap) compose the section components
directly, as `pages/[locale]/index.astro` does.

## Section patterns

| Pattern        | Component                                        | Use                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home hero      | `pages/[locale]/index.astro` + `EditionFan`      | The site's one looping picture: a story's editions taking turns, with a pause control.                                                                                                                                  |
| Chapter hero   | `sections/ChapterHero.astro`                     | Opens every line page: the line's name set huge on its cloth, the name in the other locales beneath, then the h1 headline, lede, button and the `visual` slot.                                                          |
| Word band      | `sections/WordBand.astro`                        | One word in many languages, huge, two rows sliding in opposite directions. Home only; a second one would dilute it.                                                                                                     |
| Pinned story   | `sections/ScrollStory.astro` + `StoryStep.astro` | Two to six steps whose frames share one sticky stage on desktop. Each frame is a whole picture; parts marked `data-arrive` (with `--at` in percent) appear as their step arrives. Set `number` only for real sequences. |
| Showcase       | `sections/Showcase.astro` + `Tile.astro`         | A six-column grid. Rows must add up to six (`span` 2, 3, 4 or 6). A few tiles on cloth or band, the rest paper; a tile's `visual` slot holds a vignette.                                                                |
| Statement      | `sections/Statement.astro`                       | One sentence on a band that inks in (muted to full) as it crosses the viewport.                                                                                                                                         |
| Statements     | `sections/Statements.astro`                      | Several feature titles as big statements with bodies and statuses (home's "Why REZICS").                                                                                                                                |
| Compare        | `sections/Compare.astro`                         | A two-column table, today's workaround beside the REZICS way; today's side is struck through as the row arrives. Four or five rows.                                                                                     |
| Ledger         | `sections/Ledger.astro`                          | Every capability claim of the page, from `features.ts`, with its status. Dense and plain on purpose.                                                                                                                    |
| Glance         | `sections/Glance.astro`                          | GOAL.md's five stages in order, the one in development marked by the ribbon.                                                                                                                                            |
| Call to action | `sections/CallToAction.astro`                    | Ends every page; the notify form is the site's only island. Its id is `notify`.                                                                                                                                         |

`sections/SectionHeading.astro` is the one section heading; use it rather than styling h2s.

## Illustrations

React components in `src/illustrations/`, rendered to static HTML (no `client:` directive).
Each is built from Rezics UI (`Badge`, `WorkCover`, `buttonVariants`) inside a `Plate` and
says one thing within three seconds. Sample data lives in `sample.ts` and is invented:
never real titles, authors, users, counts of users, partners or testimonials. Sample content
keeps its own `lang`; interface words come from `messages/illustrations.ts`.

Reusable pieces: `SeriesBoard` (a series across editions; `marks`, `upcoming`,
`provenance`), `SeriesShelf`, `ImportReview`, `ChapterResume`, `ReleaseTable`, `WikiGrowth`
(`stage` 1–4), `WikiArticle`, `ContributionFlow` (`stage`), `SpamReview`, `LineVignette` (one
per product line) and `Vignette` (showcase tiles by page and key).

## Motion

CSS only; no animation library. Every animation lives in `src/styles/about.css` inside
`prefers-reduced-motion: no-preference`, and scroll-driven ones inside
`@supports (animation-timeline: view())`, so the static page is the fallback and the
reduced-motion version. Animate `transform`, `opacity` or `background-position`, never layout.
A looping animation needs the `.motion-toggle` pause control (WCAG 2.2.2) and `data-loop` on
its container. Cross-document view transitions morph a home tile's title
(`view-transition-name: line-<page>`) into that line's chapter name.

Check a page with `task about:dev -- --port <n>`: scroll it at 1440 and 390 px in both
themes, once with reduced motion, and tab through it.

## Copy

- Every capability sentence is a feature in `src/features.ts` with its text in
  `messages/features.ts`. Its status comes from the GOAL.md milestone that delivers it, so
  the sentence itself describes the product as it will work and never hedges.
- Write concrete scenes ("volume 7 in 繁體中文, out Friday"), plain verbs, sentence case.
- Catalogs written in English only use `defineEnglishCopy`; pages reading them mark
  `<main lang="en">` through `pageLanguage`, and strings from the translated site catalog
  inside them carry `lang={locale}`.
