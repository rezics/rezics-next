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

Decision: reading-card `placeId` is the Board identity. Subject discussion pages confirm the Subject on the
disclosed thread and the Board home separately; they do not pass the Board id to `readSubjectThread` as a place.
Subject and author list query limits stay decimal-digit strings on the HTTP schema so a mismatched continuation is
`400`, not a missing route. Focused post-editing browser cases remain the fewest that pin the mounted edit/delete
journey; they consume the composed reading-page rather than split thread and post lists. Conversation-row items are
the post slots; nested presentation lists are not indexes. Journey navigation waits for DOMContentLoaded and
hydration. Owner edit and erase use the reading-page viewer when that page was admitted for the account, otherwise
the signed-in session subject after anonymous SSR. An unknown session withholds the overflow menu so a
stranger copy/report menu cannot open in place of owner edit and delete. Inline revisions send the inherited
native licence; a permanent
author-erased slot shows “Removed by its author” without overflow, while a restorable deletion keeps its deleted
tombstone and restore window. Edit discard confirms from live draft dirtiness, including capture-phase editor input, host text and a
pending snapshot so Escape can confirm before the next paint. Revision and erase Idempotency-Key headers
stay RFC 8941 quoted strings.

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
  item, summary, count, source or cursor material. Stage **driver registered**:
  `test/content/late-board-revocation-point-reads.test.ts` is the one native family for those surfaces.
- `late-board-revocation-pages`: the frozen suite declares literal cases for hot, active and newest board first and
  continuation pages, and thread post first and continuation pages. Each has a late board takedown, late protected
  read-grant revocation, and unchanged public and protected positive controls. Stage **driver registered**:
  `test/content/user-cases-driver.ts` binds `holdPage`, and `test/content/late-board-revocation-pages.test.ts` pins
  the native HTTP family. No extra stories.

Native acceptance commands, from the repository root:

```sh
bun run --cwd services/kernel check test/content/thread-outcomes.test.ts test/content/disclosure-outcomes.test.ts test/content/media-outcomes.test.ts test/content/subject-threads-http.test.ts test/content/boards-http.test.ts test/content/board-ranking-http.test.ts test/content/board-hot-http.test.ts test/content/author-item-reads.test.ts test/content/author-item-public-views.test.ts test/content/late-board-revocation-point-reads.test.ts test/content/late-board-revocation-pages.test.ts
CONTENT_USER_CASES_DRIVER=/absolute/path/to/native-driver.ts bun test specs/content-user-cases-outcomes.test.ts --test-name-pattern late-board-revocation-pages
```

The second command uses the bound native driver. Existing board-sort tests do not establish the late point-read or
page outcomes.

Decision: the Content Goal seeded walk uses the existing thread-board driver, seed-journal cleanup and Performance
`waitUntilWalkReady` hydration recovery. When Docker refuses a slot's published port (`port is already allocated`),
the walk adds that index to Performance `admitWalkStack` blocked set, releases the slot and admits another;
same-slot `database.ts up` retry remains for start timeouts. The fewest tests that pin the skip are
`scripts/walk-stack.test.ts` and `scripts/stack-run.test.ts`; composed native/browser proof is the seeded walk.
The first-scope table walked on one admitted stack is the 18 named journeys
in `FIRST_SCOPE_ROWS`: threads-and-boards, exact-revisions, board-paging, container-disclosure, late-revocation,
edit-history-return, watches-and-reactions, takedown-erasure, author-erasure, media, realms-and-spaces,
ratings-and-reviews, work-to-review, moderation-reports-appeals, notices, home-discovery, independent-queues and
persona-matrix. Hourly passing/total uses that table. The walk records live issuer/JWKS origins and does not write
`AUTH_JWKS_URL`; the launcher publishes issuer-origin JWKS and fetches that exact URL from native Auth. ce33 remains the canonical producer. No extra stories. Suspended bearers keep 401/403 on taken-down thread GET; ranking JWT lifetime follows wall time; each mounted
HTTP request starts its envelope from wall time so a held late-revocation request cannot shrink the next command;
author-item
growth captures stay on a one-item page after bootstrapping the bundled release, and large other-author
neighbourhoods use cost-folded capture so Access nested plan notices stay inside the 32MiB telemetry cap.
Author-item growth cases allow 180s. Authenticated thread count bodies may include the viewer's own
`authorErasure.authorId`; reaction-privacy checks drop only that field before scanning for reactor IDs. Post-page
count growth uses the same cost-folded capture and ANALYZE of the filler neighbourhood. Public-view index proofs
ANALYZE a same-route neighbourhood first so a handful of fixture rows cannot seq-scan the primary-key lookup;
existing native HTTP, growth, runtime and walk pins stay the fewest tests, with no extra stories.
Subject discussion listing HTTP uses the shared 30s test request budget so Access evaluation under parallel
check instrumentation cannot turn an empty 200 page into 503; production stays 2s. Command: `REZICS_WALK_DEFER_FRONTENDS=0 bun services/auth/scripts/dev-stack.ts walk -- bun apps/web/scripts/seeded-content-goal-walk.ts`.
Worker Vite resolves Elysia and Eden to their `exports.import` files and replaces TypeBox loaders with live ESM re-exports so workerd never evaluates CJS `module`. Focused test Vite skips the Home route crawl so edit journeys can start. Browser receiving waits for issuer `html[data-hydrated]` and the landed Sign in control. Seed token minting keeps issuer `AUTH_ORIGIN` so own-key assertions target `${issuer}/token`, and reaches native Auth through a loopback issuer proxy that uses `walkIssuerForward` because walk stacks defer Auth pages until after seed. The walk command restores the pinned Bangumi/VNDB dump cache onto the check host and extracts it before the run slice, the same way `vndb-seeded-journey` does, then points seed at `REZICS_DATASETS_DUMP_CACHE`. The dump-cache matcher also matches the Financial outer command `apps/web/tests/native/commerce-library-journeys.walk.ts` so that walk receives the same pinned archives. After journal cleanup the walk waits until identity-epoch topology remaining is zero before persona and seed, because `POST /v1/subjects:batchWrite` answered `503 semantic_not_ready` while 4096-home bootstrap was still open. VNDB release-fidelity seed scans admit the pinned 2026-11-04 dump (`entry_meta` 495184 rows, `releases` 160532). The fewest tests that pin that swap, crawl skip, walk inventory, dump-cache restore, Financial argv, remaining-zero wait and issuer-seed proxy are `vite-config.test.ts`, `scripts/cross-media-dump-cache.test.ts`, `scripts/walk-stack.test.ts` plus the walk unit tests; composed native/browser proof is the seeded walk; no extra stories.
The sole walk receives Accounts published-post effects for reply, mention and moderation delivery, current access and
preferences, replay, inbox and independent appeals. Ordinary HTTP grant receipts are the walk's authority proof, not
seeded fixture rows. The frozen notification suite timeout stays 180 seconds; its assertions are unchanged.
Catalogue CurrentPost attribution is received through existing `authoring-controls-family.test.tsx` and
`own-drafts-native.test.tsx`, `own-drafts-resume.test.tsx` and `own-drafts-commands.test.tsx`. Live identity, null
unknown and id-free deletion stay; exact revision, body, licence and viewer retirement stay. Ada fixtures are not
native or visual proof; no extra stories or screenshots.

Decision: a pre-seed identity-bootstrap timeout records the source revision, UTC, elapsed time and all eighteen rows
as not reached in `setup-failure.json`, alongside the attempt's worker stack log in the returned Content walk
evidence. It does not count setup as a product failure or infer a bootstrap cause from `remaining 4096`; Semantic
receives the native trace through its existing bootstrap owner. Existing focused walk tests remain the regression
check; no extra stories or duplicate acceptance suite.

Decision: the Content walk explicitly selects `REZICS_WALK_DEFER_FRONTENDS=0`, retaining the real default worker,
Search and standalone Kernel before identity bootstrap and seed. The walk launcher honors that existing mode while
keeping its default lightweight Account mode and scoped names, ports and cleanup. The observed deferred launch had
no worker and remained at 4096 bootstrap homes; this is launcher evidence, not a Semantic execution failure. Returned
startup logs remove the native Auth `Password:` line's credential. The existing walk and startup tests pin these
boundaries; no duplicate stories. The native membership registration fixture now expects the installed six named
steps, including Realm finalize/cancel, while retaining all authority and compensation assertions.

Decision: the isolated post-editing browser journey owns its issuer-bound server; the focused runner must not keep
an unused default Vite/Worker graph beside it. Shared-server preparation remains per file for other journeys,
including mixed selections. The existing runner fixture and server-selection tests pin this distinction; the shell
regression stays at file scope and counts linked community icons independently of folding controls. No new stories.
Reconciliation retains the shared wrapper's cancellation/descendant cleanup test and sticky host-wide admission
assertions alongside the self-hosted editor selection and occupied-port recovery tests; neither replaces the other.
Decision: the six original editing cases retain hydration and all interaction assertions. Their bounded diagnostic
run exposes Worker-only imports in the browser graph through Settings profile helpers and the test binding
transform; the existing Settings/Web and startup owners receive that complete boundary repair. Failed initial
opens release their browser context. The same sole walk receives the integrated repair; no browser runtime shim,
timeout increase, extra story or source-only acceptance replaces it.

Decision: receive the integrated Library root boundary, Auth catalogue/lifetime and Boot receipt-key repairs on
this handle, retaining Recent Search around the shell. Production-cache and walk Vite fixtures select and restore
their runtime environment explicitly; the SSR fixture follows the installed include list for both React server
entries. Existing tests retain their other assertions. Changed-workspace typing is worker completion; the sole dev
verification retains native/browser/growth and promoted-revision closure under the current owner policy.
The installed-root shell fixture mounts a document, supplies the application's router context and binds the DOM
scroll API. Its anonymous rendering and admitted viewer-replacement assertions remain unchanged.
The renewed Vite/root fixture pair belongs to the original dev verification, not intermediate worker acceptance;
worker completion uses changed-workspace typing. The existing Accounts custody owner alone settles Bun leader
completion and adopted descendants, preserving interrupted status, nonzero results and process-group absence.

## realms-and-spaces

Scope row: **Realms and Spaces**. Stage: **specified red** for the complete capability.

User job: community creators and managers create and revise Spaces and Realms, publish subjects, manage membership
and boards, and enforce protected admission and participation immediately when someone is banned.

Decision: one official-client publisher owns source compiler/construction/schema/module/bootstrap/dependency inputs,
generation and named OpenAPI/client exports, and publishes independently of consumer completion. Web uses the
installed Home and boardShelf callables without a local DTO, cast or native import. The connected visitor journey
shows at most three newest admitted ordinary threads per Board in one receiver, preserves
exact/lower-bound/unavailable reply counts and empty/unavailable state, and uses existing Realm-return and
shelf-cursor navigation slots. Connected visit, membership, publication and space-page lifetime tests are the
fewest that pin that journey, once-only completion and disposal; no extra stories.
Space-page lifetime and membership-focus tests keep a closed space-actions mock because loading the actual module left the public hydrate empty and exhausted the check host. Web typecheck excludes scripts that import Kernel or Auth source so workers-types cannot type those services.

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
- Installed Rating identity repair uses Semantic `hold/complete` through ordinary module/host composition, with
  independent counted-identity, outbox, receipt obligation/mapping-digest and checkpoint readback in
  `test/rating/identity-repair-native.test.ts`; stage **implementation exposed**. Seam measurements stay in
  `test/rating/identity-repair.test.ts` and `test/rating/growth-identity-repair.test.ts`. Performance owns nested-cost
  review and 256/1024/4096 growth.
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
bun run --cwd services/kernel check test/rating/vote-http.test.ts test/rating/aggregate-http.test.ts test/rating/identity-repair-native.test.ts
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
| `createBoard`                   | `board.create`: POST `/v1/realms/{realmId}/boards`, `{ conceptId, title, purpose: discussion, visibility }`, 201 `{ board }`; fixture provides a real Realm and its scheme/concept. [Community, board scheme](../../services/kernel/src/community/README.md), OpenAPI. `board.create_global`: POST `/v1/boards` creates Global boards with the same fields and `realmId: null`; governance needs `board:create` on Global Context.                                                                                                                                     |
| `takedown`, `revokeBoardRead`   | `board.takedown/post.takedown`: POST `/v1/boards/{id}:takeDown` or `/v1/posts/{id}:takeDown`, `{ reason }`, 200. `grant.revoke`: POST `/v1/grants:revoke`, exact resource/subject/actions/valid grant tuple, 200 `{ grant }`. Fixture grants must cover board and post takedown independently, and the protected reader must have no alternative board-read grant. [Content, Subject threads](../../services/kernel/src/content/README.md#subject-threads), [Access, Grant create/change/revoke](../../services/kernel/src/access/README.md#grant-createchangerevoke). |
| `page`, `holdPage`              | `board_threads.list` / `post.list`: GET `/v1/boards/{id}/threads?sort=&limit=&cursor=` or `/v1/threads/{id}/posts?limit=&cursor=`, 200 `{ threads, next, rankRefreshedAt }` or `{ posts, next, reactionsAsOf }`. Preserve metadata; map the array to items. All literal sort/post, first/continuation, takedown/grant and unchanged-control scenarios stay intact. `holdPage` remains a timing-only native test barrier; its implementation belongs to the binding.                                                                                                    |
| `provision`, `effects`, `close` | Isolated native test lifecycle, not public endpoints. Subjects/Realms/boards use production creation APIs; accounts/grants and delivery controls are permitted fixture setup. Effects drain/replay production events and workers; cleanup joins held requests. No manufactured votes, figures or relay rows. Global boards use `board.create_global` with explicit governance grants.                                                                                                                                                                                  |
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

Global board creation is available through `board.create_global`: POST `/v1/boards` with explicit governance
`board:create` on Global Context. Published and protected reviews boards can coexist for one Concept without a
Realm scheme. `test/content/global-board-create-http.test.ts` proves HTTP creation, vote-citing reviews,
discussions, Global subject listings, protected disclosure and idempotency. The Global provisioning gap is closed;
the composed binding's Global-place review assertions remain required.

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
