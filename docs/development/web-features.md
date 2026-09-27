# Web feature organization

Framework routes/adapters stay thin. Feature owners contain task flows, typed
API/query adapters, locale resources and component stories. Infrastructure owns
transport, sessions, routing primitives and shared runtime concerns. Reusable UI
comes from [Rezics UI](design-system.md) in `packages/ui`, a project-maintained
fork of SharkUI styled with the Rezics Aura theme. Change or extend its components
in place; do not add another UI library.

Use generated service contracts at external boundaries and runtime validation
where data crosses trust boundaries. Client selectors reflect authority but never
replace server enforcement. Exact content/context selection is shared between
SSR and browser navigation. Cache/query keys include relevant selection and scope.

## Adding a feature

Parallel feature slices touch no shared file beyond one registration line each;
the registries merge with git's union driver. The home, search, Work and Studio
features are worked examples.

- `features/<name>/messages.ts` holds the feature's strings for every locale
  (`defineMessages` in `i18n/define.ts`), registered by one line in
  `i18n/catalogs.ts`. Routes pass `getMessages()` output to components, which
  materialize recipes with the request locale; server code that only needs text,
  such as metadata, uses `getTranslation()`.
- A navigation entry is one line in `features/shell/navigation.ts`; an entry
  marked `planned` shows a coming-soon page until its route exists.
- Routes render inside the shell's `<main>` with `PageContainer`, and cover
  loading, empty, error and not-found states with the shell's `EmptyState`
  and route boundaries.

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
