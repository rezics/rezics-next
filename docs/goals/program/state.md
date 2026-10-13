# State

The supermanager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-13 10:23 UTC) |
| --- | --- |
| Run | Running since 09:39 UTC on 2026-10-13: the maintainer started the supermanager in termspaces (`rezics-agents`, window `super-manager`) and asked it to launch the whole Goal. It was paused from about 05:39 UTC |
| Running | Seven workers, each with `land: auto` and one background `wait` held by the supermanager. program: G-2115 (the operation index, half of N5, `luna`), G-2117 (N11, the efficiency command, `luna`), G-2118 (N10, one blocking `check`, `codex-1`), G-2119 (N3: fresh, bounded manager turns side by side, `codex-1`; it borrows one call in `goalctl.ts`), G-2120 (N3: the coordinator settles exited tasks, `codex`; it borrows two places in `scripts/goal/manager-commands.ts` from G-2119). api: G-2122 (the first row's implementation, `codex`; waited on with `GOAL_ID=api`). G-2112 is exited and open: it holds the harness's files for the program and lends them to G-2122. The coordinator service is stopped and disabled and no manager is enrolled |
| Managers | The supermanager only, registered as `supermanager`. The api and web managers of 2026-10-13 were Sol sessions `01a13389` (`~/.codex-1`) and `01a13391` (`~/.codex`); their checkpoints are [api](../api/state.md) and [web](../web/state.md), and nothing needs those sessions |
| Scope | 0 of 67 rows proved; 6 cells pending, 396 missing. The first row (`books/catalogue-browse-and-search-in-its-zone`) has its declaration and six tests on `main`; every persona gets 503 `work_read_unavailable` from browse. G-2112's design note proved the cause with one probe (503 before, 200 after the one missing reader starts, ready in 1.3 s): the persona harness composes Main in process (`tests/qa/support/personas.ts:166`) and starts nothing of the 22 things the production entry starts (`services/main/src/index.ts:43-106`). Decided: Main owns one lifecycle that its entry and the harness both run; no worker list in the harness, no readiness sleep, a test waits by repeating the persona's own request under a deadline. G-2122 builds it and marks the six cells proved. The note is `.temp/goal-orchestration/runs/G-2112/attempt-2.last.md`; it names `media-support.ts` as a second harness that composes Main the same way |
| On `main` | Persona cells and `outcomeTest`; `tests/qa/support/personas.ts`; `dispatch`, `land` and `resume` enforcing the method; measures in `status`; `coordinator start`; mail with sender and deadline; `regress --nightly`. `coordinator start` has not been run on a real Goal |
| Open tasks | program: G-2112, G-2115, G-2117 to G-2120. api: G-2122 and the 22 below. Landed on 2026-10-13: G-2114 (N9, `scripts/goal/notify.ts`; the first real notice went out at 10:01 UTC), G-2113 (N2, `goalctl.ts` is 157 lines over 13 modules; the tool's test files pass on `main` after it, 511 tests), G-2116 (a `goalctl` command is a file in `scripts/goal/commands/`; `ask`, `tell`, `decide`, `decisions`, `flush` are the first five), G-2112's first step. api: 22, kept with their worktrees and sessions (three Books drafts refused at their first merge, 15 matrix tasks before step two, the load-set rebuild merged and incomplete, three design notes read). web: 2 (one guard refused for scope, one merged). Their state files list each |
| For the api resume | G-2112 proves `books/catalogue-browse-and-search-in-its-zone` with that row's two files on loan from G-2075, which drops the row. G-2077 keeps its change to `tests/qa/support/personas.ts` and needs the file in its claim; the program agrees to that in its area. A declaration and a test import `scripts/qa/cases/outcome-cells.ts`, not `outcomes.ts`. G-2077's branch has one more commit that returns `personas.ts` to `main`'s version, so the file is free; the line it needed (an `idempotency-key` the caller passes is sent on any method) lands with G-2122, and G-2077 gets it when it rebases. Main's source and tests are the api Goal's area: a task that changes both them and the harness is an api task, and the program's open task that claims the harness files lends them (an unclaimed file in another Goal's area cannot be lent) |
| Regression | `task goal -- regress` on `main` d2a2e3166, run `20261013t043515-585e9a`: all 264 batches done at 09:51 UTC, 329 of 2,168 files failed (unit 14, owner 50, jena 1, integration 233, fault/recovery 31; 13 fault/recovery files not run). It is in its diagnosis phase, bounded at two hours (to about 11:35 UTC), and routes entries to the program's inbox. A script clustered the failures by first error line into 189 clusters (`.temp/goal-program/regress/clusters.py`, `clusters.md`); 58 files sit in clusters that are only a matcher, 145 clusters hold one file. Largest named causes: reconciliation not finishing (about 29 files), 503 or unavailable reads (about 40 files, the same cause as the Books row may explain part), `invalid_zone_configuration` on Zone publication (11), request cost contracts exceeded (12), disclosure batches (9), the retained load set (8). The run's own classifier marks 315 of the 329 as `deadline`, and only 7 have a timeout signature: a defect for N7. Reading the clusters into pending cells and tasks follows the run's end. End the server it runs in afterwards (`tmux -L goal kill-server`) |
| Allowances | Claude: managers only, and quantity is not the limit (maintainer, 2026-10-13). Codex: both accounts reset on 2026-10-13 at about 04:58 UTC; about 1% of the new week used. Service tier `default`. No top-up, no reset credits |
| Efficiency audit | Not run yet. The measuring script and its definitions are in `.temp/goal-program/efficiency/sessions.py`; the figures for 2026-10-11 and 2026-10-12 in [GOAL.md](GOAL.md#what-two-runs-showed) are its baseline. The first audit is due at 12:40 UTC on 2026-10-13, three hours after the workers started |
| Capacity settings | `.temp/goal-orchestration/`: QA slots 8, gate lanes 4, regress lanes 3, review engine `codex-1` |
| Tool findings to brief | Found on 2026-10-13 while launching. (1) Workers run with no sandbox, and G-2115's worker wrote two files into the main checkout before writing them in its worktree; they were identical, are set aside in `.temp/goal-program/stray-g-2115/` and removed. Nothing detects such a write, and it would refuse the task's own landing. (2) A reference file can be staged only after `dispatch` has started the worker; G-2117 looked 40 seconds too early and stopped as blocked. `dispatch` should take the references (N10's first part). (3) A task whose last step was read-only after a merged step cannot close as verified (in G-2120). (4) The regression's classifier calls 315 of 329 failures `deadline`, and 7 have a timeout signature (N7) |

## What the run of 2026-10-13 showed

For the next plan. Figures are the managers' own counts where the tool's differ.

| Subject | Finding |
| --- | --- |
| Attempts | program: 6 tasks in 11 attempts, 6 first, 1 step, 4 fixes (one refused by a gate, one by a rebase, two sent back after I read the code), 60% first; api: 22 first, 8 step resumes, 2 fixes, 92%; web: 5 first, 3 fixes, 62% |
| The pilot found the seam | The three Books step-two drafts (11 rows, 66 candidate cells) did not land: a repository guard cannot resolve the loader's `pathToFileURL` import at `scripts/qa/cases/outcomes.ts:234` once a test imports a declaration, and one draft needed a change in `tests/qa/support/personas.ts`. The registry, the harness and the guards each passed alone and were never run together. First task of the next plan: one Books row proved end to end, by the program, before any other test is written |
| Width | Useful width was about 20 workers for ten minutes (the matrices), then the api manager read 18 matrices serially: three were resumed after 20 minutes and five more after 45. One manager reading every matrix is the limit of this design |
| Mail does not interrupt | The api manager worked in one turn for 37 minutes without reading its inbox, missed the wrap-up for six minutes and resumed five tasks after it. I ended its turn by signal and stopped the five. Mail needs a way to reach a manager inside a turn, or turns need a bound |
| Coordinator | It wakes within about two seconds of a mail. Enrolment by hand needed three corrections (service stopped, tmux server in its own scope, session id from the log); `coordinator start` replaces that and has not been run on a real Goal yet |
| Gate environment | A gate run from an agent session has `CLAUDECODE=1`; `bun test` then prints no passing test names. One landing was refused for that; the worker protocol now says so |
| Measures | `status` counted a fix after a `partial` handoff as a step. `resume` now records each attempt's round; `scripts/goal/measures.ts` still infers it and should read the record |
| One file, many tasks | Four tasks changed `scripts/goal/goalctl.ts` (6,300 lines) through loans; one did not rebase and cost a round. Split the file before the next tooling wave |
| Product facts met on the way | Publishing a Zone site returns 400 on `main` in a browser journey and in the seed helper; the recipes vertical has no passing signed-in journey; the retained load set still does not build (`Catalogue backups must stay in this checkout .temp`); the short-prefix typeahead's slow query is an identity read of about 0.58 s that the fence replays, inferred and not yet captured |
| The reset | The leftover of the old week (about 13% and 17%) was not used: I ramped up over twenty minutes and the reset came two hours early |

## After a cold start of the host

1. `systemctl --user start docker-desktop`, then wait until `docker info` answers.
2. In the main checkout, `task stack:up` (the Compose storage stack was stopped
   with its data kept), then `task dev` (the Aspire AppHost; `task urls` lists
   the addresses). The backend serves the revision of the last refresh, which
   succeeded on 2026-10-12 at 16:22 UTC at `main` 75409ac3c with native image
   `rezics/fuseki:6.2.0-cmd0.5.39-5bc9e305cb80`; only documents changed after it.
3. `task dev:refresh -- --wait` when `main` has moved. Its last step (re-approve
   the official Zones) failed twice on 2026-10-12 within seconds of the restart
   on a rate-limit refusal; run it again once the stack has been up a minute.
   After a refresh that changes the native image's prefix schema, run
   `task search:rebuild` with writers stopped and start Account, Main and the
   relay again ([search index](../../operations/search-index.md)).
4. The host's third swap device (`zram2`, 16 GiB) does not survive a restart;
   add it again before running more than about fifteen workers.
5. `termspaces doctor`, then `termspaces apply --autostart`: the sessions
   `rezics` and `rezics-agents` run on termspaces' own tmux server. Until
   `goalctl` registers windows there (task N4), a coordinator turn needs
   `GOAL_COORDINATOR_TMUX_SOCKET=/tmp/tmux-1000/termspaces`. Enable
   `goal-coordinator.service` only when a manager role is configured.
6. Ports 3000, 3001, 3002, 3004 and 8025 are forwarded to the tailnet
   (`tailscale serve status`); remove one with `sudo tailscale serve --tcp=<port> off`.

## Waiting for the maintainer

| Question | What is known |
| --- | --- |
| Windows | A read-only survey on 2026-10-12: file names, case and path lengths are clean; product code has three or four POSIX assumptions; the development and test tooling has about thirty files of process control and fifteen of Unix sockets; `.gitattributes` sets no line endings, which on Windows breaks the scripts run in containers and every digest computed from file bytes. Proposed order: measure on a Windows machine first, set LF, fix product code with a lint rule, put tooling behind one platform module. The Goal tooling stays on Linux (decided). No task exists until he approves |
| A merge of a Work under title control is refused | Whether it should be is a product question (the api Goal's later list) |
| Scaled ingredients of an old-format recipe show as the amount plus the original text | The supermanager's ruling of 2026-10-12; a one-line display needs another design |
| The tailnet address cannot sign in | Origins are bound to `127.0.0.1`; direct use needs the stack's origins changed and a full restart |

## What the stopped run measured

In the [method](../method.md#why). The supermanager's own failures that day, for
whoever holds this role next: it granted exceptions to the attempt cap by mail;
it classed audit findings as must-do because they were defects; it dispatched
implementers on a shared contract before its design was settled; it ran wide on
coupled files; it added checks to the gate without measuring them under load;
it ruled on code it had not read.
