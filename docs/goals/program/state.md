# Program checkpoint

Use `task goal -- status`, `coordinator status`, `planning` and the current
briefs for live task disposition and scope. This page retains decisions and
unverified obligations; it is not an operational run log.

Waves 1 to 3 are on main, and the operations Goal is closed. The program's
completion still needs these, each owned by an open task in the ledger:

- main's confirmation passes every launch row, including the Realm, Visual Novel
  browse and Recipe cells that the cleanup race, read-basis and load failures
  stopped; then the api Goal closes;
- the remaining web surfaces land, and the web Goal closes;
- the shared-capability repairs for credit and discovery land with their
  cross-domain proofs (source adoption, publication, Structure, exchange,
  release, import identifiers and erasure custody have landed);
- gate selection, shard adjudication, harness-test isolation and landing
  conflict recovery are repaired. Gates fail on shared harness tests that the
  change cannot affect, and that failure class costs more gate time than any
  other; the repair briefs carry the research findings.

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
