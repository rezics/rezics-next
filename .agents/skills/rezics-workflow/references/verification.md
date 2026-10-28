# Prove the outcome

Read [verification rules](../../../../docs/development/verification.md), especially capability evidence and check
selection. Use the native command in the Goal's capability manifest or task contract; a parallel specification
without its native driver is not acceptance.

- [ ] Prove backend outcomes through real APIs for each persona on released fixture data. Cover independent denials,
      hidden resources, lifecycle/replay and dependency failure; use no frontend or permissive owner stubs as proof.
- [ ] Exercise every applicable surface cell, or record the contract's reason it does not apply in the manifest.
- [ ] For changed operations, compare examined work with the derived Cost bound at three seeded scales, including
      unrelated data and history. Use native cost counters, not response size or wall time.
- [ ] Check every route against the [capability evidence matrix](../../../../docs/development/verification.md#capability-evidence),
      including all required content, viewer, viewport and complex control states. Build page stories on API recordings. Use play functions, accessibility checks and snapshots;
      inspect the rendered phone/desktop pages in both themes and applicable locales. Follow the
      [page story map](../../../../docs/development/page-stories.md) and
      [web recording runbook](../../../../apps/web/README.md#storybook-and-page-recordings).
- [ ] Validate external configuration through the [real integration boundary](../../../../docs/development/verification.md#external-integrations)
      and include first-deployment evidence when required by acceptance.
- [ ] Select the narrowest acceptance under [check selection](../../../../docs/development/verification.md#check-selection-and-failures).
      Confirm fresh-worktree preparation is owned by the runner, and classify transport failures separately.
- [ ] Run acceptance once after the last relevant edit and the root typecheck. Preserve exit status and logs.
      Let queued checks acquire their slot. Follow the rules' bounded diagnostics for actual failures.

Commands from the repository root; replace placeholders with the contract's actual names, and select only the
commands applicable to the change:

```sh
bun run typecheck
bun run --cwd services/kernel check test/<module>/<outcome>.test.ts
bun run --cwd apps/web check tests/<surface>.test.ts
bun run --cwd apps/web record -- <recording-name>
bun run --cwd apps/web storybook
bun run --cwd apps/web screenshots --story '<story-id>' --width 390 --out .temp/screenshots/phone
bun run --cwd apps/web screenshots --story '<story-id>' --width 1280 --out .temp/screenshots/desktop
```

Select named recording files to avoid rewriting unrelated evidence. Screenshot defaults cover all launch locales and
both themes. The interactive Storybook server is for inspection; it is not a passing automated check.
The app's `test:stories` script runs the Storybook browser suite; use it only when the contract calls for that suite.

Conditional checks, not a default checklist to execute:

```sh
# A shared kernel runtime contract change requires the full kernel check.
bun run --cwd services/kernel check
# Executable control-plane changes require its own workspace gate.
bun run --cwd tools/goal check
# A failing control-plane file under demonstrated suite load is diagnosed alone.
bun test tools/goal/src/<failing-file>.test.ts
# Full promotion belongs to the controller, not ordinary worker verification.
bun tools/goal/scripts/gate.ts
```

Documentation alone needs neither workspace gate. Use at most twelve nearby files in a discretionary check;
whole-workspace/full web checks require the task contract except the shared-runtime requirement above.
Record infrastructure errors separately from reached assertions and follow
[maintenance escalation](../../../../docs/development/maintenance.md). Tooling repairs also need evidence from the
actual failure condition before being called live or fixed.
