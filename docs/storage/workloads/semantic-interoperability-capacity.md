# Source graph interoperability workload design

## Planning inputs

Source objects versus facts/statements/qualifiers, original bytes, lexical residuals, change streams and export generations.

Use the current 500M business-entity/document baseline and future 3B scenario
from the [workload policy](../workload-budgets.md). Derive this owner's population
and its facts/revision/index amplification; do not assume 500M rows in every table.
Do not reuse relational byte estimates as measured TDB2/Lucene costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Stream acquisition and bounded joins; separate source from product dataset load; detect retention gaps. Full source-corpus indexing is a separately admitted workload.

## Initial qualification and growth

Derive path costs and use small multi-scale fixtures, including adversarial hot
owners, deep cursors, stale workers and failed rebuilds. Assert observed work
under [complexity verification](../../testing/complexity.md). Measure lag/headroom
and qualify actual rollout capacity separately; small tests cannot certify the
current corpus. Automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.
