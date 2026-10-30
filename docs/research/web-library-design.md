# Library, Collections, copies and progress: Web design research

Research date: 31 October 2026. Repository observation: `5827ec24a0`.
This is desk research and a consumer/source inventory, not adopted authority, a runtime verification,
or native/full-row completion evidence. “Source-present” below means inspected implementation, not a
passing served journey. No product code, schemas, acceptance tests or owner contracts were changed.
The optional backend design audit at `.temp/goal/supermanager/backend-design-audit-20261030.md`
was unavailable in this checkout; no conclusions depend on its contents.

The existing design already separates the right things: explicit state, personal labels, holdings,
repeatable progress sessions, published snapshots, curated occurrences and followed Collections.
The main remaining problem is joining their authoritative producers to all Web destinations with
current disclosure, useful bounded pages and complete lifecycle behavior. A further shelf vocabulary
or separate Web library store would multiply that problem.

## Authority and evidence already available

[Scope](../scope.md) makes this an existing In system. The following documents retain authority;
recommendations here do not replace them or expand deferred scope.

| Topic and authority                                                                                                                                | Existing research and its present usefulness                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Library and Collections](../library-and-collections.md), [profile consumers](../library-profile-consumers.md), [Continue](../library-continue.md) | **Primary-backed, partial coverage:** [library abstraction](library-abstraction.md), [shelves](library-shelves.md), [shelf activity](library-shelf-activity.md). Reuse their separation of personal facts, collection navigation and batched progress. Their dated implementation inventories are not current delivery evidence.                                                                                                                             |
| [Joint presentation](../collection-presentation.md), [dynamic Collections](../dynamic-collections.md)                                              | **Partial:** shelf research supports layout and interaction choices. No surveyed product establishes this repository's exact Type/profile/kind/fact/cover protocol. The joint owner contract selects that protocol; source now implements some fields its older inventory still calls absent.                                                                                                                                                                |
| [Collection Source](../collection-source.md), [shared filtered lists](../filtered-lists.md)                                                        | **Primary-backed, partial:** [query/bulk research](library-query-bulk.md) supports bounded workflow segments, not an implemented common Source. [Whole-set support research](library-builtin-set-support-current.md) contains useful source observations but its proposed per-fact witness design must not supersede today's shared structural directory contract.                                                                                           |
| [Labels](../library-labels.md), [pins](../library-pins.md), native [Library module](../../services/kernel/src/library/README.md)                   | **Partial:** [Web library review](web-review-library.md) is a historical consumer audit. Current code already has label UI, entry Undo, personal `noindex`, shelf progress and pins; do not redispatch these as wholly absent features. **None found** for a current, complete served label/pin/built-in journey.                                                                                                                                            |
| [Deletion](../deletion.md), native [terminal participant boundary](../../services/kernel/src/library/erasure-participant.md)                       | **Primary-backed, partial:** [entry Undo](library-entry-undo-independent-current.md), [shelf maintenance](library-shelf-maintenance.md), [account retention](library-account-retention.md), [terminal implementation review](library-terminal-native-implementation-review.md). Native registration/local cleanup has advanced since those reviews. Older retention of published reading logs is superseded: current policy erases them at account deletion. |
| [Viewer actions](../viewer-actions.md), [Web capabilities](../goals/web.capabilities.md)                                                           | **Primary-backed, partial:** [viewer-action survey](viewer-actions.md) supports discoverable affordances with server authorization. It does not establish actual Auth/session composition or current personal-driver results.                                                                                                                                                                                                                                |
| Accepted profile and Type identity                                                                                                                 | **Superseded recommendation:** [type-key research](library-type-keys.md) explains earlier alternatives; its private dictionary proposal must not replace compiled release/profile authority.                                                                                                                                                                                                                                                                 |

These reports were consulted before the product sources below. Their primary citations are reused where
they still answer the question. No existing report supplies complete current UI ↔ API ↔ storage proof.
In particular, [the Web capability obligations](../goals/web.capabilities.md) and
[personal driver contract](../../specs/web-personal-driver.ts) describe required real integration;
their existence alone is not that integration.

## Four directly relevant product designs

Official pages were fetched/read on 30–31 October 2026. These are observations of documented behavior,
not claims about undocumented storage, authorization or performance guarantees.

| Primary design                                                                                                                           | Useful comparison and recommendation                                                                                                                                                                                                                                                                                        | Limits                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steam Library:** [official Library design](https://store.steampowered.com/libraryupdate/?l=english), accessed 31 October 2026          | Collections are direct organization targets; custom Home shelves feature chosen Collections and sorting. Dynamic Collections use tags and filters. This supports one Library destination, optional pinned Collections and a clear Continue region rather than many mandatory state tabs.                                    | The page also mixes purchases, events and social activity into Library. Those do not define REZICS membership or authorize a feed, recommendation system or entitlement inference. This is official product documentation, not inspected server code or a bounded-query specification.                   |
| **Zotero:** [official Collections and Tags guide](https://www.zotero.org/support/collections_and_tags), accessed 31 October 2026         | One item can appear in several Collections without duplication; the root shows the library, and tags provide another filtering dimension. Add and move have distinct interactions. Adopt the clarity of independent organization and explicit move, while retaining REZICS's occurrence IDs and canonical browse semantics. | Zotero's item-backed root, nested Collections and cross-library behavior do not define Everything, state-set support or curator authority here. Its user guide does not prove current-disclosure safety or backend page bounds. No new hierarchy or cross-curator transfer follows from this comparison. |
| **BookWyrm:** [official shelves/status guide](https://docs.joinbookwyrm.com/shelves.html), accessed 31 October 2026; pinned source below | A status shelf is exclusive, custom shelves can overlap, and manually supplied reading dates do not automatically shelve a book. This supports distinct explicit state, labels/Collections and repeated reading history, with the subject action leading into each.                                                         | Its four fixed statuses and public-default shelves are unsuitable defaults here: REZICS uses accepted profile data and private personal facts. The guide identifies itself as development documentation. Its feed/posting model is outside this task.                                                    |
| **Komga:** [official read-progress guide](https://komga.org/docs/guides/read-progress/), accessed 31 October 2026; pinned source below   | Progress belongs to each user and is visible on the book card, with manual read/unread actions. Its book DTO embeds progress. Adopt the producer-supplied card projection and explicit action, avoiding browser detail requests for each row.                                                                               | The inspected model is a current per-user/book position, not REZICS's multiple pinned sessions, sparse completed units, event history or Undo. Neither the card nor DTO establishes whole-page cost, merge correctness or authorization closure.                                                         |

Source provenance, reused without installing or executing either project:

- BookWyrm: `.reference/shelves/bookwyrm`, commit
  `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`.
  [`bookwyrm/models/shelf.py`](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/shelf.py)
  stores shelves and book associations;
  [`bookwyrm/models/readthrough.py`](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/models/readthrough.py)
  separates readthroughs and progress updates. Its
  [Anti-Capitalist Software License 1.4](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/LICENSE.md)
  restricts eligible users; treat it as restricted source, not an unrestricted open-source dependency.
- Komga: `.reference/shelves/komga`, commit `023ec905c10a35bbb8e29095420d266cd3adad60`.
  [`ReadProgress.kt`](https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/model/ReadProgress.kt)
  keys progress by book/user;
  [`BookDto.kt`](https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/interfaces/api/rest/dto/BookDto.kt)
  includes optional `readProgress`. The source uses the
  [MIT License](https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/LICENSE).

The clone paths are relative to `/home/edge/projects/rezics/rezics-next`; their metadata is recorded in
`.reference/INDEX.md`. Official guide text is cited as evidence, not offered for copying under a code
licence. No source files or long passages are proposed for reuse.

The shared pattern is a stable personal destination, independent grouping dimensions, progress near
the item and explicit organization actions. **Recommendation:** implement those patterns through the
existing PostgreSQL owners, released definitions, shared filter grammar, FULL/batched projections and
Web renderer. None of these sources supplies a reason to introduce new vertical enums or private
browser state as an authority.

## The complete consumer journey and its actual authorities

Routes below omit the locale prefix. API paths are kernel paths. Storage names are in the `library`
schema unless stated otherwise. “Required” identifies an existing owner obligation; “recommend” marks
consumer composition proposed by this report.

The common write path is a signed-in Web form/server action → the existing Auth session/operation
exposure and CSRF boundary → kernel actor/scopes/current Access → native owner command → PostgreSQL
mutation plus receipt/outbox/session position → derived projection where needed → authorized read.
A UI-visible action is no permission. Personal data is read after viewer preparation, remains private
and `no-store`, and personal destinations already carry `noindex`. Public subject/Profile Collection
surfaces must use public authority even when the viewer also owns private facts.

| User step and actual Web region                                                                                                                                                              | Current API, owner and records                                                                                                                                                                                                                                                                                       | Boundary and recommended completion                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Find a subject; save/change/clear state.** Subject overview `/subjects/{id}/{slug}`; `src/library/subject-slot*.ts*`                                                                       | Kernel Library `personal-routes.ts`, `entries.ts`: GET/PUT/DELETE `/v1/libraryEntries/:subjectId`, POST `:restore`. `entry`, `entry_deleted`, `owner_write_counter`; profile/pin modules resolve released definitions. The Web slot already sends revision/incarnation and idempotency and exposes entry Undo.       | No separate “saved” boolean or implicit state from Collection membership, label, copy or session. Entry is at most one explicit state. Resolve the effective Type's compiled library reference; persist the accepted profile pin. New values may be unavailable without a current profile; historical reads, clear and Undo must remain possible. Preserve original IDs through merges and allocate a fresh native owner-write sequence on explicit state writes/Undo.                         |
| **Open personal Library and status/label filters.** `/library`; `routes/library/index.tsx`, shelf components, `library-nav.tsx`                                                              | GET `/v1/libraryEntries`, `/v1/libraryShelfSummary`, `/v1/libraryShelfTypes` in `personal-routes.ts`; entry/shelf projections and `progress_head`. Current tracked-entry cards already have embedded subject/progress data and grid/list/table layouts. Label mode uses the assignment reader described below.       | The tracked-entry page is not yet the complete Everything union. Recommend retaining its honest label until native built-ins are joined. State chips use accepted profile states; built-in state Collections and optional pins are navigation/filter choices, not a new mandatory fixed tab set. A user's other personal facts cannot be lost because no entry exists.                                                                                                                         |
| **Continue and history.** Home Continue, Library Continue region; `/library/progress`, `/library/progress/{id}`                                                                              | `continue-read.ts` expects GET `/v1/libraryContinue` through a cast client, then one `/v1/pages:read` subject batch (`pages.$read` in the client). No production Continue HTTP mount was found. `progress-routes.ts` mounts session APIs below.                                                                      | Required Continue is the bounded union of active-role explicit state and active sessions, including session-only subjects. A non-active chosen state does not veto a session. Its GET must not prepare/write. Current helper catches failures as `[]`; recommend distinct unavailable/preparing/empty states. Navigation currently points to `/library/continue` without a matching route; compose that destination or correct navigation as part of the same journey.                         |
| **Discover/pin personal Collections.** `/library/collections`; `mine-collections*`, `collection-browser.tsx`, `library-nav.tsx`                                                              | GET `/v1/collections` for self; GET `/v1/libraryPins`, PUT/DELETE `/v1/libraryPins/:collectionId` in `pin-routes.ts`. `collection`, `collection_pins`, built-in identity/reference scaffolding. Pins are a bounded separate list with its own CAS revision.                                                          | Existing curated listing and pins do not establish logical built-in discovery. New pins require current target readability; removing/reordering existing pins must not reacquire target rights. First authorized built-in write must materialize its stable logical identity and grants atomically, never on GET. Current personal Collection previews are all explicitly `unavailable`; do not replace them with row-detail fanout.                                                           |
| **Browse a Collection, its subject tab or a public profile tab.** `/collections/{id}`, `/subjects/{id}/{slug}/lists`, `/@{handle}` Collections tab; `collection-load.ts`, query/read modules | `collection-routes.ts`: GET `/v1/collections/:collectionId`, `/members`; GET `/v1/subjects/:subjectId/collections`; GET `/v1/accounts/:accountId/collections`. `collection-reads.ts` reads curated headers/ordinal occurrence pages; `subject_collection`, listing/version/fence records serve reverse public views. | These are different populations: owner discovery, current readable Collection members, public reverse pairs and public-profile Collections. Current curated reads are source-present; the common canonical/filter/dynamic Source is not complete. Recommend one shared Source-backed browse projection for all three public consumers plus private owner browse, with no private support/count leakage. Editor occurrence pages retain multiplicity even when browse shows one canonical card. |
| **Create, edit, order, remove or move members; publish.** `/collections/new`, `/collections/{id}` editor; `collection-records.ts`, `collection-editor.tsx`, `collection-page.tsx`            | `collection-routes.ts`, `collections.ts`: POST/PATCH/DELETE Collection; POST member, PATCH note, DELETE member with parent `revision`, POST member `:restore`, POST member `:move` for in-Collection ordering. `collection`, `collection_member`, listing history; native listing work updates public reverse pairs. | Current editor saves staged independent commands; it is not an atomic batch. Its member-delete consumer omits the now-required parent revision and ignores deletion headers. Required batch remove and cross-Collection move are still absent. Publication is an authorized visibility transition, not a new personal fact or a grant on subjects/sources. Collection-level restore is not mounted; member restore is.                                                                         |
| **Follow a readable Collection and revisit it.** Collection follow action and `/library/following`                                                                                           | `personal-routes.ts`, `follows.ts`: GET/PUT/DELETE `/v1/follows/:targetId`, GET `/v1/follows`. Private `follow` edges distinguish explicit, Library and membership reasons.                                                                                                                                          | Readable unlisted targets may be followed; follow conveys no target/source rights, does not create an Everything fact and is not public membership/count evidence. Show inaccessible targets without disclosing private headers; an unavailable dependency is not proof that a follow or target is absent. No activity feed is required.                                                                                                                                                       |
| **Label without saving state.** Subject label picker, `/library/labels`, `/library?label=...`; `label-*.ts*`                                                                                 | Web has label definition/assignment/restore consumers behind cast client exposure. Native `label-commands.ts`, label/assignment stores and retention exist for `personal_label` and `label_assignment`; no production label HTTP mount was found in `http/kernel.ts`.                                                | Mount the existing native owner contract rather than adding a Web label store. Parent deletion immediately masks assignments without a child fanout; definition and assignment deletion identities/CAS remain independent. Reclaimed or explicitly unassigned reservations do not revive on parent Undo. Labels require neither state nor a supported current profile.                                                                                                                         |
| **Record a copy/holding.** `/library/copies?subjectId=...`; copies readers/forms                                                                                                             | `personal-routes.ts`, `copies.ts`: POST/GET `/v1/copies`, GET/PATCH/DELETE `/v1/copies/:copyId`. `copy` stores pinned kind/status plus location/source/acquisition/disposal/note and revision. Lists already offer FULL embedded subjects.                                                                           | A holding is a personal record, not a Commerce purchase or entitlement. Current PATCH consumes revision, but DELETE mounts no submitted revision and calls `deleteCopy(..., undefined, key)`; SQL physically deletes the current row. Web sends a revision that this route does not consume. Ordinary retained deletion/Undo and stale-editor protection need the Library owner to close this chain.                                                                                           |
| **Start/repeat a session, update progress, finish/abandon, inspect history.** `/library/progress`, session detail                                                                            | `progress-routes.ts`, `sessions.ts`, progress stores: POST/GET `/v1/progressSessions`, GET `/:sessionId`, POST `:record`/`:complete`/`:abandon`, GET `/completedUnits` and `/changes`. `progress_session`, sparse `progress_unit`, append-only `progress_change`, maintained `progress_head`.                        | Preserve the accepted mode/unit pin, decimal strings and sparse units; never infer complete from amount/total or set the entry state on session completion. Repeat consumption creates a new session. Finish/abandon is a lifecycle transition, not record deletion. Recommend exposing accepted historical meaning alongside current creation choices, without exposing private pins as public presentation fields.                                                                           |
| **Publish/read/delete/Undo a log.** Progress actions and `/logs/{id}`; `logs-read.ts`                                                                                                        | `progress-routes.ts`, `published-logs.ts`: POST/GET `/v1/publishedLogs`, GET/DELETE `/:logId`, POST `:restore`. `published_log` stores an explicitly chosen snapshot; native retained deletion/restore/due work is source-present.                                                                                   | Publication does not expose the private session, units, cursor or full changes. Current Web does not wire restore/deletion evidence into an Undo interaction. Publishing a log alone is not Everything membership. All such snapshots are erased at terminal account deletion under current policy.                                                                                                                                                                                            |

Source anchors for the concrete mismatches are
[`removeCollectionMemberRecord`](../../apps/web/src/library/collection-records.ts),
the required DELETE query and restore headers in
[`collection-routes.ts`](../../services/kernel/src/library/collection-routes.ts),
the copy DELETE route in [`personal-routes.ts`](../../services/kernel/src/library/personal-routes.ts),
its physical [`entry-store-copy-delete.sql`](../../services/kernel/src/library/entry-store-copy-delete.sql),
and [`loadContinue`](../../apps/web/src/library/continue-read.ts).
These are inspection findings to repair in their existing writers, not test results.

### Presentation, filters and dynamic publication across the journey

**Existing contract:** Type presentation comes from compiled
`Release.types[typeId].listPresentation` (`imageAspect`, at most four effective property IDs),
whole-object inheritance and the exact Type fallback table in
[joint presentation](../collection-presentation.md). Keep existing `coverRatio`; do not infer a kind
from labels or substrings. A Collection's `presentationKind` is an optional exact Type override;
automatic kind requires complete canonical membership, dominant actual Type and the specified tie break,
not a first-page sample. Facts are optional FULL `Record<PropertyId, Fact[]>` projections with at most
four properties and three values each. Absence, `{}` and unavailable have different meanings.

**Source-present:** `collection-presentation.ts` and the applied
`20261030142618_collection_presentation.sql` migration support owner-selected kind and existing imported
`coverMediaId` on `collection`. POST/PATCH validate selection with native CAS; reads authorize actual
Content reference/variant download and recheck current Collection authority. This adds no Collection
upload/container ownership. Automatic dominant kind, ordered member-cover fallback, producer key facts
and native first-three previews are not thereby delivered. Current pending/empty/owner disclosures must
remain honest. The Web metadata forms and personal Collection presenter do not yet carry this full
selected contract. Shared `src/media/type-presentation.ts`, SearchResultList and CoverList already
contain consumer presentation support; compose those rather than creating another type renderer.

**Required Source:** Everything unions live state, effective live label, retained sessions/history and
retained holdings, excluding empty shells, trash, follows, curated occurrences and ratings alone.
State-set support comes from live entry or retained pinned session/copy and exposes every sibling state,
including empty ones. Labels/trash alone do not support a state set. Liked uses current SUBJECT like/love
Content authority, stays private and has a stable empty identity; it is not Everything membership.
The shared structural owner candidate/support directory must cover every producer; an entry-only
reference, schema/head or per-fact mirror is not completeness. Preserve highest live `owner_write_seq`
state selection after merges, immutable stored originals and separate copies/sessions.

`collection-source.ts` remains a specification ABI whose factory throws `dependency_unavailable`;
`collection-source-native.ts` supplies some raw native reads, not the complete source. Built-in reference
and raw-source hooks exist, but all-support directory coverage, Liked adapters, canonical common pages
and complete output publication are missing. This is a runtime gap despite rich DTOs and owner prose.
Dynamic DTOs must omit curated-only counts/times/order/occurrence fields. Pure detail/discovery does not
materialize identity. Only authorized common members GET may start retained preparation, through the
existing Accounts operational transaction/enqueue intent; Continue GET does not start work.

For filters, reuse [the shared grammar and admission](../filtered-lists.md) everywhere: unknown remains
unknown under NOT, qualifiers bind to the same statement, quantities retain units, and `> 1,000,000`
words excludes equality/absence. Source + filter + order must be admitted together; reject unsupported
shapes before enumeration. Public filtering includes current exclusion/order/count safety, not merely
rechecking returned rows. Revalidate original **and** terminal subjects, actual source/consent/tuple
dependencies and current Access before disclosure. A public page uses public facets even for its owner.
Private state/labels/progress/holdings never enter a public index.

Use useful filled or genuinely exhausted bounded pages and the common budgets, including the shared
16-read/128-slot composition ceiling where applicable; a response LIMIT is not an engine-work proof.
Native projection/preparation must supply the page and first-three previews; browser row-detail fanout
stays zero. The same URL/cursor returns exact `202 {preparing:true}` with `Retry-After` and private
`no-store`, exhausted `200`, or genuine unavailable `503`; preparation must settle on fixed finite ready
input. No fake empty pages, operation URL or perpetual spinner. Current Web's bounded retry handling is
only a consumer of that producer obligation.

Private dynamic evaluation stays owner-local. Other viewers receive only complete activated output,
and frozen sources use their completed output; no grant, follow, mount or export grants private source
rights. Saved rule editing uses the selected shared `FilterDocument` contract but remains deferred
runtime scope. Do not activate it because Steam demonstrates dynamic organization.

### Actual lifecycle and source-record custody

The [native Library inventory](../../services/kernel/src/library/README.md) and current
[terminal boundary](../../services/kernel/src/library/erasure-participant.md) are more current than the
older research. Ordinary deletion and terminal account deletion have different obligations:

| Record family                                                                                                                                     | Current lifecycle and remaining boundary                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry and `entry_deleted` episode; labels/assignments; retained members; published logs                                                           | Native retained paths exist. Undo uses the exact deletion identity/revision and original strict `< deletedAt + 720h` deadline. Entry restore cannot overwrite a newly occupied slot; member restore also needs current parent revision, capacity/order and subject authority. Do not restart the clock on retry/restore. Web coverage differs by record, as above. |
| `copy`; progress session/unit/change/head                                                                                                         | Copy currently physically deletes; it lacks the ordinary retained path. Session completion/abandon retains private history and pinned meaning. Do not present completion as deletion, or assume an amount cursor is a session history.                                                                                                                             |
| Collection/member/listing history, `subject_collection`/versions/listings/fences                                                                  | Curated occurrence order and canonical browse output are separate. Deleted members retain the restoration episode; due processing may leave only minimal structural public-parent tombstones. Reverse listings are derived public copies, not personal facts. Cross-home late delivery needs exact terminal custody.                                               |
| `builtin_collection_reference`, state-reference source, `fact_source_head`, canonical source state/facts, pins and shelf/type/preparation records | Existing structures/hooks and generation heads are not proof of complete support or permission. New/replacement derived access paths need native writer coverage, identity/current-disclosure integration and lifecycle disposition; do not create a second truth in Web.                                                                                          |
| Receipts, outbox, write-basis, DBOS inputs/results/checkpoints, bulk and remote listing effects                                                   | These may contain private identity or payload outside the obvious row. Exact producer locators and the actual store owner's minimizer/disposition are required. Workflow success, a local zero count, expiry or relay enqueue cannot prove erasure.                                                                                                                |

`work-module.ts` now registers entry/member/label/log retention, and `work.ts` registers the account
erasure participant. The terminal worker performs bounded local child-first cleanup across entries,
copies, follows, sessions/history, labels, logs, Collections, references, pins and derived owner state.
It deliberately remains pending: `erasure-participant.ts` names missing bulk/remote locators,
orphan listing-history custody, shared payload minimization and logs/caches/exports/replicas/backup
inventory. Do not report terminal registration or local graph cleanup as wholly absent, or as complete.

**Current required account boundary:** fresh authentication and typed confirmation establish terminal
time T, immediately fencing private/unlisted reads, writes, exports, counts and producers. There is no
account Undo or 720-hour account grace period. Only eligible active-public contributions remain
de-identified; a dynamic Collection may retain complete published A, never pending B or a fresh private
evaluation at T. Published reading logs are erased. Cleanup begins immediately in bounded durable work;
the present participant must not ACK while custody remains unknown.

## Gaps and decisions for adoption

**Missing design/adoption:** the broad Library/presentation/filter/lifecycle behavior is already
specified. The remaining cross-owner seam is the executable Source admission/binding and complete
physical query/identity/privacy dependencies, including all producers of the shared support directory.
Source resource grammar and the final joint native bindings require their owners' adoption; Web must not
invent a filter language or declare readiness on their behalf. The manager should also make the existing
720-hour ordinary deletion policy explicit in the copy command/DTO/consumer contract, and specify the
accepted-profile display projection for historical records. These are integration decisions inside
existing scope, not reasons to add saved queries or a new state enum.

**Missing runtime:** complete built-in discovery/support/Liked/common canonical Source and public output
publication; production Continue and label HTTP composition; admitted useful filtered pages and preview/
facts/automatic presentation producers; native batch removal/cross-Collection move; retained copy
deletion and submitted-delete CAS; Collection restore exposure; complete terminal producer/custody closure.
Owner-selected kind/cover, profile-pinned personal writers, member/log retention and local erasure are
source-present and should be extended rather than replaced.

**Missing UI:** honest complete Library versus tracked-entry population; a reachable Continue destination
and failure states; producer previews and full selected presentation controls; member parent-CAS/delete
receipt/Undo wiring; copy/log lifecycle interactions; accepted historical profile meaning. Reuse current
label/shelf/progress/pin/forms. Publication, follow, owner/private/public/unlisted views and withheld
subjects need consistent current-source states across detail, subject Collections and profile tabs.

**Missing proof:** source existence and this report establish none of the complete served outcomes.
Later evidence must cover two accepted profile releases; state-only, label-only, history-only and
holding-only support; empty-shell/follow/curated-only exclusions; all sibling states; merged originals;
owner/other/anonymous, private/unlisted/public transitions; withheld positive/NOT/order/count effects;
bounded first/deep useful pages, previews and zero browser detail fanout; stale CAS/replay/Undo at exactly
720 hours; and terminal late producer/shared-payload disposition. Use the existing outcome contracts and
real personal driver, not another report, mocked DTOs or an isolated route as full-row proof.

Recommendations resolving ambiguities in this inventory are: preserve current owner contracts over
historical research; treat implementation as source-present rather than delivered; keep tracked-entry
terminology until Everything is complete; use four surveyed designs for interaction patterns only;
keep unavailable/preparing distinct from empty; and reserve existing writers rather than duplicate them.

## Ordered corrective slices

Each item is a whole consumer outcome for the manager to reconcile with current owners, not a new
parallel writer. Its smallest later proof is a targeted addition to the existing owned proof, followed
by the existing served personal journey when the producer is available.

1. **A complete private Library from any native personal fact.** Regions: subject actions, `/library`,
   `/library/collections`, Home/Library Continue, label picker and `/library/labels`.
   API owner: Commerce's Library module with Semantic identity, Search admission and Accounts preparation
   integration. Join all native support producers, common built-in discovery/pages, labels and pure
   Continue to the current Web consumers. Existing writer overlap: entries/profile pins, labels, shelf
   projections, pins, Collection discovery and personal-driver work; do not replace these.
   Smallest later proof: one owner with state-only, label-only, session-only and copy-only subjects,
   all sibling states and an empty-shell/follow control, then the same served Library/Continue/filter
   navigation with bounded work and honest dependency failure.
2. **One Collection browse/publication/presentation across every discovery surface.** Regions:
   `/collections/{id}`, `/library/collections`, subject `/lists`, public-profile Collections tab and their
   shared header filter/cover/list components. API owner: Library Source/presentation, Semantic facts/Type,
   Content cover authorization and Search filtering. Complete canonical useful pages, publication,
   first-three previews, auto kind/member cover and FULL facts through the selected producer contract.
   Existing overlap: header-search, Collections and type-renderer work already owns these consumers;
   integrate missing producers and mappings there. Smallest later proof: the same mixed-Type Collection
   in owner/public/unlisted views, one withheld original and a changed tag affecting NOT/order, with
   current cover/facts, bounded preview/page and no browser detail requests.
3. **Curate and Undo against one coherent parent revision.** Regions: new/detail Collection metadata
   and loaded-occurrence editor. API owner: existing Library Collection/member commands. Repair current
   delete parent-CAS/deletion evidence first, then close selected atomic 1–100 member removal and
   same-curator cross-Collection move using both parent revisions, preserved IDs/notes/order and the
   5,000-member cap; expose existing restoration and selected kind/cover fields. Keep saved rules deferred.
   Existing overlap: Collection editor, member retention and presentation writers. Smallest later proof:
   two curator tabs race removal/move, a stale attempt leaves both parents unchanged, replay is exact,
   and Undo succeeds before but not at the original 720-hour deadline; verify through the existing editor.
4. **Personal holdings and consumption history remain understandable and reversible.** Regions:
   `/library/copies`, progress start/detail/history and `/logs/{id}`, with subject/shelf summaries.
   API owner: Library copy/session/log commands and released profile producer. Close retained copy delete,
   submitted revision handling, log Undo consumption and historical accepted-meaning presentation without
   changing explicit state on progress completion. Existing overlap: profile-pinned native writers,
   current progress/log UI and personal-driver work. Smallest later proof: old-profile copy and two
   sessions survive a release change; current creation uses the new profile; stale deletion is refused;
   exact copy/log Undo and independent state are visible through real forms.
5. **Terminal deletion closes the whole private graph and its copies.** Regions: existing account
   deletion flow and every Library read/write consumer after T. API owners: Access coordinator, Library
   participant and actual Core/work/foreign store custodians. Finish the existing locator/fence/minimizer
   integration and complete no-data/retained-public disposition, rather than adding another erasure
   worker. Existing overlap: registered terminal worker, local graph phases and Auth/account work.
   Smallest later proof: delete an owner with private/unlisted data, complete public A plus pending B,
   a published log and a delayed remote/shared effect; all personal access is fenced immediately,
   only eligible de-identified A remains, and native custody reaches a truthful terminal ACK.

Checkout/current-entitlement and Auth assembly already own purchase authorization, benefits and real
credentials/session exposure; the personal driver already owns real served-persona composition.
Personal `copy.source` or an acquired date cannot substitute for those owners' purchase/entitlement
records. Commerce purchase/benefit research belongs to Commerce and is deliberately separate from this
personal Library survey. No duplicate checkout writer, benefit engine, login assembly, header search,
Collection renderer or new driver is recommended. This report can guide integration dispatch; it cannot
promote any of these slices as native, full-row or main proof.
