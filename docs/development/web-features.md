# Web feature organization

Framework routes/adapters stay thin. Feature owners contain task flows, typed
API/query adapters, locale resources and component stories. Infrastructure owns
transport, sessions, routing primitives and shared runtime concerns. Reusable UI
uses the repository's shared UI/SharkUI boundary; do not add another UI library
or modify an upstream mirror for product components.

Use generated service contracts at external boundaries and runtime validation
where data crosses trust boundaries. Client selectors reflect authority but never
replace server enforcement. Exact content/context selection is shared between
SSR and browser navigation. Cache/query keys include relevant selection and scope.

Group implementation by user capability rather than one screen per table. Keep
advanced state through ordinary edits, and preserve pending/conflict/partial/
unavailable outcomes. Feature-level deterministic tests and stories exercise
loading, empty, denied, stale, error and populated states before integration.
