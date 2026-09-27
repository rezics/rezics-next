# Component review

Start the worktree frontend with `task dev`; `task urls` prints Storybook's
address. Its `/mcp` endpoint lists components and stories. The manifest covers
components with adjacent stories in `packages/ui/src` and feature stories in
`apps/web/features`.

Run scoped story browser tests with `task storybook:test -- <story files>`.
Select relevant states, theme, locale and viewport from the changed surface;
inspect actual screenshots and fix issues within the task. The
[Storybook review skill](../../.agents/skills/storybook-ui-review/SKILL.md)
has the review procedure. Keep temporary screenshots in `.temp/`.
