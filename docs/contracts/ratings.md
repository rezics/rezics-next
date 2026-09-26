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

### Realm daily v1

`realm-daily-rating-context-v1` is a distinct immutable question profile. It fixes
the same MainVersion grain, Account population and integer 1–10 scale as standing,
with daily cadence, ISO calendar and a canonical named IANA `timeZone` selected
at context creation. Changing the timezone creates another Context. The API accepts
this profile at `POST /v1/rating-contexts`; public context reads return its timezone.
Numeric client offsets and per-submission timezone overrides are not admitted.

`POST /v1/rating-observations` also accepts
`realm-daily-rating-observation-v1`. The body has the standing fields: Context,
Work, MainVersion, value or null, acting subject and exact `expectedRevisionHead`.
With a null head, Access's durable `registered_at` instant selects the current
civil day in the Context's timezone. No client time, day, period or counting
identity is accepted. The opaque slot hashes the private Access principal,
Context, MainVersion, daily cadence and civil date. Another persona cannot add a
slot; another principal or day can. Concurrent first writes have one winner and
terminal stale-head losers. A retry retains its admission instant across midnight.

With an exact head, the server derives the original day/slot from that revision
and verifies its private principal binding. Correction, withdrawal and restoration
retain the Observation and its evaluation/original-submission time, even on a
later day; a null value withdraws without reviving an earlier value. A stale head
gets the existing terminal 409 behavior. A new day requires a null head and a new
idempotency key. Existing Account and Access configure/submit/read authorities
apply, including active principal checks. Exact revision reads accept the daily
profile as a query discriminator and require that same private principal.

Each daily Observation and immutable revision records `day` (`YYYY-MM-DD`),
`timeZone`, ISO calendar, and half-open `periodStart`/`periodEnd` UTC bounds.
The owner schema uses separate daily Context/Observation/Revision types alongside
their base Rating types, and separately generated shapes and native bindings.
The immutable Context manifest fixes timezone; the Observation manifest fixes
the selected period and all four timestamps. Existing standing profiles, manifest
bytes, receipt identifiers and relay envelope fields remain compatible. Daily
effects reuse the admitted action's receipt identity and retained manifest channel;
recovery validates the daily profile and private slot without recalculating stored
bounds using a later timezone database.

Point lookups bind Context, target, opaque slot and exact revision through TDB2
indexes. Admission/idempotency uses Access's existing unique principal/action/key
index. Each command reads/writes a constant number of bounded nodes and one
manifest; it never scans the Context's voters or all historical days. Reject
ambiguous/missing dependencies. The real-owner fixture enforces at most 24 graph
read calls and 64 KiB of returned graph bytes per measured branch, including
retries and nested receipt/manifest checks, while growing the exact slot's history.
Native engine work and deployment capacity require separate qualification.
Daily aggregation and new
cross-context policies remain outside this profile.

The calendar decision follows [Temporal's start-of-day semantics](https://tc39.es/proposal-temporal/docs/zoneddatetime.html#zoneddatetimestartofday--temporalzoneddatetime)
(reviewed 2026-09-26): use the first valid instant of the civil day and calendar
addition for the next day, including skipped/repeated midnight. Fixed 24-hour
arithmetic and client-provided offsets fail DST counterexamples. The pinned
Temporal polyfill uses the pinned server runtime's IANA/ICU data. Stored exact
bounds are authoritative for existing observations; timezone-data upgrades affect
only newly admitted periods. Tests exercise both DST transitions, midnight gaps,
retry/concurrency, persona changes and retained replay; small fixtures do not
qualify deployment capacity.

### Realm experience v1

`realm-experience-rating-context-v1` fixes experience cadence and otherwise uses
the standing MainVersion grain, Account population, English question and 1–10
scale. `realm-experience-rating-observation-v1` requires an `occasion`: a canonical
lowercase UUIDv4 that the client creates once for one intentional evaluation.
It is a bounded opaque marker, not evidence that an external event occurred.
Clients retain this marker for retries, corrections, withdrawal and restoration.
An intentional new evaluation uses a different marker and null expected head.
No client timestamp, external event lookup, persona or counting identity can
determine the occasion's private ownership.

The server hashes the active Access principal, Context, MainVersion, experience
cadence and occasion into an opaque slot. It derives a separately namespaced
opaque occasion reference from the same tuple. RDF stores only those references;
the raw marker lives in the private immutable revision manifest and authorized
exact reads. Switching personas cannot multiply the same occasion. A different
private principal remains distinct even when it supplies the same marker.

The POST uses the existing Account/Access submit authority and mandatory
idempotency header. Exact same-key retries return the original immutable receipt;
changed payloads with that key conflict. A new key with an occupied occasion and
null head receives terminal stale-head 409, even with an identical value. It does
not create or silently correct an observation. Corrections require that occasion
and its exact current head. A different occasion with an existing head conflicts.
Concurrent first commands converge on one observation; losing commands retain
terminal receipts. Withdrawal keeps the head with no value, and restoration
requires that withdrawn head. Earlier values never become effective implicitly.

Separate experience Context/Observation/Revision shapes and native bindings fix
the opaque occasion reference and exact predecessor. Each revision manifest
records the raw marker, both opaque references, profile, target, predecessor,
value/availability and all four timestamps. The durable Access admission instant
supplies submission/revision time. Initial evaluation and original submission
equal that instant; later revisions preserve both. Recovery verifies the retained
marker against the admitted private principal, request digest and timestamps,
then replays the same receipt and manifest under hold. Standing/daily shapes,
digests, manifest bytes and receipt identifiers remain unchanged.

The occasion is separate from request identification: [AIP-155](https://google.aip.dev/155)
describes deduplicating requests, while [AIP-154](https://google.aip.dev/154)
describes checking resource freshness before updates (reviewed 2026-09-26).
Using a new retry key as an occasion would duplicate one evaluation after a
client retry-key change. A server-created occasion resource would require an
extra admission and receipt without establishing that an external event happened.
The selected client marker plus private server binding avoids both problems.
[RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.4) supplies the
UUIDv4 format; this profile restricts spelling to eliminate case aliases.

Cost is bounded by one exact Context/target/slot lookup, a fixed number of exact
revision/manifest reads and one successful command/manifest. A losing race may
issue one additional terminal command. No operation enumerates other occasions,
voters or revision chains. The selected fixture enforces 24 read calls/64 KiB,
at most two command calls/32 KiB of command JSON per branch and stable point-read
cost as unrelated observations grow. These are API adapter cost bounds; native
operator complexity, contention and deployment capacity need separate evidence.

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
