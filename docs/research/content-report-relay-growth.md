# Native report relay growth binding

The native acceptance in [`growth-report-native-relay.test.ts`](../../services/kernel/test/content/growth-report-native-relay.test.ts)
measures `POST /v1/reports` separately from report-target projection through the `effects` relay registered by
`registerContent`. It uses the native Access fixture, a public post owned by another account, a permitted reporter,
the exact source envelope selected from the kernel log, `effectsRelay`, `startRelays` and the registered DBOS effect.

The submission capture covers the HTTP command only. Three projection captures hold one selected source report and
one selected post/board neighborhood per run while growing one unrelated population at a time: source report rows
in the selected source route, report-target rows for unrelated targets in the selected target route, or prior
no-effect outbox history in the selected source partition. The outbox history is drained through the registered
relay before the selected report is created. A separate replay capture rewinds the effects checkpoint to the
selected source's saved position and sends that same envelope through the registered relay again.

An additional denied submission plus empty relay capture keeps the no-write and empty-batch path visible under
retained outbox history. The assertions retain the completed `content_report_target` queue row, one target and one
board projection event, the currently readable public target, and the absence of report evidence and reporter ID
from projected data.

All growth operations use 64 / 512 / 4096, three measured repetitions, one warmup, and the owning bounds:
constant native rows, buffers observed, and statements; logarithmic blocks. Setup, report selection, relay
completion and replay remain separate boundaries.

**Binding decision:** Use a fresh source route and target/board neighborhood for each selected report, and vary
source rows, target rows, or outbox history one axis at a time.
