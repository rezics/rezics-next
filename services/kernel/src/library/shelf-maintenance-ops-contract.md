# Bounded shelf maintenance operations

This is the operational refinement of [shelf-contract.md](shelf-contract.md), Migration, backfill and cutover.
[The ports](shelf-maintenance-ops-contract.ts) specify future native behavior; effectful exports throw.
Only `initialShelfReadiness` and `counterWriteMode` implement pure rules. No migration, runtime guard, counter,
HTTP route, effect registration or composition is implemented here. Adopt the Proposed protocol in
[account-local maintenance](../../../../docs/research/library-shelf-maintenance.md) and the Recommendation and
Transaction and lifecycle implications in [native staging](../../../../docs/research/native-long-value-staging.md).
The research's suggestion that Accounts await consumers is superseded by the adopted asynchronous deletion policy.

## Initial readiness and writer amendments

An absent gate is not an empty owner. In a live owner command, acquire authoritative active `shareAccount` first,
then insert the gate if absent and lock/reload it to serialize initialization. While the new gate is exclusively
held, run three indexed exact-owner `EXISTS ... LIMIT 1` probes over entry, Collection and progress-session inputs.
Probe all Collections, including tombstoned ones; a false positive only schedules safe backfill. These are not
counts, session-history probes, dictionary scans or evidence from a raw low-level fixture. All personal input writers
take this same gate before effects. A first reader uses a short native initialization command before its read snapshot.

If all probes are false, commit open/ready, epoch zero and active nil UUID. Nil here is a complete exact zero
generation, with absent counter rows read as zero. The first writer then targets that generation. If another writer
already inserted an input, initialization observes it, or waits for its gate holder; it cannot publish a false empty.
Two initializers converge on one decision; the loser reloads, never overwrites the winner. Account deletion orders
before gate creation through the account lock. No missing gate can revive a deleted owner.

Any true probe commits open/unready with no complete pointer and a native initial-backfill request and enqueue intent
in the SAME transaction. During this short pending interval ordinary legacy create/update/delete may proceed under
the open gate; they maintain available derived fields but **defer every counter delta**, including Collection deltas.
No increment into partial nil rows, decrement of missing history, clamp, underflow or claim of completeness is allowed.
The later drain includes all committed inputs. Once rebuilding, ordinary writers fail retryably. Shelf page, summary
and facet reads return retryable 503 until complete publication; an unknown exact type is not a successful empty read
before readiness. Authentication/Access checks precede any initialization side effect for a private read.

Required amendments before consumers ship:

| Consumer                                                                 | Exact amendment                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintenance schema/types                                                 | Keep ready/active pointer distinct; add native pending backfill intent, run kind distinguishing field backfill from counter-only work, and bounded run-scoped session/head scratch state. The runnable index must include pending initialization work. Schema `kind=rebuild` may encode the subtype in native run metadata, never infer it from workflow JSON. Epoch/sequence/offset are bigint.                                    |
| `enterShelfWrite`, gate init/share SQL                                   | Replace unconditional readyfalse initialization with serialized three-probe initialization plus atomic work intent. Return readiness with epoch/generation (or expose a same-tx checked equivalent). Open/unready admits input writes and defers counters; rebuilding still refuses ordinary writers. Frozen tests owned elsewhere that assert empty always unready require manager reconciliation before changing those consumers. |
| `createShelfCounters().transition/collection`, both delta SQL statements | Read gate readiness in the same guarded transaction. Return without counter effects when unready. When ready, use only active generation, including nil for a proven empty initial owner. Missing/negative rows in a complete generation remain invariant failures. No nil fallback after rebuild.                                                                                                                                  |
| Summary/facets/date reader service                                       | Check field-readiness and pointer in the same authoritative RR snapshot as rows/counters. Do not trust the request's cached readiness. Counter-only work may retain old complete reads; field backfill may not.                                                                                                                                                                                                                     |

These amend pending interfaces, not their unfinished runtime files. Normal hook callers are entry create/state/delete,
Collection create/delete, session/progress/head/activity, type projection and dictionary reserve/continue. First-use
tests must exercise these real commands and actual Access. A schema fixture alone establishes no ready guarantee.

## Durable start, pages and publication

Initialization requests work even for a cold legacy owner that never writes again. Register a bounded global keyed
recovery sweep of native runnable intents, ordered `(route,account_id,run_id)`, limit100; wrap the cursor after exhaustion
for fairness. A private authorized read can also wake its exact pending owner. Neither mechanism scans accounts.
Recovery does not require an unrelated user command. Initial intent survives process death before enqueue. A crash
before initialization commits publishes neither ready state nor an unready503; retrying the same authorized first read
initializes again. Recovery cannot discover an owner whose request never committed. Duplicate
first reads or starters use the existing owner request; run/build IDs are never reused for a different operation.

Operator requests likewise commit a native request/intent before asynchronous drain, so a rolled-back drain is retried.
The starter takes account share then gate FOR UPDATE, drains shared writers, increments epoch, creates a fresh empty
build generation, sets rebuilding and checkpoints `drain` with runnable intent. A pending initial request can carry the
reserved run ID; drain atomically binds its new epoch. Before drain it must not authorize derived pages. Concurrent
rebuild requests coalesce or fail retryably; they never create competing builds. No account scan occurs at start.

Each native command has a finite 5000ms deadline (shorter caller deadline wins), at most100 source/cleanup rows or100
trie edges, at most100 pages per workflow segment. Keyset cursor: <=8 scalars, <=2048 UTF-8 JSON bytes, including full
unique tie keys; never OFFSET. Counts, epochs and page sequences stay native bigint; JSON uses canonical nonnegative
decimal strings without Number conversion; numeric cursor scalars must be safe integers. Each source phase has its own exhaustion checkpoint. Limits on rows,
statements, transferred bytes and whole-value initialization/publication are separate; page100 alone is no byte bound.
Maintenance segment arguments/results each serialize to <=4096 UTF-8 JSON bytes, independent of population/input size.
This bound excludes initial tombstone effect envelopes and shared history, whose retention is separate evidence.

The bounded phase order is:

1. `session-changes`: seek stored change rows, <=100 at a time; upsert run/session maxima into native scratch. Never
   scan one session's growing history inside a session page. `sessions`: merge stored start/completion/change maxima
   into `last_changed_at`. Preserve actual stored precision. Never invent a missing abandon date or a migration time.
2. `head-inputs`: seek sessions and accumulate run/subject change/completion maxima, including subjects with no entry.
   `heads`: merge these into the real heads in pages. Existing valid maxima survive. Scratch keys include run and owner;
   they cannot mix a cancelled run with a new one. No entry is created by a session/head page.
3. `entries`: keep existing incarnation; for a legacy row without one, freeze its existing last-user transaction ID as
   the baseline incarnation under the fence. This is a legacy-only amendment to the creation-transaction spelling in
   the shelf storage contract: new entries still use their real creation transaction. Do not search unbounded event
   history or claim the baseline is a recovered historical creation command. Fill activity from entry creation/update and
   head maxima, finished from best-known completed state/session evidence per the shelf contract. Preserve user
   revision, creation/update transaction/time and state; do not emit user entry.updated events for metadata repair.
4. `types`: observe current source/one-hop survivor using real semantic Access outside the owner transaction. Release
   source clients before owner checkout. Capture partition, full type and identity together once in the original
   authoritative RR per source. Persist expected entry incarnation/transaction, source binding/initial position stamp,
   `identity` for the resolved source and `originIdentity` for the requested source immutably beside the native
   reservation header. Original and resolved source may share one identity value when equal; otherwise authorize and
   anchor each independently. Continue one long key per bounded page until exact native identity publishes. Revalidate
   metadata and entry CAS before attaching it. Invisible sources retain known type; absent/unavailable evidence never
   invents a type or completes the phase.
5. `count-entries`: seek ALL states with resolved type IDs into the empty build's fixed rollup/state/type keys.
   `count-collections`: seek active Collections into its nil-type rollup. A page touches <=100 source rows and a fixed
   bounded number of counter keys per row in deterministic key order. No whole-account COUNT at validation/cutover.
6. `validate`: require durable exhaustion of every prior phase, no unresolved source/reservation, and bounded checks
   for missing required derived fields. Persist any multi-page validation cursor. `publish`: account share, gate
   FOR UPDATE, exact run/epoch/build and active account revalidation, then pointer/ready/open and checkpoint together.
   `retire-counts`: delete old nonactive/nonbuild generations and scratch in indexed pages. `retire-reservations`:
   delete old-epoch reservations (including full text/bytes) and cancelled source-preparation evidence in bounded pages;
   do not collect their shared trie prefixes or published identities during an ordinary rebuild. `complete` records terminal
   native receipt after cleanup exhaustion. Publication never copies or deletes an account in one transaction.

Counter-only requests require an already ready, field-complete gate; refuse them while initial backfill is pending.
Counter-only rebuild skips all field phases and takes the same drain/epoch/build protocol. Its old COMPLETE generation
can serve until pointer swap because every input writer is blocked. A field backfill must set readyfalse at drain
before ANY entry/head/session/type rewrite; even a previously complete counter pointer cannot make mixed fields safe.
No equivalent field-generation visibility scheme is introduced. Keep reads unavailable until atomic completion of
fields and counts. Readers already holding an RR snapshot see one complete version; old generation cleanup must not
break that snapshot. New writers after publication use only the newly active pointer, never a cached generation.
Post-publication cleanup accepts open mode only for the matching current run/epoch and cannot rewrite fields or active
counts. Keep that run identity until terminal cleanup; a new rebuild request retries until it completes. Ordinary
personal writers remain admitted after publication. Purge may supersede cleanup immediately.

Page effects, sequence/cursor, phase transitions and successor enqueue intent commit atomically with a deterministic
core receipt. Keys encode owner/run/epoch/sequence, not a timestamp; workflow ID additionally includes segment.
The receipt digest binds phase/cursor/build and bounded input identity; retries return the same result before body
effects. Enqueue happens after commit, ack by compare-and-set on the exact intent/sequence after durable enqueue.
Crash before commit rolls everything back; crash after commit/before enqueue is found by recovery; duplicate enqueue
or lost ack replays the same receipt. After100 pages commit the next segment intent, exit and release connections.
The terminal complete phase has no successor enqueue: test its commit/lost-response boundaries instead. No workflow
history is the sole checkpoint. Leases transfer via monotonic attempts/CAS, never reopen the gate. Expiry
fails closed and alerts; explicit authorized recovery preserves native checkpoints or invalidates the old epoch before
starting over. Cleanup cannot delete an active/build generation. No dual writes or catch-up delta invention.

## Derived metadata capability under rebuilding

Normal reserve/stage factories currently enter the ordinary writer guard; that guard MUST continue refusing rebuilding.
Add an internal allocator core shared by `createShelfTypeReserver` and `createShelfTypeStager`, with a private native
maintenance guard closure. `createShelfMaintenanceDerivedPorts` describes that seam; it deliberately throws today.
Only the installed maintenance runner mints `ShelfDerivedPage`, after loading/locking the matching native run and
revalidating currentCommand, live transaction identity, partition/owner, active account share, gate mode, epoch, run
and build generation. Bind provenance using a module-private WeakMap keyed by the capability and live transaction,
as command.ts binds currentCommand/time and request/access.ts binds prepared proofs. Clear it when the callback ends.
An exported TS brand, JSON fields or copied object is never runtime authority. The factory must be in the same private
runner composition boundary; no public mint-by-locator API is permitted.

This scope allows ONLY that run's derived dictionary reservation, edges, terminal/value, source CAS, heads/fields and
build counters for its current phase. It cannot create a personal entry, progress action, Collection or follow. The
allocator receives only dictionary authority. Every continuation rechecks account+epoch/run/build and reservation
source expectation; an old reservation from the open generation is stale and must restart from a fresh observation.
No reopening mode, HTTP `maintenance` flag, serialized caller token, `trustedAccount` personal bypass or deleted-owner
initiator restoration. No source connection/account lock is held across remote observation, DBOS wait or enqueue.

Exact affected consumers: reserve/root/reservation SQL via `createShelfTypeReserver`; stage read/edge/progress/publish
SQL via `createShelfTypeStager`; composed `createShelfTypeKeys`; the new backfill type-page caller; ordinary type
preparation/projection consumers retain normal guarded factories. `ShelfWrite` is not widened into a permission flag.
The maintenance reservation records matching run identity in native metadata (column or owner/run mapping) in addition
to fence_epoch/generation_id. Run identity must not be reconstructed from a user-supplied token.

Keep immutable full text AND `input_bytes bytea STORAGE EXTERNAL`, length captured once from the same validated ASCII
input. Continuation SQL directly slices stored bytea at offset+1 for <=25600bytes, then <=100 edges of <=256bytes.
No repeated conversion, text substring, full-value return or growing prefix scan. Advance offset/node with edges in
the same tx. Final exact text/terminal publication is one separately measured O(input) copy; accepted input remains
within the existing release limit, without a new per-type cap. Purge removes reservation bytes as well as text.

The type phase uses the [preparation identity protocol](type-preparation-contract.md#observation-and-authority).
`TypePreparationIdentity` holds only sourceId, partition, epoch, latest create/identity revision, its recorded
transactionId and current redirect. Before every subsequent owner page, publication and consumption/attachment, use
`semantic/item-identity.readItemIdentityVersion` and `readPartition` on the SAME new RR client for each independently
anchored origin/survivor. The proposed default `library/preparation-source.ts` adapter captures initial full type and
identity with `observePreparationSource`, then uses `observePreparationIdentity` for these metadata-only checks.
No unfinished module is imported or running integration asserted by this contract.

Compare every identity component exactly against immutable native evidence; compare origin and survivor separately.
The semantic type-writer audit ensures every type change creates a create/identity revision, so same source/epoch and
exact revision/transactionId/redirect prove unchanged accepted input. Missing/nonvisible identity, changed identity or
partition epoch, moved/missing ownership or a second redirect requires refresh/cancellation, failing closed. Initial
source positions still order projection observations and bind the native reservation; they are not item versions.
Unrelated writes or position advancement alone never restart/cancel work. Do not call `readItemTypes`, the full observer
or full source equality again per page, publication or attachment. Release every source client before account/gate
admission. Preserve current Access rechecks: metadata is no Access proof, source lock, global lock or authority.

Native creator receipt commitments cover both captured identities. Initial/final native exact-value equality and atomic
publication remain mandatory for collision handling; source metadata is not hash equality. Full type identifiers never
enter DBOS payloads. This protocol adds neither an input cap nor a per-type source lock.

## Cost

### Type source revalidation

- Touches: each independently anchored origin/survivor partition's ownership, indexed identity and redirect points.
- Bound: fixed rows, statements and result bytes per bounded page, independent of source input length and unrelated
  revisions; initial accepted input and final exact native publication remain O(input bytes).
- Growth check: `specs/library-type-metadata-outcomes.test.ts`, “native continuation verifies identity without
  retransferring staged source text”, requires actual repeated-page typeBytes=0 and same-client metadata. The source
  adapter and semantic helper own native statement/byte and population measurements; this is no measurement claim.

## Purge authority, inventory and honest completion

Accounts deletion commits its tombstone/outbox and returns without waiting for Library. Barrier T already denies all
ordinary personal actions. The existing `com.rezics.access.account-tombstoned.v1` durable effect calls the internal
purge producer; verify event identity/source against native tombstone, then account lock followed by gate lock,
increment epoch, cancel old run and set purging/readyfalse with native checkpoint/intent. Clear the active pointer;
no complete private projection survives as readable. Purge pages use a narrow native
tombstone-checking account lock, not the active-only `shareAccount` helper; lock order remains account then gate.
Duplicate effects converge. Cover every
authoritative tombstone path, including no continuation and organization close, through the actual Accounts event
contract. Do not extend the committed-deletion allowlist or revive the deleted person's restored initiator.

Provenance is native event/tombstone plus trusted registered binding. Current `effects.ts` validates registered event
types and starts deterministic envelope-position/event-sequence workflows before relay advancement. It does not make
an arbitrary CloudEvent object a purge capability. The producer must cross-check stored event/tombstone binding.
`command.ts` supplies real core receipts/positions/current live tx. `organization-close-work.ts` supplies the adjacent
checkpoint/page pattern, not Library authority. `command-support.ts`'s active-account trusted runner cannot purge a
deleted owner; add a narrowly bound native purge command path only. No change to account deletion's completion rule.

Purge wins over drain, page and publication. An in-flight bounded page holding account share finishes before deletion;
after T all backfill pages fail the active-account check even before Library consumes the event. Gate epoch/run then
invalidates delayed actors/reservations; no late publication or cleanup may set open. Retained workflows can read
minimal terminal evidence but never recreate private state. Tombstone/terminal gate survive cleanup and account-ID ABA.

Every cleanup phase seeks <=100 indexed rows under the exact owner, independently checkpointed with child-first order:

| Phase                                             | Native inventory and dependencies                                                                                                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cancel-work, bulk-evidence                        | Cancel all owner native preparation/bulk/maintenance work; remove bounded target/effect/input/manifest and scratch pages, including reservation bindings and temporary evidence; keep minimal nonresurrection receipt only. No mass cascade. |
| reservations, type-sources                        | Every generation/run's full text, input bytea/TOAST, offsets, prepared observations and owner source metadata. Shared prefix nodes remain until dictionary phases.                                                                           |
| progress-changes, progress-units, sessions, heads | Seek change/unit children by owner/session or bounded session cursor before parent deletion; both existing FKs require this order. Delete empty retained heads too.                                                                          |
| copies, entries, follows                          | All private owner rows, not only current shelf inputs. Source holder index disappears with entries.                                                                                                                                          |
| collection-members, collections                   | Remove private/unlisted/tombstoned Collections and children/current notes; retain ONLY frozen active-public Collections and their current member notes under adopted deletion policy. No resurrection or private holder directory.           |
| published-logs                                    | Retain only explicitly detached published snapshots allowed by adopted policy; remove private source links/evidence. A live session join is not a detached snapshot.                                                                         |
| counts, type-nodes, type-roots, type-values       | All generations including nil, obsolete and cancelled builds; trie children before parents with bounded indexed dependency order, then mappings. No unbounded recursive delete or hidden cascade.                                            |
| complete                                          | Verify each native phase exhausted under terminal fence, set purged and emit one minimal native-domain terminal receipt. No payload-bearing scratch survives.                                                                                |

If physical FK layout requires a different dictionary dependency order, split the phase into bounded child pages;
never widen its work bound. Child-heavy sessions/Collections retain their parent cursor until child exhaustion.
Purge traces must measure child pages, remote cleanup and reservation bytes separately, not just parent counts.

Public listing withdrawal/freshness is the separate [listing contract](listing-freshness-contract.md): actual durable
public-history producer, monotonic source stamp/version, bounded reverse public-history traversal and source terminal
zero fence are prerequisites. Existing `work.ts` only visits current member subjects and has no historical zero fence;
it cannot prove this cleanup. Frozen retained active-public Collections remain public; private histories need that
separate contract's cleanup, never a new directory of private holders. Cross-domain requests use durable per-page
intent/receipts and release the owner connection before remote commands; no unbounded fanout.

Terminal receipt means Library private native rows exhausted except the explicit retained artifacts and minimal
terminal fence. Shared core receipts/outbox/write-basis, DBOS args/results/history, telemetry and backups remain
separately outstanding retention evidence; `sharedEvidence='separate-contract'` is mandatory, never “account erased”.

## Implementation and executable evidence

Implement each row below in <=400 changed implementation lines / <=8 files; split again when necessary. Depend on
concrete code/DDL ports, not research reports or other workers' unfinished runtime files. Only final wiring edits shared
stubs, kernel composition and work registration; this specification does not claim these are installed.

| Slice                 | Concrete prerequisites                                                  | Required evidence                                                                |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Initialization/intent | account share, amended gate/run DDL, normal guard                       | empty first-reader/writer races; legacy cold recovery; no false-ready probe      |
| Field backfill pages  | phase/scratch DDL, real source observations, derived allocator guard    | session/history/heads/activity/finish/types restart and unavailable reads        |
| Counter rebuild       | guarded counters, native receipts, generation DDL                       | all states, old complete reads, exact atomic publication and cleanup             |
| Purge pages           | Accounts tombstone event binding, inventory indexes, native purge guard | barrier precedence, child/remote bounds, retained artifacts and terminal receipt |
| Final composition     | preceding concrete modules plus listing prerequisites separately        | full production driver outcomes, no raw-fixture readiness claim                  |

Run `bun test specs/library-shelf-maintenance-contract.test.ts` for the frozen pure rules, root
`bun scripts/typecheck.ts`, and `bun scripts/stack-lease.ts shelf-maintenance-verifier -- bun specs/support/verify-outcome-suite.ts specs/library-shelf-maintenance-outcomes.test.ts LIBRARY_SHELF_MAINTENANCE_DRIVER 'Library shelf maintenance outcome driver is required'` for no-driver integrity.
Acquire the verifier's slot outside its short child timeout so queued admission can finish normally.
The real outcome suite must pass with a production adapter before deployment. Its red verifier establishes only
executable specification integrity. No passing native outcome, cost measurement or finished purge is claimed here.
