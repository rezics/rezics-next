# Shelf layout references

How mature open-source library and shelf apps lay out a person's shelf, and what the REZICS shelf should take from
them.

## Method

- On 2026-10-27, 16 projects were shallow-cloned into a reference directory outside the repository. Only their
  source was read; nothing was installed, built or run.
- All paths in this document are relative to that directory.
- "Inferred" marks a point that was read from CSS or arithmetic rather than seen directly in code.

| Clone                 | Upstream                                    | Commit  | Last commit |
| --------------------- | ------------------------------------------- | ------- | ----------- |
| kavita                | Kareadita/Kavita                            | d549d5b | 2026-10-22  |
| komga                 | gotson/komga                                | 023ec90 | 2026-10-21  |
| stump                 | stumpapp/stump                              | d0f51c8 | 2026-10-20  |
| audiobookshelf        | advplyr/audiobookshelf                      | edb1f7e | 2026-10-23  |
| jellyfin-web          | jellyfin/jellyfin-web                       | b37b505 | 2026-10-27  |
| suwayomi-webui        | Suwayomi/Suwayomi-WebUI                     | 7d9f8ee | 2026-10-27  |
| koodo-reader          | koodo-reader/koodo-reader                   | fe1abf4 | 2026-10-27  |
| readest               | readest/readest                             | 44c9015 | 2026-10-26  |
| bookorbit             | bookorbit/bookorbit (successor of BookLore) | 99aa7dc | 2026-10-21  |
| booklore              | booklore-app/booklore (maintenance mode)    | 01b3407 | 2026-09-19  |
| calibre-web           | janeczku/calibre-web                        | 6e840ac | 2026-09-20  |
| calibre-web-automated | crocodilestick/Calibre-Web-Automated        | 4fc2c44 | 2026-10-01  |
| bookwyrm              | bookwyrm-social/bookwyrm                    | fe2fa0b | 2026-10-26  |
| ryot                  | IgnisDa/ryot                                | b42a770 | 2026-10-25  |
| yamtrack              | FuzzyGrim/Yamtrack                          | 5cd5343 | 2026-10-25  |
| seanime               | 5rahim/seanime                              | 4bdff7b | 2026-10-14  |

The projects fall into four groups:

- **Library servers:** Kavita, Komga, Stump, Audiobookshelf, Jellyfin, Suwayomi.
- **Reader apps:** Koodo, Readest.
- **Book managers:** BookOrbit, BookLore, Calibre-Web, CWA.
- **Closest analogues to REZICS:** BookWyrm, a social catalogue with status shelves, and Ryot, Yamtrack and Seanime, which are multi-media trackers with planned / in progress / completed / paused / dropped statuses.

## 1. Comparison

| App                   | License                        | Front end                              | Layouts                                                                        | Size control                                         | Progress on the card                                           | Layout remembered                                              | Selection                                                                                       | Phone                                                                           |
| --------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Kavita                | GPL-3.0                        | Angular 22                             | Grid only. A list enum exists but is unused. Dashboard carousels.              | None (theme variables)                               | 5px bar only while 0 < read < total; unread corner triangle    | n/a; filter and sort in URL                                    | Hover checkbox, then click toggles; shift range; long press; top bar                            | About 2 columns (inferred); filter drawer; menu becomes a modal                 |
| Komga next-ui         | MIT                            | Vue 3, Vuetify 4                       | Grid, list (a `table` enum is unused); overview rows                           | Slider 130–200px, default 150                        | 10px bar on in-progress books; unread-count or check badge     | Per view key in localStorage; filters URL-only                 | Hover circle, then click toggles; long press opens a sheet with "Select"; select all / add page | Grid forced at 3 columns below 600px; sheets; bottom selection bar              |
| Komga classic         | MIT                            | Vue 2, Vuetify 2                       | Grid only; A–Z bar                                                             | None                                                 | 6px bar; unread tick or count                                  | Per library in localStorage, mirrored to URL                   | Hover circle, shift range                                                                       | 2 columns                                                                       |
| Stump                 | MIT (web); `apps/expo` GPL-3.0 | React 19, Tailwind 4                   | Grid, table with column picker; fanned series stacks                           | 6 named presets mapped to columns per device class   | Bar under the cover plus "NN% · N pages left" / "Completed"    | Per view in localStorage; density global; filters in URL       | None in the web app                                                                             | Default 2 columns (1–4); table allowed                                          |
| Audiobookshelf        | GPL-3.0                        | Nuxt 2, Tailwind                       | Grid drawn as shelf rows (wooden or plain, set by admin); collapse series      | 9 presets (60–220) on a floating −/+ pill            | Bottom-edge bar, yellow in progress, green finished            | Global in localStorage, mirrored to URL                        | Hover radio, then click toggles; shift range; app bar replaced                                  | Columns from a width formula; tab strip                                         |
| Jellyfin web          | GPL-2.0+                       | React 18, MUI 6 (plus a legacy JS app) | Grid with image types (poster, thumb, banner…), list; legacy has 6 view styles | None (CSS % widths)                                  | Bar in footer only when partly played; check or unplayed count | Per library and tab in localStorage                            | 550ms long press or "Select" menu entry; top bar with ⋮                                         | 3 portrait columns; toolbar wraps                                               |
| Suwayomi WebUI        | MPL-2.0                        | React 19, MUI                          | Compact grid, comfortable grid, list                                           | Item-width slider 100–1000px, in settings            | None; unread and downloaded badges (off by default)            | Server: display global, sort and filter per category           | Toolbar select-all; shift or long-press range; FAB                                              | Width formula; options bottom sheet; bottom nav                                 |
| Koodo Reader          | AGPL-3.0                       | React 19                               | Card grid, list, cover-detail cards; 2×2 collection mosaics                    | Scale slider 0.6–2.0                                 | Text "New", "37.25%", "Done"                                   | Global (localStorage plus sync)                                | Hover check, menu, shift range                                                                  | No phone layout                                                                 |
| Readest               | AGPL-3.0                       | Next.js 16, Tauri                      | Grid, list, per-shelf carousel; group mosaics; rule-based shelves stacked      | Auto columns by breakpoint, or a manual number       | "NN%" text; FINISHED / ON HOLD chips                           | Local settings plus URL; shelf definitions synced              | Select button, 500ms long press, select all; bottom bar                                         | Auto 3 columns; long press; pull to refresh                                     |
| BookOrbit             | AGPL-3.0 plus §7 terms         | Vue 3.5, Tailwind 4                    | Grid, list, table (26 columns, presets, density); series stack cards           | Cover-size slider 100–280px plus gap slider          | 3px bar, status icon; overlays chosen by the user              | Mode global (local); cover size per view; optional server sync | Select toggle, shift range from anchor, "select all N matching"; bottom pill                    | Table becomes grid below 768px; display bottom sheet; first tap reveals actions |
| BookLore              | AGPL-3.0                       | Angular 21, PrimeNG                    | Grid, table                                                                    | Scale slider 0.5–1.5×; 2/3/4-column buttons on phone | Up to 3 stacked bars                                           | Server: global plus per library or shelf, overridden by URL    | Hover checkbox, Ctrl and shift                                                                  | 2/3/4 column presets                                                            |
| Calibre-Web           | GPL-3.0                        | Flask, Jinja, Bootstrap 3              | Grid, editable table (separate page)                                           | None                                                 | None (a read tick only)                                        | Server `view_settings` per view                                | Table only: checkbox, select all                                                                | 2 columns; sort hidden on phones                                                |
| Calibre-Web-Automated | GPL-3.0                        | Same as Calibre-Web                    | Adds rule-based "magic shelves"                                                | None                                                 | Detail page only                                               | Same as Calibre-Web                                            | Table toolbar, shift range                                                                      | 3 columns; sort as a scrolling chip row                                         |
| BookWyrm              | Anti-Capitalist v1.4           | Django, Bulma                          | Table only; shelf strips on the profile                                        | None                                                 | None on the shelf                                              | n/a; sort and filter in URL                                    | None                                                                                            | Table rows become labelled stacked cards                                        |
| Ryot                  | GPL-3.0                        | React Router 7, Mantine 8              | Grid only                                                                      | None                                                 | 4px bar at the bottom edge                                     | n/a; filters in URL; saved presets on server                   | Bulk mode per collection; select all matching                                                   | 2 columns                                                                       |
| Yamtrack              | AGPL-3.0                       | Django, HTMX, Alpine, Tailwind         | Grid, table                                                                    | None                                                 | Status-coloured strip that is also the progress bar; "12 / 24" | Server, per media type (layout, sort, status)                  | None                                                                                            | 2 columns; table scrolls sideways                                               |
| Seanime               | GPL-3.0                        | React 19 SPA, Tailwind                 | Grid, carousel, sections per status                                            | None                                                 | 4px top bar (CURRENT only); "3/12" badge                       | Home sections on server; other views in memory                 | None                                                                                            | 2 columns; hover popup hidden                                                   |

## 2. Patterns most apps share

1. **The cover grid is the primary layout.** It is the default in 15 of 16 apps; BookWyrm, a table, is the exception.
2. **A second, text-dense layout is common.** 10 of 16 offer a list or table beside the grid:
   - Komga next-ui, Jellyfin, Suwayomi, Koodo and Readest have a list.
   - Stump, BookLore, Calibre-Web and Yamtrack have a table.
   - BookOrbit has both.
3. **Grid size is controlled by the reader in 8 of 16 apps.** The mechanisms differ:
   - A px slider: Komga, BookOrbit, Suwayomi.
   - A scale slider: Koodo, BookLore.
   - Named presets: Stump (6, mapped to columns per device class), Audiobookshelf (9 steps).
   - Columns: Readest uses auto columns or a manual number; BookLore uses 2/3/4 buttons on phones.
4. **Phone grids sit at 2–3 columns, and nobody forces a list on phones.**
   - 3 columns: Komga, Jellyfin, Readest, CWA.
   - 2 columns: Kavita, Stump, Ryot, Yamtrack, Seanime, Calibre-Web, BookOrbit at default size.
   - Komga forces the grid on phones; BookOrbit swaps the table for the grid below 768px; BookWyrm turns table rows into labelled stacked cards.
5. **Progress is a thin bar on the cover edge.** 10 apps do this: Kavita, Komga, Audiobookshelf, Jellyfin, Ryot, BookOrbit, BookLore, Yamtrack, Seanime and Stump.
   - Several show it only while the item is in progress and hide it once finished (Kavita, Komga, Jellyfin, Seanime).
   - A count as text ("3/12", "12 / 24", "NN% · N pages left") is the second signal (Seanime, Yamtrack, Stump, Readest).
   - An unread or new-units count badge marks items with unread or unwatched units: Kavita, Komga, Jellyfin, Suwayomi, Seanime.
6. **Titles clamp to 1–2 lines.**
   - 2 lines: Komga, Stump, Suwayomi, Koodo, Seanime, BookOrbit.
   - 1 line: Kavita, Jellyfin, Ryot, Yamtrack, Readest, Audiobookshelf.
   - Audiobookshelf and Komga make the secondary line show the active sort key ("Added …", "Finished …", "Last progress …"). This explains the order without adding columns.
7. **Covers keep a fixed cell ratio.** Mismatched covers are handled in one of three ways:
   - Contain over a blurred copy: Audiobookshelf, BookOrbit.
   - Crop: Komga, Jellyfin, Stump, Suwayomi, Yamtrack.
   - Let the reader choose crop or fit: Readest, BookOrbit, Komga classic.

   Stretching (Kavita's default `object-fit: fill`, BookLore portrait covers) is the outlier. Missing covers get a generated panel with the title and author in Audiobookshelf, Readest, BookOrbit, BookWyrm and Koodo.

8. **The layout choice is remembered.**
   - Per view, library or media type: Komga, Stump, Jellyfin, Yamtrack, BookLore, Calibre-Web, BookOrbit (cover size).
   - Globally: Audiobookshelf, Koodo, Readest, Suwayomi.
   - On the server, so it follows the reader across devices: Yamtrack, BookLore, Calibre-Web, Suwayomi, BookOrbit (opt-in).
   - In local storage only: Komga next-ui, Stump, Jellyfin modern.
9. **Sort and filter state lives in the URL.** This is so in 11 apps: Kavita, both Komga UIs, Stump, Audiobookshelf, Readest, BookWyrm, Ryot, BookLore, Yamtrack, Calibre-Web, and Jellyfin (tab only).
   - When the URL carries no state, three apps fall back to stored preferences: Audiobookshelf, BookLore, Readest.
   - Active filters show as a badge or chips with a reset (BookOrbit, Komga, Jellyfin, Ryot, Seanime).
10. **Selection has a common shape.**
    - Desktop: a checkbox on the cover on hover. Once anything is selected, a click toggles instead of navigating (Kavita, Komga, Audiobookshelf, Koodo, BookLore).
    - Shift-click selects a range in 8 apps.
    - Touch: a long press of 300–1000ms (Kavita, Jellyfin, Readest, Suwayomi; Komga via a sheet).
    - An explicit Select button: BookOrbit, Readest, Suwayomi.
    - The most common bulk action is setting the status. BookOrbit and Ryot can extend the selection to "all N matching" the current query.
11. **Per-item menus open three ways:** a kebab (always shown, or on hover), right-click, and long press. The status actions, add to collection and Select are the common core. On phones the menu becomes a bottom sheet or modal (Komga, Kavita).
12. **Empty states split into "nothing here" and "nothing matches".**
    - Separate wording plus a "Clear filters" button: Komga, Audiobookshelf, BookOrbit, Stump, BookWyrm, Suwayomi, Kavita.
    - A call to action on an empty library: Yamtrack, Readest, BookWyrm, Seanime, Audiobookshelf (admins).
13. **A "continue" entry point appears in 10 apps.** It is a row, carousel or section ahead of the full shelf: Audiobookshelf, Jellyfin, Kavita, Komga, Stump, Seanime, BookOrbit, Readest, Ryot, Yamtrack.
14. **Explicit statuses come from the trackers.**
    - Yamtrack has exactly REZICS's five: Planning, In progress, Completed, Paused, Dropped.
    - Seanime uses AniList's statuses; BookWyrm has 4; Readest 4; BookOrbit 8; BookLore 9.
    - The comic and book servers derive unread / in progress / read from progress instead, so they cannot express paused or dropped.
    - Grouping by status appears as tabs (BookWyrm, Suwayomi categories with counts), as sections with counts (Seanime "All lists"), as a status filter (Yamtrack), or as group-by-status (Readest).

## 3. Recommended REZICS shelf

The structure follows the trackers, because REZICS has explicit statuses and several verticals. The layouts, density
and selection follow the library servers.

### 3.1 Structure

- **Status tabs:** All · In progress · Planned · Completed · Paused · Dropped · Collections.
  - Each tab shows its count; while filtering, the count reads "shown / total" (Suwayomi).
  - On phones the tabs scroll sideways (BookWyrm, Suwayomi, CWA).
- **All is an overview, not a merged inventory.** It has one section per status with a count and "View all N".
  - In progress comes first, as a single-row carousel ("Continue").
  - Empty sections are hidden (Seanime "All lists", BookWyrm profile strips, Readest stacked shelves, Yamtrack home).
  - This matches legacy REZICS, where All was the shelf list (`legacy-final:apps/web/features/library/state.ts`).
- **Vertical filter:** a chip row (All types · Books · Anime · Visual novels · Games · Recipes), shown only when the reader has items in more than one vertical. Ryot and Yamtrack split these into separate pages; one shelf with a filter fits the one-engine model better.
- **Collections:** the Collections tab shows collection tiles. Each tile is a 2×2 cover mosaic with a count (Koodo, Readest, BookOrbit mosaic mode). Opening a collection gives the same three layouts plus a manual order (Calibre-Web's manual-order switch, Kavita and Komga reading-list reordering).

### 3.2 Layouts

Three layouts:

- **Grid** is the default.
- **List** is the compact text layout.
- **Table** is for desktop only. Below 768px a saved Table preference renders as List (BookOrbit falls back to grid; Komga forces grid; List is closer to Table for a status shelf).

No other layouts: skeuomorphic shelves, banner and thumb card shapes, and cover-only grids add choices without adding information.

#### Per-item content

| Element   | Grid                                                                                                                                                                                                                                                                                              | List                                                                                                                                 | Table                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Cover     | Fixed cell, 2:3 in mixed views; a single-vertical view may use that vertical's ratio (for example recipes). A cover that is off by more than about 0.15 in ratio is shown contained over a blurred copy (Audiobookshelf `LazyBookCard.vue` L1083-1098; BookOrbit `blurred-fit`). Never stretched. | 48×72 thumbnail (Komga list keeps poster width; BookOrbit 64px)                                                                      | 40px thumbnail column (Stump, Yamtrack)                   |
| No cover  | Generated panel with title and creator (Readest `BookCover.tsx`, BookOrbit placeholder styles)                                                                                                                                                                                                    | Same, small                                                                                                                          | Same, small                                               |
| Title     | 2-line clamp                                                                                                                                                                                                                                                                                      | 1 line (2 on phones)                                                                                                                 | Full, wraps                                               |
| Secondary | One meta line: progress in the vertical's unit when in progress ("Ep 12 / 24", "p. 140 / 320", "37%"); otherwise the active sort key ("Finished 3 days ago", "Added 12 Mar", "★ 8"), as in Audiobookshelf and Komga                                                                               | Creator · year · type                                                                                                                | Creator and type columns                                  |
| Progress  | 3–4px bar on the bottom edge of the cover, only while in progress (Kavita, Komga, Jellyfin)                                                                                                                                                                                                       | Bar of about 96px plus unit text (BookOrbit list row); −/+ stepper for episodic items in progress (Yamtrack `progress_changer.html`) | Bar plus text, with an inline stepper                     |
| Status    | Icon chip at top-left, only where statuses mix (collections, search); omitted inside a status tab                                                                                                                                                                                                 | Status chip that is also a button opening the status menu (BookLore clickable status icon); replaces today's per-row dropdown        | Editable status cell (BookOrbit)                          |
| New units | Count badge at top-right when released units exceed progress (Seanime unwatched, Komga unread)                                                                                                                                                                                                    | Same badge after the title                                                                                                           | Column                                                    |
| Rating    | Hidden by default; optional in Display                                                                                                                                                                                                                                                            | Stars shown when rated                                                                                                               | Editable column                                           |
| Date      | Through the sort-key meta line                                                                                                                                                                                                                                                                    | Last activity, relative                                                                                                              | Added, Started, Finished, Last activity columns, relative |
| Actions   | Kebab: on hover with a fine pointer, always shown in the meta row on touch (Kavita puts it in the title row)                                                                                                                                                                                      | Kebab at the end of the row                                                                                                          | Kebab column and right-click                              |

**Table columns:**

- Available: cover, title, creator, type, status, progress, rating, added, started, finished, last activity.
- Visible by default: cover, title, type, status, progress, rating, last activity.
- Clicking a header sorts (BookWyrm, Stump, Calibre-Web), and the header is sticky (Stump).
- A column picker lists Visible and Hidden columns, drag to reorder (Stump `EntityTableColumnConfiguration.tsx`, BookOrbit `tableColumnSchema.ts`, Calibre-Web `table.js`).

#### Grid density

Three named presets, each mapped to columns per breakpoint (Stump `useGridSize.ts`):

| Preset           | < 640 | 640–1023 | 1024–1279 | 1280–1535 | ≥ 1536 |
| ---------------- | ----- | -------- | --------- | --------- | ------ |
| Small            | 4     | 6        | 8         | 10        | 12     |
| Medium (default) | 3     | 4        | 6         | 7         | 8      |
| Large            | 2     | 3        | 4         | 5         | 6      |

- **Why presets, not a px slider:**
  - One stored value gives a sensible column count on every device.
  - Phones stay in the 2–4 range that every app uses.
  - Stump's six presets give only four distinct column counts at phone width (compact and cozy both give 3; comfortable and spacious both give 2).
  - `packages/ui` has a segment group and no slider.
- **The Medium values follow the evidence:** Readest's auto columns are 3/4/6/8/12, Stump's default is 2/3/6/7/8, and Komga and Jellyfin both use 3 on phones.
- **Small shows the cover, progress bar and badges only.** The title stays as the accessible name and tooltip, following Stump, which drops to small text at its compact presets, and Audiobookshelf's text-free standard shelf.

### 3.3 Controls

**Toolbar, left to right:**

- search within the shelf, debounced about 300ms (Yamtrack, BookOrbit)
- Sort
- Filter
- the layout segment group (Grid / List / Table)
- Display, holding the density preset and, in Table, the column picker
- Select
- an item count ("N items", or "shown of total" when filtered)

**Sort:** a field plus a direction. Each tab offers only the sorts that mean something there; legacy REZICS already did this (`sortsFor` in `legacy-final:apps/web/features/library/state.ts`).

| Tab             | Default sort                | Also offered                                      |
| --------------- | --------------------------- | ------------------------------------------------- |
| In progress     | Last activity, newest first | Title, Date added, Rating, Release date, Progress |
| Planned         | Date added, newest first    | Title, Rating, Release date                       |
| Completed       | Date finished, newest first | Title, Date added, Rating, Release date           |
| Paused, Dropped | Last activity               | Title, Date added, Rating, Release date           |

**Filter:** type (vertical), rating (rated, unrated, at least n), collection, genre or tag, release year, and "has new units".

- The Filter button carries a badge with the number of active filters.
- Active filters show as removable chips with "Clear filters" (BookOrbit, Komga, Jellyfin, Ryot, Seanime).
- Three-state include/exclude, as in Komga and Suwayomi, can come later.

### 3.4 Selection and bulk actions

- **Entering selection mode:**
  - the Select button
  - on desktop, the checkbox that appears at the top-left of a cover on hover
  - on touch, a long press of about 500ms (Readest 500ms, Jellyfin 550ms)
  - "Select" in the item menu
- **Once selection mode is on:**
  - A click or tap toggles an item.
  - Shift-click selects the range from the anchor and gives it the anchor's state (BookOrbit `useBookSelection.ts:31-52`).
  - Esc leaves selection mode (Audiobookshelf).
- **Bar:** a bottom action bar using `packages/ui` `action-bar`, aware of the safe area, as in BookOrbit, Readest and Komga on touch. It holds:
  - "N selected"
  - Select all loaded, then a banner "Select all N matching" (BookOrbit `HomeView.vue` `querySelection`, Ryot)
  - Set status ▸
  - Add to collection
  - Remove from collection (inside a collection)
  - Remove from library, with a confirmation that names the history it removes (Ryot, Audiobookshelf)
  - Cancel
- **"All matching"** is sent as one query-scoped request through the API, which applies it on the server. It does not enumerate IDs in the browser.

### 3.5 Item menu

- **Entries:**
  - Status ▸, the five statuses with the current one checked (BookOrbit, BookLore)
  - Update progress…
  - Rate…
  - Add to collection…
  - Remove from this collection (inside a collection)
  - Select
  - Remove from library
- **How it opens:** on desktop it is a dropdown and also opens on right-click; on phones it is a bottom sheet (Komga `components/item/menu/Sheet.vue`).
- **Update progress** is a small form:
  - Its unit follows the vertical: pages or chapters, episodes, hours, or percent (Yamtrack units; Ryot converts units to percent).
  - It offers the matching status changes: reaching the total suggests Completed; logging progress on a Planned item moves it to In progress; marking Completed fills progress to the total (Yamtrack `app/models.py:898-930`, Seanime entry modal, BookWyrm reading modals).

### 3.6 Persistence

- **URL:** tab, type filter, sort, order, filters, layout and cursor. Views can then be shared and rendered on the server, as legacy REZICS already did with `view=`, and as Komga, Stump, Readest, BookWyrm and Ryot do.
- **Reader preference on the server, saved through the API when a control is used** (Yamtrack `views.py:168-180`, Calibre-Web `view_settings`, BookLore `entityViewPreferences`):
  - Layout, per type scope (All types, or each vertical), following Yamtrack's per-media-type and Komga's per-view keys. For example, anime can default to List while books stay Grid; Yamtrack defaults anime and manga to a table.
  - Sort and order, per status tab.
  - Density preset, global; columns are derived per breakpoint.
  - Table columns, global.
  - Each collection's own layout and manual order.
- **Precedence:** a URL value beats the stored preference without overwriting it, unless the reader changes the control (Audiobookshelf, BookLore, Readest).
- **Filters persist only in the URL.** Saved filter presets (Ryot, Kavita smart filters, BookOrbit "Save filter") can come later.
- **Not local-only storage** (Komga next-ui, Stump, Jellyfin modern): the shelf would look different on the reader's phone and desktop.

### 3.7 Phone behaviour (below 640px; the table cut-off is 768px)

- Grid at 2/3/4 columns by preset, Medium = 3. Table is not offered; List takes its place.
- Status tabs and type chips scroll sideways.
- **The toolbar collapses** to search, a "View" button and Select:
  - "View" opens one bottom sheet with Sort, Filter and Display tabs (Suwayomi `LibraryOptionsPanel.tsx`, BookOrbit display sheet).
  - "View" carries a badge counting active filters.
- Item menus and the status menu open as bottom sheets.
- A long press selects; the selection bar sits at the bottom, clear of the bottom navigation.
- **Nothing depends on hover.** The kebab is always visible in the meta row (CWA, Suwayomi and Seanime turn hover actions off on touch; Yamtrack has a preference for it).
- **The List row on a phone shows:** thumbnail; title on 2 lines; a meta line with the status chip, progress text and relative date; a slim progress bar. The creator is dropped.

### 3.8 Empty states

- **Empty library:** an explanation plus "Browse the catalogue" and "Import" (Yamtrack names the media type and links to a pre-filled search; Readest "Start your library"; BookWyrm import link).
- **Empty status tab:** one sentence per status with a next step. For example: In progress: "Nothing in progress. Pick something from Planned." with a link to Planned. Yamtrack home and Stump's dashed boxes do this.
- **Nothing matches:** "No items match these filters" plus Clear filters (BookOrbit `noFilterMatch`, Komga `EmptyStateFilterNoResults.vue`, Audiobookshelf). Never reuse the empty-library message for this; Koodo does, in `bookList/component.tsx:473-476`, and it reads as data loss.
- **The All overview hides empty sections.**

### 3.9 Loading and dates

- **Paging:** cursor pages of bounded size, with "Load more" or infinite scroll; the cursor goes in the URL so pages work without script. Virtualise once a view holds more than about 100 rendered items (Readest, BookOrbit, Suwayomi, Kavita; Seanime above 48).
- **Do not load a whole shelf in one request** as Kavita, Suwayomi and Seanime do; that cost grows with the library.
- **Dates:**
  - Relative within a week ("Today", "Yesterday", "3 days ago"), a short date after that.
  - The absolute timestamp goes in a `<time datetime>` with a tooltip (BookOrbit `BookTableDateCell.vue:56-70`, BookWyrm `naturalday`, Suwayomi `DateHelper.ts`, Stump continue cards).
  - Show the date that explains the tab or sort (Audiobookshelf and Komga sort-key lines), not every timestamp.

### 3.10 Patterns not to copy

- Layout enums with no UI behind them: Kavita `globalPageLayoutMode`, Komga next-ui `table`.
- Stretched covers: Kavita `image.component.ts:68-70` (`object-fit: fill`), BookLore portrait covers.
- Two-decimal percentages: Koodo "37.25%".
- Status derived only from progress (Koodo, Kavita, Komga, Stump): it cannot express paused or dropped.
- Sorting hidden on phones (Calibre-Web `hidden-xs`).
- A layout set only by the admin (Audiobookshelf `bookshelfView`).
- Hover-only actions on touch screens.

## 4. Reuse

Every project above was read to learn how it solves the shelf; the REZICS shelf is designed from those lessons and
implemented in this repository's own stack. Nothing is copied wholesale. Licences are listed per app in section 5 for
reference.

## 5. Per-app evidence

### Kavita (GPL-3.0; Angular 22; `kavita/UI/Web/src/app/`)

- **Layouts:**
  - `card-detail-layout` grid, `repeat(auto-fill, 10rem)` (`cards/card-detail-layout/card-detail-layout.component.ts:104`).
  - The model has `PageLayoutMode { Cards, List }` (`_models/page-layout-mode.ts`) and `globalPageLayoutMode`, but only its default is ever set (`user-settings/manga-user-preferences/manage-user-preferences.component.ts:71`).
  - Reading lists are rows (`reading-list/_components/reading-list-item/`).
  - Dashboard Swiper rows (`_models/dashboard/stream-type.enum.ts`).
- **Card** (`cards/entity-card/entity-card.component.html`):
  - 160×233 box, `object-fit: fill` by default (`shared/image/image.component.ts:68-70`).
  - 1-line title with a format icon and the kebab.
  - 5px progress bar only while 0 < pagesRead < pages (html:60-75).
  - Unread corner triangle (html:33-37); count badge.
  - Hover: dim, read button, checkbox.
- **Sort and filter:**
  - Sort: `SeriesSortField` (`_models/metadata/series-filter.ts:12-30`).
  - Filter: a rule builder (`metadata-filter/`), encoded by the server into the URL (`shared/_services/filter-utilities.service.ts:54-80`), and savable as a server "smart filter" that can become a dashboard row.
  - A–Z jump bar, used only with the name sort.
- **Selection** (`cards/bulk-selection.service.ts:87-117, 180-184`):
  - Hover checkbox; once active, clicks toggle.
  - Shift range; long press 300–1000ms (`entity-card.component.ts:315-347`).
  - Sticky top bar: mark read/unread, want to read, collection, reading list, delete, download.
- **Menu:** `_services/action-factory.service.ts:458+`. It becomes a modal at tablet width and below (`card-actionables.component.ts:141-155`).
- **Empty:** "No Data"; Want to Read: "No items match your current filter." (`assets/langs/en.json:218-219`).
- **Phone:** breakpoints at 768 and 1280 (`_services/breakpoint.service.ts:8-11`); the grid is unchanged, about 2 columns (inferred).

### Komga (MIT; `komga/next-ui/src/` is Vue 3 and current; `komga/komga-webui/src/` is Vue 2 and still the default)

- **next-ui is opt-in** through `nextUiAsDefault` (`komga/src/main/kotlin/.../IndexController.kt:16-35`).
- **Layouts:**
  - `PresentationMode = 'grid' | 'list' | 'table'` (`types/libraries.ts`); only grid and list are offered (`pages/libraries/[viewId]/series.vue:11-16`).
  - Slider 130–200px (`components/PosterSizeSlider.vue`), default 150 (`stores/app.ts:55`).
  - List: wide card with the summary clamped to 3 lines (`components/item/CardWide/ItemCardWide.vue`).
  - Overview rows, reorderable per library (`pages/libraries/[viewId]/overview.vue`).
- **Card** (`components/item/card/ItemCard.vue`):
  - Ratio 0.7071, cropped from the top.
  - 2-line title plus a subtitle that follows the sort (`components/series/card/SeriesCard.vue`, `components/book/card/BookCard.vue:130-175`).
  - Unread count or check badge; 10px bar for books in progress (`composables/book/useBookReadProgress.ts`).
- **Persistence:**
  - Layout per view key in localStorage `komga.nextui.app` (`stores/app.ts:24-36, 77-91`).
  - Grid forced on xs (`composables/presentationMode.ts`).
  - Filters and sort live only in the URL (`composables/useRouteQuerySchema.ts`, `composables/sort.ts`).
- **Filters:** three-state read status, plus genre, tag, publisher and other facets with any/all (`series.vue:47-207`).
- **Selection:**
  - Hover circle; long press opens a bottom sheet with Select (`components/series/menu/Sheet.vue`).
  - Select all, or add page (`composables/selection.ts`).
  - Top bar on pointer devices, bottom footer on touch (`components/layout/app/BarHolder.vue`, `components/selection/Footer.vue`).
  - Bulk actions are the intersection of the selected kinds (`functions/selection.ts`).
- **Empty:** "No results" / "Try to adjust the filters" with Clear filters (`components/EmptyStateFilterNoResults.vue`).
- **Phone:** 3 columns on xs (`components/item/Browser.vue:16`); sheets.
- **Classic UI:**
  - Grid only, 2 columns on xs (`functions/grid-utilities.ts`).
  - Per-library filter, mode and sort persisted and mirrored to the URL (`plugins/persisted-state.ts:24-44`).
  - A–Z bar (`components/AlphabeticalNavigation.vue`); multi-select bar (`components/bars/MultiSelectBar.vue`).
  - Empty filter: "The active filter has no matches" + "Reset filters".

### Stump (MIT for the web; `stump/packages/browser/src/`)

- **Layouts:**
  - Grid or table (`components/TableOrGridLayout.tsx`).
  - Six density presets mapped to columns per device class (`components/container/useGridSize.ts:10-72`), set with a slider (`GridSizeSlider.tsx`).
  - Table with a column picker (`components/table/EntityTableColumnConfiguration.tsx`; book columns in `components/book/table/columns.tsx:405-470`); no status or progress column.
  - Fanned series stacks (`components/series/StackedSeriesCard.tsx`).
- **Book card** (`components/book/BookCard.tsx`):
  - Cover ratio is a user preference: 1:1.6, 1:1.5 or 1:√2 (`scenes/settings/app/preferences/ThumbnailAppearancePreference.tsx`).
  - 2-line title.
  - "NN% · N pages left" or "Completed"; a bar under the cover.
- **Persistence:**
  - Layout, sort and columns per view in localStorage (`packages/client/src/stores/layout.ts:40-58`).
  - Density global (`stump:entity-card-density`).
  - Filters in the URL (`components/filters/useFilterScene.ts:156-240`).
- **Selection:** none in the web app.
- **Empty:** "No series match your search" / "Try removing some filters…" (`scenes/library/tabs/series/LibrarySeriesScene.tsx:234-248`).
- **Home rows:** continue reading with relative "updated X ago" (`scenes/home/ContinueReading.tsx`).
- **Phone:**
  - Web: default 2 columns.
  - The mobile app (`apps/expo`, GPL-3.0): list rows with "Page X / Y" (`components/listLayout/list/ListRowItem.tsx`), with layout per view saved in MMKV.

### Audiobookshelf (GPL-3.0; Nuxt 2; `audiobookshelf/client/`)

- **Layout:**
  - One grid drawn as shelf rows, `BookshelfView` STANDARD (wooden) or DETAIL (`plugins/constants.js` L22-26). It is set by the admin in server settings (`pages/config/index.vue` L114-127).
- **Size:**
  - −/+ pill over `[60…220]` (`components/widgets/CoverSizeWidget.vue`); everything scales in em.
  - Columns are computed from width (`components/app/LazyBookshelf.vue` L738).
  - Square or 1.6 covers are set per library (`LibrarySettings.vue` L165).
- **Card** (`components/cards/LazyBookCard.vue`):
  - Stretched when the cover is within 0.15 of the target ratio; otherwise contained over a blurred copy (L1083-1098).
  - Placeholder shows title and author.
  - DETAIL view adds title, author and the sort-key line ("Added …", "Finished …", L340-365).
  - Progress bar on the bottom edge, yellow in progress, green finished.
- **Grouping:** collapse series into one card with count and average progress.
- **Persistence:** user settings in localStorage, global (`store/user.js`); sort and filter mirrored to the URL (`LazyBookshelf.vue` L458-507).
- **Selection:**
  - Hover radio, then click toggles; shift range (L252-319); Esc clears.
  - The app bar becomes a selection bar (`components/app/Appbar.vue` L54-193).
- **Empty:**
  - `No results for filter "{0}: {1}"` + Clear Filter.
  - "{0} Library is empty!" with scan buttons for admins (`LazyBookshelf.vue` L13-34).
- **Home:** server-built shelves: Continue Listening/Reading, Continue Series, Read Again (`server/models/LibraryItem.js` L338-480).

### Jellyfin web (GPL-2.0+; React modern app at `jellyfin-web/src/apps/modern/features/libraries/`)

- **Layouts:**
  - `ViewMode` grid | list. Image types Primary, Banner, Disc, Logo, Thumb, plus a CardLayout flag (`components/ViewSettingsButton.tsx`, `ItemsView.tsx`).
  - Legacy view styles: List, Poster, PosterCard, Thumb, ThumbCard, Banner (`src/scripts/libraryBrowser.js` L5-41).
- **Columns:** CSS percentage widths by breakpoint (`src/components/cardbuilder/card.scss` L507-657); shape chosen from the cover aspect ratio (`cardBuilder.js` L80-104).
- **Card:**
  - Cropped background image; blurhash placeholder.
  - Progress shown only when partial (`src/components/indicators/indicators.js` L36-48).
  - Played check; unplayed count up to 99+.
  - Hover: play, played, favourite, ⋮.
- **Persistence:** the whole view-settings object in localStorage, keyed `` `${viewType} - ${parentId}` `` (`utils/settings.ts`, `hooks/useLibrary.tsx`).
- **Filters:** status (Played, Unplayed, Favorite, Continue), genres, years and others (`components/filter/`); vertical A–Z picker (`AlphabetPicker.tsx`).
- **Selection:**
  - 550ms long press (`src/components/multiSelect/multiSelect.js` L473, L520).
  - Top bar; ⋮ holds select all, collection, playlist, mark played/unplayed, delete.
- **Menu:** `src/components/itemContextMenu.js`.
- **Empty:** "Nothing here." (`components/common/NoItemsMessage.tsx`).
- **Phone:** 3 portrait columns below 500px; list rows hide media info below 800px (`listview.scss` L212-226).

### Suwayomi WebUI (MPL-2.0; React 19; `suwayomi-webui/src/features/library/`)

- **Layouts:**
  - `GridLayout` Compact, Comfortable, List (`src/base/Base.types.ts` L12-16).
  - Item-width slider 100–1000px, default 300, in Settings › Appearance (`features/settings/Settings.constants.ts` L37-42); columns = `ceil(width / itemWidth)` (`features/manga/components/MangaGrid.tsx` L43-58).
  - The library resembles Mihon's (not verified in code).
- **Card** (`features/manga/components/cards/MangaGridCard.tsx`):
  - Ratio 1:1.5, cropped.
  - 2-line title over the cover (Compact) or below it (Comfortable).
  - Unread and downloaded badges, optional.
  - Optional ▶ continue button (`ContinueReadingButton.tsx`).
  - ⋮ only with a fine pointer (`MangaOptionButton.tsx`).
- **Options:** Filter, Sort and Display tabs in one bottom drawer (`components/LibraryOptionsPanel.tsx`, `src/base/components/modals/OptionsPanel.tsx`).
  - Three-state filters.
  - Sort and filter per category in server metadata (`features/category/services/CategoryMetadata.ts`); display settings global in server metadata.
- **Category tabs:** with count chips, "shown/total" while filtering (`screens/Library.tsx` L114-120, L306-320).
- **Selection:**
  - The toolbar checkbox selects all.
  - Shift or long-press range (`src/base/collection/hooks/useSelectableCollection.ts`).
  - FAB with the bulk menu (`SelectionFAB.tsx`, `MangaActionMenuItems.tsx`).
- **Empty:** "Your library is empty", "The category is empty", "No manga matches this filter" (`src/base/components/feedback/EmptyView.tsx`).

### Koodo Reader (AGPL-3.0; React 19; `koodo-reader/src/containers/lists/bookList/component.tsx`)

- **Layouts:** `viewMode` card | list | cover (`src/constants/viewMode.tsx`).
- **Scale:** slider 0.6–2.0 stored as `cardScale` (component L469-470, L577-588).
- **Collections:** 2×2 mosaic tiles with a count (`components/collectionCover/component.tsx`).
- **Card:**
  - Crops unless "Don't crop book cover" is set.
  - 2-line title.
  - "New" / "NN.NN%" / "Done" (`components/bookCardItem/component.tsx:250-264`).
- **Persistence:** global, `readerConfig` in localStorage, synced.
- **Status filter:** All, Unread, Reading, Finished, derived from progress and not persisted.
- **Selection:** shift range that merges (`components/bookItem/useBookItem.ts:138-177`); bulk bar (`components/selectBook/component.tsx`); drag onto a shelf.
- **Menu:** includes Pin to top, which overrides any sort (`dialogs/actionDialog/component.tsx`).
- **Empty:** illustrations with no button; a filter with no results redirects to "Empty library" (L473-476).
- **Phone:** no phone layout.

### Readest (AGPL-3.0; Next.js 16 / Tauri; `readest/apps/readest-app/src/app/library/`)

- **Layouts:**
  - grid | list (`src/types/settings.ts:17`); per-shelf carousel (`src/services/bookshelves/definitions.ts:48-52`).
  - Auto columns 3/4/6/8/12, or a manual number (`components/BookshelfStream.tsx:68-79`, `components/ViewMenu.tsx:200-218`).
  - Cover crop or fit, skeuomorphic covers, hide covers.
- **Shelves:** rule-based and stacked on one page; the built-in "Recently read" carousel acts as the continue row (`definitions.ts:196-280`, `BookshelvesDialog.tsx`).
- **Group by:** none, group, series, author, tag, subject or status.
- **Item** (`components/BookItem.tsx`, `src/components/ReadingProgress.tsx`):
  - 28:41 cell.
  - "NN%"; FINISHED and ON HOLD chips; the UNREAD chip is turned off.
- **Persistence:**
  - Local settings mirrored to URL parameters; the URL wins (`ViewMenu.tsx:46, 92-162`).
  - Shelf definitions sync as CRDT rows (`services/bookshelves/persistence.ts`).
- **Selection:**
  - Select button (hidden on phones), 500ms long press (`components/BookshelfItem.tsx:409-427`).
  - Bottom bar with Status ▸ (`SelectModeActions.tsx`, `SetStatusAlert.tsx`).
- **Empty:** "Start your library" + Import (`LibraryEmptyState.tsx`); a "+" tile closes the grid.

### BookOrbit (AGPL-3.0-only plus additional terms; Vue 3.5; `bookorbit/client/src/`)

- **Layouts:**
  - grid | list | table (`packages/types/src/display-preferences.ts:10`).
  - Cover-size slider 100–280px and gap slider (`ViewHeaderDisplayControls.vue`); columns computed (`features/book/components/VirtualBookGrid.vue:107-121`).
  - Table columns in `tableColumnSchema.ts`, with column presets, saved views and row density.
  - Collapsed series cards with five cover modes (`CollapsedSeriesCard.vue`).
- **Card** (`BookCoverCard.vue`):
  - Blurred-fit by default (`BookCoverArtwork.vue:76-101`).
  - Overlays chosen by the user: progress bar, status, rating, format, series position.
  - Info on hover, below the cover, or off.
- **Rows and cells:** list row with a progress bar (`BookListRow.vue`); table date cell absolute with the relative time in a tooltip (`table/BookTableDateCell.vue:56-70`).
- **Persistence:**
  - `viewMode` global in localStorage; cover size per view (`bookorbit:coverSize:<type>:<id>:<ratio>`); optional server sync (`composables/useDisplaySettingsSync.ts`).
  - Table falls back to grid below md (`composables/useEffectiveViewMode.ts`).
- **Filters:**
  - Nested rule builder; transient by default, "Save filter" to localStorage, or a named Smart Scope on the server.
  - Multi-key sort saved per view (`useViewSort.ts`).
- **Selection:**
  - Shift range from an anchor (`useBookSelection.ts:31-52`); "Select all N matching" (`views/HomeView.vue` `querySelection`).
  - Bottom pill bar (`components/SelectionActionBar.vue`).
- **Statuses:** 8, each with an icon and colour (`composables/useBookStatus.ts`).
- **Empty:** "No books match your filters" + Clear filters (`locales/en.json` `noFilterMatch`).
- **Phone:** the Display controls open as a bottom sheet (`view-header/ViewHeaderMobileMenu.vue`); the first tap reveals the overlay (`BookCoverCard.vue:170-179`).

### BookLore (AGPL-3.0; Angular 21; maintenance mode; `booklore/booklore-ui/src/app/features/book/components/book-browser/`)

- **Layouts:** grid and table (`book-browser-query-params.service.ts:17-20`).
- **Size:** slider 0.5–1.5× (`cover-scale-preference.service.ts`); 2/3/4-column buttons on phones (`book-browser.component.ts:154-200`).
- **Card** (`book-card/`): up to three stacked progress bars; a clickable status icon that opens the status menu.
- **Preferences:** on the server, global plus overrides per library, shelf or magic shelf (`settings/user-management/user.service.ts:11-34`), overridden by the URL.
- **Statuses:** 9 (`features/book/model/book.model.ts:393-403`).

### Calibre-Web (GPL-3.0; Flask/Jinja; `calibre-web/cps/`)

- **Layouts:**
  - Grid with Bootstrap 2/4/6 columns (`themes/standard/templates/index.html:89-154`).
  - Editable table on its own page (`book_table.html`, `static/js/table.js`).
- **Per view on the server:** sort (`web.py:342-372`) and table column visibility (`table.js:589-607`) in `User.view_settings` (`ub.py:213-223, 258`).
- **Shelves:** manual order mode that disables sorting (`shelf.html:18`, `shelf_order.html`).
- **Status:** read status 0/1/2 (`ub.py:403-422`); only "finished" gets a badge.
- **Phone:** the sort toolbar is hidden (`index.html:69`).

### Calibre-Web-Automated (GPL-3.0; `calibre-web-automated/cps/`)

- **Magic shelves:** rule-based (`magic_shelf.py:157-262`), including "Currently Reading" and "Yet to Read".
- **Hover quick actions:** on wide screens with hover only (`static/js/caliBlur.js:819-1000`).
- **Table:** shift range and a toolbar (`templates/book_table.html:41-84`, `table.js:64-145`).
- **Phone:** sort row scrolls sideways (`static/css/layout-refresh.css:180-200`).
- **Status from sync:** progress past 0 sets reading, 99% or more sets finished (`progress_syncing/protocols/kosync.py:330-365`).

### BookWyrm (Anti-Capitalist v1.4; Django/Bulma; `bookwyrm/bookwyrm/templates/shelf/shelf.html`)

- **Status:** four exclusive status shelves plus custom shelves (`models/shelf.py:21-26`, `views/shelf/shelf_actions.py:57-80`).
- **Shelf page:**
  - Tabs for each shelf (`shelf.html:40-83`).
  - Table: Cover, Title, Author, Rating, Shelved, Started, Finished, actions (`shelf.html:152-216`).
  - Dates use `naturalday`.
  - Header sorting in the URL (`views/shelf/shelf.py:146-163`).
- **Shelve button:** split button with the next status (`templatetags/shelf_tags.py:35-45`); reading modals take dates, progress, comment and privacy.
- **Phone:** table rows become labelled cards (`static/css/bookwyrm/components/_book_preview_table.scss:9-46`).
- **Empty:** "This shelf is empty." / "We couldn't find any books that matched {query}" (`shelf.html:217-228`).

### Ryot (GPL-3.0; React Router 7, Mantine; `ryot/apps/frontend/app/`)

- **Layout:** grid only, `cols={{ base: 2, sm: 3, md: 5, … }}` (`components/common/layout.tsx:33-49`).
- **Card** (`components/common/entity-display.tsx:431-541`): owned and finished icons, rating, "Current: S1-E3", 1-line title, 4px bottom bar, 4 action buttons.
- **Status:** mirrored into system collections (`crates/utils/dependent/seen/src/lib.rs:152-187`).
- **Filters:** in the URL via nuqs, with saved presets on the server (`lib/hooks/filters/use-presets.ts`).
- **Bulk:** collection-only bulk mode with "select all items" (`components/common/bulk-collection-editing-affix.tsx`).
- **Progress input:** unit-aware (`components/routes/dashboard/forms/metadata-progress-update/in-progress-form.tsx`).

### Yamtrack (AGPL-3.0; Django, HTMX, Alpine; `yamtrack/src/templates/app/media_list.html`)

- **Layouts:** grid or table (`users/models.py:57-61`); table by default for anime and manga.
- **Persistence:** layout, sort and status saved on the server per media type, simply by using the controls (`users/models.py:146-303`, `app/views.py:168-180`).
- **Card** (`app/components/media_card.html`):
  - 2:3 crop.
  - Status chip with date; score; "12 / 24".
  - Status-coloured strip that doubles as the progress bar (`progress_bar.html`, `app/config.py:235-275`).
- **Table:** Score, Progress, Status, Start and End date (`media_list.html:162-180`).
- **Status changes and stepper:** automatic status transitions (`app/models.py:898-930`); inline ± stepper (`app/components/progress_changer.html`).
- **Empty:** "No {Books} Tracked Yet" + "Browse {Books}" (`media_list.html:140-158`).
- **Phone:** 2 columns; the table scrolls sideways.

### Seanime (GPL-3.0; React 19 SPA; `seanime/seanime-web/src/app/(main)/`)

- **Grid:** fixed column ladder (`_features/media/_components/media-card-grid.tsx:6-20`); grid or carousel per home section, saved on the server (`_features/home/home-settings-modal.tsx`).
- **My lists:** sections per status with counts; empty ones hidden (`lists/_containers/anilist-collection-lists.tsx`).
- **Card** (`media-entry-card.tsx`):
  - 6:8 crop.
  - Top bar only for CURRENT; "3/12" badge; unwatched or unread count; score pill.
  - Desktop hover popup with Continue or Watch.
- **Entry editor:** status, score, progress and dates; Completed fills progress (`_features/media/_containers/anilist-media-entry-modal.tsx`).
- **Large grids:** off-screen cards replaced with measured skeletons above 48 items (`media-card-grid.tsx:65-231`).

## Personal-score ordering contract

The [native personal-score contract](../library-personal-score-order.md) now owns the server ordering extension.
BookWyrm's owner-review rating annotation and server sort (`bookwyrm/views/shelf/shelf.py`, pinned reference)
provide the closest score journey; Bangumi's owner/subject collection read (`internal/collections/infra/mysql_repo.go`)
keeps the user's own rating distinct from public aggregates. The earlier REZICS
`legacy-final:apps/web/features/library/state.ts` already exposed rating with descending as its initial direction
and restarted cursors on sort changes. Retain these useful interactions through native whole-shelf keysets;
no reference or legacy implementation was copied. Availability and bounds belong to the linked native contract.
