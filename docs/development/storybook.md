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
