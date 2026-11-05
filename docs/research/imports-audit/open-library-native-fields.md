# Open Library native field API acceptance

This report accompanies
[`open-library-native-fields.test.ts`](../../../services/kernel/test/imports/open-library-native-fields.test.ts).
It extends the native API evidence beyond the existing two-work TSV fixture. Existing pure and native
specifications, product code, helpers and definitions are unchanged. The base inspected was
`fb7ffaca82ead9baaa84e18992aae8644aa9ae78`.

## Source and execution surface

Read the native [`work.json`](../../../specs/fixtures/imports/open-library/work.json) and
[`edition.json`](../../../specs/fixtures/imports/open-library/edition.json), the
[API fixture format](../../../specs/fixtures/imports/api/README.md),
[conversion contract](../../../packages/conversion/README.md),
[importer contract](../../../services/importer/README.md),
[`open-library.ts`](../../../packages/conversion/src/open-library.ts), existing
[`imports-open-library.test.ts`](../../../specs/imports-open-library.test.ts), and
[`imports-api.test.ts`](../../../specs/imports-api.test.ts). Also inspected the actual
native API fixture/runtime/observer, media boundary, importer/source registration, semantic editor HTTP
handlers and presentation page HTTP/dispatch implementation. No external research or reference-project
implementation was needed or used.

The new test constructs five literal-tab columns from the existing native JSON payloads: type, key,
revision, modification timestamp and complete JSON. It runs the actual reader, converter and importer
against isolated migrated databases with real Auth-issued credentials and Access. It reuses
`openApiRuntime` and `openApiObserver`; SQL is observation only. The fixed input has two works,
two editions and one cover. Existing record/page/media-job bounds remain active. The runtime's temporary
SQLite uses the existing temporary-directory mechanism with `TMPDIR=/dev/shm` during runtime creation,
restoring the caller's environment afterwards. The existing timeout and native job bounds are unchanged.

## Frozen outcomes

- Source-key bindings, public candidate IDs, stored revision membership and native command receipts
  establish four distinct identities: two `schema:Book` works and two `bf:Instance` editions. No author
  Person is created. The fixture keys identify records; titles and labels never resolve identity.
- Valid ISBN-10 becomes ISBN-13, hyphenated and duplicate ISBN inputs produce one edition fact, and
  ISBN inputs on a work produce no ISBN fact. One edition supplies only ISBN-10, independently
  establishing the converted ISBN-13 effect. Invalid ISBN-10 and ISBN-13 checksums reject the native
  dump without public writes or additional effects. Publication retains May 1980 with month precision.
- Every returned candidate cites its source URL, P648 identifier, native revision and day-precision
  modification date. Unknown supplied authors remain explicit `somevalue` with their P648 qualifier.
  Work-only authors do not appear on the authorless edition; edition-only authors do not appear on
  the authorless work.
- Bibliographic `CC0-1.0` permission and unknown description rights are observed separately in actual
  conversion captures. Neither prose rights nor a blanket licence is manufactured on public commands.
  Description, notes and private/account/post sentinels are absent from commands, public candidates,
  public subjects and composed pages. Exact subject-route observations find no imported summary
  document, and captured transport contains no document write/read.
- A cover goes through the public `media:importFromUrl` request authenticated as the importer account,
  actual registered import/image jobs, Sharp and boundary object storage. Native observations establish
  available media, stored re-encoded variant bytes, container/uploader identity, cover provenance and
  rights-holder/via-Open-Library credit with `LicenseRef-unknown` image licence. Public image values
  use the returned media UUID. Public download authorization returns actual stored variant bytes.
- The editor accepts and adopts the returned candidate IDs in Global before anonymous subject and
  page assertions. Bounded deliveries of the production links relay project those actual editor events.
  The page embeds the same selected statements. Restart and identical reimport
  preserve subject/candidate IDs, receipts/revisions/effect totals and media job/request totals.

## Decisions and limits

The shared native runtime has no `identifierLookup` adapter. A reference to a work already imported
therefore remains the documented `somevalue` plus P648 qualifier. The test preserves that actual
contract instead of inventing a resolution endpoint, new property or author adapter. Later binding
of unresolved references belongs to separate acceptance. The frozen driver type describes only
`value`; exact `somevalue` wire assertions use `unknown` without changing that driver.

The existing observer's convenience adoption helper can create a manual candidate and selects by
value; this case instead calls the real editor APIs with the retrieved IDs. It selects Global because
the public page reads Global. Grants use the ordinary governance API and actual account credential.
The editor is provisioned as `trusted` through `accounts/:id:setRateTier` with the existing
governance management credential (including `account:set_rate_tier`): this fixed accept/adopt session exceeds the new-account thirty-write budget.
The normal trusted budget remains active; no limiter override, clock advance or synthetic actor is used.

Source metadata is observed in actual conversion output only. General source-record metadata
persistence/read remains pending; no new write ABI or successful persistence claim is introduced.
This is a fixed native-field outcome case, not a discovery filter matrix, growth proof, live provider
test or visual browser acceptance. The existing import-to-discovery specification owns those filters.
Object storage and source HTTP are the existing external boundary fixtures, not live R2/upstream access.
The cover's source bytes are registered before importing its URL; observing a source after import cannot
provide bytes to an earlier job. The runtime launches a media worker, so this case also delivers the
production semantic links relay for each selected subject partition (at most sixteen batches). These
are actual outbox deliveries, not seeded projection rows or fabricated media success.

## Verification

Final commands ran from the assigned worktree root through `bun scripts/worker-check.ts --`:

- `bun run --cwd services/kernel check test/imports/open-library-native-fields.test.ts`:
  **exit 0**, **1 pass, 0 fail, 541 assertions**, with no automatic isolated rerun. The native case
  completed in 15.2 seconds; the complete test process took 45.2 seconds. The frozen outcomes above
  are established through actual API responses, receipts, native storage and public projections.
  Log: `.temp/goal/checks/worker-check-2026-10-28T20-12-31.022Z-6e5a73cb.log`.
- `bun run typecheck`: **exit 0**, including the kernel workspace.
  Log: `.temp/goal/checks/worker-check-2026-10-28T20-12-31.022Z-e41dae3a.log`.

The report-presence acceptance is `test -s docs/research/imports-audit/open-library-native-fields.md`,
run through the same wrapper after finalizing this report.

Retry diagnostics exposed fixture setup gaps: source HTTP bytes were registered after the import,
selected relations had no links relay delivery, and the editor exceeded the new-account write budget.
The corrections register source bytes before importing, deliver the production relay, and provision
`trusted` through the actual management credential. `member` is a derived rate class, not a settable
tier; the API rejected it, and the narrower importer-scoped governance credential was also refused.
Compilation-only failures were corrected with the runtime-compatible UUID generator and an explicit
relay `read` status guard. Frozen driver/result types, outcome assertions and the 300,000 ms timeout
were preserved. The ISBN-10-only edition strengthens the conversion evidence.

No full root or kernel gate ran. No files outside the two declared paths are changed. Read source
references are listed above. General source-record metadata persistence/read, late reference binding,
discovery filtering, live upstream availability and browser rendering remain outside this case.
