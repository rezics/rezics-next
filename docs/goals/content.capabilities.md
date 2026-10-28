# Content capability acceptance

This manifest covers the content-owned rows of [public scope](../scope.md) and the outcomes of
[content and communities](content.md). Product rules remain with the
[content](../../services/kernel/src/content/README.md),
[community](../../services/kernel/src/community/README.md) and
[rating](../../services/kernel/src/rating/README.md) owners. The
[acceptance gap report](../research/api-acceptance-gaps.md) supplies fixture contract names and the missing user cases.

Stages, in order, are **specified red**, **driver registered**, **implementation exposed**,
**user-case acceptance passed**, and **promoted**. A registered native wrapper proves a binding exists; it does not
establish a passing run or promotion. No passing revision or promotion evidence is claimed here. A capability with
missing composed acceptance stays specified red even when its supporting APIs and bound suites exist.

The shared `ratings/content` fixture is
[content-user-cases.json](../../specs/fixtures/content-user-cases.json). It contains logical names, controlled titles,
standard-question work targets, distinct-controller voters, fifty real Global prior votes, an extreme private Realm
population, unpublished/ineligible votes, vote-citing reviews and paged discussions. Names map to HTTP-created IDs
at runtime. The same person's vote counts in Global and each eligible Realm: the private Realm control changes
membership, not the Global vote population. No fixture seeds votes, reviews, threads, aggregates or figures.

The new [suite](../../specs/content-user-cases-outcomes.test.ts) and
[driver contract](../../specs/content-user-cases-driver.ts) require an isolated migrated native kernel, real HTTP
through production `createKernel.handle`, native Auth and Access, and production command, effect and relay
boundaries. API responses alone supply assertions. Timing barriers never implement policy or redact results.

## threads-and-boards

Scope row: **Posts, threads and boards**. Stage: **specified red** for the complete capability.

User job: readers, authors and moderators create, read, page and revise threads, posts, replies and immutable
revisions on boards, with current disclosure, licences, references and media claims.

Personas: anonymous, author, Realm member, outsider and moderator. Fixtures: `ratings/content` for paged discussions
and deterministic revocation; the bound thread/disclosure/media suites retain their own native fixtures. Media
claims are covered here, including uploader identity, parent disclosure and lifecycle.

| Surface cell             | Scope and scenarios                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue                | In: the subject's discussion list, `test/content/subject-threads-http.test.ts`; bound thread/disclosure scenarios and `late-board-revocation` subject-thread reads.   |
| Curated                  | Out: threads are not catalogue subjects or Collection members.                                                                                                        |
| Everything without state | Out: threads are not catalogue subjects or Collection members.                                                                                                        |
| Own state                | In: author activity thread/reply reads, including current disclosure and `late-board-revocation` author-activity reads. This is authored activity, not library state. |
| Mounted Zone             | Out: a Zone mounts saved scopes and Collections, not boards, under public scope.                                                                                      |
| TypeList                 | Out: threads are not catalogue subjects or Collection members.                                                                                                        |

Scenarios and evidence on this base:

- `content-thread-outcomes`, `content-disclosure-outcomes` and `content-media-outcomes` are bound by native wrappers
  under `services/kernel/test/content/`; stage **driver registered**. These retain their frozen scenarios and fixture
  rules without duplication.
- Board pages by sort (`hot`, `active`, `newest`) have native HTTP coverage in `boards-http`, `board-ranking-http`
  and `board-hot-http`; stage **implementation exposed**. Author activity reads have native `author-item-reads` and
  `author-item-public-views` coverage; stage **implementation exposed**.
- `late-board-revocation`: take the board down or revoke its protected read grant after the board check for thread,
  post head, exact revision, subject-thread and author-activity reads. Final output must disclose no now-ineligible
  item, summary, count, source or cursor material. Stage **specified red**; the deterministic composed binding for
  these point reads is not established on this base.
- `late-board-revocation-pages`: the new suite declares literal cases for hot, active and newest board first and
  continuation pages, and thread post first and continuation pages. Each has a late board takedown, late protected
  read-grant revocation, and unchanged public and protected positive controls. Stage **specified red**; no user-cases driver is registered.

Native acceptance commands, from the repository root:

```sh
bun run --cwd services/kernel check test/content/thread-outcomes.test.ts test/content/disclosure-outcomes.test.ts test/content/media-outcomes.test.ts test/content/subject-threads-http.test.ts test/content/boards-http.test.ts test/content/board-ranking-http.test.ts test/content/board-hot-http.test.ts test/content/author-item-reads.test.ts test/content/author-item-public-views.test.ts
CONTENT_USER_CASES_DRIVER=/absolute/path/to/native-driver.ts bun test specs/content-user-cases-outcomes.test.ts --test-name-pattern late-board-revocation-pages
```

The second command requires the future real binding. Neither existing board sort tests nor the missing-driver
verifier establish the late point-read or page outcomes.

## realms-and-spaces

Scope row: **Realms and Spaces**. Stage: **specified red** for the complete capability.

User job: community creators and managers create and revise Spaces and Realms, publish subjects, manage membership
and boards, and enforce protected admission and participation immediately when someone is banned.

Personas: anonymous, creator, manager, moderator, Realm member, banned member and outsider, including a banned
member with an independent read grant. Fixtures: the bound community suite's native Space/Realm fixtures and the
`ratings/content` protected Realm/board personas for shared content reads. The ban barrier additionally needs a
member with no independent read grant and a separate independent-grant control.

| Surface cell             | Scope and scenarios                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue                | In: Realm subject publications through `community-outcomes`; `protected-ban-barrier` protects community-owned reads and admission. |
| Curated                  | Out: Collection curation is owned by commerce; Realm publication does not define Collection membership.                            |
| Everything without state | Out: library support unions are owned by commerce, not Realm membership.                                                           |
| Own state                | Out: personal library state and inbox delivery are separate capabilities; Realm membership is community authority.                 |
| Mounted Zone             | Out: Zone mount composition is owned by semantic; a Realm is not a mounted Collection.                                             |
| TypeList                 | Out: configured subject lists are owned by semantic; Realm membership/publication is not a TypeList.                               |

Scenarios:

- `community-outcomes` is bound by `services/kernel/test/community/community-outcomes.test.ts`; stage
  **driver registered**.
- `protected-ban-barrier`: a ban denies protected reads, participation and admission from its authoritative T,
  before removal work settles. A ban beats any independent read grant. Exercise both independent-grant and
  no-independent-grant fixtures, with unrelated public reads as controls. Stage **specified red**: the required
  native file `test/community/ban-protected-http.test.ts` is absent on this base; this manifest does not claim it runs.

Native acceptance commands:

```sh
bun run --cwd services/kernel check test/community/community-outcomes.test.ts
bun run --cwd services/kernel check test/community/ban-protected-http.test.ts
```

The second command names the required future barrier acceptance, not an existing passing check.

## ratings-and-reviews

Scope row: **Ratings and reviews**. Stage: **specified red** for the complete capability.

User job: readers privately rate a subject and publish a review that may cite their vote, then understand honest
public figures on subject pages and search cards without leaking anyone's vote or private Realm context.

Personas: anonymous, reader/review author, other independent voters, outsider, private Realm member and moderator;
include an account whose vote becomes ineligible while delivery is paused. Fixtures: `ratings/content`, using the
released standard question, five-vote work threshold, fifty real Global prior votes, ten extreme private Realm voters,
unpublished votes, paged reviews, a different subject target, draft/protected/taken-down posts and two licences.

| Surface cell             | Scope and scenarios                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue                | In: subject page figures and search cards, `subject-rating-context`; subject review list and continuations, `review-from-vote`.        |
| Curated                  | Out: search owns rating sort and the public aggregate is its only rating input; no new Collection sorting contract is introduced here. |
| Everything without state | Out: search owns rating sort and its only rating input is the public aggregate.                                                        |
| Own state                | In: the reader's private vote, tested by `subject-rating-context` and by vote changes in `review-from-vote`.                           |
| Mounted Zone             | Out: search owns rating sort and the public aggregate is its only input; Zone composition is owned by semantic.                        |
| TypeList                 | Out: search owns rating sort and the public aggregate is its only rating input; configured TypeLists stay with semantic.               |

Scenarios:

- Existing native vote and aggregate cases in `test/rating/vote-http.test.ts` and `test/rating/aggregate-http.test.ts`
  remain the producer acceptance; stage **implementation exposed**. They are reused, not duplicated.
- `review-from-vote`, stage **specified red**, has three literal cases in the new suite: PUT vote then POST review
  and change vote while anonymous reads all relay continuations; publication-time citation survives vote changes;
  hidden/protected posts stay out while immutable revisions and licences survive. All writes use the existing content
  DTO, including `kind`, `subjectIds` and `voteCitation` with question, integer units and vote revision.
- `subject-rating-context`, stage **specified red**, has four literal cases: subject page/search card agree on
  standard question, Global population, units and count with a real prior; below-threshold/pending/ineligible votes
  give honest insufficient-data/updating without a number; only the authenticated caller obtains their own vote; an extreme private
  Realm population never substitutes for or moves Global, and unreadable Realm figures return 200 with zero count
  and neutral freshness, indistinguishable from an empty population. Native vote, aggregate, prior and figure workers produce
  every figure. Numeric count remains allowed below threshold; mean and score do not.

Native acceptance commands:

```sh
bun run --cwd services/kernel check test/rating/vote-http.test.ts test/rating/aggregate-http.test.ts
CONTENT_USER_CASES_DRIVER=/absolute/path/to/native-driver.ts bun test specs/content-user-cases-outcomes.test.ts --test-name-pattern 'review-from-vote|subject-rating-context'
```

The second command awaits a real registered binding. Realm rating sorts remain deferred. Private Realm votes are
not a separate copy of Global votes; changing only membership is the discriminating isolation control.

## User-case contract audit

This audit uses [OpenAPI](../../contracts/openapi.json) operation schemas and the owning README sections below.
Success codes are exact; errors remain the original RFC 9457 response. Unwrapping an envelope or renaming a list
array does not permit adding response fields. Request paths and fixture IDs may supply request inputs only.

| Driver methods                  | Landed HTTP contract and source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `putVote`, `ownVote`            | `rating.vote_put/get`: PUT/GET `/v1/subjects/{id}/ratings/{questionId}/vote`, PUT body `{ units }`, 200 `{ units, revision, at }`. GET selects the authenticated caller, with 401 for anonymous and 404 for the fixture outsider with no vote. [Rating, HTTP](../../services/kernel/src/rating/README.md#http).                                                                                                                                                                                                                                                        |
| `createThread`                  | `thread.create`: POST `/v1/threads`, 201 `{ thread }`; request `boardId`, `title`, `kind`, `subjectIds`, `body`, `licence`, `visibility`, optional `voteCitation`. Review kind and citation are already landed, including immutable publication-time units/revision. [Content, Reviews](../../services/kernel/src/content/README.md#reviews).                                                                                                                                                                                                                          |
| `createPost`, `revise`          | `post.create/revise`: POST `/v1/threads/{id}/posts` (201 `{ post }`) and `/v1/posts/{id}/revisions` (200 `{ post }`). Send body/licence; thread/post IDs select the path, and omitted metadata is preserved. OpenAPI request/response schemas; [Content](../../services/kernel/src/content/README.md).                                                                                                                                                                                                                                                                 |
| `readPost`, `readRevision`      | `post.get/revision`: GET `/v1/posts/{id}` or `/v1/posts/{id}/revisions/{revisionId}`, 200 `{ post }`. Returned id, threadId, revisionId, boardId, subjectIds, licence, body and voteCitation supply the asserted Post subset. Unreadable draft/protected/taken-down posts and exact revisions stay 404. [Content, Subject threads](../../services/kernel/src/content/README.md#subject-threads).                                                                                                                                                                       |
| `subjectReviews`                | `subject_threads.list`: GET `/v1/subjects/{id}/threads?place=&kind=review&limit=&cursor=`, 200 `{ threads, next }`; map threads to items, preserve next. Current target/place/disclosure filtering, relays and replay remain required. [Content, Subject threads](../../services/kernel/src/content/README.md#subject-threads).                                                                                                                                                                                                                                        |
| `realmFigure`                   | `rating.aggregate_get`: GET `/v1/subjects/{id}/ratings?question=&population=`, 200 `{ subject, question, figures }`; unwrap one entry with population, count, freshness and optional mean/histogram/remaining. Mean is stored units, so ten votes of 20 produce mean 20, not 10. No score or readiness state is returned. [Rating, HTTP](../../services/kernel/src/rating/README.md#http).                                                                                                                                                                             |
| `joinPrivateRealm`              | `realm.add_member`: POST `/v1/realms/{realmId}/members`, `{ accountId }`, 202 `{ workflowId }`, then native drain. The same vote counts in both populations; membership alone cannot change Global. [Community, Durable initiators](../../services/kernel/src/community/README.md#durable-initiators), [Rating, Voter Realm membership](../../services/kernel/src/rating/README.md#voter-realm-membership).                                                                                                                                                            |
| `suspend`                       | `account.suspend`: POST `/v1/accounts/{accountId}:suspend`, `{ reason }`, 200 `{ suspension }`. Provision platform governance authority separately from Realm moderation; drain the native eligibility transition. [Access, suspension policy](../../services/kernel/src/access/README.md), [Rating, Voter eligibility](../../services/kernel/src/rating/README.md#voter-eligibility).                                                                                                                                                                                 |
| `createBoard`                   | `board.create`: POST `/v1/realms/{realmId}/boards`, `{ conceptId, title, purpose: discussion, visibility }`, 201 `{ board }`; fixture provides a real Realm and its scheme/concept. [Community, board scheme](../../services/kernel/src/community/README.md), OpenAPI. Global review-board provisioning has the gap below.                                                                                                                                                                                                                                             |
| `takedown`, `revokeBoardRead`   | `board.takedown/post.takedown`: POST `/v1/boards/{id}:takeDown` or `/v1/posts/{id}:takeDown`, `{ reason }`, 200. `grant.revoke`: POST `/v1/grants:revoke`, exact resource/subject/actions/valid grant tuple, 200 `{ grant }`. Fixture grants must cover board and post takedown independently, and the protected reader must have no alternative board-read grant. [Content, Subject threads](../../services/kernel/src/content/README.md#subject-threads), [Access, Grant create/change/revoke](../../services/kernel/src/access/README.md#grant-createchangerevoke). |
| `page`, `holdPage`              | `board_threads.list` / `post.list`: GET `/v1/boards/{id}/threads?sort=&limit=&cursor=` or `/v1/threads/{id}/posts?limit=&cursor=`, 200 `{ threads, next, rankRefreshedAt }` or `{ posts, next, reactionsAsOf }`. Preserve metadata; map the array to items. All literal sort/post, first/continuation, takedown/grant and unchanged-control scenarios stay intact. `holdPage` remains a timing-only native test barrier; its implementation belongs to the binding.                                                                                                    |
| `provision`, `effects`, `close` | Isolated native test lifecycle, not public endpoints. Subjects/Realms/boards use production creation APIs; accounts/grants and delivery controls are permitted fixture setup. Effects drain/replay production events and workers; cleanup joins held requests. No manufactured votes, figures or relay rows. Global boards remain a provisioning gap below.                                                                                                                                                                                                            |
| `subjectFigure`, `searchCard`   | The subject consumer is GET `/v1/subjects/{id}/figure` (`rating.figure_get`), 200 `{ figure }` with the named `PublicFigure` DTO. `subject.get` stays without a figure: its ETag follows the subject head revision, so frequently changing figures stay outside it. POST `/v1/subjects:search` (`subject.search`) still needs the same DTO on search hits. [Rating, HTTP](../../services/kernel/src/rating/README.md#http).                                                                                                                                            |

The suite composes vote target/question identifiers from its own request arguments solely for citations; the driver's
Vote contains only units, revision and at. Citation comparisons and own-vote comparisons therefore use different
shapes. Anonymous and outsider Realm reads assert the original envelope and exactly `{ population, count: 0, freshness: { asOf: null,
updating: false } }` at 200, with no mean, histogram, remaining, score or actual update state. This is the neutral
empty figure specified by Rating HTTP, not evidence about the hidden population. Moderator aggregate assertions,
unchanged Global figures and absence of private Realm IDs from both public consumers remain intact.

The remaining rating expectations keep the [public figure](../../services/kernel/src/rating/README.md#public-figure)
contract: five work votes reveal display mean 4 for stored units 8; fifty real prior votes of stored units 12 yield
a Bayesian score strictly between 4 and 6. Fifteen votes (five at 8, ten at 20) yield display mean 8. Four eligible
votes disclose count but no mean/score; paused delivery never fabricates a published number; suspension removes
ineligible votes on drain. Public figures and aggregate HTTP means use different units and must not be substituted.
Fixture counts, independent controllers, document bodies, licences, page sizes, cursor progress/uniqueness and
replay checks remain unchanged. No literal scenario or title is removed.

Missing product behaviours retained by this suite:

- **Rating and semantic/presentation:** the subject figure consumer is GET `/v1/subjects/{id}/figure`, with
  standard-question Global identifiers, the question's stored-unit scale, count, published display mean/Bayesian
  score and explicit `ready` / `insufficient_data` / `updating` states in the named OpenAPI `PublicFigure` component.
  `subject.get` stays without a figure; its ETag follows the subject head revision, keeping frequently changing
  figure publications out of that response. Native evidence is `test/rating/public-figure-http.test.ts`, using vote
  HTTP writes and the default worker, including pending publication and private-Realm non-disclosure. The frozen
  subject/search scenario still awaits search's matching consumer; the driver must not synthesize states from nulls
  or rescale aggregate HTTP means.
- **Search with rating:** `subject.search` has no figure on hits. `searchCard` still requires the same current public
  figure and explicit readiness as the subject consumer, preserving private-vote and private-Realm non-disclosure.
  [Search, Global rating order](../../services/kernel/src/search/README.md#global-rating-order) documents the public
  producer boundary and pending runtime composition; indexed score alone cannot supply the asserted figure.
- **Content with community:** `provision` requires Global review boards (including a protected board) created over
  HTTP. OpenAPI exposes only Realm-owned board creation. The native creator requires a Realm and its board scheme;
  a Realm-owned board is indexed under that Realm, not Global. There is no landed Global-board creation route.
  Keep the Global-place review assertions; do not seed boards or silently change the place to a Realm.

Review vote citations are **not missing**: both `thread.create` and `post.revise` accept voteCitation, and post and
revision responses expose it. Late-page disclosure/barrier acceptance remains the binding's concern, unchanged.

## moderation-reports-appeals

Scope row: **Moderation, reports and appeals**. Stage: **specified red**; the frozen notification suite is unbound.

User job: reporters report harmful content, moderators take it down and resolve reports, and affected authors read
the reason and appeal to an independent reviewer who can uphold or reverse the decision.

Personas: reporter, author/appellant, moderator/decider, second moderator/reviewer, unrelated reader and anonymous.
Fixtures: `ratings/content` real content targets and protected-board controls, plus the frozen notification suite's
native report/decision/appeal fixture contract. Reports, decisions, appeals and notices must be created through APIs,
not seeded.

| Surface cell             | Scope and scenarios                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Catalogue                | Out: decision and appeal records are participant/moderator workflows, not catalogue subjects.            |
| Curated                  | Out: moderation records are not Collection members.                                                      |
| Everything without state | Out: moderation records are not library support facts.                                                   |
| Own state                | In: recipient's inbox for moderation outcomes, including `report-to-appeal` decision/resolution notices. |
| Mounted Zone             | Out: private moderation workflows are not mounted saved scopes or Collections.                           |
| TypeList                 | Out: moderation records are not configured catalogue subject lists.                                      |

`report-to-appeal` is the moderation cases in frozen
[content-notification-outcomes.test.ts](../../specs/content-notification-outcomes.test.ts): takedown decision,
report resolution, appeal uphold or reverse, and refusal of the original decider. Decision deadlines, denied and
replayed transitions and restoration eligibility remain covered by that suite. A later binding must execute those
existing cases; this manifest does not replace or duplicate them.

Native acceptance command, requiring the future native notification binding:

```sh
CONTENT_NOTIFICATION_DRIVER=/absolute/path/to/native-notification-driver.ts bun test specs/content-notification-outcomes.test.ts
```

## notices

Scope row: **Notifications**. Stage: **specified red**; the frozen notification suite is unbound.

User job: recipients receive eligible in-app reply, mention and moderation notices, page their inbox, see bounded
unread state and mark a notice seen without revealing another person's inbox.

Personas: recipient, author/replier, mentioned account, protected member, outsider, moderator, unrelated reader and
anonymous; include deleted recipients and preference/access changes before delivery. Fixtures: `ratings/content`
content and protected Realm personas plus the frozen notification suite's native recipient/preference and delivery
fixtures. Effects start paused; replay redelivers committed production events, never synthetic notices.

| Surface cell             | Scope and scenarios                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| Catalogue                | Out: personal notices are not catalogue subjects.                         |
| Curated                  | Out: personal notices are not Collection members.                         |
| Everything without state | Out: personal notices are not library support facts.                      |
| Own state                | In: recipient's inbox, `notice-delivery` including unread and seen state. |
| Mounted Zone             | Out: private inboxes are not mounted saved scopes or Collections.         |
| TypeList                 | Out: notices are not configured catalogue subject lists.                  |

`notice-delivery` is the notice cases in the same frozen
[notification suite](../../specs/content-notification-outcomes.test.ts): reply, mention, send-time access,
preferences, replay, inbox, unread and seen. Access loss after delivery still prevents sensitive disclosure. No email
requirement is added. Native acceptance uses the same notification command above with its future real binding.

## Closed scope and verification

**Articles, hosted works and media** stays closed behind grants until polished under [public scope](../scope.md);
media claims are covered by `threads-and-boards`.

Run the new native acceptance with a real binding as documented above. Until then the specification validation
command is:

```sh
bunx oxfmt --check docs/goals/content.capabilities.md specs/content-user-cases-outcomes.test.ts specs/content-user-cases-driver.ts && bun specs/support/verify-outcome-suite.ts specs/content-user-cases-outcomes.test.ts CONTENT_USER_CASES_DRIVER 'Content user cases driver is required'
```

This checks every declared literal scenario fails with exactly the missing-driver error, with no skipped cases.
It advances only **specified red**, never **user-case acceptance passed**. A future registered driver must pass the
suite through real production boundaries before the capability advances; promotion needs recorded revision evidence.
