# Rating

Rating owns native ratings: questions, votes, and the aggregates of those votes over populations. In code and
interface text, "rating" and "score" alone mean this opinion measure; an age or content classification is always
named in full ("age rating", "suitability") and lives with classification.

## Questions, votes and populations

A **question** is what a rating answers ("How much did you like this work?", "How good is this translation?"). It
has an exact revision, a scale and a target grain (work, release, episode, character). The standard question is
shown from 0 to 10 in steps of 0.5 and stored as integer units from 0 to 20. A cleared vote is a tombstone, never
a zero. Changing what a question asks creates a new question; votes stay with the meaning they were given under.

A **vote** is one person's current answer to one question about one target. There is exactly one current vote per
(person, question, target). It lives in the voter's partition, so a popular target is never a write hotspot.
Accounts declared under one controller count once, with the latest vote.

A vote keeps the target it was cast on. Its `counted_target` equals that target until a merge changes where it counts;
it is NULL when the vote counts nowhere. Aggregates use the counted target, and a partial unique index allows at most
one counted vote per voter, question and target. When two subjects merge, a person's vote or clear on the survivor
wins; otherwise their vote on the merged subject counts there. If several merged subjects feed one survivor and the
person has no survivor vote, the latest-changed merged vote counts. Equal change times choose the vote whose original
target id sorts first. A later vote on the survivor replaces the merged vote that counted there, while both vote rows
keep their original targets. Unmerge does not exist in the kernel. Because targets stay on the votes, a later unmerge
can recount them; one vote never becomes two.

A **population** is a set of people whose votes an aggregate counts: Global (every eligible account) or one Realm
(its current members). A population is a segment of one measurement, not a separate measurement: the same vote
counts in Global and in every Realm whose population includes the voter. A person never votes again to be counted
in a Realm, and nothing has to choose which of a person's Realms their vote "belongs to".

A Realm that wants a different question (for example a translation-quality score) defines its own question. Its
votes are separate because its question is separate, and it is always displayed under its own label.

## Aggregates

An aggregate is kept per (question, population, target) as additive components: count, sum and a histogram over the
scale's units. Means, Bayesian scores and roll-ups are computed from components and never stored as inputs. The
standard question also publishes a separate current figure projection for search and display.

- A vote, change or clear updates the Global aggregate and the aggregate of each Realm whose population includes the
  voter, asynchronously and idempotently, by subtracting the previous value and adding the new one. The number of
  Realms a person's votes count in is capped, which bounds the work of one vote.
- An operator transfer moves an account's votes to its new controller's count through a paged recount.
- Joining a Realm adds the member's existing votes to that Realm's aggregates; leaving or a ban removes them. This
  runs as a resumable paged job; each page touches a bounded number of votes, and affected aggregates report that
  they are updating until it finishes.
- Every aggregate declares its freshness. A takedown or erasure of a vote, an account or a target reaches the
  aggregates within the declared bound.
- Hot targets keep sharded components that are summed on read.
- Imported scores (Bangumi, VNDB and other sources) are source statistics, kept and shown separately with their
  source. They are never merged into a native aggregate, and no native votes are invented from them.

Different questions, scales or grains are never combined. Episode ratings do not feed a series score; release
ratings do not feed a work score. A roll-up over members (for example a series over its works) is a named metric
with its formula, member count and coverage, and is shown only when it covers at least half its members.

`readAggregate` reads the question scale at the question's encoded home, population freshness at the population
home, and at most sixteen component shards at the target home, in three separate statements. Each home is bound
through the ordinary partition reader, so a missing or moved home is unavailable rather than an empty aggregate.
The default `/ratings` route uses `readAggregateFigure` through this reader; its thresholds and stored-unit mean
and histogram stay the same. An unknown question returns null without reading the population or target. A known
question with no components returns zero count, sum and a zero histogram sized by that question's scale.

For a pool caller, each home uses its own read-only repeatable-read observation and releases its connection before
the next checkout, including before the target read. A caller-owned `PoolClient` (or query-only snapshot client)
keeps its transaction lifetime: the reader binds each logical home separately on that physical database snapshot,
without nested checkout or transaction control, as supported by the shared read composition. Callers that need a
physical database snapshot supply the existing read executor's client; no atomic snapshot across databases is
promised. The reader never joins foreign tables into the target statement.

`appliedAt` is the latest applied time among the observed target shards, or null without components. `updating`
reports whether a population job was pending at the separate population observation; it is false without a pending
row. A job may start or finish between these observations. These fields describe those observations, not an atomic
membership-and-components snapshot or a guarantee that every asynchronous vote has been applied. Count, sum and
histogram components are decoded and added exactly as BigInts before the existing figure conversion.

### Counted population-total delivery

`applyRatingChanges` keeps its completion contract: successful return includes visible population totals. It first
captures each distinct immutable question scale in a separate anchored question-home repeatable-read observation,
releasing all those connections before target checkout. It groups changes by target partition in commands of at
most 100 changes. A target command touches only local counted votes, aggregate components, pending figures and
population-total delivery state. It captures the actual before/after counted winners, including both counting-key
shards on rekey, rather than raw vote units or a presumed one-voter increment.

Each target command atomically commits its components, immutable signed count/sum deltas, a target-local pending
obligation, and `com.rezics.rating.population-total.delivery.v1` through the native history/outbox contract. A
monotonic serial identifies each (source partition, population) stream. One event contains at most 200 distinct
question/shard deltas; a source page produces at most 100 deliveries plus its unchanged `aggregate.applied.v1`
event. Counts and sums remain exact BigInts. The sixteen private-key-selected total shards are unchanged.

The default rating work module registers `rating_population_total` with the existing effects registry and relay.
Its admission hook inserts an immutable destination inbox item using only the supplied short transaction, released
before enqueue. Foreground completion uses that same admission and population-home receipt implementation after
the target command releases. There is no extra worker or queue. An exact population-home command locks the stream
frontier, requires the next serial, updates the affected shards, marks the inbox applied and emits a durable received
continuation atomically. A separate source-home command acknowledges that exact obligation and emits the existing
aggregate-applied event to wake figure work. Duplicate receipt and acknowledgment are idempotent point operations.
The native relay also retains the ordinary history-event consumer custody until its effect finishes.

Reordered items remain in the inbox without advancing the frontier. A received continuation probes exactly one
successor and emits the next continuation on commit; an item admitted later can apply through its own effect. An
earlier contribution is never discarded because a newer serial arrived. Receipt and totals roll back together on
failure, including negative-shard constraint failures; totals are never clamped. Two source streams updating the
same shard use additive locked PostgreSQL updates, so neither replaces the other's contribution. A source crash
before delivery retains its outbox and pending obligation; a destination crash before acknowledgment retains its
applied receipt and continuation. Retrying a vote also drains previously committed obligations instead of attempting
to reconstruct their old deltas. Foreground completion selects only the caller's populations in batches of 100,
reading pending source obligations in pages of 100. It includes their necessary ordered predecessors; unrelated
population backlogs do not extend that call. Figure draining completes its source partition's pending pages before
publication. Total recovery work grows with pending page count; each individual effect replay performs fixed keyed
work without a receipt-history scan.

Installation retains every nonzero total as the cutover baseline. Use the ordinary worker revision rollout:
retire the old handlers, apply the migration, then start the new default work module to recover interrupted work.
Do not continue old handlers through their retry budget against the new fence. The migration locks the total
relation while installing an always-enabled writer fence. All old committed total writes precede that barrier;
any residual old transaction that reaches a changed total after it fails and rolls back its entire source command. New population-home commands set a
transaction-local writer marker. Prior-check-only updates remain permitted. Already applied old vote/segment
history is idempotent against its existing counted votes and emits no new delta; unapplied history goes through
the shared new writer. Legacy aggregate-applied history only wakes drains and never adds totals. New serials
start at one; no per-target baseline initialization, cross-home join, full scan or manager installation step is
needed. A missing predecessor is a gap, never a zero contribution.

Outstanding delivery is represented by source pending rows and their exact partition-local pending count and
generation. Figure preparation requires no outstanding delivery, then checks destination prior epochs and captures
priors in released population-home snapshots. The subject command rechecks that local generation and pending count;
a concurrent capture or acknowledgment invalidates the preparation and leaves figure marks pending. This prevents
an early target aggregate event from permanently publishing against its own undelivered totals. It does not promise
an atomic snapshot across source targets or populations. Population membership-job `pendingJobs` and aggregate-reader
`updating` retain their existing meaning; they do not claim to expose this delivery backlog. The existing declared
freshness bound still applies, including erasure and takedown. Recovery uses the installed runner's admission and
retry schedule; this protocol adds no stronger wall-clock latency guarantee.

### Public figure

A public figure is stored for each (standard question, population, subject) in the subject's anchor partition. It
contains the count and a display-scale mean rounded to four decimal places from the grain threshold (5 votes for work
or release, 10 for episode or character). Below threshold only count is published. Realm-defined questions have no
public figure.

Counted totals per (question, population) keep additive count and sum in sixteen population-home shards, delivered
through the durable protocol above. For the standard question, the serial figure drain checks those totals. The first prior epoch
starts at 50 counted votes. A later epoch starts when the total reaches twice or falls to half its count at the
current epoch's start. Each epoch freezes its display-scale mean `m` and grain threshold `C`. Falling below 50 ends
the active epoch. A figure's Bayesian score is `(C*m + sum)/(C + count)` when its own count reaches `C` and the
population has an active prior epoch; otherwise the score is null. Figure events and reads always carry the frozen
epoch mean, count and epoch number. An epoch start or end republishes every currently rated subject through durable,
resumable pages of at most 500 figures.

`population_prior_epoch` is the sole population-prior authority. Before a publication page, the drain selects at
most 500 exact pending figure keys in a subject-home read. It then reads each distinct (population route, question,
population) prior in that population home's own anchored repeatable-read snapshot, releasing every source connection
before any subject command. Republish marking captures its prior the same way. Each existing subject command
materializes `subject_home_prior_input`, keyed by subject partition and exact population route/question/population,
and uses only that local input, local components and question configuration. No subject transaction reads the
population authority. Absent, inactive and active inputs retain their exact generation, epoch and frozen `m`/`C`.
Only a strictly newer generation replaces a local input; equal or delayed older deliveries cannot change its values.
Publication requires the local generation to satisfy both the published floor and any pending generation, and labels
its values with exactly that generation. A stale capture leaves an unsatisfied mark pending. Epoch changes keep their
existing durable republish cursor and work events, so concurrent changes converge without locks across homes.

Aggregate applies mark affected figures pending with the anchor-partition position. A serial drain reads at most 16
shards per pending figure and publishes at most one changed-figure event per figure in each page of at most 500. A
published figure's revision increases for every changed snapshot; the event carries the same current fields returned
by the internal reads.

`readPublicFigures(client, { partition, questionId, populationId, subjectIds })` reads at most 256 current figures
with one statement. `pagePublicFigures(client, { partition, questionId, populationId, after, limit })` reads at most
500 current figures in subject order with one statement. The page directly constrains the equality prefix
`(partition_no, question_id, population_id)` and strict `subject_id > after` cursor beneath its ordered limit,
using `public_figure_population_subject_idx` and its `revision > 0` predicate. A null cursor starts before all
valid subject IDs. The batch retains exact full-key seeks for the requested IDs. Both reads retain the published
values, including numeric zero, revision, as-of time and position, while a newer publication is pending.
`publicFigureState(figure, grain, pending)` computes the shared consumer state from the published count and the
figure's pending mark: `ready` at the grain threshold, otherwise `updating` when pending and `insufficient_data`
when not. A ready figure remains ready during an apply and retains its last published numbers. No published row
means count zero; a pending, unpublished row reports `updating`.
`readPublicFigureViews(client, subjectIds)` reads the standard question and Global population for up to 256
subjects across partitions in the caller's `REPEATABLE READ READ ONLY` snapshot, without transaction control.
Non-empty calls use exactly two statements: the question by key and published fields plus pending marks by full
subject keys. Empty calls use none. Every requested subject receives a view, including unpublished or absent rows;
the reader shares `publicFigureState` and the mean/score rules with the subject figure route. Realm populations,
votes and shard totals never enter this read.

The search adapter `createPublicRatingSource` reads standard-question Global figures in batches of at most 256 anchored subjects.

## Thresholds and privacy

A mean is published from 5 votes on a work or release and from 10 on a finer grain (episode, character
appearance). Below that, only the count and how many more votes reveal the score are shown. A population below the
threshold also hides its histogram, so a small Realm never reveals its members' individual votes. Ranked lists use a
Bayesian weighted score whose prior comes from the same question and population, from at least 50 votes.

Aggregates of a readable subject are public facts. Anyone who can read the subject can read its Global figure; a Realm's
figure follows that Realm's read visibility. A person's own vote stays private to them. It counts anonymously in the
aggregates of the populations they belong to: an aggregate at or above the threshold reveals no individual vote, and a
person who does not want to be counted clears the vote. Votes of suspended or banned accounts, and of members a Realm
has removed, leave the affected aggregates.

## Display

Every score is shown with its population and its count ("8.4 · 1,203 ratings on REZICS", "8.9 · 64 ratings in
Realm Name"). The rules are the same on every surface:

- **Headline.** The general site shows the Global population to anyone who can read the subject, including anonymous
  readers. A Realm-routed page or Zone shows that Realm's population and says so in one line, with Global next to it.
- **Several Realms.** The population picker pages through readable populations that rated the target. Anonymous
  readers see the headline and readable populations through the picker; there is no "viewer's Realms" list. Figures
  from different populations are never averaged, blended into a personal number, or substituted for one another when
  one is missing.
- **Cards.** A subject card (search, shelves, feeds) shows the headline population's figure for the site it is on,
  with a population mark whenever it is not Global.
- **Question.** The standard question is the default everywhere. A Realm's own questions are listed by name; the
  page never picks "the first" question of an unordered or partially read list.
- **Writing.** The score control writes the viewer's one vote for the question shown. It is the same control on the
  general site, on a Realm page and in a Zone.
- **No data.** With no votes, nothing is drawn: never a zero, never an empty histogram. Below the threshold, the
  count and "n more ratings to show a score".
- **Own vote.** The viewer's own rating is shown once, as theirs, and is the same value in every population.
- **Imported scores** appear after the native figures, labelled with their source and their own scale.
- **Search and sort.** Rating facets and rating sort use the Global population and the standard question, unless the
  search runs inside a Realm-routed site, which uses that Realm's population and says so. A query parameter never
  selects a population implicitly.

### Question and public-figure presentation

The subject headline and its structured metadata use the existing `/figure` PublicFigure; Search renders the
`figure` supplied on each hit without a second read. Display the published mean with Global, its count and its
0–10 display units. The separately explained Bayesian score determines rating order; it is never substituted for
the mean. A null mean is unknown, a published zero mean is valid, and a zero count draws no numeric figure.
Below threshold, show only count and the publication requirement. Pending publication is labelled, while an
already ready producer snapshot retains its published numbers. Native publication happens after processing, so a
successful private vote write does not claim the public figure has changed.

Load the standard question by its exact id for its label, revision, grain and stored scale. The standard question's
stored bounds map to the documented 0–10 display domain; its stored `displayStep` determines valid input steps.
Controls and server-side input validation use the returned bounds and step rather than hardcoded stored units.
Zero is a vote and clear is a separate DELETE. The own-vote read stays private and session-bound.
`/ratings` supplies distribution and labelled Realm details, never the headline or metadata value. Imported
statistics follow native figures with their independent source, scale, count, as-of date, licence and attribution;
they never supply or alter the native mean, vote count or ordering score.

## Realm question authoring and selection

Decision: `owner_id` remains the creating account; separate `realm_id` records Realm provenance, and explicit
`?realm=` selects that Realm's definitions without changing the default Global directory or its cursor binding.

`POST /v1/realms/{realmId}/rating-questions` accepts strict JSON
`{ meaning, label, grain, scale: { min, max, displayStep } }` with `Idempotency-Key`. `meaning` is the exact
immutable opinion being asked (1–2,000 Unicode code points); `label` is its distinct nonblank display name
(1–200 code points). Text is retained exactly, including intentional whitespace, and rejects NUL. Grain is
`work`, `release`, `episode` or `character`. A changed meaning, grain or scale requires a new identity.
Creation wording stays immutable; the separate caption command below corrects presentation. This slice exposes
no retirement or Global authoring command. Native Realm lifecycle and grants keep
their existing owners.

The creator must be a current authenticated account with ordinary native `realm:manage` authority on that
selected active Realm. Membership and role names are not substitute authorizations. `resourceAuthorization`
prepares and verifies current Access for each command attempt before receipt lookup; revoking manage denies
an exact replay before it discloses the earlier result. The command writes one question, receipt and registered
`com.rezics.rating.question.created.v1` event in the Realm's single native partition. Its generated ID encodes
that Realm's route. `owner_id` records the creator, rather than a Realm ID or permission shortcut. The receipt
digest binds principal, operation and the complete definition; changed inputs with the same key conflict.

Success, including an authorized exact replay, returns HTTP `201` with
`{ id, realmId, meaning, revision: 1, label, canonicalLabel: label, labelRevision: 1, grain, scale }` and ordinary session progress. Meaning, provenance,
revision and scale persist together. A database trigger rejects changes to authored definitions. Existing
legacy definitions retain their previous representation and the seeded standard question remains unchanged.

Supported scales are integer stored units with `0 <= min < max <= 20`, positive integer `displayStep`, and
`(max-min) % displayStep === 0`. Binary `0..1` and integer `0..10` questions are supported by the installed
vote SQL, event validation and aggregate histogram path. Votes must lie on the exact selected scale. Display
mapping is consumer-owned: custom `0..10` does not inherit the standard question's half-point display mapping.
The separate scale-delivery owner removes the native `0..20` envelope across that delivery path; this command must consume its
bounds only after that capability is delivered. A definition is never proof of ranked population readiness;
custom-question rank publication remains with its separate owner.

`GET /v1/rating-questions/{id}` refreshes the exact selected definition. Legacy definitions keep their exact wire
shape; Realm definitions add `realmId`, `meaning`, `canonicalLabel` and `labelRevision`; `label` is the current caption. `GET /v1/rating-questions?realm={realmId}&limit=1..20`
uses the existing `{ ratingQuestions, next }` capability with explicit native Realm selection. It does not merge
or infer Realm choices from Global pages. Its opaque continuation binds the exact selection, limit and every
verified viewer/credential authority field, with sorted distinct scopes, the existing 15-minute expiry and
4,096-character cap. Default Global tokens retain their previous binding. Tokens cannot cross viewers or
selections. Unknown, duplicate or invalid query parameters fail rather than changing the selection.

Each selected Realm page performs two native Realm readability observations, one before metadata and one before
release. All rows share that Realm; no ownership or membership join replaces Access. One indexed seek consumes
at most 20 raw rows plus one unconsumed lookahead and hydrates at most 20 definitions. Progress uses the last
raw key, and no total or completeness claim accompanies an empty page. Each page is a fresh observation, not a
snapshot of the catalogue across requests. The cursor resumes after the consumed raw key even if earlier rows
are no longer present. Point reads perform one exact question-home metadata seek, one native home binding and
one current authority observation after releasing the metadata snapshot. Page reads bind the selected Realm
home. No operation holds a metadata checkout while preparing another native authority observation.

Unknown or unreadable questions/Realm selections return `404`; missing manage returns `403`. Invalid definitions
return `400`; changed idempotent inputs return `422`. Native authority, moved-home, admission or database failure
retains ordinary `503` unavailable states, never empty metadata or allowed admission. Protected labels cannot
enter the default Global directory. Vote writes recheck question readability during every native command
preparation before receipt disclosure; private own-vote reads also recheck it. Standard vote admission retains
its existing scope contract. Aggregate and population HTTP handlers select current readable metadata before
reading numeric results. Low-level aggregate functions remain trusted computation ports, not disclosure ports.

`readVisibleRatingQuestion` and `ratingQuestionView` in `question-directory.ts` provide exact current provenance,
meaning, revision, grain and scale for native consumers, including the rank owner. Review-context selections use
that authority boundary on initial and continuation observations. Content point and board-page disclosure hides
an unreadable custom question's citation while retaining the ordinarily readable post; unavailable authority
propagates. Standard citations retain their existing behavior. Content's `reads.ts` and
`review-context-eligibility.ts`, plus Rating's internal aggregate metadata export, change outside the declared
paths solely to close those provenance boundaries. Search controls, query/partition coordination, Web interfaces,
membership repair and custom rank publication are separate deliveries.

`test/kernel.test.ts` adds the new command to the exhaustive typed route contract while retaining every existing
route assertion. This is outside the declared paths because the kernel contract must include every mounted route.

Focused outcomes live in `test/rating/realm-question-authoring.test.ts`: native manage grants, creation and exact
replay, changed-input conflict, persisted author/provenance, point/selection refresh, binary and `0..10` scales,
protected/ban denial, current vote admission and manage loss before replay. Physical growth is unmeasured;
the dev verifier owns clause measurements and broader acceptance after integration.

### Question caption maintenance

Decision: label revision 1 resolves immutable creation wording; separate caption heads start at 1, corrections
append from 2, and point/directory views expose `canonicalLabel` alongside current `label` without changing
measurement metadata or directory cursor epoch.

`updateQuestionLabel(deps, actor, { questionId, expectedLabelRevision, label }, context)` is mounted at
`PUT /v1/rating-questions/{questionId}/label` with `Idempotency-Key`. A signed-in currently authorized Realm
curator supplies an exact integer presentation revision and a nonblank caption of at most 200 Unicode code
points, with no NUL. Original bytes, including whitespace, are retained. The result is
`{ questionId, labelRevision, label }` plus ordinary session progress. There is no operator shortcut, inferred
ownership, Global/standard authoring or permission formula. The native Realm `realm:manage` decision and current
question/Realm readability run before receipt lookup on every attempt, including retry after revocation. Missing
and concealed questions both return `404`; a readable question without manage returns `403`. The existing
producer's released preparation proof and evidence deadline govern command races; no metadata checkout spans
native Access preparation. The question and active Realm are validated in that native preparation. A lost or
erased question cannot be recreated by receipt replay.

The question-home command locks one presentation head, compares the expected label revision, inserts one
immutable revision, advances its separate head and records its ordinary receipt and registered
`com.rezics.rating.question.label-changed.v1` event atomically. A conflicting head returns `409` with no state
change. Reusing a key for changed input returns `422`; an ambiguous response retries the exact same body/key.
Even an identical caption appends a revision when explicitly submitted at the correct head. The event contains
only question/Realm IDs and presentation revision, never caption text or copied profiles.

`readQuestionLabel` (`GET /v1/rating-questions/{id}/labels/{labelRevision}`) resolves exact retained bytes.
`readQuestionLabelHistory` (`GET /v1/rating-questions/{id}/labels?limit=1..20&cursor=...`) returns
`{ labels, next }`, with each label `{ questionId, labelRevision, label, at, author }`. Revision 1 reads the
canonical creation label and creator directly from the immutable question; its timestamp is null because the
producer did not retain one. Corrections retain exact author ID and authoritative command time. Authors use
Access's current `readPublicIdentities` allowlist, including deleted identity tombstones and absent/pending
identity omission (`author: null`), with no profile copies. Exact caption references identify the question and
presentation revision, independently of author/account history.

History is ascending, with a signed initial revision ceiling, strict consumed-revision keyset and at most 20
consumed rows plus one unconsumed lookahead. Tokens bind viewer credential/session authority, question, Realm,
limit and ceiling through the existing 15-minute seal; another viewer, question or limit cannot reuse them.
Appending later captions does not extend an existing traversal. Every request refreshes current question/Realm
disclosure before reading and again after provenance hydration, releasing each anchored observation before the
next checkout. Ban, concealment, question loss and account/session fences remain current native decisions;
old tokens and exact references grant no disclosure authority. Failures propagate as unavailable, never as empty
history. Retention follows the native question: revisions persist independently of author profile lifecycle,
remain concealed with that question/Realm, and cascade only if the native question is physically removed. This
command introduces no deletion, retirement, author-history restoration or lifecycle jobs.

`question-read.sql` keeps canonical `label` and measurement `revision` unchanged and adds separate
`presentationLabel`/`labelRevision`. Existing actual callers (`votes.ts`, `aggregate-read.ts`,
`public-figure-http.ts`, and `question-directory.ts`) retain canonical measurement fields. Only
`ratingQuestionView` selects the latest caption for HTTP point/directory presentation and also emits
`canonicalLabel`; immutable meaning, scale, grain, population and vote units never change. Frozen rank/prior
references must continue using canonical measurement metadata. Directory pages retain the producer's fresh
observation/keyset contract and epoch 1; caption changes neither rebuild aggregates/populations nor invalidate
selection tokens. Latest captions come from a head point join, without history scans or public discovery copies.

#### Operation Cost

- **Touches:** command: bounded native question/Realm authorization, one head lock, one revision insert, one
  head update and ordinary receipt/event; current point/directory: one head primary-key join per question;
  exact caption: two disjoint revision-1/retained-revision point branches; history: one question-home indexed
  `(question_id, revision)` keyset plus the revision-1 point, followed by current account presentation and final
  disclosure. All observations release before checking out another home.
- **Bound:** history consumes at most 20 labels, one lookahead and 20 distinct author point hydrations; exact
  reads hydrate at most one author. SQL pushes the limit into the correction branch before union ordering.
  No per-request census, refill or all-partition scan; command rows and statements are constant. Index descent
  grows logarithmically with retained captions; full traversal grows by page count. Directory costs retain
  their existing 20-row budget with one additional local head seek per row.
- **Growth check:** `test/rating/question-label.test.ts` pins the connected native outcome and bounded keyset
  behavior. Physical clause/growth measurements remain the dev verifier's work; no custom rank cost is inferred.

`rating/events.ts` changes outside the declared paths to register the caption event; `test/kernel.test.ts`
adds the three mounted paths to the exhaustive typed native route contract. No existing behavior assertion is
removed. `library/collection-reads.ts` removes an identical duplicate import already present on the base, solely
to unblock the required workspace type-check; library behavior is unchanged. `db/rating/schema.sql` records the additive migration snapshot.

## Protected Realm rank source

The adopted second scope includes Realm rating order. Private Realm numbers stay outside the common Search
index. Search imports `createRealmRankSource` and `RealmRankSource` from [realm-rank.ts](realm-rank.ts), composes
the factory with the production `{ pool, access, tokens }`, and calls
`page(actor, { realmId, questionId, partition, sort: 'score_desc', limit, cursor? }, { deadline })`.
The actor comes from native credential verification. The factory performs current Realm authorization itself,
then checks every consumed candidate through native subject Access and current identity before release; an
unreadable or redirected subject contributes no returned figure. Missing or denied Realm returns `not_found`.
Unavailable authority, data or moved homes fail closed. Search owns selection/rating-sort controls, query
integration and coordination of partition-local pages; Content retains the native partition-local producer contract. This port installs no additional search route or service.

Decision: the first usable slice requires an explicitly selected standard question, one subject partition and
descending Bayesian score; other questions return `invalid_request` until their separate private publication lands.
Global is rejected as a Realm selection. The remaining question publication and lifecycle proof are described in
the continuation brief; the Global source and public figure transport retain their existing contracts.

The result is `{ candidates, next }`. Each candidate contains `{ subjectId, count, mean, score, priorEpoch,
revision, asOf, updating }`, with the standard question's display units. Only threshold-ready, actively scored figures in
the selected population's current prior generation qualify. No unscored tail, suppressed counts, histogram,
total, scanned count, raw position or readiness estimate is returned. Zero mean and score remain valid values.
Equal scores use subject UUID descending. A full consumed batch may return a continuation followed by an empty
terminal page. Disclosure filtering can shorten or empty a page; the reader never refills it.

`rating.realm_rank` is a private, subject-home ordered projection of the existing standard-question publication.
The publication transaction maintains it through `public_figure_realm_rank`; migration installs the trigger and
backfills eligible retained figures under a write barrier. No external consumer, new queue or asynchronous copy
lies between figure commit and rank visibility. Committed vote, eligibility, membership, identity-repair and erasure
effects reach that publication path and update or remove the rank row in the same transaction. This is separate
from production Semantic repair admission: its held mapping/obligation producer remains unavailable as documented
under Identity repair. Rank
freshness is exactly the existing figure freshness bound, rather than a new synchronous vote guarantee. A pending
publication retains the last eligible published snapshot. Epoch changes exclude old-generation rows immediately;
the existing durable republish pages admit new-generation rows as they converge. An inactive prior admits none.
`updating` reflects the selected population's native pending jobs or that figure's pending publication; `asOf`
stays at the published snapshot's applied time. These observations do not claim to expose an uncommitted repair
or every worker backlog. Empty/suppressed figures supply neither ordering keys nor a continuation position.

Decision: native erasure pages retain revision-only destination fences and stay outstanding until their exact
standard-question figure/rank publications commit; ordinary membership removals retain existing semantics.
The fence stores only the exact contribution key and highest removed revision, without units, counting keys or
vote timestamps. It shares the component command's serializable transaction. Old vote and re-key delivery,
including allow-missing re-key delivery, cannot recreate a physically erased contribution at that revision or
earlier. An erasure delivered before its vote still commits the fence. Identity removals already retain explicit
null contribution rows with ordered revisions, so late original-position events cannot restore an alias score.

Erasure uses its existing page witness and aggregate effect as the retry authority. After components and native
population-total deliveries commit, the effect drains only that page's exact standard-question figure keys and
checks that their pending marks have cleared before acknowledging the native page. Interrupted publication or
acknowledgment retains the witness; replay recovers it even if component work is already applied. The existing
terminal status therefore includes figure/rank convergence for newly applied erasure pages. This does not retrofit
already acknowledged erasures or recover deliveries removed before installation of the revision fence.

Decision: retain native source epoch/position frontiers for membership, eligibility and vote/segment delivery;
finish a population transition only after its committed pages have reached the shared aggregate consumer.

Membership frontiers live in the voter home, keyed by voter and Realm, and eligibility frontiers by voter. They
survive removal of the membership row. A delayed old join, leave, suspension or reinstatement cannot reset a newer
transition. Target homes retain a frontier per voter/question/population/target, including after a removal; native
source epoch and position order lifecycle changes independently of the vote revision. Within one source command,
counted revision orders replacements. Delayed additions cannot resurrect departed votes, and old removals cannot
undo a rejoin or reinstatement. Segment additions preserve original vote times for controller winner selection.

The default worker receipts each source page by transition and cursor, replaying its exact committed data and
source position after a crash. After releasing the voter command it invokes the same aggregate consumer used by
the durable relay, including population-total receipt/acknowledgment. A page cannot complete its workflow step
until this delivery succeeds. Terminal settlement therefore follows every page's component/total delivery; replaced
jobs retain the existing begin-before-finish pending accounting. Figure/prior publication remains asynchronous.
Search must preserve each candidate's published `asOf`, revision and prior epoch during convergence: an eligible
published snapshot can remain visible while updating. `population_pending`/aggregate `updating` describes segment
work, not a completed rank publication or an atomic Access/rank snapshot. An ended prior immediately admits no
candidates. A denied viewer loses access independently of this work and cannot use a saved continuation.

Every continuation is signed with the native token keyring and additionally encrypted so withheld candidate keys
cannot appear in its payload. It expires after 15 minutes and binds Realm, question, partition, sort, limit,
verified credential authority, home epoch, rank source generation and population prior generation. Rank generation
changes atomically with eligible published rows, never with changes confined below threshold. Every request
reauthorizes the Realm, observes the current prior, reads one candidate batch, checks disclosure, reauthorizes the
Realm and reobserves prior and rank generation in fresh physical observations before release. Changed generations
return `invalid_cursor`, including on the first page if publication races it. The reader does not claim an atomic
snapshot of independently homed Access and rating data.

Operation Cost:

- Touches: exact population-home prior and subject-home generation keys; the equality prefix
  `(partition_no, question_id, population_id, prior_generation)` of `realm_rank_score_idx`, then the strict
  descending `(score, subject_id)` seek; native Realm and subject authority/identity probes.
- Bound: `limit` is 1–100. One candidate query reads at most `limit` rows and releases at most that many figures.
  At most `limit` current subject checks and two Realm checks run. Both prior reads and generation reads are
  point operations. Each consumed rank row adds one exact figure-key probe for its pending mark, and each prior
  observation adds one population pending-jobs probe. There is no candidate lookahead, refill, cross-partition candidate scan, aggregate read,
  history replay or population expansion. B-tree descent grows logarithmically; authority retains its existing
  bounded native cost. Publication adds one exact rank upsert/delete and at most one generation upsert per figure.
- Membership/eligibility delivery adds one indexed frontier upsert per source event and per changed target key,
  with no population, membership or history scan. Pages remain at most 100 votes and 101 populations; aggregate
  commands remain at most 100 changes, 16 component shards per figure and the existing population-total bounds.
  Source page replay uses one exact native receipt; terminal settlement uses the existing exact population receipts.
  Retained frontier storage grows with distinct delivered keys, including withdrawn keys; delivery cost does not
  grow with their unrelated history. These are declared bounds, not measured physical growth proof.
- `test/rating/realm-rank-membership.test.ts` covers existing votes joining, leaving, rejoining, prior/threshold and
  rank-generation changes, terminal pending, unchanged Global, immediate denial and replayed native old pages/votes.
- Erasure touches: one exact revision-fence upsert per removed contribution, bounded by the existing 100-vote,
  101-population page. Figure work groups exact subject keys by home/population in batches of at most 100; each
  figure sums at most 16 components through the existing prior capture and publication transaction. A final exact
  pending-key probe gates acknowledgment. Total work is linear in affected keys; B-tree probes grow logarithmically.
  No unrelated figure backlog is scanned. Existing prior-epoch checks and delivery recovery retain their native costs.
- Focused outcomes: `test/rating/realm-rank.test.ts` exercises native votes/default workers, threshold crossing,
  signed continuation restart, current candidate withholding, clear and membership withdrawal, unauthorized
  access and unchanged Global figures. `test/rating/realm-rank-repair.test.ts` connects native repair receipts to
  both rank homes, reorders/replays effects and withholds old source positions using the documented producer seam.
  `test/rating/erasure-status.test.ts` uses native Auth account deletion, interrupted component/acknowledgment
  delivery and late vote/re-key replay to check threshold removal before terminal status. Source implementation
  and these focused outcomes are separate from integrated native/main proof and physical growth measurements.
  Production held Semantic repair composition and its end-to-end lifecycle proof remain continuation work.

## Reviews

A review is a content item about one target. It may cite the author's vote on that target; a review never requires a
score, and a score never requires a review. A cited vote is cited at the revision the author had when writing, so
changing a vote later never rewrites an old review. Permitted readers see the immutable citation's units, question
ID and vote revision. Only the authenticated author sees a differing current vote beside it, using the existing
private own-vote GET. The request never selects a public author vote. A missing, cleared or unavailable private
read adds no comparison; a review without a citation is unscored. Post history uses each revision's stored citation
and references, independently of today's thread references or vote.

## HTTP

Vote routes require an authenticated account with `rating:vote` behind the `personal_library` gate. Vote reads are
private to the authenticated account; the target and question identify a vote but never select its owner. Aggregate,
population and source-statistics reads are public under subject and Realm read rules. Question point and directory
reads use current Global `definitions:read` for legacy definitions, including its native anonymous public floor
and authenticated denials. Realm definitions instead require current native Realm readability, including protected
Realm grants, active hosts and bans. The same provenance check guards vote admission, aggregate/population HTTP
reads, review-context selection and citation disclosure.

- `PUT /v1/subjects/{id}/ratings/{questionId}/vote` accepts the strict JSON body `{ "units": integer }` and
  requires an `Idempotency-Key`. It returns `{ "units", "revision", "at" }` for the caller's current vote.
- A vote write that changes or replays answers the session token; a no-op does not.
- `DELETE` on the same path also requires an `Idempotency-Key`, writes a tombstone for a cleared vote, and returns
  `204 No Content`.
- `GET` on the same path returns `{ "units", "revision", "at" }` for the caller's current vote. It returns `404`
  when no current vote exists, including after a clear.
- `GET /v1/rating-questions/{questionId}` is public and returns `{ "id", "revision", "label", "grain", "scale" }`, where
  `scale` contains integer `min`, `max` and `displayStep` values in stored units. The standard question therefore has
  a scale of `0` through `20` in steps of `1`; its display maps two stored units to one point on the `0` through `10`
  scale.
- `GET /v1/rating-questions?limit=1..20&cursor=<opaque>` returns exactly
  `{ ratingQuestions: RatingQuestion[], next: string | null }`, with default limit 20. Every entry uses the same
  current stored-unit metadata as the point route. This default selection contains only definitions without Realm
  provenance. UUID identity ascending is the only ordering. The `(realm_id, id)` index
  seek consumes at most `limit` entries and probes one unconsumed lookahead; the signed continuation starts after
  the last consumed key. Every page rechecks Global authority before reading question rows. Denial preserves the
  point route's `404`; unavailable authority or data reads retain ordinary problem responses, never empty choices.
  The cursor binds the directory operation, limit and native viewer/credential authority, with the existing
  4,096-character cap and 15-minute expiry. Expired or mismatched tokens return `invalid_cursor`.
  Unknown, repeated and invalid query fields are rejected. There are no text, grain or selected-id filters, totals,
  votes or population statistics. Clients request each page explicitly.
  Choices are metadata, not feed membership, candidate eligibility or Source readiness. The cursor retains only
  a position and does not freeze question revisions or hydrate entries. Selected identity can be refreshed through
  the point route; separate requests do not certify a shared snapshot. This installed directory adds no
  feed predicate, Source, Home consumer or generated client declarations.

  Operation Cost:
  - **Touches:** one metadata page through `question_realm_directory_idx (realm_id, id)`, plus the existing Global authority probes.
  - **Bound:** one indexed seek, at most 21 examined question rows and 20 returned rows, independent of catalogue
    size; B-tree descent grows logarithmically. No alternate catalogue or ownership-derived authority.
  - **Growth check:** native growth execution is deferred. The mounted paging/authority regression in
    `test/rating/public-reads.test.ts` is authored but unrun; workspace typing alone is not native or feed proof.

- `GET /v1/subjects/{id}/figure` is public under `subject:read`, with `404` for an unknown or unreadable subject.
  It returns `200 { figure }` using the reusable OpenAPI `PublicFigure` component:
  `{ questionId, populationId, scale: { min, max, displayStep }, count, state, mean, score }`.
  It selects only the published Global figure for the standard question. `scale` matches the question's stored-unit
  scale; `mean` is the producer's published display mean on 0–10 and `score` its Bayesian score. Both numbers are
  null unless `state` is `ready`, and score is also null without a published active prior epoch. No figure row
  returns zero count, `insufficient_data` and null numbers. Below threshold a pending apply reports `updating`;
  an already ready figure retains its published numbers and `ready` state. The response uses the published revision
  as its ETag (zero before publication) and `Cache-Control: no-cache`, matching other public subject reads.
  The route never reads votes, shard totals or Realm populations. `subject.get` continues to follow the subject's
  head revision and carries no figure; search can reuse `PublicFigure` unchanged.
- `GET /v1/subjects/{id}/source-statistics` returns an array of at most two independent current figures,
  ordered by provider, under the Subject's read rules. An absent, cleared or fenced provider has no row and no
  invented total. Each row retains provider, exact source record, effective fence alias, scale, mean, count,
  as-of date, licence and attribution. Figures never enter native votes, means, priors, rankings or ballots.
- `PUT /v1/subjects/{id}/source-statistics/{source}` publishes one positive observation. The strict JSON body
  contains `sourceRecordId`, `scale`, `mean`, positive `count`, `asOf`, `licence`, `attribution`, optional
  `sourceAlias` and optional `expectedObservation`. It requires `Idempotency-Key` and the shared
  `source_statistic:write` authorization on Global Context, checked before every receipt lookup, including replay.
- `POST /v1/subjects/{id}/source-statistics/{source}:clear` accepts only `sourceRecordId`, `count: 0`, `asOf`,
  optional `sourceAlias` and optional `expectedObservation`, returning 204. Missing aggregates do nothing;
  zero count is an explicit empty observation, never a mean of zero. A clear can remove a fenced figure.
  A different tuple binding is a receipt-backed no-op. A clear of an empty slot retains a tombstone so delayed
  positive refreshes cannot resurrect it; an identical repeated clear has no additional effect.

The closed profiles live in [source-provider.ts](source-provider.ts). `vndb` retains its existing record-key and
caller-supplied scale contract (integer endpoints within 0–4096); the current converter sends `v123` and 1–10.
`bangumi` admits only canonical positive safe-integer subject IDs (`123`, never `00123`, `v123` or a URL), and
exactly the provider's 0–10 aggregate scale. Zero means within scale are valid with positive counts.
No normalization or native source revision is inferred. The Bangumi inventory's 1–10 score buckets and official
aggregate score field inform that profile; an aggregate zero remains representable on its own source scale.
The source inventory explicitly omits Bangumi ratings from current imports: this capability grants neither
licence nor adapter approval. Imports still omits `score`, `score_details` and `rank` until separately admitted.
Profile policy does not depend on alias spelling. Other providers remain rejected in mounted strict parameters,
response/event schemas, native types and database constraints.

Decision: keep legacy VNDB response shapes unless a writer opts into observation metadata with
`expectedObservation`; Bangumi responses always identify their unversioned observation.
Both write operations accept `sourceAlias` using the existing fence grammar (`^[a-z][a-z0-9_-]{0,31}$`).
Omission and the explicit provider ID bind the same tuple and preserve existing VNDB receipt digests. Aliases
select the facts-fence home, never a provider profile. A custom alias is retained in responses. There is one
current slot per `(route, subject, provider)`, so independently eligible Bangumi and VNDB rows cannot overwrite
one another. Different record/alias bindings require explicit CAS provenance before replacing that slot.

#### Observation and repair contract for Imports

`source_statistic_observation` retains each accepted immutable payload, and `source_statistic_head` indexes one
current digest per subject/provider, including clears. Neither read hydration nor refresh scans this history.
`sourceObservation(subjectId, provider, value)` defines the content address: SHA-256 of RFC 8785 canonical JSON
`["source-statistic-observation.v1", subjectId, provider, payload]`. Payload is the exact supplied positive or
empty observation, with effective `sourceAlias` present and `expectedObservation` excluded. The date is an
observation date, not a native revision. Metadata is `{kind: "unversioned", digest: <64 lowercase hex>}` in the
optional response `observation`; licence and attribution remain caller-supplied provenance, not profile defaults.
Legacy VNDB receipts keep their existing request-digest algorithm. A legacy current row is adopted with its
original payload when first changed; migration invents neither time nor revision. Its expected digest can be
computed from its current GET row using the same helper (exclude response `source` and `observation`).

An older `asOf` conflicts (409), including against a cleared head. An equal-date identical digest is harmless.
An equal-date different observation, or a different alias/record, requires `expectedObservation` equal to the
current digest; otherwise it conflicts. A supplied expectation always compares with the head (`null` means
no head/current statistic), except an identical digest is already satisfied. A newer observation of the same
binding can omit the expectation, preserving ordinary legacy VNDB refreshes. CAS does not override date order.
A matching clear obeys the same date/CAS rules; a delayed empty refresh cannot remove a newer positive row.
After a clear, the importer knows the new head digest from the exact clear payload even though HTTP returns 204.
Corrections with no provider revision use CAS plus content digest; they must not invent a revision or average
conflicting records. A receipt replay returns its original effect and must still pass current disclosure.

#### Current disclosure and actual consumers

The producer and mounted binding remain [source-statistics.ts](source-statistics.ts) and
[http/kernel.ts](../http/kernel.ts). Both commands use the actual shared Global writer helper. Mounted publication
and read resolve the current Subject before/final disclosure; original redirected records are never copied or
combined into a terminal statistic. Pending identity mappings are unavailable. Existing
[merge-job.ts](merge-job.ts) and [identity-repair.ts](identity-repair.ts) reconcile votes, not statistics; this
slice installs no statistics merge adapter. Their source files require no change. Original observation records
stay on their original subject; only independently published terminal records can be read at a terminal identity.

Every positive publication and list read checks the exact `(effective alias, sourceRecordId, facts)` fence in
released anchored before/final observations. A VNDB facts takedown hides only its row; a Bangumi alias cannot
bypass that provider's ID/scale rules. Summary and cover fences are independent. Local current binding is reread
before serializing. Unavailable tuple homes fail closed, without a stale-fact fallback or cross-partition join.
Clear checks tuple-home availability before/final publication but remains permitted behind a facts takedown.
Committed responses concealed later retain `effect_status: not_applicable`, including receipt replay.

The existing VNDB callers are `services/importer/src/import-client.ts` (`writeSourceStatistic`,
`clearSourceStatistic`), bound by `services/importer/src/importer.ts` and `cli.ts`. Their ordinary newer same-record
writes retain wire compatibility; equal-date corrections and record rebinding now require the additive expectation.
Imports owns that follow-on adapter/refresh integration, credential scope admission and licence decisions. No
successful Bangumi import is inferred. The real typed client is regenerated through the Kernel compiler database.
Web's `apps/web/src/features/pages/subject-ratings.ts` and `subject-ratings-view.tsx` already load/render the array
separately from native figures. Their optional provenance fields remain source-compatible. Web owns the named
**Bangumi source-figure reader** follow-on: provider label, exact alias/record provenance, scale/asOf and UI tests.
Imports owns **Source observation CAS refresh** using this exact positive/clear digest contract.

#### Operation Cost: source-statistic list

- Touches: at most two current statistic rows, each provider's two anchored tuple-fact snapshots, a second local
  binding read and before/final Subject identity/availability checks.
- Bound: finite admitted-provider count (two); no totals, history scan, source fetch or cross-partition join.
- Growth check: existing lifecycle/isolation growth suites retain their indexed current-row/fence scope; the
  connected provider tests cover independent hydration and concealment. Broad growth measurement is deferred.

#### Operation Cost: source-statistic publish

- Touches: one locked subject, one provider head/observation, optional legacy current row adoption, one immutable
  observation insert, one current upsert, one event/receipt and anchored tuple/Subject observations.
- Bound: constant rows/statements per command, one current head lookup by primary key, logarithmic index work
  as retained observations grow. Two providers share no head or statistic slot. Identical digests have no new effect.
- Growth check: existing source-statistic growth suites plus connected provider ordering cases; full measurement
  belongs to integration verification, not an imported-record history walk.

#### Operation Cost: source-statistic clear

- Touches: one locked subject, one provider head/observation, exact tuple comparison, optional legacy adoption,
  one immutable empty observation/head update, at most one current deletion and one event/receipt.
- Bound: constant indexed work, including empty heads and stale tuple no-ops; no search for another binding.
- Growth check: lifecycle growth suite covers exact clear; connected provider tests cover tombstones, older
  refreshes and independent provider preservation. Broader acceptance remains deferred.

Vote request bodies reject unknown fields and non-integer values. The question scale carries the units used by vote
requests, so vote routes do not accept or return floating-point vote values. Errors use RFC 9457 problem responses.

Aggregate and population reads are public under the same `subject:read` rules as other subject reads. A Realm figure is
returned only when the reader can read that Realm; otherwise the aggregate read returns zero without score or update
state and the population page omits that Realm.

- `GET /v1/subjects/{id}/ratings?question={id}&population={id}` accepts 1–20 `population` values; repeated
  query parameters request multiple populations, and Global uses the Global Context id. It returns one independent
  figure per requested population. Each figure has `population`, `count` and `freshness` (`asOf` is the latest applied
  shard time, or `null` when no shard has been applied; `updating` reports active Realm membership jobs). A work or
  release score appears from 5 votes; an episode or character score appears from 10. At the threshold the figure
  includes the mean in stored units, rounded to two decimals, and the histogram over the question's units. Below the
  threshold a positive count includes `remaining`, and no mean or histogram. A zero count has no `remaining`. A
  protected Realm the reader cannot read is returned as zero with no score or update state disclosed.
- `GET /v1/subjects/{id}/ratings/populations?question={id}&cursor=` pages every population with a positive
  count, in population-id order, 20 per page. The signed cursor is bound to the subject and question. Global is
  included when it has votes; Realms the reader cannot read are omitted.

Unknown or unreadable subjects and unknown questions return `404`. A population figure is never combined with another
population's votes.

### Internal own-vote batch

`readOwnVotes(client, actor, questionId, targetIds)` enriches shelves using the caller's repeatable-read client and
snapshot. It requires the same current native account, authentication epoch and `rating:vote` scope as the own-vote
GET. It rejects more than 100 raw targets before deduplication and rejects unroutable question or target IDs. Empty
input still admits the caller. The Map uses exact requested target keys and GET values `{ units, revision, at }`;
clears and missing votes are absent, while zero remains a vote. It does not resolve redirects or select a controller,
population or shelf membership. This internal helper adds no HTTP endpoint or scope.

### Subject redirect resolution

The existing adding segment resolver performs one indexed redirect lookup and reads source and terminal
home epoch states in the voter command. These home states describe availability; they do not prove an exact
original-to-terminal mapping or authorize identity repair. Released `readMapping/readMappings(Pool)` observations
also provide no authority for vote effects.

### Identity repair

`createRatingIdentityRepairCommands` exposes explicit admission, selection, commit and cancellation steps to the
controller. The controller owns process reconciliation and replacement. Rating retains one active work frame per
voter with a monotonically increasing generation; replacement must match that generation and cannot replace active
work. Each selected page is durable and immutable, binds its original vote revisions, counted identities and cursor
in a digest, and visits at most 64 votes through the admission's finite upper key. A separate empty terminal page
proves completion. The same native voter transaction writes counted vote changes, outbox events, a page receipt and
the checkpoint. Receipt replay recovers a lost response without repeating effects. Changed selected votes invalidate
that selection without advancing its checkpoint. Existing account, authentication-epoch and `rating:vote` scope
checks apply before all work and receipt replay. Original vote keys, units (including explicit clears), timestamps
and revisions are retained; only counted identities and their ordered effect revisions change. A terminal's own
vote, including a clear, takes precedence over redirected originals; otherwise the latest original wins, with the
existing original-ID tie break.

Decision: cancellation stops eligible repair without changing votes; ineligible cancellation starts bounded local
withdrawal pages, and repeated cancellation preserves the withdrawal checkpoint.

The missing Semantic producer contract is `RatingIdentityProducer.hold/complete`: in the actual authorized voter
`CommandTransaction`, hold exact original-to-visible-terminal mappings and their epochs against concurrent changes,
including rollback and repoint and at most 64 competing originals, then atomically hand a retained Rating repair obligation to the native page receipt.
The receipt retains the obligation ID and exact mapping digest. That obligation must cover later identity changes and concurrent vote creation beyond the captured upper key; it
must remain held until Rating's effects and checkpoint commit, including the empty terminal page. Home state reads
and released observations cannot implement this contract. Production composition therefore returns pending with
`semantic-exact-currentness-and-held-repair-obligation-unavailable`; pending or unavailable producer observations
never advance work. The port is service configuration, not caller input, and supplies no authorization. A failed
obligation handoff rolls back the entire page. Withdrawal uses local counted identities and requires no mapping
observation. Repair has finite page, selection-byte, membership and event bounds, with no runtime funding, prepaid
quotes, no-refill rule or foreign-price availability gate.

## Voter Realm membership

`rating.voter_realm` belongs to the voter's route. Membership events update it in one command in the voter's
partition. The first 100 joined Realms occupy the capped set, including rows still `adding` or `removing`.
Later joins are `uncounted`. Deleting a capped row promotes the earliest-joined uncounted Realm to `adding`;
equal join timestamps are ordered by Realm id. A pending removal continues to occupy its slot. Duplicate joins
preserve the original join time, and a rejoin during removal retains its slot and join time.

A new capped membership starts `adding` with a NULL cursor. Leaving a `counted` Realm starts `removing` with
NULL cursor and limit. Leaving an `adding` Realm with no cursor deletes it immediately; otherwise removal
starts with a NULL cursor and its former add cursor as the limit. Leaving an uncounted Realm deletes it.
Joining during removal sets `rejoin`; leaving during removal clears it. On completion, removal deletes the row
and promotes one waiting Realm, or, when `rejoin` is set, restarts it as `adding` with no cursor or limit.
`finishVoterRealmRemoval` is called by the pager in its final page command.

Vote writes read at most 100 non-uncounted membership rows in their own transaction. Their events list Global,
every `counted` Realm, `adding` Realms only for keys at or before their cursor, and `removing` Realms only for
keys in `(cursor, limit]`. Keys are ordered by `(question_id, target_id)`. A NULL add cursor means no keys have
been applied; a NULL removal cursor or limit means no lower or upper bound respectively. These bounds preserve
exactly the applied prefix when a member leaves during adding. The pager reads at most 100 current votes by
`(question_id, target_id)` keyset in the voter's partition. Each active transition has a stable transition id used
as its DBOS workflow id; the voter Realm cursor is the page checkpoint. Adding advances from its applied prefix,
while removing reads only its remaining range through the saved limit. Finished removals either restart as adding
with a fresh transition id or delete the row and promote the earliest waiting Realm. `rating.population_pending` on
the Realm's route counts active jobs, and aggregate reads report `updating` while that count is positive.

All membership decisions, paging and vote changes must serialize in the voter's partition. The voter's events
reach the aggregate effect in partition order; paging must apply its pages in that same stream so each vote
counts exactly once per population. Membership effects use source-event receipts so a retry after a later leave
cannot resurrect a membership. Their command emits `com.rezics.rating.voter-realm.changed.v1` in that partition.

Membership changes write at most two membership rows: the affected Realm and one promotion. Capped and waiting
partial indexes bound the membership read and promotion independently of other voters and the waiting set's
size. Vote writes add at most 100 membership rows to their existing bounded reads.

## Voter eligibility

`rating.voter_state` keeps one row per voter with `eligible`, `leaving`, `ineligible` or `returning`, a transition id,
and the last applied `(question_id, target_id)` cursor. Existing voters are backfilled as eligible. Vote commands
ensure the row exists and emit no populations while the voter is leaving or ineligible; a returning voter counts
again while its pages run so newer vote revisions can be applied idempotently alongside the page events.

Suspension starts a `leaving` transition and reinstatement starts a `returning` transition. They use the same durable
segment workflow, page step and `com.rezics.rating.segment.page.v1` event as Realm membership jobs. Each page reads
at most 100 votes by keyset from the voter partition. Each vote carries the populations where that key currently
counts: Global and the Realm populations admitted by their `counted`, `adding` or `removing` cursor. Removal
subtracts those populations; return adds them. The page checkpoint commits with the event, so replay resumes from
the stored cursor without applying a page twice.

An account tombstone uses the removal transition with source deletion enabled. Each page records the vote and its
populations in the removal event before deleting those vote rows in the same voter-partition command. Once the final
page is empty, the remaining `voter_realm` rows are deleted and the voter remains `ineligible`. A suspension retains
both votes and Realm memberships for reinstatement.

The rating tombstone purge is participant `community`'s rating part; `readRatingErasureDone` reports its completion.

## Cost

| Operation                           | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Growth check                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Put vote                            | Reads the voter's account, capped Realm memberships, existing vote by `(route, voter_id, question_id, target_id)`, and any counted-target match by its unique index; writes the vote and command/event records. Membership input is capped at 100.                                                                                                                                                                                                                                   | Rows and statements are constant for one vote; index blocks grow logarithmically with same-partition vote history. Membership work is capped at 100 rows independently of other voters and waiting Realms.                                                                                                                                                                                                                                            | `test/rating/growth-votes.test.ts`: `putting a vote has constant rows and statements as same-partition votes grow`; `putting a vote reads only the capped memberships as other voters and waiting Realms grow`                                                                                   |
| Own-vote batch                      | Reads the account by primary key and seeks a vote for each distinct requested target by `(route, voter_id, question_id, target_id)`; input has at most 100 target IDs.                                                                                                                                                                                                                                                                                                               | Rows grow linearly with distinct targets `k` (at most `k` vote rows plus one account); statements are constant (two when nonempty, one when empty); index blocks grow logarithmically with vote history.                                                                                                                                                                                                                                              | `test/rating/growth-own-votes.test.ts`: `own vote batch has input-bounded rows and constant statements as votes grow`                                                                                                                                                                            |
| Aggregate apply                     | Released distinct-question preparation, local counted-vote winner probes and aggregate shards, then atomic exact delivery capture.                                                                                                                                                                                                                                                                                                                                                   | At most 100 changes per command, 100 destinations, 200 question/shard deltas per delivery and 101 command events. Work is O(changes); indexed winner probes touch one counted entry.                                                                                                                                                                                                                                                                  | `test/rating/growth-aggregate.test.ts`: `aggregate updates keep bounded rows and statements as votes, targets, accounts and source partitions grow`                                                                                                                                              |
| Population-total delivery           | Exact inbox admission, contiguous receipt and additive total updates at the population home, then exact source acknowledgment.                                                                                                                                                                                                                                                                                                                                                       | Fixed keyed work per receipt/replay, at most two statements per affected shard plus fixed receipt/clock work; source backlog pages at most 100. Unrelated history requires no scan; blocks grow logarithmically.                                                                                                                                                                                                                                      | `test/rating/population-total-home.test.ts`: `source pages, destination statements and exact replay stay bounded as unrelated receipt history grows`                                                                                                                                             |
| Aggregate read                      | One question-scale point read at the question home, one population-pending point read at the population home, and at most 16 component shards by the full target-local key prefix. Each statement has its own logical partition binding. A request can include at most 20 populations.                                                                                                                                                                                               | Six application statements per known-question aggregate (three partition probes and three data statements), reading at most 21 rows including partition metadata. Pool calls use three sequential snapshots/checkouts, never one checkout per shard; caller-owned snapshots add no checkout or transaction control. Work is independent of unrelated population/target rows, with logarithmic index blocks; no vote, subject, member or history scan. | `test/rating/aggregate-anchored-read.test.ts`: separate-home outcome, max-one pool, exact native components and unrelated population/target growth; retained `test/rating/growth-aggregate-read.test.ts`: `one population aggregate read has constant rows and statements as target voters grow` |
| Population page                     | Seeks the target-first population index for at most 20 positive populations and one continuation probe, then reads up to 16 component shards per returned population.                                                                                                                                                                                                                                                                                                                | Rows are constant (at most 20 × 16 shard rows plus the continuation seek); statements are constant; index blocks grow logarithmically with rated-population history.                                                                                                                                                                                                                                                                                  | `test/rating/growth-aggregate-read.test.ts`: `a target population page has constant rows and statements as rated populations grow`                                                                                                                                                               |
| Segment and re-key page             | Reads at most 100 vote rows by `(question_id, target_id)` keyset in the voter partition, the active Realm/job checkpoint and, for re-key, capped population memberships. Applies page changes through the aggregate effect, grouping commands by target partition.                                                                                                                                                                                                                   | The page input `k` is at most 100 votes. Rows and statements are linear in `k` and affected target partitions, with at most 101 populations per re-keyed vote; index blocks grow logarithmically with voter vote history. Total workflow work is linear in pages.                                                                                                                                                                                     | `test/rating/growth-segment-job.test.ts`: `segment page has constant rows and statements as voter votes grow`; `re-key page has constant rows and statements as voter votes grow`                                                                                                                |
| Eligibility page                    | Reads at most 100 vote rows by keyset and at most 100 capped voter-Realm rows, then applies each vote to Global and up to 100 Realm populations through the aggregate effect.                                                                                                                                                                                                                                                                                                        | Page rows and statements are linear in `k × p`, where `k` is at most 100 votes and `p` is at most 101 populations per vote; index blocks grow logarithmically with voter vote history. Total work is linear in page count.                                                                                                                                                                                                                            | `test/rating/growth-segment-job.test.ts`: `eligibility page has constant rows and statements as voter votes grow`                                                                                                                                                                                |
| Merge page                          | Reads up to 100 Global population voters by keyset, their questions for the merged target, vote rows by counted-target and vote primary-key indexes, and applicable capped Realm populations; groups commands by voter partition.                                                                                                                                                                                                                                                    | Rows and statements are linear in page voters `k` (at most 100) and affected questions; index blocks grow logarithmically with merged-target voter history. Each page is bounded separately; total work is linear in page count.                                                                                                                                                                                                                      | `test/rating/subject-merge.test.ts`: `merge page has constant rows and statements as merged target voters grow`                                                                                                                                                                                  |
| Voter-Realm membership change       | Reads and writes the affected membership and, on removal, the earliest waiting membership through capped/waiting partial indexes; vote population selection reads at most 100 non-uncounted memberships.                                                                                                                                                                                                                                                                             | Membership-change rows and statements are constant (at most two membership rows); index blocks grow logarithmically with membership history. Vote membership selection is linear in the fixed cap of 100, independent of other voters and waiting-set size.                                                                                                                                                                                           | `test/rating/voter-realms.test.ts`: `membership join and promotion cost constant rows and statements as other voters grow`                                                                                                                                                                       |
| Public figure drain                 | Completes source delivery pages, then selects at most 500 pending figure keys, captures distinct exact priors in independently anchored population-home reads, then materializes local prior inputs and publishes in the existing subject command. Each figure reads up to 16 local aggregate shards, updates one figure and emits one changed-figure event. Republish marking uses the same source capture and local input guard.                                                   | At most 500 candidates and 500 distinct prior inputs; source snapshots release before target checkout, with one local command per affected subject partition per page. Indexed work O(page × distinct prior keys × log R), retaining at most 16 components per figure and the existing republish page/cursor bounds. No partition/history survey or retry/refill is added.                                                                            | `test/rating/growth-public-figure.test.ts`: `figure drain has constant rows and statements as votes on one subject grow`                                                                                                                                                                         |
| Subject public figure HTTP read     | One subject read under existing read rules, the standard question scale, one `readPublicFigures` statement for one anchored subject, and one point read of that figure's pending mark in the same snapshot.                                                                                                                                                                                                                                                                          | O(1) statements and rows, independent of votes, populations and subjects; figure index blocks grow logarithmically with the relation.                                                                                                                                                                                                                                                                                                                 | `test/rating/public-figure-http.test.ts`: the ready-figure acceptance measures the same statement count at 1, 64 and 512 voters.                                                                                                                                                                 |
| Public figure batch and page reads  | The batch seeks up to 256 requested IDs by `(route, question, population, subject)`; the page seeks the exact partition/question/population prefix and strict subject cursor in the existing published-figure partial index, then reads at most the requested ordered window and its figure rows.                                                                                                                                                                                    | Intended bound: one statement per call; at most 256 exact batch rows or 500 visited/returned matching page rows plus logarithmic index seeks, independent of unrelated figure/voter history. Measured growth acceptance UNRUN under minimal verification.                                                                                                                                                                                             | `test/rating/growth-figures-statistics.test.ts`: `Public figure batches and pages stay within their bound as figure and voter history grows`                                                                                                                                                     |
| Public figure views                 | One question read by key and one statement seeking each requested subject's figure by primary key in its anchor partition, for the standard question and Global population.                                                                                                                                                                                                                                                                                                          | Two statements per non-empty call; at most the requested 256 figure rows; blocks O(N log F), linear in N subjects and logarithmic in F figure rows, independent of votes, populations and Realms. Empty calls issue no statements.                                                                                                                                                                                                                    | `test/rating/public-figure-views.test.ts`: `batched figure views use two statements for 1, 64 and 256 subjects across partitions`                                                                                                                                                                |
| Source-statistic GET, PUT and clear | GET returns at most two rows for the admitted `vndb` and `bangumi` sources, checks its exact facts tuple in two independently anchored tuple-home snapshots, rereads the local binding, and rechecks the current subject before serialization. PUT checks that tuple before its subject-partition upsert and at final disclosure. Clear deletes only one row matching `(route, subject_id, source, source_alias, source_record_id)` and emits the existing change event only when that row changes. | Rows, statements and effect events are constant: at most one source-statistic row per subject/source, one changed row/event per command, and one facts-fence row per tuple snapshot. Index blocks grow logarithmically with source-statistic, receipt and tuple-fence histories. Every nested query and physical occurrence is included in the lifecycle growth capture.                                                                              | `test/rating/growth-source-statistic-lifecycle.test.ts`: `source statistic GET, PUT and authoritative zero clear stay bounded as row and tuple histories grow`; `test/rating/growth-figures-statistics.test.ts`: `Source statistic writes and reads stay within their bound as statistics grow`  |
| Own-vote and question GET reads     | Each command and mounted GET reads the account by primary key, then seeks one vote by `(route, voter_id, question_id, target_id)` or one question by primary key.                                                                                                                                                                                                                                                                                                                    | Rows and statements are constant per read (two point reads); index blocks grow logarithmically with vote history.                                                                                                                                                                                                                                                                                                                                     | `test/rating/growth-figures-statistics.test.ts`: `Own vote and question reads stay within their bound as votes grow`                                                                                                                                                                             |
| Protected Realm rank page           | Two native Realm authorizations, four partition observations, two prior and generation points, one equality-prefixed `realm_rank_score_idx` seek, and native subject Access/current identity for every consumed row.                                                                                                                                                                                                                                                                 | [Derived bound](cost-realm-order.md): rows <= `8+C+2R_R+C R_S`, data/control statements <= `37+9C` for the fixed native authority; `C<=limit<=100`, returned `V<=C`; shared index blocks logarithmic.                                                                                                                                                                                                                                                 | `test/rating/growth-realm-rank-source.test.ts`: 256/1024/4096, first/deep/withheld/empty/terminal; physical acceptance deferred to integration.                                                                                                                                                  |

Page sizes bound each workflow step independently: segment and eligibility pages process at most 100 votes, merge pages at most 100 voters, and figure drain/republish work is admitted in pages of at most 500 figures. Total affected work grows with page count and affected keys; a page bound does not bound the complete workflow.
