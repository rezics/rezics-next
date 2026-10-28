# Measure and improve

Read [efficiency rules](../../../../docs/development/efficiency.md) and
[measurement mechanics](../../../../tools/goal/README.md#measurements-and-historical-imports).
Managers use this stage at checkpoints and the cadence defined by those rules; workers provide evidence without
starting a second monitoring loop.

```sh
bun tools/goal/src/cli.ts attempts --json
bun tools/goal/src/cli.ts report --json
```

Run controller commands only against authorized controller state. Exported attempts provide evidence; do not put
private account readings or configuration into tracked documents.

- [ ] Compare allowance per accepted landing and accepted outcomes per time, by Goal, task class and model profile.
- [ ] Include lost attempts and resumed usage deltas once. Separate measured durations from estimates.
- [ ] Inspect the hourly ledger and preceding twelve-hour window at the required cadence. Find the largest avoidable
      cost: unready contracts, replacement input, rereads, polling, checks, conflicts or idle capacity.
- [ ] Before a third attempt, classify losses and repair their cause. Preserve independent ready work while doing so.
- [ ] Apply the [incident method](../../../../docs/development/efficiency.md#incident-method) to every evidenced cause;
      record before/after evidence on comparable accepted work and inspect post-landing defects.
      A retry cap or a cheaper token price alone does not demonstrate savings.
- [ ] Adjust worker and check admission separately using measured memory, queueing and accepted throughput.
- [ ] Keep routing in its configured owner and preserve service-tier, pacing and pause rules. Capacity/provider errors
      follow the controller retry policy, not an improvised tier switch or exhaustion claim.

Output: the measured cause, one corrective action with an owner, and a comparison window. Put durable corrections in
their existing owner document/tool, then update briefs to link them; do not accumulate another policy in memory.

## Incident analysis

Use the [owning incident rule](../../../../docs/development/efficiency.md#incident-method) for the evidence, class
repair, manager notification and next-hour verification requirements. Build a cause-to-fix record from the named
artifacts; attach their paths and measured times to the operating report, keeping private state outside Git.

### Worked example: 2026-10-28 Storybook delay

The delay illustrates five cause groups. The check group includes both check sizing and delayed observation; keep
those classes distinct when choosing repairs. This qualitative example does not supply measured durations or proof
that a repair has taken effect.

| Evidenced cause                                                               | Class                                     | Repair to apply beyond this task                                                                                                                  | Evidence to inspect in the next hourly report                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Work waited because declared files overlapped.                                | Shared-file holds                         | Apply the [dependency rule](../../../../docs/development/delivery.md#brief-preflight); remove overlap-based holds from dispatch.                  | Independent overlapping tasks start without a shared-file hold.                             |
| A brief assumed all stories lived in one Storybook and needed reshaping.      | Wrong brief premise                       | Apply repository preflight to story locations and package ownership before dispatch.                                                              | New briefs match the recorded base without the same reshape.                                |
| Checks were oversized and long attempts went unnoticed.                       | Oversized checks; unnoticed long attempts | Use [narrow acceptance](../../../../docs/development/verification.md#check-selection-and-failures) and the hourly ledger to expose long attempts. | Commands match the changed surface; queue time and attempt duration are visible.            |
| Integration configuration had not been validated through the deployment tool. | Unvalidated integration configuration     | Require [real integration validation](../../../../docs/development/verification.md#external-integrations) in acceptance.                          | The actual configuration has tool validation evidence, plus deployment evidence where safe. |
| A control-plane fix had not reached the branch where it runs.                 | Branch or propagation gap                 | Split and land control-plane work under [landing discipline](../../../../docs/development/delivery.md#checkout-and-landing-discipline).           | The running control plane contains the checked main revision.                               |

In an incident report, link the evidence for every row, the class repair and its owning rule. Record notification to
every manager and compare the next hourly report with the incident window under the owning rule; an intended repair
is still pending until that comparison supports its effect.
