# Rezics UI

`@rezics/ui` is Rezics's shared React component library. Import the base controls from `@rezics/ui/shadcn/<name>` (see below), the site's own components from `@rezics/ui/<name>` such as `@rezics/ui/cover`, shared hooks from `@rezics/ui/hooks/use-is-mobile`, and the theme stylesheet from `@rezics/ui/styles.css`.

Run `bun run storybook` in this directory to review components. Run `bun run check` to type-check the package and run its unit and accessible browser story tests.

Tests run in a private network namespace that holds only loopback, so changes to the host's network interfaces cannot interrupt browser requests. Run one test file with `bun run test <file>` to use the same isolation. Run `bun run test:stories:slow-frames` after changing a story or an editor or overlay component: it delays every animation frame by 400 ms, which reproduces the failures a loaded host causes.

The logo red (`--brand`) marks identity and never colors text; use ink blue (`--primary`) for colored text and actions. Use Manrope for interface text and Source Serif 4 for Work titles only. Fonts are self-hosted, and theme selection belongs on `<html>` without a script. Mark icons in red with `fill-*` or `stroke-*` utilities, never `text-brand`.

## shadcn components

Before building any interface piece, look it up in [SHADCN.md](SHADCN.md), which lists every item in the shadcn registry with its purpose and add command, and add it from shadcn when it exists. Build our own only for what shadcn does not offer, and say so in that component's doc comment.

The package uses shadcn's Rhea style on the Base UI primitives (`components.json`, style `base-rhea`). `apps/web/components.json` shares that configuration, so `bunx shadcn@latest add <name>` run from either directory writes into `packages/ui`.

- Files in `src/shadcn/` are exactly what the shadcn CLI writes. Never edit them by hand: brand changes belong in `src/styles.css`, and our own components in `src/components/`. Import them as `@rezics/ui/shadcn/<name>`; `src/index.ts` exports only the rich-text editor, so a shadcn name never clashes with one of ours.
- `src/components/` holds only what shadcn does not offer: the site's components (`Cover`, `Reactions`, `ContentActions`, `ReportDialog`, the rating components, `MediaImage`, `EntityPicker`, `DocumentBody`, `Prose` and the editor) and a few small helpers and display pieces with no shadcn counterpart. A component there never wraps a control that shadcn provides.
- The shadcn colour variables map to the Aura tokens in `src/styles.css`, layered after the Rhea defaults.
- Stories for shadcn components are `src/components/shadcn-<name>.stories.tsx`, titled `shadcn/<Name>`.
- `shadcn-sync.json` records the last successful sync time and CLI version. The daily GitHub check opens one shared `shadcn-sync` issue when that sync is more than seven days old; it never syncs components. Anyone with repository issue access can also run `bun run shadcn:sync-check` in this directory.
- Whoever takes the issue runs `bun run shadcn:sync` here as an ordinary task. It re-adds every cloned component from `shadcn@latest`, refreshes `shadcn-registry.json` and `SHADCN.md` with `scripts/shadcn-index.ts`, pins dependencies exactly, updates the sync record and shows the diff. Review all changes and run `bun run check` before committing. Include `Closes #<issue-number>` in the sync commit message; the issue closes when the commit reaches the default branch. The sync never runs automatically, so people do not redo it in parallel.
- To refresh only the capability index outside a sync, run `bun scripts/shadcn-index.ts`; `--offline` regenerates `SHADCN.md` from the committed registry snapshot.

## Editor and document body

The rich-text editor keeps Tiptap and the document model (`@rezics/document`) and draws its controls from the shadcn primitives: `dropdown-menu` for the block menu, `toggle`, `button` and `tooltip` for the selection menu and the touch bar, `sheet` for the touch block picker, `command` for the slash menu, and `field` with `input` for the link and image forms. Two things stay in our own components, because shadcn has no equivalent: Tiptap's bubble menu places the selection and link menus against a range of text (a shadcn popover anchors to a trigger element), and the toolbar role with one tab stop and arrow-key travel is not in the registry.

shadcn menus and sheets render in a portal on the page, not inside the story canvas, so a story finds them with `screen`. A layer that takes focus must hand it back through Tiptap's frame-deferred restore (`returnFocus` in `editor-selection-menu.tsx`); wait for the editor to hold focus before sending the next key.

`Prose` is the surface for documents, in the reading page (`DocumentBody`) and in the editor. Body text is interface text. Only a Work title, marked with the `work-title` class, takes the serif face. A line holds about 65 characters (36 em for Chinese, Japanese and Korean, where a character is an em wide), and CJK text gets more leading. The styles live in `src/prose.css`.

## Content feedback

`Reactions`, `ContentActions`, `ReportDialog` and the rating components are built from shadcn primitives (`button`, `popover`, `dropdown-menu`, `alert-dialog`, `dialog`, `radio-group`, `field`, `textarea`, `slider`, `badge`).

- On a detail page the reaction cluster sits top right and reporting lives in the `ContentActions` overflow menu; there is no visible report button.
- `Reactions` shows and offers every kind unless `kinds` narrows it: a subject admits like, love, laugh, insightful and sad, so its cluster passes those five and never shows upvote or downvote. `disabled` turns the chips and the React trigger off until the page has hydrated.
- `RatingSummary` takes the aggregates the rating module returns (count, sum and histogram per population, plus the threshold) and never shows a score without its population and count. The headline is the page's own population; every other population is a labelled list and is never averaged or substituted; imported source scores follow, labelled with their source and scale. Below the threshold it shows the count, the votes still needed and why the distribution is hidden; with no votes it draws nothing.
- `RatingInput` is one slider over the question's scale plus a clear button. It works in displayed points and reports stored units, saves optimistically and rolls back with an announced message when saving fails.

## Deletion

Import `Tombstone` from `@rezics/ui/tombstone` for a reference to a deleted, withheld or unavailable record. Ordinary reads
omit deleted records; only references keep a tombstone, following [the deletion policy](../../docs/deletion.md).
Pass the replaced `shape` (`post`, `card` or `row`). Never pass the record's
title, author, image or link. Cards keep an empty cover frame and inherit the ratio from `CoverGrid` or `CoverRow`;
outside a collection pass `ratio`. Match a surface's known item dimensions with `className` or `style`.

`reason` defaults to `unavailable`: “Not available”, with no claim about why a reference cannot be read. Pass
`deleted` or `withheld` only when the wire supplies that reason. For a notice covering one part, import `Withheld`
from `@rezics/ui/withheld` in place of that image, passage or field, leaving the record's other fields visible.
Pass `shape="image"` with a numeric width/height `ratio`, `shape="passage"`, or `shape="field"` with its public `label`.
It keeps the image frame, passage block or field label on one muted surface with a notice message and no action;
`className` or `style` can reserve known dimensions. Pass no withheld content, alt text or file name. Its `labels`
prop overrides the English notice message. A purge keeps the record's identifier, type, relations, counts and
tombstone as the deletion policy requires; neither display component purges data.

Only an owner's deleted reference receives both `restoreUntil` and `onRestore`. It offers Restore with a relative
deadline until that instant, then removes the control and deadline automatically. Withheld records never offer
restore. The caller supplies the server's 30-day deadline and performs and authorizes the restore; the component
makes no request. `labels` accepts English-default message, Restore and deadline-format overrides; relative dates
use `LocaleProvider`.

Call `undoToast('Post deleted', onUndo)` from `@rezics/ui/undo-toast` after a successful action, with the existing
shadcn `Toaster` mounted once. It announces the result politely and offers Undo for eight seconds, including while
hovered or focused. A second call replaces the previous result and invalidates its callback; Undo calls the current
callback at most once. Pass a third `labels` argument to translate Undo. This immediate feedback complements the
owner's longer restore window; the site supplies all delete and restore calls.

## Cover

`Cover` draws the image area of any subject: a work, edition, character, person, organization, recipe or Realm. Import it from `@rezics/ui/cover`. Do not draw subject images with a bare `<img>`.

The cover area always renders. `Cover` reserves its box from the frame ratio before any byte arrives, so a missing, slow, failed, withheld or taken-down image never collapses the layout or leaves an empty hole. Every state below renders a designed result at the same size.

| State                           | Result                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Image available                 | The image, fitted to the frame, over its placeholder colour while it loads             |
| Loading                         | The placeholder colour or decoded ThumbHash in the frame, no spinner                   |
| No image                        | The typographic placeholder                                                            |
| Load error                      | The typographic placeholder, never a broken-image icon                                 |
| Withheld for suitability        | The image blurred behind a short label and a reveal control, per the viewer's settings |
| Taken down, or no right to show | The typographic placeholder, exactly as if there were no image                         |

### Frame ratios

The frame ratio comes from the subject's type, never from the image, so grids and rows align. Types declare their ratio as a class annotation in the definition release, inherited through `bases`; these are the defaults:

| Type family                                      | Frame ratio (width:height) |
| ------------------------------------------------ | -------------------------- |
| Book, edition, manga, light novel, comic volume  | 5:7                        |
| Anime series or film, live-action series or film | 5:7 (poster)               |
| Visual novel, game                               | 5:7 (package art)          |
| Music release                                    | 1:1                        |
| Recipe, place, event                             | 4:3                        |
| Character, person                                | 3:4 (portrait)             |
| Organization, Realm, Zone, concept               | 1:1                        |

5:7 (0.714) is the default for works because most covers in the catalogue are close to 1:√2: Japanese bunko (A6),
tankōbon, manga and light novels (B6), A5 books, Blu-ray and DVD cases and B-series posters are 0.70–0.71. A 2:3
cover (US trade, Steam capsules) loses about 7% of its height in the frame; 3:4 would cost the 1:√2 majority about
6% and 2:3 covers 11%.

`coverRatio(types)` in `@rezics/ui/cover` holds this table by type CURIE as the fallback. When the definition release carries a `coverRatio` annotation for the type, the site resolves it and passes it as the `ratio` prop, which wins over the table.

The ratio is resolved from the subject's semantic type through its structural bases, the same way templates resolve; a creative work with no more specific type uses 5:7 and anything else uses 1:1. A coarse resource class, an empty type list or a summary that dropped the types never decides the ratio, so every read that feeds `Cover` carries the subject's type.

A row, grid or list that mixes types uses one frame ratio for all its items (the ratio of most of its items, 5:7 when tied), so mixed shelves stay aligned; each image is then fitted by the rule below. A Zone's `cover` appearance token (`portrait`, `square`, `landscape`) chooses that shared ratio on its pages instead. A single-type list and the subject page header always use the type's own ratio.

An image whose own ratio is within 15% of the frame fills it (`object-fit: cover`). A wider or taller image is shown whole (`object-fit: contain`) on a backdrop of its own placeholder colour, so landscape package art or a square album cover in a portrait slot is never cut to a sliver. Portraits of characters and people keep the top of the image when they are cropped (`object-position: top`); other images keep their stored focal point, or the centre.

### Typographic placeholder

The placeholder is designed, not empty: the subject's title set in the Work title face, its principal creator or type label in the interface face, on a background chosen deterministically from the subject id alone. Its colour does not depend on the title, byline or type, so the same id always looks the same on every surface. It never shows a generic icon alone. Below 64 px a set title is unreadable, so a standalone cover represents it with its initials in the Work title face. A cover in a tile beside its visible title shows only the colour field; it does not repeat the title, byline or initials. Text stays legible against its background in both themes.

A suitability-withheld cover shows its decoded ThumbHash blurred behind the label and the reveal button, and requests no image byte until the viewer reveals it. `placeholder.color` is painted first, and the ThumbHash (decoded with the `thumbhash` package) over it while the image loads; a contained image keeps the colour alone as its backdrop. The placeholder colour is derived only from the subject id, and its light text keeps at least 5.5:1 contrast in both themes and at every size. On a standalone cover, the placeholder shows the title and, when available, the byline. The labels (`withheld`, `reveal`, `credit`, `via`) are English by default and the site passes translations in `labels`.

### Sizes and loading

`Cover` takes a named size (`xs` 48 px, `sm` 96 px, `md` 160 px, `lg` 240 px, `xl` 320 px wide in CSS pixels) or `fill` for a frame sized by its parent. It writes `srcset` from the variants the kernel returned, offers AVIF before WebP through `<picture>`, and sets `sizes` from the named size so the browser picks the smallest sufficient variant. It sets intrinsic `width` and `height` from the frame. Covers below the first viewport load lazily; the subject page's own cover loads eagerly with high fetch priority because it is usually the largest element.

### One summary everywhere

Every surface builds `Cover` from the cover summary the kernel returned with the subject, never from a per-surface reconstruction, so the type, crop, placeholder and credit are the same on the subject page, in search, on a Zone card and in a thread attachment. A surface that cannot get a summary still renders the frame with the placeholder.

### Credit and text alternative

The `alt` text is the subject's title. Decorative repeats of a cover next to its visible title use `alt=""`. Where a cover is shown at `lg` or larger, its credit (rights holder, and the source it came through) is reachable from the cover: in a caption on the subject page (`caption`), and otherwise behind a small credit control on the cover that opens the rights holder, source and licence; the sources section lists it too. A `fill` frame shows the control from 240 px wide.

## Cover cards

Import `CoverCard`, `CoverGrid` and `CoverRow` from `@rezics/ui/cover-card`.

Any surface that shows a subject as a card (shelves, Continue, home rows, collections, search results in grid
mode, relation, edition and character tiles) follows one pattern:

- The cover fills the tile's top edge to edge, followed by the caption on the page background. The tile has no
  background, outline, border or shadow, including on hover. Keyboard focus shows a visible ring around the whole
  tile. `Cover` owns the one cover radius. The cover frame in a tile, each `CoverRow` or `CoverGrid` item and a
  standalone `Cover` use that radius; the `CoverRow` rail uses it too, while `CoverCard` sets no radius of its own.
  At 1280 px about eight tiles fit per row with an 8 px gap; the title is centered on at most two lines with an
  ellipsis.
- Below the cover: the title clamped to two lines, then at most one line of secondary text (creator, year or
  relation label), then the item's one row of state (progress, status or score). Nothing else; details belong on
  the subject page. The placeholder in a tile shows only its colour field because the title is already visible.
- Every cover in a grid or row has the frame ratio rules of [Cover](#cover), so covers align across the row and
  text starts at the same height.
- The whole card is one link to the subject; a site passes its client-side router link as `link`. Actions on the item (change status, remove, add to collection) live
  in the card's ⋯ menu, never as a button or select on the card.
- Grid columns follow the container width (two on a phone, more on wider screens), with the same gap between
  cards in both directions.

A tile with progress takes `progress={{ value, label }}` and renders `ProgressRow` in its state line. A known fraction
shows the bar and percentage on one line; unknown progress shows its position label without a bar. Pages do not build
their own progress row inside a cover tile.

A tile can take `status={{ label, href? }}`. The caller passes the status label already localized for the subject
profile. The quiet, neutral chip sits in the caption after the title and byline and before progress; its ink uses the
foreground or muted-foreground token. A long label stays on one line and truncates while remaining available to
assistive technology. When `href` is present, the chip is a separate link above the stretched subject link, so pointer
and keyboard users can reach it; keyboard order is subject, status, then the menu.

## Progress

Import `ProgressRow` from `@rezics/ui/progress-row`.

Reading, watching or playing progress shows as one row: the item's ⋯ menu at the start where the card has one, a
thin progress bar filling the remaining width, and the percentage after it in tabular figures. The bar and the
number never sit on separate lines. Where a unit is meaningful the number may be the unit instead ("Ep 3/12",
"p. 120/310"), with the same row layout. An item without known progress shows no bar rather than an empty one.
`CoverCard` builds this row when given `progress={{ value, label }}`; `value` is a fraction from 0 to 1, or `null`
when only the position label is known.

## Shelves

A person's library follows what mature shelf apps share ([research](../../docs/research/library-shelves.md)). Work on
the shelf or its cover tiles starts by reading the reference source kept in the main checkout's `.reference/shelves/`
(index in `.reference/INDEX.md`): Readest `apps/readest-app/src/app/library/components/` (`BookItem.tsx`,
`Bookshelf.tsx`, `ReadingProgress`), Koodo Reader `src/components/bookCoverItem/` and `bookCardItem/`, Kavita
`UI/Web/src/app/cards/`, Komga `next-ui/src/components/book/card/BookCard.vue` and Stump
`packages/browser/src/components/book/BookCard.tsx`. Learn the density, spacing and progress placement there and
implement them in this stack.

- **Structure.** Status tabs with counts (All, In progress, Planned, Completed, Paused, Dropped, Collections). All is
  an overview with one section per status, In progress first as Continue, empty sections hidden. A type filter row
  (books, anime, …) appears when the library holds more than one type.
- **Layouts.** Grid (default), List, and Table on wide screens; on narrow screens Table shows as List. The grid has
  three sizes (small, medium by default, large), each with a minimum card width. Columns follow the container width
  as [Cover cards](#cover-cards) describes; at wide widths small fits more cards and large fits fewer.
- **Grid.** [Cover cards](#cover-cards) with the [progress row](#progress) for items in progress; the secondary line
  shows the active sort key ("Finished 3 days ago"); a badge counts new episodes or chapters past the reader's
  progress.
- **List.** Thumbnail, title, a status chip that opens the status menu, the progress row with a −/+ step, relative
  last activity, and the item menu.
- **Table.** Status, progress and rating editable in place, a column picker, a sticky header and sorting by column.
- **Controls.** Each tab offers the sorts that suit it (Completed defaults to date finished, Planned to date added);
  active filters show as removable chips with Clear filters; selection by a Select button, a checkbox on hover, a
  long press or shift-click ranges, with a bottom bar for Select all matching, status, collections and remove.
- **Persistence.** Tab, sort, filters, layout and position live in the URL; layout, sort and grid size are also saved
  to the reader's account and follow them across devices; a URL value wins.
- **Phone.** Sort, filter and display share one bottom sheet; menus open as bottom sheets; nothing depends on hover.
- **Empty and dates.** "Nothing here yet" (with Browse and Import) is distinct from "nothing matches these filters"
  (with Clear filters); dates are relative within a week, with the exact time on hover.

## Media image

`MediaImage` draws an image inside a document or a gallery that is not a subject cover. Import it from `@rezics/ui/media-image`. It takes the same image summary as `Cover` (`media`, `width`, `height`, `placeholder`, `variants`), a `src` builder from the site that turns `{ media, format, width }` into a URL, the `alt` text and a `sizes` string.

- The frame reserves the image's own ratio before any byte arrives and stops at the image's own width, so the page does not shift and a small image is never enlarged. `frame` sets one ratio for gallery tiles that must align; the image is then cropped to it.
- The stored placeholder colour is painted behind the image while it loads. A summary without a safe colour falls back to the surface tone.
- `<picture>` offers AVIF before WebP, each with `srcset` from the variants the summary lists and the `sizes` prop. Images load lazily; `priority` loads one eagerly with high fetch priority.
- A failed image, or a summary with no variants, becomes a quiet frame of the same size holding the alt text. The browser's broken-image icon never appears. An empty `alt` marks the image decorative and leaves the frame blank.

The variant and placeholder code lives in `media-image-sources.ts`, so `Cover` can import the same summary types and `srcset` writer.

## Entity picker

`EntityPicker` chooses subjects by searching. Import it from `@rezics/ui/entity-picker`. The site passes `search(text, signal)`, which resolves `{ id, title, types, typeLabel, year?, cover }[]`, and the `src` builder `Cover` needs.

- It searches as the person types, after a pause (`debounce`, 250 ms by default), and aborts the search a newer keystroke makes stale. Results of an aborted search are never shown.
- Each result shows a small cover, the title, and the type label and year. The `id` is passed back through `onValueChange` and never rendered. The cover is `Cover` at `xs`, so a subject with no image shows its placeholder; rows share one frame ratio so covers align. `cover` is the `Cover` summary.
- Arrow keys move through the results and Enter selects, as in the shadcn `combobox` it builds on. `multiple` keeps the chosen subjects listed below the search box, each with a remove button.
- An empty answer says nothing matches the text. A failed search says so in words and offers Try again. While a search is running the earlier results stay but cannot be chosen.
