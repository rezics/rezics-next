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
- [ ] Choose one correction, record before/after evidence on comparable accepted work and inspect post-landing defects.
      A retry cap or a cheaper token price alone does not demonstrate savings.
- [ ] Adjust worker and check admission separately using measured memory, queueing and accepted throughput.
- [ ] Keep routing in its configured owner and preserve service-tier, pacing and pause rules. Capacity/provider errors
      follow the controller retry policy, not an improvised tier switch or exhaustion claim.

Output: the measured cause, one corrective action with an owner, and a comparison window. Put durable corrections in
their existing owner document/tool, then update briefs to link them; do not accumulate another policy in memory.
