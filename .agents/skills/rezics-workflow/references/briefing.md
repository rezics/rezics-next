# Brief and implement

Read [delivery rules](../../../../docs/development/delivery.md), the relevant
[Goal definition](../../../../docs/goals/README.md) and the [brief schema](../../../../tools/goal/README.md#briefs-and-routing).
Use that schema directly; this skill does not define another one.

Managers:

- [ ] Link the adopted owner decisions and capability manifest; state outcome, exclusions, dependencies, consumers,
      affected paths, risk areas, native acceptance and estimated size.
- [ ] Freeze missing per-persona API cases red before implementation under the
      [capability evidence rules](../../../../docs/development/verification.md#capability-evidence).
- [ ] For interfaces, list exact stories to add: route/control, state, viewer, viewport and recorded API evidence.
- [ ] Verify exports, fixtures and dependencies exist on the recorded base; check current task state before reshape.
- [ ] Sequence shared-file writers. Include existing tests whose old behaviour the new contract replaces; their
      owner reconciles frozen acceptance before dispatch, never the implementation worker.
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

Read the contract's failing outcomes and likely files, implement the complete outcome, then follow
[verification](verification.md). Preserve frozen files. For a minimal adjacent correction, check risk ownership,
cover every changed outside-path file with its affected tests and list the reason in the handoff for owner notice.
Do not rebase or merge. Keep temporary files under `.temp/`. If the contract conflicts, report the conflicting
assertions and owner text with concrete evidence rather than weakening acceptance.
