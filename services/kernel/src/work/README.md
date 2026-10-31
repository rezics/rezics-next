# Native workflow writer retirement

The pinned SDK extension declares `DBOSClient.retireWorkflow(actualWorkflowId)` and
`getWorkflowWriterFence(actualWorkflowId)`, also available on `DBOS`. The Work wrappers are
`retireSdkWorkflowWriters` and `readSdkWorkflowRetirement` in [sdk-retirement-fence.ts](sdk-retirement-fence.ts).
The actual, unchanged workflow ID is the native identity. The receipt contains that ID, its permanent writer
generation, a native closure UUID and the native closure timestamp. Repeated retirement returns the same receipt.

The declaration commit preceded the implementation for consumer integration. The patch now supplies both the
native implementation and declarations; declaration-only revisions establish no closure. Native proof and
participant completion remain separate from source integration and typing. The native cases in
[sdk-retirement-fence.test.ts](../../test/work/sdk-retirement-fence.test.ts) await post-integration execution.

Retirement establishes technical SDK writer closure only. Genuine Source, consumer and root admission belong to
their owners. SUCCESS, cancellation, an empty status read or a caller boolean cannot supply that authority. This
wrapper neither cancels nor deletes. After genuine owner readiness and native closure, owners use the existing
supported SDK deletion API without descendants, then all exact physical family probes. Unknown original or foreign
custody remains pending. Closure is permanent and survives SDK deduplication and execution/history deletion.

The Bun patched dependency stays on `@dbos-inc/dbos-sdk` 5.4.6-preview. Its SDK-owned migration installs one permanent
`workflow_writer_fences` control row per actual ID, outside deletable execution/history rows. Generation 1 admits
writes; generation 2 carries an immutable native closure UUID and timestamp. There is no reopening API. The control
row contains no execution payload and does not increase the existing execution budgets: 64 operations, eight event
keys, 64 history rows, 64 KiB payloads, 4 KiB metadata, 139 execution rows and 10 MiB remain unchanged.

Every INSERT and UPDATE of `workflow_status`, `workflow_input`, `workflow_output`, `operation_outputs`,
`workflow_events`, `workflow_events_history`, `notifications` and `streams` passes an SDK-installed native row guard.
The guard upserts the actual ID's control row and holds its native row lock through the writer's COMMIT. A conflicting
tombstone is checked against the current locked tuple; an older transaction snapshot cannot admit a stale writer.
The same guards therefore cover previous executors, transactional enqueue, SQL enqueue, queue claims/recovery,
status/output/error updates, steps, messages, events, history, streams, rewind and input restoration. Notifications
guard their actual destination ID. New child/fork status rows also guard their parent/source ID. Existing children
retain their independent lifecycle. Resume, rewind and fork explicitly guard their IDs inside their native
transaction, including otherwise empty or terminal no-ops.

Retirement joins the original native workflow-owner lock and the permanent control-row lock. It revokes the current
execution token before closing the control row in the same transaction, without changing status or payload. This
also fences the unchanged old `sendFromStep` path: its native owner check shares that lock through notification
COMMIT, so a message to a different live destination must either commit before closure or roll back. SDK deadlock
retry applies to the entire retirement statement. No process shutdown, global mutex or application callback supplies
the fence. Running JavaScript and application side effects still require their owners' admission; the receipt
establishes SDK writer closure only.

The native guards are `ENABLE ALWAYS`, including control-row immutability guards. Ordinary COPY/restore replay into
the live schema cannot recreate a retired ID. Database recovery must preserve the permanent control table and
guards alongside the SDK schema; rolling the entire database back to a pre-fence backup is outside this receipt's
guarantee. Product modules use only supported SDK methods to fence and delete; they install no foreign SDK triggers
or SQL mutations. Any lawful cancellation must precede closure, since cancellation itself updates SDK status.
Remove the patch when the pinned upstream primitive provides equivalent permanent guards and receipts, including
old executors. The patch header records the missing primitive and its reproducer.

Source inspected before implementation: the installed SDK's `client`, `system_database`, `dbos`, `dbos-executor`,
workflow management and native migration runner/history; and the indexed read-only
`search-worker-outcome-harness/dbos-transact-ts` reference's `client.ts`, `system_database.ts`, `dbos.ts` and
`dbos-executor.ts` at revision `980dc55095f445b189aecb59e7f3334345179f65`.
