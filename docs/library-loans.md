# Private copy loans

Loans record an owner's private lending or borrowing of one exact native copy. They grant no digital entitlement,
send no message and assert no other person's consent. Copy eligibility and authority remain native copy policy;
an Open Library entitlement, installation or DRM licence is not a local lending grant.

## Calendar and lifecycle

Decision: loan dates are complete Gregorian `YYYY-MM-DD` values; the server supplies one UTC calendar day per
response, and a due date is inclusive through that day.

Copy acquisition/disposal days and Loan dates use the public `isCalendarDate` rule from `@rezics/filter` for
Gregorian validity. Each caller keeps the exact ten-character `YYYY-MM-DD` shape and years 0001–9999 boundary;
the package's partial dates and astronomical years do not widen these inputs. Valid text is preserved without
trimming or reserialization, and trailing newlines are invalid. Copy dates remain nullable, Web empty fields become
null, and omitted native updates leave the stored day unchanged.

Decision: Web chooses those days through the locale Calendar grid, never a native date input, so stored Gregorian
days are not passed through browser timezone controls.

Years range from 0001 through 9999. Impossible calendar days, partial dates, instants and normalized overflow dates
are invalid. Stored dates are compared as dates and are never passed through browser timezone formatting. An absent
due date is undated. A date equal to the response boundary is due; an earlier date is overdue. Return takes precedence
over both. Each list response discloses one boundary and reuses it for every row.

The immutable loan identity carries account, exact copy, direction (`lent` or `borrowed`), counterparty, start day,
nullable due and return days, and revision. Create operands also capture the selected copy revision. A due date cannot
precede the start. Extension assigns an undated loan's first due date or strictly advances its existing due date; it
never clears or shortens one. Return records a day between the start and the server's current day, including early
return. It is terminal. Both extension and return require the expected revision. Revisions cannot advance past the
native signed integer maximum.

Counterparty is explicitly `{kind: "name", name}` or `{kind: "person", personId}`. Private names retain their exact
text, including surrounding spaces and Unicode composition. Names contain 1–300 Unicode scalar values, must contain
non-whitespace text and cannot contain control characters or unpaired surrogates. They are never matched to an
account. A person identity must be explicitly selected; parsing a routable ID does not admit or disclose that person.

Decision: Returned loan history stays private and is retained for the owner's lifetime, survives copy deletion or
disposal, and is removed by terminal owner erasure.

## Installed native journey

`services/kernel/db/library/migrations/20261104105358_copy_loans.sql` installs owner-scoped immutable loan rows, the
owner membership generation, a unique partial index enforcing one open loan per exact copy, and seek indexes for
open due-date order, returned history and owner erasure. The generated `services/kernel/db/library/schema.sql` is
derived from this migration. The copy ID is intentionally not a foreign key so returned history survives copy
deletion.

The mounted API in `services/kernel/src/library/personal-routes.ts` exposes:

- `GET /v1/copy-loans?filter=open|history&limit=...&cursor=...` (`copy:list`). Open loans default to 20 and are
  capped at 100 rows; returned history is capped at 50. Each query fetches at most one extra row to create its next
  cursor. Open rows order by due day ascending with undated last, then loan ID ascending. History orders by return
  day descending, then loan ID descending.
- `POST /v1/copy-loans` (`copy:create`) accepts `copyId`, `copyRevision`, `direction`, an explicit `counterparty`,
  `startedOn`, and optional `dueOn`. It returns `{loan, boundary}`.
- `PATCH /v1/copy-loans/:loanId` (`copy:update`) accepts `{revision, dueOn}` and extends a due date.
- `POST /v1/copy-loans/:loanId/return` (`copy:update`) accepts `{revision, returnedOn}` and returns the loan.

All writes require the standard `Idempotency-Key` header and shared native command runner. Current-viewer admission,
active owner, profile, exact copy identity, eligibility and rights are rechecked at native dispatch. Creation locks
that copy and relies on the unique open-loan index; extension and return lock the loan and compare its revision.
Replaying the original command key and input returns its original receipt result. A new repeated return conflicts.
Unsupported profiles return a typed unavailable problem. Copy disposal and deletion are refused while any loan
remains open; neither path invents a return. Contextual actions in reads are hints only; commands reauthorize
independently.

List cursors are sealed to owner, filter, ordering, a 15-minute lifetime and loan membership generation. Create,
extend and return advance that generation, making obsolete cursors return `stale_cursor`. The response includes one
Gregorian UTC day boundary and per-loan state (`overdue`, `due`, `undated` or `returned`), owner viewer,
response-derived extend/return actions and reasons. Exact private name text is returned as entered. An explicitly
selected person is admitted through existing identity mapping and Semantic person disclosure; if identity or
presentation becomes unavailable, the response uses `state: concealed` and contains no destination ID.

Safe copy presentation uses the existing batch copy-context helper, bounded to 100 raw rows and 65,536 serialized
context bytes. It reports `available`, `scope`, `withheld`, `missing`, `unsupported` or `unavailable` states without
withholding the private loan. Person presentation is capped at 100 IDs. Empty language preferences are omitted from
the Semantic facts request, which otherwise rejects an empty language array.

Decision: each copy context's `facts` is the closed union the generated client declares (`item`, `time`, `quantity`,
`code`), so a loan page serializes through the Web server function without casts. Loans read and refresh under the
`copy.list` gate, the personal-library operation Copies already uses; the exposure table has no loan-specific operation.

Decision: loan commands receive the transaction-bound History evidence through the request access seam, which binds the
prepared history accounts on the live command transaction. They do not import the evidence leaf themselves.

Returned history is private to the owner for the owner's lifetime and survives copy deletion or disposal. Terminal
owner erasure removes loan rows and the generation row through the existing owned-graph receiver, in batches of at
most 100 keys per work step. No separate cleanup scheduler or retention timer was added.

## Installed web journey

Decision: until whole-Kernel declaration emission publishes `copy-loans`, `@rezics/client` overlays the mounted
GET/POST/PATCH/return contracts and yields when that envelope exists. Web uses only those official types.

`/library/loans` lists open and returned history through the current-viewer reader, with first/more cursor moves,
extend and return on each eligible row, and a named-counterparty create form. The Copy editor offers the same create,
extend and return commands beside the copy form for the inspected holding, so loan fields cannot block copy Save, and
links to the loans page. Copy and loan day fields keep a locale Calendar grid that does not import `react-day-picker`
or `date-fns`. Host-b ready evidence: Worker discovery printed `(ssr) [optimizer] scanning dependencies...`
and then nothing for 150s; later `noDiscovery` plus an explicit include still printed no Vite
line inside the isolated network, with diagnostics showing only the storybook-dev command and no
CJS/`module` exception. The composition that reaches ready is Web's host-local `optimizeDeps`
cache: `vite optimize --force` plus a Node middleware-mode SSR warm keyed by `bun.lock`,
`patches/` and the pinned include/entries, then restamped onto the serve plugin list so an
isolated start reuses it. Worker `noDiscovery` keeps an explicit include of React, TanStack's
server store and `@inlang/paraglide-js/urlpattern-polyfill`. Copies still aliases
`urlpattern-polyfill` to ESM `index.js`, serves those files through filtered Worker resolve/load
hooks, and shims remaining CJS, because Workerd's export-type inspection uses
workerd/worker/module/browser conditions, not `import`. Adding `import` hung Rolldown before
ready. The nested package and `react-dom/server` stay off include and off exclude; calendar
packages stay on exclude. Serve reuses current Paraglide output through `messagesCurrent`, skips
generate under `REZICS_TEST_RUNTIME` unless a test supplies `REZICS_PARAGLIDE_COMPILER_MODULE`,
and takes a `.temp` lock when it does generate. A focused private-network check warms that cache
on the host, then starts one shared Vite for `/en` before the suite. Copies reuses it through
per-file Worker overlays; signed-in-routes copies that cache into a private config and compiles
after the shared server. Test Vite startup disables Miniflare's `Request.cf` metadata fetch and
uses its deterministic fallback, so the private-network server does not depend on network geo
metadata. The first pre hook aligns the cache before Cloudflare's eager Worker optimizer init and
restamps immediately before init. Vite config identity stays Node-loadable: `prepareViteDepCache`
and Bun process custody live in `vite-dep-cache-build.ts`, not in the module `vite.config.ts`
imports. `REZICS_WEB_SERIAL_VITE` and `--max-concurrency=1` keep exclusive Worker graphs off one
6 GiB slot. Isolation tests that need overlapping helpers leave that variable unset.
`WEB_TEST_STATE_DIR` remains the focused run root; Worker persistence still allocates its own
instance directory unless a caller passes `WEB_TEST_STATE_INSTANCE_DIR`. Return uses the mounted
`POST /v1/copy-loans/:loanId/return` path, not an AIP-136 `:return` method. signed-in-routes uses
the same `startDevServer` ready and `/en` first-response path as Copies.

Acceptance pins the mounted return path and the locale Calendar source, and keeps the existing Copies
page/browser cases. No extra page stories. Keep the original Copies, loan, label, signed-in-route and
five custody suites; do not add page stories. Public contribution on LabelShelf is live id/kind/displayName,
id-free Deleted account/organization, or null unknown; loan counterparties stay loan-owned.

Cross-capability receiving keeps the existing exposure parity assertion narrow: run only its operation-to-group
case from `closed-controls.test.ts`, together with Home Continue admission and viewer-exposure lifetime, before the
Copies journey. The remaining closed-controls browser cases stay out of this selection. The Worker denied-file
loader resolves `/src/...` and realpath aliases before its browser guard; the served-startup case must still load the
Worker while browser reads of those files remain denied. Web exposure maps mounted `definitions.import` onto `definition_publication`, and the generated client supplies
`definitions.imports.post`. Parity keeps that operation-to-group case.
Worker SSR resolves TanStack Store's `use-sync-external-store/shim/with-selector` import to the local ESM adapter;
the package entry is CommonJS and reaches Workerd with a runtime `require` call. The browser keeps the package
implementation. Focused checks regenerate Paraglide when the generated message index refers to a module missing
from disk, even if the top-level output timestamp is fresh.

The native focused case does not yet cover concurrent create/disposal, foreign accounts and owner retirement,
concealed-person threats, lost-acknowledgement refresh, stale-cursor recovery or independent 64/512/4096 cost cases
for every pool. Complete measured costs for admission/currentness, SQL, locks, dispatch, receipts, hydration,
serialization, retention and cleanup remain unverified.

## Verification

Product-first landing decision: finish the production outcome and changed workspace typechecks, then land with the exact one-shot journey results recorded; non-money test failures may accompany landing, and landing alone is not end-to-end acceptance.

`bun run --cwd services/kernel check test/library/loan-http.test.ts` executed the mounted native journey: 1 test
passed with 29 assertions. It covers exact create receipt replay, conflicting open create, due-day inclusivity,
next-day overdue state, extension and stale revision, refusal to dispose or delete an open-loan copy, return replay,
repeated-return conflict, and returned history after copy deletion. The command wrapper exited 1 after the test phase
because artifact return failed with:
`error: remote-check: returned empty directory differs from its manifest: services/kernel/.temp/schema-diagnostics/schema-3aQitT`.

`bun run --cwd services/kernel typecheck` exited 2. Its first diagnostic is the unchanged missing client module
`../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.`
The output also reports unchanged Community, Content and Search errors; it reported no diagnostics in the loan source or
loan HTTP test. The focused landing command
`bun run --cwd services/kernel check test/library/loan-date.test.ts test/library/loan-model.test.ts` previously
executed both pure-model suites: 9 tests passed with 139 assertions, but its wrapper also hit the artifact-return
failure above. Frozen acceptance, full native privacy/concurrency and growth cases, generated web delivery, and
browser review were not run.
