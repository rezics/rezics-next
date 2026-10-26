# Rezics UI

`@rezics/ui` is Rezics's shared React component library. Import components from `@rezics/ui/button`, shared hooks from `@rezics/ui/hooks/use-is-mobile`, and the theme stylesheet from `@rezics/ui/styles.css`.

Run `bun run storybook` in this directory to review components. Run `bun run check` to type-check the package and run its unit and accessible browser story tests.

Tests run in a private network namespace that holds only loopback, so changes to the host's network interfaces cannot interrupt browser requests. Run one test file with `bun run test <file>` to use the same isolation. Run `bun run test:stories:slow-frames` after changing a story or an editor or overlay component: it delays every animation frame by 400 ms, which reproduces the failures a loaded host causes.

The logo red (`--brand`) marks identity and never colors text; use ink blue (`--primary`) for colored text and actions. Use Manrope for interface text and Source Serif 4 for Work titles only. Fonts are self-hosted, and theme selection belongs on `<html>` without a script. Mark icons in red with `fill-*` or `stroke-*` utilities, never `text-brand`.

## shadcn components

Before building any interface piece, look it up in [SHADCN.md](SHADCN.md), which lists every item in the shadcn registry with its purpose and add command, and add it from shadcn when it exists. Build our own only for what shadcn does not offer, and say so in that component's doc comment.

The package uses shadcn's Rhea style on the Base UI primitives (`components.json`, style `base-rhea`). `apps/web/components.json` shares that configuration, so `bunx shadcn@latest add <name>` run from either directory writes into `packages/ui`.

- Files in `src/shadcn/` are exactly what the shadcn CLI writes. Never edit them by hand: brand changes belong in `src/styles.css`, and our own components in `src/components/`. Import them as `@rezics/ui/shadcn/<name>`; `src/index.ts` does not re-export them, because their names clash with the Ark components.
- The shadcn colour variables map to the Aura tokens in `src/styles.css`, layered after the Rhea defaults.
- Stories for shadcn components are `src/components/shadcn-<name>.stories.tsx`, titled `shadcn/<Name>`.
- `shadcn-sync.json` records the last successful sync time and CLI version. The daily GitHub check opens one shared `shadcn-sync` issue when that sync is more than seven days old; it never syncs components. Anyone with repository issue access can also run `bun run shadcn:sync-check` in this directory.
- Whoever takes the issue runs `bun run shadcn:sync` here as an ordinary task. It re-adds every cloned component from `shadcn@latest`, refreshes `shadcn-registry.json` and `SHADCN.md` with `scripts/shadcn-index.ts`, pins dependencies exactly, updates the sync record and shows the diff. Review all changes and run `bun run check` before committing. Include `Closes #<issue-number>` in the sync commit message; the issue closes when the commit reaches the default branch. The sync never runs automatically, so people do not redo it in parallel.
- To refresh only the capability index outside a sync, run `bun scripts/shadcn-index.ts`; `--offline` regenerates `SHADCN.md` from the committed registry snapshot.

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
| Book, edition, manga, light novel, comic volume  | 2:3                        |
| Anime series or film, live-action series or film | 2:3 (poster)               |
| Visual novel, game                               | 3:4 (package art)          |
| Music release                                    | 1:1                        |
| Recipe, place, event                             | 4:3                        |
| Character, person                                | 3:4 (portrait)             |
| Organization, Realm, Zone, concept               | 1:1                        |

The ratio is resolved from the subject's semantic type through its structural bases, the same way templates resolve; a creative work with no more specific type uses 2:3 and anything else uses 1:1. A coarse resource class, an empty type list or a summary that dropped the types never decides the ratio, so every read that feeds `Cover` carries the subject's type.

A row, grid or list that mixes types uses one frame ratio for all its items (the ratio of most of its items, 2:3 when tied), so mixed shelves stay aligned; each image is then fitted by the rule below. A Zone's `cover` appearance token (`portrait`, `square`, `landscape`) chooses that shared ratio on its pages instead. A single-type list and the subject page header always use the type's own ratio.

An image whose own ratio is within 15% of the frame fills it (`object-fit: cover`). A wider or taller image is shown whole (`object-fit: contain`) on a backdrop of its own placeholder colour, so landscape package art or a square album cover in a portrait slot is never cut to a sliver. Portraits of characters and people keep the top of the image when they are cropped (`object-position: top`); other images keep their stored focal point, or the centre.

### Typographic placeholder

The placeholder is designed, not empty: the subject's title set in the Work title face, its principal creator or type label in the interface face, on a background chosen deterministically from the subject id within the type's palette. It never shows a generic icon alone. Below 64 px a set title is unreadable, so the placeholder there shows the title's initials on the same background, and every surface that uses those sizes prints the subject's name beside the cover. Text stays legible against its background in both themes. The same subject always gets the same placeholder, on every surface.

### Sizes and loading

`Cover` takes a named size (`xs` 48 px, `sm` 96 px, `md` 160 px, `lg` 240 px, `xl` 320 px wide in CSS pixels) or `fill` for a frame sized by its parent. It writes `srcset` from the variants the kernel returned, offers AVIF before WebP through `<picture>`, and sets `sizes` from the named size so the browser picks the smallest sufficient variant. It sets intrinsic `width` and `height` from the frame. Covers below the first viewport load lazily; the subject page's own cover loads eagerly with high fetch priority because it is usually the largest element.

### One summary everywhere

Every surface builds `Cover` from the cover summary the kernel returned with the subject, never from a per-surface reconstruction, so the type, crop, placeholder and credit are the same on the subject page, in search, on a Zone card and in a thread attachment. A surface that cannot get a summary still renders the frame with the placeholder.

### Credit and text alternative

The `alt` text is the subject's title. Decorative repeats of a cover next to its visible title use `alt=""`. Where a cover is shown at `lg` or larger, its credit (rights holder, and the source it came through) is reachable from the cover: in a caption on the subject page, and in the sources section.
