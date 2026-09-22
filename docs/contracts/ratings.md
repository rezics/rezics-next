# Rating contexts, observations and distributions

## Context, observation and revision

A RatingContext identifies a question, target grain, eligible population, scale,
cadence and governance. Several contexts can exist in one Realm. Main Version,
translation, release and exact software/model version remain different targets.
A scale with ten numbers is not necessarily equivalent to another ten-point scale.

An Observation is one rater's evaluation in an admitted slot. A correction,
withdrawal or restoration changes that observation's revision, stored as an immutable application revision manifest. A new day or deliberate experience creates another observation; retrying
the same command does not. Context wording/scale/population meaning changes create
a new context; changing only aggregation policy creates a policy revision.

## Slots and time

Standing has one effective opinion per counting identity/target/context. Daily
uses a server-validated calendar period, timezone and DST-resolved bounds.
Experience uses an explicit occasion. Preserve evaluation time, submission time,
original submission time and revision time independently. No submission is absent,
not zero or an automatically carried-forward daily vote. Future/backdated entries
follow an explicit finite admission policy.

Private accountability prevents one human from multiplying votes through personas
while preserving allowed public Agent attribution. An imported score aggregate
never becomes native observations or fabricated accounts.

## Aggregation policy

Select target, context, compatible scale, audience and time basis before reducing.
Default: latest eligible observation per rater, then equal-rater arithmetic mean.
A context may choose mean-per-rater; pooled observation means remain separately
labeled. With A's observations 2,2,8 and B's 6: latest-per-rater is 7,
mean-per-rater is 5, and pooled observations are 4.5. Preserve distributions and
denominators rather than averaging daily means.

Select an observation's effective revision before applying its availability: a
withdrawn latest opinion does not resurrect an older one. No automatic roll-up
combines Realm/global populations, parent/child products or family/version scores.
Cross-context synthesis is an explicitly named metric with its own definition.

## Queries and implementation

Jena stores contexts, observations and revision anchors. Bounded per-context/
target/time projections maintain histograms and rater reductions. Correcting an
observation invalidates affected buckets/generations; rebuilding preserves the
active generation until complete. Exact expensive analytics become resumable jobs.
Search joins qualified aggregates with graph/text conditions; arbitrary raw-score
joins cannot silently change the population.

Responses include scale, selected policy, population/time coverage, generation,
precision and missing/unavailable states. Qualify concurrent slot admission, DST,
persona switches, correction/withdrawal, empty populations and reconstruction.
