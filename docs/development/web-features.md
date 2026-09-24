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

## Data fetching

Eden is the typed transport; TanStack Query is only the client-side cache.

- **Server reads.** Server Components call Main through the Eden client with the
  request's server-side session token. They do not use TanStack Query.
- **Writes.** Server Actions call Main commands, then `revalidatePath` or
  `revalidateTag`. Show pending, stale and partial outcomes from the returned
  receipt.
- **Client reads.** `"use client"` components use TanStack Query only for
  interactive data: search-as-you-type, infinite lists, polling pending receipts
  or partial states, and optimistic ratings or votes.
- **Query factories.** Each feature exports `queryOptions` factories wrapping Eden
  calls that throw on `error`. Keys include context, Realm, locale and exact
  selection.
- **BFF proxy.** Browser calls go through the Workers BFF proxy at `/api/main/*`,
  which keeps Main's paths and attaches the bearer token from the server session.
  One Eden type therefore serves server and browser, and the browser never holds
  the Main token.

## Capability grouping

Group implementation by user capability rather than one screen per table. Keep
advanced state through ordinary edits, and preserve pending/conflict/partial/
unavailable outcomes. Feature-level deterministic tests and stories exercise
loading, empty, denied, stale, error and populated states before integration.
