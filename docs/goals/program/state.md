# State

The supermanager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-13 05:05 UTC) |
| --- | --- |
| Manager | `program`, an interactive Claude session started by the maintainer on 2026-10-13. It wakes on its own background waits and on Goal mail (`scripts/goal/next-event.sh program`) |
| Delivery Goals | `api`: manager `api`, GPT-6.1 Sol on `codex-1`; 18 outcome tasks cover all 67 rows in two steps (the persona matrix, read by the manager, then the declaration and tests), plus three design analyses and the load-set rebuild. `web`: manager `web`, Sol on `codex`, started for the four client-contract guards and the tests red on `main`; no surface task before a vertical is proved. Both are headless and enrolled with the coordinator (start messages in `.temp/goal-orchestration/managers/`). `operations`: not started |
| First tasks | On `main`: P1 (G-2070, 04:50 UTC), P2 (G-2071, 04:58), P4 (G-2072 step 1, 05:01), P6 (G-2088, 05:03). In work: P3 (G-2072 step 2), P7 (G-2073), P8 (G-2089). The tool now refuses a brief without `kind:`, reviews only implementation and mechanism tasks in sensitive paths, and refuses a third fix round without a dated decision |
| Decided for P1 to P3 | A row's proofs are one declaration file, `scripts/qa/cases/outcomes/<kind>/<slug>.ts`, with a cell for each persona: `proved`, `pending`, `notApplicable` or missing. `outcomeTest` runs a pending cell as an expected failure, so a test that starts passing is red until its cell says `proved`. That is how "fails on `main`" is checked without a run at dispatch, and why no two tasks share a registry file. Delivery Goals file each row's existing proofs under their personas; the program does not |
| Host | Cold-started on 2026-10-13: Docker, the storage stack, `task dev`, the third swap device and the coordinator service are up. tmux for manager wakes is its own server and scope: `tmux -L goal` (`goal-tmux.scope`) |
| Verified | One integration file passed on `main` d2a2e3166 in 11.9 s on a pooled stack, so the tier outcome tests run in works. `task goal -- regress` started at 04:35 UTC in `tmux -L goal`, window `regress` (log `.temp/program-regress.log`); the first main-wide run on the final `main` |
| Tree | `main` and the archive (`archive/goals`); 55 unmerged branch tips of the stopped run under `refs/archive/2026-10-12/` |
| Allowances | Claude: managers only. Codex: both accounts reset on 2026-10-13 at about 04:58 UTC (0% of a new 7-day window, next reset about 2026-10-20 05:00 UTC), two hours before the time codex-resets.com listed. Service tier `default`. Width is set by settled work and the measures, not by spending. No top-up, no reset credits |
| Capacity settings | `.temp/goal-orchestration/`: QA slots 8, gate lanes 4, regress lanes 3, review engine `codex-1` |

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
5. `systemd-run --user --scope --unit=goal-tmux -- tmux -L goal new-session -d -s goal-host`,
   then `systemctl --user enable --now goal-coordinator.service`. Enrolment is
   refused while the service runs and when the tmux server shares the enrolling
   shell's cgroup; stop the service, enrol with `--tmux-socket /tmp/tmux-1000/goal`,
   start it again.
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
