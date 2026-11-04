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

Returned history is private to the owner for the owner's lifetime and survives copy deletion or disposal. Terminal
owner erasure removes loan rows and the generation row through the existing owned-graph receiver, in batches of at
most 100 keys per work step. No separate cleanup scheduler or retention timer was added.

## Still to deliver

The native HTTP slice is installed, but the `/library/loans` page, contextual copy action, overflow navigation,
generated web client delivery, locale strings, stories and rendered page cases are not. The native focused case does
not yet cover concurrent create/disposal, foreign accounts and owner retirement, concealed-person threats,
lost-acknowledgement refresh, stale-cursor recovery or independent 64/512/4096 cost cases for every pool. The
native code uses bounded SQL and disclosure helpers, but complete measured costs for admission/currentness, SQL,
locks, dispatch, receipts, hydration, serialization, retention and cleanup remain unverified. These requirements
are the continuation; no browser or frozen acceptance pass is claimed.

## Verification

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
