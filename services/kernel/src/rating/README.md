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

A vote keeps the target it was cast on. When two subjects merge, a person who voted on both counts once on the
survivor: their vote on the survivor wins, an explicit clear included; otherwise their vote on the merged subject
counts. Aggregates are recomputed from votes, never from stored means. An unmerge returns every vote to its own
target, and a vote cast on the merged group meanwhile waits for its author to assign it; one vote never becomes two.

A **population** is a set of people whose votes an aggregate counts: Global (every eligible account) or one Realm
(its current members). A population is a segment of one measurement, not a separate measurement: the same vote
counts in Global and in every Realm whose population includes the voter. A person never votes again to be counted
in a Realm, and nothing has to choose which of a person's Realms their vote "belongs to".

A Realm that wants a different question (for example a translation-quality score) defines its own question. Its
votes are separate because its question is separate, and it is always displayed under its own label.

## Aggregates

An aggregate is kept per (question, population, target) as additive components: count, sum and a histogram over the
scale's units. Means, Bayesian scores and roll-ups are computed from components and never stored as inputs.

- A vote, change or clear updates the Global aggregate and the aggregate of each Realm whose population includes the
  voter, asynchronously and idempotently, by subtracting the previous value and adding the new one. The number of
  Realms a person's votes count in is capped, which bounds the work of one vote.
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

## Thresholds and privacy

A mean is published from 5 votes on a work or release and from 10 on a finer grain (episode, character
appearance). Below that, only the count and how many more votes reveal the score are shown. A population below the
threshold also hides its histogram, so a small Realm never reveals its members' individual votes. Ranked lists use a
Bayesian weighted score whose prior comes from the same question and population, from at least 50 votes.

A person's own vote is private to them unless they publish it with a review or on their public profile. It counts,
anonymously, in the aggregates of the populations they belong to: an aggregate at or above the threshold reveals no
individual vote, and a person who does not want to be counted clears the vote. Votes of suspended or banned
accounts, and of members a Realm has removed, leave the affected aggregates.

## Display

Every score is shown with its population and its count ("8.4 · 1,203 ratings on REZICS", "8.9 · 64 ratings in
Realm Name"). The rules are the same on every surface:

- **Headline.** The general site shows the Global population. A Realm-routed page or Zone shows that Realm's
  population and says so in one line, with Global next to it.
- **Several Realms.** Beside the distribution, the page lists the viewer's Realms, taken from their memberships
  rather than from which aggregates exist, each with its own figure and count ("No ratings yet" when it has none),
  ordered by count; the first three are shown and a picker pages through the rest and through every other
  population that rated the target. Figures from different populations are never averaged, blended into a
  personal number, or substituted for one another when one is missing.
- **Cards.** A subject card (search, shelves, feeds) shows the headline population's figure for the site it is on,
  with a population mark whenever it is not Global. A reader may pin which of their Realms is listed first on
  subject pages; that preference never replaces the headline population on a page or a card.
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

## Reviews

A review is a content item about one target. It may cite the author's vote on that target; a review never requires a
score, and a score never requires a review. A cited vote is cited at the revision the author had when writing, so
changing a vote later never rewrites an old review; the review shows the current vote beside it when they differ.

## HTTP

All rating HTTP routes require an authenticated account with the `rating:vote` action. Vote reads are private to the
authenticated account; the target and question identify a vote but never select its owner.

- `PUT /v1/subjects/{subjectId}/ratings/{questionId}/vote` accepts the strict JSON body `{ "units": integer }` and
  requires an `Idempotency-Key`. It returns `{ "units", "revision", "at" }` for the caller's current vote.
- `DELETE` on the same path also requires an `Idempotency-Key`, writes a tombstone for a cleared vote, and returns
  `204 No Content`.
- `GET` on the same path returns `{ "units", "revision", "at" }` for the caller's current vote. It returns `404`
  when no current vote exists, including after a clear.
- `GET /v1/rating-questions/{questionId}` returns `{ "id", "revision", "label", "grain", "scale" }`, where
  `scale` contains integer `min`, `max` and `displayStep` values in stored units. The standard question therefore has
  a scale of `0` through `20` in steps of `1`; its display maps two stored units to one point on the `0` through `10`
  scale.

Vote request bodies reject unknown fields and non-integer values. The question scale carries the units used by vote
requests, so vote routes do not accept or return floating-point vote values. Errors use RFC 9457 problem responses.
