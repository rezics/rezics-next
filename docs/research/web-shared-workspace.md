# A shared workspace for web workers

Research date: 2026-10-28. Repository baseline: `bc6c7eba7976422220c2fec1e572b9dce03ecd98`.
This report retains historical evidence. The Goal tooling README owns the adopted dispatch and delivery contract.

## Recommendation

The adopted shared-module protocol lives in [Goal tooling](../../tools/goal/README.md#shared-module-workspaces-opt-in).
Workers edit and commit concurrently in one module worktree. The train merges its branch into dev and uses commit
trailers for attribution. The earlier reservation, commit-queue, write-fence and snapshot proposal is superseded.

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
There were **zero recorded route-tree conflicts** in this sample. Typechecking also runs route generation; this sample does not show route-tree conflicts.

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
