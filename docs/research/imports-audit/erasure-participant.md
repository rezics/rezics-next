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

## Admission and evidence boundary

Inspected checkout base `0378f4bb1c` on 2026-10-30. The required predecessor is absent from this checkout:
`services/kernel/src/imports/erasure.ts`, `test/imports/erasure-participant.test.ts` and
`test/imports/erasure-participant-worker.ts` (the latter paths relative to `services/kernel`) do not exist.
`src/work/modules.ts` registers no imports module. The coordinator lists imports among its eleven version-1
participants, but that list does not install a participant implementation.

The historical candidate `6790a14e548f8379772ede78e4382e9c3c69b167` was read through Git objects only.
Its native test SHA-256 is `bc7b37a5fb7c745da676b36f4800b90c14db26d2cef3e32798fe557d8f484f17`;
its child SHA-256 is `69c5136fb701fb7a6592109c950e063afe60daa83a29ae899d325c28dbc190f0`.
Those are historical bytes, not integrated files or passing evidence. Its adapter calls the coordinator with
`none`, and its positive case uses fresh native Auth deletion and an isolated worker. Its second ACK SELECT
provides no redelivery proof, and its hardcoded Access/Auth pending assertions do not preserve concurrent owners'
actual outcomes. No historical candidate files were installed, rewritten or executed here.

The assignment requires reusing the integrated positive case and delivered production adapter while prohibiting
runtime/source/default-registration changes. Rebuilding that missing predecessor or inventing a second suite
would cross that boundary. Resume acceptance reconciliation on a base containing the delivered adapter, default
registration and existing native case/child. This is an admission conflict, not an observed native test failure.

No worker was started, stopped, restarted or edited. No acceptance or typecheck was started: the required existing
native file and its production dependency are absent; the committed changes are documentation only. No participant
cleanup, integration, replay, native/API/growth success or promotion is claimed.

## Current storage and role inventory

Read current `services/importer/src/record-bindings.ts`, `run-store.ts`, `record-store.ts`, `import-session.ts`,
`vndb-tables.ts` and the credentials documentation. Binding records/groups/journals/candidates/media use source
and external record keys. Run sources/generations/entries/members/acknowledged/commands/payloads/envelopes use
source, run, record and command keys. RecordStore keeps source-key revision/digest/converter/state and source
counts. ImportSession's owner is a process identity/capability per source, not a platform account. VNDB runs,
rows and spool are acquisition/source keyed. Candidate/media identifiers, source projections, immutable command
bytes, actual receipts and generation state support source reconciliation. No account-owned importer payload or
platform-account ownership locator appeared in these schemas.

The automated account's private key is an operator-managed file; bearers remain in memory. Source input and
operator configuration are external to application storage. API authentication with that account does not make
source-reconciliation state personal payload for it. This supports the required `none` rationale, not a claim that
an installed participant has acknowledged it. Author, editor, uploader, delegate, operator and acting-human
evidence and copies in shared receipts, outbox, media, search and catalogue remain with their owning participants.
An importer-owned personal field would require its producer to add an indexed ownership relation or atomically
recorded exact locator and bounded minimizer before retaining `none`; broad JSON/name scans are not substitutes.

The required disposition performs fixed tombstone validation and one coordinator acknowledgement transaction,
without importer SQLite access. Its bound is the indexed point ACK within eleven version-1 participants, covered
by `services/kernel/test/access/growth-erasure-coordinator.test.ts`,
`erasure acknowledgement (first) stays constant as accounts and completed erasures grow at three scales`.
This is an existing named bound, not a new benchmark or newly observed execution.

## Replay interface inspection and remaining proof

Read current `src/events/effects.ts`, `src/work/client.ts`, `src/work/registry.ts` and `src/worker.ts` under
`services/kernel`. `composeWork` registers effects once and returns `effects.enqueue`. That enqueue derives
`fx:epoch:partition:position:eventSeq:name` from the supplied native envelope and calls the registered DBOS
workflow with return-existing reuse policy. `startWorker` retains this registered enqueue internally and exposes
only `stop`. `createWorkClient` is an existing external DBOS client, not another executor. No missing public API
has been established: the more immediate missing dependency is the imports module and native fixture-child in
this base. No production helper, SDK clone or second executor was added.

Once that dependency is present, first delivery must remain through the registered production worker/effect/relay
and its own transaction. Read the committed envelope rather than reconstructing event fields. Independently
observe actual final imports `none` and the native DBOS terminal result, then redeliver the same envelope through
the existing registered enqueue. Compare exact workflow/effect identity, one full ACK row including retained
values and xmin/version, and native terminal result. Neither relay checkpoint nor dispatch proves completion;
a second SELECT alone proves no replay. Do not reset checkpoints, alter DBOS records or call the ACK/effect
body directly. Observe every other owner's actual outcome without writing it or attributing concurrent ACKs to
imports; if any owner remains pending, completion must remain null. Preserve own pending-before-delivery,
none-after-delivery, deletion, scope and native Auth signin/approve/execute assertions.

## Preserved files and documentation diff

Only this report and `services/importer/README.md` change. The README adds the required three-bullet erasure
disposition and adopts the two dated measurement inventories beside Cost. It preserves all existing numerical
bounds and source policies, changing only the obsolete kernel-call title inside the aligned table to the exact
current client-transport test title. No outside-path file changes, frozen assertions or runtime changes occur.
The inventories were read from Git objects at `472aa311ffe270eca9f01f7d7bf633281c76f14d` and
`14659f678751fc153ab67752628b9d9efc32c15d`; they are evidence, not passing executions. Their table-binding gaps
were reconciled against current grouping/storage, which still retains both source-statistic fields. No external
reference project or upstream research was needed. The full change is available as the committed diff.

The following SHA-256 values were captured at admission and verified unchanged after documentation edits.
Paths are relative to the repository root. The absent native participant/child remain absent.

| Path                                                             | Before and after SHA-256                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `services/kernel/src/worker.ts`                                  | `d0d22175231ed96e618a9d10811383c47bcc0008fc0a6b2c17c574105e1617c8` |
| `services/kernel/src/events/effects.ts`                          | `f5e0083f997e04be57e6e4f9fad9983926c3cdb367065eb95570f96983a3e555` |
| `services/kernel/src/work/client.ts`                             | `62acfad2c4c811f55b34e49aa76b72e6e0a5c4d7fd2b9129392b8c876b55d04d` |
| `services/kernel/src/work/registry.ts`                           | `bfef93f3e0d29b642b0cacbd80a9aee644e08155de0a7df56cebc4040ccf0986` |
| `services/kernel/src/work/modules.ts`                            | `766a94319ea837dbbab4dcdd9c2009a23563d91fb856bb87324710fec83505ae` |
| `services/kernel/test/support/account-deletion.ts`               | `130834b8dfb8a1a55b0dafae4cde8e1b1b732155451c27c80ddac0e4db6c3dad` |
| `services/kernel/test/access/native-account-bindings-fixture.ts` | `43d4649bb7509cc8a415f6b862348e7e329893a3eb0317abfd46a2d512490c76` |
| `specs/imports-vndb-tables-driver.ts`                            | `d1d12e1e5417ba96279726c25739854141f2d18990e0029619afc3570234b5ec` |
| `specs/imports-vndb-tables.test.ts`                              | `2db4a61d4612e3a358db9fa4ed1460cbfe8ff6396da0f51fc98b1eefb651ca9f` |
