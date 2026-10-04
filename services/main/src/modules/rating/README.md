# Rating owner decisions

A RatingContext identifies the question, target, population, scale and cadence.
Sharing a semantic Context or the same numeric range does not combine questions.
Changing a question creates another RatingContext; changing the experience
reduction changes its separate policy head. This keeps old observations tied to
the meaning under which they were admitted. MainVersion, release, translation
and exact software/model version are separate target grains; their populations
cannot be silently rolled together.

Standing, daily and experience slots represent different intentions. Standing
asks for one current opinion, daily uses the server's civil day, and experience
uses a client-retained occasion marker bound to the private Access principal.
The marker identifies an intentional evaluation; it does not prove that an
external event happened. The private binding prevents persona changes from
creating extra votes. Global standing uses a separate population and scale.
Imported aggregate scores remain source statistics, without invented native
observations or principals.

A daily period uses the first valid instant of a civil day and calendar addition
for its end. Twenty-four-hour UTC arithmetic changes the question at DST gaps
and overlaps. Retained observations keep their exact admitted bounds when the
server's timezone database changes.

The policy implementations live in `experience-reduction.ts` and `synthesis.ts`.
Their tests preserve separate denominators and scales. Owner manifests, current
heads, receipts and the Access inventory determine whether an aggregate is
complete. A missing or mismatched owner record makes it unavailable. A zero
contributor result is `no-data`; it is not evidence loss. The selected fixtures
measure adapter calls and bytes. They do not qualify native Jena operator work,
hot-head contention or deployment capacity.
Bulk aggregate fixtures do not qualify the interactive writes they bypass.
Pre-inventory Contexts need explicit reconstruction before these reads can claim
completeness. A matching rollback of both owners outside an authenticated
recovery cut is not independently detected by the aggregate; matching inventory
alone is not a valid restore proof. The selected graph-loss fixture does not
qualify the production signed owner-cut release gate.

The standing, daily, experience, Global and release profile definitions live in
`model/definitions/`; the exact admission and read contracts live in this owner
module. RATE01–09 are declared in `scripts/qa/cases/ratings-and-event-time.ts`;
`scripts/qa/coverage/rate*.ts` names the complete-case tests. The recorded
backend run is named in `docs/plan/README.md#current-state`.

Target ratings (release, realization, occurrence and resource grains) read from
additive components, never from a walk of the raters. Access keeps the head
count, rating count, sum and a 1–10 histogram per (RatingContext, target), and
the same figures summed per Context in 16 shards keyed by a hash of the target,
so a seal moves only its target's shard row and a ranking's prior sums sixteen
rows. The seal that moves a head moves its target row and shard row in
its own transaction (subtract the head's recorded value, add the new one;
withdrawal subtracts only), and the sealed value must match the admitted request
digest. Count and sum are what the histogram says, which the database checks.
A target of at most 100 raters is also verified head by head against its
manifests and must equal its components; a larger one is witnessed by its last
sealed write, which must still be its observation's live head, so a graph that
lost it or rolled back past it makes the read unavailable instead of wrong. Heads
sealed before components existed have no recorded value (SQL cannot read the
graph): they are counted as `unvalued`, a verified read of such a target records
their values, and a target above 100 raters waits for its raters' next revisions.

A Context shows a target's mean only from its display threshold, 5 ratings by
default and 10 for the `projection` grain, and a `realm-target-rating-context-v3`
Context may declare its own. Count, sum and histogram always show: with the
histogram the mean is no secret, but a mean from a handful of ratings is not
evidence, and a ranking built on it would be noise.

`POST /v1/rating-rollups` is a derived metric over one RatingContext, not a stored
or cached figure. `pooled` is the sum of the members' sums over the sum of their
counts; `mean-of-means` averages members' means and counts only members at or
above the threshold. The two can rank two roll-ups in opposite order, which is why
the formula, member count, coverage (members at the threshold over members the
question counts) and every member's components travel with the value, and why the
value is withheld below half coverage. A member the caller cannot read, that does
not exist, or has another grain is listed as unavailable with its reason and still
counts in the denominator. A member the Context does not accept is `not-accepted`,
distinct from unavailable, and is left out of the value, that denominator and the
ranking. A v1–v3 Context accepts every member its grain admits. A ranking uses a Bayesian weighted rating, `v/(v+m)·R + m/(v+m)·C`,
whose prior mean C is the Context's own pooled mean and weight m its average
ratings per target, never under the 50-rating listing minimum; both are returned.
Different Contexts, questions, scales or populations are never combined, and no
mean is ever an input.

Materialized rating projections, joined rating search, policy-controlled
backdated entries, cross-context policies beyond the named Realm/Global
synthesis, and physical capacity need separate implementation and qualification.
