# Rezics UI

`@rezics/ui` is Rezics's shared React component library. Import components from `@rezics/ui/button`, shared hooks from `@rezics/ui/hooks/use-is-mobile`, and the theme stylesheet from `@rezics/ui/styles.css`.

Run `bun run storybook` in this directory to review components. Run `bun run check` to type-check the package and run its unit and accessible browser story tests.

The logo red (`--brand`) marks identity and never colors text; use ink blue (`--primary`) for colored text and actions. Use Manrope for interface text and Source Serif 4 for Work titles only. Fonts are self-hosted, and theme selection belongs on `<html>` without a script. Mark icons in red with `fill-*` or `stroke-*` utilities, never `text-brand`.
