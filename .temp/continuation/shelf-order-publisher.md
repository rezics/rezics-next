# Personal shelf shared client publisher follow-up

goal: commerce
manager: commerce

The Web receiving flow now uses the existing generated client for native priority and title ordering and for explicit title preparation. The shared client publisher must publish these operands before the receiver can type-check:

- `GET /v1/libraryEntries`: `query.orderBy` includes native `priority` and `title`; `query.direction` accepts `asc` and `desc`.
- `POST /v1/libraryShelfTitlePreparation`: a generated `.post(undefined, options)` call with `idempotency-key` and `Accept-Language` headers and the typed `{ installation: 'pending' | 'installed', prepared: number }` response.

Regenerate through Content's existing shared client publisher. Do not handwrite or cast the client. Then rerun `bun run --cwd apps/web typecheck` and the four focused priority, title, preparation, and score suites. The current-viewer mounted fixture was marked `UNRUN` at base; this attempt reaches its inherited `Pinned A` assertion and stops there, so reconcile it through controller integration. Native, browser, and root acceptance remains with integration.
