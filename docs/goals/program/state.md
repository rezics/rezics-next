# Program checkpoint

Use `task goal -- status`, `coordinator status`, `planning` and the current
briefs for live task disposition and scope. This page retains decisions and
unverified obligations; it is not an operational run log.

Wave/1 and wave/2 are on main. The erasure and restore consumers passed on
physical fixtures (completion and production), the OPS10 restore campaign and
the release image start passed from a clean checkout, and 67 of the 68 launch
rows are declared proved. The program's completion still needs these, each
owned by an open task in the ledger:

- wave/3 merges into main through its merge candidate and confirmation;
- main's scheduled confirmation passes every launch row, including Realm
  ranking (its retained-data fix lands first) and Realm closure search;
- the Realm rules and Realm ranking surfaces land;
- the erasure drill reruns green from a clean checkout after wave/3, and the
  operations, api and web Goals close.

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
