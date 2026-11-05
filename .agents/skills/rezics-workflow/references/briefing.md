# Brief and implement

Read [delivery rules](../../../../docs/development/delivery.md), the relevant
[Goal definition](../../../../docs/goals/README.md) and the [brief schema](../../../../tools/goal/README.md#briefs-and-routing).
Use that schema directly; this skill does not define another one.

Managers:

- [ ] State the outcome in user terms, what done means and the owner links; add exclusions, dependencies, consumers,
      affected paths, risk areas and estimated size. Product workers on dev design the change and write its tests.
- [ ] Freeze missing per-persona API cases of cross-Goal contracts red before implementation under the
      [capability evidence rules](../../../../docs/development/verification.md#capability-evidence).
- [ ] For interfaces, list exact stories to add: route/control, state, viewer, viewport and recorded API evidence.
- [ ] Apply [brief preflight](../../../../docs/development/delivery.md#brief-preflight) to control-plane, stabilize and
      verification briefs; product workers on dev preflight their own. Check current task state before reshape.
- [ ] Apply its overlap rule when setting dependencies. Name existing tests whose old behaviour the new contract
      replaces; the worker updates them, while frozen acceptance is reconciled by its owner before dispatch.
- [ ] Apply [checkout and landing discipline](../../../../docs/development/delivery.md#checkout-and-landing-discipline)
      when splitting control-plane and companion work or assigning a shared module workspace.
- [ ] Use the configured route, not a model selection copied from old memory. Keep private settings outside Git.

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

Workers start in their assigned worktree:

```sh
pwd
git branch --show-current
git status --short
```

Read the contract's outcomes and likely files, verify its premises against your base, implement the complete outcome,
then follow [verification](verification.md). Preserve frozen files; update an existing test whose behaviour the
contract changes and list it. Decide ambiguities from the owner documents, record each decision in your summary and the
owning document, and, for product work on dev, tell your manager with an `info` message. For a minimal adjacent
correction, check risk ownership, cover every changed outside-path file with its affected tests and list the reason in
the handoff for owner notice. Do not rebase. Merge or cherry-pick only a branch or commit the contract names
explicitly, and only for product work on dev in your own worktree; never in a shared workspace. Keep temporary files
under `.temp/`; a continuation brief for the rest of your outcome goes to `.temp/continuation/`. Report a blocker only
for two existing requirements that cannot both hold, quoting both, or for missing access.
