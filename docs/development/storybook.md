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

Storybook browser interactions on the production component are acceptance
evidence for UI behavior: clicking, typing, selection, retry, remove, export,
reopening a draft, feedback and focus. Cover the intended outcome with actual
assertions and relevant viewport/locale states. Contract-shaped fixtures and
failure injection may establish these component states; retain recorded API
answers unchanged and label fixture evidence accurately.

Combine that UI evidence with the API outcomes for authority, durable writes,
readback and idempotency. Reuse matching successful API evidence rather than
repeating a full backend journey for every viewport or locale. A test helper
that fails before the intended interaction is a runner problem to resolve;
it does not invalidate a passing Storybook interaction. A failed product
outcome or an untested required state still needs its own resolution.
