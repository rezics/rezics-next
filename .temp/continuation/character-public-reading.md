goal: semantic
manager: semantic
kind: interface

# Continue the Character appearance and voice visit

## Delivered in this attempt

Moved `PublicDocumentView`, `publicDocument` and `PublicDocumentViewSchema` into the supported Content entry
`services/kernel/src/content/document-public.ts`. Semantic's native Character document preview and Subject route now import
that entry directly. `document-routes.ts` retains the compatibility exports and all GET/DELETE route behavior. The
Content module registration preserves `realm-board-home.ts`, the Community projection exclusion and core dependency,
the separate Community projection entry, and Web's checkout reader-origin entry.

Added the released Character voice-credit lookup through the current inbound projection. The public links route admits
only `wdt:P725` filtered to the Character with `qualifier=wdt:P453`, when the active release declares the exact credit
slot-key/qualifier pairing and the qualifier targets `wd:Q95074`. Current assertion hydration verifies the exact qualifier
and preserves `wdt:P725`'s performer as the main value. Ordinary inverse filters are unchanged. The selected endpoint page
is capped at 20 assertions, the Character visitor requests 12, and the native ordered scan caps at 20 keys across Global
and selected Context. A capped scan reports `partial` and resumes after the last examined key when it has not already
found a full current page. The existing Character visit uses that query, and its partial-freshness story state is present.

The local `rezics-kernel-dev` graph was inspected read-only. It has 136 `semantic.fact` rows and 382 `core.outbox` rows,
but no `semantic.subject`, facts, `schema:character`/`wdt:P725` holder facts, or matching outbox subject/payload for
Character `01a1a7f2-b438-779d-be96-aa19ca250569`. Its schema has no candidate/adoption or inbound-projection tables to
trace. This exact source-admission gap was returned to Imports via the goal inbox. Do not fabricate the imported graph.

## Remaining outcome

The original public Kurisu journey is not complete until Imports supplies actual adopted Bangumi assertions. Then prove
the native Subject/page result contains the released STEINS;GATE appearances, qualified P725/P453 voice credits, exact
assertions, admitted document previews, authorized target summaries, and current sources. Authored native fixtures do
not establish this imported admission.

Move the public association presentation into the requested
`apps/web/src/features/catalogue/character-public-reading/**` component and mount it from the Character profile. Preserve
the existing Connections window, query, Previous/return and inspection owners; only the qualified admission bridge in
`subject-connections.ts` may change there. Keep whole-association spoiler gating, exact current Context/Realm, locale,
caller/session and release identity, synchronous retirement, and rejection of late and ABA reads. Viewer actions must
come only from current native authority; do not copy Search or build a parallel graph. Add the requested mounted cases:
signed-out and ordinary signed-in, suspended/denied, withheld targets, spoiler threshold, stale/current projection,
Context suppression, unavailable/mismatched documents, expired reading and current retry. Add the remaining named
stories for disclosed profile/appearance/voice, spoiler concealment, missing body, withheld target, expired reading and
successful retry.

Finish the actual selected-work inspection and use its current release descriptor, exact assertion/source attribution,
released role and credited-as qualifier, language and spoiler fields only when supplied. Derive all display targets from
current disclosed summaries; a withheld or stale target must never leave an ID or label behind. Extend the native and
mounted tests for adopted Bangumi assertions and exact Context suppression. Preserve the document HTTP disclosure,
erasure and growth suites, including their independent receiving obligations.

## Required evidence and bounds

- The named screenshot directory `/home/edge/projects/rezics/rezics-next/.temp/screenshots/core` was absent. Browser
  review is deferred to the controller. Contract-named source reads included `.reference/INDEX.md`, the current native
  relation and work-context readers, existing directed-credit tests, and `legacy-final:apps/web/features/work-page/credits.tsx`;
  no legacy code was ported.
- `docs/subject-pages.md` records the additive response and read limits: the separate appearance and voice windows each
  return 12 assertions in Character-specific use, 20 examined projection keys for the qualified voice lookup, at most 256
  related Subject summaries, 16 qualifiers, 16 references and 16 parts per reference, a 1 MiB measured stream body, and
  the direct preview's 15-document/262,144-byte-per-source/1 MiB-map limits; page composition keeps its 2 MiB native
  document limit. The native scan is one indexed SQL statement
  with at most 40 layer seeks plus two lookahead seeks; selected current assertion hydration and source eligibility
  remain batched through their current owners. Freshness may remain eventual after the existing 10-second deadline.
- `services/kernel/test/semantic/m1-character-public-reading-growth.test.ts` measures the 64/512/4096 stale
  same-Character projection and unrelated-history case through the actual native lookup, charging database statements,
  examined rows, blocks and response bytes. It complements the controller-owned installed receiving and actual imported
  graph tests; it does not prove those outcomes.
- `bun run --cwd packages/client typecheck` passed. Kernel typecheck completed with 440 repository diagnostics; after
  fixing the changed-file cursor/property diagnostics, a final path-filtered pass reported no diagnostics in the
  changed Semantic reader, HTTP subject route, Content document boundary, or changed native tests. The workspace still
  fails on unrelated base diagnostics, including the duplicate `ImportTransportError` in
  `services/importer/src/cross-media-seed.ts`, Content route type errors, and unrelated Semantic/other test errors.
- Web typecheck completed after retry but the root workspace still reports 656 diagnostics. None name the changed
  Character visit, Subject connection bridge, or public document entry; existing checkout/community/editor errors and
  absent SQL modules imported by untouched Kernel files remain. Both workspace checks are non-green at repository
  scope.
- Kernel focused tests were attempted after the final reader change. The check stops before tests on the base schema
  dump mismatch (`identity_receiving_capture_pending` expected, `identity_rating_repair_journal` actual); it also
  reports ref cleanup SIGTERM. The schema is unchanged by this attempt. Web focused tests remain held by the existing
  check-custody descriptor: reconciliation twice returned code 75 with custody `occupied` and result `unknown`, so no
  duplicate test invocation was started. The native receiving, imported-graph, mounted, browser, document HTTP and
  root acceptance checks remain deferred to controller verification.

## Contract-named sources read

- `docs/subject-pages.md`: Character-origin visits, Character document previews, Character cost, and the broader current
  Subject relation-page contracts.
- `services/kernel/src/semantic/links.ts`, `list-presentation-work-context.ts`,
  `list-presentation-relations.sql`, and the directed-credit native tests.
- `legacy-final:apps/web/features/work-page/credits.tsx` and `.reference/INDEX.md`.

## Changed in this attempt

- `services/kernel/src/content/document-public.ts`
- `services/kernel/src/content/document-routes.ts`
- `services/kernel/src/semantic/character-public-reading-documents.ts`
- `services/kernel/src/semantic/http/subjects.ts`
- `services/kernel/src/semantic/links.ts`
- `services/kernel/src/semantic/list-inbound-links-by-property.sql`
- `services/kernel/test/semantic/directed-cast-person-credits.test.ts`
- `services/kernel/test/semantic/m1-character-public-reading-growth.test.ts`
- `apps/web/src/features/catalogue/character-work-visit/intent.ts`
- `apps/web/src/features/catalogue/character-work-visit/model.ts`
- `apps/web/src/features/catalogue/character-work-visit/view.tsx`
- `apps/web/src/features/pages/subject-connections.ts`
- `apps/web/tests/character-work-visit.test.tsx`
- `apps/web/tests/m1-character-public-reading.test.tsx`
- `apps/web/src/stories/character-work-visit.stories.tsx`
- `packages/client/src/index.ts`
- `docs/architecture/modules.json`
- `services/kernel/src/content/README.md`
- `services/kernel/src/semantic/README.md`
- `services/kernel/src/semantic/current-relations.ts`
- `services/kernel/src/semantic/link-changes.ts`
- `docs/subject-pages.md`
- `services/kernel/test/semantic/links-projection.test.ts`
- `services/kernel/test/semantic/growth-reads.test.ts`
