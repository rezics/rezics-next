# Review and hand off

Read [review rules](../../../../docs/development/verification.md#review) and
[delivery](../../../../docs/development/delivery.md). Review the changed contract and observable outcome, using the
required gates and risk review rather than adding repeated general review rounds.

```sh
git diff --check
git diff --stat
git diff -- <changed-path>
git diff --cached
```

- [ ] Compare the diff with the adopted owner contract, frozen acceptance and capability manifest.
- [ ] Check disclosure, lifecycle, costs and consumers where changed; investigate the full defect class in the diff.
- [ ] For blocking findings, retain a test failing at the outcome assertion on the reviewed head or a concrete
      reproducible contract violation. Distinguish setup failure, assertion failure and unavailable evidence.
- [ ] Inspect screenshots and running surfaces; automated passes alone cannot establish visual quality.
- [ ] Record exact check commands, results and tested revision. Name decisions/assumptions, outside-path changes
      and their covering tests, source references, remaining limits and any blocker.
- [ ] Stage only the intended files, inspect the staged diff, commit on the assigned branch and leave it clean.

```sh
git add -- <changed-paths>
git diff --cached --check
git diff --cached
git commit -m '<English description of the completed outcome>'
git status --short
```

Use the task's required result format. The controller owns [integration and
promotion](../../../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing); a worker
handoff does not authorize manual integration. Managers verify outcomes on the promoted commit before Goal closure,
notify affected owners through the supported workflow, and retain the acceptance links in the tracked Goal.

On a wrap-up instruction, follow [delivery's pause procedure](../../../../docs/development/delivery.md): checkpoint
and preserve state promptly. Do not resume a paused Goal merely to finish another repair.
