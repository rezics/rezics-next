# VNDB conversion completion evidence

Reviewed checkout: `34dbc5607bf58f36722fb7e252df58fc1120d541`.
All relative file:line references below refer to that commit, before this report.
This is inspection evidence, not a replacement specification or a claim of main
merge, successful execution, or root-gate completion.

The complete manager brief at
`/home/edge/projects/rezics/rezics-next/.temp/goal/managers/imports.md`
was read. Its Done-when requires pure shared conversion, permitted fields,
references, native identity/revision tracking, and actual API outcomes on main.
Current owning contracts inspected: `packages/conversion/README.md:17`,
`packages/conversion/README.md:43`, `packages/conversion/README.md:127`,
`packages/definitions/README.md:716`, and `services/importer/README.md:21`.
The fixture's rights boundary is explicit at
`specs/fixtures/imports/vndb/README.md:16`.

## Requirement dispositions

Here **proved-by-current-code-and-tests** means production implementation and
executable assertions agree by inspection; no source suite was executed here.
**Incomplete/contradicted** identifies a concrete mismatch. **Unverified** means
the inspected evidence does not establish the outcome.

- Pure per-record conversion: **proved-by-current-code-and-tests**.
  `packages/conversion/src/vndb.ts:130` projects only own declared data fields;
  `packages/conversion/src/vndb.ts:220` has no fetch, persistence, clock or UUID
  generation. The frozen-input scenario at `specs/imports-vndb.test.ts:156`
  intercepts filesystem, fetch and process calls, compares two full returns,
  and checks the original remains unchanged. Its driver forwards the grouped
  record directly to `convertVndb` at `packages/conversion/tests/vndb-driver.ts:17`.
  Additional SQL/socket spies and ignored growing private populations are at
  `packages/conversion/tests/vndb-growth.test.ts:47`; whole-return stability
  after unrelated conversions is asserted at
  `packages/conversion/tests/logical-growth.test.ts:126`.
- Explicit converter revision: **proved-by-current-code-and-tests**.
  `packages/conversion/src/vndb.ts:13` exports `vndb@5`;
  `packages/conversion/src/vndb.ts:230` takes a trusted registration override.
  `packages/conversion/tests/vndb-growth.test.ts:86` asserts an override changes
  command keys, preserves the digest, and appears in the returned registration.
  `packages/conversion/tests/vndb-language.test.ts:48` also guards against the
  earlier language-output revision. Source-body registration is never read.
- Command proposals and exact citations: **incomplete/contradicted**.
  Real create/propose commands are validated at
  `packages/conversion/src/vndb.ts:324`; facts carry VN identity and revision URL
  at `packages/conversion/src/vndb.ts:242`. The driver runs the actual portable
  validator at `packages/conversion/tests/vndb-driver.ts:6` and observes actual
  statement/reference paths at line 43. However, the current definitions README
  requires explicit revision/date reference parts; finding A below is missing
  from both production output and the source assertions.
- Stable two-phase external-ID bootstrap/resolution:
  **proved-by-current-code-and-tests** for the converter's portion;
  **unverified** for server uniqueness across runs in this review.
  `packages/conversion/src/vndb.ts:299` hashes source, ID, native revision,
  digest, converter revision, phase and target into deterministic command keys.
  Lines 301–322 emit one metadata-only create without a target, or statements
  addressed to the caller's UUID. No UUID is invented. The bootstrap test at
  `packages/conversion/tests/vndb-bootstrap.test.ts:6` checks no create statements,
  actual resolved targets, portable validation and equal digests across phases.
  Its UUID is supplied by the test, not returned by a server uniqueness claim.
- Native revision versus unversioned and SHA-256 changes:
  **proved-by-current-code-and-tests** for the current VNDB native-revision contract.
  `packages/conversion/README.md:50` requires VNDB's native revision;
  `packages/conversion/src/vndb.ts:153` checks matching positive numeric
  `entry_meta.revision` and envelope text. `services/importer/src/vndb-tables.ts:428`
  reads that field; `services/importer/src/cli.ts:712` preserves it as text.
  `packages/conversion/src/support.ts:193` canonicalizes the sanitized projection
  and hashes through SHA-256 at line 125. Title-only edits alter digests at
  `specs/imports-vndb.test.ts:145`; bindings/registration do not at
  `packages/conversion/tests/vndb-growth.test.ts:86`.
  Missing VNDB revision rejects rather than becoming a fabricated timestamp.
  The shared null-to-`unversioned` helper at
  `packages/conversion/src/support.ts:259` is not a missing-revision VNDB path.
- Field-level licence and attribution: **proved-by-current-code-and-tests** for
  the permitted metadata projection and exclusions, not a blanket dataset grant.
  `packages/conversion/src/vndb.ts:336` returns ODbL-1.0, DbCL and VNDB attribution.
  `specs/imports-vndb.test.ts:39` asserts those exact values and facts-group
  commands without summary rights. The projection discards descriptions, image
  IDs, release prose, user posts/reviews/accounts/lists. The complete-output
  sentinel checks at `specs/imports-vndb.test.ts:201` cannot be hidden by the
  observation adapter. `services/importer/src/vndb-tables.ts:351` bypasses decoding
  for unrelated tables. The table test searches actual logical SQLite contents
  at `services/importer/tests/vndb-tables.test.ts:260` for private/image markers.
- Cover credit belongs to the rights holder: **proved-by-current-code-and-tests**
  as an exclusion here. VNDB emits no cover assets or media commands
  (`packages/conversion/src/vndb.ts:335`), and the source suite forbids cover facts
  (`specs/imports-vndb.test.ts:85`). There is no VNDB cover attribution path proved
  by these tests. The metadata licence is not applied to an image; this report
  does not authorize adding covers under that licence.
- Bounded record/command behavior without truncation:
  **proved-by-current-code-and-tests** for implemented rejection boundaries;
  **incomplete/contradicted** for the documented command maximum (finding B).
  `packages/conversion/src/vndb.ts:14` caps titles at 64, combined original/Latin
  title candidates at 64, links at 32, text at 4096 UTF-8 bytes, sanitized JSON at
  64 KiB and commands at 98. Lines 262 and 323 reject rather than slice output.
  `packages/conversion/tests/vndb-growth.test.ts:32` verifies exact proposal counts
  at 1/8/64 titles and rejects excess rows/text. Duplicate identical names are
  deduplicated; distinct accepted names become labels/aliases or name candidates
  (`packages/conversion/src/vndb.ts:267`). Combined Latin-title/link maxima are
  not covered by that test. Reader-to-converter acceptance also has the seam in C.
- Required dump format and archive/table assembly:
  **proved-by-current-code-and-tests** for synthetic native table entries;
  **unverified** for replaying the pinned compressed public dump in this attempt.
  `services/importer/src/cli.ts:673` selects `VndbTablesStore`, with `readArchive`
  for decompressed ustar bytes at line 681, then stages everything before paging.
  `services/importer/src/vndb-tables.ts:274` recognizes exactly three table/header
  pairs. Headers may follow data (SQLite spool), and all six members plus parent,
  title and native-revision consistency validate before ready at line 328.
  COPY nulls/escapes decode as bytes before fatal UTF-8 at line 120; source pages
  use numeric native-ID keysets at line 496. The test harness at
  `services/importer/tests/vndb-tables.test.ts:50` uses real SQLite and production
  stage/page calls. Lines 94–151 assert reversed table order, delayed completion,
  exact grouped rows, pagination and durable reopen. Lines 273–295 assert escaped
  text, reordered headers and cap rejection. The archive transport is simulated
  by entry generators in these tests, not a zstd download or tar extraction.
- Same exported community API and importer converter:
  **proved-by-current-code-and-tests**. `packages/conversion/package.json:7`
  exports the implementation itself. `services/importer/src/source-registry.ts:8`
  imports that subpath and line 50 registers that function/revision by reference;
  line 131 invokes it. `services/importer/tests/source-registry.test.ts:14` checks
  actual output validation, trusted feed/revision forwarding, and re-conversion
  from normalized data. The registry adds aliases and an aggregate statistic at
  `services/importer/src/source-registry.ts:81`, not another VNDB fact converter.
  The statistic keeps count/mean with VNDB attribution; its test transport is
  simulated (`services/importer/tests/source-statistics.test.ts:49`), so its name
  does not establish real HTTP authorization or storage.

## Concrete mismatches and missing assertions

A. **Incomplete/contradicted — citation parts.** The exact current contract at
`packages/definitions/README.md:741` requires source URL, catalogued identifier,
`schema:version` and `schema:dateModified`, separately from the source envelope.
Use `specs/fixtures/imports/vndb/record.json:21` with revision 7 and lastmod
`2026-10-24`, resolving to `00000000-0000-4000-8000-000000000001`.
Expected: each fact reference includes version 7 and the native last-modified day.
Actual by inspection: reference parts are only `wdt:P3180 = v123` and
`schema:url = https://vndb.org/v123.7` (`packages/conversion/src/vndb.ts:242`).
The reader retains lastmod (`services/importer/src/vndb-tables.ts:427`), but
conversion drops it (`packages/conversion/src/vndb.ts:209`). A failing-test sketch
asserts the reference property IDs contain both required schema properties.
The existing source assertions at `specs/imports-vndb.test.ts:99` check envelope
revision and URL, never those two reference parts. Smallest owner boundary:
`packages/conversion/src/vndb.ts` and its source tests; no kernel change is implied.

B. **Incomplete/contradicted — documented maximum.**
`packages/conversion/README.md:149` says at most 97 commands; implementation allows
98 (`packages/conversion/src/vndb.ts:20`). Deterministic sketch: one `v1` revision-1
record with `olang: 'en'`, 64 distinct titles `T0`…`T63` in `en-x-t0`…`en-x-t63`,
all official with null Latin text, plus 32 matching link/dictionary rows with IDs
1…32 and website values `https://example.org/0`…`https://example.org/31`.
Bind the UUID above. Documented expected maximum: 97; actual construction:
1 identifier + 64 names + 32 URLs + 1 original language = 98, without truncation.
The existing growth test has no links, so misses the discrepancy. This is a
documentation/code mismatch, not evidence of an unbounded converter. Smallest
owner boundary: conversion README and a combined-limit source assertion.

C. **Unverified — accepted empty Latin cell across the composition boundary.**
`services/importer/tests/vndb-tables.test.ts:280` stages `v124` with title `港` and
an empty Latin cell successfully, but only inspects `v123` afterward. The reader
returns that empty string (`services/importer/src/vndb-tables.ts:421`), whereas
`packages/conversion/src/vndb.ts:175` calls nonempty `titleText` and rejects it.
Small deterministic seam test: stage that existing fixture, page `v124`, then
convert its real envelope. Expected if reader-accepted empty Latin is a supported
native record: preserve `港` and produce bootstrap metadata; actual by inspection:
`ConversionError` at `/vn_titles/0/latin`. No end-to-end assertion covers this input.
The native validity/required handling of empty Latin remains unverified here;
this report chooses neither normalization nor a new acceptance rule. Smallest
owner boundary: VNDB table-reader/converter tests and their input contract.

The vocabulary inventory also maps `vn.alias` to `schema:alternateName`
(`packages/definitions/sources/vndb.yaml:2622`), while the current converter
README describes a narrower projection and code discards that column. Inventory
mapping completeness is **unverified**, not inferred from title-only success;
this report does not silently expand the converter to every inventoried field.

## Source-specific public-API coverage and completion limits

By inspection only, `specs/imports-api.test.ts:81` replaces the old inline SQL
fixture with synthetic six-entry native COPY table streams, seven-byte chunks,
and revisions 7/19. `services/kernel/test/imports/api-runtime.ts:655` feeds those
unchanged entries to production `VndbTablesStore`; line 682 calls production
`Importer.runRecords` with `createSourceRegistration`. No table assembly lives
in that driver. Tar/zstd acquisition is bypassed at this fixture boundary.
`specs/imports-api.test.ts:310` asserts validated authenticated batch requests;
lines 327–355 inspect returned title facts, same-subject targets, revision URLs,
rights metadata and exact effect counts. Lines 380–433 cover excluded synopsis,
rejection of unsupported inline SQL, and truncated/wrong-header no-effects cases.
This maps source coverage; actual API-boundary proof belongs to its separate review.

Only this report is changed. No product suites, root/typecheck/kernel gates,
remote checks, installations or check-host probes were run. The acceptance is
`test -s docs/research/imports-audit/vndb.md`. Existing assertions are inspection
evidence, not fresh passing results. No infrastructure failure was observed;
central check-host saturation neither proves a product defect nor excuses A/B.
Main merge and root-gate completion remain **unverified**.

Interpretive choices: use current merged contracts over discussion references;
treat native revisions as mandatory for VNDB; keep covers excluded; distinguish
converter determinism from server uniqueness; leave ambiguous input normalization
and inventory expansion undecided. No legacy behavior was needed or copied.
The reference index was inspected at the prescribed read-only `.reference/INDEX.md`;
no VNDB clone is listed. Official dump/schema/generator evidence was read as
recorded hashes and format notes in `specs/imports-vndb-tables-driver.ts:10`,
not independently downloaded or revalidated. No external research was necessary.
