# Program checkpoint

Use `task goal -- status`, `coordinator status`, `planning` and the current
briefs for live task disposition and scope. This page retains decisions and
unverified obligations; it is not an operational run log.

Wave/1 and wave/2 are on main. The erasure and restore consumers passed on
physical fixtures (completion and production), the OPS10 restore campaign and
the release image start passed from a clean checkout, and 67 of the 68 launch
rows are declared proved. The program's completion still needs these, each
owned by an open task in the ledger:

- wave/3 merges into main through its merge candidate and confirmation. The
  candidate merged main without introducing a failure, and wave/3 was
  fast-forwarded to it; wave/3's own red unit and owner files (155 cases in
  49 files) are repaired by cause on that branch first;
- main's scheduled confirmation passes every launch row, including Realm
  ranking (its retained-data fix lands first) and Realm closure search;
- the Realm ranking surface lands (Realm rules has landed);
- the erasure drill reruns green from a clean checkout after wave/3, and the
  operations, api and web Goals close.

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
