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
reads use current Global `definitions:read`, including its native anonymous public floor and authenticated denials.

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
  current stored-unit metadata as the point route. UUID identity ascending is the only ordering. The primary-key
  seek consumes at most `limit` entries and probes one unconsumed lookahead; the signed continuation starts after
  the last consumed key. Every page rechecks Global authority before reading question rows. Denial preserves the
  point route's `404`; unavailable authority or data reads retain ordinary problem responses, never empty choices.
  The cursor binds the directory operation, limit and native viewer/credential authority, with the existing
  4,096-character cap and 15-minute expiry. Expired or mismatched tokens return `invalid_cursor`.
  Unknown, repeated and invalid query fields are rejected. There are no text, grain or selected-id filters, totals,
  votes or population statistics. Clients request each page explicitly.
  Choices are metadata, not feed membership, candidate eligibility or Source readiness. The cursor retains only
  a position and does not freeze question revisions or hydrate entries. Selected identity can be refreshed through
  the unchanged point route; separate requests do not certify a shared snapshot. This installed directory adds no
  feed predicate, Source, Home consumer or generated client declarations.

  Operation Cost:
  - **Touches:** one metadata page through `rating.question_pkey (id)`, plus the existing Global authority probes.
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
- `GET /v1/subjects/{id}/source-statistics` is public under the subject's read rules. It returns each imported source
  statistic with its source, source record id, source scale, mean, count, as-of date, licence and attribution.
- `PUT /v1/subjects/{id}/source-statistics/{source}` replaces that source's statistic using a strict JSON body
  containing the source record id, scale, mean, count, as-of date, licence and attribution. It requires an
  `Idempotency-Key` and `source_statistic:write` on Global Context, held by the importer governance role.
- `POST /v1/subjects/{id}/source-statistics/{source}:clear` accepts only
  `{ "sourceRecordId", "count": 0, "asOf", "sourceAlias"?: string }` and returns `204 No Content`. It uses the same Global Context writer
  authority, personal-library gate and idempotency rules as `PUT`. The zero is authoritative for that exact source
  record binding: it removes a matching stale statistic, while an absent or different binding is an idempotent no-op.
  Missing counts and partial averages are unknown and never clear a row. A clear can remove a row after its imported
  facts tuple has been fenced; it does not alter votes or published figures.

Both positive PUT and clear accept optional `sourceAlias`, using the source-fence identifier grammar
(`^[a-z][a-z0-9_-]{0,31}$`, at most 32 ASCII bytes). Omission and explicit provider id (`vndb`) bind the
provider tuple and preserve legacy request digests and response shapes. A custom alias participates in request
identity and appears as optional `sourceAlias` in GET/PUT responses. The effective alias is persisted on the one
current `(route, subject, provider)` slot; changing aliases replaces that slot rather than adding a statistic.
Clear removes only a matching provider, effective alias and record id, including after rebind or subject merge.
A stale or absent binding is a receipt-backed no-op with no change event. No as-of ordering is imposed.

Imported source statistics are disclosed only while their exact `(effective alias, sourceRecordId, facts)` tuple remains
current. A facts takedown hides the matching row from public lists and blocks later publication for that tuple.
Summary and cover fences are independent. The tuple home is read through its own anchored snapshot before writes and
again at final disclosure; an unavailable tuple home fails closed. Clearing is an exact selected-subject partition
command and never consults or removes another tuple.

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
including rollback and repoint, then atomically hand a retained Rating repair obligation to the native page receipt.
That obligation must cover later identity changes and concurrent vote creation beyond the captured upper key; it
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
| Source-statistic GET, PUT and clear | GET returns at most one row for the supported `vndb` source, checks its exact facts tuple in two independently anchored tuple-home snapshots, rereads the local binding, and rechecks the current subject before serialization. PUT checks that tuple before its subject-partition upsert and at final disclosure. Clear deletes only one row matching `(route, subject_id, source, source_alias, source_record_id)` and emits the existing change event only when that row changes. | Rows, statements and effect events are constant: at most one source-statistic row per subject/source, one changed row/event per command, and one facts-fence row per tuple snapshot. Index blocks grow logarithmically with source-statistic, receipt and tuple-fence histories. Every nested query and physical occurrence is included in the lifecycle growth capture.                                                                              | `test/rating/growth-source-statistic-lifecycle.test.ts`: `source statistic GET, PUT and authoritative zero clear stay bounded as row and tuple histories grow`; `test/rating/growth-figures-statistics.test.ts`: `Source statistic writes and reads stay within their bound as statistics grow`  |
| Own-vote and question GET reads     | Each command and mounted GET reads the account by primary key, then seeks one vote by `(route, voter_id, question_id, target_id)` or one question by primary key.                                                                                                                                                                                                                                                                                                                    | Rows and statements are constant per read (two point reads); index blocks grow logarithmically with vote history.                                                                                                                                                                                                                                                                                                                                     | `test/rating/growth-figures-statistics.test.ts`: `Own vote and question reads stay within their bound as votes grow`                                                                                                                                                                             |

Page sizes bound each workflow step independently: segment and eligibility pages process at most 100 votes, merge pages at most 100 voters, and figure drain/republish work is admitted in pages of at most 500 figures. Total affected work grows with page count and affected keys; a page bound does not bound the complete workflow.
