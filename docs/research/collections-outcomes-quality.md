# Common Collection outcome quality review

Reviewed 2026-11-03. **Library Done when 1 and 4 remain unverified.** This review identifies the current
source bindings, frozen cases and missing measurements; it records no native pass or newly observed test failure.
The final controller launch policy defers acceptance/native/browser/root/worker-check execution until integration.
Consequently the requested current-dev complete evidence cannot be supplied by this attempt. That is a missing
measurement, not an infrastructure failure, a passing check, or a reason to start another implementation.

## Bound source and evidence limits

- Clean retained worker source: `cd29239f653033662b56e8b7e553f753b7db878d`.
- Captured read-only `dev`: `9c22ac533be07f70aa231b0f00895d969a7b3ad7`, dated
  `2026-11-03T07:34:52+08:00`. No merge, cherry-pick, rebase or promotion was performed.
- `git diff --name-status cd29239f653033662b56e8b7e553f753b7db878d
  9c22ac533be07f70aa231b0f00895d969a7b3ad7 -- <selected paths>` exited **0 with no differences**.
  The selections covered `services/kernel/{src,test}/library`, the three original outcome specifications below,
  their dynamic/shelf driver declarations, the cited Library owner documents, Content's four `liked-*` read files,
  and the two Zone tests below. This establishes source equality for that inventory, not whole-kernel dependency
  equality or execution against dev. The recorded dev hash is immutable; it is not a claim about a later dev head.
- Earlier evidence: [Library Goal acceptance](../goals/library.md#acceptance) explicitly calls its native binding
  provisional, names unavailable dependencies and leaves native/growth/main proof pending.
  [Design status](design-status-commerce.md), especially “Curated Collections” and “Built-in dynamic membership,”
  is historical inventory, not current native output. Some missing-source descriptions are stale, as detailed below.
  Neither document supplies an exact current-dev runner exit or complete persona/case recording.
- Local `.temp/goal` contained no matching retained quality-run evidence. An attempted supported historical inbox
  lookup, `bun tools/goal/src/cli.ts inbox log --to commerce --grep bd18969f --limit 8 --json`, exited **1**:
  `Error: workers cannot read the shared manager inbox`. This is an inspection permission boundary, not a kernel
  acceptance result. No repeated inbox lookup or bypass was attempted. Manager-held evidence remains uninspected.
- No test process/check UUID, raw test log, native capture, database fixture, browser recording or promotion proof
  was created. Evidence paths in this review are source/specification paths, not fabricated execution artifacts.

Decision: deliver the source-bound review now, keep all unrun native outcomes non-green, and leave execution to
the existing integration verifier and repairs to their existing owners. This decision was sent to Commerce through
`bun tools/goal/src/cli.ts inbox send commerce info '<decision>'` (exit **0**).

## Authorities and test inventory

The exact Goal clauses under review are:

> Curated and built-in Collections share identity, visibility, common members/filtering, ordering where applicable,
> notes, follows, export and Zone mounting. Curated duplicate occurrences stay editable; removing a mount does not
> delete its Collection.

> Everything, state, Liked, Continue and canonical browsing meet the adopted native owner-query/disclosure contracts.
> Filtering and owner-local plans work wherever the common Collection abstraction appears, with next-read owner-write
> visibility, honest preparation/unavailable responses and bounded native work.

[Library and Collections](../library-and-collections.md), [Dynamic Collections](../dynamic-collections.md),
[owner queries](../library-owner-queries.md), [Continue](../library-continue.md),
[filtered lists](../filtered-lists.md), [Collection presentation](../collection-presentation.md), and
[Collection Source](../collection-source.md) retain sole behavior authority. This report adopts no new runtime,
budget, public DTO or permission rule.

Paths in the table are relative to `services/kernel/test/library/` unless explicitly prefixed.
All coverage below is **assertion inventory, not executed coverage**.

| Required dimension | Existing original/native oracle | Remaining coverage limit |
| --- | --- | --- |
| Curated plus Everything/state, common identity, visibility and pages | `dynamic-outcomes.test.ts` imports unchanged `specs/dynamic-collections-outcomes.test.ts`; original cases at 349, 420, 438, 473 and 1192 cover shared page, multiple profiles, empty identity, accepted meaning and discriminated DTOs. | Original scenarios do not establish all Liked or ordinary saved-rule journeys. |
| Ordered duplicate occurrences and notes | Original dynamic case 394; `specs/library-outcomes.test.ts:351`; `collection-http.test.ts:354`; `collections.test.ts:273`. | Preserve occurrence editing separately from canonical unique browsing. The original duplicate assertions remain unchanged; a different browsing contract cannot be used to silently waive them. |
| Owner, foreign, anonymous, suspended; private/public/unlisted | Original dynamic cases 349, 566, 594; original Library cases 292, 418, 979; `collection-http.test.ts:378,399,581`; released `collection-user-cases.test.ts:719,750`. | Common dynamic export/mount personas and all source kinds still need actual native results. |
| Everything independent state/label/session/holding union, supported state siblings, clear/Undo | `builtin-runtime-user-cases.test.ts:86,120,165,198,211,251`; `owner-filter-native-closure.test.ts:44,116,164`. | Source existence and closure tests do not prove a complete mounted default runtime. |
| Liked, empty and reaction-only membership | Built-in discovery case at `builtin-runtime-user-cases.test.ts:4`; default unavailable-source case at `builtin-runtime-default-binding.test.ts:8` creates a real reaction and addresses Liked. | Discovery/immutable-rule coverage and an intentional 503 fault are not positive like→love→clear or reaction-only useful-page evidence. A complete current run of those outcomes was not supplied. |
| Ordinary saved dynamic | `collection-rules-http.test.ts:22,61,96,117,123`; `collection-rule-read-http.test.ts:33,49,69,110`. | Retained private meaning, CAS/replay, clear/Undo, suspended credentials and honest public-provider unavailability have source cases; their existence proves neither public execution nor a native pass. |
| Continue | `continue-user-cases.test.ts`, with released-data state/session and privacy cases; original shelf case 886. | Continue is a separate owner read, not another built-in Collection kind; its GET starts no preparation. Shelf ordering alone does not prove this independent union. |
| Sparse useful pages, genuine emptiness and direct cursor retries | Original dynamic cases 552, 652, 685, 867, 915, 979; released `collection-user-cases.test.ts:401` onward, including 680, 719, 750 and 772 onward. | Require repeated identical cursor reads, source/filter/viewer binding, full-or-final output and finite retained progress; no current response/cost recording exists. |
| Follow, export, bulk and mounted identity | Original dynamic case 709; original Library case 819; `follows.test.ts:369,503,534,568`; `services/kernel/test/zones/membership-contract.test.ts:236,340,372`. | Dynamic export/mount driver calls are unavailable. Zone cases cover native storage/API composition, but do not supply the full real-Auth persona matrix. Bulk stays with its existing durable owner. |
| Shelf next-read activity, keysets, progress and private facets | `shelves-outcomes.test.ts` imports unchanged `specs/library-shelves-outcomes.test.ts`; cases 325–602, 743–997, 1071–1237, 1343–1552. | Type-change/redelivery/fault seams and shaped growth fixtures are incomplete. Personal shelf results cannot substitute for common Members integration. |
| Bounded native preparation and growth | Original dynamic cases 778, 915, 1258; original shelf case 1260; `collection-source-native-growth.test.ts`, `growth-collections.test.ts`, `members-preparation-native.test.ts`, `members-preparation-durable-native.test.ts`. | No current inclusive per-backend measurements or useful prepared-page completion result was captured. |

The dynamic/shelf wrappers each set their native driver path and import the original specification, without assertion
rewrites. [Native conformance](../../services/kernel/test/library/support/native-conformance.ts) and
[outcome driver](../../services/kernel/test/library/support/outcome-driver.ts) use the existing isolated fixture,
Auth service, Access, compiled releases, kernel and worker infrastructure. Missing bindings throw explicitly.
Some smaller module/Zone suites use their own fixture credentials: their results must be labelled by that actual
boundary rather than promoted into real-Auth acceptance. Do not replace any fixture with a modeled backend or
fabricate successful dependencies to obtain a green result.

## What is missing versus genuinely empty

The current source is more advanced than historical prose suggests:

- [builtin-identity.ts](../../services/kernel/src/library/builtin-identity.ts) derives Everything, state **and Liked**
  identities. [liked-source.ts](../../services/kernel/src/library/liked-source.ts) calls the actual Content exports
  in [liked-read.ts](../../services/kernel/src/content/liked-read.ts): raw like/love paging, current membership and
  exact bigint source version. Do not commission a second Liked identity/reaction producer based on older README
  wording. Complete Source/current-disclosure integration and positive outcomes remain unproved.
- [collection-source.ts](../../services/kernel/src/library/collection-source.ts:335) has a real authorization and
  maintained-canonical-generation composition. Its `ready` branch accepts curated/private-built-in authority and
  rejects other authority kinds or a nonready generation with `dependency_unavailable`. It does not certify public
  or frozen output merely because native explicit-output rows exist. Raw ordinal reading is not canonical readiness.
- [collection-source-native.ts](../../services/kernel/src/library/collection-source-native.ts:409) observes stored
  metadata; a missing header with a built-in reference is explicitly unavailable. A missing reference does not
  establish that a known logical owner's facts are empty. Native input rows, source-version counters, structural
  owner directory coverage and accepted meaning are necessary inputs, not complete identity/disclosure authority.
- [members-preparation.ts](../../services/kernel/src/library/members-preparation.ts:754) can recover retained
  immutable meaning, but `readWorkDefinition` returns `null` until the complete Source declaration/physical
  execution authority is connected. [members-preparation-work.ts](../../services/kernel/src/library/members-preparation-work.ts)
  explicitly throws `dependency_unavailable`; even an empty work input cannot complete successfully. Reservation,
  touch, ENQUEUED status and step admission are real narrower seams, not ready results.
- [native-dynamic-driver.ts](../../services/kernel/test/library/support/native-dynamic-driver.ts:128) explicitly
  lacks mount, export, durable bulk, preparation observations, complete inspection, population growth and
  owner/Search work measurements. Private subject provisioning and state-reference repair observations are also
  unavailable. [native-shelves-driver.ts](../../services/kernel/test/library/support/native-shelves-driver.ts:50)
  lacks digest/fault latches, native primary-type change/redelivery and shaped growth seeding. These are source
  binding gaps already on the retained base, not observed transient service failures or new regressions.

Apply the existing response distinction, including during retry:

| Native state | Required public result | Evidence needed |
| --- | --- | --- |
| Complete admitted/current observation, genuinely exhausted | `200 {members:[],next:null}` | Complete finite population, current original/terminal disclosure and final source checks; released contradictory-filter cases are useful empty-result controls. |
| Actual retained preparation underway | Members `202`, exactly `{preparing:true}`, `Retry-After`, private/no-store | Real committed episode/intent, retained frontier and eventually useful result; same validated URL/filter/cursor on retry. |
| Missing Source, physical execution authority, dependency or useful work | `503` readiness/unavailability | Exact native error and phase; no members, fake next page, manufactured zero or successful empty export. |
| Unsupported admitted query shape | `422 unsupported_query` before enumeration | Actual admission refusal, not a fallback scan. |
| Zone retained progress | Existing Zone `202 {next}` transport | Its own opaque continuation/current authorization; never substitute the Members wire shape. |

The original dynamic test at 566 already expects the native suspended old bearer to return
`401 invalid_credentials` with its Bearer challenge. The newer owner-query persona authority supersedes older
hypothetical valid-suspended-token 403 prose. Do not invent a suspended token or weaken that assertion.

## Clause gaps and bounded repair proposals

Every item below is **missing/unmeasured current native evidence**, with static source limitations where stated.
There is no observed assertion failure, flaky rerun or pre-assertion infrastructure failure in this attempt.
The proposals describe outcomes for existing owners; none is dispatched or installed as another continuation.

| Exact owner-clause text | Reproduction or missing observation | User-visible repair outcome, likely paths and bounded next brief |
| --- | --- | --- |
| Goal 1: “Curated and built-in Collections share identity, visibility, common members/filtering, ordering where applicable, notes, follows, export and Zone mounting.” | Commands D/N/Z below are unrun. Dynamic case 709 reaches explicit unavailable export/mount bindings; source readiness rejects unsupported public/frozen authority. Identity/Content primitives already exist. | Existing Library/Source and held export/whole-filter owners should bind one actual Collection identity across the already adopted surfaces. Limit the next slice to the existing native callable/fixture boundaries, then run the untouched case. Likely `collection-reads.ts`, `collection-source*.ts`, `builtin-runtime*.ts`, `support/native-dynamic-driver.ts` and the current export consumer. No new producer or duplicate consumer. |
| Goal 1: “Curated duplicate occurrences stay editable; removing a mount does not delete its Collection.” | Original dynamic 394 and original Library 351 retain duplicate/note/order assertions. Zone 236 verifies mounted union uniqueness, not the complete remove-mount-and-reread-Collection journey. Current native result for removal/preservation is missing. | Existing Collection editor and Zone owner should demonstrate two independently editable occurrences, removing only one occurrence/mount and rereading the surviving Collection/notes. Likely `collections.ts`, `collection-reads.ts`, existing member/mount routes and native fixtures. Bound follow-up to that end-to-end preservation cell, retaining canonical browse semantics. |
| Goal 4: “Everything, state, Liked, Continue and canonical browsing meet the adopted native owner-query/disclosure contracts.” | Commands N/G unrun. Liked identity/raw/version reads exist, but discovery and an intentional unavailable-source test do not prove reaction-only membership. Original driver cannot provision the genuine private-subject fixture needed by dynamic 566/915. | Existing Source/identity/disclosure owners should connect the current callable prerequisites, not recreate identity/reactions. Native outcome: correct independent union, all supported state siblings, like/love/clear, active session-only Continue and current original AND terminal eligibility. Likely `builtin-runtime-query.ts`, `collection-source*.ts`, `owner-filter-native*.ts`, `continue-query.ts`, Semantic's existing scoped observation owner and native fixtures. Separate the missing positive Liked oracle from producer work. |
| Goal 4: “Filtering and owner-local plans work wherever the common Collection abstraction appears” | D/N/Z unrun. Released common-filter cases cover curated/Everything/state and public editor versus anonymous behavior; they explicitly exclude numeric growth and whole-query repair/ACK proof. Saved-rule/public output and mounted composed disclosure still need current execution. | Reuse the held whole-filter consumer and existing Search/Semantic producer owners. Deliver useful same-meaning filter pages on each actual source, including excluded/NOT/order dependencies, without public private-fact copies. Likely `owner-filter-plan.ts`, existing Search scope integration, `collection-source.ts` and Zone's current composition. Bound proposal to missing composition cells after producer release, not a second filter engine. |
| Goal 4: “with next-read owner-write visibility” | Original dynamic 552, saved-rule HTTP 96, released common-filter clear/completion/old-continuation cases and shelf transition/keyset cases are unrun. No prepared-view before/write/next-read capture exists. | Existing Library fact/query owners should show the next owner read observes committed state/label/session/holding and reaction changes, while public completed output/cursors stay unaffected by unrelated private changes. Likely `owner-write-sequence*`, existing fact-version hooks, `owner-filter*`, `liked-source.ts`, `continue-query.ts` and original native fixtures. Bound to current-source invalidation and exact retry cases; no new write order or fact authority. |
| Goal 4: “honest preparation/unavailable responses” | D/P unrun; native reservation tests do not reach completed useful-page readback. `readWorkDefinition` lacks bound Source authority and the registered worker body explicitly refuses. | Reuse the sole Members status-first retained integration owner at its supported checkpoint, followed by its existing funding/completion owner. Deliver status/read recovery first, preserving Collection/filter/cursor; missing authority stays 503, committed work 202, completed useful results 200. Likely `members-preparation*`, existing collection routes/reads/work registration and current Web read/status regions. Do not start another Members producer, completion writer or whole-filter consumer. |
| Goal 4: “and bounded native work.” | Original dynamic 778/915/1258 and shelf 1260 lack actual measurements. Dynamic measurement/seed/reference seams throw; shelf shaped `seed` throws. No inclusive Source/History/receiving/Access/backend rows, blocks, bytes, statements, candidates, engine work or finite-progress captures exist. | Existing Members funding owner, Performance and native-fixture owners should capture the declared complete parent and every child/failed prefix at geometric scales, then demonstrate sparse first/deep full-or-final pages after finite preparation. Likely `members-preparation-budget.ts`, `members-preparation-contract.md`, Source/native work ledgers and the existing growth fixtures. Preserve C3 and original assertions; do not subtract infrastructure costs or pass on response size alone. |

The inspected sole Members owner contract, **“Finish Members preparation status and retained native integration,”**
is status-first: it names retained clean implementation checkpoint `669cf5653da227655bf8df11fa93180354370ed2`
and assigns full filtered funding/completion to its next brief. That checkpoint was neither merged nor executed
here. Its approved C3 is **16 statements for the Members-owned body**, not the entire request. The one prepaid
parent also includes constant History registration **464**, receiving/readback **429**, executor controls, Source,
Access, transfer and cleanup declarations. [The current contract](../../services/kernel/src/library/members-preparation-contract.md#cost-and-required-native-evidence)
records those prices and explicitly requires actual Pool/Source/final physical authority. This research cannot
release the missing authority, declare the status checkpoint complete, or convert those constants into extra work.

## Deferred owning commands and result classification

These are exact commands for the existing owning runner from the worktree root. **None was launched**; each has
exit **not available**, evidence path **none**, and result **deferred/unmeasured**, not pass. Preserve current runner
placement and original specs; do not force local execution, edit generated SQL bindings or bypass check admission.

```sh
# D — unchanged original dynamic and shelf specifications through native wrappers
bun run --cwd services/kernel check test/library/dynamic-outcomes.test.ts test/library/shelves-outcomes.test.ts

# N — existing common Collection/native journey mapping
bun run --cwd services/kernel check test/library/outcomes.test.ts test/library/collection-http.test.ts test/library/collection-user-cases.test.ts test/library/builtin-runtime-user-cases.test.ts test/library/builtin-runtime-default-binding.test.ts test/library/collection-rules-http.test.ts test/library/collection-rule-read-http.test.ts test/library/continue-user-cases.test.ts test/library/owner-filter-native-closure.test.ts

# Z — existing mounted union/target/continuation contracts
bun run --cwd services/kernel check test/zones/membership-contract.test.ts test/zones/page-continuation-contract.test.ts

# P — sole Members owner's named checkpoint acceptance (status/reservation, not full completion)
bun run --cwd services/kernel check test/library/members-preparation.test.ts test/library/members-preparation-native.test.ts

# G — existing native component/growth observations; cannot replace D
bun run --cwd services/kernel check test/library/members-preparation-durable-native.test.ts test/library/collection-source-native-growth.test.ts test/library/growth-collections.test.ts
```

The verifier should retain each actual invocation, captured dev commit, placement, terminal exit and raw evidence
path. Attribute a failing assertion by exact case/response; repeated inconsistent outcomes require a reproducible
flake classification, not an assumed transient failure. Missing metrics remain missing even when functional
assertions pass. A transport/bootstrap/DB/service failure before assertions is infrastructure evidence for its
existing owner; it cannot establish any product failure or pass. Any failure already on this report's base is a
baseline gap. This documentation-only change adds no product regression, new test file or changed workspace to
type-check; focused tests, workspace typing, native/browser checks and broader acceptance were not run.

## Primary-source patterns and recommendation

Existing clones were inspected as data only; nothing was installed, built or executed from them. Paths below
are relative to `/home/edge/projects/rezics/rezics-next/.reference/`; their reuse entries were added to `INDEX.md`.

| Primary source and licence | Inspected material | Implication for this stack |
| --- | --- | --- |
| PostgreSQL, commit `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License, `COPYRIGHT` | `library-shelf-maintenance/postgres/doc/src/sgml/mvcc.sgml:510–560`, read from the Git object because that path is outside the sparse checkout. [Official transaction isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html). | A repeatable-read snapshot does not automatically become current after another transaction commits. Inference: keep the native final source/disclosure checks and next-read invalidation oracle; a retained snapshot/version is not authorization. |
| PostgreSQL official [LIMIT/OFFSET documentation](https://www.postgresql.org/docs/18/queries-limit.html); same project licence | Unique ordering and the server cost of skipped rows. | Inference: stable native keysets and measured examined work are appropriate; LIMIT/response length alone cannot prove bounded deep/sparse pages. |
| DBOS Transact TypeScript, commit `980dc55095f445b189aecb59e7f3334345179f65`; MIT, `LICENSE` | `search-worker-outcome-harness/dbos-transact-ts/src/client.ts:374–432`, [pinned upstream source](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/client.ts#L374); existing `tests/client.test.ts` commit/rollback/idempotency cases at 845, 888 and 923 were located, not run. | Caller-owned transactional enqueue commits/rolls back with its writes and requires the actual system-database client. Inference: retain the existing same-client Core/DBOS intent and prove its native commit/recovery behavior; a locator or reserved workflow is not completed preparation. |

The shared pattern is to keep authoritative state, a particular read observation and durable derived work distinct,
then test their actual transaction and retry boundaries. For REZICS's TypeScript/PostgreSQL/DBOS/Search stack,
retain the existing owners, Source, shared grammar, operational intent and native runner. Adopt the missing
measurement/case matrix into the existing repair owners' acceptance, correct stale delivery descriptions only after
their owner reviews the present source, and obtain current-dev results before any completion claim. No external
code copy, new scheduler, fact mirror, promotion proof or duplicate completion writer is recommended.

Only this requested report is committed. Outside the declared report path, the shared reference `INDEX.md` was
updated solely for required source provenance; no product/specification/test/package/generated file was changed.
No continuation was enqueued and main promotion remains parked.
