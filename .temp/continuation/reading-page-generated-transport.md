---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'claim',
  'paths': ['packages/client/src/kernel/**', 'contracts/openapi.json'],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'waiting': [],
  'after': ['f6639bfc-bae7-4c61-9133-9841067982c7'],
  'estimate': { 'lines': 500, 'files': 6 },
  'inseparable': true,
}
---

# Finish generated delivery for the current reading journey

The installed reading-page route and bounded selected-card batch are committed at `688002f326`. Complete generated transport for that implementation using the existing Kernel generator and the mounted `thread.reading_page` operation, then deliver the generated DTOs, exact producer signatures and current head to Web's existing thread-reading receiver. Do not add a second generator or edit Web-owned files.

The OpenAPI source already contains `/v1/threads/{id}/reading-page`. The direct `openapi` and `client` commands fail because no `DATABASE_URL` is configured. Kernel's admitted `typecheck --emit-client` route reaches the compiler but currently fails in unchanged `services/kernel/src/community/member-page-select.sql` because `:route`, `:realm_id` and `:at` each appear more than once. The focused landing check currently stops before assertions on a shared schema dump mismatch for `db/community/schema.sql`. Do not bypass these compiler, migration or schema guards; resume generation and delivery when their owning environment or source defects are resolved.

## Acceptance

- Generate the actual mounted Kernel operation and update `packages/client/src/kernel/**` if its declarations are stale.
- Type-check the changed workspace and run the focused reading-page landing test.
- Report the installed exports, generated DTO state, committed head and actual reached native outcomes separately to Web's receiver and shared producer consumers.
- Keep broader native, growth and rendered acceptance under the controller's existing deferral.
