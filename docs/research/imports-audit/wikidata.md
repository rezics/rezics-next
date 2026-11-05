# Wikidata conversion completion evidence

Reviewed checkout: `50253f81316a8e975d67971fb62ed42db3145c10`.
All relative file:line citations below identify that commit, before this report.
This is scoped review evidence, not a replacement contract or a completion claim
for main. The imports Done-when also requires merge on main and a passing root gate;
neither follows from this worker checkout or development integration.
Statuses describe inspected code/assertion coverage; execution limits are below.

Authority read: the complete manager brief at
`/home/edge/projects/rezics/rezics-next/.temp/goal/managers/imports.md`
(Done when, lines 12–28; imports alignment, line 71),
`packages/conversion/README.md:1`, `:38`, `:122`, `:187`,
`services/importer/README.md:21`, `:50`, and
`services/importer/src/import-contract.ts:39`.
The source driver contract explicitly permits a structural fake consumer and
out-of-command CC0 metadata (`specs/imports-wikidata-driver.ts:11`, `:30`, `:35`).
Existing repository documents take precedence over discussion material.

## Requirement findings

- **Pure per-record conversion — proved-by-current-code-and-tests.**
  `packages/conversion/src/wikidata.ts:120` constructs local projections and
  command arrays; its only catalogue state is fixed bundled mappings at `:53`.
  Hashing uses canonical JSON and SHA-256, not time or randomness
  (`packages/conversion/src/support.ts:125`, `:193`, `:281`).
  `specs/imports-wikidata.test.ts:360` freezes input, intercepts I/O, time and
  randomness, asserts synchronous equal returns and unchanged input/resolutions.
  Its real path is `packages/conversion/tests/wikidata-driver.ts:23` →
  `convertWikidata`; the driver only frames the native envelope and captures
  `ConversionError`. Growth tests also deny SQL/network/file calls and compare
  exact anchor return bytes after unrelated conversions
  (`packages/conversion/tests/wikidata-growth.test.ts:114`).

- **Stable explicit converter_revision — proved-by-current-code-and-tests.**
  The export is `wikidata-3` (`packages/conversion/src/wikidata.ts:15`);
  trusted override validation is at `:149`, envelope propagation at `:336`,
  and revision-bearing command identities at `:543` and `:552`.
  `specs/imports-wikidata.test.ts:342` checks a changed native revision without
  changing converter revision. `packages/conversion/tests/wikidata-language.test.ts:70`
  rejects the previous revision, and `wikidata-growth.test.ts:154` checks an
  explicit override without contaminating the data digest.

- **Command proposals and citations — proved-by-current-code-and-tests.**
  `packages/conversion/src/wikidata.ts:337` uses the facts envelope;
  `:347` adds the entity URL, pinned by `lastrevid` when present;
  `:496` retains supported source reference parts; `:536` emits proposals.
  `specs/imports-wikidata.test.ts:45` checks actual command pointers, envelope,
  references and portable validation. Assertions at `:154` and `:204` check
  specific names, authors, dates, URL, preferred rank, P1545 position and P854 URL.
  The driver's `accept` calls real `checkBatchWrite`, then extracts references
  (`packages/conversion/tests/wikidata-driver.ts:80`); it executes no semantic
  command. The test's “semantic consumer” wording proves structural consumption
  only, not persistence, authorization or community adoption.

- **Two-phase conversion/resolution — proved-by-current-code-and-tests;
  server-stable external-id claim — unverified here.**
  Bootstrap contains type/labels/aliases/descriptions and no statements or
  fabricated UUID (`packages/conversion/src/wikidata.ts:546`). Binding an actual
  subject UUID switches to proposals (`:536`); unresolved item values remain
  `somevalue` plus canonical sameAs identity/citation (`:354`, `:488`).
  `packages/conversion/tests/wikidata-bootstrap.test.ts:6` checks both phases
  and equal digest using a supplied test UUID. `specs/imports-wikidata.test.ts:310`
  and `:473` assert missing versus supplied resolutions for author, translator,
  work and publisher. Those resolution maps simulate already-resolved subjects;
  they do not exercise uniqueness-claim storage. Server identity remains the
  independent API-boundary review's responsibility.

- **Native revision/unversioned plus SHA-256 — proved-by-current-code-and-tests
  for native revisions and digest sensitivity; unversioned conversion execution
  remains unverified.**
  `packages/conversion/src/wikidata.ts:144` rejects invalid native revisions and
  requires literal `unversioned` when absent; `:335` hashes only normalized data.
  `packages/conversion/tests/wikidata-growth.test.ts:154` changes an accepted
  label, verifies a different digest/proposal, and keeps registration/private
  fields outside the digest. Reader assertions preserve absent revision as null
  (`services/importer/tests/dumps-revision.test.ts:11`), without inventing one.
  The inspected source outcome suite does not assert a successful revisionless
  conversion followed by a same-unversioned changed record. See the adapter gap
  below; reader success alone does not prove that full seam.

- **Field permission and attribution — proved-by-current-code-and-tests for
  the accepted structured facts projection.**
  `packages/conversion/src/wikidata.ts:342` returns CC0-1.0, Wikidata contributors
  and source URL; all commands use facts, with no summary/cover assets (`:574`).
  `specs/imports-wikidata.test.ts:60` checks facts commands have no `rights`,
  and `:97` traces CC0 metadata and entity citations. The driver points licence
  to actual `/sourceMetadata/license`, never inventing per-command rights
  (`packages/conversion/tests/wikidata-driver.ts:58`). This is the exact permitted
  contract, not evidence that every source namespace or the output database is CC0.

- **Bounded accepted values without truncation — proved-by-current-code-and-tests
  for covered limits; exhaustive limit combinations — unverified.**
  `packages/conversion/src/wikidata.ts:16` declares 128 KiB, 64 terms/statements,
  15 references, 16 snaks and 100 commands. Arrays/scalars reject rather than slice
  (`:93`, `:102`); combined terms/statements and projected bytes are checked at
  `:175`, `:303`, `:333`; over-limit commands reject at `:563`.
  `packages/conversion/tests/wikidata-growth.test.ts:57` checks growing accepted
  projections, normalized round trips, command counts, 65 statements and oversized
  text. `wikidata-type-cap.test.ts:6` proves P31 is counted once at the boundary.
  Public fixture assertions check every generated accepted external-ID value
  (`specs/imports-api.test.ts:1151`), but were inspected only, not run here.
  No inspected test independently covers every reference/snaks/command cap edge.

- **Language/type and qualifier/rank projection — proved-by-current-code-and-tests
  for the inspected supported subset.**
  Accepted languages are canonical platform language families plus `mul`
  (`packages/conversion/src/support.ts:100`, `:115`); ignored languages are skipped
  before reading bodies or consuming the term budget (`wikidata.ts:155`).
  `packages/conversion/tests/wikidata-language.test.ts:50` checks many excluded
  languages, canonical tags and retained labels/aliases/descriptions.
  P31 selects a bundled type and rejects conflicting mapped types (`wikidata.ts:439`);
  deprecated claims are skipped, accepted ranks retained, and qualifiers require
  the property's allowed list (`:457`, `:470`, `:528`). Time/quantity restrictions
  diagnose unsupported semantics (`:364`, `:408`); month precision is asserted at
  `specs/imports-wikidata.test.ts:522`. This is not full Wikibase preservation:
  unmapped snaks are omitted, item qualifiers are skipped (`wikidata.ts:268`, `:477`).
  The fixture proves P1545/P854, not arbitrary qualifier/reference vocabulary.

- **Required JSON-lines reader — proved-by-current-code-and-tests by inspected
  reader assertions; current reader-suite execution — unverified.**
  `services/importer/src/dumps.ts:104` accepts entity lines as well as line-framed
  arrays, then parses real JSON and preserves identity/revision (`:213`, `:233`).
  The driver returns production `readDump` directly
  (`services/importer/tests/dumps-driver.ts:229`); `specs/imports-dumps.test.ts:104`,
  `:115`, `:124`, `:144`, `:175` assert payload equality, CRLF/final-line handling,
  comma framing, absent revision and malformed array failure, with one-byte chunks.
  `specs/fixtures/imports/api/wikidata.jsonl:1` is two entity lines;
  `specs/fixtures/imports/dumps/wikidata.json:1` exercises the array framing.
  Input is decompressed text; this does not certify arbitrary compressed exports
  or non-item entity records, which the reader rejects (`dumps.ts:218`).

- **Shared community-tool/importer API — proved-by-current-code-and-tests.**
  `packages/conversion/package.json:9` exports the Wikidata module.
  `services/importer/src/source-registry.ts:9`, `:55`, `:129` import that same
  function/revision, forward trusted options/context, and alias normalized output.
  `services/importer/tests/source-registry.test.ts:14` checks configured source
  envelopes, revisions, portable commands and normalized round trips.
  `packages/conversion/tests/source-registration.test.ts:21` checks isolated feed
  identities with unchanged digest. There is no separate importer converter.

## Public-API fixture coverage map (inspection only)

`services/kernel/test/imports/api-outcomes.test.ts:5` binds the unchanged suite to
`api-driver.ts:4` → `api-fixture.ts`; runtime `api-runtime.ts:680` uses `readDump`
and `:682` invokes `runRecords(createSourceRegistration(...))`. The production
transport is constructed at `:431`; its injected fetch reaches `app.handle(req)`
at `:504`. Synthetic dump bytes, in-process HTTP delivery and deliberate response
loss are simulated. General API/Auth/Access/database-boundary proof is deferred.

- Wikidata launch/reference retention: `specs/imports-api.test.ts:440` plus launch
  assertions at `:310` check bulk envelopes, title, native revision 101, CC0 metadata,
  two created subjects and literal unresolved `OL999999W` with source reference.
- Restart idempotence explicitly includes every source (`:448`); lost committed
  response/replay uses Wikidata and checks stable keys, receipts and two subjects
  (`:817`, `:850`). This is executable coverage present, not a run result here.
- Changed-record/adoption coverage at `:467` uses Open Library; mass disappearance
  at `:531` uses Bangumi; refresh fence coverage at `:601` uses Bangumi summaries.
  These are shared lifecycle scenarios, not Wikidata-specific executions. Changed
  Wikidata pure output is covered at `specs/imports-wikidata.test.ts:228`.
  Wikidata changed-record persistence, mass-stop and facts-fence outcomes remain
  **unverified** by source-specific API evidence in this review.

## Concrete evidence gap and verification limits

**Incomplete/contradicted test adapter, not an established product defect:**
`services/kernel/test/imports/api-fixture.ts:143` frames Wikidata revision with
`String(native.lastrevid)`. Deterministic sketch: clone the first JSON-lines entity,
delete `lastrevid`, then call `d.convert('wikidata', record, 'conversion-v1', context)`.
Expected under `packages/conversion/README.md:43`: conversion with record revision
`unversioned` and an unpinned entity URL. Actual by inspection: the adapter supplies
`"undefined"`, and `packages/conversion/src/wikidata.ts:148` throws
`Source envelope revision does not match entity`. Smallest owner/path boundary:
imports API fixture adapter, `services/kernel/test/imports/api-fixture.ts:143`.
Existing API conversion inputs all have `lastrevid`, so they miss this gap.
This report neither changes that adapter nor prescribes a new product contract.

No concrete scoped converter product defect is established by this inspection.
Local `bun test` selected all six `wikidata-*.test.ts` source files, conversion
`source-registration.test.ts`, importer `source-registry.test.ts` and
`dumps-revision.test.ts`: 14 passed; the source outcomes wrapper timed out at
120000 ms (`packages/conversion/tests/wikidata-outcomes.test.ts:5`). This occurred
on unchanged base product/test code; no child assertion output was collected.
The frozen outcome assertions therefore remain execution-unverified. No retry
or infrastructure diagnosis is inferred. Document acceptance `test -s
docs/research/imports-audit/wikidata.md` and `git diff --check` pass.
No root/kernel, remote or check-host check was run. Central saturation is not product
evidence and no overload-driven product change is proposed. Full Done-when still
depends on the independent boundary review and execution of the root gate on main.

Review choices: creation aliases/descriptions are immutable metadata, not missing
refresh statements (`specs/imports-wikidata-driver.ts:11`); unknown mappings and
unsupported semantics are assessed against the current bounded projection, not
expanded into a new import policy. No new policy or contract is decided here.
Reference reading: fixture format/rights notes in
`specs/fixtures/imports/wikidata/README.md:1` and `api/README.md:23`;
bundled recipe/core mappings (`packages/definitions/catalogue/recipe.yaml:16`,
`core.yaml:381`, `packages/definitions/release/rezics.json:2449`) confirm factual
mapping boundaries. Recipe instructions have no Wikidata mapping; posts/private
extensions are excluded (`specs/imports-wikidata.test.ts:399`; `docs/scope.md:11`).
The read-only reference index named no Wikidata converter project. Legacy inspection
of `legacy-final:packages/conversion/src/index.ts` found no Wikidata branch/export;
the tag's conversion tree has no Wikidata module. No legacy code was copied.
