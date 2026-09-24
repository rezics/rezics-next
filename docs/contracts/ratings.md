# Rating contexts, observations and distributions

## Context, observation and revision

A RatingContext identifies a question, target grain, eligible population, scale,
cadence and governance. Several contexts can exist in one Realm. Main Version,
translation, release and exact software/model version remain different targets.
A scale with ten numbers is not necessarily equivalent to another ten-point scale.

The first `realm-standing-rating-context-v1` profile creates a distinct
RatingContext for one active Realm and an English question. It fixes MainVersion
as the target grain, integer values 1–10, standing cadence, an admitted Account
principal as the counting identity and latest-effective-opinion mean as the
aggregation policy. A Realm may link more than one such context; identical scale
numbers do not merge questions. The question and scale meaning are immutable for
this profile. The shape binds the explicit Realm and Context focuses, their
reciprocal link and every fixed policy. The installed command requires Account
`rating:configure` and Access `rating.context.create` at
`rating:context:{Realm URI}`. It writes a guarded immutable context manifest,
receipt and private typed event. Public reads verify the manifest. A retained
creation and terminal cancellation replay under recovery hold. Observation,
withdrawal and aggregation commands remain separate work.

An Observation is one rater's evaluation in an admitted slot. A correction,
withdrawal or restoration changes that observation's revision, stored as an immutable application revision manifest. A new day or deliberate experience creates another observation; retrying
the same command does not. Context wording/scale/population meaning changes create
a new context; changing only aggregation policy creates a policy revision.

The first `realm-standing-rating-observation-v1` profile requires an opaque
slot for one Account principal, RatingContext and MainVersion, an exact current
head and a distinct revision. An available revision carries one integer 1–10;
a withdrawn revision carries no value. Corrections, withdrawal and restoration
name the exact predecessor. Evaluation, submission, original submission and
revision times have separate typed fields. The shape verifies explicit Realm,
Context, Work, MainVersion, Observation and Revision focuses. The installed
command verifies Account `rating:submit` and Access `rating.observation.set` at
`rating:observe:{RatingContext URI}`, derives the slot from the Access principal
ID, and conditionally replaces its exact current head. It stores each revision
and four server times in an immutable manifest. Initial evaluation and
submission coincide; a correction preserves the initial evaluation and original
submission. Stale and strongly cancelled admissions receive terminal receipts.
Jena may shorten the fractional seconds of an `xsd:dateTime` literal; reads
compare the instant and revision writes restore canonical server ISO text before
persisting another immutable manifest.
The private exact-revision read requires Account `rating:read`, current Access
`rating.observation.read` at `rating:read:{RatingContext URI}`, and the same
active Account principal. Retained revisions and cancellation replay under
recovery hold. Public graph records and relay envelopes omit the Account
principal ID. Aggregation and joined search remain separate qualification.

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

The first `realm-standing-latest-mean-v1` public query reduces current heads for
one Context/MainVersion after checking the active Realm and target. Its admitted
limit is 100 standing slots; a larger population receives a budget error. Every
included revision must have an intact immutable manifest, one opaque slot and a
1–10 value or a valueless withdrawal. The result separates total slots, active
count and withdrawn count, provides a ten-bucket histogram and exact integer
sum/count alongside a numeric mean, and uses `no-data` precision when count is
zero. This is a complete bounded snapshot at its source position. Materialized
projection generations and joined rating search remain to be qualified.

Responses include scale, selected policy, population/time coverage, generation,
precision and missing/unavailable states. Qualify concurrent slot admission, DST,
persona switches, correction/withdrawal, empty populations and reconstruction.

[Schema.org Rating](https://schema.org/Rating) supplies scalar value and scale
terms for suitable observation exchange. [RDF Data Cube](https://www.w3.org/TR/vocab-data-cube/)
is an analytical view. REZICS owns the question identity, admitted slot,
private counting key, revision and reduction rules.
