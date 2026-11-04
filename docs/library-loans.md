# Private copy loans

Loans record an owner's private lending or borrowing of one exact native copy. They grant no digital entitlement,
send no message and assert no other person's consent. Copy eligibility and authority remain native copy policy;
an Open Library entitlement, installation or DRM licence is not a local lending grant.

## Calendar and lifecycle

Decision: loan dates are complete Gregorian `YYYY-MM-DD` values; the server supplies one UTC calendar day per
response, and a due date is inclusive through that day.

Years range from 0001 through 9999. Impossible calendar days, partial dates, instants and normalized overflow dates
are invalid. Stored dates are compared as dates and are never passed through browser timezone formatting. An absent
due date is undated. A date equal to the response boundary is due; an earlier date is overdue. Return takes precedence
over both. Each future list response must disclose its boundary and reuse it for every row.

The model's immutable loan identity carries account, exact copy, direction (`lent` or `borrowed`), counterparty,
start day, nullable due and return days, and revision. Create operands also capture the selected copy revision.
A due date cannot precede the start. Extension assigns an undated loan's first due date or strictly advances its
existing due date; it never clears or shortens one. Return records a day between the start and the server's current
day, including early return. It is terminal. Both extension and return require the expected revision. Revisions
cannot advance past the native signed integer maximum.

Counterparty is explicitly `{kind: "name", name}` or `{kind: "person", personId}`. Private names retain their exact
text, including surrounding spaces and Unicode composition. Names contain 1–300 Unicode scalar values, must contain
non-whitespace text and cannot contain control characters or unpaired surrogates. They are never matched to an
account. A person identity must be explicitly selected; parsing a routable ID does not admit or disclose that person.

## Installed boundary

`loan-date.ts` and `loan-model.ts` implement pure validation, immutable operands and fresh lifecycle transitions.
They are internal domain rules, not mounted commands. Exact owner/copy checks reject foreign accounts even when
they share a route, before comparing revisions. The copy operand check rejects stale or disposed copies but is
explicitly insufficient to establish current eligibility, rights or authority.

Native dispatch must recheck the active viewer, current owner and copy policy, lock the exact live copy, enforce
one open loan atomically with disposal/deletion, and persist the original result through the existing command
runner. A fresh repeated return conflicts; an exact receipt replay returns its original result without executing
the transition again. Parsed operands and resulting snapshots are detached and frozen, including nested party data;
this preserves their value in memory but does not supply durable receipts or refresh reconciliation.

There is currently no loan migration, persistence, mounted API, cleanup producer, generated client delivery or
`/library/loans` page. No loan command is exposed through another transport. Safe copy/work presentation, admitted
person disclosure and concealment, viewer states and allowed actions remain to be implemented at the native boundary.
The existing copy editor and navigation remain the current installed journey.

The continuation must install bounded indexed open/overdue and history reads, owner/filter/order/lifetime/generation
cursor binding, native receipt resolution, bounded funded cleanup and terminal erasure before exposing the journey.
Finite page size alone does not establish a query or maintenance bound. Independent 64/512/4096 native growth cases
and complete costs across native owner, source, Access and Work pools remain required; these domain functions make
no SQL, lock, disclosure, retention or scheduler cost claim.

## Verification

Focused cases in `test/library/loan-date.test.ts` and `test/library/loan-model.test.ts` pin Gregorian validity, due-day
inclusivity, undated state, exact copy/owner operands, name/reference separation, immutable inputs/results, stale
edits, extension, early return and terminal return. They do not prove concurrent native commands, disclosure,
receipts, membership cursors, owner retirement, API execution or rendered interaction. Those remain continuation
acceptance, along with the mounted lifecycle, lost acknowledgements and refresh, disposal races and scale cases.

`bun run --cwd services/kernel typecheck` was run and failed with exit 2. Its first compiler diagnostic was
`../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.`
That client export is unchanged from the base, where the referenced module is absent. The output also reports
errors in unchanged Community, Content and Search source/tests. This is not a successful workspace typecheck.

After fixing the test fixture types and applying the repository formatter, the workspace compiler reported no
loan source or loan test diagnostics; its unrelated workspace errors remain. The focused landing command
`bun run --cwd services/kernel check test/library/loan-date.test.ts test/library/loan-model.test.ts` executed
both files: 9 tests passed, 0 failed, with 139 assertions. Its native command completed, but the wrapper exited 1
while returning artifacts:
`error: remote-check: returned empty directory differs from its manifest: services/kernel/.temp/schema-diagnostics/schema-3aQitT`.
The test phase passed; the overall landing command did not. Full native HTTP lifecycle, frozen acceptance,
64/512/4096 growth and browser review were not run and remain deferred to integration and the continuation.
