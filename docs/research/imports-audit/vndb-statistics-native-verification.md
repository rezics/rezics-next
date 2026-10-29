# VNDB native archive statistic verification

The binding consumes the existing explicit `sourceStatistics: 'vndb'` runtime and
`identitySupport.issue` / `setStatisticGrant` exports. It owns only its archive table
store, ordinary Importer/transport and journal. The CLI case provisions an actual
account key through stage/approve/apply, stores the private JWK with mode 0600 on
tmpfs, and calls `runImportCli` with `--source vndb --dump -` and ordinary account,
client, Auth, API and durable-state arguments. No shared helper or production code
is changed.

The portable wrapper launches the unchanged suite on the current pinned Bun,
inherits the native kernel environment/preloads, drains both output pipes and
requires exactly six passes, zero failures, no skips/todos and exit zero. The six
frozen names are:

1. pinned COPY reaches seven-scope Auth, real Access, public bulk identity and statistic PUT/current GET
2. reimport and reopen are no-ops; changed native average updates once without native votes
3. lost committed response retries original bytes and idempotency identity with one effect
4. zero votes invent neither statistic nor native votes
5. reduced real Auth scope denies before persistence; revoked grant denies original-bearer receipt replay
6. source acquisition and mass disappearance failure send no statistic and preserve baseline

Frozen suite SHA256: `f428084304fd2fc993e503632431c279c0bfcd92826b46134e39a9fb911628a1`.
Frozen port SHA256: `c188105feafad041f4ff5a257434a8955319c7e7cedb34d6bfd7257ee30b5756`.
All six names, assertions and fixture files remain unchanged.

## Observations and decisions

Both callers use the pinned real-shaped synthetic COPY headers and rows. Synthetic
changes set v123's count to 20 and average to 735, then 810, retaining entry revision 7. The source date is 2026-10-25; converter revision is `vndb@7`. The CLI logs the
actual bundled catalogue version/digest with its native evidence. Source metadata
retains database ODbL-1.0, contents LicenseRef-DbCL-1.0 and VNDB attribution;
statistic licence/attribution is separate from native votes and future SourceRecord
metadata catch-up. No description/image licence is inferred.

`sourceRecords` records actual `VndbTablesStore.page` leaves. Source baseline
`fingerprint` denotes RunStore's maintained complete-generation pointer; `records`
is its maintained present count. It is neither a fixture label nor a statistic
transaction. The same SQLite path survives close/reopen. SQLite/fsync data lives
under `os.tmpdir()`, and the CLI private key lives on tmpfs; only runtime logs use
the repository scratch directory.

The HTTP boundary captures exact request bytes, method, path, bearer and structured
idempotency header, followed by the real response/status. It resolves v123 only
from a successful public create-or-resolve result. A lost response is thrown only
after capturing the committed real response and querying its exact receipt.
Replay retains the captured Request and original bearer. Denials never look up or
return a successful receipt. Anonymous current GET is an actual public request.

Independent read-only SQL uses exact imported subject/source/route anchors,
account/composite receipt identities and each committed receipt position for
historical changed-event IDs. Current statistic transactions come from storage;
DTOs are reconstructed from storage columns, never the PUT body. Before subject
resolution, empty native observations are empty, without invented effect proof.

## Verification state

The tested implementation revision is `329400add0`. Both managed checks returned
terminal results; no checks remain pending:

- Native acceptance `4c8e4de6-b32d-48af-bd67-2361e322247f`: exit 1.
  Command: `bun run --cwd services/kernel check test/imports/vndb-statistics-outcomes.test.ts test/imports/vndb-cli-native.test.ts`.
  Log: `.temp/goal/checks/worker-check-2026-10-29T21-53-06.635Z-d9e18c06.log`.
- Root typecheck `63e5d497-4506-46d5-a45d-f8fae1a4cf5a`: exit 0, all 13 workspaces.
  Command: `bun scripts/typecheck.ts`.
  Log: `.temp/goal/checks/worker-check-2026-10-29T21-53-06.840Z-d3003901.log`.

The wrapper and its unchanged child both used Bun
`v1.4.4-canary.1 (a0cc096ce)`. Child output reports `4 pass`, `2 fail`,
`67 expect() calls`, six tests, exit 1; no skip/todo is reported. The full six
names above correspond to pass, fail, fail, pass, pass, pass respectively. The
wrapper correctly fails its child-exit assertion (`Expected: 0`, `Received: 1`);
it does not count these four passes as delivery. Both declared native files fail.
Earlier compilation errors in source-literal typing, conversion type import and
required archive progress callback were corrected before this tested revision.

The first top-level assertion is the CLI invocation's exit-code assertion at
`services/kernel/test/imports/vndb-cli-native.test.ts:185`, called by the changed
mean/lost-ACK invocation at line 246. It received code 1 instead of 0, with:

```text
Import failed; durable state is retained for resume.
new=0 changed=0 unchanged=1 vanished=0 skipped=0
```

Initial CLI publication and its unchanged close/reopen assertions had already
passed: actual seven-scope account-key Auth, bulk identity, one statistic PUT,
anonymous GET, exact stored DTO, one anchored event/receipt, zero native votes,
two-record maintained baseline and unchanged bulk receipts. The later CLI
revocation assertions and final evidence logger were not reached. Consequently
the runtime bundle digest and final CLI aggregate counters were not printed;
source inspection pins catalogue version 1.0.0, converter `vndb@7`, source date
2026-10-25 and synthetic native entry revision 7. No runtime digest is invented.

The first child failure is at `specs/imports-vndb-statistics.test.ts:171`, before
its committed-outcome assertion at line 172: changed mean 8.1 at unchanged entry
revision produces `bulk-failed` / `Durable operations remain unresolved`.
The capture records exactly one PUT with real status 200 and returned mean 8.1,
count 20, source date/licence/attribution intact, and a persisted receipt:

```json
{"partition_no":1210,"principal_kind":"account","principal_id":"764ada75-62ac-8c41-a37c-58058c0cfe2a","command_kind":"rating.source_statistic.write","idempotency_key":"vndb:v123:d677da99d170a365b64452e4872ca72bcd3f46a0ba1878d157fcaf7c6bb788fd"}
```

The ordinary Importer's empty-plan branch at
`services/importer/src/importer.ts:688-694` rejects a conversion with retained
proposals and no other final plan, despite the preceding statistic write. This
is the source-inspection explanation consistent with the capture; the Importer
catches the inner exception, so the native log does not expose its inner stack.
The changed case's subsequent transaction/event/baseline assertions were not
reached and are not claimed.

The second child failure is at `specs/imports-vndb-statistics.test.ts:192`, before
its committed-outcome and retry-count assertions at lines 193-195. The boundary
captured one actual status-200 statistic response with mean 7.35 and marked
`responseLost: true` only after finding the persisted receipt:

```json
{"partition_no":3920,"principal_kind":"account","principal_id":"764ada75-62ac-8c41-a37c-44288c0cfe2a","command_kind":"rating.source_statistic.write","idempotency_key":"vndb:v123:c31277a492cb1976a61d6382473dfdb48d29a5dd8a41b9d3af1c5deabe330c57"}
```

No second PUT occurred; the run returned the same unresolved-work diagnostic.
`services/importer/src/import-fetch.ts:45-47` admits GET/HEAD and keyed POST for
retry and rejects PUT. This is incompatible with the frozen committed-response
loss requirement, while this binding contract expressly forbids changing retry
policy or correcting the production algorithm. No manual retry, fabricated
success, fixture/assertion change or policy relaxation was used.

The four passing frozen cases establish initial native statistic publication,
zero-vote absence, real reduced-scope denial, same-bearer grant-revocation receipt
denial, and acquisition/mass-loss baseline protection within their exact frozen
assertions. The initial case checks real storage, current transaction, one
historical event/receipt and zero native votes. Exact transaction/event IDs are
not printed on its passing path, so this report does not invent them. The changed
and uncertain-ACK requirements remain red. Their production behavior predates
the binding; the missing tests cannot run on a base without this new driver, so
no base-pass or base-fail result is claimed.

An independent authorization/disclosure/rights review found no blocking defect in
the binding. It identified the PUT retry-policy mismatch and clarified that the
baseline port aliases a maintained generation pointer, not a content hash.
The two frozen hashes above were verified unchanged after execution. This final
report records reached native product conflicts, replacing the earlier missing
terminal handoff and compile-only evidence; it does not request another check.

## Cost and limits

### Native observation

- Touches: exact fixture subject/source rows, exact account receipt keys, and outbox
  rows at each captured committed receipt position; native votes at the supplied
  account/target anchor. Historical anchors are retained as captured evidence.
- Bound: supplied fixture subjects and captured successful commands only; no
  unanchored catalogue or history enumeration. Production archive and transport
  budgets are unchanged.
- Growth check: unavailable in this slice. Point-row derivation is not growth
  capture; statistic-bearing fixed-input/unrelated-population native growth is
  future evidence.

The measurement inventories at the adopted revisions were read and reconciled
with current code. They describe source inventories, not native passes. Input
bytes/chunks and requests remain their own units. No SQLite execution/returned-row
counter or PostgreSQL buffer measurement is fabricated. Existing row slack 2/10%,
byte/block slack 4/50%, execution zero, stricter explicit zeroes, raw SQL/binds/EQP,
validators and combined-event assertions remain untouched. Canonical native
PostgreSQL capture and separate PostgreSQL-derived checks remain unchanged.

Read sources: full portable suite/port and statistic contract report; current
API runtime/identity support and native CLI Auth reference; production archive,
VNDB table store, registration, Importer, RunStore, transport/credentials/CLI;
rating routes/statistic SQL, receipt/key/outbox conventions; pinned fixtures,
VNDB rights README and source inventory; both adopted measurement inventories.
No external reference implementation was needed or used. The implementation changes only declared paths. The inherited controller
checkpoint also contains `apps/auth/project.inlang/.lix/README.md` and
`apps/web/project.inlang/.lix/README.md`, generated localization README files;
this implementation did not edit them or any other outside-path file. No all-VNDB, all-source, discovery, privacy, metadata,
fourteen-case table binding, native growth or main promotion claim follows.
