# Ordinary CLI mid-run authority loss and sealed recovery

The frozen [native outcome](../../../services/kernel/test/imports/cli-midrun-authority-resume.test.ts)
is bound by its [caller](../../../services/kernel/test/imports/cli-midrun-authority-resume-fixture.ts).
The missing-caller red is historical evidence; binding alone does not establish a native pass or promotion.

One `openApiRuntime({batchRecords:8,maxFields:64,maxRecordBytes:65536})` owns the application, Auth, Access and
registered worker. The caller consumes the actual `identitySupport`, `openApiObserver` and runtime `mediaBoundary`
exports. A mode 0600 operator JWK is provisioned by Auth's staged/approved/applied credential effects. The CLI
uses ordinary account/client/Auth/API/state arguments. Private key and bearer values never enter evidence.
All SQLite, key and filesystem durability work uses a private tmpfs directory, closed and removed by this caller.

## Connected scenario and decisions

The single child is Bangumi, with seventeen supplied synthetic metadata records. Its initial completed baseline
contains no media. Every record's refreshed title changes; the first record additionally supplies a cover, using
the registered media worker before its changed envelope is admitted. This preserves the initial metadata-only
baseline while exercising real media acquisition and immutable media recovery in the same world.

The first record's actual changed public envelope is forwarded. Other actual outgoing envelopes wait before
`runtime.replay`, retaining the default concurrent executor. Once the first native success is captured and at
least one sibling request is held, only the existing Global bulk grant is revoked. Held requests are released
together to real Access. The successful transaction remains committed; no rollback of earlier authority is
required. Exact native 403 bodies, pending prepared bytes/keys, the completed baseline and handle closure are
observed. The exact successful Request with its original bearer is separately replayed while revoked: no stored
success may be disclosed. Only that grant is restored before a fresh CLI invocation reopens the same state.

Recovery is supplied a distinct successor but must consume zero successor bytes. Original prepared pending
requests are compared with actual resumed-phase HTTP requests in durable keyset order, retaining captured bodies
and keys. Records that had not reached preparation still use the original sealed source projections. A subsequent
invocation admits the distinct successor. Captured effect ordinals prove successor effects follow the old drain.
Seventeen completed digests must change on each generation; native record revisions remain `unversioned` and
converter revisions come from the actual registration (`bangumi@3` at the current source revision).

Independent public editor creation, acceptance and adoption use references retrieved from a native candidate.
The selected statement, acceptance and adoption are observed before and after recovery and successor publication.
Original receipt transactions/responses/xmin, bootstrap/proposal journals and acquired media objects survive.
The already successful record's complete subject/candidate/retraction/revision rows are unchanged by recovery.
Candidate identities across all seventeen subjects must be accounted for by captured successful public responses
or the independent editor, with no repeated candidate identity for distinct proposals.

## Commands and evidence limits

```sh
node_modules/.bin/oxfmt --check services/kernel/test/imports/cli-midrun-authority-resume-fixture.ts services/importer/tests/cli-midrun-authority-resume.test.ts services/importer/README.md docs/research/imports-audit/cli-midrun-authority-resume.md docs/goals/imports.capabilities.md
node_modules/.bin/bun check --no-script -p services/importer/tsconfig.json
bun test services/importer/tests/cli-midrun-authority-resume.test.ts
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-midrun-authority-resume.test.ts
```

The native log and `.temp/goal/cli-midrun-authority-resume/native-evidence.json` retain raw exchanges, pending rows,
receipts, source digests, converter/bundle revisions, selected public objects and registered worker child names/counts.
The managed check receipt identifies the tested commit. Native execution is pending until that receipt exists;
no binding, compiler or local protocol-double result is credited as native acceptance. No production importer
change is inferred merely from the previously missing caller. The importer-local companion only proves exit 4,
non-retry, baseline retention, exact durable replay and later successor admission against a local protocol double.

This caller adds no PG growth series or counters. Existing source/transport/API byte, row, page, envelope and retry
bounds and canonical/derived growth suites are unchanged. Missing native growth evidence for this connection
remains missing. Source acquisition precedes every effect; current tuple fences and ordinary permissions are
retained. There is no new API, Auth policy, permission, serialized executor or transport retry exception.

Read sources: CLI, credentials, Importer, ImportSession, RunStore, RecordBindings, source registry, Bangumi converter,
native API runtime/observer, identity fixture and media boundary, plus existing backpressure/key-rotation/ACK callers
as behavior references. The read-only reference index was inspected. This binding needs no external implementation
or new research; the previously adopted backpressure algorithm is unchanged. The frozen test is unchanged.
