# Governance and delivery workload design

## Planning inputs

Reports/evidence, enforcement targets, recipients, retries, retention and erasure fan-out.

Keep the 500M-row baseline and 3B-row estimate for corpus-scale relations, then
convert business records to facts/history/index costs with stated assumptions.
Do not reuse relational byte estimates as measured Fluree costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Commit decisions/fences before bounded propagation; page recipients; bound intent/dead-letter bytes and external retries. Count pending work by arrival rate and retention.

## Initial qualification and growth

Use practical fixtures on available hardware, including adversarial hot owners,
deep cursors, stale workers and failed rebuilds. Measure work growth and observable
lag/headroom; do not require those future volumes for first delivery. Large-scale
throughput and automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.
