# Rezics UI

`@rezics/ui` is Rezics's shared React component library. Import components from `@rezics/ui/button`, shared hooks from `@rezics/ui/hooks/use-is-mobile`, and the theme stylesheet from `@rezics/ui/styles.css`.

Run `bun run storybook` in this directory to review components. Run `bun run check` to type-check the package and run its unit and accessible browser story tests.

Tests run in a private network namespace that holds only loopback, so changes to the host's network interfaces cannot interrupt browser requests. Run one test file with `bun run test <file>` to use the same isolation. Run `bun run test:stories:slow-frames` after changing a story or an editor or overlay component: it delays every animation frame by 400 ms, which reproduces the failures a loaded host causes.

The logo red (`--brand`) marks identity and never colors text; use ink blue (`--primary`) for colored text and actions. Use Manrope for interface text and Source Serif 4 for Work titles only. Fonts are self-hosted, and theme selection belongs on `<html>` without a script. Mark icons in red with `fill-*` or `stroke-*` utilities, never `text-brand`.
