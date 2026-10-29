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

Implementation was committed before submitting both managed checks at code
revision `efc2a94c69`:

- Native acceptance: `bf8c1266-33e7-48c2-bf83-5d4bd3ae39fe`, command
  `bun run --cwd services/kernel check test/imports/vndb-statistics-outcomes.test.ts test/imports/vndb-cli-native.test.ts`.
  Log: `.temp/goal/checks/worker-check-2026-10-29T18-43-06.755Z-25b9cf8b.log`.
- Required root typecheck: `54086601-21a1-4f38-bfa6-1421c7e2a89b`, command
  `bun scripts/typecheck.ts`.
  Log: `.temp/goal/checks/worker-check-2026-10-29T18-43-06.563Z-1891e585.log`.

The completion handoff reported each as `exit status running; check failed without
a summary`, while stating all checks had finished. Both supplied logs contain
only admission queue/load messages, with no child suite output, terminal exit
status, pass/fail count, typecheck diagnostic or first reached assertion.
Admission waiting itself is queued work, not a test failure. The concrete tool
blocker is a completion handoff without terminal results; the maintainer required
finishing without another wait, poll or duplicate check submission.

The authorized retry against committed revision `aae205b053` produced terminal
results. Native check `fc7e0670-d77d-4c60-a1bd-1e92d0997eb4` and root typecheck
`b3cc79ff-07fb-4d41-9a33-1abf7ea54a07` both exited 1. The first diagnostic was
`test/imports/vndb-cli-native.test.ts(230,49): error TS2769: No overload matches this call.`
The expected source literal widened to string. Root typecheck also found the
kernel test's unavailable package alias and required archive progress callback.
These are binding defects, before any child/native outcome assertion. The fixes
retain the source literal type, use the existing relative conversion type import,
and supply the required callback without inventing byte/growth observations.
No assertion, source bytes, runtime policy or production path changed.

Retry logs are `.temp/goal/checks/worker-check-2026-10-29T20-39-33.185Z-1e181978.log`
and `.temp/goal/checks/worker-check-2026-10-29T20-39-48.939Z-6da7bc30.log`.

No native pass, reached product failure, receipt/state observation or root
typecheck result is claimed. The source inspection pins catalogue version 1.0.0,
converter `vndb@7`, source date 2026-10-25 and synthetic native entry revision 7;
runtime bundle digest and actual native receipt/event/transaction evidence remain
unobserved until the queued native caller executes. Its intended output records
those values, without treating them as already observed.

An independent authorization/disclosure/rights review found no blocking defect in
the binding. It confirmed the expected PUT retry-policy mismatch and clarified
that the baseline port aliases a maintained generation pointer, not a content hash.

Inspection identified that `createImportFetch.mayRetry` admits GET/HEAD and keyed
POST, and returns false for PUT. The binding leaves this existing retry policy
unchanged so the native lost-response assertion can expose the actual outcome.

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
No external reference implementation was needed or used. No files outside the
declared paths changed. No all-VNDB, all-source, discovery, privacy, metadata,
fourteen-case table binding, native growth or main promotion claim follows.
