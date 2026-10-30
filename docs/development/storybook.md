# Storybook catalogue

## Catalogue and ownership

Storybook has three tiers: **Pages** in `apps/web` show route level states in the full site shell; **Patterns** in
`apps/web` show connected compositions from the same recorded or fake data without the shell; **Components** in
`packages/ui` show shared UI. A state confined to one region belongs to a pattern. Page stories cover populated states
when the page frame differs by viewer, plus empty, unavailable and error outcomes.

Use `<Tier>/<Area>/<Name>` titles with user facing nouns. Pages and Patterns use the areas Library, Subjects, Discovery,
Community, Commerce and Account, in that order. Name stories for persona and outcome (`Signed out`, `Owner, empty`,
`Filter sheet open`), not viewport, theme or locale. Keep about six visible states per title. Regression only stories
carry the `!dev` tag. Cross cutting exposure views use the `exposure` tag in the page they cover.

Locale and theme are Storybook globals. Use the viewport toolbar for responsive review; a phone only state can set
`globals.viewport` at story level. Browser coverage runs at desktop and phone widths. Do not use the removed
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
