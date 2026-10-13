# State

The supermanager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-13 07:45 UTC) |
| --- | --- |
| Run | Paused since about 05:39 UTC on 2026-10-13 at the maintainer's order. The plan for the next start is in [GOAL.md](GOAL.md); its first work is tasks N1 and N2 |
| Running | No worker, no manager turn, no watcher. The coordinator service is stopped and disabled and no manager is enrolled |
| Managers | None. The maintainer starts the supermanager in termspaces ([GOAL.md](GOAL.md#starting)). The api and web managers of 2026-10-13 were Sol sessions `01a13389` (`~/.codex-1`) and `01a13391` (`~/.codex`); their checkpoints are [api](../api/state.md) and [web](../web/state.md), and nothing needs those sessions |
| Scope | 0 of 67 rows proved; 402 persona cells missing (`task goal -- status`). All 67 rows have a persona matrix, read and corrected by the api manager, in 18 briefs |
| On `main` | Persona cells and `outcomeTest`; `tests/qa/support/personas.ts`; `dispatch`, `land` and `resume` enforcing the method; measures in `status`; `coordinator start`; mail with sender and deadline; `regress --nightly`. `coordinator start` has not been run on a real Goal |
| Open tasks | program: none. api: 22, kept with their worktrees and sessions (three Books drafts refused at their first merge, 15 matrix tasks before step two, the load-set rebuild merged and incomplete, three design notes read). web: 2 (one guard refused for scope, one merged). Their state files list each |
| Regression | `task goal -- regress` on `main` d2a2e3166, run `20261013t043515-585e9a`, started 04:35 UTC and still running at 08:21 UTC. Reading it is task N0. Files failed at 08:21 UTC: 14 unit, 50 owner, 1 jena and 172 of the 555 integration files run; 201 integration and 80 fault/recovery files have not run. `main` is not green. Two things make part of that the run's own: it shared the host with up to 25 workers until about 06:00, and its tmux server inherited an agent's environment (`CLAUDECODE=1`). Cluster the failures by their first error line before any task is written; several unit failures are Zone tests, which fits the 400 on Zone publication. It runs in `tmux -L goal`, window `regress`, the last thing outside termspaces: end that server when the run is over (`tmux -L goal kill-server`). `task goal -- regress --resume 20261013t043515-585e9a` continues it after a stop |
| Allowances | Claude: managers only, and quantity is not the limit (maintainer, 2026-10-13). Codex: both accounts reset on 2026-10-13 at about 04:58 UTC; about 1% of the new week used. Service tier `default`. No top-up, no reset credits |
| Efficiency audit | Not run yet. The measuring script and its definitions are in `.temp/goal-program/efficiency/sessions.py`; the figures for 2026-10-11 and 2026-10-12 in [GOAL.md](GOAL.md#what-two-runs-showed) are its baseline. The first audit is due three hours after workers start again |
| Capacity settings | `.temp/goal-orchestration/`: QA slots 8, gate lanes 4, regress lanes 3, review engine `codex-1` |

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
