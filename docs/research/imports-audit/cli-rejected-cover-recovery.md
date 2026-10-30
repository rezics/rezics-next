# Ordinary CLI rejected-cover recovery

The frozen outcome is
`ordinary Bangumi and Open Library CLI retain explicit native cover rejection and recover through a valid successor`
in [the native test](../../../services/kernel/test/imports/cli-rejected-cover-recovery.test.ts).
Its [connected caller](../../../services/kernel/test/imports/cli-rejected-cover-recovery-fixture.ts) uses one
`openApiRuntime({batchRecords:8,maxFields:64,maxRecordBytes:65536})`, `identitySupport`, `openApiObserver`,
ordinary `runImportCli`, and the existing media boundary's registered worker. The frozen test is unchanged.

## Source and observation boundaries

The two children are `bangumi` (one synthetic animation JSONL record, unversioned, `bangumi@3`) and
`openlibrary` (the pinned edition fixture with one cover ID, revisions 11 and 12, `open-library@3`). Each invocation uses native Auth's stage/approve/apply credential lifecycle
and the same owner-only account-key file, ordinary six scopes, account/client/API/Auth flags and private SQLite
state on tmpfs. No bearer or private JWK is logged. The real coordinator's seal is observed before Auth or API
effects. The CLI constructs the actual Importer, ImportSession, RunStore, RecordBindings and media resolver.

Only external image HTTP bytes and object storage are fixtures. Corrupt bytes are delivered through
`mediaBoundary.source(url, 'corrupt-image')`; the native fetch/image pipeline produces rejection. The caller
schedules registered jobs when the ordinary CLI requests media status. It never creates a status, receipt,
native reply or authority. Converter output is observed through `createImporter`'s existing
`onConversionOutput` option without changing it. Rejected mapped IDs are extracted from those actual cover
proposals, and absence of native cover candidates/public attachments is checked separately.

Reopen uses precisely the original input and SQLite file after the external old URL starts serving valid PNG
bytes. Actual captured POSTs, source requests, worker calls, terminal status and persisted journal demonstrate
whether terminal rejection survives. Recovery then changes the actual Bangumi URL or Open Library cover ID,
not just the served bytes. Its new native object must become available, retain the supplied original privately,
and expose independently encoded variants. Ordinary editor acceptance/adoption precedes anonymous selected
cover and authorized-variant reads; originals remain unavailable through public downloads.

An independently authored and adopted title survives both invocations. Original bootstrap/proposal journals,
media request/status bytes, receipt locators and native receipt responses/transactions are reread by their
exact keys. Both children are checked again after the other provider completes, preserving source isolation.
The cover retains the current separate `LicenseRef-unknown` credit and source provenance. Provider metadata
rights do not license the image. This journey leaves the existing metadata-with-rejected-cover policy intact.

## Execution and anchors

Source inspection starts at `9867123c8473ebf7fac2f4865f43f759e49e3995`. The missing caller has been bound;
that is not a revalidated native product failure or a passing run. No native/main success is claimed here
before managed acceptance completes.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-rejected-cover-recovery.test.ts
```

The command selects exactly one frozen native test with two provider children and three CLI invocations per
child: initial rejection, identical reopen and changed-cover successor. Each invocation logs actual sanitized
request/response bodies, seal results, CLI result and source-byte hash. Successful completion writes raw evidence
under `.temp/goal/cli-rejected-cover-recovery/` and emits the same witness with the
`cli-rejected-cover-recovery-evidence` prefix in the managed raw log. That witness includes caller SHA-256,
bundled definition digest, actual record revisions/digests/converter revisions, native subject/media IDs,
immutable journal bytes/keys, exact receipt locators and committed transaction/response rows, public responses,
worker registrations/calls and source requests. Original/variant bytes are hashed only in serialized evidence;
the assertions compare the real byte arrays.

Read source: importer CLI, importer planning and deferred-cover paths, media resolver, RunStore/RecordBindings,
source registry, both native converters, the pinned Open Library edition, native API runtime/observer and identity
support, media boundary/observer, and adjacent CLI ACK and Open Library edition-media callers. No external
reference implementation is needed or copied for this existing-contract composition.

## Limits and decisions

This is one connected operator outcome in the existing Provider imports and bridges scope. It adds no
publication policy, media algorithm, allowed host, native byte limit, cover-summary change, general SourceRecord
metadata migration, discovery expansion or richer licence inference. Public proof uses selected `schema:image`
statements and the media download API; it does not claim common-cover web rendering or summary production.
The independent title is a genuine ordinary contributor proposal, so importer-owned proposal replacement cannot
be mistaken for preservation of an independent selection.

Existing source/page/projection/envelope/retry bounds remain in force. Native growth evidence is missing for
this connected outcome: no new PostgreSQL series or replacement counters are fabricated. Existing counted local
and canonical/derived growth suites retain their separate authority. Root typecheck, affected/sibling regression,
integration and promotion remain controller-owned. No production defect is invented to accompany caller glue;
any actually reached importer defect must be fixed under the unchanged acceptance.
