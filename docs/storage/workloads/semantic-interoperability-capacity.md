# Source graph interoperability workload design

## Planning inputs

Source objects versus facts/statements/qualifiers, original bytes, lexical residuals, change streams and export generations.

Keep the 500M-row baseline and 3B-row estimate for corpus-scale relations, then
convert business records to current facts/revision payloads/index costs with stated assumptions.
Do not reuse relational byte estimates as measured TDB2/Lucene costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Stream acquisition and bounded joins; separate source from product dataset load; detect retention gaps. Full source-corpus indexing is a separately admitted workload.

## Initial qualification and growth

Use practical fixtures on available hardware, including adversarial hot owners,
deep cursors, stale workers and failed rebuilds. Measure work growth and observable
lag/headroom; do not require those future volumes for first delivery. Large-scale
throughput and automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.
