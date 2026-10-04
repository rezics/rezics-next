# Deferred rating query requirements

Implemented RatingContext, observation, revision, aggregation, policy and
Realm/Global synthesis behavior lives in the [Rating owner](../../services/main/src/modules/rating/README.md),
its model profiles and owner tests. RATE01–09 scenarios remain in the
[acceptance source](../../scripts/qa/cases/ratings-and-event-time.ts).

## Scoped targets and roll-ups

Decision 53, maintainer and product manager, 2026-10-04. An observation targets
exactly one Resource; "X in F" is a [projection](semantic-model.md#identities-variants-and-projections),
so the rating `projection` grain covers "Character in an episode", "Person in a
match or map" and "unit in a game version" without a second target. The question
decides the grain, not the platform: "how much do you like this character" is a
Character question; "how did they do in this episode or match" is a projection
question. A RatingContext's identity is its question, scale and grain; its
population is a segment, so two Contexts that differ only in population are
segments of one measurement and may be shown side by side, while different
questions never combine. Reviews and discussion take the same targets.

- **No implicit roll-up.** Projection ratings never feed their subject, episode
  ratings never feed a series and match ratings never feed a player, as
  [IMDb](https://help.imdb.com/article/imdb/track-movies-tv/ratings-faq/G67Y87TFYYP6TWAV)
  keeps series and episode ratings apart and [MAL](https://myanimelist.net/info.php?go=topanime)
  scores episodes on another scale.
- **Named derived metrics.** A roll-up is its own metric with a declared formula
  (pooled observations or the mean of per-member means), its member count and
  coverage; the two formulas can rank differently ([Simpson's paradox](https://en.wikipedia.org/wiki/Simpson%27s_paradox)).
- **Additive components only.** Each (RatingContext, target, population,
  period) stores sum, count and a histogram; every roll-up recomputes from them
  ([Kimball](http://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/additive-semi-additive-non-additive-fact)),
  never from stored means.
- **Variant families.** A hub's page lists each member's own figures side by
  side and shows no family mean.
- **Version pins.** A rating of one release stays on that release; a
  cross-release figure is a derived metric.
- **Merges.** When identities merge, each rater keeps one current observation
  per RatingContext and target, and aggregates recompute from observations.
- **Thresholds are part of a metric.** Defaults, which each RatingContext may
  override and which local data should recalibrate: a mean on a Resource from 5
  ratings (IMDb), on a projection from 10, with only the count and histogram
  below it; leaderboards use a Bayesian weighted rating whose prior and weight
  come from the same RatingContext and are published, from 50 ratings
  ([Letterboxd](https://letterboxd.com/journal/the-score-new-weighted-average-ratings/));
  a derived roll-up shows when it covers at least half its members. Every score
  shows its count, histogram and population label.

Exports describe a rating as a Web Annotation with motivation `assessing`
whose target is the projection IRI with its `prov:specializationOf` subject,
and an aggregate as a [DQV quality measurement](https://www.w3.org/TR/vocab-dqv/)
or [Data Cube](https://www.w3.org/TR/vocab-data-cube/) observation.

## Work not yet implemented

- Future or backdated entries need an explicit finite admission policy.
- Target ratings keep additive components per Context and target (see the
  owner README); time-bucketed components and the other rating families still
  need them. Corrections invalidate affected buckets; a rebuild keeps the active
  generation until the replacement is complete. Expensive exact analytics, such
  as reconstructing legacy targets recorded before components existed, should
  be resumable jobs.
- Seals within one RatingContext serialize on its admission scope gate; a
  question rated by many people at once needs a per-target scope before launch
  load.
- Joined rating search may combine qualified aggregates with graph/text
  conditions, while preserving the selected population. Raw-score joins must not
  silently change that population.
- Daily aggregation and cross-Context policies beyond the named Realm/Global
  synthesis need separate implementation and qualification.

The owner README lists these items as deferred work; they are not part of the
current bounded aggregate API.
