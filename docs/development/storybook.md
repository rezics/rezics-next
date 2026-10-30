# Storybook catalogue

## Catalogue and ownership

Storybook has three tiers: **Pages** in `apps/web` show route level states in the full site shell; **Patterns** in
`apps/web` show connected compositions from the same recorded or fake data without the shell; **Components** in
`packages/ui` show shared UI. A state confined to one region belongs to a pattern. Page stories cover populated states
when the page frame differs by viewer, plus empty, unavailable and error outcomes.

Keep one complete folder per page, component or pattern, with user facing nouns. Product areas retain Library,
Subjects, Discovery, Community, Commerce and Account in that order, followed by integrated areas including Catalogue,
Zones and Imports. Preserve supplied canonical folders and IDs, including shared folders such as
`Patterns/Collection Editor`; a shared pattern does not require an extra product-area level. Name stories for persona
and outcome (`Signed out`, `Owner, empty`, `Filter sheet open`), not viewport, theme or locale. Keep the hierarchy
compact and include every required behavior state, even when a folder needs more than eight. Regression only stories
carry the `!dev` tag; do not use it to hide required states. Cross cutting exposure views use the `exposure` tag in
the page they cover.

Locale and theme are Storybook globals. Review the same canonical IDs at `phone390` and `desktop1280` using the
viewport toolbar, with locale and theme globals; do not create width, locale or theme behavior variants. A phone only
state can set `globals.viewport` at story level. Browser coverage runs at desktop and phone widths. Do not use the removed
`parameters.viewport.defaultViewport` setting.

The title and story name rules follow [Storybook naming](https://storybook.js.org/docs/writing-stories/naming-components-and-hierarchy),
[tags](https://storybook.js.org/docs/writing-stories/tags), [globals](https://storybook.js.org/docs/essentials/toolbars-and-globals),
and [refs](https://storybook.js.org/docs/api/main-config/main-config-refs).

The critical Personal Library navigation regression renders the actual tabs component in a focused DOM test. It checks
that the caller and all eight generated locale messages load without starting Storybook or a native service. Run it
from the repository root with:

```sh
bun test apps/web/tests/library-page-smoke.test.ts
```

The Web landing integration check selects this command for changes under `apps/web`, `packages/ui`, and
`packages/document`.
