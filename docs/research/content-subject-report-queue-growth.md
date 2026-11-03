# Native Subject report queue read growth

This operation binding adds the missing native measurements for [Content Done-when 5](../goals/content.md#done-when)
and the [moderation quality map](content-quality-moderation.md). The owning bounds are
[Subject report snapshots](../../services/kernel/src/content/README.md#reports-and-moderation) and
[selected report pages](../../services/kernel/src/content/README.md#selected-report-pages).
It changes no production contract or existing measurement.

[`growth-subject-report-queues.test.ts`](../../services/kernel/test/content/growth-subject-report-queues.test.ts)
uses its private [fixture](../../services/kernel/test/content/support/growth-subject-report-queues-fixture.ts).
Production Access authenticates real native Auth credentials. Native Subject creation and report HTTP commands
produce the selected records. Report command replay must retain the receipt identity. The registered Content
module enqueues committed native log envelopes through the real worker, waits for every registered effect and
replays that enqueue before any selection. Projection and replay are setup, with no projection growth claim.

| Axis | Independently varied pressure at 32 / 256 / 2048 | Fixed neighbourhood |
| --- | --- | --- |
| Population | Unrelated Subjects and reports, exact-target references and Global candidates, sharing the selected Subject and report routes | Seven native selected reports; page limit 1, candidate limit 2; unrelated timestamps between fixed head and tail |
| Retained history | Same-report-home outbox envelopes, command receipts and original write bases referencing one fixed unrelated source | 32 unrelated Subject/report populations, seven selected reports and unchanged candidate indexes |

Noise is privileged unobserved setup, never the source of asserted workflow results. Each new series removes
only its previous noise so scales describe the same independent axis rather than cumulative earlier series.
Retained history means source event/command history; it does not claim Semantic revision or moderation history.

Each route has separate series for first, deep (after three native keys), terminal-empty, sparse current-status
filtering, sparse current-target inspection denial, initial Global authority loss and final Global authority loss.
The final-loss barrier is after a real report fill and before its last current Global check. Sparse denial revokes
Global inspection after the candidate Subject snapshot and restores it before the final fence; both transitions
use native governance HTTP. The competing writer uses the ordinary pool; captured read authorization and all
selected native snapshots use the growth pool. No decision or query result is mocked. A subject-local grant
cannot substitute for Global inspection.

Decision: terminal-empty measures a resolved-filter page at the fixed tail with one pending raw candidate and no
continuation; it makes no claim of zero raw candidates. This preserves native sealed cursor construction.
Sparse captures include their next HTTP read to prove last-examined continuation and no refill. The other states
capture one HTTP read. Selection, hydration, dropped candidates, current authorization and empty/denied work all
remain inside their respective observation. Reads need no asynchronous runner completion; registered projection
completion precedes them. Rows/statements are constant and buffers logarithmic at fixed limits, using the shared
observer/classifier with its default repetitions, warmups and budgets. No planner, TTL or bound tuning applies.

Binding assertions retain both routes' 1–50 limits, cursor selection/order/limit/operation binding, narrower real
credentials and Global-only inspection. Existing frozen HTTP suites retain the full viewer/client and lifecycle
persona coverage. Native reports with omitted evidence must disclose null evidence and no revision; this slice
neither reconstructs erased bytes nor claims to measure erasure or Realm moderation.

The landing command is:

```sh
bun run --cwd services/kernel check test/content/growth-subject-report-queues.test.ts
```

Every reached growth result emits the exact Git revision, that command, fixture, reached state, three-scale native
costs, raw repetitions and statement attributions. A growth-bound failure emits its reached samples before
rethrowing; an earlier failure is not a measured pass. Logs are runner artifacts, not committed evidence files.
The authored base is `7129bd8d2203ef3afdc2bf398db69442c3044789`; source inspection confirmed the native HTTP suite
has no growth series and the selected-page Cost measurement is deferred. Controller acceptance, promotion and
browser/native launch claims remain deferred; authoring or type-checking this file does not establish measured
bounds. Any reached production failure belongs at the existing report selection/inspection SQL seam; this slice
must retain that failure instead of changing runtime code or weakening its bound.
