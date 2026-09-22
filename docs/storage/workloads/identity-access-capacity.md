# Identity and Access workload design

## Planning inputs

Principals/Agents, groups/roles/bindings, representation path depth, effective-member expansion and revocation fan-out.

Keep the 500M-row baseline and 3B-row estimate for corpus-scale relations, then
convert business records to facts/history/index costs with stated assumptions.
Do not reuse relational byte estimates as measured Fluree costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Use selective subject/target/scope indexes, batched decisions, bounded impact planning and immediate scope fences before cleanup. Do not make the entire private directory a per-request join.

## Initial qualification and growth

Use practical fixtures on available hardware, including adversarial hot owners,
deep cursors, stale workers and failed rebuilds. Measure work growth and observable
lag/headroom; do not require those future volumes for first delivery. Large-scale
throughput and automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.
