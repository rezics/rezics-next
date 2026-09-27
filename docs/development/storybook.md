# Component review and frontend acceptance

Changed visible components require scoped Storybook browser tests and actual
screenshot review at verification. Stories cover ordinary, advanced, empty,
loading, denied, stale, partial and error states with typed fixtures. Review
layout, typography, contrast, focus/keyboard, long/multilingual text and material
context/authority information; repair issues within the changed scope.

Use the owning workspace's documented Storybook tooling and shared components.
Affected deterministic/TypeScript checks qualify contract integrity separately
from rendered checks. Temporary screenshots remain task-owned artifacts unless
retention is requested. Never present source inspection as rendered verification.

Full-application browser, screenshot, responsive or interaction QA requires the
user's explicit request for that task. Component review does not activate a
whole application server or establish human usability/performance acceptance.

## Agent access through MCP

Storybook 11's `@storybook/addon-mcp` serves an MCP endpoint at
`http://127.0.0.1:6006/mcp` while `yarn storybook` runs, with the components
manifest enabled. Its tools list and show component documentation
(`docs-list`, `docs-show`, `docs-show-story`), give story-writing instructions,
find stories by component file or change, return preview URLs and run story tests
with accessibility checks (`test-run`). Agents building UI connect to it, for
Claude Code with `claude mcp add --transport http storybook http://127.0.0.1:6006/mcp`,
and check a component's documented props before using it.

The manifest only covers components that have stories. Write stories for
[Rezics UI](design-system.md) components next to them in `packages/ui/src`, which
Storybook also loads, so agents can discover the shared library.
