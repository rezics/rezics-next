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
directly, as `pages/[locale]/index.astro` does. The roadmap opens with a route to launch (the five
stages as stops, the ribbon on the one being built), tells the stages as a pinned story whose
frames show where each sits and a few of its capabilities, files launch capabilities in Now, Next
and Later columns with post-launch capabilities in a separate section, and ends on a statement about dates. The home page shows the whole product, not one
line: hero deck, word band, then its three messages (a work in your language, the whole
community, fans from every platform), every kind of story, the product lines, why, the stages
and the call to action. Each message is a heading, one interactive or arriving picture and
its claims in a `FeatureList`.

## Section patterns

| Pattern        | Component                                        | Use                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home hero      | `pages/[locale]/index.astro` + `StoryDeck`       | A deck of every kind of story, each named in several scripts; swipe or use the buttons to bring the next kind forward (Motion island).                                                                                  |
| Chapter hero   | `sections/ChapterHero.astro`                     | Opens every line page: the line's name set huge on its cloth, the name in the other locales beneath, then the h1 headline, lede, button and the `visual` slot.                                                          |
| Word band      | `sections/WordBand.astro`                        | One word in many languages, huge, two rows sliding in opposite directions. Home only; a second one would dilute it.                                                                                                     |
| Pinned story   | `sections/ScrollStory.astro` + `StoryStep.astro` | Two to six steps whose frames share one sticky stage on desktop. Each frame is a whole picture; parts marked `data-arrive` (with `--at` in percent) appear as their step arrives. Set `number` only for real sequences. |
| Showcase       | `sections/Showcase.astro` + `Tile.astro`         | A six-column grid. Rows must add up to six (`span` 2, 3, 4 or 6). A few tiles on cloth or band, the rest paper; a tile's `visual` slot holds a vignette.                                                                |
| Statement      | `sections/Statement.astro`                       | One sentence on a band that inks in (muted to full) as it crosses the viewport.                                                                                                                                         |
| Statements     | `sections/Statements.astro`                      | Several feature titles as big statements with bodies and labels only beyond launch (home's "Why REZICS").                                                                                                               |
| Compare        | `sections/Compare.astro`                         | A two-column table, today's workaround beside the REZICS way; today's side is struck through as the row arrives. Four or five rows.                                                                                     |
| Ledger         | `sections/Ledger.astro`                          | Every capability claim of the page, from `features.ts`, with a “Later” label only beyond launch. Dense and plain on purpose.                                                                                            |
| Glance         | `sections/Glance.astro`                          | GOAL.md's five launch stages in order, linking to the roadmap for progress.                                                                                                                                             |
| Feature list   | `sections/FeatureList.astro`                     | Feature statements with labels only beyond launch as a grid, under a section's picture (home) or inside the ledger.                                                                                                     |
| Call to action | `sections/CallToAction.astro`                    | Ends every page with the notify form island. Its id is `notify`.                                                                                                                                                        |

`sections/SectionHeading.astro` is the one section heading; use it rather than styling h2s.

## Illustrations

React components in `src/illustrations/`, rendered to static HTML (no `client:` directive).
Each is built from Rezics UI (`Badge`, `WorkCover`, `buttonVariants`) inside a `Plate` and
says one thing within three seconds. Sample data lives in `sample.ts` and is invented:
never real titles, authors, users, counts of users, partners or testimonials. Sample content
keeps its own `lang`; interface words come from `messages/illustrations.ts`.

Reusable pieces: `SeriesBoard` (a series across editions; `marks`, `upcoming`, `provenance`),
`SeriesShelf`, `WikiGrowth` (`stage` 1–4), `WikiArticle`, `ContributionFlow` (`stage`),
`SpamReview`, `RealmGathering` (one story's versions on five platforms leading into one Realm
conversation), `KindsGrid` (every kind of story with one example each), `LineVignette` (one
per product line) and `Vignette` (showcase tiles by page and key). Every line page has its own
file of pictures: a hero, one `*Flow` component with a `stage` prop for its four story steps,
and a record of vignettes registered in `Vignettes.tsx`. `ReadingPictures` (`LibraryHero`,
`ImportFlow`), `SerialPictures` (`ChapterDesk`, `SerialFlow`), `AcgnPictures` (`ThreeReleases`,
`AcgnFlow`), `CommunityPictures` (`RealmScene`, a Realm conversation beside the wiki it feeds, and
`RealmFlow`), `DistributionPictures` (`PurchaseHero`, `StoreFlow`), `DeveloperPictures`
(`TwoClients`, `ApiFlow`), `TrustPictures` (`SuitabilityChoices`, `CaseFlow`) and
`RoadmapPictures` (`RoadmapRoute`, `StageFrame`). Shared parts live in `parts.tsx` (`row`, the
`Words` and `Picture` types, `Connect`). `sample.ts` also holds
`kindsOfStory` (a work per kind, named in several scripts), `lanternRecord` (one record in
four reading languages) and `lanternThread` (posts and wiki facts by chapter).

Rules the pictures follow: sample content keeps its own `lang` and interface words come from
`messages/illustrations.ts`; code and identifiers carry `lang="en" translate="no"`; a tile whose
text is the whole point may go without a picture, but every hero and story step has one. Muted
text must reach 4.5:1 on its surface, so never dim a whole row with `opacity`; use a dashed
border for "not yet" and reserve `soft` small badges for paper, not tinted rows (axe checks both).
A cover shows its title only from 4.5 rem wide (`WorkCover`); narrower ones are colour and shape.

## Motion

Two tools, each for what it does best.

**CSS** does everything that follows the scroll or a navigation: scroll-driven animations
(`animation-timeline: view()`), pinned stories, `[data-arrive]` parts, word bands, ink-in
statements and cross-document view transitions (a home tile's title,
`view-transition-name: line-<page>`, morphs into that line's chapter name). Every CSS
animation lives in `src/styles/about.css` inside `prefers-reduced-motion: no-preference`, and
scroll-driven ones inside `@supports (animation-timeline: view())`, so the static page is the
fallback and the reduced-motion version. Animate `transform`, `opacity` or
`background-position`, never layout. A looping animation needs the `.motion-toggle` pause
control (WCAG 2.2.2) and `data-loop` on its container; no page loops at present.

**Motion** (`motion/react`) does what CSS cannot: gestures (drag and swipe), springs that
answer a hand, orchestrated sequences (fields changing one after another) and layout changes
(list items arriving and leaving). It runs only in React islands in `src/islands/`, which
turn a picture into something a visitor can use. The references are `StoryDeck` (swipe a
deck), `ListingInPlace` (a record changing language field by field) and `PlaceInStory` (a
range whose value reveals posts and facts).

- Wrap the island in `MotionRoot` and use `m.*` from `motion/react-m`; `MotionRoot` loads
  the gesture and layout features once, strictly, so a stray `motion.div` fails.
- Take every transition from `useMotion()` (`src/islands/motion.tsx`): `settle` (a spring for
  things coming to rest: a card returning, a marker snapping, a layout change), `lift` (a
  spring for things picked up or pressed), `swap` (text replacing text, 0.34 s on
  `--ease-out-soft`) and `stagger` (0.07 s between siblings). With reduced motion it returns
  `instant`: the state still changes, nothing travels, no sequence plays itself.
- Render the first state on the server with `initial={false}`, so the island is complete
  before hydration and never shifts the page. A field with versions that differ in length
  stacks them in one `.swap` cell with `data-active`, so the tallest decides its height.
- Controls are native: buttons, radios and range inputs, labelled from the catalog. Parts
  under `aria-hidden` must not be focusable (Motion makes `whileTap` targets focusable; give
  them `tabIndex={-1}`).
- Hydrate with `client:idle` when the island must be live before the reader reaches it,
  otherwise `client:visible`; list it in `islandLoading` in `tests/build.test.ts`, which also
  holds the JavaScript budget. Change the reader's view unasked only out of sight
  (`instant`) or once, as `ListingInPlace` turns Japanese into English on first view.

Check a page with `task about:dev -- --port <n>`: scroll it at 1440 and 390 px in both
themes, once with reduced motion, and tab through it; drag and swipe what can be dragged.

## Copy

- Every capability sentence is a feature in `src/features.ts` with its text in
  `messages/features.ts`. The sentence describes the product at launch without hedging.
  Only post-launch capabilities get a “Later” label, sourced to an owner decision;
  principles never get a label. Milestones belong to the roadmap, where progress is shown.
- Write concrete scenes ("volume 7 in 繁體中文, out Friday"), plain verbs, sentence case.
- Catalogs written in English only use `defineEnglishCopy`; pages reading them mark
  `<main lang="en">` through `pageLanguage`, and strings from the translated site catalog
  inside them carry `lang={locale}`.
