# Public figure views at a fixed selected neighbourhood

This measurement binds [Content Done when 4 and Acceptance](../goals/content.md) to
[`readPublicFigureViews`](../../services/kernel/src/rating/public-figure-http.ts) and the owning
[rating Cost contract](../../services/kernel/src/rating/README.md#cost): two statements per nonempty call,
at most 256 requested figure rows, no statements for empty input, and O(N log F) index blocks.
N is fixed here; the existing requested-batch curve retains its separate purpose.

The operation is in
[`growth-public-figure-views.test.ts`](../../services/kernel/test/rating/growth-public-figure-views.test.ts),
with private setup in
[`growth-public-figure-views-fixture.ts`](../../services/kernel/test/rating/support/growth-public-figure-views-fixture.ts).
The shared native fixture remains the producer and publication authority.

## Operation binding

- **Setup:** the native fixture creates thirteen Subjects in three partitions, real Auth credentials and a protected
  Realm through production Access and the registered community/rating runtime. Fifty real HTTP Global votes
  establish the prior. The selected ready Subject has five zero votes; one selected Subject has one vote; one has
  no figure. Native Realm votes publish both extremes on the ready Subject without changing its Global response
  or ETag. These producer workflows finish before read observation.
- **Selection:** the four requested Subject IDs, standard question, Global population and three partitions remain
  fixed. A fourth selected Subject receives its first real HTTP vote while a test advisory-lock barrier holds only
  publication completion. The registered worker commits its pending mark; HTTP observes `updating` with revision
  zero. The barrier changes no data and supplies no figure result.
- **Completion:** the actual helper runs on the instrumented native PostgreSQL pool in the caller's repeatable-read,
  read-only transaction. Its entire execution, empty call and invalid/oversized input rejections are observed.
  Two statement/plan assertions include all those calls: the successful call needs both statements, so empty and
  rejected calls add none. Only the caller's BEGIN/ROLLBACK add transaction control. This helper has no actor gate;
  authentication denials belong to the existing HTTP lifecycle coverage. No producer is required by this read.
- **Replay:** every warm-up and measured repetition reads the same four keys and compares the complete map,
  revision strings and quoted ETags with the native HTTP baseline. After observation the barrier is released and
  native pending publication completes. No direct effect invocation replaces a command or registered runner.

## Independent growth

Decision: use a fresh native fixture per axis so other unrelated axes remain fixed while the chosen axis grows.

Each axis uses 256, 1024 and 4096 retained keys, always within an existing selected partition. Pressure is seeded
outside observation, never into a selected Global figure or its producer inputs.

| Axis | Seeded pressure | Other axes |
| --- | --- | --- |
| Subjects | Unselected `semantic.subject` rows without figures | Figure/population history counts fixed |
| Figures | Unselected Global `rating.public_figure` rows | Subject/population history counts fixed |
| Population history | Other populations of the selected ready Subject: figures at revision 99, five votes and one aggregate component per population | Subject and unrelated Global figure counts fixed |

SQL cardinality assertions verify each independent footprint, including five population votes per history key.
The private population pressure carries mean/score 10 while the selected Global ready output remains exactly
zero. Selected ready-zero, insufficient, pending and absent states retain their complete HTTP output and ETags.
Serialized results also exclude Realm/member identifiers and vote internals.

The shared `checkGrowth` observer/classifier retains raw rows, native buffers, physical statements, relation sizes
and background work. It judges constant rows/statements and logarithmic blocks without planner/budget overrides.
The test checks every touched relation through `assertGrowthAccessPaths`, the exact two statements/plans, and at
most four visited figure rows with no figure sequential scan. Two measured repetitions per scale exercise replay.
No Search writer, protocol or authority rule is introduced.

## Execution and limits

From the worktree root, the focused landing command is:

```sh
bun run --cwd services/kernel check test/rating/growth-public-figure-views.test.ts
```

Runtime output records the exact tested Git revision and command before setup, actual seeded counts per scale,
then the selected states/revisions and three-scale samples with raw costs, relation footprints and classifier
verdicts. These are execution outputs, not checked-in evidence. A failure retains its reached assertion and native
cost context; an infrastructure exit or queued run establishes no measured pass. If product work is required, the
owning seam is the existing `readPublicFigureViews` query and its rating Cost contract, outside this test slice.

This document defines the operation binding, not a completed growth result. Controller launch deferral applies to
native/browser acceptance. Typechecking and the focused landing invocation cannot establish promotion or Goal
closure; admitted three-scale observations must come from the runner on its bound revision. No HTTP lifecycle or
requested-batch measurement is duplicated or replaced.
