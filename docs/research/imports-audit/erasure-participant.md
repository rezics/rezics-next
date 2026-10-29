# Imports erasure participant audit

The importer has no account-owned persisted payload in the reviewed storage.
Its SQLite `RecordBindings`, `RunStore`, `RecordStore`, and `ImportSession`
schemas are keyed by source, external record key, run, or process ownership;
they contain no platform account owner or account locator. Stored candidate
and media identifiers, source projections, exact command and acknowledgement
bytes, receipts, counts, and generation state support source reconciliation.
The automated account key is an operator-managed file, while bearer
credentials remain in memory. Source input and operator configuration are
external to application storage.

The account key used for API authentication does not make importer state
personal payload for that account. An imports erasure effect therefore
acknowledges `none` through the Access coordinator after receiving the actual
account tombstone event. It neither reads nor mutates importer SQLite and does
not restore the deleted initiator. The participant is a server kernel work
module; the importer CLI has no PostgreSQL dependency, privileged write,
deletion hook, or access to operator files.

This disposition covers only importer-owned state. Author, editor, uploader,
delegate, operator and acting-human evidence, and copies in receipts, outbox,
media, search, catalogue and other shared stores remain with their owning
participants. Their cleanup is not claimed by imports. If an importer-owned
personal field or shared copy is introduced, its producer must add an indexed
native ownership relation or atomically recorded exact locator and bounded
minimizer before release. No broad JSON/name scan or central ownership graph
is permitted.

The effect performs fixed event validation and one coordinator acknowledgement
transaction. It performs no domain scan or purge. Its growth bound is the
coordinator's indexed point acknowledgement for the `imports` participant
within the 11-entry version-1 participant set; see
`services/kernel/test/access/growth-erasure-coordinator.test.ts`, test
`erasure acknowledgement (first) stays constant as accounts and completed
erasures grow at three scales`. Imports adds no local counters or benchmark.

## Integrated admission and proof design

Inspected integrated base `2b7b7785da3c5225a44a2fb43899dcd8ff2b2956` on 2026-10-30. The delivered
`importsWorkModule`, exactly-once default registration, existing positive native test and isolated child are
present. The original positive case already signs in through fresh Auth, approves and executes deletion,
observes the committed tombstone and starts the real worker with only the imports module. Those proofs are
reused. Its purported replay was a second ACK SELECT, and its Access/Auth pending expectations could reject
legitimate concurrent acknowledgements. Those are the only business-expectation corrections.

Read the native account fixture, deletion helper, `events/effects.ts`, `events/log.ts`, `work/client.ts`,
`work/registry.ts`, `worker.ts`, imports adapter and default modules before changing the acceptance.
`startWorker` exposes only stop, while its existing relay receives the actual registered `effects.enqueue`.
The isolated fixture child intercepts only that relay-factory boundary with Bun's module mock, forwarding the
production relay and enqueue unchanged. It retains just the native envelope containing the target account's
tombstone; it neither reconstructs CloudEvent fields nor calls the effect body or ACK directly. The same
registered enqueue is exposed to one bounded redelivery request after the initial observation. No production
port, helper builder, SDK clone, second registration or additional executor is introduced.

First delivery still uses `startWorker([importsWorkModule])`, the production relay, registered DBOS effect and
its own coordinator transaction. After the relay reaches the head, the acceptance separately awaits the actual
DBOS result and requires terminal SUCCESS; a checkpoint alone is not success. It checks actual workflow inputs
against the retained envelope/event sequence, deterministic `fx:epoch:partition:position:eventSeq:imports_erasure`
identity and exactly one persisted `effect.run` step. After the actual none ACK it redelivers that same envelope
through the retained enqueue, awaits the native result again and compares full workflow status, step records,
envelope and identity. Exactly one full ACK row (`to_jsonb(a)`, including retained values) plus xmin must remain
unchanged. No checkpoint/status reset or DBOS row manipulation is used.

All eleven owners' actual coordinator observations are recorded before and after replay. Imports must be pending
before its worker starts and none afterwards. If any actual owner is pending, completedAt must be null. No other
owner's result is manufactured, written, or attributed to imports; concurrent owner acknowledgements are allowed.
No assertion treats suspended credentials as valid or restores the deleted actor.

## Current storage and roles

Reinspected schema definitions in `services/importer/src/record-bindings.ts`, `run-store.ts`, `record-store.ts`,
`import-session.ts` and `vndb-tables.ts`, and the README credentials policy. Bindings use source/external-record
keys; run generations, entries, members, acknowledgements, commands, payloads and envelopes use source/run/record
keys. RecordStore keeps source-key revision/digest/converter/state. ImportSession owns a per-source process
identity/capability. VNDB rows/spool/runs are acquisition/source keyed. Candidate/media IDs, source projections,
command bytes, receipts and generation state support source reconciliation. No platform-account ownership
relation or applicable account-owned payload appeared. Operator key files and in-memory bearers remain distinct
from those persisted records. This inventory supports none for imports; other stores retain their own role and
copy obligations described above.

## Measurement inventory reconciliation

Read both integrated reports at `472aa311ffe270eca9f01f7d7bf633281c76f14d` and
`14659f678751fc153ab67752628b9d9efc32c15d`; their current files are byte-identical to those Git objects.
Their existing README adoption is reused: named SQLite executions/returned rows, input bytes/chunks, requests,
retained bytes, raw SQL/binds/EQP/validators, physical populations and independent payload axes remain explicit.
Old row-like slack 2/10%, byte/block-like slack 4/50%, execution zero and counted defaults zero remain explicit,
including stricter explicit-zero checks. Native PostgreSQL capture and separate appended-row/calls-plus-plans
assertions remain distinct. Existing exact statement/page/byte formulas and source policies are unchanged.
Counted client sends remain distinct from semantic server capture and width-only/short-series limitations.

Current VNDB grouping still preserves id, olang, c_votecount and c_average. No complete portable fourteen-case
binding is supplied: its baseline/committed-acquisition and row-lifetime/execution observation producers remain
missing. The separate six-case native source-statistic binding is not replaced by local conversion evidence.
No frozen statistic oracle, storage producer or binding changes follow from these inventories. The duplicate
new Cost table is removed; the single imports erasure subsection retains exactly Touches/Bound/Growth check
bullets and the eleven-participant point-ACK bound with its existing named native growth reference.

## Verification and preserved bytes

At current admission the integrated acceptance and isolated child already supply registered enqueue redelivery,
DBOS identity/terminal/step observations, full ACK/xmin comparison and truthful other-owner observations.
Those proofs are reused. The native outbox observation is additionally tied to the delivered event's actual ID,
epoch, position and event sequence directly from the committed row; no event fields are reconstructed for replay.
Storage schemas and VNDB grouping were rechecked against the inventories; no new account-owned importer payload
or portable-table producer was found. The README adoption and its exact bounds remain unchanged.

The meaningful acceptance amendments were committed before submission. Terminal verification:

- `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/erasure-participant.test.ts`
  passed on the formatted acceptance revision `69642e6def`: 1 pass, 0 fail, 47 assertions, no load rerun.
  Evidence: `.temp/goal/checks/worker-check-2026-10-29T20-38-36.157Z-756f7dc5.log`.
- `bun scripts/worker-check.ts -- bun run --cwd services/kernel typecheck` passed, including construction.
  Evidence: `.temp/goal/checks/worker-check-2026-10-29T18-36-18.084Z-38e75f8f.log`.
  Subsequent test/child changes were formatting only; this passed check was not repeated.

The first focused submission stopped at formatting before native execution. Formatting was repaired and committed
without changing assertions or runtime behavior before the successful focused submission. Earlier internal-runner
submission errors supplied no native evidence and are superseded by these public-interface terminal results.

The native case reached genuine fresh Auth signin/approve/execute, the committed tombstone, production registered
worker/relay/effect delivery and the imports `none` acknowledgement. The same observed envelope was redelivered
through the registered enqueue. Both native DBOS results were terminal SUCCESS with identical workflow identity,
inputs and persisted step records; the single full ACK and xmin remained unchanged. All ten other participants
were actually pending in both observations, with empty retained arrays and completedAt null. These are observed
outcomes, not manufactured expectations: the acceptance also allows concurrent acknowledgements by those owners.
This proves the scoped participant delivery and replay case, not other-owner cleanup, integration or promotion.

Only declared files change, with no production API, frozen assertion or unrelated default edits. No reference
project is named for this surface or needed. The full committed diff is the reviewable patch. The predecessor's
live worker is neither restarted nor edited.

The following SHA-256 inventory preserves the original admission values and current final bytes. Production
runtime/default registration, native support and frozen files remain unchanged. Only the permitted acceptance
and isolated child differ from original admission.

| Path                                                             | Admission SHA-256                                                  | Final SHA-256                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `services/kernel/src/worker.ts`                                  | `d0d22175231ed96e618a9d10811383c47bcc0008fc0a6b2c17c574105e1617c8` | `d0d22175231ed96e618a9d10811383c47bcc0008fc0a6b2c17c574105e1617c8` |
| `services/kernel/src/events/effects.ts`                          | `d76acdf3d45f937dbde46a36afb38bc39365d551cdb8a02d73db4ad9843a8ee8` | `d76acdf3d45f937dbde46a36afb38bc39365d551cdb8a02d73db4ad9843a8ee8` |
| `services/kernel/src/work/registry.ts`                           | `ef32ccddcd991cd9c17965ac823eb46445b86d312c8485416128c7f4050a5f2b` | `ef32ccddcd991cd9c17965ac823eb46445b86d312c8485416128c7f4050a5f2b` |
| `services/kernel/src/work/client.ts`                             | `62acfad2c4c811f55b34e49aa76b72e6e0a5c4d7fd2b9129392b8c876b55d04d` | `62acfad2c4c811f55b34e49aa76b72e6e0a5c4d7fd2b9129392b8c876b55d04d` |
| `services/kernel/src/work/modules.ts`                            | `97f1507626e687162128144141cb5c85e9c99ac0f64899da9100bcb899d2accb` | `97f1507626e687162128144141cb5c85e9c99ac0f64899da9100bcb899d2accb` |
| `services/kernel/src/imports/erasure.ts`                         | `48de6c92146a0068f226fa6ab49e62730794c7527193b15df0a7ae832d569ad6` | `48de6c92146a0068f226fa6ab49e62730794c7527193b15df0a7ae832d569ad6` |
| `services/kernel/test/imports/erasure-participant.test.ts`       | `1c020cbd57c6032406a5a88f5818a995b388a79a2461d445b2a34e571242f32e` | `5b710f57e26200f94e12436556a06a02c7b6418a28c55a54ef4302fa3102c240` |
| `services/kernel/test/imports/erasure-participant-worker.ts`     | `69c5136fb701fb7a6592109c950e063afe60daa83a29ae899d325c28dbc190f0` | `bd47ab904dd0d6543eb749355e5466ab8f5fcdf32807ec823849752fd7d2c076` |
| `services/kernel/test/support/account-deletion.ts`               | `130834b8dfb8a1a55b0dafae4cde8e1b1b732155451c27c80ddac0e4db6c3dad` | `130834b8dfb8a1a55b0dafae4cde8e1b1b732155451c27c80ddac0e4db6c3dad` |
| `services/kernel/test/access/native-account-bindings-fixture.ts` | `43d4649bb7509cc8a415f6b862348e7e329893a3eb0317abfd46a2d512490c76` | `43d4649bb7509cc8a415f6b862348e7e329893a3eb0317abfd46a2d512490c76` |
| `specs/erasure-operation-driver.ts`                              | `c1e9cb6d68919ae1eb9e2be062ad09c2c8f8b6769530ba5831dafd5941671f24` | `c1e9cb6d68919ae1eb9e2be062ad09c2c8f8b6769530ba5831dafd5941671f24` |
| `specs/erasure-operation-outcomes.test.ts`                       | `ab2c42cecb62706ac6b4e212b6a3f2a691621f1ed7e93d28ed68c5fd905d3e2c` | `ab2c42cecb62706ac6b4e212b6a3f2a691621f1ed7e93d28ed68c5fd905d3e2c` |
| `specs/terminal-erasure-driver.ts`                               | `7a574e0c9ac50471cbad50fb82d1af3856c0d9016012ec7aed190ed072d13180` | `7a574e0c9ac50471cbad50fb82d1af3856c0d9016012ec7aed190ed072d13180` |
| `specs/terminal-erasure-outcomes.test.ts`                        | `1d398bd9119e0e31c632daaffb427d44c3ae8f77f8454ee4d6c0a0025b35d0e7` | `1d398bd9119e0e31c632daaffb427d44c3ae8f77f8454ee4d6c0a0025b35d0e7` |
| `specs/imports-vndb-tables-driver.ts`                            | `8bbb39e5f2482bd703f1fa1abb97a6426218902b46b4e3ba9e93a42cf852e11f` | `8bbb39e5f2482bd703f1fa1abb97a6426218902b46b4e3ba9e93a42cf852e11f` |
| `specs/imports-vndb-tables.test.ts`                              | `97d91eecee9860906c474eb9955253cffe6a04523cb72e5d6c07c48dfd3e98a6` | `97d91eecee9860906c474eb9955253cffe6a04523cb72e5d6c07c48dfd3e98a6` |

## Landing reconciliation

Completed the control-plane-started rebase onto `97a002b5d2` by resolving the README conflict explicitly.
Preserved the current bounded partial-source-reduction Cost subsection and all unrelated current guidance.
Removed only the obsolete erasure Cost table, retaining exactly one erasure subsection with Touches, Bound
and Growth check bullets. The earlier Markdown union had retained the deleted table alongside these bullets;
that landing conflict was not a native acceptance failure.

The acceptance and child are byte-identical to the previously passing formatted proof. Runtime, default
registration, native support and frozen files in the hash inventory remain unchanged on this base. Current
RunStore additionally persists source/record-keyed reference signatures; these contain resolution digests,
not an account ownership relation or new account-owned payload. The `none` rationale remains applicable.
The existing README measurement adoption, source policies and numerical bounds are preserved. No external
reference source or outside-path edit is needed. The affected typecheck already passed; unchanged proof
code requires no repeated typecheck. The focused native acceptance passed on the reconciled base at `d30ef603ef`:
`bun run --cwd services/kernel check test/imports/erasure-participant.test.ts` exited zero with 1 pass,
0 fail and 47 assertions, without a load rerun. Evidence:
`.temp/goal/checks/worker-check-2026-10-29T20-47-39.982Z-09fa8edb.log`.
Both native owner observations again showed imports `none`, all ten other participants pending and
completedAt null. The unchanged acceptance proved actual registered redelivery, identical terminal DBOS
identity/steps and the unchanged full ACK/xmin. No check remains live. This resolves the scoped landing
reconciliation and native acceptance; integration and promotion remain separate.
