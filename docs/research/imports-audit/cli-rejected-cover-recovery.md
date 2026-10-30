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

Source inspection starts at `9867123c8473ebf7fac2f4865f43f759e49e3995`. Managed acceptance passed on
`94e003a486ee861a4d5a71083cda671f786bb7b9`, binding the previously missing caller without a production
implementation change. There was no reached production failure in this attempt. Main promotion is not claimed.

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

Managed check `35458534-d01d-4db4-9749-0c9af460b943` exited 0: **1 pass, 0 fail, 820 assertions**, no skips or
todos, and no load reruns. Its raw log is
`.temp/goal/checks/worker-check-2026-10-30T08-51-52.110Z-f3e94e78.log`; line 81 contains the complete
`cli-rejected-cover-recovery-evidence` witness, including every original receipt. The caller SHA-256 was
`b6205559b2e1b7a577325be3170e42d824bdaa8fdb886dfa9884fd152291b3cb`; the actual bundled digest was
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.
Local importer compilation passed for 146 files, and edited-file formatting passed before slot admission.
The managed selected check also completed its compiler, quality and native test phases.

The exact two provider children each returned CLI code 0 for initial rejection, identical reopen and valid
successor. They retained 3 Bangumi and 7 Open Library original command receipts, including bootstrap responses
and transactions. The worker recorded 10 executions: four imports, four image jobs and two native purges.
Four source fetches delivered two 21-byte corrupt inputs and two 151-byte valid PNGs; neither reopen fetched
or posted media or introduced a worker call. Each available object retained its own original and two variants:
AVIF (287 bytes) and WebP (78 bytes), both distinct from the PNG. Both old objects remained explicitly rejected,
with no variants, converter mapping, public attachment or allowed download.

| Child         | Source record revision        | Converter revision | Original source digest                                             | Successor source digest                                            |
| ------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `bangumi`     | `unversioned` → `unversioned` | `bangumi@3`        | `4d10cbbbadc9c52bab7c02b5656ae7380f515b7b16289cf1fc5a03b989bfc113` | `ed7620e9cd767437062095f7cb0aace01295da3e4fb6996b1eb970eeb9057485` |
| `openlibrary` | `11` → `12`                   | `open-library@3`   | `c9e1369d4a7389de1fb84fbd93932abe9161d29280ed1882e3dde3021d6b72e9` | `a5cc47346ae766685e814cec4cd3af61df0915dcdfbb708aa2468e3e913eda50` |

Actual native object anchors:

| Child         | Subject                                | Rejected media                         | Available successor media              | Bootstrap receipt transaction          |
| ------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- |
| `bangumi`     | `01a18c1c-e25d-734e-b8b7-5868f90518c7` | `01a18c1c-e2e6-76f0-811f-5868724d15a2` | `01a18c1c-eaa1-7251-90bf-58688167c62c` | `01a18c1c-e25c-7420-80f1-a0a76b3cfc5b` |
| `openlibrary` | `01a18c1c-ec89-74f4-a56f-681336541579` | `01a18c1c-ecc3-7487-94f2-68138b3bcfad` | `01a18c1c-f3fa-703e-a06e-6813fbaeb93e` | `01a18c1c-ec88-73c8-bd76-f03bab62c7de` |

Both bootstrap keys end in `333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`, with
exact prefixes `bangumi:424243:` and `openlibrary:/books/OL900000002M:`. Their native receipt partitions are
1414 and 1665 respectively, with command kind `subject.batch_create`. The raw witness retains full principal,
key, response and transaction anchors rather than treating a cached locator as proof of persistence.

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
