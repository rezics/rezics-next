# Statements, grouping and context workload design

## Planning inputs

Resource/relation degrees, statements and independent support per qualified fact,
role-occurrence multiplicity, context decisions, overlapping display groups,
independent judgment populations, rule closure and history churn.

Use the current 500M business-entity/document baseline and future 3B scenario
from the [workload policy](../workload-budgets.md). Derive this owner's population
and its facts/revision/index amplification; do not assume 500M rows in every table.
Do not reuse relational byte estimates as measured TDB2/Lucene costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Anchor statement/inverse and vocabulary reads; stage cycle-sensitive changes;
incrementally invalidate affected statements and context generations. Avoid
materializing every Resource x Realm combination. Navigation changes do not
rewrite statement identities or allocate Path/Sense bundles.

The [aggregation contract](../../contracts/search.md#statement-aggregation)
resolves admitted contexts before deriving and grouping. Budget candidate
statements, support fanout, correlated occurrences, distinct-key memory, group
overlap, evidence bytes and summary hydration, including cold caches. A final
page limit does not bound aggregation work. Exact counts cover the declared
eligible relation; oversized plans have a declared budget/asynchronous outcome.

Batch name/avatar reads and keyset-page support/inverse records. Count facts,
resources and occurrences separately; do not infer distinct target counts by
summing source counts or overlapping child groups. Named term patterns compile
into admitted relation queries without per-resource interpretation calls.

## Initial qualification and growth

Derive path costs and use small multi-scale fixtures, including adversarial hot
owners, deep cursors, stale workers and failed rebuilds. Assert observed work
under [complexity verification](../../testing/complexity.md). Measure lag/headroom
and qualify actual rollout capacity separately; small tests cannot certify the
current corpus. Automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.

Include duplicate source claims, many paths to one concept, overlapping groups,
repeated character/release appearances and opposing Realm decisions. Measure
statement/decision and derived-index amplification after simplification; removing
logical wrappers alone is not measured latency or storage improvement.
