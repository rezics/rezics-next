# State

The supermanager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-12 16:30 UTC) |
| --- | --- |
| Manager | None. The maintainer starts one ([GOAL.md](GOAL.md#starting)). No delivery Goal has a manager |
| Running | Nothing. Every worker, every manager session, the shell waiter and the coordinator service were stopped on the maintainer's order; the coordinator is disabled, so nothing wakes by itself |
| Tree | One branch (`main`) and the archive (`archive/goals`); no worktree but the shared stack's staged revision; no open task, no brief |
| Unmerged work | 54 branch tips kept under `refs/archive/2026-10-12/` (`git for-each-ref refs/archive/2026-10-12`). The new Goals' state files say what each is and what it lacks |
| Archive | `archive/goals` holds the kernel, trust-ops and launch Goals of 2026-10-06 with their briefs and handoffs; `program-2026-10-06/study-2026-10-12/` has the efficiency research with its sources, the measured causes, the review findings of the whole run as data, the three managers' end-of-run tables, the supermanager's scripts and notes, and the reports sent to the maintainer; `architecture-review-2026-10-07/` has the evidence behind the target architecture |
| Not verified | No main-wide integration or fault/recovery run was made on the final `main`; the retained seed set does not restore there. Unit gates passed for each merge. This is the first thing to establish |
| Allowances | Claude: managers only (maintainer, 2026-10-12); the week began on 2026-10-12 at about 15:00 UTC. Codex `codex` 86% used, resets about 2026-10-18 07:00 UTC; `codex-1` 82% used, resets about 2026-10-19 05:00 UTC. Grok reset on 2026-10-12; Cursor unknown. No top-up, no reset credits |
| Capacity settings | `.temp/goal-orchestration/`: QA slots 8, gate lanes 4, regress lanes 3, review engine `codex-1` |

## After a cold start of the host

The maintainer powered the host off after this state was written.

1. `systemctl --user start docker-desktop`, then wait until `docker info` answers.
2. In the main checkout, `task dev` (it starts the Aspire AppHost; `task urls`
   lists the addresses). The backend serves the revision of the last refresh.
3. `task dev:refresh -- --wait` when `main` has moved. Its last step (re-approve
   the official Zones) failed twice on 2026-10-12 within seconds of the restart
   on a rate-limit refusal; run it again once the stack has been up a minute.
   After a refresh that changes the native image's prefix schema, run
   `task search:rebuild` with writers stopped and start Account, Main and the
   relay again ([search index](../../operations/search-index.md)).
4. The host's third swap device (`zram2`, 16 GiB) does not survive a restart;
   add it again before running more than about fifteen workers.
5. `systemctl --user enable --now goal-coordinator.service` once a manager is to
   be woken by it.
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
