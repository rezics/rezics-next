# VNDB native archive statistic verification

The binding consumes the existing explicit `sourceStatistics: 'vndb'` runtime and
`identitySupport.issue` / `setStatisticGrant` exports. It owns only its archive table
store, ordinary Importer/transport and journal. The CLI case provisions an actual
account key through stage/approve/apply, stores the private JWK with mode 0600 on
tmpfs, and calls `runImportCli` with `--source vndb --dump -` and ordinary account,
client, Auth, API and durable-state arguments. The shared native helpers remain
unchanged. Production repairs are confined to the two reached coordinator/transport
defects described below.

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

The historical pre-repair tested implementation revision is `329400add0`. Both
managed checks returned terminal results:

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
it does not count these four passes as delivery. Both declared native files failed
on that historical revision.
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
{
  "partition_no": 1210,
  "principal_kind": "account",
  "principal_id": "764ada75-62ac-8c41-a37c-58058c0cfe2a",
  "command_kind": "rating.source_statistic.write",
  "idempotency_key": "vndb:v123:d677da99d170a365b64452e4872ca72bcd3f46a0ba1878d157fcaf7c6bb788fd"
}
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
{
  "partition_no": 3920,
  "principal_kind": "account",
  "principal_id": "764ada75-62ac-8c41-a37c-44288c0cfe2a",
  "command_kind": "rating.source_statistic.write",
  "idempotency_key": "vndb:v123:c31277a492cb1976a61d6382473dfdb48d29a5dd8a41b9d3af1c5deabe330c57"
}
```

No second PUT occurred; the run returned the same unresolved-work diagnostic.
At that revision, `services/importer/src/import-fetch.ts:45-47` admitted GET/HEAD
and keyed POST for retry and rejected PUT. This reached conflict justified the
subsequent narrowly authorized production repair. No manual retry, fabricated
success, fixture/assertion change or policy relaxation was used.

The four passing frozen cases establish initial native statistic publication,
zero-vote absence, real reduced-scope denial, same-bearer grant-revocation receipt
denial, and acquisition/mass-loss baseline protection within their exact frozen
assertions. The initial case checks real storage, current transaction, one
historical event/receipt and zero native votes. Exact transaction/event IDs are
not printed on its passing path, so this report does not invent them. The changed
and uncertain-ACK requirements were red at that revision. Their production behavior predates
the binding; the missing tests cannot run on a base without this new driver, so
no base-pass or base-fail result is claimed.

An independent authorization/disclosure/rights review found no blocking defect in
the binding. It identified the PUT retry-policy mismatch and clarified that the
baseline port aliases a maintained generation pointer, not a content hash.
The two frozen hashes above were verified unchanged after that execution.

## Scoped repair and local proof

The coordinator now records successful completion of the actual awaited statistic
write before permitting the statistic-only disposition. It still performs the
bounded current-candidate/proposal comparisons, requires every candidate and
proposal to be retained, and excludes fenced, skipped-cover and deferred-cover
paths from this disposition. No existing semantic candidate, bootstrap journal,
proposal body or server receipt is replaced. The trusted RunStore method requires
a current ready lease, a classified immutable empty plan, a present VNDB source
projection, an existing acknowledgement and no pending keys/deferred cover. It
resolves the actual staged projection through the ordinary acknowledgement and
finalization logic. Existing no-effect reasons retain their previous guards.

Normal bounded HTTP retries now also admit only the exact UUID-subject VNDB
statistic PUT path with the existing validated quoted structured-field key. No
unrelated PUT, missing/malformed key, server policy, retry/deadline/body limit or
coordinator logical-write ceiling changed. The transport retains the exact original
bytes/headers/bearer, subject to its pre-existing explicit 401 renewal rule.
Failure diagnostics summarize method/path/status/loss/receipt and omit raw bearer
tokens; in-memory exact requests remain available to the frozen replay assertions.

Local regressions were committed and run before repair: 7 passed and 4 failed,
reproducing uncommitted same-revision refresh, failed resume and one-send lost ACK.
After repair, the six focused new cases across the existing source-statistics,
import-fetch and import-fetch-growth files passed with 95 assertions on pinned Bun
`v1.4.4-canary.1 (a0cc096ce)`. These cases use actual local Importer/RunStore and
ordinary transport with explicit local HTTP protocol doubles; they claim no native
Auth, server receipt or event proof. They verify committed projection changes,
unchanged semantic journals, reopened no-op, unchanged baseline on denial or
exhausted acknowledgement loss, original-key recovery, stale/terminal completion
rejection, exact retry bytes/headers, invalid route/key refusal and the existing
three-attempt/two-wait physical default. Counted supplied bytes remain a byte unit.

Edited-file formatting passed. The direct pinned importer compiler passed all 136
files. A broader local two-file run also exposed an existing Retry-After exact-wall-
clock assertion receiving 1999 instead of 2000; it was left unchanged. The final
focused run selected the six new regressions rather than changing that assertion.
The system Bun initially resolved a compiler command to the root gate; that own
invocation was interrupted while queued, before a slot was admitted. The pinned
compiler was then invoked directly. No broad gate result is claimed, and the
historical all-13-workspace typecheck is not evidence for this repair.

An independent read-only authorization/disclosure/rights review of
`d3f3667db7..f23f236dd7` found no blocking findings. It checked the confirmed-write
and exhaustive-retention gates, current lease and immutable/pending/deferred guards,
exact route/key admission under unchanged budgets, and redacted failure diagnostics.
The reviewer ran no tests; native behavior remained a verification limit.

## Final native result

Native acceptance `3641609f-917a-40df-b98e-c5f3603a4311` was submitted once at
`b231910991`, after the local preflight, for only the two declared files. It
returned exit 0, with no load reruns or skipped/todo cases. Log:
`.temp/goal/checks/worker-check-2026-10-29T23-11-29.679Z-2ad1fc71.log`.
Only review/evidence documentation changed after the tested implementation.

The command was:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/vndb-statistics-outcomes.test.ts test/imports/vndb-cli-native.test.ts
```

Actual child output, on the same pinned Bun
`v1.4.4-canary.1 (a0cc096ce)` as the wrapper:

```text
(pass) pinned COPY reaches seven-scope Auth, real Access, public bulk identity and statistic PUT/current GET
(pass) reimport and reopen are no-ops; changed native average updates once without native votes
(pass) lost committed response retries original bytes and idempotency identity with one effect
(pass) zero votes invent neither statistic nor native votes
(pass) reduced real Auth scope denies before persistence; revoked grant denies original-bearer receipt replay
(pass) source acquisition and mass disappearance failure send no statistic and preserve baseline

6 pass
0 fail
91 expect() calls
Ran 6 tests across 1 file.
```

The child exited 0; the wrapper passed its five assertions. The CLI caller passed
one test with 249 assertions. The kernel compiler completed and wrote 804 Reylo
analysis entries. This is the declared two-file native check, not another root
or whole-kernel gate. Both frozen hashes at the start of this report remain exact
and unchanged after this run.

The CLI evidence records bundle version `1.0.0` and actual bundle digest
`sha256:943ceadcf70fe1bd71382c2f88ca782cbf946a2c1c1097d748d273482eb7b318`,
converter `vndb@7`, source entry revision 7 and date 2026-10-25. It consumed three
input passes, 21,504 input bytes and 57 input chunks across initial, unchanged and
synthetically changed mean inputs. Each invocation used actual key signin and
token exchange, all status 200; each requested the unchanged seven VNDB scopes.
The key was mode 0600 on tmpfs. No bearer or private JWK is printed in this report.

Initial publication exposes mean 7.35/count 20 through the real anonymous GET.
Unchanged close/reopen preserves the identity, statistic effect and bulk receipts.
Synthetic mean 8.1 at the same native revision commits once despite the injected
lost response; normal retry assertions compare exact bytes, path, key, bearer and
receipt. Current-grant revocation denies exact original-bearer replay with the
native 403/not_applied problem, no successful receipt disclosure and unchanged
stored observations. The six cases additionally prove genuine reduced-scope
denial and rejected acquisition/mass-loss baseline preservation.

Final independently anchored native CLI observations:

- Maintained baseline: generation pointer `3`, present count 2.
- Native vote rows: 0. Immutable bulk receipt identities: 10, unchanged through refresh.
- Current statistic transaction: `01a189f0-b460-70db-9b2b-15047ea2a2fc`.
- Historical statistic changed events: `01a189f0-b1b7-7499-8d0e-ca615d5f9260`
  and `01a189f0-b461-76e2-9b3e-5385bb124c82`.
- Two historical composite statistic receipts, both with partition `1258`,
  principal kind `account`, principal ID `764ada75-62ac-8c41-a37c-c3298c0cfe2a`
  and command kind `rating.source_statistic.write`. Exact idempotency keys:
  `vndb:v123:c31277a492cb1976a61d6382473dfdb48d29a5dd8a41b9d3af1c5deabe330c57`
  and `vndb:v123:94c97545c91493ae3a1e3f88f859dbdebfa36678945d89b8a9c2c9bfd379ff1a`.

These identities are read from actual receipt/outbox/statistic rows using captured
command anchors. They are distinct from the native entry revision and the local
completed-generation pointer. The scalar/own-reference/rights/erasure/CPU changes
already present in the assigned checkout were retained. No production/shared
helper outside the declared paths was edited by this repair. Broad regression
and promoted-revision checks remain the landing batch's responsibility.

## Landing retry verification

The declared acceptance was rerun once on `a0589d4aefeec1605047e872db25b8b9dd9e0321`
without another implementation change. Check `54c1ce5a-5a7d-4e2d-b7b5-9cb3d0f52e8b`
exited 0. Its log is
`.temp/goal/checks/worker-check-2026-10-29T23-23-20.424Z-6d604724.log`.
The same check was retained through admission waiting; no duplicate submission or
load rerun occurred. The six frozen names above all passed: six child tests,
91 assertions, zero failures and child exit 0. The wrapper passed five assertions;
the CLI test passed 249 assertions. Both frozen SHA256 values remain exact.

Before submission, edited-file formatting passed, the direct importer compiler
passed 136 files, and the six focused local regressions passed with 95 assertions
and 22 unrelated tests filtered out. No root typecheck or broader regression run
was submitted for this retry.

The native log also reports `src/commerce/stripe.ts(101,41): error TS2379` for
passing `signal: AbortSignal | undefined` to an exact optional `signal?: AbortSignal`.
An isolated direct compiler invocation exits 2 with that diagnostic:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes \
  --noUncheckedIndexedAccess --module preserve --moduleResolution bundler \
  --target esnext --allowImportingTsExtensions --skipLibCheck --types bun \
  services/kernel/src/commerce/stripe.ts
```

The Stripe
caller, transport, model, settlement and compiler configurations are byte-identical
to the assigned base `6ecc2fa97ca029f24c58119616ee8ca0dc02f50f`; none was edited
by this implementation. This is the base-owned diagnostic reported by the landing
retry, distinct from the successful native tests and wrapper exit status. No clean
kernel typecheck or successful derived-file regeneration is claimed. The passing
declared acceptance is reported with this limitation, as required for a base-owned
failure; no Stripe production repair or outside-path edit was made.

The rerun used the same pinned Bun `v1.4.4-canary.1 (a0cc096ce)`, bundle version
`1.0.0`, digest
`sha256:943ceadcf70fe1bd71382c2f88ca782cbf946a2c1c1097d748d273482eb7b318`,
converter `vndb@7`, native entry revision 7 and source date 2026-10-25. The actual
CLI observations again record three archive passes, 21,504 bytes, 57 chunks, six
successful Auth exchanges, maintained baseline generation `3` with two records,
zero native vote rows and ten unchanged bulk receipt identities. This rerun's
independent native anchors are:

- Current statistic transaction: `01a18a12-5ef1-7463-94a1-7596802c5ced`.
- Historical statistic events: `01a18a12-5c9b-748d-9ac0-de054cd762cc` and
  `01a18a12-5ef2-7499-bb3d-460bec86a2e2`.
- Two composite statistic receipts at partition `2457`, principal kind `account`,
  principal ID `764ada75-62ac-8c41-a37c-7c868c0cfe2a` and command kind
  `rating.source_statistic.write`, retaining the two exact idempotency keys recorded
  above. These are this run's captured receipt anchors, not fixture labels or PUT
  body mirrors.

The same receipt/journal and native-growth limits below apply. Broad regression
and landing compiler ownership remain separate from this passing two-file proof.

## Cost and limits

### Statistic-only completion and retry

- Touches: existing bounded current-candidate comparisons for one source record,
  exact run/generation/acknowledgement keys and bounded physical sends of the same
  authorized statistic request.
- Bound: existing 300-candidate cap, fixed indexed RunStore point reads/writes and
  O((1+q) log R) work at existing q caps. Retry admission uses bounded URL/key bytes;
  physical attempts, waits, deadlines and eight logical-write ceilings are unchanged.
- Growth check: exact existing bounds and raw plan proofs are retained. Focused
  local outcomes and native acceptance do not establish a new statistic-bearing
  native growth series.

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
