# Open Library conversion completion evidence

Reviewed checkout: `7149d7367c17ff713f5071abf1e5f42d1ce045fd`.
All relative `file:line` references below identify that snapshot, before this report.
This is inspection evidence, not a replacement contract or an execution result.
The authoritative imports manager brief was read completely from the read-only
main checkout's `.temp/goal/managers/imports.md`, including Done when and the
bootstrap, native-revision, unresolved-reference and field-rights decisions.
Merged package documentation and executable contracts govern converted topics.
No main merge, root-gate pass or check-host result is inferred from this checkout.

## Scoped disposition

The following labels describe what the inspected production code and assertions
support. `proved-by-current-code-and-tests` means a traced implementation and
matching assertions exist; those tests were not executed for this review.

- **Pure per-record conversion — proved-by-current-code-and-tests.**
  `packages/conversion/src/open-library.ts:159` projects explicit native fields;
  `:281` exports synchronous conversion, and `:293` constructs only return data.
  `specs/imports-open-library.test.ts:462` freezes input, guards filesystem,
  process and network entry points, then checks no attempts, synchronous results
  and unchanged inputs at `:510`. The outcome wrapper actually launches that
  suite with `open-library-driver.ts` at
  `packages/conversion/tests/open-library-outcomes.test.ts:10`; the driver calls
  `convertOpenLibrary` directly at `packages/conversion/tests/open-library-driver.ts:28`.
  Its consumer validates actual commands with `checkBatchWrite` and released
  catalogue `checkTyped` at `:70`; it does not submit a server write.
- **Explicit stable converter revision — proved-by-current-code-and-tests.**
  `packages/conversion/src/open-library.ts:19` pins `open-library@2`;
  `:287` accepts an optional trusted override and `:300` includes it in metadata.
  Command identity includes that revision at `:328`. Source-controlled fields
  cannot register a converter. `specs/imports-open-library.test.ts:428` checks
  repeat conversion across fresh drivers, changed clock/random and source edits.
  `packages/conversion/tests/open-library-language.test.ts:46` asserts the old
  revision is retired. Importer registration passes its explicit override at
  `services/importer/src/source-registry.ts:119` and `:131`.
- **Portable proposals and citations — proved-by-current-code-and-tests.**
  `packages/conversion/src/open-library.ts:307` constructs source URL, P648,
  native version and day-precision modification references; `:336` attaches
  them to facts. `:347` distinguishes Book from Instance; `:395` validates and
  deduplicates ISBN-13, including converted ISBN-10, rather than inventing IDs.
  `specs/imports-open-library.test.ts:60` checks all four actual citation parts;
  `:226`, `:238` and `:559` assert work/edition mappings, date precision and ISBN
  values. The driver locates actual reference parts at
  `packages/conversion/tests/open-library-driver.ts:99`, not fabricated observations.
  `packages/conversion/tests/open-library-language.test.ts:30` calls production
  conversion and checks canonical deduplicated language values and citations.
- **Two-phase bootstrap — proved-by-current-code-and-tests for converter output;
  unverified for server uniqueness in this scope.**
  `packages/conversion/src/open-library.ts:348` emits one metadata-only create
  without an ID, while `:338` emits proposals only with a supplied subject ID.
  `specs/imports-open-library.test.ts:79` asserts exactly that split and prohibits
  invented bootstrap IDs/statements. Stable key inputs include source, native
  key, revision, digest, converter revision, field and target at converter `:322`.
  Actual create-or-resolve claim anchoring belongs to the API-boundaries review;
  converter tests use supplied UUIDs and cannot prove server uniqueness.
- **Unresolved and resolved relations — incomplete/contradicted for stable
  transition identity; proved-by-current-code-and-tests for value preservation.**
  `packages/conversion/src/open-library.ts:98` accepts wrapped work authors and
  direct edition author/work keys. `:377` requires supplied UUID resolutions;
  `:384` emits `somevalue` plus a P648 qualifier when unresolved, and an item
  UUID only when supplied. Both keep the record citation. This is the exact
  current representation specified by `packages/conversion/README.md:128`;
  the identifier survives as an external value in a qualifier, not a fabricated
  item ID. `specs/imports-open-library.test.ts:231` and `:539` assert both forms.
  The transition's command-key collision is detailed below.
- **Native revisions, unversioned and SHA-256 — proved-by-current-code-and-tests
  within Open Library's native-revision requirement.**
  `packages/conversion/README.md:45` explicitly requires native Open Library
  revisions. Converter `:167` rejects absent, non-positive, unsafe or mismatched
  revisions; `:299` serializes the actual revision, never a dump timestamp.
  `specs/imports-open-library.test.ts:407` asserts missing/malformed revisions
  reject. The general `unversioned` rule is not permission to invent an Open
  Library revision or accept a record this source contract rejects.
  `packages/conversion/src/support.ts:125` uses SHA-256; `:193` canonicalizes the
  sanitized projection. `packages/conversion/tests/open-library-growth.test.ts:82`
  asserts a title-only change changes digest, private fields do not, and target
  bindings do not. Source outcome assertions at `specs/imports-open-library.test.ts:451`
  independently check changed source values and propagated native revisions.
- **Field-level permission and attribution — proved-by-current-code-and-tests
  for emitted conversion data; unverified for media execution/disclosure here.**
  Converter `:411` diagnoses unknown prose rights without a summary proposal;
  `:451` identifies CC0 bibliographic permission separately from description
  rights. `:419` constructs allowlisted cover assets with unknown licence,
  rights-holder credit, via-source URL and cover provenance. `:435` requires an
  actual supplied media mapping before an image proposal. The source test at
  `specs/imports-open-library.test.ts:258` inspects returned description, actual
  credit/provenance, separate field groups and absence of summary commands;
  `:300` supplies a synthetic media UUID and checks the resulting image command.
  It explicitly defers upload/re-encoding proof at `:326`. No metadata licence
  is assigned to cover copyright; no hotlink is proposed as an image value.
- **Bounded behavior without truncation — proved-by-current-code-and-tests
  for the inspected caps; unverified for exhaustive combinations.**
  Converter `:84` rejects invalid/oversized strings, `:89` rejects collections
  over 64, `:186` caps combined relations, `:195` caps retained prose at 1 MiB,
  `:217` caps projection at 2 MiB and `:439` rejects over 100 commands.
  These are rejecting limits, not slicing accepted lists or text to fit.
  `packages/conversion/tests/open-library-growth.test.ts:33` checks 1/8/64
  relations remain portable and 65 rejects. Its oversized-title case does not
  independently test the projection-byte boundary. The logical growth suite
  uses production conversion, large UTF-8 prose and whole-return byte slopes at
  `packages/conversion/tests/logical-growth.test.ts:71`, `:115`, `:145` and `:169`.
  Unrelated catalogue/history arrays in `open-library-growth.test.ts:69` are
  deliberately inaccessible synthetic populations, not database-scale proof.
- **Required TSV reader — proved-by-current-code-and-tests for books/works/
  editions; author records are intentionally excluded by the current contract.**
  `services/importer/src/dumps.ts:191` splits five literal-tab cells, parses JSON,
  cross-checks type/key/native revision and yields only work/edition records.
  `specs/fixtures/imports/api/README.md:19` documents precisely those columns.
  `specs/imports-dumps.test.ts:91` compares actual reader output to both native
  payloads, revisions and escaped text; `:219` rejects malformed envelopes.
  The driver is the real `readDump`, returned directly at
  `services/importer/tests/dumps-driver.ts:234`, not an alternate TSV parser.
  `specs/fixtures/imports/dumps/openlibrary.tsv:3` lacks `last_modified`: its
  edition proves reader preservation, not a full reader-to-converter success.
  `packages/conversion/src/open-library.ts:163` rejects author record types,
  and `specs/imports-open-library.test.ts:342` explicitly requires that exclusion.
  Therefore this review does not silently expand book imports into author subjects.
- **Shared community API and importer converter — proved-by-current-code-and-tests.**
  `packages/conversion/package.json:8` exports the Open Library module.
  `services/importer/src/source-registry.ts:14` imports that public entry point;
  `:60` registers it and `:129` delegates, adding aliases rather than converting
  independently. `services/importer/tests/source-registry.test.ts:49` compares
  work and edition registration output to direct exported conversion with real
  fixture data and synthetic subject/reference/media bindings, including source,
  revision, digest, keys and deferred assets at `:76` and `:89`.

## Concrete missed defect: resolution changes a body but reuses its command key

Boundary: `packages/conversion/src/open-library.ts:322` and `:377` (conversion
owner); a regression belongs beside the source relation assertions. No product
implementation or acceptance modification is part of this report.

Deterministic input: `{external_id:'/works/OL1W', record_revision:'1', record:{
type:{key:'/type/work'}, key:'/works/OL1W', revision:1, title:'Book',
last_modified:{value:'2025-01-02T03:04:05'},
authors:[{author:{key:'/authors/OL1A'}}]}}`.
Convert twice with subject `00000000-0000-4000-8000-000000000001`; on the second
call add `resolvedReferences:{'/authors/OL1A':'00000000-0000-4000-8000-000000000002'}`.
Find each `schema:author` proposal. Actual by inspection: both keys hash the
same tuple, ending in `facts`, `authors:0`, and the same subject; their statement
values differ (`somevalue` versus the supplied UUID). Expected: unchanged input
and context replay identically, while this changed relation body can be submitted
as a distinct proposal without reusing the unresolved command's identity.
Failing-test sketch: assert identical digests, different author values and
`expect(resolvedAuthor.key).not.toBe(unresolvedAuthor.key)`; the last assertion
fails under the current key construction. No server outcome was executed here.
The tests at `specs/imports-open-library.test.ts:539` check resolved values but
never compare those keys. `packages/conversion/tests/open-library-growth.test.ts:90`
also changes the subject UUID, concealing this same-subject collision.

## Source-specific public-API fixture map (inspection only)

`specs/fixtures/imports/api/openlibrary.tsv:1` and `:2` contain two small works
with titles, native revisions and modification timestamps. They contain no
edition, author relation, ISBN, description or cover; converter fixture breadth
must not be presented as public-API fixture breadth.
`specs/imports-api.test.ts:436` calls the common launch assertions at `:310`:
portable bulk requests, bearer headers, returned subject/proposals, citations,
native revision `1` and two created subjects. `:448` covers unchanged restart
for every source; `:467` uses Open Library for changed title/native revision and
converter revision, preserving subject identity and community adoption.
The mass-disappearance case at `:531` and fenced-refresh case at `:601` use
other sources, so Open Library-specific executable coverage of those outcomes
is **unverified**; no duplicate lifecycle audit or product change is implied.

The wrapper at `services/kernel/test/imports/api-outcomes.test.ts:10` binds the
suite to `api-driver.ts`, which delegates to `api-fixture.ts`. Its run path uses
production `readDump`, `createSourceRegistration` and `importer.runRecords` at
`services/kernel/test/imports/api-runtime.ts:680`. The injected fetch dispatches
Request objects to the production app at `:449` and `:504`, rather than a live
network server. Inputs, chunking and fault controls are fixture simulations.
The fixture's separate pure-convert method at `api-fixture.ts:133` calls the
same production converter; it is not evidence of a public write on its own.
General authentication, database and real-API boundary proof remain with the
independent API-boundaries review; this inspection makes no passing-run claim.

## Limits and review decisions

Only this report is changed. The named acceptance is report existence/nonempty;
no converter, root/kernel, remote or check-host checks were run for this review.
Current code/assertions support substantial source conversion coverage, with the
resolution-key gap above and unexecuted boundary coverage explicitly outstanding.
Main merge and successful root gate on main remain unverified Done-when evidence.
No check-host saturation was measured here; shared-host overload is operational
context, not evidence of a converter defect or a reason to change product behavior.
The report follows merged work/edition-only and native-revision contracts rather
than inventing author imports, fallback revisions or a new relation schema.
Sources read: the manager brief, owning conversion/importer READMEs, public bulk
shape, converter/support/export files, source/reader tests and drivers, source
fixtures and the API fixture wiring cited above. No legacy behavior was needed,
no legacy code was copied, and no external reference project or research was used.
