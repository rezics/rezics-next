# Votes, references and community accountability

## Targets and populations

Every vote identifies its exact feature target, context, eligible population and
private counting identity. Public Agent attribution is separate. Definition votes,
application fit, spoiler judgments, ratings and poll choices have different scales
and uniqueness rules. Source aggregate statistics do not become native ballots.

## Mutations

Cast/change/withdraw through an expected-revision, idempotent command. Validate
target eligibility, active context, authority and feature limits together. A persona
switch cannot create additional votes where one-person uniqueness is required.
Closed polls, altered option meanings and population changes need explicit policy;
never reinterpret already cast votes under a new question.

## References and projections

Community references preserve resource, revision and occurrence grain. Reactions,
favorites, follows and private progress do not transfer target ownership or disclosure.
Aggregate counters are bounded projections with replay-safe updates; hot objects
must not serialize all writes through one synchronous exact global counter.

Return distributions, selected population and freshness. Withdrawn/private ballots
cannot leak through facets or reconstruction. Test duplicate retry, concurrent
changes, account/Agent enforcement, source import and restore without resurrecting
withdrawn state.
