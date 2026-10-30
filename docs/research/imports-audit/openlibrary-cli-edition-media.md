# Open Library edition and cover CLI evidence

The frozen native case is `Open Library work edition and cover operator lifecycle` in
`services/kernel/test/imports/openlibrary-cli-edition-media.test.ts`. Its binding invokes
the production `runImportCli` with a five-column TSV file and ordinary account-key flags.
One `openApiRuntime` owns Auth, Access, the public API, database and registered media worker.
The CLI owns a separate durable Importer/RunStore/RecordBindings ledger across invocations.
The binding uses the existing `identitySupport`, `openApiObserver` and `mediaBoundary` exports.
It neither calls the runtime's direct-import driver nor constructs another application.

## Source and decisions

The source bytes derive from `specs/fixtures/imports/open-library/work.json` and `edition.json`:
the synthetic Glass Atlas work has native revision 7 and modification date 2025-01-02;
the edition has revision 11 and modification date 2025-02-03. The journey adds synthetic
edition language `/languages/eng` and cover IDs 900000002, 900000003 and unavailable sentinel
-1. It retains the work's cover 900000001, native author/work keys, ISBNs and unknown prose.
The unrelated configured source imports the same work key with no covers. These are fixture
changes, not assertions about an upstream historical record. No native revision is invented
when the unchanged edition learns its own exact work claim.

The two aliases are `edition-books` and `independent-books`. Foreign knowledge precedes the
first edition import, which remains unresolved. Importing its own work and revisiting the
same complete edition/work dump resolves only the own-source relation. The foreign baseline
is independently point-read and remains identical. Complete successor inputs retain both
own records, so the journey needs no disappearance-threshold override.

`unresolvedAuthorCitation` is the full key read from the persisted normalized source row;
the actual native author candidate independently has `somevalue` and its `wdt:P648` qualifier.
Public editor selection uses retrieved candidate IDs, including the target-addressed work
relation. The ordinary public subject read supplies edition type, resolved work, ISBN and
language values. The fence comparison records the actual native subject revision, separately
from the stable source-record revision and digest.

Each cover is credited separately under `LicenseRef-unknown`, with Open Library attribution
and cover-group provenance. Bibliographic CC0 permission never becomes summary or image
permission. Source image HTTP and object storage are the existing external doubles; native
reservation responses, registered job execution, database rows, variants, events and download
decisions remain real. Scheduling drains only actual returned reservation IDs before their
ordinary status request. Public selected downloads succeed before takedown and return 404
after media takedown plus the exact edition cover tuple fence. Reopening does not replace
the native entry, media request bytes/keys, or original bootstrap bytes/key/ACK/receipt.

## Verification and limits

The local admission file `services/importer/tests/openlibrary-cli-edition-media.test.ts`
adds three cases: a truncated second row, a mismatched TSV identity and an invalid ISBN,
each following a valid cover-bearing edition. They invoke the actual CLI and require invalid
input with no Auth/API/media request before complete validation. They are local admission
proof, not native acceptance.

The managed native command is:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/openlibrary-cli-edition-media.test.ts
```

The native raw log prints `Open Library CLI native evidence` with actual source rows/digests,
converter revision, definition bundle digest and disclosed release, exact native IDs, immutable
bootstrap journal/receipt, all captured command receipt locators, media event transaction
anchors, variant object keys/digests/byte counts, registered workflow IDs and public reads.
It prints no private JWK or bearer.

Managed acceptance passed on code revision `281b5ce279`: one native case, 432 assertions,
zero failures, zero load reruns. The exact child case is
`Open Library work edition and cover operator lifecycle`. Check
`f3b6fbb3-78c8-41a6-8315-eaeb99edfec2` exited 0; its raw log is
`.temp/goal/checks/worker-check-2026-10-30T05-42-36.020Z-023985f8.log`.
The selected kernel compiler and quality phases passed; this is not a root typecheck
or an all-workspace regression result. Subsequent changes only record this evidence.

The same code passed the importer compiler (137 files), edited-file formatting and three
local admission cases (12 assertions):

- `Open Library CLI seals the whole cover-bearing TSV before effects: truncated row`
- `Open Library CLI seals the whole cover-bearing TSV before effects: mismatched identity`
- `Open Library CLI seals the whole cover-bearing TSV before effects: invalid ISBN`

The first reached failure was local TS2352 on the new admission test's throwing fetch
boundary. Giving that function its actual `Promise<Response>` signature fixed the compiler
failure before native admission. The first managed native execution passed. The missing
caller was bound without a reached production defect or an unnecessary production rewrite.
The frozen acceptance file remains unchanged. No files outside the declared paths changed.

The raw native evidence contains five CLI invocations, 21 successful command receipt
locators and three available media rows with two stored variants each. The registered
children are three `content.importFromUrl` and three `content.image` workflows. The edition's
two selected variant downloads returned 200 before the fence and 404 afterward; public
cover disclosure became empty. Native subject revision remained 23 across the fence.
The edition's source revision remained 11 with digest
`b3af614716de69683dc9e376e9786669687c3eb2b4519baa96ffca333f72a6b5`;
the work media retained source revision 7 with digest
`a5bce5d5027df194ef37109e693997f19861caeb337ff4eefcd3f37a224e848f`.
The definition bundle and public disclosed release both were
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`
(catalogue version 1.0.0).

Exact native anchors in that log include:

- Edition `01a18bd5-e8c6-7401-aa1b-ae197eb40fbd`, own work
  `01a18bd5-ec7f-725f-b541-6e1a907c02b8`, foreign work
  `01a18bd5-e74c-74f9-8398-9afe7df21990`.
- Immutable bootstrap key
  `edition-books:/books/OL900000002M:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`,
  native receipt transaction `01a18bd5-e8c6-7400-8e3d-aee7c903ce96` in partition 2785.
- First edition cover `01a18bd5-e94f-75a0-a1d7-ae198b470f42`, import workflow
  `fx:1:2785:2:0:content_import_from_url_01a18bd5-e94f-75a0-a1d7-ae198b470f42`,
  image workflow `fx:1:2785:3:0:content_image`, available-event transaction
  `01a18bd5-e9e0-7340-a3a6-370fc5795780`.

Source inspection: the two source JSON fixtures; `cli.ts`, `importer.ts`, `media-resolver.ts`,
`record-bindings.ts`, `run-store.ts`, `source-registry.ts`, conversion `open-library.ts`;
native `api-runtime.ts`, `api-observer.ts`, `identity-fixture.ts`, `media-boundary.ts` and its
observer; the adjacent known-reference, named-feed and Open Library native-field cases;
the importer and conversion owner READMEs. No external reference implementation is ported.

This is one focused connected caller. Existing bounded acquisition, converter, local ledger,
transport and worker limits apply unchanged. It adds no PostgreSQL growth measurement, no
catalogue/history scan and no shared capture extension. Missing native growth evidence stays
missing. No adjacent native result is reused as acceptance for this caller.
