# State

The supermanager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-13 10:52 UTC) |
| --- | --- |
| Run | Running since 09:39 UTC on 2026-10-13: the maintainer started the supermanager in termspaces (`rezics-agents`, window `super-manager`) and asked it to launch the whole Goal. It was paused from about 05:39 UTC |
| Running | Six workers, each with `land: auto` and one background `wait` held by the supermanager. api: G-2122 (the first row's implementation, third step: the persona stack runs the relay as production does; `codex`; waited on with `GOAL_ID=api`). program: G-2123 (N8, wide test runs admitted by the tool, `codex-1`), G-2124 (N10: `dispatch` stages references, the prompt carries the brief, `engine: sol` chooses the account, stray writes are named; `codex-1`), G-2125 (N10: a refused landing goes back to its worker as the failure alone, `codex`), G-2126 (N4: termspaces windows as a view of the ledger, `codex`), G-2127 (the efficiency command reads only its window, `codex-1`). G-2112 is exited and open: it holds the harness's files for the program and lends them to G-2122; close it as verified when G-2122 has landed. The coordinator service is stopped and disabled and no manager is enrolled; `task goal -- settle` has not yet run on the real ledger (predicted from the ledger: it marks the 22 paused tasks settled with their reasons and lands none, since none has a `done` handoff) |
| Managers | The supermanager only, registered as `supermanager`. The api and web managers of 2026-10-13 were Sol sessions `01a13389` (`~/.codex-1`) and `01a13391` (`~/.codex`); their checkpoints are [api](../api/state.md) and [web](../web/state.md), and nothing needs those sessions |
| Scope | 0 of 67 rows proved; 6 cells pending, 396 missing. The first row is `books/catalogue-browse-and-search-in-its-zone`. Its cause was proved by one probe (G-2112's note, `.temp/goal-orchestration/runs/G-2112/attempt-2.last.md`): the persona harness started nothing of what the production entry starts. On `main` now: Main owns one lifecycle and the harness runs it (a persona stack's first call went from 6.3 s to 7.0 s). Still failing, and decided in G-2122's brief: a publication after the reader started reaches browse only through Main's relay, so the persona stack initialises and runs the relay as production does (`relay-init.ts`, then the relay entry); and the test asked `relevance` without a query, which the API rightly refuses with 400 `unsupported_query_shape`, so the test asks it only with a query and asserts the refusal. Other harnesses that compose Main without the lifecycle: `media-support.ts`, `zone-realm-discussion-lookup.test.ts` |
| On `main` | Persona cells and `outcomeTest`; `tests/qa/support/personas.ts`; `dispatch`, `land` and `resume` enforcing the method; measures in `status`; `coordinator start`; mail with sender and deadline; `regress --nightly`. `coordinator start` has not been run on a real Goal |
| Open tasks | program: G-2112, G-2123 to G-2127. api: G-2122 and the 22 below. Landed on 2026-10-13, each in one or two attempts: G-2113 (N2, `goalctl.ts` split over 13 modules), G-2114 (N9, Telegram notices), G-2116 (a command is a file in `scripts/goal/commands/`), G-2115 (`task operation -- <query>`, half of N5), G-2118 (`task goal -- check`, first part of N10; `tests:` in a brief), G-2119 (N3: a manager turn is fresh, bounded at ten minutes, up to six side by side, recorded; `coordinator turns`), G-2120 (N3: `task goal -- settle` and the pump settle exited tasks), G-2117 (N11: `task goal -- efficiency`), the first step of G-2112 and the first two of G-2122 (Main's one lifecycle in `services/main/src/lifecycle.ts`, run by the entry and by the persona harness). `docs/goals/worker.md` names `check` and `task operation`. api: 22, kept with their worktrees and sessions (three Books drafts refused at their first merge, 15 matrix tasks before step two, the load-set rebuild merged and incomplete, three design notes read). web: 2 (one guard refused for scope, one merged). Their state files list each |
| For the api resume | G-2112 proves `books/catalogue-browse-and-search-in-its-zone` with that row's two files on loan from G-2075, which drops the row. G-2077 keeps its change to `tests/qa/support/personas.ts` and needs the file in its claim; the program agrees to that in its area. A declaration and a test import `scripts/qa/cases/outcome-cells.ts`, not `outcomes.ts`. G-2077's branch has one more commit that returns `personas.ts` to `main`'s version, so the file is free; the line it needed (an `idempotency-key` the caller passes is sent on any method) lands with G-2122, and G-2077 gets it when it rebases. Main's source and tests are the api Goal's area: a task that changes both them and the harness is an api task, and the program's open task that claims the harness files lends them (an unclaimed file in another Goal's area cannot be lent) |
| Regression | `task goal -- regress` on `main` d2a2e3166, run `20261013t043515-585e9a`: all 264 batches done at 09:51 UTC, 329 of 2,168 files failed (unit 14, owner 50, jena 1, integration 233, fault/recovery 31; 13 fault/recovery files not run). It is in its diagnosis phase, bounded at two hours (to about 11:35 UTC), and routes entries to the program's inbox. A script clustered the failures by first error line into 189 clusters (`.temp/goal-program/regress/clusters.py`, `clusters.md`); 58 files sit in clusters that are only a matcher, 145 clusters hold one file. Largest named causes: reconciliation not finishing (about 29 files), 503 or unavailable reads (about 40 files, the same cause as the Books row may explain part), `invalid_zone_configuration` on Zone publication (11), request cost contracts exceeded (12), disclosure batches (9), the retained load set (8). The run's own classifier marks 315 of the 329 as `deadline`, and only 7 have a timeout signature: a defect for N7. Reading the clusters into pending cells and tasks follows the run's end. End the server it runs in afterwards (`tmux -L goal kill-server`) |
| Allowances | Claude: managers only, and quantity is not the limit (maintainer, 2026-10-13). Codex: both accounts reset on 2026-10-13 at about 04:58 UTC; about 1% of the new week used. Service tier `default`. No top-up, no reset credits |
| Efficiency audit | First reading by the command, sessions begun 09:30 to 10:46 UTC on 2026-10-13: 13 worker sessions, 687 steps, 57.5M input tokens (97% cached); by step: wait 28%, read 24%, test 20%, edit 16%, other 6%, think 3%, commit 3%; steps with no decision 51%; Sol 9 sessions at 2.7M tokens a turn, Luna 4 at 4.5M; no session past 150 steps; dearest G-2115 (Luna, 96 steps, 10.4M). `check` landed at 10:34 UTC, so this is the figure before it. The command took 165 s (G-2127 bounds it). The audit by a researcher is due at 12:40 UTC; record with `task goal -- efficiency --record` then |
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
