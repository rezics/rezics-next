# Performance design status

Audit date: 2026-10-30. Source baseline: `5827ec24a05f57299ea50343b540eb81bd849c54`.
This is a backend design audit, not native acceptance or an adopted replacement contract.
[Scope](../scope.md) gives Performance no standalone product In row: the
[Performance Goal](../goals/performance.md) supports every In owner. Search owns discovery,
Commerce owns Library, Accounts owns account APIs, Auth-app and authentication/Access authority, Semantic
owns catalogue/Zone sources, and Content retains notice delivery. Performance owns the website
account-settings, notices and preferences journeys; Web owns shell, shared patterns, Storybook
organization and visual review. The three pages below remain cross-cutting capability audits.

[The capability manifest](../goals/performance.capabilities.md) owns stage, fixture and scenario
obligations; [verification](../development/verification.md) owns proof requirements. Designed,
implemented, exposed, accepted on dev and promoted are separate claims. Existing owner deliveries
remain trusted evidence for their stated revision and boundary; this audit neither revalidates
their receipts nor upgrades them to complete capability acceptance. Promotion is unknown here.
The optional private controlling request was unavailable in this checkout; the supplied contract
and tracked authorities define this audit. The journey status below reflects the subsequent interface
handoff; the original Performance Done scope, research and native/promotion debt remain unchanged.

The [Performance ownership](../goals/performance.md#ownership) handoff covers the existing
`/settings` sections `#reading`, `#display`, `#notifications`, `#privacy`, `#verification`, `#profile`,
`#public-activity` and `#account`, including admission-dependent sections and Auth security entry.
Settings consumes the existing typed profile `GET /v1/accounts/{id}/profile` and
`PATCH /v1/accounts/{id}`, and preference `GET/PATCH /v1/accounts/{id}/preferences` boundaries;
Display now composes Web's delivered `AppearanceControls` and its browser cookies. `/inbox`
consumes Content's account-notification list/count/mark-seen APIs and current target reads;
Accounts retains preference storage and API authority. Patterns and Pages share the real Display
component. Web's 390/1280 review with shared locale/theme globals, actual typed-source journey
acceptance, native physical-work evidence and promoted proof remain pending; local typing does
not establish them. No new audit or backend ownership is implied.

| Capability              | Design and implementation status                                                                                                                  | Acceptance and promotion status                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| growth-harness          | Existing native capture/classifier and counted-unit support are implemented; the manifest's absent-counters-file statement is stale on this base. | Complete reserved counter scenario is still missing; no whole-capability dev acceptance or promotion established.                                    |
| hot-path-bounds         | Cost citation validation and module suites exist; operation-level coverage remains partial.                                                       | Existing owner passes retain their limited meaning; no complete hot-path acceptance or promotion established.                                        |
| composed-discovery-cost | Required jobs and budgets are specified; several owner integration choices remain proposals.                                                      | Manifest stage remains **not yet specified** for executable acceptance: its named suite is absent, with no red/driver/exposed/passed/promoted claim. |

## Cross-cutting audit page: growth-harness

**Authority and evidence.** [Kernel Growth checks](../../services/kernel/README.md#growth-checks)
owns the measurement API and attribution rules, together with the Performance manifest and Goal.
[Classification](growth-classification.md), [plan stability](growth-check-plan-stability.md) and
[uncertainty calibration](growth-uncertainty-calibration.md) are evidence, not new tolerances or
permission to change fixtures. Primary-source backing is **partial**: the first two studies cite
papers and upstream implementations; calibration is a local experiment whose recorded invocations
exited nonzero, not a green campaign. PostgreSQL documents actual plan/buffer and nested-statement
logging, but supplies no universal classifier tolerance or three-scale complexity theorem.
[PostgreSQL auto_explain](https://www.postgresql.org/docs/19/auto-explain.html), accessed 2026-10-30.

**Complete contributor journey.** Contributor CLI selects an owner growth suite through
`bun run --cwd services/kernel check <files>` (or its owning workspace runner) -> `checkGrowth`
seeds isolated native resources -> instrumented production pools capture the operation and
PostgreSQL execution plans -> shared cost/classification produces per-scale repetitions,
occurrence/error/backend attribution, verdicts and optional `GROWTH_PROFILE` JSON lines -> the
contributor receives a result, `GrowthBoundError`, or visible inconclusive diagnostic/report.
There is no product UI/API, and none is required. This CLI command is descriptive, not run here.

The ordinary harness uses three to five scales, normally 1/8/64, with warm-up and measured
repetitions; discovery explicitly overrides scales to 64/512/4,096. Grow unrelated population,
history and relevant supporting relations independently while fixing selected keys/fanout.
Grow actual affected input separately for change-proportional jobs. Real row shapes, selectivity,
relation footprints and native Access matter; synthetic statistics or a forced plan cannot
replace physical work. Small reference relations need not grow merely to force an index.

Capture includes rows removed, loops, shared hits plus reads, statement/wire bytes, nested SQL,
all participating backends and causal async work. A failed statement still counts and retains
SQLSTATE; PostgreSQL supplies no completed plan for its missing row/block cost. Completed work
before abort remains charged. Preserve inclusive totals and per-attempt records through retries;
do not replace them with committed-attempt cost. Independently scheduled background statements
are reported separately with bounded application-relation work per statement; DBOS-only history
is reported but is not proved bounded by an application-only grow function. Missing capture is
not zero. Planner estimates and returned rows are not physical-work evidence.
[PostgreSQL EXPLAIN](https://www.postgresql.org/docs/19/using-explain.html), accessed 2026-10-30.

**Concrete gap.** `services/kernel/test/support/growth-counters.test.ts` now exists. Its five
tests cover numeric limits, counted growth, report/profile medians, missing units and backend
connections. They do not contain the reserved `counted-unit-ceilings-at-three-scales` scenario
covering all required physical/wire/native units. The implementation's `countedViolations`
compares the per-scale median to an absolute limit; the discovery contract additionally requires
every repetition to meet its ceiling. Retaining repetitions makes a native assertion possible,
but the present counters suite is not proof of that obligation. Preserve the five existing
`growth.test.ts` frozen scenarios and all existing counters tests; add the missing whole capture
scenario through its owner. Neither file presence nor the stale manifest advances a stage.

## Cross-cutting audit page: hot-path-bounds

**Authority and evidence.** Each module's Cost subsection owns its operation derivation;
[Kernel](../../services/kernel/README.md), [Search](../../services/kernel/src/search/README.md),
[Library](../../services/kernel/src/library/README.md) and verification are the relevant owner
documents here. The [cost audit](performance-cost-audit.md) inventories command, receipt, Access,
validation, read, relay, projection, cleanup and durable-wrapper seams. Its literal-table counts
are historical: current verification permits Operation headings with Touches/Bound/Growth check
bullets. Do not turn its prose-only-table findings into current missing-design counts.
[Access](growth-shadow-triage-access.md), [Content](growth-shadow-triage-content-a.md),
[further Content](growth-shadow-triage-content-b.md) and [other-module](growth-shadow-triage-other.md)
triage distinguish algorithm, fixture, bound/model and state-noise causes. Primary-source backing
is **partial**: local SQL/tests and some measured profiles support specific findings; PostgreSQL
and the classification studies explain mechanisms, not every operation's native pass.

**Product journey and exact missing link.** The Web route inventory in the
[page-story map](../development/page-stories.md#appswebsrcroutessearchtsx) names
`apps/web/src/routes/search.tsx`; Search uses `POST /v1/subjects:search`. Semantic's PostgreSQL
catalogue truth and command outbox feed relays/default Search indexing, which re-read current
source state and replace/delete OpenSearch documents before checkpoint advancement. Search
queries the projection, checks current disclosure and returns hits for the visible search page.
This describes the designed UI <-> HTTP <-> storage <-> async projection <-> output journey;
it is not a newly accepted full-stack result. The precise open seam is complete current
query-level privacy/source observation, repair acknowledgement and native consumer composition,
including negative predicates and order, rather than only returned-hit checks.

The [public-filter native study](public-filter-native-cut-current.md) explains why ordinary
checkpoints, refresh completion or current positive-hit checks cannot certify stale exclusion.
The [Search closure proposal](../search-composed-closure-plan.md) consumes the existing source
and consumer protocols; it does not implement them. Keep the existing source, consumer,
owner-observation and coverage writers and shared summary repair as the sole implementation
owners. Missing composed proof does not establish that their delivered source is missing.

**Required operation closure.** Audit `read-bound`, `write-bound`, `access-bound`,
`validation-bound`, `projection-bound`, `cleanup-bound` and `job-progress-bound` against an
existing exact scenario, not merely an existing filename. Include authorization before receipt
replay, rejected/hidden/empty requests, deep keyset pages, aborted attempts and retries, and
bounded resumable cleanup. An inner primitive check does not cover a wrapper's added fresh-human,
metadata, release, native disclosure, DBOS persistence or transport work. Rows/statements stay
constant and indexed blocks logarithmic at fixed admitted neighbourhood; total finite input
and real affected fanout may be linear, with bounded steps and separately seeded fanout axes.

The manifest's tracked suite inventory and Cost verifier are useful navigation and citation
validation. They do not prove capture completeness or derivation correctness. Existing triage
also cannot justify increasing uncertainty to absorb unseeded supporting history. Preserve the
current classifier's explicit inconclusive diagnostics, retry SQLSTATE handling and independent
background attribution; a compatible/inconclusive result is not complete native proof.

## Cross-cutting audit page: composed-discovery-cost

**Authority and evidence.** [Filtered lists](../filtered-lists.md#cost) owns meaning and numeric
budgets; [Library and Collections](../library-and-collections.md),
[owner queries](../library-owner-queries.md), [Dynamic Collections](../dynamic-collections.md),
[Zones](../zones.md) and the Search README own their runtime boundaries. The
[gap inventory](api-acceptance-gaps.md#definitions-and-fixtures-the-missing-cases-require) owns
released fixture names. The Search closure proposal is an integration recommendation pending
owner adoption. Existing [Zone integration](semantic-integration-audit-zone-composition.md),
[page completion](search-pages-completion-audit.md) and public-filter research supply bounded,
historical evidence. Primary sources back measurement primitives **partially**; there is **no**
primary-source or native result proving this whole composed journey on the audited base.
The older [multi-leaf replay study](search-multileaf-final-proof-pinned-sol.md) explains a
superseded replay design's limit; it must not resurrect the old universal 256-proof budget.

**Actual journey map.** UI paths below come from the Web page-story inventory; API templates
come from the linked owner documents. Paths identify consumers, not proof that every job renders.

| Consumer                                       | Existing UI path                                                                                                                                             | HTTP boundary and storage/async/output link                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct catalogue / prepared public             | `apps/web/src/routes/search.tsx`                                                                                                                             | `POST /v1/subjects:search` -> public OpenSearch projection of Semantic PostgreSQL truth -> default relay/indexing and retained preparation where admitted -> useful ordered hits, readiness or genuine exhaustion. Complete privacy/plan binding remains open.                                                                                                                                                                |
| Curated / Everything without state / own state | `apps/web/src/routes/collections/$id.tsx`, `apps/web/src/routes/library/index.tsx`, `apps/web/src/routes/library/collections.tsx`                            | `GET /v1/collections/{id}/members` -> curated occurrences or private native owner support/truth -> bounded derived maintenance/preparation -> canonical members. Whole owner query/filter admission, complete support and Source2a/custody remain pending; tracked entries are not Everything.                                                                                                                                |
| Mounted Zone / configured TypeList             | `apps/web/src/routes/zones/$id.tsx`, `apps/web/src/routes/zones/$id_.$.tsx`; common renderer `apps/web/src/features/pages/render.tsx` named by the page plan | `POST /v1/zones/{id}:readPage`; common subject aggregate `POST /v1/pages:read` -> Zone configuration, readable scopes/mounts and owner plans -> retained source preparation/projection -> configured list. Static no-data-read pages complete; source-dependent union/direct targets remain gated and return readiness for admitted development callers. Shared TypeList filter admission is proposed, not implemented proof. |

The current scope explicitly keeps source-dependent Zones closed until polished. Required manifest
cells remain audit obligations behind that boundary, not newly public systems. TypeList Book/Recipe
configuration exists in `packages/definitions/presentation/{book,recipe}/zone.json`; its existing
type-only descriptor does not establish the requested combined predicate. Native members may
return the adopted private `202 {preparing:true}` with Retry-After and no partial members; genuine
empty is `200 {members:[],next:null}`, unavailability `503`. Static Zone runtime does not emit a
fictional preparation operation. Preparation must be real retained progress, not endless readiness.

**Bulk journey.** The [Library bulk contract](../../services/kernel/src/library/bulk-contract.md)
names `POST /v1/libraryOperations` -> `202` with operation ID and Location;
`GET /v1/libraryOperations/{operationId}` and
`GET /v1/libraryOperations/{operationId}/outcomes?limit=20&cursor=...&state=...` -> `200`;
`POST /v1/libraryOperations/{operationId}:cancel` requests cancellation. Private operation/target
storage, frozen discovery manifest, per-target receipts and DBOS recovery must lead back to
inspectable status/outcomes and changed Library cards. Shared filtered preview/capture/runtime
and a complete UI binding are the missing links; these endpoint contracts alone prove neither.

**Fixture and oracle restrictions.** Retain `words`, `classification`, `books`, `diet`, `recipes`,
`personal`, `sources`, `privacy`, actual created-ID mapping, real native Access and released
definitions. No synthetic vocabulary, private diet-label proxy or title-as-Concept replacement.
The manifest records missing released wordCount/suitableForDiet; the existing partial released
fixture builder does not prove those dependencies complete. Strictly over 1,000,000 words excludes
equality, unknowns, characters and edition pages. Combined book result is `{B-long}`; form/tag
alone is `{B-long, B-edge, B-characters}`. Quick vegetarian is
`{R-quick, R-edge, R-cooked, R-other-cooked}`; Alice's not-cooked result is
`{R-quick, R-edge, R-other-cooked}`. Commerce must adopt completed-history/query semantics before
freezing that private predicate; clearing state cannot erase completion history.

Keep anonymous/Alice/Bob, hidden subject/source, denied, empty and revoked controls distinct.
There is an explicit documentation discrepancy: the Performance manifest requests a valid
suspended bearer returning `403 account_suspended`, while current Library authority says native
suspension invalidates that bearer (`401 invalid_credentials`) and correct-password sign-in
returns `403 ACCOUNT_SUSPENDED`. Preserve both recorded obligations for owner reconciliation
before executable freeze; do not fabricate a SQL/token persona or silently weaken either test.

At 64/512/4,096, independently grow catalogue, matches, sparse nonmatches, history, owner pools,
aliases/duplicates, cursor depth and privacy reductions. Preserve first/deep/sparse pages, the
16-read/128-slot composed page, canonical duplicates, unrelated-owner history, actual repair and
nondecreasing served share, interrupted frontier resume, foreign revocation, denied/hidden/
suspended/empty cases, captured bulk population and retry/cancel/revoke. Preparation rereads at
most one step and totals linear relevant input. No slack applies to literal counted ceilings.
Direct candidates are at most `min(600,6s+3)`; ready-result candidates at most `2s+2`.
The full composed limits remain 816 candidates, 6,784 points, 14,080 examined rows, 72 statements
per backend, 96 engine searches and one connection per backend. Preserve all linked byte,
block, per-read, privacy-subset and preparation-step limits as well.

Charge inclusive query plus `readStatus`, nested work, every shard/refill/reject/reread, catalog
and shared summary work; retain exact privacy-start/privacy-final/own-rows attribution. Engine
iteration is `next_doc_count + advance_count` over the actual full query tree, not returned hits
or a separate uncharged profile query. If final coverage probes active XIDs, independently hold
1/8/64 allocated transactions at fixed data; the adopted bound has no active-XID term. The
manifest's `test/performance/composed-discovery-user-cases.test.ts` remains absent. No reserved
scenario name is executable red evidence, and older standalone or 256-proof checks cannot replace it.

## Operational tooling and research handoff

[Scripts](../../scripts/README.md#check-cost-ledger) owns run-ledger/resource accounting and
admission. Slot wait is queue time, not a stalled test. Phase timings, check-hours and memory
GiB-hours support contributor operations; they are not a public product system or asymptotic
proof. Matched cold/warm comparisons precede savings claims. No host or benchmark was run here.
Minimal mode leaves native HTTP/default-worker, database and UI recording checks to integration;
the Display integration receives only a local Web typecheck. Existing accepted-on-dev
evidence stays trusted; current full acceptance and promoted-revision proof remain debt.

The companion destinations `performance-growth-harness-design.md`,
`performance-hot-path-bounds-design.md` and `performance-composed-discovery-design.md` under
`docs/research/` are **pending** on this base. This report does not wait for or impersonate them.
Read local research first; extend its unresolved questions instead of repeating settled studies.
Reference reading: the read-only `.reference/INDEX.md` and OpenSearch 3.9.0
`QueryTimingType.java` / `Timer.java` via the indexed clone, revision
`4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, confirm iterator names and `_count` serialization.
[Query timing source](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/query/QueryTimingType.java),
[timer source](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/profile/Timer.java),
accessed 2026-10-30; Apache-2.0 with upstream notices. No source is copied or executed.

## Actionable whole-slice gaps

| Next outcome                                                                                    | Owning boundary                                                        | Existing work versus genuinely new slice                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete counter capture with an over-limit repetition that the median would hide               | Performance harness                                                    | Extend existing counters/capture through the current writer; add the missing all-unit three-scale scenario. Manifest correction follows evidence, not file presence.                        |
| Close operation-to-Cost-to-native-bound coverage, including wrappers and failures               | Each runtime owner, Performance review                                 | Repair existing derivations/citations/fixture axes; add native coverage only for genuinely uncovered complete operations. Do not repeat historical literal-table counts.                    |
| Produce complete public privacy/source observation through repair and final consumer disclosure | Existing Semantic/Search source and consumer owners, Accounts boundary | Continue existing producer/consumer/coverage work and shared summary repair; native composed binding is missing proof, not a new competing source writer.                                   |
| Finish owner support, completion meaning, source custody and shared filtered selection          | Commerce with Semantic/Content/Accounts exports                        | Continue existing owner directory/preparation/bulk contracts; new native whole-query and captured-population scenarios must consume those producers.                                        |
| Freeze executable whole-journey scenarios without changing frozen tests                         | Performance with Search, Commerce, Semantic and Web                    | New missing composed suite; reuse owner direct/prepared checks, released fixture receipt and common renderer. Reconcile suspended-persona discrepancy with Accounts/Commerce before freeze. |
| Establish dev acceptance, UI output and promoted evidence at their actual revisions             | Runtime owners, Web and integration/promotion owner                    | Post-integration verification debt: all applicable cases, zero skips/todos, real HTTP/Access/default workers, recorded UI states and promoted checks. This audit advances no product stage. |
