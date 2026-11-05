goal: semantic
manager: semantic
kind: interface

# Continue the Character appearance and voice visit

## Delivered in this attempt

Moved `PublicDocumentView`, `publicDocument` and `PublicDocumentViewSchema` into the supported Content entry
`services/kernel/src/content/document-public.ts`. Semantic's native Character document preview and Subject route now import
that entry directly. `document-routes.ts` retains the existing compatibility exports and all GET/DELETE route behavior.
The Content module registration preserves its existing Realm Board entry, Community projection exclusion and dependency,
the separate pure Community projection module, and Web's checkout reader-origin entry.

## Remaining outcome

Complete the seeded public Kurisu journey from actual local Bangumi data. Before designing the association lookup, trace
Character `01a1a7f2-b438-779d-be96-aa19ca250569` through its source holders, candidates, Context adoption, outbox and
projection. The read-only local `rezics-kernel-dev` database was inspected: it has 136 `semantic.fact` rows and 382
`core.outbox` rows, but no subject or facts for this Character, no `schema:character`/`wdt:P725` holder facts mentioning
it, and no matching outbox subject or payload. Its installed schema has no candidate/adoption or inbound-projection
tables, so those stages cannot be traced in this local database. This source-admission gap was returned to Imports via
the goal inbox. Do not infer admission from authored fixtures or fabricate relations; continue the receiver against its
documented native contract when Imports supplies the graph.

Add the narrow native released `wdt:P725` lookup by its admitted `wdt:P453` slot key. Reuse current native projection,
selection, Context suppression, source-fence, disclosure, labels, inspection, evidence, Sources and work-context
readers. Keep ordinary inverse filtering and Connections' window/query/Previous/return files unchanged; only update the
qualified admission bridge in `apps/web/src/features/pages/subject-connections.ts`. Extend the Subject/page wire shape
and typed client additively. Derive and declare the complete row, call and UTF-8 bounds, including each layer's indexed
keys, two streams of at most 20 assertions, the lower reader page and lookahead, qualifier/reference/body caps, selected
holder hydration, source eligibility, disclosure, labels, documents and freshness. Stale projection must be partial or
unavailable, never a definitive empty result.

Mount the local public association reader and preserve Realm/Context, locale, caller/session, release and reader
generation. Retire replaced previews synchronously, reject late and ABA results, hide whole spoiler-bearing associations
without leaking IDs/labels, and derive viewer actions only from current native authority. Keep correction drafts and
uncertain commands with their current owners.

## Required evidence

- The named screenshot directory `/home/edge/projects/rezics/rezics-next/.temp/screenshots/core` was absent during this
  attempt. Browser review is deferred to the controller. Inspect legacy `apps/web/features/` and its named Character
  credit feature before UI design; no legacy code was ported in this attempt.
- `bun run --cwd services/kernel typecheck` ran after the committed extraction but failed on existing diagnostics in
  untouched importer/kernel files (including duplicate `ImportTransportError` declarations and route-handler typing).
  The captured output was truncated, so the controller must establish the final workspace typecheck after integration.
- Preserve the existing authored-Character document preview tests. Add native tests using the adopted Bangumi graph, and
  add `services/kernel/test/semantic/m1-character-public-reading-growth.test.ts` at 64/512/4096 surrounding works,
  history and same-Character degree with the selected page fixed. Charge examined rows, SQL statements and UTF-8 bytes
  through qualifier lookup and hydration; a SQL `LIMIT` alone is not evidence.
- Extend `apps/web/tests/m1-character-public-reading.test.tsx` for signed-out, ordinary signed-in, suspended/denied,
  withheld targets, spoiler threshold, stale/current projection, exact Context suppression, unavailable and
  unavailable/mismatched document bodies. Add only the named stories: disclosed profile/appearance/voice, spoiler
  concealment, partial freshness, missing body, withheld target, expired reading and successful current retry.
- Review the actual Kurisu page at 390/1440 in light/dark, signed-out/signed-in, `zh-Hant` and `ja`, including keyboard
  focus and inspection return when the controller permits browser verification.
- Run the controller-owned acceptance after integration. It independently owns installed Character receiving,
  native Document disclosure/erasure/growth, actual seed admission, browser captures and cold-loading checks.

## Contract-named sources read

- `docs/subject-pages.md` Character-origin visits, Character document previews, and Character work-cast cost sections.
- `services/kernel/src/semantic/links.ts`, `services/kernel/src/semantic/list-presentation-work-context.ts`,
  `services/kernel/src/semantic/list-presentation-relations.sql`, and the existing directed-credit native tests.
- `.reference/INDEX.md` and `legacy-final:apps/web/features/work-page/credits.tsx`.

## Changed in this attempt

- `services/kernel/src/content/document-public.ts`
- `services/kernel/src/content/document-routes.ts`
- `services/kernel/src/semantic/character-public-reading-documents.ts`
- `services/kernel/src/semantic/http/subjects.ts`
- `docs/architecture/modules.json`
- `services/kernel/src/content/README.md`
- `docs/subject-pages.md`
