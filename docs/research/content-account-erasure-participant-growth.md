# Content account-erasure participant operation costs

The [Content Cost map](../../services/kernel/src/content/README.md#cost) bounds each phase separately:
50 authored/upload/reaction/report/moderation keys, at most 100 older authored revisions, and 50 upload proof keys.
Participant progress, fence closure, final existence probes and acknowledgement add constant work to each step.
The complete lifecycle remains linear in the erased account's own content. Accounts owns its orchestration.

The native [acceptance](../../services/kernel/test/content/growth-account-erasure-participant.test.ts) and its
[private fixture](../../services/kernel/test/content/support/growth-account-erasure-participant-fixture.ts) use real
Auth registration and `deletePersona` approval/execution, the production Access factory and Content work registration.
A separate registered executor preserves the live Auth executor. Source events are relayed before deletion; committed
tombstones then enqueue the actual participant. Collection failure occurs at physical prefix deletion after its native
pending fence. Storage and databases are isolated resources owned by this invocation.

Decision: select individual registered workflows with the SDK's queue delay/release controls; retain production page,
retry, expiry and ten-minute sleep settings, and cancel only this fixture's observed sleeper before resuming its persisted
next step through the native enqueue seam already used by `account-erasure.test.ts`.

| Operation | Selected work and asserted completion |
| --- | --- |
| Fence closure | Real tombstone effect, stable close workflow, one progress row and closed fence. |
| Authored page | One published contribution and one draft; published body retained with erased author, draft title and physical revision bytes cleared by registered follow-up work. |
| Upload phases | One pending reserved avatar; fields pass records the unchanged 600,000 ms durable delay and leaves both acknowledgements pending. |
| Collection settlement | Registered partition worker collects exactly one pending prefix, joins its effects and removes bytes and media row before participant resumption. |
| Reactions/reports | Empty selected ranges, including final reaction source-version cleanup. Existing positive functional scenarios remain unchanged. |
| Moderation | One recent decision, decider removed, statement retained under one exception and expiry key. |
| Final proof | Separate media and fields operations, actual residual probes, content/delivery `none` for empty accounts and `erased` for contributions. |
| Replay | Actual registered `effect` workflow replays the committed tombstone; original close workflow and progress are unchanged, with exactly one acknowledgement per participant. |
| Expiry | Registered retention page at the original due time, statement cleared, expiry key removed and exception resolved. |

Each operation has its own `checkGrowth` series at 256, 1024 and 4096. The independent axes are unrelated completed
progress, unrelated authored source/locator rows, and retained moderation decisions/expiry keys. Only that axis varies;
removable locator/progress/expiry pressure resets before the next series. Immutable unrelated post/revision cohorts
remain as an explicitly reported fixed baseline within each subsequent series; each content series adds its own
256/1024/4096 source cohort, without deleting or weakening revision identities. Population insertion/counting and lifecycle selection are
outside the observation. Observer status polling uses the administrative connection, while the actual registered
executor, enqueue/release commands and fixed result assertions remain captured. Six native accounts per scale/scenario allow one warm-up, one accepted run and the shared
observer's four possible cold-backend discards without SQL resets of selected lifecycle state. The selected neighborhood
and production page limits remain fixed. Constant rows/statements and logarithmic buffers apply to each selected
operation, including registered follow-up work, rather than an arbitrary-size account lifecycle. Probe budgets derive
from the owning page bounds plus progress/acknowledgement point operations; Collection retains its 16 routes and
100-item production batch. No planner, TTL, budget or growth classifier override is installed.

Run from the worktree root:

```sh
bun run --cwd services/kernel check test/content/growth-account-erasure-participant.test.ts
```

The executable prints the tested Git revision, exact command, fixture populations, each reached registered operation
and output, and the shared observer's full three-scale samples (native rows, buffers, statements, plans and relation
footprints). It also classifies actual registered-step and storage-prefix counts. These runtime observations, including
any first reached assertion failure, belong to the controller's check output; authoring this suite is not a measured
pass. Acceptance launch and promotion remain deferred to normal controller admission. This fixture does not measure
account-wide orchestration, growth in the selected account's own content, six months of real-time waiting or an entire
linear lifecycle as constant work.
