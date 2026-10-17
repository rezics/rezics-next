# Program checkpoint

Use `task goal -- status`, `coordinator status`, `planning` and the current
briefs for live task disposition and scope. This page retains decisions and
unverified obligations; it is not an operational run log.

Waves 1 to 3 are on main, and the operations, api and web Goals are closed.
Main's confirmation passed all 408 launch cells on 2026-10-16, and every
shared-capability exception in the inventory is repaired. The api and web Goals'
deferred findings, and the api Goal's retained-population checkpoint rebuild
procedure, are archived on `archive/goals` with their Goals. That rebuild is
still blocked before a fresh checkpoint; it gates growth checks only, not any
row. Every program task has landed, and main's final confirmation at `eedd958e26`
passed all 408 launch cells on 2026-10-16 with none failed or not run. The
completion criteria are met. The program stays open for the maintainer's
acceptance findings rather than closing at once.

Efficiency readings on 2026-10-16: 13.16 M worker input per main landing for
03:00–15:00, 7.65 M after the gate, harness and watcher repairs landed
(15:45–19:00), and 3.57 M while closing (19:00–22:00). Failed landing surface
gates fell from six to none. The largest remaining cost was discovering stale
test premises one run at a time, so workers now fix independent failures from
one run together. Confirmation stacks that lose a dependency service mid-run
left six catalogue cells unrun twice; that repair is open. The 12-hour reading
at 01:15 on 2026-10-17 was 5.76 M per landing. Its largest avoidable cost was a
returned round on that repair: a ranking run that crossed midnight UTC read an
empty current-day bucket, and the failure was taken for the branch's
regression. Ranking acceptance is being made independent of bucket boundaries,
and such a failure is now attributed to a branch only when it repeats there.

Shared capabilities are implemented once ([platform thesis](../../product/platform-thesis.md)).
The program inventories, across every in-scope vertical and source, the shared
owners that recognise a vertical or provider to do a generic job, such as Work
publication requiring the Recipe profile. Findings are grouped by cause, decided
in a design note, and repaired after wave/3 merges by generalising each owner and
migrating its callers together, without moving or renaming special cases. Proof
needs a non-Recipe consumer and a second source where that is the boundary.
Product-row coverage and shared-capability acceptance are reported separately,
and the unified-engine outcome is not complete while a known exception remains.

The supermanager handles program tooling and steers the delivery Goals'
remaining tasks directly. Delivery manager registration and mail state come
from the coordinator.

## Operating decisions

Use the pinned-backend refresh procedure in the [local development skill](../../../.agents/skills/local-development/SKILL.md).
Docker Engine replaced Docker Desktop; use the [toolchain](../../development/toolchain.md)
for runtime configuration rather than the retired Desktop restart recipe.
Use six confirmation lanes for final qualification unless a new measured run
justifies changing that host setting. Use the [manager settings](../manager.md#settings-layers) for account scheduling;
keep operational observations untracked.

A settled answer belongs in the task brief; when a brief has accumulated many
decisions, the next one restates the whole current instruction and supersedes
the rest. Before resuming a worker, commit the brief decision, then rebase the
worker's branch onto main and reinstall dependencies if the lockfile changed;
workers do not rebase. An exited task with ready work behind it gets an
executable disposition within five minutes. A worker handoff
that only diagnoses an authorized repair is incomplete. Verify a landing-tool
repair with an actual landing, rather than ledger state alone.

## Unresolved decisions

Windows support requires a measurement on a Windows machine before deciding
line-ending and platform-module work. Goal tooling remains Linux-only; no
Windows task is authorized by this checkpoint. Whether title control should
prevent a Work merge remains a product question in API's later list.

Legacy nameless Recipe scaling retains the original line with separate amount
and unit; [Recipe exchange](../../contracts/recipe-exchange.md) owns that behavior.
Tailnet sign-in requires compatible origins and a full stack restart; an origin
bound to loopback does not authorize that change automatically.

## Deferred findings

The [unverified tooling backlog](later.md) retains the unresolved leads from the
former run journal. Load it only when investigating or briefing that class of
fault; it supplies no current stop or retry instruction.
