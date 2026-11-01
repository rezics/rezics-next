# Rezics UI

`@rezics/ui` is Rezics's shared React component library. Import the base controls from `@rezics/ui/shadcn/<name>` (see below), the site's own components from `@rezics/ui/<name>` such as `@rezics/ui/cover`, shared hooks from `@rezics/ui/hooks/use-is-mobile`, and the theme stylesheet from `@rezics/ui/styles.css`.

Run `bun run storybook` in this directory to review components. Run `bun run check` to type-check the package and run its unit and accessible browser story tests.

For isolated local agent inspection, follow [Storybook agent access](../../docs/development/storybook.md#agent-access).
UI exposes `/mcp` and `/manifests/components.json` on its own dev server, using the same React docgen metadata
configuration as Web. Discover canonical component and story IDs with the installed documentation tools after the
index and manifest are ready. Set Web's `STORYBOOK_UI_URL` to this UI server's origin when composing both catalogues.

Tests run in a private network namespace that holds only loopback, so changes to the host's network interfaces cannot interrupt browser requests. Run one test file with `bun run test <file>` to use the same isolation. Run `bun run test:stories:slow-frames` after changing a story or an editor or overlay component: it delays every animation frame by 400 ms, which reproduces the failures a loaded host causes.

The logo red (`--brand`) marks identity and never colors text; use ink blue (`--primary`) for colored text and actions. Source Serif 4 sets the cover placeholder's title and Work titles marked inside documents; titles in rows, cards and page headings use Manrope. Fonts are self-hosted, and theme selection belongs on `<html>` without a script. Mark icons in red with `fill-*` or `stroke-*` utilities, never `text-brand`.

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

## Form fields

Fields that choose one value from a fixed list use `NativeSelect` from `@rezics/ui/shadcn/native-select`, with
`NativeSelectOption`s, inside a shadcn `Field` with a `FieldLabel` from `@rezics/ui/shadcn/field`. This keeps form
choices native, consistent with other fields, and available before hydration. `Menu` is for actions and navigation,
not form values.

For ordinary sliders, associate a visible label with `aria-labelledby` and use the supported `locale` and `format`
props for numeric value text. The rating components compose [Base UI slider parts](https://base-ui.com/react/components/slider)
directly because the native range needs question-specific value text, including the unrated state. The actual
`Slider.Thumb` supplies its native input's label and formatted value; the root remains a group. This specialization
belongs in the rating components, not in a generic slider wrapper.
Editable input, textarea, grouped combobox and select boundaries use `--control`, with at least 3:1 non-text
contrast on Aura's light and dark surfaces. Decorative borders keep `--border`. Focus retains the blue ring;
invalid fields retain the danger boundary and disabled controls retain their disabled state. Grouped inputs draw
one outer boundary. Theme adaptations live in `styles.css`; generated shadcn controls stay unchanged.

Below 768px or with a coarse primary pointer, editable controls and standard action buttons have a minimum 44px
target. Fine-pointer desktop controls retain their dense sizes. Inline combobox tokens and editor toolbar buttons
keep their own composition; callers must not treat an inline token as a standalone action.

## Menu

Use `Menu` from `@rezics/ui/menu` for package menus. It takes one ordered entry list for items, links, radio groups,
submenu pages, separators and destructive actions. Below the `md` breakpoint, or with a coarse primary pointer, the
menu opens as a bottom sheet with a title and touch rows at least 44px high. On wider fine-pointer screens it opens as
a dropdown anchored to its trigger. Menu labels, including the title and Back control, come from the caller's native
locale messages. A submenu becomes a sheet page; browser Back returns to the previous page and then closes the sheet.
Selecting a radio value closes the menu once. Escape closes either form, and focus returns to the trigger.
Custom menu content with client-side links can set `closeOnNavigation` so following a link closes the menu without
adding a sheet-history entry.

Callers use `Menu` or a component built on it; they never import shadcn's dropdown primitive to implement a
menu. `editor-selection-menu.tsx` is a floating formatting toolbar over a text selection, not a menu. `cover.tsx`'s
credit control is not a menu.

- **Operation:** Render a menu and its entries.
- **Touches:** No new reads; rendering only, over data the page already loaded.
- **Bound:** Constant work per entry rendered.
- **Growth check:** None; no read path changes.

## Bottom sheets

Callers use `Menu` or `BottomSheet` and never import the shadcn drawer. Every sheet always shows a grab handle, title
and Done control, and keeps safe-area padding below its scrollable body.

## Editor and document body

The rich-text editor keeps Tiptap and the document model (`@rezics/document`) and draws its controls from the shadcn primitives: `dropdown-menu` for the block menu, `toggle`, `button` and `tooltip` for the selection menu and the touch bar, `sheet` for the touch block picker, `command` for the slash menu, and `field` with `input` for the link and image forms. Two things stay in our own components, because shadcn has no equivalent: Tiptap's bubble menu places the selection and link menus against a range of text (a shadcn popover anchors to a trigger element), and the toolbar role with one tab stop and arrow-key travel is not in the registry.

shadcn menus and sheets render in a portal on the page, not inside the story canvas, so a story finds them with `screen`. A layer that takes focus must hand it back through Tiptap's frame-deferred restore (`returnFocus` in `editor-selection-menu.tsx`); wait for the editor to hold focus before sending the next key.

`RichTextEditor` accepts an optional `lookupMention(handle, signal)` source. After a 200 ms typing pause, `@handle` offers one exact account match; stale lookups are aborted, keyboard or pointer selection inserts an inline `mention` with only its `accountId`, and Escape keeps the typed text. Without a source, `@` stays plain text. `DocumentBody` accepts a `mentions` map of account ids to current handles and a `locale` (English by default); it renders localized agent links, or a plain `@` for unresolved accounts. Handles are rendered as text, never HTML.

`Prose` is the surface for documents, in the reading page (`DocumentBody`) and in the editor. Body text is interface text. Only a Work title, marked with the `work-title` class, takes the serif face. A line holds about 65 characters (36 em for Chinese, Japanese and Korean, where a character is an em wide), and CJK text gets more leading. The styles live in `src/prose.css`.

## Content feedback

`Reactions`, `ContentActions`, `ReportDialog` and the rating components use the shared `Menu` for choices and overflow actions, with shadcn primitives for buttons, confirmations, dialogs, fields, textareas, sliders and badges.

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
shadcn `Toaster` mounted once at the application composition root (`AppShell` on the web). Pages and their Library
regions share that provider without adding a Toaster. Standalone stories and fixtures must supply one provider;
intentionally independent managers may each own a separate Toaster. It announces the result politely and offers Undo for eight seconds, including while
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

Every kind defaults to the same portrait frame, **5:7** (width:height): books, editions, manga, anime,
films, games, albums, recipes, people, characters, organizations, Realms, Zones, concepts and unknown Types.
Source artwork dimensions never choose the frame. `coverRatio(types)` and `sharedRatio(subjects)` return this
stable default, including for an empty type list or composition. The current catalogue declares the same default
through inherited `coverRatio` and `listPresentation` annotations.

5:7 (0.714) is close to common book, disc-case and poster proportions. An explicit valid `ratio` remains supported,
as do configured list aspects. A parsed `listPresentation` takes precedence over a composition `ratio`, then the
shared default applies. The subject page resolves an explicit released `coverRatio` through structural bases;
a missing annotation falls back to the shared default. Historical releases and user configuration retain their
valid alternate ratios. Members keep their actual semantic Type and factual hints regardless of Collection kind.

An image whose own ratio is within 15% of the frame fills it (`object-fit: cover`). A wider or taller image is shown whole (`object-fit: contain`) on a backdrop of its own placeholder colour, so landscape package art or a square album cover in a portrait slot is never cut to a sliver. Portraits of characters and people keep the top of the image when they are cropped (`object-position: top`); other images keep their stored focal point, or the centre.

### Typographic placeholder

The placeholder is designed, not empty: the subject's title set in the Work title face, its principal creator or type label in the interface face, on a background chosen deterministically from the subject id alone. Its colour does not depend on the title, byline or type, so the same id always looks the same on every surface. At 64 px and wider, every placeholder shows the title in the colour field, including tiles and list rows beside a visible title. Below 64 px it shows one centred neutral image icon on the colour field, with no text or initials. Titles wrap at normal word boundaries; CJK may break between characters. A word wider than the field reduces the type size instead of splitting, and longer titles are clamped with an ellipsis to the lines that fit. Text stays legible against its background in both themes.

A suitability-withheld cover shows its decoded ThumbHash blurred behind the label and the reveal button, and requests no image byte until the viewer reveals it. `placeholder.color` is painted first, and the ThumbHash (decoded with the `thumbhash` package) over it while the image loads; a contained image keeps the colour alone as its backdrop. The placeholder colour is derived only from the subject id, and its light text keeps at least 5.5:1 contrast in both themes and at every size. At 64 px and wider, the placeholder also shows the byline when available. The labels (`withheld`, `reveal`, `credit`, `via`) are English by default and the site passes translations in `labels`.

### Sizes and loading

`Cover` takes a named size (`xs` 48 px, `sm` 96 px, `md` 160 px, `lg` 240 px, `xl` 320 px wide in CSS pixels) or `fill` for a frame sized by its parent. It writes `srcset` from the variants the kernel returned, offers AVIF before WebP through `<picture>`, and sets `sizes` from the named size so the browser picks the smallest sufficient variant. It sets intrinsic `width` and `height` from the frame. Covers below the first viewport load lazily; the subject page's own cover loads eagerly with high fetch priority because it is usually the largest element.

### One summary everywhere

Every surface builds `Cover` from the cover summary the kernel returned with the subject, never from a per-surface reconstruction, so the type, crop, placeholder and credit are the same on the subject page, in search, on a Zone card and in a thread attachment. A surface that cannot get a summary still renders the frame with the placeholder.

### Credit and text alternative

The `alt` text is the subject's title. Decorative repeats of a cover next to its visible title use `alt=""`. The subject page opens a viewer from its cover, where the original image appears with its rights holder, linked source and licence. Sources and credits are collected in the page's Sources section; covers never render a caption or credit control.

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
  the subject page. The last row places state or progress first and the menu at the end, aligned with the cover’s right edge. It sits at the bottom of the full-height tile so tiles in a grid row line up. A menu alone stays at the end; with neither state, progress nor menu, no last row is rendered.
- Every card defaults to the shared portrait frame and honors its actual member Type's configured list aspect. Its title and metadata remain attached beneath that image;
  a grid's composition ratio is only the fallback when the member has no known list presentation.
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

## Choice controls

Checkboxes and radio buttons use the shadcn `Checkbox` and `RadioGroup` inside a `Field`. A control that must work before hydration uses `NativeCheckbox`. Callers never render a bare checkbox or radio input.

## Lists

Import `ListRow`, `ListRowLink` and `ListRowControl` from `@rezics/ui/list-row` for item lists. Rows have no fixed height, dividers, borders or card background at rest. The rounded overlay is the only hover, keyboard-focus and press state. Stretch the title link over the row, and put controls or secondary links above it in `ListRowControl`. Prefer a larger vertical cover over denser rows: covers are at least 72 px wide on a phone and 96 px from `sm` up, at the subject's own ratio. Grids of cover cards are not lists.

### Content items

Import `ContentItem` and `ContentItemProps` from `@rezics/ui/content-item` for a shared content row. Place each item in an ordinary `ul` or `ol`; it renders exactly one `li`. The required `title` renders as a named `h2`, `h3` or `h4` (default `h2`). With `href`, one native `ListRowLink` is stretched across the row and labelled by that visible heading; without a destination, the heading remains plain text. No slot is nested inside the primary anchor, and there is no duplicate title link or tab stop.

The optional slots render in this order: `visual`, `context`, `metadata`, `preview`, `state`, `actions`, `trailing`, with the title between context and metadata. A visual supplies its own cover or avatar width; omitting it leaves the content column flush with the row rather than an empty visual column. Use `metadata` for supplied facts and secondary links, `preview` for short content summaries, `state` for progress or status, and `actions`/`trailing` for actual independent controls. Metadata, state and controls sit above the stretched link. Buttons and links in state/action slots have at least 44 px targets, including on touch. Titles are 17–18 px on phones and 18–20 px on desktop; metadata is 13–14 px. Rows use 12–16 px vertical breathing room and 12–16 px phone / 16–20 px desktop gaps. The component forwards ordinary `li` attributes, including `data-*`, and uses the `ListRow` overlay for hover, focus and press, with a visible focus outline and reduced-motion transition handling. Native forced-colors behavior is retained by using ordinary headings, links, controls and list semantics.

`ShelfListRow` from `@rezics/ui/shelf-list` remains the compatibility adapter for library callers. It composes the shared item while preserving selection callbacks, status and overflow menus, progress labels (including unknown values), cover presentation, date and progress controls. Use `ShelfTable` for tabular data rather than changing table semantics. The shared row keeps the established `ListRow` hover, focus and press overlay as its sole surface feedback.

### List presentation

The joint authority is [Collection presentation](../../docs/collection-presentation.md). Import `MemberListRow`
from `@rezics/ui/list-presentation` and the `ListPresentation` type from `@rezics/ui/cover`. Both member rows and
`CoverCard` accept optional effective `listPresentation` input: `imageAspect` chooses portrait 5:7, landscape 16:9
or square 1:1; `keyFacts` selects up to four ordered unique effective property CURIEs. The renderer never invents
inherited hints or fact values. The caller supplies already available, localized facts as content or card metadata.

`MemberListRow` keeps its existing public props for Search and Collection callers while adapting to `ContentItem`: the
title is the shared named heading and stretched primary link, the decorative `Cover` remains the leading visual, its
supplied children stay together as raised metadata, and `trailing` remains an independent control slot. Its
`storyOverlay` prop enables the shared forced overlay for stories. The existing `member-list-row-title` selector stays
on the actual heading alongside ContentItem's `data-content-item-slot="title"`; the cover keeps its
`member-list-row-cover` selector. The adapter does not fetch or derive member facts; the caller supplies any already
available localized facts and links.

The current released hints and exact Type fallbacks all select portrait 5:7. Unknown Types retain a valid
configured composition ratio, otherwise the same portrait default. A Collection kind may guide composition;
it never rewrites a member's actual Type. Rows use 72/96 px portrait and square frames and 128/192 px explicitly
configured landscape frames on phone/desktop, with a common radius and two-line attached title. Artwork keeps
its own dimensions and fit independently of the frame. Standalone `Cover` accepts list presentation when passed.

The complete behavior folder is `Components/List Presentation`, with attached docs, keyboard focus, actual menu
interaction and suitability reveal. Hand off every same ID below for **both phone 390 and desktop 1280**, with
`en`/`zh-Hans` locale globals and light/dark theme globals. Width, locale and theme are not separate behavior states.

| State         | Story ID                                      |
| ------------- | --------------------------------------------- |
| Book          | `components-list-presentation--book`          |
| Video         | `components-list-presentation--video`         |
| Anime         | `components-list-presentation--anime`         |
| Music         | `components-list-presentation--music`         |
| Recipe        | `components-list-presentation--recipe`        |
| Mixed         | `components-list-presentation--mixed`         |
| Missing image | `components-list-presentation--missing-image` |
| Withheld      | `components-list-presentation--withheld`      |
| Key facts     | `components-list-presentation--key-facts`     |
| Unknown Type  | `components-list-presentation--unknown-type`  |

## Metadata lines

Use `MetaLine` (or `metaText` for string props) for metadata separators; each separator stays with the following item so a wrapped line never ends with one, and separators are decorative to screen readers.

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

- **Structure.** Continue appears above Collection shortcuts and one paged list of tracked entries. Each tile shows a
  status chip when web knows its label; state filters the same list. A type filter row (books, anime, …) appears when
  the library holds more than one type. Collection shortcuts show the first eight owner Collections and link to All
  Collections.
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
- Long result and selected titles wrap to at most two lines; type metadata clips to one line. Status text wraps,
  the popup fits the available viewport, and selected rows reserve space for their remove control. A disabled
  picker disables both its native input and removal. Presentation never substitutes ids or manufactures results;
  the caller's independent search remains authoritative. Imports owns exact-value forms, Commerce owns copy
  selection, and Accounts owns agent selection.
