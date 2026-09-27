# Deferred rating query requirements

Implemented RatingContext, observation, revision, aggregation, policy and
Realm/Global synthesis behavior lives in the [Rating owner](../../services/main/src/modules/rating/README.md),
its model profiles and owner tests. RATE01–09 scenarios remain in the
[acceptance source](../testing/ratings-and-event-time.md).

## Work not yet implemented

- Future or backdated entries need an explicit finite admission policy.
- Materialized rating projections must be scoped by Context, target and time.
  Corrections invalidate affected buckets; a rebuild keeps the active generation
  until the replacement is complete. Expensive exact analytics should be
  resumable jobs.
- Joined rating search may combine qualified aggregates with graph/text
  conditions, while preserving the selected population. Raw-score joins must not
  silently change that population.
- Daily aggregation and cross-Context policies beyond the named Realm/Global
  synthesis need separate implementation and qualification.

The owner README lists these items as deferred work; they are not part of the
current bounded aggregate API.
