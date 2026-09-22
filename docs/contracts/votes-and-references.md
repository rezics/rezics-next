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

## Institutional entitlements and representation

A governance electorate defines eligible holders and counting units explicitly.
An organization may hold a weighted seat independently of its current operators.
An entitlement records poll/electorate revision, source identity, holder and exact
weight. A voting mandate authorizes a representative to operate that holder's
ballot under [Access](identity-and-access.md); it creates no additional weight.

The default institutional mode has one organizational entitlement and a designated
representative, with declared replacement/backup authority. Several representatives
or several valid authorization paths still operate the same ballot identity.
Concurrent changes use its expected revision, and an accepted replacement removes
the previous contribution. Membership, administrative status, speaking as an
organization and reputation scores do not independently confer voting weight.

The charter may permit any admitted representative, require k-of-n independent
approvers, or require a finalized internal decision. Approvals bind the exact
poll, choice, entitlement/allocation, weight snapshot, mandate revision and expected
ballot revision. Different proposed choices cannot share approvals. An internal
majority may produce a whole external ballot or an explicit proportional split,
according to the charter; the access graph does not choose this aggregation.

## Allocation and counting invariants

Casting, allocating and issuing voting power are separately authorized operations.
Where the electorate enables allocation, a holder can divide an entitlement into
explicit seats. For each root entitlement, the sum of active allocation leaves
and the sum of counted units must each be no greater than its issued units.
A fully allocated parent cannot also cast its original weight. Partial allocation
has an explicit residual seat; multiple paths to the same leaf count it once.

Retain source-entitlement identities through every allocation/delegation. Root
issuance also enforces the electorate's counting-identity uniqueness. Personal
and organizational seats may coexist only if the electorate admits both classes.
A persona switch cannot add a seat in a one-person electorate, and an account ID
alone does not establish natural-person uniqueness.

An allocated Person seat belongs to that Person and uses its admitted controllers.
A member-set allocation explicitly means individual member seats or a collective
seat; membership changes cannot silently multiply its units. Use integer units
with a declared scale or exact rational values, including rounding and residual
ownership. Ballot choices/distributions must conserve the same units.

## Poll snapshots, proxies and current authority

Before a governance poll opens, freeze its question/options, charter, eligible
entitlements, weights and allocation plan. Define quorum, explicit abstention and
uncast-weight treatment in those units; approval signatures are not extra seats.
Ordinary ratings/reactions may retain their separately declared live-population
policy.

Evaluate current principal enforcement, representation and command admission on
every cast/change/withdraw. A departed representative cannot submit using the
opening snapshot; a replacement can operate the organization's unchanged seat.
An already admitted ballot survives operator departure unless an explicit,
auditable invalidation rule applies. Never rewrite historical authority evidence.

When ordinary proxy voting is enabled, use one explicit proxy hop per entitlement,
with proxy routes frozen for the poll. Received units are not automatically
redelegable. The charter may permit the original holder to reclaim/override; that
operation replaces the contribution for the same source entitlement. Revoked
proxies cannot make new changes, and new proxy routes normally apply to the next
poll. An organizational holder's override requires its current representative.

Live proxy rerouting and full liquid delegation are separate extension profiles.
They require explicit replacement/recount, cycle, topic, precedence, concentration,
abstention and provenance policies plus workload qualification. Ordinary access
inheritance never activates them. Initially reject proxy cycles; do not silently
drop units or invent a delegate.

## Persistence and command boundaries

Fluree owns poll charters, electorate/weight snapshots, source entitlements,
immutable allocation plans, resolutions and ballot revisions. Access/PostgreSQL
owns current mandates, protected representative policies and authority fences.
Keep one authoritative owner for each fact.

Activate allocation plans before opening the poll. Guard plan activation, opening
and ballots with expected-state conditional transactions so a root and its
allocated children cannot both count, including under concurrent requests.
Maintain one current ballot per poll and active allocation leaf; retries preserve
one effect and tally projections are replayable.

Bind current Access admission to the exact ballot or allocation through the
[authorization bridge](../implementation/authorization-bridge.md). Independent
check-then-write calls do not establish cross-store atomicity. An approved result
can execute only the body's admitted governance capability for the exact effects,
as defined by [governance rules](governance-rules.md).

The [research basis](../research/access-depth-representation-and-voting.md)
compares institutional representation, direct proxies and liquid delegation.
[Governance acceptance](../testing/governance-and-delivery.md) owns prospective
conservation, concurrency, revocation and recovery cases.

## References and projections

Community references preserve resource, revision and occurrence grain. Reactions,
favorites, follows and private progress do not transfer target ownership or disclosure.
Aggregate counters are bounded projections with replay-safe updates; hot objects
must not serialize all writes through one synchronous exact global counter.

The [interaction/cache blueprint](../implementation/interactions-and-cache.md)
binds ordinary likes/favorites to guarded Fluree edge transactions and defines
optional read caching. A cache never becomes another authoritative ballot or
favorite store. Other vote types retain their own population and history contracts.

Return distributions, selected population and freshness. Withdrawn/private ballots
cannot leak through facets or reconstruction. Test duplicate retry, concurrent
changes, account/Agent enforcement, source import and restore without resurrecting
withdrawn state.
