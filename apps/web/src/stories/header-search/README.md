# Header Search

The reusable region lives in `search/header-search/`. AppShell mounts it once. The same native input stays in the
pill, expanded panel and phone sheet. Route query and facet data enter through the ordinary GET form. ScopeChip
and ShellSearch remain re-exports for existing callers.
The [search interface contract](../../search/README.md) owns desktop centring, the compact transition, coherent
surface paint and control focus. Filters remains on the left of the second row.

A scope label never grants authority. A caller must supply its existing localized scoped search route; without
one, scoped submission and suggestions stay unavailable. Removing the chip explicitly returns to global search.
Global suggestions never run with a scope. An optional scoped suggestion loader must enforce that scope itself.
No advanced search admission or Zone source is opened. `slots.ask` is empty and renders nothing.

Filters use `HeaderSearchFilterProvider` and `useRegisterHeaderSearchFilters`. SearchPage registers its real current
named Type/facet controls only when available. The header opens that control and transfers keyboard focus. Other
routes may register an existing control through this seam; absent controls leave Filters disabled.

The stories use a suggestion boundary adapted from the existing search recording. Errors reject; loading stays
pending until cancelled. FiltersOpen uses SearchPage and its ordinary fake route boundary. Every state is reached
through its play. No story represents native authority or visual approval.

Review every exact ID at **phone390 and desktop1280**, with **en and zh-Hans**, **light and dark** toolbar globals.
Root screenshot review is pending for every cell:

| State ID                              | phone390 | desktop1280 |
| ------------------------------------- | -------- | ----------- |
| patterns-header-search--rest          | pending  | pending     |
| patterns-header-search--scope-chip    | pending  | pending     |
| patterns-header-search--expanded      | pending  | pending     |
| patterns-header-search--typing        | pending  | pending     |
| patterns-header-search--scope-removed | pending  | pending     |
| patterns-header-search--filters-open  | pending  | pending     |
| patterns-header-search--suggestions   | pending  | pending     |
| patterns-header-search--no-results    | pending  | pending     |
| patterns-header-search--loading       | pending  | pending     |
| patterns-header-search--error         | pending  | pending     |
| patterns-header-search--sheet         | pending  | pending     |

Sheet and SheetKeyboardSubmission explicitly select the sheet presentation, with focus containment and Escape
return at either toolbar size. Other states choose presentation responsively. Expanded covers keyboard focus and
recent discovery; Suggestions covers active-descendant selection. Display-only URLs are retired; viewport and theme
variations use toolbar globals on the behavior story.
