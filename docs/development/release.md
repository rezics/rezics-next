# Release qualification

Publish a fixed candidate while [development continues on `dev`](delivery.md#direct-source-integration).
The resident owns release scope and trade-offs. Capability owners supply and repair their evidence. The existing
publisher advances `main` and confirms the running revision. Feature exposure follows [public scope](../scope.md).

## Candidate and time budget

Start the clock when the scoped batch enters release qualification. Record the previous qualified revision, the
candidate source and artifact, the in-scope outcomes, and the [required evidence](verification.md#choosing-checks).
Assign an owner to each outstanding outcome. Continue new work on `dev`. Add only release fixes to the candidate
and integrate those fixes on `dev` too. Keep a candidate's code, configuration and data lineage identifiable across
fixes. A newer `dev` head does not change the release batch.

The target for a routine batch is **12 elapsed hours** through verified publication. Include queue time, required
preparation, diagnostics, repair and reruns. A repaired revision, host replacement or retry keeps the initial start
time. Split known broad changes into independently deliverable, compatible steps before the batch starts. The
[first-public sequence](../scope.md#release-sequence) has its own closeout target and prerequisites.

Use the existing result events and checkpoints to manage the remaining time:

| Time from entry | Expected result |
| --- | --- |
| By hour 1 | Report startup, applicable migrations and a critical native smoke result, or the first failing prerequisite and its owner. Start the independent affected checks. |
| By hour 8 | Diagnose and repair, revert, or isolate changes on the critical path. Reproduce faults at their smallest real boundary and preserve completed checks. |
| By hour 10 | Settle affected evidence for the final candidate, including any required compatibility or recovery check. Reserve capacity for publishing and confirming the revision. |
| By hour 12 | Publish and observe the revision, or record a missed target with the first outstanding required outcome and its owner. |

If a change will miss the window, the resident can revert it or leave it unexposed when the remaining release
scope and dependency contracts still hold. Missing or unknown required evidence and unsafe rollback hold the
affected candidate. Keep the last qualified release available and continue independent development. A reduced or held
batch counts against the original target. Only the owner and maintainer can change adopted product scope.

## Qualifying and publishing

Collect the required outcomes from capability manifests and [check selection](verification.md#choosing-checks).
Compose applicable results from existing development checks with new candidate checks where inputs changed. Always
prove candidate startup and a small set of critical journeys through real interfaces. Run broader combinations for
changes to shared semantics. Use the existing [promotion commands](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing).
The installed publisher's full gate applies until its replacement can enforce the required evidence for the exact
candidate. A manually selected check or this document does not change that command.

Build once for matching inputs and publish the qualified artifact. If rebuilding is necessary, verify artifact
identity or rerun the affected checks. When a release changes shared data, queues, indexes or readers and writers,
prove supported version coexistence, migration and the applicable recovery route. Separate compatible schema changes,
resumable backfill, activation and removal when each can ship independently. For an irreversible step, prove recovery
before activation. Use isolated representative data and test cold startup, replay or growth when the change affects
that behavior. Apply [database restore](database-restore.md) when recovery requires restoring data.

Verify publication from the running product or service using the observed artifact or revision and the applicable
live smoke. Use limited exposure and compare against the previous release when the deployment supports it. Keep
release verification open until that observation is recorded. Product Goal closure also requires its adopted outcomes
on the promoted revision. Track the 12-hour result and source-to-publication time under [efficiency](efficiency.md#release-and-repair-metrics).

## Qualifying the workflow

Compare the new path with the current one on a local change, a stateful cross-owner repair and a check-host
interruption. Verify that an unaffected result survives the interruption, changed inputs invalidate their results,
and independent source keeps landing. Use the existing progress report to compare time to the first actionable
failure, total release time and active coding during qualification. Retire repeated full runs only where the
publisher can establish that the candidate still has all required evidence.
