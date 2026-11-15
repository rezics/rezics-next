# Review and hand off

Read [review rules](../../../../docs/development/verification.md#review) and
[delivery](../../../../docs/development/delivery.md). Review the changed contract and observable outcome, using the
applicable risk review rather than adding repeated general review rounds.
[Phase ownership](../../../../docs/development/delivery.md#implementation-and-acceptance) determines the handoff:
review source logic against contracts; inspect acceptance evidence only for assigned verification.

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
- [ ] During interface acceptance, inspect rendered surfaces; automated passes alone cannot establish visual quality.
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

Use the task's required result format and phase handoff. Units own
[source integration](../../../../docs/development/delivery.md#direct-source-integration); the controller retains
promotion and publication keeps its owner. Product Goal closure retains promoted-candidate evidence. Report a
completed source assignment and its remaining acceptance separately.

On a wrap-up instruction, follow [delivery's pause procedure](../../../../docs/development/delivery.md): checkpoint
and preserve state promptly. Do not resume a paused Goal merely to finish another repair.
