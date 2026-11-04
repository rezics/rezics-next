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

### Bounded scale delivery

Decision: native delivery accepts integer units from 0 through 4096, at most 4097 histogram bins, and exact
signed-BIGINT component arithmetic; Realm authoring and custom ranking remain on their current 0–20 contracts.

The durable vote event keeps its existing type, fields, source position and receipt identity; units remain an integer
or null, now bounded to 0..4096. Existing 0..20 event envelopes remain valid. Before target work, the worker reads the
exact question scale at its encoded home and checks every incoming unit against that question's minimum, maximum and
step. Supported scales have integer bounds with 0 <= minimum <= maximum <= 4096, a positive integer step that divides
the range, and no more than 4097 bins. Stored units and aggregate means remain in the question's original units.
Different questions keep separate revisions, scales, grains and populations; no scale conversion, mixed histogram,
shared prior or public custom-question figure is produced. Review citations preserve the original question, vote
revision and units, and accept only the author's current vote when its units match that question's exact scale.

A target command page contains at most 100 changes. Each change updates one aggregate-component histogram, or two
when a controller re-key moves winners. With at most 4097 bins, that bounds a page at 200 component-histogram
updates, and at most two histogram working arrays are live for one re-key. Aggregate reads sum at most 16 components,
costing at most 16 times the question's bin count. Signed population-total pages keep the existing limit of 200
question/shard deltas; each count delta is bounded by 200 and each stored-unit sum delta by 819,200. Component totals
are checked against PostgreSQL bigint limits before update. An invalid retained scale or off-step retained unit fails
delivery and keeps its durable obligation; it is never skipped or partially applied. The population-total receipt and
source identities and delivery order are unchanged.

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
Creation wording stays immutable; the separate caption command below corrects presentation. Creation exposes
no retirement or Global authoring command. Native Realm grants keep their existing owner.

The creator must be a current authenticated account with ordinary native `realm:manage` authority on that
selected active Realm. Membership and role names are not substitute authorizations. `resourceAuthorization`
prepares and verifies current Access for each command attempt before receipt lookup; revoking manage denies
an exact replay before it discloses the earlier result. The command writes one question, receipt and registered
`com.rezics.rating.question.created.v1` event in the Realm's single native partition. Its generated ID encodes
that Realm's route. `owner_id` records the creator, rather than a Realm ID or permission shortcut. The receipt
digest binds principal, operation and the complete definition; changed inputs with the same key conflict.

Success, including an authorized exact replay, returns HTTP `201` with
`{ id, realmId, meaning, revision: 1, lifecycle: { state: "active", revision: 1 }, label, canonicalLabel: label, labelRevision: 1, grain, scale }` and ordinary session progress. Meaning, provenance,
revision and scale persist together. A database trigger rejects changes to authored definitions. Existing
legacy definitions retain their previous representation and the seeded standard question remains unchanged.

Supported authoring scales remain integer stored units with `0 <= min < max <= 20`, positive integer `displayStep`,
and `(max-min) % displayStep === 0`. Binary `0..1` and integer `0..10` questions are supported by the installed
vote path. Votes must lie on the exact selected scale. Display mapping is consumer-owned: custom `0..10` does not
inherit the standard question's half-point display mapping. Native storage and event delivery now support the bounded
0..4096 contract above, but this authoring command keeps its current 0..20 limit. A definition is never proof of
ranked population readiness; custom-question ranking continues to admit only the released 0..20 integer range until
its owner adopts a compatible publication contract.

`GET /v1/rating-questions/{id}` refreshes the exact selected definition. Legacy definitions keep their exact wire
shape; Realm definitions add `realmId`, `meaning`, `canonicalLabel`, `labelRevision` and lifecycle state; `label` is the current caption. `GET /v1/rating-questions?realm={realmId}&limit=1..20`
uses the existing `{ ratingQuestions, next }` capability with explicit native Realm selection. It does not merge
or infer Realm choices from Global pages. Its opaque continuation binds the exact selection, limit and every
verified viewer/credential authority field, with sorted distinct scopes, the Realm lifecycle generation, the
existing 15-minute expiry and 4,096-character cap. Default Global tokens retain their previous selection and
viewer binding. Tokens cannot cross viewers or
selections. Unknown, duplicate or invalid query parameters fail rather than changing the selection.

Each selected Realm page checks current native readability, reads its lifecycle generation and bounded question
snapshot, checks caller readability again with no question-home checkout held, and then rereads the native
generation before release. Only matching source observations qualify the page. Global pages also recheck caller
readability after their question snapshot. All rows share the explicitly selected Realm; no ownership or membership
join replaces Access. One indexed seek consumes at most 20 raw rows plus one unconsumed lookahead and hydrates at
most 20 definitions. Progress uses the last raw key, and no total or completeness claim accompanies an empty page.
Each page is a fresh observation, not a snapshot of the catalogue across requests. The cursor resumes after the
consumed raw key even if earlier rows are no longer present. Point reads perform one exact question-home metadata
seek, one native home binding and one current authority observation after releasing the metadata snapshot. Page
reads bind the selected Realm home. No operation holds a metadata checkout while preparing another native
authority observation.

Unknown or unreadable questions/Realm selections return `404`; missing manage returns `403`. Invalid definitions
return `400`; changed idempotent inputs return `422`. Native authority, moved-home, admission or database failure
retains ordinary `503` unavailable states, never empty metadata or allowed admission. Protected labels cannot
enter the default Global directory. Vote writes recheck question readability during every native command
preparation before receipt disclosure; private own-vote reads also recheck it. Standard vote admission retains
its existing scope contract. Aggregate and population HTTP handlers select current readable metadata before
reading numeric results. Low-level aggregate functions remain trusted computation ports, not disclosure ports.

`readVisibleRatingQuestion` and `ratingQuestionView` in `question-directory.ts` provide exact current provenance,
meaning, revision, grain, scale and Realm lifecycle observation for native consumers, including the rank owner. Review-context selections use
that authority boundary on initial and continuation observations. Content point and board-page disclosure hides
an unreadable custom question's citation while retaining the ordinarily readable post; unavailable authority
propagates. Standard citations retain their existing behavior. Content's `reads.ts` and
`review-context-eligibility.ts`, plus Rating's internal aggregate metadata export, change outside the declared
paths solely to close those provenance boundaries. Search owns question selection, rating-sort controls,
query/partition coordination and Web interfaces. Content keeps the partition-local native producer contract;
membership repair has its separate owner, and custom rank publication remains separately owned as described below.

`test/kernel.test.ts` adds the new command to the exhaustive typed route contract while retaining every existing
route assertion. This is outside the declared paths because the kernel contract must include every mounted route.

The installed client uses `createKernelClient(origin, options?)`, then
`client['rating-questions'].get({ query: { realm?, limit?, cursor? } })` or
`client['rating-questions']({ questionId }).get()`. Public `RatingQuestionDirectoryQuery`,
`RatingQuestionDirectory` and `RatingQuestion` types derive from the complete mounted route declarations.
Populated and empty successes share `{ ratingQuestions, next }`; an empty page with `next` still requires explicit
continuation. Concealed selections return the ordinary `not_found` problem. Dependency failures return their
ordinary retryable problem and no page; retry the identical query. A lifecycle-invalid cursor requires an explicit
first-page restart. These observations never authorize a vote; vote admission retains its conditional guard.

Focused outcomes live in `test/rating/realm-question-authoring.test.ts`: native manage grants, creation and exact
replay, changed-input conflict, persisted author/provenance, point/selection refresh, binary and `0..10` scales,
protected/ban denial, current vote admission and manage loss before replay. Physical growth is unmeasured;
the dev verifier owns clause measurements and broader acceptance after integration.

### Realm question management page source

`GET /v1/realms/{realmId}/rating-questions/management` composes the existing Realm directory and optional
`selectedQuestionId` for an authenticated current reader. It returns closed `viewer`, `realmId`, `directory`,
`actions` and `selected` fields, with `Cache-Control: private, no-store`. Unknown and concealed Realms or exact
selections share `404`. It does not initialize a question or change any existing writer. The mounted schema is
the complete-input publisher's source; the new method has no claimed installed public Client declaration yet.

Decision: management reuses the native active-question directory; a retired definition remains inspectable by
exact selection, with Restore advice only when current native `realm:manage` permits it.

The directory consumes 20 raw keys plus one unconsumed lookahead. Empty sparse pages preserve continuation;
there are no totals or automatic refills. Its distinct cursor binds Realm, selected id, sorted credential authority,
page size and the existing lifecycle generation/epoch-2 frontier. Invalidated lifecycle continuation requires an
explicit restart. Captions do not invalidate that generation. The ordinary selector's cursor and behavior remain
unchanged. Global questions and questions belonging to another Realm return `404` on exact management selection.

Selected `question` keeps definition `revision`, `labelRevision` and `lifecycle.revision` distinct. `readback` and
`history` point to the existing exact question and caption methods; history is never a substitute definition.
`actions.create` is either the existing POST method/href or null. Selected `actions.caption` carries only the
existing PUT href and `expectedLabelRevision`; `actions.lifecycle` carries the existing retire/restore POST href
and `expectedLifecycleRevision`. Exhausted revision heads offer no corresponding action. Advice comes from
current native Access for `realm:manage`; ordinary membership, readability and creator identity grant none of
these commands. Unavailable advice fails the entire page rather than looking like denial or an empty directory.

After advice preparation the source requalifies Realm disclosure and checks the generation and exact selected
metadata again. Changed selected metadata requires fresh inspection (`409`); lifecycle generation changes use
the native invalid-cursor response. Commands retain authorize-before-receipt and original same-key replay rules.
Readback is a separate current observation and cannot acknowledge an uncertain command. A future browser consumer
must retire forms and original intents on private-visit replacement, and retain the original cursor on failed
continuation. This source alone does not establish that browser behavior or recorded presentation.

The exhaustive mounted-route assertion in `test/kernel.test.ts` must include this additive GET; updating that
entry changes no shared writer or authorization contract.

#### Management page Cost

- **Touches:** the paired directory observations and bounded Realm-home snapshot; optionally one exact selected question
  observation and its Realm disclosure; native Access preparation/evaluation for current `realm:manage`; a final
  Realm observation and Realm-home snapshot that recheck lifecycle generation plus exact selected metadata and heads.
  Authentication, Accounts, grants/roles, host and Realm eligibility inside these calls remain chargeable, and no
  connection stays open during foreign authority preparation. Caption history is a separate native operation.
- **Bound:** fixed 20 consumed directory keys plus one unconsumed lookahead and at most one independently selected
  question, read again by key after advice. Joins seek only those keys' caption/lifecycle heads. Meaning stays at most
  2,000 code points, each caption 200, native scale integer 0..20, cursor 4,096 characters and response 1 MiB.
  The 21st directory key is a native unconsumed lookahead. Byte validation limits retained bodies and serialization;
  it does not establish physical index or nested Access bounds, so nested authorities and examined prefixes remain
  chargeable growth inputs.
- **Growth check:** `test/rating/question-management-journey.test.ts` pins empty and 20-row continuation, the exact
  retired selection, independent caption/lifecycle heads, and loss of current authority. Independent unrelated
  questions, revisions, votes and authority at 256/1024/4096 with full nested physical accounting remain outstanding;
  Global directory measurements do not establish this composition's native growth result.

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
native home partition and epoch, limit and ceiling through the existing 15-minute seal; another viewer, question,
limit or home cannot reuse them. A home epoch change retires a continuation as `stale_cursor`; same-epoch caption
appends stay outside its signed ceiling. Every request checks current question/Realm disclosure before source reads,
retains the native question and raw page observations while current author identities hydrate, then rechecks both
before output. Each author uses Access's public identity allowlist twice, so a name change is reflected after later
identities hydrate, erased accounts retain only the allowed tombstone, and absent/pending identities stay omitted.
Every anchored observation releases before another home is checked out. Ban, concealment, question loss and
account/session fences remain current native decisions; old tokens and exact references grant no disclosure
authority. Failures propagate as unavailable, never as empty history. Retention follows the native question:
revisions persist independently of author profile lifecycle, remain concealed with that question/Realm, and cascade
only if the native question is physically removed. This command introduces no deletion, retirement, author-history
restoration or lifecycle jobs.

Exact caption reads retain their original question, revision rows and author observations through the same
released hydration and final source checks. If their home epoch changes, they return unavailable; history
returns `stale_cursor` so its caller can explicitly restart. Neither path falls back to an older caption.

The mounted consumer uses `createKernelClient(origin, options).ratingQuestions({ questionId })`: `label.put`
takes `{ expectedLabelRevision, label }` and `Idempotency-Key`; `labels.get({ query: { limit, cursor? } })`
returns the closed `{ labels, next }` DTO; `labels({ labelRevision }).get()` resolves an exact caption.
`@rezics/client` exports `QuestionLabelInput`, `QuestionLabelResult`, `QuestionLabel`, `QuestionLabelHistory`
and `QuestionLabelHistoryQuery` from those mounted declarations. Each label contains
`{ questionId, labelRevision, label, at, author }`; author is the active identity allowlist, a deleted tombstone
or null. A populated result may have a continuation; `{ labels: [], next: null }` is an admitted empty result,
never a concealed question (`404`) or failed dependency (`503`). Retry a failed read with the exact query;
only `409 stale_cursor` requires an explicit first-page restart. After correction, refresh current display and
history independently of measurement revision; replace retained rows and cursors when viewer authority changes.

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
  exact caption: two observations of the disjoint revision-1/retained-revision point branches; history: two question-home indexed
  `(question_id, revision)` keysets and question points, current question/Realm disclosure at both ends, and a
  final home epoch point. Exact reads also finish their question and home observations. Up to 20 author IDs each use two released account-home identity reads. The read has no
  runner phase; the existing writer retains its single registered event path.
- **Bound:** Each raw page returns at most 21 label rows and only 20 consumed authors are hydrated, twice; source
  materialization is at most 42 label rows and 40 identity results, with one partition row per anchored read.
  Each read-only home transaction uses `BEGIN`, a local statement timeout and `COMMIT`; all pools are released
  before the next home. Captions occupy at most 800 UTF-8 bytes each before JSON encoding; the response contains at
  most 20 labels and 20 current public identity DTOs. SQL pushes the correction limit before union ordering. No
  per-request census, refill, all-partition scan or invisible MVCC estimate is included. Index descent grows
  logarithmically with retained captions; full traversal grows by page count. Directory costs retain their
  existing 20-row budget with one additional local head seek per row.
- **Growth check:** `test/rating/question-label.test.ts` covers the connected native journey, exact-caption
  author privacy, current author disclosure, same-query identity/source retry and epoch retirement during final
  source disclosure. Physical native proof remains required for independent unrelated and selected
  identity/source/authority histories at 256/1024/4096 with fixed keys, homes, admitted byte caps and page limits.
  This includes actual Access preparations/evaluations, SQL and transaction controls, physical plans and rows,
  foreign pools, materialized/retained/serialized UTF-8 bytes, registered command/effect phases and cold retries;
  the local row bounds above do not establish those all-pool costs. Controller acceptance retains this original
  connected journey and its missing growth outcomes; no custom rank cost is inferred.

Decision: a native question-home epoch change returns `409 stale_cursor`, while same-epoch caption appends preserve
the captured ceiling.

`rating/events.ts` changes outside the declared paths to register the caption event; `test/kernel.test.ts`
adds the three mounted paths to the exhaustive typed native route contract. No existing behavior assertion is
removed. `library/collection-reads.ts` removes an identical duplicate import already present on the base, solely
to unblock the required workspace type-check; library behavior is unchanged. `db/rating/schema.sql` records the additive migration snapshot.

### Realm question lifecycle

Lifecycle belongs to the same authored question but has its own revision. When no lifecycle head exists, a Realm
question is active at lifecycle revision 1. Captions remain on their separate revision head; retirement and
restoration never edit the canonical creation label, measurement revision, meaning, grain, scale or caption.
Global and standard questions have no lifecycle command.

`POST /v1/rating-questions/{questionId}/$retire` and `POST /v1/rating-questions/{questionId}/$restore` accept
`{ expectedLifecycleRevision }` and `Idempotency-Key`. Both require current native `realm:manage` on the question's
actual Realm before receipt lookup on every attempt. Standard, unknown and concealed questions do not acquire a
synthetic manager. A revision or state conflict returns `409` without changing state or emitting an event. An exact
replay is admitted only while its resulting lifecycle revision remains current; a replay after a later transition
conflicts. Manage revocation denies receipt replay.

Each successful transition writes one lifecycle head, advances one per-Realm lifecycle generation and emits the
registered `com.rezics.rating.question.lifecycle-changed.v1` event containing the question, Realm, state, lifecycle
revision and generation. It does not delete votes, enumerate voters or Subjects, or advance figure generations.

An authorized `GET /v1/rating-questions/{questionId}` may return a retired Realm question with
`lifecycle: { state: "retired", revision }`; its current Realm readability check still runs, so this historical
metadata is not admission to cast, rank or select. Unknown and concealed questions remain indistinguishable.
Explicit Realm directories omit retired questions but consume their raw keys for bounded progress. Their cursors
carry the lifecycle generation and fail with `400` after any retirement or restoration in that Realm, including an
empty page. Default Global directory behavior remains unchanged.

Retirement refuses new vote casts and changes with `409`. A voter with current ordinary vote authority and current
question disclosure can still read their own stored vote and withdraw it through the existing account-owned
command; no private figures or other voters' rows are exposed. Restoration admits new commands at its new active
revision. Preserved votes retain their original question meaning and eligibility.

The native Realm rank source requires an active lifecycle observation for the selected question and rechecks its
exact lifecycle revision before returning. Its cursor is bound to that revision. A retired question produces the
typed `RealmRankQuestionUnavailableError` reason `retired`; missing or stale native prior/source observations
produce `unavailable`; when a pending source has no candidate rows, the page stays unavailable. Existing candidate
rows retain their source `updating` marker. Restoration
reuses existing figures only while the frozen measurement identity and current native prior generation remain
active; otherwise the source stays unavailable until the existing publication producer establishes current
figures. `com.rezics.rating.realm_rank.changed.v1` carries the exact lifecycle revision observed when its figure
was published. The event carries both state and revision. Search owns event handling, selection controls and user
messaging.

#### Retire Cost

- **Touches:** One question-home read, current Realm manager preparation, one command receipt, one locked question,
  one same-value question-tuple update, one lifecycle-head upsert, one Realm-generation upsert and one lifecycle event.
- **Bound:** Constant statements and rows per attempt; no vote or Subject scan. Index and receipt lookup blocks grow
  logarithmically with retained history.
- **Growth check:** `test/rating/question-lifecycle.test.ts` checks one transition and exact replay/revocation behavior;
  physical growth measurement belongs to the dev verifier.

#### Restore Cost

- **Touches:** The same bounded question, manager, receipt, lifecycle and generation rows as retirement, plus one
  registered event. No figure or voter rows are rewritten.
- **Bound:** Constant statements and rows per attempt; retained lifecycle and receipt indexes grow logarithmically.
- **Growth check:** `test/rating/question-lifecycle.test.ts` checks the active revision and preserved meaning after
  restoration; physical growth measurement belongs to the dev verifier.

#### Historical point read Cost

- **Touches:** One question primary-key seek joined to its lifecycle and caption heads, then current Realm
  readability under the existing Access path.
- **Bound:** One metadata row regardless of vote history; joined heads are unique by question.
- **Growth check:** The focused lifecycle test compares the returned retired revision with the unchanged authored
  definition; physical growth measurement belongs to the dev verifier.

#### Selectable directory Cost

- **Touches:** One `(realm_id, id)` keyset query inside one question-home read transaction, joined to at most one
  current caption head and one lifecycle head per raw question. A Realm selection reads its generation in that same
  transaction and again after the final native Access check. Every selection performs current caller qualification
  before and after the bounded question snapshot; Access preparation/evaluation and its foreign pools stay outside
  the question-home transaction. The Realm path owns two `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`,
  `SET LOCAL statement_timeout`, `COMMIT` sequences and two partition bindings; Global owns one sequence and binding.
  Native authority SQL, deadline controls and unsuccessful attempts also count toward the complete request cost.
- **Bound:** At most 21 materialized raw question rows and 21 current caption/lifecycle head joins, 20 returned active definitions,
  two Realm generation point reads and two caller qualifications. Retired rows consume raw-key progress but never
  fill a page; empty pages still receive both caller qualifications. Global selection uses generation `0` and the
  same two caller qualifications. Admitted definitions retain the schema's 2,000-code-point meaning and 200-code-point
  current/canonical caption limits; UTF-8 retention and JSON escaping must be charged separately. Physical rows
  visited by native plans and all foreign work still require observation. Caption history, vote history and catalogue
  counts are not read. This bound makes no claim about invisible MVCC work.
- **Growth check:** `test/rating/growth-question-directory.test.ts` measures the Global keyset path at its recorded
  256/1024/4096 scales while independently growing unrelated question rows, measurement identities and closed
  Global authority history. It holds selected keys and page depth fixed and checks physical access paths, row and
  block bounds, one-pool observations, database request/response bytes, serialized response bytes and read-only SQL.
  `test/rating/question-directory-currentness.test.ts` exercises current Access revocation, retirement during final
  preparation, mounted client creation/caption commands, sparse empty continuations, explicit restart, same-input
  operational retry and empty-page Global denial.

#### Own vote read and withdrawal Cost

- **Touches:** Existing current-question disclosure, current original/terminal Subject identity and native Access,
  plus one account and one vote point read; withdrawal uses the existing account command, one vote row and its
  existing bounded event fanout. Point readback now withholds a concealed Subject just as the inventory does.
- **Bound:** Account/vote primary-key probes and one lifecycle head, plus the single-source identity mapping's
  double collection and original/terminal reference snapshots and Access preparation. Retained vote history is
  never enumerated; nested identity/Access cost remains part of the operation.
- **Growth check:** `test/rating/growth-own-votes.test.ts` owns own-vote read growth; the lifecycle test checks retained
  private read and withdrawal while retired.

#### Protected Realm rank read Cost

- **Touches:** Existing Realm and subject observations, prior/generation points and one ordered rank seek; the exact
  lifecycle revision is included in the question read and checked again before serialization.
- **Bound:** Existing `realm_rank_score_idx` limit still bounds candidates; lifecycle state adds no scan, index or
  figure-generation work.
- **Growth check:** `test/rating/growth-realm-rank-source.test.ts` owns rank growth; the lifecycle test checks the
  retired reason even with no current prior rows.

## Protected Realm rank source

The adopted second scope includes Realm rating order. Private Realm numbers stay outside the common Search
index. The scored-only compatibility factory `createRealmRankSource` and `RealmRankSource` in
[realm-rank.ts](realm-rank.ts) use the production `{ pool, access, tokens }` dependencies and expose
`page(actor, { realmId, questionId, partition, sort: 'score_desc', limit, cursor? }, { deadline })`.
The actor comes from native credential verification. The factory performs current Realm authorization itself,
then checks every consumed candidate through native subject Access and current identity before release; an
unreadable or redirected subject contributes no returned figure. Missing or denied Realm returns `not_found`.
Unavailable authority, data or moved homes fail closed. Search owns selection controls, predicate integration and
cross-partition composition; Web owns the remaining Content interfaces. This port
installs no additional search route or service.

Search's `createRealmRatingNativeSource` in `search/realm-rating-native.ts` remains at `index_not_ready`.
`createRealmRankOrderSource` supplies native selected-question observations, scored score/UUID seeks,
exact figure proofs and `readCanonicalPartition` raw name/ID candidates with complete figure proofs.
Semantic's `subjectSource.canonicalNames` supplies current native population observations and bounded name/ID
seeks, separately from the background ID-key inventory. Private Realm figures remain outside the common Search
index. Complete ordering still requires scored canonical-name ties and admitted predicate composition before Search
may compose the finite frontier. Search retains parsing,
text/analyzer/Boolean semantics, admission, useful-page accounting, public response and signed outer cursor.
The required scored order is score descending, canonical name ascending (missing last), then subject ID ascending;
the unscored phase uses that same name/ID order. The compatibility `page` retains its score/UUID-descending order.

The native observation binds the selected population, question measurement identity, revision, publication digest
and explicit provenance (Global or the owning Realm), current Realm authority/revision, prior eligibility and
publication generation, the population home's epoch/position and the canonical population observation. Every native partition inventory, scored read
and figure proof reobserves this evidence before and after its read, including empty requests. A changed caption,
lifecycle, prior, publication or source home restarts the read; denied Realm or question provenance fails closed.
Retired questions cannot supply new observations. Pending population work cannot prove eligibility, including an
empty scored set or an inactive prior. Exact figure proofs preserve score zero and withhold below-threshold figures.
Canonical observation homes include each occupied native Subject partition's committed generation and source-home
epoch/position. `semantic.subject.canonical_name` follows the current native label head in language order, with
missing names last and UUID ascending ties; the native expression index supplies bounded partition-local seeks.
Term head changes and privileged fact minimization/removal refresh this key in the same transaction. Native
population counts and generations extend `semantic.partition_subjects`; they do not introduce another catalogue.
The partition frontier includes internal hidden/redirected candidates: it never grants Subject read access.
`readCanonicalPartition` reobserves the selected Realm/question and complete native figure evidence even for empty
reads and inactive priors. Scored candidates stay explicit and must be charged when walking the complement.
These primitives do not replace current Subject disclosure or prove the complete Search predicate.

Decision: canonical name keys extend the native Subject row and use committed per-home population generations;
Search remains unavailable until canonical scored ties and complete admitted predicate execution are delivered.

Decision: native primitive reads conservatively restart on any population-home position change until the complete
canonical producer supplies narrower currentness evidence; the scored-only compatibility port is unchanged.

Decision: eligible selected questions use the released integer vote range (0–20 inclusive); custom means and
scores use that question's stored units, while the standard question retains its 0–10 display units.
The producer uses `readVisibleRatingQuestion` before and after traversal: one exact question-home read followed
by its native provenance authority (Realm readability for Realm questions, `definitions:read` otherwise).
It returns `ratingQuestionView` as `question`, including Realm provenance and meaning when present.
Decision: standard and Global-authored questions may select a private Realm population under their existing
`definitions:read` authority; Realm-authored questions must match that Realm, and every caption, provenance or
lifecycle publication change restarts the compatibility cursor independently of measurement identity.
Out-of-range scales return `invalid_request`; absent or denied questions return `not_found`. Global remains
invalid as a Realm selection. Question revision, grain and exact scale are frozen with both publication and
its same-question, same-Realm prior, included in the ordered index prefix and cursor binding. Changing a
measurement requires a new question ID: mutating an existing definition with retained votes withholds its old
ranking rather than reinterpreting those votes or borrowing another scale's prior.

The compatibility result is `{ question, candidates, next }`. Each candidate contains `{ subjectId, count, mean, score, priorEpoch,
revision, asOf, updating }`, in the selected question’s units described above. Only threshold-ready, actively scored figures in
the selected population's current prior generation qualify. No unscored tail, suppressed counts, histogram,
total, scanned count, raw position or readiness estimate is returned. Zero mean and score remain valid values.
Equal scores use subject UUID descending. A full consumed batch may return a continuation followed by an empty
terminal page. Disclosure filtering can shorten or empty a page; the reader never refills it.

`rating.realm_rank` is a private, subject-home ordered projection maintained by the native publication drain.
`applyRatingChanges` marks custom Realm snapshots pending as well as standard snapshots; custom Global totals
remain separate and never supply a Realm prior. `createRatingWorkModule` installs the existing drain effect and
`resumeRealmRankPublication` startup seam. Retained custom totals are marked for epoch checks by migration;
startup resumes those checks and existing durable republish work, without another membership or repair workflow.
The existing `public_figure` table carries internal custom Realm publication envelopes in its half-unit arithmetic,
with the frozen question identity; those envelopes emit only `com.rezics.rating.realm_rank.changed.v1` containing
keys and revision, never the public-figure event or Global public transport. Custom reader numbers multiply that
internal representation by two. The standard publication, public events and Global source keep their units.
The publication transaction maintains it through `public_figure_realm_rank`; migration installs the trigger and
backfills eligible retained figures under a write barrier. No external consumer, new queue or asynchronous copy
lies between figure commit and rank visibility. Votes, eligibility and membership jobs, identity repair and erasure
continue to use that publication path; this increment adds no separate convergence, repair or erasure workflow or outcome claim. Rank
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
cannot appear in its payload. It expires after 15 minutes and binds Realm, exact question revision/grain/scale, partition, sort, limit,
verified credential authority, home epoch, rank source generation and population prior generation. Rank generation
changes atomically with eligible published rows, never with changes confined below threshold. Every request
reauthorizes the Realm, observes the current prior, reads one candidate batch, checks disclosure, reauthorizes the
Realm and reobserves prior and rank generation in fresh physical observations before release. Changed generations
return `invalid_cursor`, including on the first page if publication races it. The reader does not claim an atomic
snapshot of independently homed Access and rating data.

Complete Search row, statement, transaction-control, memory and ordered-index bounds are derived in
[cost-realm-order.md](cost-realm-order.md). The following Operation Cost applies only to the scored-only
compatibility `createRealmRankSource.page`.

Operation Cost:

- Touches: exact population-home prior and subject-home generation keys; the equality prefix
  `(partition_no, question_id, population_id, question_identity, prior_generation)` of `realm_rank_score_idx`, then the strict
  descending `(score, subject_id)` seek; native Realm and subject authority/identity probes.
- Bound: `limit` is 1–100. One candidate query reads at most `limit` rows and releases at most that many figures.
  At most `limit` current subject checks, two selected-Realm checks and two question authority/key reads run. Both prior reads and generation reads are
  point operations. Each consumed rank row adds one exact figure-key probe for its pending mark, and each prior
  observation adds one population pending-jobs probe. There is no candidate lookahead, refill, cross-partition candidate scan, aggregate read,
  history replay or population expansion. B-tree descent grows logarithmically; authority retains its existing
  bounded native cost. Each Realm question authority check adds one current provenance-Realm read. Publication adds one exact rank upsert/delete and at most one generation upsert per figure.
  Prior checks sum at most sixteen population-home shards after an anchored question-key read. Custom publication
  reuses pages of at most 500 subject snapshots, each summing at most sixteen shards; prior republish traverses
  `(question_id, population_id, target_id)` by its existing indexed strict subject keyset, at most 501 rows
  including lookahead. Total republish work is linear in rated subjects; no candidate scan supplies a page.
- `test/rating/realm-rank-question.test.ts` adds distinct questions/scales through native vote workers,
  threshold suppression, independent priors and generations, question authority and cross-question cursor replay.
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
  the last consumed key. Every page rechecks Global authority before and after reading question rows. Denial preserves the
  point route's `404`; unavailable authority or data reads retain ordinary problem responses, never empty choices.
  The cursor binds the directory operation, limit and native viewer/credential authority, with the existing
  4,096-character cap and 15-minute expiry. Expired or mismatched tokens return `invalid_cursor`.
  Unknown, repeated and invalid query fields are rejected. There are no text, grain or selected-id filters, totals,
  votes or population statistics. Clients request each page explicitly.
  Choices are metadata, not feed membership, candidate eligibility or Source readiness. The cursor retains only
  a position and does not freeze question revisions or hydrate entries. Selected identity can be refreshed through
  the point route; separate requests do not certify a shared snapshot. The existing Home caller consumes the default
  Global directory. Explicit Realm selection remains separate from Home's Global controls. The complete generated
  client exposes both selections; metadata conveys no feed predicate or Source readiness. See
  [Selectable directory Cost](#selectable-directory-cost) for the shared Global and Realm bounds and outstanding
  physical-plan measurements.

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

### Provider source statistics

- `GET /v1/subjects/{id}/source-statistics` returns an array of at most two independent current figures,
  ordered by provider, under the Subject's read rules. An absent, cleared or fenced provider has no row and no
  invented total. Each row retains provider, exact source record, effective fence alias, scale, mean, count,
  as-of date, licence and attribution. Figures never enter native votes, means, priors, rankings or ballots.
- `PUT /v1/subjects/{id}/source-statistics/{source}` publishes one positive observation. The strict JSON body
  contains `sourceRecordId`, `scale`, `mean`, positive `count`, `asOf`, `licence`, `attribution`, optional
  `sourceAlias`, optional `figures` and optional `expectedObservation`. It requires `Idempotency-Key` and the shared
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

#### Provider distribution and rank figures

Decision: Bangumi figure encoding v1 uses ascending original 1–10 bins with explicit complete/partial coverage
and optional subject-rank population; omitted figures or denominators remain absent. Scalar DTOs and hashes
stay compatible. This is a native encoding version, never a provider revision.

The existing positive body and response accept optional `figures: SourceFigures`, exported by
[source-figures.ts](source-figures.ts). `createSourceStatisticCommands({pool, routeKey, clock?})` still exports
`write`, `writeCommand`, `clear`, and `read`; `SourceStatistic` is now an exported additive DTO. The mounted
GET/PUT/clear routes, registered change event and default Kernel composition remain the same producer. The
source schemas for existing `rating.source_statistics_get` and `rating.source_statistic_put` operations declare
this exact optional object; their generated client declarations must be published before consumer integration. Neither source requests nor native vote commands acquire another endpoint.

```json
{
  "schemaVersion": 1,
  "distribution": {
    "unit": "ratings",
    "completeness": "partial",
    "bins": [{ "score": 10, "count": 17 }]
  },
  "rank": { "unit": "subjects", "position": 3, "population": 100 }
}
```

The object is closed, requires at least one supplied figure, and is admitted only for the Bangumi provider,
regardless of its fence alias. `distribution` and `rank` are independently optional. Bins use original integer
keys 1–10, strictly increasing and unique; their counts are nonnegative safe integers. A complete distribution
has all ten keys and sums exactly to the included rating count. A partial distribution supplies one to ten
known bins, whose sum must not exceed that count. A present zero is a supplied zero; a missing bin is unknown.
Even ten supplied keys do not upgrade partial coverage. No means are reconstructed or checked against a
weighted sum: the importer contract does not promise the rounding precision needed for that comparison.

Rank position is a positive safe integer; a supplied population is a positive safe integer at least as large
as position. Its unit is subjects, independently of the aggregate's rating count and the distribution's ratings.
Population omission means no denominator is known. No percentile, popularity score, inferred population,
normalized bins or cross-provider ordering is returned. An omitted figure stays omitted on read, including for
old VNDB and scalar-only Bangumi observations. The containing provider row supplies each figure's provider,
original record, effective alias, as-of date, observation digest, licence and attribution. Age is computed from
that source date by the existing Web consumer; no server clock is presented as source freshness.

Figures are immutable payload fields in the existing canonical observation hash and receipt digest. Same-time
figure corrections, record replacement, stale writes and clear tombstones use the same locked provider head and
CAS as scalars. A scalar-only refresh intentionally replaces prior figures with absence; historical payloads
retain the supplied original figures. Removing a current row removes all its figures atomically. Hydration reads
only current slots, never the immutable history. Before/final Subject and tuple-fence disclosure checks cover
the entire containing row, including replay. A changed figure between the local binding reads fails closed.

There are at most ten bins, 4,096 serialized figure bytes, 32,768 observation bytes and 65,536 list-body bytes.
The command validates closed cardinality before serializing; database constraints bound stored JSONB bytes
(including JSONB whitespace), and the reader repeats the closed semantic decoder and body-byte check.
Unknown versions or corrupt figures fail unavailable rather than becoming a scalar-only success. The current
row stores the optional object next to the scalar fields so no per-bin query or head/history hydration is needed.
The existing primary-key prefix `(route, subject_id, source)` covers exactly the two admitted source slots;
immutable head lookup uses all four observation primary-key columns.

Web owns the existing **Bangumi source-figure reader**: named provider, accessible bin counts/shares, partial
coverage, rank with unavailable denominator, provenance, phone/desktop review and one action/recovery. That
visual experience remains pending its owner; this producer does not assert it has passed. Imports owns the
permitted converter, fetching and licence admission; no adapter is admitted by this encoding. The scalar
converter remains compatible. Performance must review inherited nested authority/identity costs before the
controller's broader acceptance; measured statements and bytes are not inferred from the output row count.

References inspected: the Content product-experience decision named by the brief; the reference INDEX;
`legacy-final:apps/web/features/work-page/ratings.tsx` (accessible bin counts/shares and withheld figures).
These establish display semantics, without copying a frontend into this producer.

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

#### Immutable source observation inspection

`GET /v1/subjects/{id}/source-statistics/{source}/observations` is a protected importer read requiring the existing
`source_statistic:write` action. Every response includes the exact current head, including an empty slot or a clear
tombstone, and the `expectedObservation` values accepted by the existing put and clear CAS writers. `?digest=`
selects that exact retained digest and returns it as `selectedObservation` without replacing it with today's head.
`?history=true` starts a signed one-row keyset page; `?cursor=` continues it. Native rows descend by committed
per-subject/provider `nativeOrder`, not provider `asOf`; the raw bounded lookahead determines `nextCursor`. Retained
observations without native order remain marked `legacy: true` with `nativeOrder: null` and are traversed by their
stored digest. `payloadVersion` is explicit, and `provenance` labels the content digest as unversioned provider
provenance. The exported response schema is the actual route DTO for the generated Imports API43 and Web clients.

Decision: inspection always includes the current head; an optional digest resolves that exact retained observation,
while signed history uses descending committed local order and marks legacy rows as unversioned.

Decision: history consumes one raw position even when concealed, returning empty items with continuation when
another raw position exists; a changed source observation returns a conflict for retry with the original cursor.

Current head and exact digest remain required: a concealed required tuple returns the existing indistinguishable 404. A stable concealed historical candidate is omitted before payload acquisition. Lookahead metadata is used
only for continuation and currentness, never as a returned resource or permission. An empty history page with a
non-null cursor is therefore continuing, not exhausted. There is no refill. Initial and final native metadata and
each tuple's own home, epoch and security revision must agree; a change to an optional candidate or lookahead
returns 409 without a new cursor. A final required-source takedown still returns 404. Dependency failures remain
failures; callers retain the supplied cursor for an identical retry or explicitly restart. The signed cursor uses
the native token envelope and binds caller, client, delegator, scopes, route, Subject, provider, Subject home and
Subject epoch, query shape and expiry. Provider tuple homes can differ from the Subject home and from one another.
History keeps its initial native order ceiling and captures the legacy digest ceiling when traversal reaches that
boundary. A removed cursor boundary returns conflict so the caller can retry the original frontier.

Decision: history cursors retain the initial native order ceiling and capture the legacy digest ceiling when traversal
reaches that boundary; continuations reject missing retained boundary rows.

Decision: fence each provider tuple in its own home and bind history cursors to the Subject home epoch.

The installed internal factory is `createSourceObservationReadCommands(dependencies).inspect(input)` in
`source-observation-read.ts`. Its exported `SourceObservationReadDependencies` takes `pool`, `routeKey`, native
`tokens` and optional `clock`; `SourceObservationReadInput` takes `subjectId`, `source`, the authenticated `caller`,
optional `digest`/`cursor`/`history`, and `deadline`.
It returns `Promise<SourceObservationReadResponse>`; `SourceObservationReadItem` and `SourceObservationPayload` are
also exported. The mounted route owns Access authorization and both current Subject resolutions; an internal
factory call does not replace these checks. Existing put/clear commands consume `resolution.*.expectedObservation`
and reauthorize the immutable intent on every attempt, including exact replay. A stale expected digest remains a
conflict. The mounted inspection rechecks the existing action and compares both complete Subject resolutions after
the factory has materialized and byte-checked the DTO. Generated declarations and OpenAPI must come from this
mounted schema before consumer delivery.

Consumers distinguish populated history (`items: [observation]`), continuing withheld history (`items: [],
nextCursor: signedBoundary`), exhausted history (`items: [], nextCursor: null`) and unavailable required resources
(the existing concealed 404). Failed reads return no inspection DTO and retain the original input for an identical
retry; callers can explicitly restart after a changed boundary. The current head is independent of all history
states. Web retains the existing Subject provenance and conflict-recovery interface; native transport tests do not
establish its phone/desktop experience or one-action recovery acceptance.

Inspection reuses current Subject and source-tuple fence reads before and after payload hydration. A guessed digest
cannot disclose an alias or retained payload outside the existing write authorization, current Subject identity and
facts-fence rules. The response is capped at 68,000 serialized bytes and each immutable payload is independently
checked against its stored digest and the 32,768-byte payload limit. The endpoint performs no write, receipt lookup,
provider request, ballot read or source-history sort.

#### Operation Cost: source-observation inspection

- Touches: current-only uses two head metadata queries; exact uses four metadata queries returning at most four
  rows; history uses six returning potentially eight rows across a native/legacy boundary. Each metadata statement
  also reads the Subject partition epoch through the fixed partition key, without adding a metadata round trip.
  Hydration uses one
  immutable batch (at most two rows) and, independently, one legacy scalar read; mixed hydration charges both.
  Up to three distinct tuples (current, candidate, lookahead), each potentially in a different home, receive
  initial/final repeatable-read snapshots. Each snapshot dispatches BEGIN, partition authority, exact fence facts
  and COMMIT: six snapshots add 24 local SQL, including 12 transaction controls, plus catalogue freshness work
  from compiled queries. Required concealment
  stops before hydration; stable historical concealment omits only its payload. Metadata, fence changes and
  dependency failures do not refill. Mounted work additionally includes authentication/account lifecycle and
  root write authorization before and after materialization, admission/runner work and both complete Subject
  resolutions (redirect, identity, Context/citation/disclosure and Access observations). These are independent current observations, not one atomic
  snapshot; their inherited owner bounds and participating pools remain additional to the local SQL count.
- Bound: all metadata/payload queries bind route, Subject and provider. Exact uses the primary key; history uses
  the partial `(route, subject_id, source, local_order DESC)` or legacy `(route, subject_id, source, digest DESC)`
  index, each selecting at most two physical ordered positions. A continuation checks its exact retained boundary by
  key in the same bounded metadata query. Each provider tuple is fenced and compared in its own home; the cursor's
  home and epoch are the Subject home and epoch. The native token binds caller, client, delegator, scopes, query
  shape, expiry and retained native/legacy ceilings. No full-history sort is permitted. Head, candidate and
  lookahead metadata are reobserved before return. Only disclosed head/selection payloads are materialized,
  with at most two item validations/canonicalizations/hashes after deduplicated I/O. The schema admits immutable
  JSONB at 32,768 bytes; legacy scalar field bounds remain their writer's admission. Application payload and
  68,000-byte response checks occur after acquisition/materialization and are not peak-memory bounds. Growth captures
  actual materialized payload, retained item and serialized response byte lengths; admitted source counts are not
  measured byte ceilings. Account for
  decoded JSON/strings, canonical strings, UTF-8 buffers and hash inputs, retained item objects, repeated head/history
  response serialization before final gates, repeated head/history serialization and mounted HTTP serialization/copies.
  Oversize/unsupported historical payloads fail only when selected and permitted. No receipt body or credential is
  provenance. Full physical/byte ceilings still require
  inherited authority, catalogue, runner and materialization terms; output caps alone establish none of those.
- Growth check: `test/rating/growth-source-figures.test.ts` disables the worker and holds the selected Subject/provider,
  three represented tuple homes, admitted payload bytes and one-row page depth fixed while independently growing
  unrelated source heads, selected source history, Subject revisions and closed Access write denials at
  256/1024/4096. It captures participating backends, statement/control work, examined rows, buffers and physical
  prefix/residual plans, plus actual payload/item/response bytes. The existing source-statistic isolation growth
  suite owns registered write-command phases. `test/rating/source-observation-http.test.ts` uses real Access and
  fence commands to pin
  concealed raw continuation, exact native/legacy selection, caller/home/epoch/expiry cursor bindings, new-head
  continuation, payload/final-fill changes, caller/Subject revocation, same-cursor retry and existing CAS recovery.
  Full inherited authentication, runner and peak-memory ceilings remain controller acceptance obligations; a source
  assertion or failed check setup does not establish them.

#### Operation Cost: source-statistic list

- Touches: at most two current statistic rows including their bounded figure JSON, each provider's two anchored tuple-fact snapshots, a second local
  binding read and before/final Subject identity/availability checks.
- Bound: finite admitted-provider count (two), at most 20 bins/8,192 figure bytes, 65,536 response bytes; no totals,
  history scan, source fetch or cross-partition join. Both local reads use the fixed primary-key prefix; tuple,
  Subject, Access and runner work retain their existing bounds and participate in the native growth capture.
- Growth check: existing lifecycle/isolation growth suites retain their indexed current-row/fence scope; the
  connected provider/figure tests cover independent hydration and concealment. The figure growth suite fixes
  the maximum ten-bin payload while native heads/history grow at 256/1024/4096, captures participating pools,
  accounts actual response bytes and asserts physical prefix plans. Execution remains controller acceptance.

#### Operation Cost: source-statistic publish

- Touches: one locked subject, one provider head/observation, optional legacy current row adoption, one immutable
  observation insert (at most 32,768 bytes), one current upsert (at most ten bins/4,096 figure bytes),
  one event/receipt and anchored tuple/Subject observations.
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

`readOwnCountedVotes(client, actor, questionId, targetIds)` is the bounded read for canonical pages. It seeks the
same viewer/question through Rating's partial `(route,voter_id,question_id,counted_target)` index and returns only
the viewer's current native counted vote for each supplied Content terminal. It accepts at most 100 IDs before
dedupe, uses the caller's repeatable-read client, preserves zero and omits absent or cleared votes. The caller must
resolve and revalidate Content identity and visible question meaning; this helper does not admit a result row or
expose aggregate ratings.
`createOwnCountedVoteReader({ pool, access }).prepare(request, deadline)` admits at most 100 requested Subject keys,
requires the current native actor account, authentication epoch and `rating:vote` scope, checks the standard question,
captures current Subject mappings and verifies ordinary Subject
readability before the owner starts its checkout. A pending identity mapping returns `preparing`; an absent,
concealed or unavailable Subject is retained as `unavailable` without exposing its terminal. The fixed measurement is
question `00000000-0000-7000-8000-000000000001`, revision 1, units 0 through 20 in steps of 1.

The caller retains one reader instance and the exact same actor and ordered requested IDs through all three phases;
preparations are instance-local and must not be serialized or reconstructed. The caller starts its own repeatable-read
transaction on the account's native home and passes that `PoolClient` to `read(client, request, preparation)`. The
read phase checks the same account standing and selects `rating.vote.counted_target` rows for the admitted
terminal IDs. It also probes the exact requested and canonical original slots for review evidence, including explicit
missing rows. Those slots never decide which source vote wins or replace counted-target truth. After releasing the owner checkout,
the caller invokes `finish(request, preparation, readResult, deadline)`. Finish rechecks the actual account, question,
identity mapping, published epochs on both identity homes, Subject disclosure, original slots and selected counted rows. It returns `current` only when those observations
match; otherwise it returns `preparing` with a same-input retry. This composition spans native snapshots and is not
one atomic snapshot.

Each current observation correlates `requestedTargetId`, the selected row's `originalTargetId`, and the native
`countingTargetId`. A present row with `units: 0` is a real score; `state: 'clear'` preserves a counted tombstone with
its original `revision` and separate `countedRevision`; `state: 'absent'` means no counted row exists at the current
destination. `unavailable` remains distinct from pending identity coverage. Callers keep their existing Library gate,
source witnesses, owner fencing and exact request on retry. The reader adds no route, derivative, writer or repair.

Decision: native own-score reads prepare identity and disclosure before the caller checkout, read only counted-target
truth plus exact original-slot witnesses in the caller snapshot, then return `preparing` with the same input when final native observations differ.

The mounted factory signature is
`createOwnCountedVoteReader(deps: OwnCountedVoteReaderDependencies): OwnCountedVoteReader`, where dependencies
are `{ pool: Pool; access: Access }`. Its public protocol is:

```ts
prepare(request: OwnCountedVoteRequest, deadline: number): Promise<OwnCountedVotePrepareResult>;
read(client: Pick<PoolClient, 'query'>, request: OwnCountedVoteRequest,
     preparation: OwnCountedVotePreparation): Promise<OwnCountedVoteReadResult>;
finish(request: OwnCountedVoteRequest, preparation: OwnCountedVotePreparation,
       readResult: OwnCountedVoteReadResult, deadline: number): Promise<OwnCountedVoteResult>;
```

`request` is `{ actor: Actor; targetIds: readonly string[] }`; deadlines are absolute milliseconds. Duplicate keys
keep their first occurrence, but all raw keys count toward the 100-key cap. The canonical Subject is the mapping's
terminal and equals `countingTargetId`; `originalTargetId` identifies the selected native vote, which can differ
from both the requested and canonical Subject. `sourceEpoch` is a decimal string. Fingerprints are SHA-256 hex
digests of JSON observations; the request digest binds account, client, sorted scopes, authentication epoch,
requested-by identity and ordered raw keys. Native account observations bind route, standing and transaction
identity; instance-local witnesses also bind published epochs on the requested and canonical homes.

Dependency errors propagate: callers retain their cursor and exact input, without publishing empty or refreshed
observations. A changed `countedRevision` invalidates final confirmation even when units and original `revision`
are unchanged. Display values are units divided by two; `null` remains clear. The review witness encoding and byte
limit below apply to these observations, but confer no atomic conditional write admission.

Decision: publish the named reader and dependency types from the generated mounted module so consumers never infer
the protocol from private source; the account-page `createOwnVotesReader` remains a separate authority.

### Conditional provider vote review

`createVoteCommands({pool, access, clock?}).putVoteOutcome(actor, input, idempotencyKey)` accepts
`input: {questionId, targetId, units: number | null, guard?: VoteReviewGuard}`. Its success result remains
`{vote: Vote | null, component: SessionComponent | null}`. Unconditional callers keep their existing writer,
receipt and matching-no-op behavior. The HTTP vote body remains unchanged; the guard is an internal producer input.

Each available counted-reader observation now includes `review: VoteReviewGuard`, with version 1,
`question: {revision, lifecycleRevision}`, `subject: {canonicalId, epochs: [{partition, epoch}]}` and
`ownVote: {state: 'absent' | 'present', observation}`. Epochs are native published unsigned decimal strings from
both requested and canonical homes, deduplicated and sorted. Missing or pending coverage cannot produce a review.
The opaque observation is canonical JSON of the fixed tuple
`[1, ownerId, questionId, requestedTargetId, canonicalId, originalSlot, canonicalSlot, effectiveSlot]`.
Each slot is null for proven absence, or
`[sourceTargetId, units, revision, countedRevision, countedTarget, changedAt, transactionId]`.
It retains explicit clears, zero, source replacement and revision-only changes, with a 4096-byte input ceiling.
Consumers retain it unchanged. This is review evidence across bounded native snapshots, not an atomic fence.

The complete closed, copied guard participates in the existing vote receipt digest. Current native account and
Access admission precede receipt lookup. Fresh execution compares question meaning/lifecycle, canonical target,
exact identity epochs and the own-vote witness before no-op, cleanup or effects. A known mismatch throws
`VoteReviewStaleError` (`question_changed`, `subject_changed`, `identity_epoch_changed`, `own_vote_changed`);
missing published epoch evidence throws `VoteReviewUnavailableError`. Errors create no success receipt and an
unchanged unavailable attempt may retry the original input/key. Guard validation rejects malformed versions,
unsafe revisions, incomplete or extra identity-home evidence and oversized observations as `VoteInvalidError('guard')`.

Decision: guarded provider effects remain `atomic_guard_unavailable` until question lifecycle and identity
publication supply commit-held native participant fences; reviewed evidence alone never installs adoption.

The missing owner contracts are a Rating question-home revision/lifecycle hold joined to the voter command commit,
and a Semantic requested/canonical-home mapping and exact published-epoch hold joined to that same commit,
including identity admission, publication and reconciliation writers. The current question writer locks its own
question row; `identityEpochStore.readEpoch` and `admitIdentityRatingEffect` observe identity without such a hold.
Account sharing, the shelf write gate and local vote row locks do not fence these foreign authorities. Even a
matching guarded no-op therefore returns typed `atomic_guard_unavailable`; no guarded effect is installed or
advertised to Library consumers. Guarded success/replay, absent-slot first-writer serialization and full native
race/growth acceptance remain delivery work under those owner contracts. Bangumi, MAL and AniList independently
retain unavailable adoption and do not depend on one another's publication.

#### Native question participant

`createQuestionVoteAdmission(): QuestionVoteAdmission` in `question-vote-admission.ts` supplies the question
producer independently of the vote writer and Semantic identity admission. Its exact methods are:

```ts
prepare(input: Readonly<{
  questionId: string;
  question: VoteReviewGuard['question'];
}>): QuestionVoteAdmissionPreparation;
admit(
  tx: CommandTransaction,
  prepared: QuestionVoteAdmissionPreparation,
): Promise<Readonly<{
  questionId: string;
  revision: number;
  lifecycleRevision: number;
  lifecycleState: 'active' | 'retired';
}>>;
```

Preparation copies one routed UUID and the exact reviewed immutable-definition/lifecycle pair (positive int32
revisions). It performs no I/O, holds no resources, and is accepted only by the factory that minted it. It may be
reused across executor retries. The native body calls `admit` on the original live executor transaction after
authorization and receipt lookup, before any no-op, cleanup or effect. The returned state is the state bound to
that lifecycle revision; it does not grant permission to cast on a retired question. The writer still checks the
entire guard, disclosure, units and authority. This participant writes no vote, consent, receipt or event and has
no HTTP endpoint. A returned value is descriptive, never a reusable execution capability.

Decision: question admission supports the command's own logical home only; cross-home attempts explicitly return
`VoteReviewUnavailableError('atomic_guard_unavailable')`, even for currently co-resident homes. The executor has
no multi-home participant enrollment/completion/abort protocol. Its owning command infrastructure must provide
deterministically ordered native home fences held through the _same_ owner commit, including movement and failure
cleanup, before cross-home installation. Neither an arbitrary foreign checkout nor local SERIALIZABLE installs it.
The original guarded vote journey remains unavailable until its writer integrates this participant and Semantic's
separate exact-epoch participant. This source factory is not generated client delivery or provider adoption.

Within one home (including different routes in that home), admission takes a PostgreSQL share lock on the actual
question, then reads its lifecycle head. Absence of that head means active revision 1 under the owning question
lock, never absence of serialization. Standard/native and Realm questions use the same path. Retire and restore
update the question tuple to its existing definition revision before changing the lifecycle head. This physical
tuple change forces an older SERIALIZABLE command snapshot to retry rather than read a superseded lifecycle head;
it does not advance the immutable meaning revision. An authoritative definition-changing writer must likewise
update this tuple before dependent heads. Current authoring only inserts immutable definitions. Caption writers
change their independent head and do not invalidate meaning evidence. The common order is question tuple, lifecycle
head, then the executor's native completion fence. Exact replay does not execute that body or update the tuple.

Missing questions or mismatching definition/lifecycle revisions produce fresh `VoteReviewStaleError('question_changed')`.
Malformed preparation is rejected; unknown lifecycle state is `question_observation_unavailable`. Native contention,
deadline and operational failures retain executor outcomes and retries. There is no participant release method:
the original executor COMMIT or ROLLBACK releases its row locks, including failed guards, no-effect completion,
deadline and abort. A completed transaction cannot admit again. Preparation creates no checkout to clean up.

##### Question participant Cost

- **Touches:** Preparation/evaluation uses no Access preparation or evaluation of its own. Admission uses the live
  authorized command's one pool/client, locks one primary-key question and reads at most one primary-key lifecycle
  head in two statements; it adds no transaction controls. Lifecycle transitions additionally update that one
  question tuple. Native receipt, management authorization, generation and event work remain owned above.
- **Bound:** One supplied key and one logical home; at most two materialized physical rows. Retained preparation
  contains one 36-byte UUID and two int32 revisions; the result contains that UUID, two int32 revisions and one
  enum of at most seven ASCII bytes, plus fixed object/serialization keys. SQL never materializes meaning, scale,
  captions, histories or unrelated questions. There are no extra pools, checkouts or independently retained handles.
  Index positioning grows logarithmically; this bound does not count MVCC storage as work evidence.
- **Growth check:** `test/rating/question-lifecycle.test.ts` retains real management actions/readback, replay and
  revocation and exercises the native factory, implicit head, both competing schedules, restore ABA, standard
  question, stale/missing keys, unavailable foreign home, abort/deadline and subsequent valid commands. Controller
  acceptance owns observed SQL/controls, physical plans, bytes, pools and runner phases with independently grown
  selected/unrelated question/lifecycle histories at 256/1024/4096 and fixed keys/native byte caps; no measured
  growth pass is claimed by these source bounds.

Commerce and own-score consumers import `OwnCountedVoteReader`, `OwnCountedVoteReaderDependencies`,
`OwnCountedVoteRequest`, `OwnCountedVotePreparation`,
`OwnCountedVoteReadResult`, `OwnCountedVoteResult`, `OwnCountedVoteObservation` and their supporting types from
`@rezics/client`. `packages/client/src/index.ts` re-exports these source declarations from
`services/kernel/src/rating/own-votes-counted.ts`, generated as
`packages/client/src/kernel/rating/own-votes-counted.d.ts`; generate that module and OpenAPI together from the
complete mounted source with `bun run --cwd services/kernel typecheck --emit-client --emit-openapi`.
Consumers use observations only when the result is `current`; `preparing` retries the same reader instance, actor and
ordered target IDs. Preserve `counted` (including zero), `clear`, `absent` and `unavailable` as distinct states, and
retain source epochs and vote revisions for currentness checks.

Decision: Commerce and own-score consumers use these source-derived DTOs, retry `preparing` with identical input and
preserve each observation state.

#### Native counted own-score reader Cost

Decision: growth fixtures compose native Access directly so unrelated Kernel HTTP catalog startup does not prevent reader measurements.

- Touches: preparation reads the account once, then reads the standard question, native identity mappings and published requested/canonical-home epochs outside the caller checkout. The identity producer double-collects each supplied source/control home; Subject disclosure repeats a bounded identity collection and prepares and evaluates Access for each original and terminal. The caller phase binds the account home, reads the account once, probes at most 100 exact counted-target keys and batch-probes at most 200 exact original-slot keys. Finish rechecks question, mappings, epochs and disclosure, then re-reads the account, counted rows and original slots in one final account-home snapshot. Every foreign home is released before the caller checkout and final account snapshot.
- Bound: at most 100 raw requested IDs, 100 distinct requested identities, 100 counting destinations, 200 original slots and 200 identity homes, deduplicated. Each counted-target statement uses the exact `(route, voter_id, question_id, counted_target)` prefix and returns at most one row per destination. The additional original-slot statement uses the full `(route, voter_id, question_id, target_id)` prefix and returns one explicit present/absent observation per key. There is no vote-history scan, refill, winner selection, write or event. The intended examined-work bound is constant rows/statements and logarithmic B-tree positioning with retained history, including Account/question/identity and Access evidence. Revisions, counting identity, units, time and transaction ID survive final comparison and the review DTO; each opaque witness is bounded to 4096 bytes. These native output caps alone do not establish that examined-work bound.
- Growth check: `test/rating/own-votes-page.test.ts` retains the exact native counted-reader outcomes. `test/rating/growth-own-votes.test.ts` measures only `readOwnVotes`. `test/rating/growth-own-votes-counted.test.ts` adds independent 256/1024/4096 physical-prefix measurements through the production prepare/read/finish reader and real Access for unrelated votes, same-voter/question retained losing rows, selected-source redirect and mapping/authority history (including expired Access grants), and relevant repair backlogs. Requested keys, homes, admitted cardinalities and byte caps stay fixed. The shared harness charges SQL/controls, participating connections, physical plans and raw wire bytes without changing catalog, MVCC or asynchronous attribution. Fixture counters charge reader and command-runner phases, Access preparation/evaluation, database-row materialization, retained identity/Access/reader payloads and serialized results as UTF-8 bytes. Growth requests fix one legacy alias and one unavailable key at two Subject homes; the exact native cases retain the other observation variants. Decision: current journeys, pending-authority observations and stale-finish cleanup use independent fixed-size captures, preserving the shared telemetry cap; repetitions keep identical input and restore the losing slot or pending marker after each negative observation. Successful same-input retry after each negative observation still needs measured coverage. The focused suite currently fails: selected identity/source/authority history examines 3660, 12876 and 49740 rows in current journeys, with the growth attributed to the native terminal-closure directory lookup; several exact byte-counter bounds also fail. These results do not establish a counted-reader prefix bound. Controller acceptance and broader campaigns remain deferred.

### My ratings

`GET /v1/me/rating-votes` (`rating.own_votes_page`) mounts the account-home native inventory under
`rating:vote`, authenticated bearer access and the existing `personal_library` exposure gate. Its sole optional
query field is `cursor`; unknown fields, including voter, selection, search, sort and limit, are rejected.
Responses use `Cache-Control: no-store`. `register.ts` exports `createOwnVotesReader`, `OWN_VOTES_PAGE_SIZE`,
`OwnVoteActions`, `OwnVoteEntry`, `OwnVotesPage` and their mounted schemas. The factory takes the existing
`{pool, access, tokens, routeKey, clock?}` dependencies; `page(actor, {cursor?}, deadline)` returns the same DTO.
The default Kernel passes its existing trusted route key; this read-only operation registers no new writer,
projection, event or worker. Existing vote effects and session-token transport remain the mutation authority.

Decision: list all current native votes in question/target key order; retain merged source identities and withhold
their mutation links because the existing command resolves to the terminal and cannot withdraw the old source safely.

The fixed raw window consumes twenty non-cleared `(question_id, target_id)` keys and at most one lookahead on
the authenticated account's route. `vote_own_current_page_idx` physically excludes cleared rows. It does not
sort by change time or invent chronology. Changing a value keeps its key; clearing removes it; reapplying before
the consumed key is observed on a fresh traversal. Inserts after that key may appear later. This live cursor
promises neither a historical snapshot nor continued readability of previously consumed rows.

Continuation is sealed to account, client, delegator, normalized complete scopes, authentication epoch, current-native
selection and ordering version, using the observed native account-home epoch. The injected clock and shared signed
cursor service retain their fifteen-minute expiry. Current
account kind/state/fence/epoch is checked before cursor decoding and before vote payloads. The twenty selected
source keys alone enter native identity, Subject summary and question observations. Question reads group exact
IDs by home, join only their label/lifecycle heads, release the home, and check each represented Realm through
native Access. Global questions retain the existing vote command's disclosure rule. No mounted point GET is used
for hydration. Final question, original/terminal disclosure, identity and account observations qualify rows and actions. Labels
come from `readSubjectSummaryObservation`; its final `current()` witness rechecks actual source-home epochs and
positions and freshly prepared native disclosure. Changed summary sources fail with retryable unavailability,
never old labels. A final exact-key account read suppresses concurrently cleared votes; a changed selected slot or
question observation fails for retry at the same frontier, rather than combining observations from different operations.

Each entry includes the original `targetId`/`questionId`, current permitted `subject` summary and `subjectHref`
(the native Subject GET), current `question` label/scale/lifecycle, and `own: {units, revision, at}`. Units equal
zero remain present. A merge can show multiple original votes with the same terminal summary; their source keys
never collapse into an invented canonical vote. A pending identity suppresses a row. Unavailable identity,
release or authority work fails the complete request with a retryable problem, retaining the caller's unconsumed
frontier. An empty or short eligible page keeps `next` when raw continuation exists; it never refills to twenty.

`actions` is a closed union: `editable` supplies `put`, `clear`, `readback`; `retired` supplies clear/readback and
`reason: question_retired`; `unavailable` supplies `merged_source` or `identity_pending` without mutation URLs.
All links target the exact existing `/v1/subjects/{id}/ratings/{questionId}/vote`. For a supported row, PUT integer
units using one idempotency key, keep the returned `rezics-session-token`, and retry an uncertain response with
that original method/path/body/key. GET readback uses that exact source. DELETE uses its own stable key; subsequent
GET returns 404 and a fresh inventory omits the clear. Neither replay nor delayed aggregate work recreates a vote.
Own units imply no public mean, private rank, provider figure or Realm contribution. Aggregate freshness remains
the existing aggregate read's explicit `freshness` contract; the page does not claim aggregate completion.

`prepareVoteTarget` in `votes.ts` is shared by the writer's initial preparation, every native attempt before
receipt replay, and two request-local observations for each selected unmerged slot. It observes the actual question
and original-to-terminal resolution through native Access. The account snapshot repeats the writer's current account
requirements, native identity-effect admission and existing Library command gate. Retired definitions offer only
clear/readback when those conditions hold. Advice grants no authority: PUT/DELETE repeat their own authorization,
preparation and locked native admission on every attempt. No new writer, authority copy or lifecycle is installed.

Decision: a fenced native account home or closed existing Library command gate returns closed `unavailable/read_only`
action advice without mutation links; changed retained summary, question or slot observations require same-input retry.

Examples for Web's existing account reader and Subject assessment owners:

```ts
// Populated: exact identities and existing native transport, including a valid zero.
{ viewer: { accountId }, votes: [{ targetId, questionId, subject, subjectHref,
  question, own: { units: 0, revision: 1, at },
  actions: { state: 'editable', put: votePath, clear: votePath, readback: votePath } }], next: null }
// Retired questions preserve withdrawal, with no PUT link.
{ state: 'retired', reason: 'question_retired', clear: votePath, readback: votePath }
// A merged source keeps its exact original key and withholds all command links.
{ targetId: sourceId, actions: { state: 'unavailable', reason: 'merged_source' } }
// Empty; deliberately withheld raw windows can instead retain a continuation.
{ viewer: { accountId }, votes: [], next: null }
{ viewer: { accountId }, votes: [], next: opaqueCursor }
// After clear, exact-source GET returns the same 404 used for an unknown or concealed slot.
{ status: 404, code: 'not_found' }
// Failed load is HTTP 503 with a retryable problem, never the empty DTO.
// Revoked/suspended or missing rating:vote is HTTP 403; signed out is HTTP 401.
// A fenced home/closed native command gate preserves the readable row without action links.
{ state: 'unavailable', reason: 'read_only' }
{ state: 'unavailable', reason: 'identity_pending' }
// A retryable 503 keeps the original cursor. Reload that exact cursor after recovery.
// Uncertain PUT/DELETE retains the original method/path/body/key and uses exact-source GET readback.
```

Web retains all UI ownership. The account inventory consumer and phone/desktop change/clear/failure-recovery
inspection after integration are remaining experience work; this API alone does not close that journey.

#### Raw current-vote selection Cost

- Touches: `readOwnVotesRawPage` checks one current account primary key, then seeks the partial Rating index by
  route, voter and complete question/target continuation. The mounted caller independently binds the account home.
- Bound: one account row and at most 21 indexed current votes; at most 20 selected payloads enter hydration.
  Stored fields have fixed UUID/integer/timestamp widths. B-tree positioning grows logarithmically with current
  keys; cleared rows are absent from the selection index. No count, residual tombstone filter or refill scan.
- Growth check: focused outcome coverage exercises twenty selected keys, sparse eligible output and continuation.
  Independent native 256/1024/4096 growth and strict partial-prefix plans remain integration acceptance.

#### Current own-vote page Cost

- Touches: three account-home repeatable-read snapshots (pre-cursor, raw selection, final supplied-key read),
  each with partition binding, a second native partition-state read and current account admission; the raw helper
  repeats account admission. Final selection probes at most20 exact vote keys and the native Library command gate.
  Two question passes group Q <=20 definitions by home, reading exact definition/label/lifecycle heads and preparing
  and evaluating native `readRealm` for R <=Q represented Realms per pass. Four batch identity observations remain:
  initial mappings, initial readable originals, final readable originals and final mappings. Each batch collects
  twice, with source-home owner/source batches and control-home owner/pending-group/current-closure batches.
  Each readable-original pass prepares original AND terminal Access and reads both references, even for ordinary
  sources. For P <=20 selected visible unmerged slots, two `prepareVoteTarget` passes additionally read a native
  question, its Realm when applicable, one identity mapping and original AND terminal prepared Access/reference
  observations. The final account snapshot performs at most S <=20 exact native `admitIdentityRatingEffect` probes,
  each with direct redirect and identity-home owner/cutover/control reads, matching the writer's native location.
  Two independently anchored Global release reads bracket the shared summary. `readSubjectSummaryObservation`
  projects at most S terminals; its final witness prepares native Access for disclosed initial/representative
  batches, reads all participating partition bindings and epoch/positions and evaluates each check afresh. All
  preparation releases its checkout before another home is acquired; every snapshot has BEGIN/isolation/COMMIT or
  rollback, pool acquisition and deadline work. The reader has no command runner; actual PUT/DELETE retain their
  existing preparation, authorization-before-receipt, locked vote/count/admission, event/receipt/commit and replay
  phases from the vote Cost sections, including the shared Library gate and registered effect runner phases.
- Bound: at most21 raw votes,20 exact final vote points, four account points, six account-home partition points,
  one Library gate point,2Q question/label/lifecycle points plus2P native command question/label/lifecycle points,
  2R grouped Realm observations plus up to2P command-preparation Realm observations. Identity work comprises four
  batches plus2P individual mapping observations,4S readable-source reference checks plus4P preparation reference
  checks, and S effect-admission probes. These are supplied-key bounds, not a numeric ceiling on nested authority.
  The summary owner includes current labels, original-language/image slots, up to twelve representative-edition
  keys and one chosen edition per terminal, up to three planning attempts, native disclosure for all addressed
  Subjects, selected Content media/custody and independently anchored source fences. Its final witness retains
  actual source-home epoch/position components and selected/disclosed batches and repeats native authority work.
  Cold release reads include the complete released bundle. Charge physical rows and raw/materialized/retained/
  serialized bytes for every nested pool, Access proof, statement/expanded-slot candidate, label, cover/credit,
  retained observation and final DTO, not only twenty vote scalars. Existing Performance corrections still apply;
  neither output limits nor fixed keys prove a whole-operation physical or byte ceiling. Empty raw pages stop
  before foreign work; denied scopes/security episodes stop before private payload selection. Operational failure
  returns no page/frontier; callers retain the exact input for retry.
- Growth check: `test/rating/own-votes-page.test.ts` uses production Kernel, native Access, signed-account fixtures
  and registered Rating effects for native mutation/replay/readback, sparse pages, two devices and dependency
  recovery. All-pool controls/rows/bytes and strict by-ID physical-prefix plans at independent 256/1024/4096
  growth, including question/Subject revisions, remain integration acceptance; Performance review is required
  before setting the nested numerical ceilings.

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

| Operation                           | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Growth check                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Put vote                            | Reads the voter's account, capped Realm memberships, existing vote by `(route, voter_id, question_id, target_id)`, and any counted-target match by its unique index; writes the vote and command/event records. Membership input is capped at 100.                                                                                                                                                                                                                                                                                                                                                                      | Rows and statements are constant for one vote; index blocks grow logarithmically with same-partition vote history. Membership work is capped at 100 rows independently of other voters and waiting Realms.                                                                                                                                                                                                                                            | `test/rating/growth-votes.test.ts`: `putting a vote has constant rows and statements as same-partition votes grow`; `putting a vote reads only the capped memberships as other voters and waiting Realms grow`                                                                                   |
| Own-vote batch                      | Reads the account by primary key and seeks a vote for each distinct requested target by `(route, voter_id, question_id, target_id)`; input has at most 100 target IDs.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rows grow linearly with distinct targets `k` (at most `k` vote rows plus one account); statements are constant (two when nonempty, one when empty); index blocks grow logarithmically with vote history.                                                                                                                                                                                                                                              | `test/rating/growth-own-votes.test.ts`: `own vote batch has input-bounded rows and constant statements as votes grow`                                                                                                                                                                            |
| Aggregate apply                     | Released distinct-question preparation, local counted-vote winner probes and aggregate shards, then atomic exact delivery capture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | At most 100 changes per command, 100 destinations, 200 question/shard deltas per delivery and 101 command events. Work is O(changes); indexed winner probes touch one counted entry.                                                                                                                                                                                                                                                                  | `test/rating/growth-aggregate.test.ts`: `aggregate updates keep bounded rows and statements as votes, targets, accounts and source partitions grow`                                                                                                                                              |
| Population-total delivery           | Exact inbox admission, contiguous receipt and additive total updates at the population home, then exact source acknowledgment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fixed keyed work per receipt/replay, at most two statements per affected shard plus fixed receipt/clock work; source backlog pages at most 100. Unrelated history requires no scan; blocks grow logarithmically.                                                                                                                                                                                                                                      | `test/rating/population-total-home.test.ts`: `source pages, destination statements and exact replay stay bounded as unrelated receipt history grows`                                                                                                                                             |
| Aggregate read                      | One question-scale point read at the question home, one population-pending point read at the population home, and at most 16 component shards by the full target-local key prefix. Each statement has its own logical partition binding. A request can include at most 20 populations.                                                                                                                                                                                                                                                                                                                                  | Six application statements per known-question aggregate (three partition probes and three data statements), reading at most 21 rows including partition metadata. Pool calls use three sequential snapshots/checkouts, never one checkout per shard; caller-owned snapshots add no checkout or transaction control. Work is independent of unrelated population/target rows, with logarithmic index blocks; no vote, subject, member or history scan. | `test/rating/aggregate-anchored-read.test.ts`: separate-home outcome, max-one pool, exact native components and unrelated population/target growth; retained `test/rating/growth-aggregate-read.test.ts`: `one population aggregate read has constant rows and statements as target voters grow` |
| Population page                     | Seeks the target-first population index for at most 20 positive populations and one continuation probe, then reads up to 16 component shards per returned population.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rows are constant (at most 20 × 16 shard rows plus the continuation seek); statements are constant; index blocks grow logarithmically with rated-population history.                                                                                                                                                                                                                                                                                  | `test/rating/growth-aggregate-read.test.ts`: `a target population page has constant rows and statements as rated populations grow`                                                                                                                                                               |
| Segment and re-key page             | Reads at most 100 vote rows by `(question_id, target_id)` keyset in the voter partition, the active Realm/job checkpoint and, for re-key, capped population memberships. Applies page changes through the aggregate effect, grouping commands by target partition.                                                                                                                                                                                                                                                                                                                                                      | The page input `k` is at most 100 votes. Rows and statements are linear in `k` and affected target partitions, with at most 101 populations per re-keyed vote; index blocks grow logarithmically with voter vote history. Total workflow work is linear in pages.                                                                                                                                                                                     | `test/rating/growth-segment-job.test.ts`: `segment page has constant rows and statements as voter votes grow`; `re-key page has constant rows and statements as voter votes grow`                                                                                                                |
| Eligibility page                    | Reads at most 100 vote rows by keyset and at most 100 capped voter-Realm rows, then applies each vote to Global and up to 100 Realm populations through the aggregate effect.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Page rows and statements are linear in `k × p`, where `k` is at most 100 votes and `p` is at most 101 populations per vote; index blocks grow logarithmically with voter vote history. Total work is linear in page count.                                                                                                                                                                                                                            | `test/rating/growth-segment-job.test.ts`: `eligibility page has constant rows and statements as voter votes grow`                                                                                                                                                                                |
| Merge page                          | Reads up to 100 Global population voters by keyset, their questions for the merged target, vote rows by counted-target and vote primary-key indexes, and applicable capped Realm populations; groups commands by voter partition.                                                                                                                                                                                                                                                                                                                                                                                       | Rows and statements are linear in page voters `k` (at most 100) and affected questions; index blocks grow logarithmically with merged-target voter history. Each page is bounded separately; total work is linear in page count.                                                                                                                                                                                                                      | `test/rating/subject-merge.test.ts`: `merge page has constant rows and statements as merged target voters grow`                                                                                                                                                                                  |
| Voter-Realm membership change       | Reads and writes the affected membership and, on removal, the earliest waiting membership through capped/waiting partial indexes; vote population selection reads at most 100 non-uncounted memberships.                                                                                                                                                                                                                                                                                                                                                                                                                | Membership-change rows and statements are constant (at most two membership rows); index blocks grow logarithmically with membership history. Vote membership selection is linear in the fixed cap of 100, independent of other voters and waiting-set size.                                                                                                                                                                                           | `test/rating/voter-realms.test.ts`: `membership join and promotion cost constant rows and statements as other voters grow`                                                                                                                                                                       |
| Public figure drain                 | Completes source delivery pages, then selects at most 500 pending figure keys, captures distinct exact priors in independently anchored population-home reads, then materializes local prior inputs and publishes in the existing subject command. Each figure reads up to 16 local aggregate shards, updates one figure and emits one changed-figure event. Republish marking uses the same source capture and local input guard.                                                                                                                                                                                      | At most 500 candidates and 500 distinct prior inputs; source snapshots release before target checkout, with one local command per affected subject partition per page. Indexed work O(page × distinct prior keys × log R), retaining at most 16 components per figure and the existing republish page/cursor bounds. No partition/history survey or retry/refill is added.                                                                            | `test/rating/growth-public-figure.test.ts`: `figure drain has constant rows and statements as votes on one subject grow`                                                                                                                                                                         |
| Subject public figure HTTP read     | One subject read under existing read rules, the standard question scale, one `readPublicFigures` statement for one anchored subject, and one point read of that figure's pending mark in the same snapshot.                                                                                                                                                                                                                                                                                                                                                                                                             | O(1) statements and rows, independent of votes, populations and subjects; figure index blocks grow logarithmically with the relation.                                                                                                                                                                                                                                                                                                                 | `test/rating/public-figure-http.test.ts`: the ready-figure acceptance measures the same statement count at 1, 64 and 512 voters.                                                                                                                                                                 |
| Public figure batch and page reads  | The batch seeks up to 256 requested IDs by `(route, question, population, subject)`; the page seeks the exact partition/question/population prefix and strict subject cursor in the existing published-figure partial index, then reads at most the requested ordered window and its figure rows.                                                                                                                                                                                                                                                                                                                       | Intended bound: one statement per call; at most 256 exact batch rows or 500 visited/returned matching page rows plus logarithmic index seeks, independent of unrelated figure/voter history. Measured growth acceptance UNRUN under minimal verification.                                                                                                                                                                                             | `test/rating/growth-figures-statistics.test.ts`: `Public figure batches and pages stay within their bound as figure and voter history grows`                                                                                                                                                     |
| Public figure views                 | One question read by key and one statement seeking each requested subject's figure by primary key in its anchor partition, for the standard question and Global population.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Two statements per non-empty call; at most the requested 256 figure rows; blocks O(N log F), linear in N subjects and logarithmic in F figure rows, independent of votes, populations and Realms. Empty calls issue no statements.                                                                                                                                                                                                                    | `test/rating/public-figure-views.test.ts`: `batched figure views use two statements for 1, 64 and 256 subjects across partitions`                                                                                                                                                                |
| Source-statistic GET, PUT and clear | GET returns at most two rows for the admitted `vndb` and `bangumi` sources, checks its exact facts tuple in two independently anchored tuple-home snapshots, rereads the local binding, and rechecks the current subject before serialization. PUT checks that tuple before its subject-partition upsert and at final disclosure. PUT and clear lock the subject, seek its exact provider head and preserve immutable observations. Clear advances an ordered tombstone and deletes only the matching `(route, subject_id, source, source_alias, source_record_id)` row; a head change emits the existing change event. | Rows, statements and effect events are constant: one current row/head per subject/provider, at most two observation inserts (including legacy adoption) and one effect event per command, and one facts-fence row per tuple snapshot. Index blocks grow logarithmically with source-statistic, receipt and tuple-fence histories. Every nested query and physical occurrence is included in the lifecycle growth capture.                             | `test/rating/growth-source-statistic-lifecycle.test.ts`: `source statistic GET, PUT and authoritative zero clear stay bounded as row and tuple histories grow`; `test/rating/growth-figures-statistics.test.ts`: `Source statistic writes and reads stay within their bound as statistics grow`  |
| Own-vote and question GET reads     | Each command and mounted GET reads the account by primary key, then seeks one vote by `(route, voter_id, question_id, target_id)` or one question by primary key.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rows and statements are constant per read (two point reads); index blocks grow logarithmically with vote history.                                                                                                                                                                                                                                                                                                                                     | `test/rating/growth-figures-statistics.test.ts`: `Own vote and question reads stay within their bound as votes grow`                                                                                                                                                                             |
| Protected Realm scored page         | Two native Realm authorizations, two selected-question observations (question and label head, home partition, and current provenance authority), two freshness/prior reads, scored rank generation and seek, and native subject Access/current identity for every consumed row. The seek binds the actual `question_identity` before `prior_generation`.                                                                                                                                                                                                                                                                | [Derived bound](cost-realm-order.md): rows <= `14+C+2R_R+C R_S+2R_Q`; statements and controls <= `29+2A_R+C A_S+2A_Q`; `C<=limit<=100`, returned `V<=C`; candidate index positioning is logarithmic. This is the compatibility scorer only; it does not establish canonical-name ties or the unscored complement.                                                                                                                                     | `test/rating/growth-realm-rank-source.test.ts`: three scales and first/deep/withheld/empty/terminal cases; its selected-question cost and EXPLAIN assertions remain to be reconciled before acceptance.                                                                                          |

Page sizes bound each workflow step independently: segment and eligibility pages process at most 100 votes, merge pages at most 100 voters, and figure drain/republish work is admitted in pages of at most 500 figures. Total affected work grows with page count and affected keys; a page bound does not bound the complete workflow.

## Imported classification observations

[register.ts](register.ts) exports `createSourceClassificationProducer(config)` for the existing Imports and Web
server compositions. Its methods are `put(PutSourceClassification)`, `clear(ClearSourceClassification)`,
`readExact({actor, subjectId, association, deadline})` and
`readBatch({actor, subjectId, associations, limit, deadline})`. The supplied-key batch accepts one Subject and
1–32 selected associations; an empty selection returns an empty array without IO. It rejects oversized input
before any authority or source lookup and never discovers classifications or refills withheld results.
`SourceClassificationProducer`, `SourceClassificationFigure`, `SourceClassificationRead`, the mutation/input
interfaces, closed ingestion schemas, digest helpers and the maximum batch constant are actual exports.
These producer methods also back the mounted source classification transport below. There is no public fence endpoint or new governed resource.

The finite VNDB profile is defined in [source-classification-contract.ts](source-classification-contract.ts).
[VNDB's official Kana fields](https://api.vndb.org/kana#vn-fields) define tag confidence as the provider's
`tags.rating`, greater than zero and at most three, and `tags.lie` as a boolean. Character `traits.lie` is also a
boolean; character traits do not provide confidence. The admitted record/member pairs are `v…`/`g…` and
`c…`/`i…`. No confidence is converted into a probability, enjoyment star score, vote or local classification
ballot. Independently provided `confidenceCount` and `lieCount` are optional nonnegative integers. Omitted
counts stay absent, including in the public DTO; ordinary Kana tag/trait responses do not supply those counts.
Imports owns actual payload extraction, permission and licence admission. There is no provider fetch or second
producer here. This capability does not admit an otherwise prohibited dataset or converter.

Decision: a native canonical classification may receive an independently licensed imported observation; an imported
candidate additionally requires the same facts tuple as its current Semantic provenance. Imports supplies the
external association identifier; Semantic remains authoritative for the selected canonical candidate and provenance.

Every association binds Subject, property, candidate, candidate revision, release, Context, exact target and
`qualifiersDigest`. `classificationQualifiersDigest(publicStatement.qualifiers)` hashes canonical snaks with
`{property: id, value}` and preserves qualifier order. The empty qualifier list has its own digest. The native
adapter calls Semantic's published `currentRelationFacts`, `candidateSources`, `readRelease`, `readContext` and
current Subject identity/Access interfaces. It contains no Semantic SQL, display-text matching or alternate
candidate selection. It uses the public statement audience and independently checks target readability. Missing
release/provenance authority cannot produce an available figure. A replacement, different revision, changed
qualifiers or Context uses a different slot; old figures remain attached to their original identity.

The release identity uses Semantic's `sha256:` prefix followed by 64 hexadecimal characters; observation and
qualifier digests remain unprefixed. The adapter requests caller-owned source-fence resolution from Semantic,
then verifies candidate provenance against the observed record and independently anchored facts fences. Passing
an absent route key to Semantic's ordinary source-filtering mode would discard imported candidates before this
verification. Deprecated display candidates are not current associations.

Decision: treat a selected Subject or target identity revision change during hydration as `changed`; retain the
VNDB confidence domain (0, 3], allowing zero only for explicitly supplied counts.

The immutable observation identity is SHA-256 of canonical JSON
`["vndb-classification-observation.v1", association, payload]`. The payload includes exact source alias, record,
association member, indicators, supplied counts, millisecond UTC `asOf`, attribution, licence and either an explicit
source revision or `{kind: "unversioned", digest}` for the permitted source payload. This provider digest is distinct
from the native immutable observation digest. CAS and idempotency keys are command input, outside that identity.
Only admitted fields are accepted. `classificationObservation` lets Imports compute the next digest before submission.

Both commands require explicit `expectedObservation` (`null` for no head) and an idempotency key. Current native
`source_statistic:write` Global authority is checked before every receipt lookup, including exact replay and retry.
The command also prepares the current Subject identity mapping and locks and checks the Subject's nonredirected
identity before receipt lookup. This applies to clear without requiring public association or Context disclosure.
Every changed payload requires matching CAS. Older observations conflict even with matching CAS; a different
equal-time observation or source rebinding requires the current digest. An identical immutable payload is already
satisfied. Clear retains a tombstone, preventing delayed observations from resurrecting a slot. A clear cannot
rebind a retained slot to another source record/member. Clear still works when the original association, Context,
provenance or source tuple is no longer publicly readable, using the existing governance/bulk authority alone.

Two Rating tables retain immutable observations and one exact current slot. They have no voter, question or native
aggregate keys and no dependency on the private native-ballot implementation. Neither enjoyment aggregation nor
classification ballots consume these observations. Reads compare current Semantic evidence, local head identity
and the source tuple fence before and after filling DTOs. Fence homes are independently anchored and released;
no command holds a foreign checkout or writes a foreign partition. DTOs label provider, source/member, observation,
source version, units, as-of, age and unavailable indicators. Unknown and concealed associations both return
`{state: "unavailable", reason: "not_found"}`; absence of a current observation uses `not_observed`. Typed missing
provenance/authority and changed-observation states carry no retained source payload.
Missing and cleared heads participate in final head equality too: a concurrent first publication or replacement
of a tombstone returns `changed`, rather than a stale `not_observed` result.

Lifecycle visibility is checked on every read and publication/replay, rather than copied into another projection.
The existing default worker already registers the Rating event catalogue, including
`com.rezics.rating.source_classification.changed.v1`; no aggregate drain or repair effect consumes it. Retraction,
Context withholding, qualifier changes and fences need no asynchronous removal or scan. A retained clear is the
bounded repair operation. An association never migrates by Subject merge, label equality or target redirect.

### Exact association read Cost

- Touches: `readExact` delegates to the supplied batch with one key: two Semantic observation passes, two anchored
  Rating head reads, and two anchored facts-fence passes for a nonempty published slot. Each Semantic pass includes
  distinct holder/target `resolveSubject`, one `readContext`, one `readRelease`, `currentRelationFacts` and a separate
  `candidateSources` probe, plus a supplied identity-mapping batch and an anchored item identity version for each
  distinct holder/target. Missing authority suppresses slot lookup; cleared/empty slots suppress fence reads.
- Bound: one supplied association, two head and observation primary-key probes per pass, at most one tuple per fence
  pass. The explicit lateral `LIMIT 1` paths bind the entire Rating primary key before reading payload bytes; each
  stored payload is capped at 8192 bytes. Nested Semantic/Access work retains its owners' bounds, including selected
  slot expansion/history and cold release loading; it is not counted as a single constant query.
- Growth check: focused native tests cover empty, denied, stale and current branches; strict physical plans and
  independent 256/1024/4096 growth of associations, observations and actor ballots remain integration work.

### Supplied association batch read Cost

- Touches: for N supplied keys, two Semantic passes over at most N Context/holder groups, N+1 distinct holder/target
  identities, N distinct releases and N Contexts; two Rating reads each return at most N heads/observations. Each
  Semantic pass additionally batches identity mappings and reads at most N+1 anchored item identity versions.
  Each fence pass deduplicates at most N tuples and issues one exact query and anchor per participating partition.
- Bound: N <= explicit limit <= 32. No refill, Subject classification inventory, vote query or source-history survey.
  Rating examines at most N selected heads and N selected observations per pass, with logarithmic B-tree positioning.
  Bytes include up to N capped payloads plus bounded association keys. Whole-operation costs additionally include
  two times all real Semantic/Access callees above, snapshot controls and cold release bytes. Those nested terms
  require Performance review before assigning a numeric whole-operation ceiling.
- Growth check: focused native tests enforce the supplied-key limit and empty branch; all-pool physical-prefix and
  runner measurements at the three independent growth scales are deferred to integration acceptance.

### Put observation Cost

- Touches: each Core attempt prepares native writer authority, one Semantic exact observation and one anchored tuple
  fence and current Subject identity mapping before receipt lookup; authorization locks one Subject and reads its
  item identity version even on replay. The body locks one source slot, reads one current observation, inserts at
  most one immutable observation, updates one head and emits one registered event/receipt. Replay skips mutations.
  After commit, exact-association disclosure runs the read operation above and compares the committed digest.
- Bound: one exact association/slot, payload <=8192 stored bytes, and one immutable insert per changed attempt.
  Concurrent writes serialize on the Subject/slot; CAS rejects a stale writer. Core's existing retry count multiplies
  attempt work, including native authority and anchors; final disclosure includes every exact-read dependency above.
- Growth check: focused native tests cover replay, independent receipt authority, stale CAS and competing writers.
  Native physical-work growth and uncertain-commit injection remain integration acceptance work.

### Clear observation Cost

- Touches: current native Global writer authority before receipt lookup, one locked Subject, one exact locked slot
  and current observation, at most one immutable tombstone insert, one head update, one registered event and receipt.
  Preparation reads the Subject identity mapping; authorization reads its item identity version before replay.
  Replay and identical tombstones add no new observation/event. There are no public Semantic or tuple-fence reads.
- Bound: one retained exact key per attempt; no candidate inventory, provider fetch, ballot touch or repair scan.
  Primary-key probes retain logarithmic positioning as unrelated histories grow; existing Core retries multiply
  the command/authority work. Clear payload contains only exact tuple/member, as-of and the literal clear marker.
- Growth check: focused native tests clear after Subject denial, Context denial and source fencing, and reject
  older resurrection. Three-scale all-pool physical work remains deferred to integration acceptance.

## Mounted source classification transport

The production Kernel installs `sourceClassificationRoutes` through `ratingRoutes`, using its real Pool,
Access and route key. `createSourceClassificationProducer` remains the only writer. No provider payload is
admitted by installing these routes. Imports must supply an admitted aggregate, explicit licence and attribution,
exact provider record/member identity, source version or payload digest, observation time and authentic current
Semantic association. Ordinary Kana association payloads do not imply counts or denominators.

Decision: use the existing Subject `:id` resource path with explicit `:read`, `:put` and `:clear` methods for
supplied-association reads and immutable CAS commands. Imports consumes them through the generated Eden client;
official client declaration emit for these routes stays on the compiler database.

Official root DTO aliases derive only from the actual mounted declarations. When those declarations lack the
transport, these aliases are `never`; the existing consumer retains its explicitly provisional compatibility seam.
That seam is not installed delivery. Once the publisher emits the mounted transport, the root uses it directly
without intersecting the provisional narrower mutation states. The sole declaration publisher must emit the
mounted route before Imports can receive official types. Source-side `SourceClassificationPutResult` and
`SourceClassificationClearResult` derive from the response schemas, preserving `published | cleared` for both.

`POST /v1/subjects/:id/source-classifications:read` takes `{ associations: [...] }` (zero through 32).
`SourceClassificationBatchInput` and `SourceClassificationBatch` are exported from `rating/register.ts`.
Items preserve supplied order. Available items include provider, exact association, observation digest/version,
source record/member, asOf, confidence and lie availability, optional explicitly supplied counts and provenance.
Empty input returns `{ items: [], actions: [] }` without calling the producer or inspecting authority.
Unknown or stale associations return unavailable items; no retained history or source-fence inspection is exposed.
Anonymous readers receive no importer actions. Current Global writers receive `put` and `clear` actions.
The response is private to the request (`Cache-Control: no-store`).

`POST /v1/subjects/:id/source-classifications:put` takes `SourceClassificationPutInput`: association,
value and required expectedObservation (digest or explicit null). It requires a structured Idempotency-Key.
It returns observationDigest, published state and current figure. `:clear` takes `SourceClassificationClearInput`
with the same CAS identity and a clear value, and returns observationDigest and cleared state. Both carry the
registered command session component. A conflict requires inspecting current state and making an explicit new
intent with that digest. An uncertain response retries the identical body and key; it does not create a new intent.

Example states for Web: a confidence observation has `confidence: { state: "available", value: 2.5,
unit: "vndb-tag-rating", minExclusive: 0, max: 3 }`; a lie-only observation has unavailable confidence with
reason `not_supplied`. A supplied zero lieCount remains zero, and an absent confidenceCount is omitted.
A cleared slot is unavailable with reason `not_observed`; a stale Semantic identity is `not_found`; a changed
selection is `changed`. Transport failures use the existing Problem response and preserve the original intent
for retry. These source observations remain separate from community classification ballots.

### Read transport Cost

- Touches: strict input validation and serialization, then two producer batch reads and current writer action
  checks, plus bearer reauthentication between selection and final checks. Each producer read includes two
  current Semantic/disclosure observations, two exact observation-head reads and two current source-fence reads.
  Each Semantic observation resolves selected Subject/target anchors, Context access/defaults, releases,
  current relation facts and candidate source references. All use their owning native adapters.
- Bound: 32 supplied identities, one Subject, 65,536 serialized input bytes; empty input performs zero producer
  or authority calls. Each selected relation/head uses the existing route and exact identity key. Duplicate
  supplied identities preserve output order. No classification inventory, history scan or cross-partition join.
  Response size is bounded by the admitted observation field limits and 32 supplied association identities.
- Growth check: focused mounted tests pin empty input, 32/33 validation and public current output. Independent
  native growth at 256/1024/4096, all-pool examined-work charging and physical-prefix plans remain continuation
  work; these structural bounds are not measured ceilings.

### Put transport Cost

- Touches: strict association/payload/byte validation and structured key parsing, one existing producer put,
  registered receipt/event/session handling and response serialization. The producer owns current writer
  authority before receipt lookup, exact slot CAS and current Semantic/source-fence checks/readback.
- Bound: one supplied association and one immutable observation intent; no additional writer or storage.
  Existing command retry limits multiply the underlying work. Invalid payloads reach no producer call.
- Growth check: focused mounted tests cover publication, exact retry, denial before replay, conflict and deliberate
  replacement. Native physical-prefix and race measurement remains continuation work.

### Clear transport Cost

- Touches: strict association/clear/byte validation and structured key parsing, one existing producer clear,
  registered receipt/event/session handling and serialization. The producer rechecks current writer authority
  before receipt lookup and locks only its exact Subject observation slot.
- Bound: one supplied association and explicit expected head; public Semantic disclosure is not required to
  clear a retained slot after concealment. No retained payload is returned by this route.
- Growth check: focused mounted tests clear an observation and verify anonymous reads cannot resurrect it.
  Native growth and current-authority race injection remain continuation work.

The continuing imported-observation journey retains independent native 256/1024/4096 growth, strict physical-prefix
plans and all-pool bytes/controls/runner charging. In particular, Semantic's expanded slot selection, retained
history, identity authority and cold/composed release loading need whole-operation bounds; the supplied-key cap
alone does not prove them. Current source-fence and identity preparation is released before command acquisition;
final publication/read disclosure remains separate from a commit-held foreign authority witness. Native race and
unknown-delivery outcomes, actual declaration publication and Imports/Web receiving remain integration obligations.

## Classification assessments

A classification association is the exact current Semantic statement, not its display label. The first native reader supports only disclosed Global associations whose released property is in the `classification` group and targets `skos:Concept`. Realm-local candidates are unavailable until their disclosure contract is adopted. Association identity binds the original candidate, release and revision, subject, target, Global context and qualifiers, including spoiler qualifiers. The actor home retains the association identifiers and a digest of that immutable binding, not a copied Semantic statement. Reads do not follow redirects. A replacement or redirected candidate stays unavailable until a native rebind policy exists. Source confidence, source voter counts and inferred source ballots never seed these native totals.

The mounted APIs are:

- `PUT /v1/subjects/{id}/classification-associations/{associationId}/assessment` with `{ "assessment": "support" | "oppose", "falsePositive": boolean }`.
- `DELETE /v1/subjects/{id}/classification-associations/{associationId}/assessment` withdraws the whole ballot.
- `GET /v1/subjects/{id}/classification-associations/{associationId}/assessment` reads only the authenticated person's slot.
- `GET /v1/subjects/{id}/classification-associations/{associationId}/aggregate` reads the privacy-qualified native aggregate.

Their mounted action labels are `classification_ballot:set`, `classification_ballot:read_own` and `classification_ballot:read_aggregate`.
One current slot belongs to the account and exact association. A set response contains `associationId`, `revision` and `delivery`. The own-state response contains `hasBallot`, `assessment`, `falsePositive`, `revision` and `pending`; `pending` compares only that person's slot revision with their retained target contribution. A changed write returns `delivery: "enqueued"`; an unchanged write returns `delivery: "unchanged"`. Neither response claims that the public aggregate has changed.

Below five eligible current ballots, the aggregate is `{ "associationId": "…", "state": "suppressed", "pending": "unknown" }` and includes no numeric count, fraction, voter identifier or ordering clue. At five or more, `state: "published"` includes support and oppose counts, an independent false-positive count, `supportFraction = supportCount / (supportCount + opposeCount)`, `asOf`, `generation` and `pending: "unknown"`. The fraction is defined only when support plus oppose has a denominator. The public pending state is unknown because an exact association-home read does not scan actor homes. Published values describe the last delivered target-home generation; current Semantic subject, target, association, spoiler and moderation disclosure gates apply on every own-state and aggregate read. Loss of current association disclosure hides the aggregate immediately without erasing private ballot provenance.

The default worker consumes the actor-home outbox with `projectBatch`, preserves source route, epoch and position, and applies each actor slot revision once at the association home. It subtracts the exact retained contribution before adding the next eligible contribution. Account suspension, reinstatement and tombstone events use the existing Access lifecycle producer; cleanup advances through indexed pages of at most 50 ballots per actor. A redirect or replacement never transfers a contribution. These totals are separate from `rating.vote`, rating figures, reaction counts, semantic acceptance and imported source statistics. Web owns the following subject classification reader/editor; this slice adds no second presentation owner.

Decision: support fraction is support divided by support plus oppose, false-positive flags count independently, public pending is unknown without an actor-home scan, own pending compares only the caller's slot revision with its retained contribution, changed writes say enqueued and unchanged writes say unchanged.

The source factory is `createClassificationBallotCommands({ pool, access, clock? })`, exported with the input and
mounted response schemas from `rating/register.ts`. Its `set`, `clear`, `readOwn` and `readAggregate` methods back
the existing Subject receiver. Client publication must derive methods and aliases from these mounted declarations.
The native source does not supply a replacement Client DTO or a second presentation.

Decision: the Subject receiver derives ballot methods and successful response types directly from the admitted
mounted Client declarations, retaining its existing runtime validation and unavailable fallbacks.

Decision: retain each represented actor partition as an aggregate source witness and return retryable unavailability
while its native relay checkpoint trails its current head, including unrelated pending work, rather than publish
potentially ineligible ballots during lifecycle cleanup.

Every accepted contribution revision advances the aggregate generation, including changes that leave numeric totals
unchanged. Each target transaction also retains that source partition's greatest native epoch/position. Aggregate
reads collect the exact aggregate and its source prefix twice. For each represented source, its current native epoch
must match the delivered epoch and its relay checkpoint must equal its current log head. The initial and final
collections must agree, including aggregate generation and source membership. Missing, moved, unavailable or changed
witnesses fail the read without a partial result. Cleanup remains bounded and asynchronous; its unfinished events
keep the source frontier behind the head. No currentness check enumerates voters or joins foreign partitions.
Both the point reader and the existing own-page aggregate receiver apply this same witness.

Own-state reads repeat the current account, actor lifecycle generation, exact private slot and actor-home witness
after reading delivery state. Both point readers repeat Semantic's current exact association and native Access
after payload selection. A visibility loss returns the same 404 as absence; a changed binding or witness returns a
retryable failure. An own slot whose retained binding already differs returns the ordinary 404, never a false empty slot. A visible mismatched binding cannot be edited or silently rebound. Withdrawing after lost
visibility still returns only 204 under the existing own-account rule.

The existing receiver can represent these responses without new UI:

```json
{ "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102", "revision": "2", "delivery": "enqueued" }
{ "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102", "hasBallot": true, "assessment": "oppose", "falsePositive": true, "revision": "2", "pending": true }
{ "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102", "state": "suppressed", "pending": "unknown" }
{ "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102", "state": "published", "supportCount": 3, "opposeCount": 2, "falsePositiveCount": 4, "supportFraction": 0.6, "asOf": "2026-11-03T23:00:00.000Z", "generation": "8", "pending": "unknown" }
```

A withheld association returns the ordinary `not_found` problem, with no retained state or aggregate. A dependency,
source backlog or changing witness returns the existing retryable unavailable problem and no count or new frontier.
Retry the original read. An uncertain command retains its original method, body, key, credentials and receipt
component; retry that exact command before separately refreshing current own state. An exact receipt replay returns
the original response only after current admission, even if a later command has changed the slot.

### Cost: set or change

- Touches: The existing own-account command runner prepares current Semantic association, Subject/target identity,
  released classification and native Access before actor checkout and receipt lookup. Its actor-home command reads
  current account admission, eligibility generation and one locked exact slot, then writes that slot, receipt and
  outbox. The registered relay reads source envelopes, locks one retained target contribution and aggregate, and
  writes the replacement contribution, source witness, generation and aggregate event in one target command.
- Bound: One exact slot and contribution per command; one source-prefix point upsert per accepted revision. Semantic
  performs two Subject and two target snapshots per preparation, including native authority, identity, release,
  selected slot and disclosure work. Shared command retries, account admission, receipt, log and transaction controls
  remain part of the bound; there is no synchronous voter enumeration or foreign write in the actor command.
- Growth check: Hold exact actors, homes and payloads fixed while independently growing unrelated ballots, selected
  revision/event history, Semantic identity/authority changes and relevant relay backlog at 256/1024/4096. Include
  every source/target pool, actual default runner phase, Access preparation/evaluation, control statement, physically
  examined row and raw/materialized/retained/serialized byte. Require exact primary-key prefixes, excluding invisible
  MVCC under the existing decision; returned rows and output limits alone do not establish examined-work ceilings.

### Cost: withdraw

- Touches: The same native preparation and own-account runner, current account and actor state, exact retained slot,
  receipt and changed outbox event. Target delivery subtracts the exact retained contribution and advances both slot
  witness and aggregate generation. Missing association visibility uses only the existing minimal own-account rule.
- Bound: One locked slot and at most one update/event, plus an activation cleanup event when needed. Each lifecycle
  page seeks the `(route, actor, eligibility generation, subject, association)` obligation prefix in index order,
  selects at most 51 obligations and updates at most 50 exact keys, emitting one ordered slot revision
  per update and a continuation event when another page remains. A visible binding mismatch fails before mutation.
- Growth check: Retain change-clear-change and exact uncertain-clear replay with a newer slot. Grow selected actor
  history and eligible cleanup obligations independently of unrelated actors at 256/1024/4096; capture all shared
  runner controls, preparations, physical prefixes and bytes, including every cleanup and target-delivery phase.

### Cost: read own state

- Touches: Two complete current Semantic association observations bracket the payload. Two released actor-home
  snapshots bind the native home, account, lifecycle generation and exact caller slot; one separately bound
  association-home snapshot reads only that caller's retained contribution. Every checkout is released before the next.
- Bound: Eleven snapshots on the retained-slot path, including eight inside the two Semantic observations; six native
  Access preparations and twelve evaluations within those observations, with their nested work charged separately.
  Three exact private payload points and two actor-state/account points per actor pass; no voter inventory. Operational
  failure returns no state. Own pending is a conservative comparison with one retained delivery revision.
- Growth check: Keep selected actor/association, homes and byte caps fixed while independently growing unrelated
  slots, selected contribution history and source/identity/authority changes at 256/1024/4096. Capture all nested pools,
  controls, physical rows and raw/materialized/retained/serialized bytes; require full supplied-key prefixes.

### Cost: read aggregate

- Touches: Two complete Semantic association/Access observations and two bound target snapshots. Each target pass
  reads the exact binding's aggregate and ordered source prefix. Each source pass separately binds its native home
  and reads its exact consumer checkpoint; no cross-partition SQL join or actor lookup participates.
- Bound: For P represented source partitions, ten plus 2P released snapshots, two aggregate points, two prefix reads
  of at most P source rows and 2P checkpoint points. P is at most the native partition address space of 4096,
  independent of voters and retained contribution history. Source tuples contain only partition, epoch and position;
  internal witnesses retain these and native home/checkpoint metadata, never voter identities. Public serialization
  has fixed scalar fields and no source vector. Semantic release/authority raw and materialized bytes are additionally
  charged; no fitted whole-operation byte ceiling is inferred from these structural limits.
- Growth check: Keep represented homes, selected keys, ballot cardinality and admitted byte caps fixed while growing
  unrelated rows, selected retained history, authority/identity changes and relevant repair backlog independently at
  256/1024/4096. Attribute both target collections, every source pool, native runner/control and Access phase and all
  physical/raw/materialized/retained/serialized work before setting numerical ceilings. Require the exact
  route+subject+association+binding prefix and checkpoint primary key; no output-count proxy proves physical bounds.

### Cost: read own classification assessments

- Touches: The existing account-bound raw selection, optional selected key, exact-slot verification, current Semantic
  association/summary composition and caller contribution batch. Each admitted aggregate also uses the shared
  two-pass target/source observation described in Cost: read aggregate; final verification occurs before return.
- Bound: At most 20 raw entries and one selected slot; no voter enumeration or request-time count. For A admitted
  aggregates, A <= 21, charge each aggregate's two target prefixes and two passes over its represented source homes,
  in addition to the page's existing account, summary and Semantic observations. Any nested failure returns no page
  or refreshed cursor, preserving the exact input frontier.
- Growth check: Keep selected keys, represented homes, raw cardinality and byte caps fixed while independently
  growing unrelated slots, selected history, authority changes and repair backlogs at 256/1024/4096. Include the
  shared aggregate witness in all-pool physical-prefix, controls, preparations/evaluations and byte measurements.

### Return to classification assessments

`GET /v1/me/classification-assessments` returns only the authenticated account's current retained classification slots.
The cursor is sealed to the acting account, client, current delegator, authentication epoch, sorted effective scopes,
actor lifecycle generation, selected exact slot and raw `(subject, association)` order; its signed epoch is the
observed native account-home epoch. A moved or changed home makes continuation unavailable or stale instead of an
empty page. Each response selects at most 20 raw slots. `selectedSubjectId` and
`selectedAssociationId` may independently promote one exact owned slot; the selected key is excluded from the raw
page so it appears once in a traversal. The response says `complete: false` for lifetime coverage: withdrawn,
superseded and removed inventory is not reconstructed. `traversal` and `next` describe only the current retained
generation.

The association identity includes its current Semantic candidate, slot, property, Global Context, release, revision,
statement digest and qualifier digest. The page exposes current Work and Concept summaries only while the exact
association and both identities remain readable. If visibility is gone, a retained own slot has no old label,
qualifier or destination; only the existing own-account withdrawal may remain. The `set` and `clear` links carry the
slot revision as `expectedRevision`. A stale link returns 409; clients refresh the page before trying again. These
links describe current advice only. The mounted commands repeat current authorization and keep their receipt/replay
rules.

Decision: When current Semantic disclosure is absent, return a retained own slot without labels, qualifiers,
destinations or aggregate only when the existing own-account clear action is available; otherwise omit it while
advancing the raw continuation.

Decision: A readable association whose current binding differs from the retained slot uses the existing withheld
item with no clear link, so the page does not promise a withdrawal the native clear precondition will refuse.

Native classification counts use the existing five-ballot suppression rule. The provider's confidence and lie flag
remain source data from `POST /v1/subjects/:id/source-classifications:read`; this page returns no source figure and
never combines it with native counts.

Populated response:

```json
{
  "viewer": { "accountId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702001" },
  "inventory": {
    "kind": "current-retained",
    "complete": false,
    "generation": "1",
    "cleanup": "settled"
  },
  "items": [
    {
      "state": "available",
      "subjectId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702101",
      "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102",
      "subject": {
        "id": "019a1b2c-3d4e-7f00-8a00-5ab1ec702101",
        "type": "schema:Book",
        "label": "Example book",
        "href": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702101"
      },
      "target": {
        "id": "019a1b2c-3d4e-7f00-8a00-5ab1ec702103",
        "type": "skos:Concept",
        "label": "Mystery",
        "href": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702103"
      },
      "association": {
        "subjectId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702101",
        "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102",
        "slotId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702104",
        "property": "schema:keywords",
        "targetId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702103",
        "contextId": "00000000-0000-8000-8000-000000000000",
        "origin": "global",
        "release": "example-release-digest",
        "revision": 3,
        "bindingHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "statementDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "qualifiersDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      },
      "own": {
        "assessment": "support",
        "falsePositive": true,
        "revision": "1",
        "pending": "pending"
      },
      "aggregate": {
        "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102",
        "state": "suppressed",
        "pending": "unknown"
      },
      "actions": {
        "state": "editable",
        "readback": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702101/classification-associations/019a1b2c-3d4e-7f00-8a00-5ab1ec702102/assessment",
        "set": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702101/classification-associations/019a1b2c-3d4e-7f00-8a00-5ab1ec702102/assessment?expectedRevision=1",
        "clear": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702101/classification-associations/019a1b2c-3d4e-7f00-8a00-5ab1ec702102/assessment?expectedRevision=1"
      }
    }
  ],
  "traversal": "complete",
  "next": null
}
```

An empty current inventory has the same viewer and retention fields with `items: []`, `traversal: "complete"` and
`next: null`. If association visibility is lost but the current own-account rule still permits withdrawal, the retained
slot is minimal:

```json
{
  "state": "withheld",
  "subjectId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702101",
  "associationId": "019a1b2c-3d4e-7f00-8a00-5ab1ec702102",
  "subject": null,
  "target": null,
  "association": null,
  "own": {
    "assessment": "support",
    "falsePositive": true,
    "revision": "1",
    "pending": "unknown"
  },
  "aggregate": null,
  "actions": {
    "state": "withdraw-only",
    "readback": null,
    "set": null,
    "clear": "/v1/subjects/019a1b2c-3d4e-7f00-8a00-5ab1ec702101/classification-associations/019a1b2c-3d4e-7f00-8a00-5ab1ec702102/assessment?expectedRevision=1"
  }
}
```

Signed-out and revoked callers receive distinct current authorization errors; completed withdrawal is `204 No Content`.
The retryable dependency failure returns no partial page or replacement cursor, so the caller retries the same frontier.

```json
{ "type": "https://rezics.com/problems/authentication_required", "title": "Authentication Required", "status": 401, "code": "authentication_required", "retryable": false, "effect_status": "not_applicable", "request_id": "request-id" }
{ "type": "https://rezics.com/problems/forbidden", "title": "Forbidden", "status": 403, "code": "forbidden", "retryable": false, "effect_status": "not_applicable", "request_id": "request-id" }
{ "type": "https://rezics.com/problems/partition_unavailable", "title": "Partition Unavailable", "status": 503, "code": "partition_unavailable", "retryable": true, "effect_status": "not_applicable", "request_id": "request-id" }
```

### Cost: own classification page

- Touches: Three released account-home snapshots verify the active account and actor lifecycle row. The current partial ballot index selects at most 21 raw keys; the optional selected key uses one primary-key lookup, and final actor-home verification probes at most 21 supplied keys. Current Semantic association reads are grouped by subject home and capped at 21 identities; at most 84 exact resolutions cover initial own disclosure, current set advice, aggregate advice and final own disclosure. Current summaries batch at most 42 supplied Subject ids by represented home. Native contribution reads use supplied-key joins capped at 21 identities per represented association home. Each admitted aggregate uses the two-pass source witness described in Cost: read aggregate; at most 21 selected aggregates participate.
- Bound: Raw slots stay fixed at 20 plus one continuation sentinel; one selected slot may be promoted separately. The response has at most 21 entries, at most 42 compact summaries, labels at most 2,000 characters and a 1 MiB serialized body ceiling. Cursor length remains 4,096. No actor, subject, association-history or voter scan runs on the page request. Any unavailable nested read fails the whole request and preserves the caller's cursor frontier.
- Growth check: `test/rating/own-classification-journey.test.ts` uses production Kernel and real Access while independently growing unrelated ballots, associations, identity revisions and authority history at 256/1024/4096. The measured native prefixes, all participating SQL, backend, row and block evidence are asserted alongside empty/ready pages, selected promotion, sparse continuation, binding mismatch, read-only, withdraw-only preparation and same-key replay.
