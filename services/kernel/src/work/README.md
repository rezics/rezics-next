# Native workflow writer retirement

The pinned SDK extension declares `DBOSClient.retireWorkflow(actualWorkflowId)` and
`getWorkflowWriterFence(actualWorkflowId)`, also available on `DBOS`. The Work wrappers are
`retireSdkWorkflowWriters` and `readSdkWorkflowRetirement` in [sdk-retirement-fence.ts](sdk-retirement-fence.ts).
The actual, unchanged workflow ID is the native identity. The receipt contains that ID, its permanent writer
generation, a native closure UUID and the native closure timestamp. Repeated retirement returns the same receipt.

These declarations are published before implementation for consumer integration. They are unsupported until the
SDK body and its complete native writer guards land; declarations alone establish no closure. There is no stub
success path. Native proof and participant completion remain separate from source integration and typing.

Retirement establishes technical SDK writer closure only. Genuine Source, consumer and root admission belong to
their owners. SUCCESS, cancellation, an empty status read or a caller boolean cannot supply that authority. This
wrapper neither cancels nor deletes. After genuine owner readiness and native closure, owners use the existing
supported SDK deletion API without descendants, then all exact physical family probes. Unknown original or foreign
custody remains pending. Closure is permanent and survives SDK deduplication and execution/history deletion.
