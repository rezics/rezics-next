# Private library bulk operations

## Bounded preview and confirmation

Commerce decision L2 supersedes the earlier cross-home confirmation-cut protocol and its capture/funding
requirements. Preview explicit or admitted filtered targets once, persist the exact target rows, and confirm that
manifest. At most 1,000 targets may belong to an operation. A larger result refuses preview with “Select at most
1,000 targets. Narrow the selection and preview again.” Confirmation never reruns a filter or adds new matches.

Use the existing occurrence selection, removal and Undo commands and UI. Preserve selected occurrence identity
and multiplicity. Each effect compares the captured revision/incarnation in its actual native write. Record a
changed entry as `conflict/revision_mismatch`, displayed as “Changed since preview; skipped”; continue the other
targets. This is a per-target outcome, not rejection of confirmation. Native authorization, command receipts,
durable initiator capture/restoration and account lifecycle checks continue to govern every action and read.

Decision: the header retains action/filter provenance without an explicit ID array; installed `bulk_target` rows
are the sole persisted membership manifest. A new preview gets a new operation identity. Retry retains the same
operation and per-target receipt identities. Completed effects and their outcomes must commit together on the
same home; remote commands must reconcile their original native receipts before any further attempt.

## Native storage boundary

[`collection-bulk-store.ts`](collection-bulk-store.ts) implements the internal native transaction seam:

- `collectCollectionBulkTargets` asks an admitted source for bounded useful pages, stopping at 1,001 matches.
  Source cursors and authorization belong to the source; the collector invents neither a filter nor preparation.
- `previewCollectionBulk` inserts one `bulk_operation` header and all `bulk_target` rows in the surrounding native
  command transaction. It freezes action, initiator, creation receipt, target expectations and deterministic
  per-target receipt locators. Reusing an operation identity with different intent refuses rather than replacing
  membership. Canonical subjects are unique; distinct occurrence members preserve duplicate subjects.
- `confirmCollectionBulk` transitions the operation once. Its caller must emit the registered Core outbox event
  in that same native command. Zero-target previews complete on confirmation without an effect.
- `readCollectionBulk` and `pageCollectionBulkManifest` use source route, operation and owner keys. They are
  internal readers; the API must independently authorize the current caller and enforce results retention.
- `applyCollectionBulkTarget` serializes same-home effects with the operation lock and stores terminal outcomes
  in the same native command transaction. Replays return the original outcome, including resulting member ID.
  Its native executor must atomically check the captured expectation and return the original native events.
  It is not a remote effect dispatcher and must never wrap a network command in a local transaction.

The operation header has full-key owner, due and expiry indexes. The installed manifest keeps its subject and
occurrence uniqueness, state and pending indexes; no second manifest or scheduler is added. Existing
`pageBulkOutcomes` remains the bounded reader for wire outcomes after native authorization and cursor validation.

Decision: captured native occurrence expectations bind `member_revision`, `transaction_id` and `added_at` together;
the older incarnation/sequence-only scaffold cannot authorize removal and fails with `evidence_missing`.

`executeCollectionRemoveTarget` delegates to `collection-bulk-remove.ts`. It restores the initiating actor during
each native command attempt, checks current Collection and Subject access, locks the exact member and compares
those stamps before calling the existing retained batch-removal producer with the current parent CAS. No Subject
population is scanned. Native member events, ordering and explicit Undo are preserved. The receipt response retains
the original deletion identity, revision and Undo deadline. Same-home applied state/evidence commits with the removal;
no-effect/conflict receipts contain terminal results without another personal write. The operation owner acknowledges
those results and all cross-home results. Occurrence receipt locators use the actual Collection home.

Current authority refusal creates no command receipt or effect and returns denied evidence with a null transaction
identity. Only private source-bound accounting may recover an earlier exact receipt after refusal. This internal
accounting result grants neither another effect nor public disclosure. Missing original receipt evidence on an
already terminal target fails closed. The operation owner still installs its durable source reader/restorer and
owns lifecycle, result authorization, retention and Accounts erasure composition.

The other factories in `bulk-contract.ts` remain unimplemented scaffolding, rather than a mounted API. Their
funding/cut descriptions are superseded by this contract. The store seam does not make those factories functional.

## Remaining native composition

The separate integration delivery owns native commands/routes, outbox and worker delivery, lifecycle/erasure
composition and the recoverable Web journey. This storage increment supplies only the internal transaction seam.

Mount native preview, confirmation, operation and outcome routes with the ordinary Access catalogue and command
receipts. Capture the native durable initiator and install its reader. Emit and consume one registered Core outbox
confirmation event through the existing Library WorkModule and queue. Use the source's documented direct or
ready-result interface for filtered capture and the existing Members preparation implementation where needed.

Native executors must retain the real entry/occurrence CAS, live authorization, native domain events and exact
remote receipt reconciliation. Reuse the delivered occurrence removal/Undo journey. Expose durable operation URLs
for Web preview, explicit confirmation and per-target results; navigation and retry must recover the same operation.
Compose retention and erasure with Accounts 27af and the existing Library cleanup, including the new header's
owner/expiry indexes. Do not expose the internal store before this composition lands.

## Personal Library removal executor

`executeLibraryRemovalTarget` now delegates to `collection-bulk-library-removal.ts`; other action ports retain
their existing implementation status. It removes only the captured personal entry through the ordinary native
deletion transition and event. Copies, sessions, Collection occurrences and financial facts remain independent.
The same owner transaction stores terminal target evidence and its original command receipt. `TargetEvidence`
adds optional `deletion: { deletionId, revision, restoreUntil }` for successful removals, preserving the original
720-hour deadline. Undo remains a separate admitted command.

Decision: present `admissionSequence` is native `entry.owner_write_seq`; absent `slotGeneration` is the captured
`owner_write_counter.seq`, conservatively conflicting on any intervening owner state write, including create/clear ABA.
Missing native sequence evidence conflicts rather than being replaced with a synthetic value.

The internal source-bound recovery path verifies the exact persisted manifest, initiating record and original
native receipt against terminal evidence. It may return private accounting after revocation; callers must still
authorize every public result read. It neither acknowledges another home's outcome nor authorizes another effect.
Personal removals are same-home; the executor installs no remote dispatcher, scheduler, public route or erasure path.
It uses the operation owner's installed durable reader/restorer and chunk limiter; admission, confirmation and
worker composition remain owned by the integration delivery.

## Static bounds

The separately owned command envelope admits at most 64 KiB. The stored-value ceilings below bound internal
persistence; they do not enlarge that envelope or admit an oversized command.

One preview holds at most 1,000 targets, each at most 4,096 canonical JSON bytes, and request and initiator at most
131,072 bytes each. Stored JSON whitespace has a separate finite SQL ceiling. An admitted source is read in pages
of at most 100, with a final remaining-plus-one probe; sources returning one useful target per page need at most
1,001 calls. Every source retains its own finite indexed per-call bound. Enumeration stops before persistence if
the extra target exists. Manifest persistence uses one header insert, one multirow target insert and one header
read; replay uses one header insert attempt and one read. Header insertion and target insertion are atomic.

Manifest pages seek by `(route,operation_id,ordinal)` and emit at most 100 targets, using the installed pending
partial index for pending work. A same-home attempt performs at most five full-key/indexed statements plus its
native executor's static bound: header lock/read, target lock, target transition, indexed pending existence and
header completion update (the last two share a statement). No runtime quotes, funding or no-refill ledger applies.
Execution expires 24 hours after preview and results are retained for 48 hours. Retention never substitutes for
current authorization or authorizes erasure by itself. Whole composed admission and worker ceilings must include
the existing native command, Access, source and executor bounds when those adapters are installed.
