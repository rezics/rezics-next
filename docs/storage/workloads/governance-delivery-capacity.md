# Governance and delivery workload design

## Planning inputs

Reports/evidence, enforcement targets, recipients, retries, retention and erasure fan-out.

For polls, include entitlement/seat count, representatives per seat, seats per
operator, allocation leaves, approval thresholds, concurrent replacements and
frozen electorate size. Distinguish live Access checks from snapshot preparation,
allocation validation, tally projection and approved-effect execution.

Keep the 500M-row baseline and 3B-row estimate for corpus-scale relations, then
convert business records to facts/history/index costs with stated assumptions.
Do not reuse relational byte estimates as measured Fluree costs. Include skew,
read/write rates, memory, storage, network, retention, rebuild and restore time.

## Bounded implementation

Commit decisions/fences before bounded propagation; page recipients; bound intent/dead-letter bytes and external retries. Count pending work by arrival rate and retention.

Prepare governance electorate/weight/allocation snapshots before opening.
Ordinary ballot mutations operate on named entitlements and expected revisions;
they do not recursively recompute the electorate or count every authority path.
Batch permitted operations without losing per-seat conservation/idempotency.
Use replayable tally projections rather than a single global exact write counter.
Full liquid routing is a separately qualified bounded job/profile.

## Initial qualification and growth

Use practical fixtures on available hardware, including adversarial hot owners,
deep cursors, stale workers and failed rebuilds. Measure work growth and observable
lag/headroom; do not require those future volumes for first delivery. Large-scale
throughput and automatic shard/fleet operations remain later qualification.
Define per-owner thresholds and resulting admission/index/placement actions.
The governing [workload policy](../workload-budgets.md) owns timing and limits.

Exercise many representatives contending on one seat, one operator holding many
independent seats, concurrent plan activation/opening, mandate revocation, failed
snapshot preparation and tally replay after ambiguous commits. Measure snapshot
time/memory, per-seat contention, p95/p99 mutation latency, projection lag and
recovery time while enforcing [vote conservation](../../contracts/votes-and-references.md).
