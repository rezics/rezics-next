# A shared workspace for web workers

Research date: 2026-10-28. Repository baseline: `bc6c7eba7976422220c2fec1e572b9dce03ecd98`.
This report supplies evidence and a proposed pilot, not a new dispatch or delivery contract.

## Recommendation

Pilot one shared web working tree with three concurrent workers, exclusive ownership of writable files,
a controller-owned commit queue, and checks on immutable snapshots. Start it on `web/shared` from `dev`;
have the existing train integrate sealed prefixes in batches. Preserve each worker's commit and authorship.
Keep `main` promotion separate. Consider direct commits to `dev` only after the pilot demonstrates safe
coordination with every other writer of that ref.

The opportunity is substantial but narrower than eliminating all unsuccessful attempts. In the observed
web history, attempts rejected during rebase consumed **121.79 worker-hours, 30.26% of ended worker time**.
Initial worktree preparation occupied approximately **28 minutes across 330 dispatches**. Avoiding repeated
work, and bounding retained checkout storage, matter much more than accelerating `git worktree add` alone.
Sharing files introduces overwrite and test-contamination risks that branching currently contains.

## Measurement and its limits

The source is the main checkout's `.temp/goal/goal.sqlite`, opened with `sqlite3 -readonly` and backed up
into this worktree's `.temp/web-shared-workspace/snapshot.sqlite`. Cutoff: **2026-10-28 15:42:08.298 UTC**.
Snapshot SHA-256: `da87084d2c84beedde07db41e84246af451826ddc25461d5c749fbeacd4fda04`.
It contains 2,211 tasks, 3,489 attempts, 3,446 records and 6,649 events. Restricting `brief.goal` to `web`
gives 330 tasks, 478 attempts, 460 ended records, 869 events and 313 landing rows. All 310 referenced
web landing logs were present and read; eleven mention a batch integration check.

Worker-hours are persisted `endedAt - startedAt`, including checks, waits and lifecycle-detection delays;
they are neither CPU hours nor pure editing time. Token figures are the stored `tokens` counters, counted
once per `(task_id, attempt)`, including unsuccessful attempts. They are diagnostic usage, not a provider
billing ledger. Twenty-two ended records have zero tokens; resumed-counter and missing-response limitations
discussed in [the token audit](agent-token-efficiency.md) also limit these totals. Open attempts have no final
record and are excluded from these token totals. A pass overrides an inherited escalation label.

### Rework and conflicts

The following rows partition all 460 ended web records. A rebase rejection means a failed `gate-outcome`
whose stage is `rebase`, rather than merely an escalation containing that word. Hours describe the whole
preceding attempt; they do not mean that Git spent those hours rebasing.

| Ended outcome                                             | Attempts | Worker-hours | Recorded input + output, million |
| --------------------------------------------------------- | -------: | -----------: | -------------------------------: |
| Passed                                                    |      218 |       150.85 |                         2,023.06 |
| Rejected during rebase                                    |       69 |       121.79 |                         1,797.96 |
| Other stops labelled rebase conflict                      |        4 |         0.82 |                            16.09 |
| Specification conflict, excluding actual rebase rejection |       31 |        17.22 |                           281.50 |
| Environment                                               |       31 |        22.59 |                           265.56 |
| Scope growth                                              |       33 |        22.09 |                           376.36 |
| Pool exhausted                                            |       18 |        21.32 |                           390.99 |
| Stalled                                                   |       15 |        18.59 |                           223.94 |
| Cancelled, superseded, early stop and other stopped       |       41 |        27.21 |                           266.84 |
| **Total**                                                 |  **460** |   **402.47** |                     **5,642.31** |

There are 218 passing integration events, all at stage `merge`; these are integrations onto `dev`, not
218 promoted outcomes on `main`. For their complete histories, 167 of 385 attempts precede the winner,
using 133.74 of 284.59 worker-hours and 48.53% of recorded tokens. In the narrower **128 successful interface
tasks**, 122 of 250 attempts precede the winner: **48.8% of attempts, 49.77% of time and 51.89% of tokens**.
This supports the approximately 48% replacement premise with an explicit denominator. Across _all_ ended
interface records, including tasks without a winner, 179 of 307 did not pass; that is a different rate.

The 69 actual rebase rejections include 18 records labelled specification conflict. Conversely, 23 passing
records retain a rebase-conflict label. Counting labels alone would both misclassify successful work and hide
repeated rebase failures escalated as specification conflicts. Failures concerning specifications,
base defects, infrastructure or allowance exhaustion do not disappear when workers share a checkout.

Hot files, counted once per rejection containing the file or group, are `apps/web/README.md` (19),
`apps/web/src/kernel/fake.ts` (10), locale messages (11), recorded-response JSON (6), and
`apps/web/tests/page-stories.test.ts` (6). Their union covers **41/69 rejections**; the counts overlap.
There were **zero recorded route-tree conflicts** in this sample. Generated routes still need serialization
because typechecking runs route generation, not because this sample proves they caused historical retries.

The language-propagation case illustrates the distinction between work lost and Git execution time.
`landing-1776.log`, `landing-1853.log` and `landing-1915.log` reject changes to the fixture adapter;
`landing-2065.log` names the shared story test; `landing-2174.log` names the README, adapter and home route.
These five attempts occupied **19.03 hours** before rejection. Including a sixth unsuccessful, rebase-labelled
stop gives **19.46 hours**, **347.78 million recorded tokens**, **5.38 million uncached input** and
**1.04 million output**. A seventh attempt was running at cutoff. Only five have confirmed train conflicts;
the sixth is not evidence of another observed Git conflict. The corresponding `evidence/<task>/<attempt>/failure.json`
and `diff.patch` preserve failure and implementation evidence; the query below resolves their concrete paths.

### Setup and landing waits

Initial preparation is observable approximately from each worker branch's first reflog entry, whose old
object is zero, to task `createdAt`. In `tools/goal/src/tasks.ts`, branch creation precedes checkout,
dependency installation and frozen-file preparation, and `createTask` follows them. All 330 web branches
retain that creation entry: sum **1,681.15 seconds**, median **3.37 seconds**, p90 **9.06 seconds**, maximum
**91.08 seconds**. Reflog timestamps have one-second resolution, so each interval has up to roughly one
second of rounding error. This excludes time acquiring the dispatch lease, retries and train checkouts;
it does not isolate installation from checkout or formatting. `createdAt` is too late to measure those
missing portions. Creation-to-first-worker delay also includes dependencies and admission, so it is not
a substitute for setup time.

For a completed landing, infer train start as outcome event time minus `hostMs`, and queue residence as
that start minus the matching `landing-requested` event. This is inferred residence, not instrumented
phase timing. Summed residence can overlap between batch members and cannot establish train utilization.

| Completed web landings          | Count |   Queue sum | Queue median / p90 | Mean queue | Mean train residence |
| ------------------------------- | ----: | ----------: | -----------------: | ---------: | -------------------: |
| Entire observed history         |   310 | 80.40 hours |   0.38 / 58.20 min |  15.56 min |             1.22 min |
| Passing landings, same history  |   218 | 51.74 hours |   0.50 / 58.20 min |  14.24 min |             1.46 min |
| Last 24 hours, all outcomes     |    43 | 32.63 hours |  37.75 / 81.17 min |  45.53 min |             1.38 min |
| Passing landings, last 24 hours |    28 | 16.91 hours |  39.08 / 75.18 min |  36.24 min |             1.97 min |

All 69 rebase-stage outcomes together report **284.57 seconds** of train residence, including their other
setup work. The expensive consequence is the attempts and retries associated with rejection, not those
few seconds of Git operation. Queue time normally occurs after worker exit and does not itself spend
model allowance. Do not add it to worker-hours or claim an equivalent allowance saving.

The recent window ends at cutoff and begins exactly 24 hours earlier. It has 14 rebase rejections;
the full lifetimes of those 14 attempts total **64.39 hours**. All 102 records ending in that window total
200.32 hours. These are completion-cohort figures, not hours physically inside the window: calendar-clipped
web attempt residence, including running attempts, is 236.97 hours. Keep the denominators separate.

A read-only inventory during this investigation found **2,240 registered worktrees**; the filesystem was
52% occupied, with about 898 GiB available. This confirms retention growth, not the earlier saturation event
or its byte cost. Worktree counts include other Goals and train/promotion trees. No historical disk ledger
or defensible per-web-worktree unique-byte measurement was available; hardlinks and shared Git objects
also make multiplying `du` output by the count misleading. This investigation removed no worktrees.

### Allowance attribution

The rebase-rejected attempts contain **28.72 million uncached input**, **1,762.83 million cached input** and
**6.41 million output** tokens. These are respectively **28.49%, 31.93% and 29.88%** of the ended web totals.
They identify an expensive cohort; they cannot identify which tokens were specifically spent resolving Git
conflicts or how much already-written implementation survives in a retry.

**Exact subscription allowance spent on rebases, setup or landing waits is not identifiable from this store.**
Only 296/460 records have before/after observations with a comparable reset/window. Readings are shared
across concurrent workers and managers, sometimes stale, rounded or reset; summing percentage differences
would charge other work repeatedly. Setup and the unattended train do not call a model themselves.
Future phase events plus a deduplicated per-response usage ledger can attribute model work; actual allowance
still needs provider attribution or isolated measurement windows. Do not convert raw cached-heavy tokens
into allowance percentages or money using nominal model prices.

## What the primary sources establish

All external sources below were inspected on 2026-10-28. The repository snapshots were reused, read only as
data, and registered under this topic in the main checkout's ignored `.reference/INDEX.md`.

| Primary source                                                                                                                                                                                                                                                      | Relevant practice and boundary                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DORA: trunk-based development](https://dora.dev/capabilities/trunk-based-development/)                                                                                                                                                                             | Small changes integrate frequently; fast automated tests support integration. Sharing a branch does not imply sharing an editable filesystem.                                                                                                                                                  |
| [Software Engineering at Google, chapter 16](https://abseil.io/resources/swe-book/html/ch16.html)                                                                                                                                                                   | One current version and minimal branch lifetime reduce coordination costs. The chapter describes separate developer workspaces and the need to coordinate writes on shared storage. Its [online licence](https://abseil.io/resources/swe-book) is CC BY-NC-ND 4.0; no text is reproduced here. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) and [worktrees](https://code.claude.com/docs/en/worktrees)                                                                                                                                   | Task claiming uses locking; teammates should own different files. Worktrees are the documented way to isolate parallel sessions. Task claiming is not a filesystem write fence.                                                                                                                |
| [Anthropic's parallel compiler experiment](https://www.anthropic.com/research/building-c-compiler)                                                                                                                                                                  | Agents used task locks, separate container-local clones and synchronized through Git. Shared-codebase success is not evidence for a single writable checkout; the account also reports overwrite and integration problems.                                                                     |
| [Aider source, `aider/repo.py`, `GitRepo.commit`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L131)                                                                                                               | Explicit filenames are added and passed to `git commit`; the fallback commits all tracked changes. This supplies a scoped-commit pattern, not a concurrent index or write-lock guarantee.                                                                                                      |
| [Git commit](https://git-scm.com/docs/git-commit) and [update-ref](https://git-scm.com/docs/git-update-ref)                                                                                                                                                         | A path-limited commit excludes other staged paths; compare-and-swap ref updates can reject a stale expected head. Neither protects file contents while another process edits them.                                                                                                             |
| [bors-ng, `lib/worker/batcher/divider.ex`](https://github.com/bors-ng/bors-ng/blob/ca725797e53a88e954998de0bbb14a8a5acb13ab/lib/worker/batcher/divider.ex) and [README](https://github.com/bors-ng/bors-ng/blob/ca725797e53a88e954998de0bbb14a8a5acb13ab/README.md) | Batching amortizes checks, splitting failed batches isolates candidates, and a failing singleton is rejected. A passing batch does not prove every intermediate commit passed.                                                                                                                 |
| [GitLab merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)                                                                                                                                                                                           | Checks cover cumulative source-plus-target states. Removing a failed predecessor invalidates later results; a check against an old combination cannot authorize a new one.                                                                                                                     |

Local source paths and licences: `.reference/agent-token-efficiency/aider` at
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`, Apache-2.0 (`LICENSE.txt`), and
`.reference/merge-queues/bors-ng` at `ca725797e53a88e954998de0bbb14a8a5acb13ab`, Apache-2.0
(`LICENSE-APACHE`). The paths above are relative to the main checkout. Other links are official published
documentation, not code licensed for incorporation. The recommendation implements patterns in Bun, SQLite,
Git and the existing check runners; it proposes no copied upstream files or passages.

The shared patterns are small independently attributable changes, explicit coordination, checks of a precise
combined state, and invalidation when that state changes. Established trunk practice supports shortening
integration distance. It does **not** establish that an unrestricted shared working tree is safe at this
repository's concurrency. The extra fencing below is a pilot hypothesis to test.

## Proposed workspace protocol

### Admission and editing

1. Create one disposable workspace outside the main checkout, on `web/shared`, with a workspace identity,
   generation number and recorded `dev` base. Install dependencies once per lockfile/toolchain version.
   Keep the main checkout read only. Exclude stabilize-target tasks, backend risk areas, dependency upgrades
   and control-plane modifications from the first pilot.
2. Treat declared paths as the initial reservation request, not a permanent scope fence. Resolve glob,
   directory, ancestor and exact-file overlaps conservatively, including future file creation. A directory
   reservation excludes its descendants; renames reserve both endpoints. Retain existing risk ownership.
   A needed adjacent correction obtains an additional reservation before editing and retains its checks
   and owner notification. No reservation opens an undeclared risk area.
3. Grant all required reservations atomically, in a canonical order, to an attempt and generation. Queue an
   overlapping writer without launching a model. Do not let workers hold half a reservation set while waiting
   for the rest. Expand dynamically only if conflict-free; otherwise checkpoint, release and requeue.
4. Reserve hot shared files for one writer at a time. For README updates and locale additions, workers may
   submit owned fragments under their private `.temp` directories to a queued editor. Apply semantic changes
   under the same reservation and attribute them to the requesting task. Fixture adapters, recordings and
   tests stay together when their contract requires an atomic change. No simultaneous hunk ownership.
5. Make generators controller-owned operations with named input/output sets: route trees, locale output,
   recordings, check-timing files, manifests and lockfiles. Run on a sealed input snapshot, serialize writes
   to each output set, and record the generator revision and resulting hashes. Generator output is evidence
   for its input tree, never a generic exemption from scope or frozen-file checks.

Enforcement must precede concurrent admission. Each worker sees the shared source read only in a process
mount namespace; only exclusively leased directory subtrees may be writable bind mounts. Mixed directories
with file-level reservations use a controller edit API with expected preimage hashes and generation tokens.
This supports atomic-save editors without pretending a file bind mount permits safe directory replacement.
All `.git` writes and repository credentials belong to the broker; arbitrary worker shell commands cannot
write them. Private scratch, logs and caches are per attempt. Dependency cache hardlinks remain read only.

Prompts, Git's `index.lock`, post-edit watchers and command-name denylists cannot enforce this boundary.
A lease expiry does not revoke an already-mounted writable directory. Stop and verify the old attempt's
process group before reassigning it; retain existing PID/start-identity checks and stale-attempt fencing.
Until that runtime boundary exists, use a single editable worker per workspace or keep isolated worktrees.

### Commits and checks

Workers request commits of their finished work through the broker; the resulting commit is theirs.
The broker serializes all index/HEAD mutations with a workspace lock, verifies the current attempt token,
freezes its reserved paths briefly, and formats only those paths. It stages explicit literal paths, including
new files and deletions, and makes a path-limited commit. Verify the staged and committed path lists and
frozen hashes; reject unrelated paths. Record source commit, parent, tree, task, attempt and file hashes.
No worker uses `git add -A` without paths, `commit -a`, global stash, reset, clean, checkout or rebase.
Hooks must also respect this boundary. A clean index is a broker invariant; peer unstaged files may exist.

The commit is **prepared**, not integrated or accepted. Its snapshot contains committed predecessors and
this task's changes, excluding peers' unfinished edits. Invoke the task's named acceptance once after its
last relevant edit, plus the root typecheck, through a snapshot-aware check wrapper. Existing tests and
frozen files retain their contracts. Include checks for adjacent changes and declared generator inputs.
Keep the existing shared heavy-check admission; queued checks wait without waking a model.

Use bounded disposable check snapshots, at most two in the pilot, rather than a permanent checkout per task.
Namespace build output, Vite caches, generated files, test probes, ports and databases by snapshot/run.
`apps/web/package.json` runs generation during typechecking, and `scripts/check.ts` writes timings; these
cannot execute against the live editable tree. Promote intentional generated output through the broker.
Live preview and tests against peer dirty files may guide development but cannot produce acceptance receipts.

A receipt names the exact source tree, command/test selection, contract and frozen hashes, dependency and
toolchain versions, environment fingerprint, exit status and logs. Reuse it only for the same validated
state and compatible environment. If a parent, generator input, shared dependency or target tree changes,
invalidate the affected receipt. Unknown dependency changes invalidate conservatively. A task may observe
peer unfinished code, but cannot finish by depending on it: the sealed snapshot must contain the dependency.

### Reaching dev

| Option                                                | Consequence                                                                                                                                                                                                           | Assessment                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Workers commit directly to checked-out `dev`          | Commit advances `dev` before post-commit checks; other train writers can advance its ref without updating that working tree/index. Safe operation requires every writer to use one broker and checked-state protocol. | Possible later, with a controller gate before publishing each candidate; largest disruption to current train and recovery assumptions. |
| Shared `web/shared`, train integrates sealed prefixes | One web source branch and immutable batch candidate; external Goals still use the train. Keeps pending work out of `dev`, but retains one integration boundary and cross-Goal conflicts.                              | Recommended pilot. Bound branch age and batch size; a permanent web fork would recreate the original problem.                          |

Seal after three ready commits or five minutes from the first ready commit, whichever comes first.
Allow one pending batch and three unfinished owners; pause admission when those bounds are reached.
The time bound triggers submission, not a promise that scarce check slots finish within five minutes.
Preserve one commit per worker; enqueue the ordered commit/task manifest as one batch, not three unrelated
branch diffs. In a train snapshot merge the sealed prefix with the captured current `dev` head. Run the
union of members' acceptance commands, affected checks, generation validation and root typecheck on that
**exact cumulative candidate**, reusing compatible receipts only when their checked state is unchanged.
Do not add a full web or workspace check unless a member's contract requires it.

Publish with an expected-old-head compare-and-swap through the train's existing lease and attempt fences.
If `dev` changes, construct and check the new combined tree; never publish the old receipt against it.
After two candidate rebuilds, park publication until a controller-coordinated integration window.
The batch receipt identifies all covered tasks and the candidate commit. Mark them integrated only after
publication; `main` promotion still runs its existing gates. Batching amortizes integration work; it does
not remove correctness checks or the serial ref update.

Bring external `dev` changes back into the shared workspace once per batch generation. At a controller
barrier, pause new edits, drain existing write operations and checkpoint each unfinished owner's patch,
untracked files and preimages. Remove only those checkpointed edits, merge the new `dev` into the clean
shared branch, then reapply each owner's patch with preimage checking and issue new generation tokens.
Retain commits and mappings; avoid rewriting each worker branch. A failed reapplication stays preserved
and goes to its owner for resolution, with competing writes held. No dirty-tree global reset or stash.
Drain snapshot checks independently so a queued check never holds the workspace mutation lock.

## Attribution and recovery

Retain separate states for editing, prepared commit, checked snapshot, batch queued, integrated and
promoted. Attribute a path delta to its reservation owner relative to that commit's parent, not the task's
original base or the whole shared tree. Attribute generated deltas to their requesting input changes.
Preserve source commit and integrated candidate separately; a shared branch tip is not one task's work.

Compare a failing check with the exact previous accepted base under the same environment. An existing
failure remains a baseline failure; an infrastructure failure remains unverified. For a new batch failure,
test ordered prefixes or split the batch with explicit dependency closure. Removing a predecessor
invalidates dependent receipts. If two individually passing changes fail together, record an interaction
and notify both owners; do not automatically blame the final committer or replace every attempt.

Freeze publication of a failing batch while independent editing can continue within reservations.
Correct or compensate for a bad prepared commit at a workspace barrier, preserving later owners' patches;
never reset the live shared tree to an earlier commit. Revocation first blocks broker requests, then stops
the identified old process groups, snapshots their owned changes and releases reservations. A terminated
worker's unrelated files and other workers' processes are outside cleanup authority.

Persist an operation journal before touching Git: expected parent, target tree, attempt tokens and batch
membership. Git ref mutation and SQLite publication are not one crash-atomic transaction. On restart,
reconcile the journal with Git's actual ref and commit manifest before resuming grants or marking tasks
integrated. A commit published before a crash must not be duplicated or charged to another attempt.

## Required control-plane changes

These are future implementation work, not modifications made by this report.

| Boundary                                                  | Existing assumptions to change                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/goal/src/types.ts`, `config.ts`, SQLite migrations | Add opt-in workspace mode, workspace/generation, reservations, source commit ownership, check receipts, batch membership and operation journal. Preserve isolated mode and historical records.                                                                      |
| `tasks.ts` dispatch/retry                                 | Replace per-task worktree/install with reservation admission; cover glob and directory overlap. Current `earliestSharedWriter` handles only identical concrete non-derived paths. Replace whole-tree `commitFinishedWork` and retry-leftover staging for this mode. |
| `launch.ts`, `process.ts`, `store.ts`                     | Launch within the write boundary, private scratch and process identity; fence edits, commits and checks as well as landing. Preserve atomic attempt replacement and verified process termination before regrant.                                                    |
| `scripts/worker-check.ts`, web generation/check runners   | Resolve a check to its immutable candidate; persist tree and environment identity, queue/start/end and generated outputs. Avoid live-tree mutations and shared caches/probes. Keep host-slot admission independent of worker admission.                             |
| `merge-train.ts`, landing queue, integration plans        | Accept an ordered web batch, merge once against current `dev`, select checks over its full delta, map each task and compare-and-swap once. Recheck every member's current fence at publication.                                                                     |
| Settlement, evidence and promotion                        | Capture owned patches, not the full workspace; distinguish baseline, interaction, worker and transport failure. Preserve per-task frozen hashes and main-promotion coverage of the actual integrated batch.                                                         |
| Cleanup and telemetry                                     | Reference-count workspace/snapshot leases; cap retained snapshots by count and unique bytes; clean only owned expired resources. Record stage durations, lock waits, reapplications, retries and accepted outcomes.                                                 |

### Cost: reserve and commit

- Touches: requested canonical paths, overlapping active reservations, one attempt token and one workspace head.
- Bound: at most three active workers and the pilot contract's finite path set; indexed active reservations,
  not a scan of historical tasks. The Git mutation lock covers capture/commit only, never checks or model work.
- Growth check: before admission, measure rows examined and lock time with 10, 100 and 1,000 unrelated ended
  tasks and independent reservation churn; hold the selected path set fixed. These are proposed validations.

### Cost: validate and integrate

- Touches: at most three batch members, their cumulative delta, conservative dependent checks and current `dev`.
- Bound: two check snapshots and one publishing transaction; generators declare finite input/output sets.
  Existing host slots bound heavy execution. Conflicts and moved heads create visible, bounded retries.
- Growth check: at the same three unrelated-history scales, record selected commands, snapshot bytes, native
  queue events and retry count. Increased unrelated history must not expand task enumeration or check selection.

### Cost: revoke and recover

- Touches: one attempt's identified process groups, reserved paths, journal and referenced snapshots.
- Bound: owned resources only; expired leases do not authorize a repository-wide cleanup or process search.
- Growth check: independently grow unrelated workspaces and retained history at three scales; confirm identical
  touched paths/processes and unchanged broker-operation bounds. Measure unique retained bytes separately.

## Expected gain, risks and pilot decision

An intentionally conservative planning scenario recovers **25–50%** of the 121.79 hours associated with
confirmed rebase rejections: **30.45–60.89 worker-hours**, or **7.57–15.13%** of the 402.47-hour ended web
budget before new coordination costs. Under the same cohort-proportional assumption, the usage opportunity
is **7.18–14.36 million uncached input** and **1.60–3.20 million output** tokens. These are scenarios, not
measured savings or allowance predictions. Existing patches often survive retries, and required checks,
cross-Goal merges and real contract conflicts remain. The theoretical full 30.26% recovery is not a forecast.

For the recent passing cohort, halving the **36.24-minute mean landing queue** would save about **18 minutes
per integration**, without assuming any faster checks. Direct publication could remove that queue but
would add its own validation and commit queue. The batch option must demonstrate the reduction; the current
train already supports batching. Initial setup has only 28 measured minutes to recover across the entire
history. Storage changes from one editable checkout per dispatched task to one shared checkout plus bounded
check snapshots; the byte saving must be measured rather than inferred from the historical worktree count.

The principal risks are overwritten unfinished work, stale writers after retry, commits containing peer
changes, speculative dependencies, generated output racing with edits, interaction failures, hot-file
serialization, and the workspace becoming a common failure domain. Reservations, a real write fence,
snapshot checks and checkpoint recovery address these mechanisms. They add implementation cost and can
reduce concurrency. A shared tree does not resolve product disagreements or a saturated check fleet.

Run **six small web tasks in two waves of three** after controller safety acceptance. Choose independent
page/component changes, one queued shared fixture/recording update, and one route/locale change exercising
generation. Predeclare contracts and a matched six-task isolated-worktree baseline of similar changed
files and test commands; use the same model profiles, host admission and definition of accepted outcome.
Do not expand into backend risk areas for this experiment.

Before real workers, controller acceptance must exercise simultaneous disjoint commits, overlapping exact
and glob reservations, new/deleted/renamed paths, frozen-file protection, dirty-peer exclusion from checks,
generator serialization, stale-token rejection, forced worker exit and recovery, crash after ref update,
and external `dev` movement during validation. Assert byte preservation of an innocent worker's unfinished
files throughout. These tests belong in the later implementation contract; the research acceptance is this report.

Record per task and batch: creation/admission/edit/check/commit/integration/promotion timestamps; check-slot
and path-lock waits; snapshot tree and receipt identities; conflict/reapplication reason; attempt and
replacement counts; preserved versus redone patches; uncached/cached/output usage deltas; unique checkout
bytes, peak snapshots and leftover resources. For actual allowance comparison, isolate a provider window
from unrelated activity or obtain per-run attribution; otherwise report it unavailable and retain token
components separately. Never sum overlapping before/after allowance observations.

Keep the option provisionally only if all six tasks integrate and promote with unchanged acceptance, no
lost/foreign edits or stale publication, at most two retained check snapshots, at least **50% less rebase
rework per accepted task**, and at least **15% lower median ready-to-integration latency**, without increased
worker-hours or measured allowance per accepted task. Require p90 path-lock wait below ten minutes and no
increase in check executions per accepted task. Include failed and abandoned attempts in costs. If the
matched baseline has zero rebase rework, that criterion is inconclusive, not a pass.

Six tasks establish safety and operability, not a reliable causal performance estimate. If results are
promising but allowance or gains remain unmeasurable, extend a controlled alternating trial before general
adoption. Any lost edit, foreign commit or stale fence is an immediate stop to shared admission: checkpoint
all owners, finish or recover their work in isolated trees, and retain evidence. Long shared-file queues
or unchanged rework favour improving reservation scheduling while keeping isolated checkouts.

If adopted, put the protocol in `tools/goal/README.md` and update `docs/development/delivery.md`,
`verification.md` and `efficiency.md` before dispatching dependent work. This report remains evidence.

## Reproducing the measurements

All database queries use `sqlite3 -readonly`; live counts will advance. The local scratch directory contains
the snapshot, JSON extracts, `analyze.py`, `metrics.txt`, `setup.json` and `log-inventory.json`. Query the
snapshot for the exact cutoff; the following recipes also work against the live source with changed totals.

```sh
sqlite3 -readonly /home/edge/projects/rezics/rezics-next/.temp/goal/goal.sqlite \
  ".backup '.temp/web-shared-workspace/snapshot.sqlite'"
sqlite3 -readonly .temp/web-shared-workspace/snapshot.sqlite
```

```sql
-- Scope and whole-attempt cost. Classify passes before interpreting escalation.
WITH web AS (
  SELECT id FROM worker_tasks WHERE json_extract(body,'$.brief.goal')='web'
)
SELECT json_extract(r.body,'$.outcome') AS outcome,
       count(*) AS attempts,
       sum((julianday(json_extract(r.body,'$.endedAt')) -
            julianday(json_extract(r.body,'$.startedAt')))*24) AS hours,
       sum(json_extract(r.body,'$.tokens.input') +
           json_extract(r.body,'$.tokens.output')) AS raw_tokens
FROM worker_records r JOIN web ON web.id=r.task_id GROUP BY outcome;

-- Use actual stage, including rebase failures escalated as specification conflicts.
SELECT e.task_id,e.attempt,e.at,
       json_extract(e.body,'$.logPath') AS log_path,
       json_extract(e.body,'$.conflictedFiles') AS conflicts,r.body AS record
FROM worker_events e JOIN worker_tasks t ON t.id=e.task_id
JOIN worker_records r ON r.task_id=e.task_id AND r.attempt=e.attempt
WHERE json_extract(t.body,'$.brief.goal')='web' AND e.kind='gate-outcome'
  AND json_extract(e.body,'$.passed')=0 AND json_extract(e.body,'$.stage')='rebase';

-- Queue minutes; retain task/attempt to avoid pairing different retries.
SELECT e.task_id,e.attempt,e.at,
       ((julianday(e.at)-julianday(q.at))*86400000 -
         json_extract(e.body,'$.hostMs'))/60000 AS queue_minutes,
       json_extract(e.body,'$.hostMs')/60000.0 AS train_minutes,
       json_extract(e.body,'$.passed') AS passed
FROM worker_events e JOIN worker_tasks t ON t.id=e.task_id
JOIN worker_events q ON q.task_id=e.task_id AND q.attempt=e.attempt
  AND q.kind='landing-requested'
WHERE json_extract(t.body,'$.brief.goal')='web' AND e.kind='gate-outcome';

-- Resolve the anonymized language case to its local evidence without storing task IDs here.
SELECT a.task_id,a.attempt,json_extract(a.body,'$.evidencePath') AS evidence_path
FROM worker_attempts a WHERE a.task_id=(
 SELECT task_id FROM worker_events WHERE kind='gate-outcome'
 AND json_extract(body,'$.logPath') LIKE '%/landing-2065.log' LIMIT 1
);
```

For the successful cohort, take each task's passing event and sum records through its winning attempt;
preceding records have a lower attempt number. Filter record `taskClass='interface'` for the interface
cohort. Percentiles use nearest rank. To reproduce setup, read each web task's `branch` and `createdAt`,
then the first line of `<git-common-dir>/logs/refs/heads/<branch>`; require its zero old-object ID and use
its reflog timestamp, not the referenced commit's author date. Read that branch's matching task creation
time and subtract. Reflogs and landing files are auxiliary evidence outside the SQLite snapshot and may
eventually expire; the numerical findings above preserve this investigation's observations.
