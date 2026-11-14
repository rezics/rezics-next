# Brief and implement

Read [delivery rules](../../../../docs/development/delivery.md), the relevant
[Goal definition](../../../../docs/goals/README.md) and the [brief schema](../../../../tools/goal/README.md#briefs-and-routing).
Use that schema directly; this skill does not define another one. Apply
[direct source integration](../../../../docs/development/delivery.md#direct-source-integration) to every task type
when integration is the bottleneck; the acceptance-writing steps below then belong to deferred verification.

The manager and workers who author Goals:

- [ ] State the outcome in user terms, what done means and the owner links; add exclusions, dependencies, consumers,
      affected paths, risk areas and estimated size. Product workers on dev design the change and write its tests.
- [ ] Freeze missing per-persona API cases of cross-Goal contracts red before implementation under the
      [capability evidence rules](../../../../docs/development/verification.md#capability-evidence).
- [ ] For interfaces, list exact stories to add: route/control, state, viewer, viewport and recorded API evidence.
- [ ] Apply [brief preflight](../../../../docs/development/delivery.md#brief-preflight) to control-plane, stabilize and
      verification briefs; product workers on dev preflight their own. Check current task state before reshape.
- [ ] Apply its overlap rule when setting dependencies. Name existing tests whose old behaviour the new contract
      replaces; the worker updates them, while frozen acceptance is reconciled by its owner before dispatch.
- [ ] Confirm cross-owner lifecycle steps against the owner's scoped contract and delivered interface before requiring
      them in acceptance. Keep permanent takedowns permanent; a newly permitted source is separate from restoration.
- [ ] Apply [checkout and landing discipline](../../../../docs/development/delivery.md#checkout-and-landing-discipline)
      when splitting control-plane and companion work or assigning a shared module workspace.
- [ ] Use the configured route, not a model selection copied from old memory. Keep private settings outside Git.
- [ ] Apply [skill instructions](../../../../docs/development/delivery.md#skill-instructions) when a brief uses a
      skill; preserve its reference reads, executable paths and documented failure recovery.

These commands run only in the controller's authorized checkout and state, not as a worker workaround:

```sh
bun tools/goal/src/cli.ts status
bun tools/goal/src/cli.ts dispatch .temp/goal/brief.md
bun tools/goal/src/cli.ts inbox read <manager>
bun tools/goal/src/cli.ts inbox ack <manager>
bun tools/goal/src/cli.ts inbox wait <manager>
```

Handle events before acknowledging them; establish the supported wakeup path before idling. See
[commands and managers](../../../../tools/goal/README.md#commands-and-managers) for lifecycle and event semantics.

The manager adopts the authored Goal before allocation. Execution units consume it through a native Codex Goal;
subagents and Grok CLI use that unit's shared worktree. Different units use separate worktrees. Do not create domain
manager sessions or a management tier. Runtime registration follows the Goal tooling owner.

Workers start in their unit's shared worktree:

```sh
pwd
git branch --show-current
git status --short
```

Read the contract's outcomes and likely files, verify its premises against your base, implement the complete outcome,
then follow [verification](verification.md). Preserve frozen files; update an existing test whose behaviour the
contract changes and list it. Decide ambiguities from the owner documents. Record decisions that change the adopted
contract in your summary and its owning document; hand off an owning-document change outside your declared paths
while continuing independent work. Routine implementation and test choices that preserve the contract belong in the
handoff and do not require an owning-document edit. For product work on dev, send the resident manager an actionable decision or source handoff.
For a minimal adjacent correction, check risk ownership, cover every changed outside-path file with its affected tests and list the reason in
the handoff for owner notice. Follow the direct-integration owner policy when it applies; otherwise do not rebase,
and merge or cherry-pick only a branch or commit the contract names explicitly. One designated writer coordinates
staging and commits in the unit tree. Preserve other writers' unfinished changes. Keep temporary files
under `.temp/`; a continuation brief for the rest of your outcome goes to `.temp/continuation/`. Report a blocker only
for two existing requirements that cannot both hold, quoting both, or for missing access.
