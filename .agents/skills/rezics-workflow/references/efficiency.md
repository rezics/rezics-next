# Measure and improve

Read [efficiency rules](../../../../docs/development/efficiency.md) and
[measurement mechanics](../../../../tools/goal/README.md#measurements-and-historical-imports).
The resident manager uses this stage at checkpoints and the defined cadence; units provide native session, source
and acceptance evidence without
starting a second monitoring loop.

```sh
bun tools/goal/src/cli.ts attempts --json
bun tools/goal/src/cli.ts report --json
```

Run controller commands only against authorized controller state. Exported attempts provide evidence; do not put
private account readings or configuration into tracked documents.

- [ ] Compare allowance per accepted landing and accepted outcomes per time, by Goal, task class and model profile.
- [ ] Include lost attempts and native unit/subagent usage deltas once. Exclude child totals already included in a
      parent aggregate; never invent managed starts. Separate measured durations from estimates and mark unknowns.
- [ ] Inspect the hourly ledger and preceding twelve-hour window at the required cadence. Find the largest avoidable
      cost: unready contracts, replacement input, rereads, polling, checks, conflicts or idle capacity.
- [ ] Apply the [incident method](../../../../docs/development/efficiency.md#incident-method) to the largest evidenced
      loss. Separate observations from hypotheses and preserve independent work while its owner repairs the cause.
- [ ] Adjust worker and check admission separately using measured memory, queueing and accepted throughput.
- [ ] Keep routing in its configured owner and preserve service-tier, pacing and pause rules. Capacity/provider errors
      follow the controller retry policy, not an improvised tier switch or exhaustion claim.

Output: the measured cause, one corrective action with an owner, and a comparison window. Put durable corrections in
their existing owner document/tool, then update briefs to link them; do not accumulate another policy in memory.

## Incident analysis

Use the [owner rule](../../../../docs/development/efficiency.md#incident-method), not a new audit loop.

1. Select the evidence that explains the largest loss; record its scope and missing attribution.
2. Identify the decision or repeated action that sustained it, and distinguish the causal hypothesis from observation.
3. Name what stops or changes, its owner, and the owner document or tool receiving the correction.
4. Compare the next applicable outcome at the existing checkpoint; leave the improvement unverified until then.

Keep a concise incident record separate from prompts. Retain raw logs privately. A usage ledger supports the
explanation but does not replace it; do not reproduce it as another narrative report.
