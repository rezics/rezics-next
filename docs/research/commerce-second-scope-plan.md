# Commerce second scope: saved dynamic Library queries

People save a private Library view, return to a meaningful current result, and explicitly share only a complete
published subject set. This plan turns the second-scope kernel outcome in [public scope](../scope.md) into eight
product briefs. Web owns the saved-rule interface; this batch owns native storage integration, evaluation and
sharing. Advanced catalogue facets, text/rating sorts and other Goals' discovery systems are separate outcomes.

## Owner decisions

Decision: deliver through the installed saved-rule, Source, Members and explicit Publication contracts with `id`
order; keep query meaning private and add no query grammar, sort family or publication engine.

The [dynamic owner contract](../dynamic-collections.md#saved-queries-and-execution-admission) owns the saved body,
CAS, pinned meaning and execution. [Library and Collections](../library-and-collections.md) owns personal fact
meaning and common Collection identity. The [Library Goal](../goals/library.md) remains under commerce, as the
[Commerce Goal](../goals/commerce.md#scope) requires. Second scope opens execution/sharing delivery; it does not
restart those first-scope obligations or move them to another Goal.

Default private views evaluate the existing Everything population and an admitted rule: labels, sessions and
holdings can establish presence without an exclusive entry state. Saved IDs are ordinary Collection IDs. Curated
occurrences and immutable Everything/state/Liked identities retain their existing meanings.

## Retained-source premises

The clean starting revision is `66b9e2b45ba6da313f488d4ff60349ed4a73b166`. Its `dev` history already includes
`fba75760f6`, which moves user-saved queries to second scope. No merge or cherry-pick is needed.

There is substantial implementation to finish composing, not a missing saved-query subsystem:

- [Rule storage/admission](../../services/kernel/src/library/collection-rules.ts),
  [commands](../../services/kernel/src/library/collections.ts) and
  [routes](../../services/kernel/src/library/collection-routes.ts) already support saved definitions, revisions
  and private editor operations. Non-private saved creation currently refuses with `dependency_unavailable`.
- [Saved admission](../../services/kernel/src/library/owner-filter.ts) loads the accepted release and combines
  request filters with the saved meaning. The [native read binding](../../services/kernel/src/library/owner-filter-native-binding.ts)
  also compares that release to the active release; the two-release journey must reconcile this with historic pins.
- [Collection Source](../../services/kernel/src/library/collection-source.ts),
  [native source selection](../../services/kernel/src/library/collection-source-native.ts),
  [owner pages](../../services/kernel/src/library/owner-filter-plan.ts) and
  [Members preparation](../../services/kernel/src/library/members-preparation.ts) have bodies. Missing current
  native observations remain unavailable; neither source presence nor structural typing proves useful results.
- [Publication episodes](../../services/kernel/src/library/collection-publication-episodes.ts),
  [service](../../services/kernel/src/library/collection-publication-service.ts),
  [staging](../../services/kernel/src/library/collection-publication-staging.ts),
  [final activation](../../services/kernel/src/library/collection-publication-final.ts) and
  [recovery work](../../services/kernel/src/library/collection-publication-work.ts) already exist. Complete their
  actual saved-source/provider bindings instead of recreating their declared APIs.

Some owner inventory paragraphs still describe factories or publication bodies as absent. The linked production
sources take precedence for implementation presence; required behavior and unmeasured native acceptance remain
unchanged. The dynamic owner section is corrected alongside this plan.

The required Goal status read showed first-scope Commerce measurement work, a retained Library schema task and
Web's second-scope planning. These briefs do not requeue those checks, rewrite the Library schema, rebuild the Web
editor, or assert that earlier integrated implementations passed native acceptance. At dispatch, retain any newly
delivered matching behavior and complete only the remaining outcome.

## Ready product slices

Each file lives under `.temp/continuation/` for controller harvesting, keeps goal/manager `commerce`, and omits
model/effort. Estimates are product lines, not a target to fill. Each brief owns its few native outcome cases and
updates its behavior owner document in the same landing; tests remain shorter than the product change.

| Brief | Usable outcome and completion boundary | Owners and installed seams | Product estimate |
| --- | --- | --- | --- |
| `01-saved-query-members.md` | Save a private view and get useful unique members, including clear/Undo and state-free presence. Finish common native binding, preserving existing command outcomes. | [Dynamic saved rules](../dynamic-collections.md#saved-queries-and-execution-admission), [native OWNER directory](../library-owner-queries.md#native-candidate-support-and-complete-observations); `collection-reads`, `owner-filter-plan`, `owner-filter-native-binding`. | 450 |
| `02-saved-query-pins.md` | Reopen a saved A rule after release B; edit once with CAS/replay, while rename preserves rule meaning and generation. | [Saved meaning](../dynamic-collections.md#saved-queries-and-execution-admission), [owner admission](../library-owner-queries.md#viewer-self-binding-and-admission); `collection-rules`, `owner-filter`, `collections`. | 350 |
| `03-saved-query-preparation.md` | A sparse mixed catalogue/private query reaches a useful page after finite preparation and crash recovery. | [Dynamic bounds](../dynamic-collections.md#query-identity-and-cursor-bounds), [shared cost](../filtered-lists.md#cost); existing Members reserve/read/work and `preparation-native-reader`. | 480 |
| `04-saved-query-privacy.md` | Next-read private changes and complete negative/order dependencies retire stale answers without stalling on unrelated work. | [Current query privacy](../filtered-lists.md#current-disclosure-and-query-privacy), [owner absence](../library-owner-queries.md#absence-readiness-and-disclosure); native binding/closure and prepared reader. | 450 |
| `05-saved-query-publication.md` | Explicitly publish an exhaustively evaluated saved set through the existing operation/status API, with replay-safe staging and current final authority. | [Whole-query publication](../dynamic-collections.md#selected-whole-query-publication-contract-native-bodies-pending), [Source publication](../collection-source.md#admitted-access-and-publication); native episode/work/staging/final APIs. | 500 |
| `06-saved-query-sharing.md` | Open public/unlisted results as owner, other or anonymous; enable non-private creation only with actual provider admission, exposing no private rule/facts. | [Dynamic disclosure](../dynamic-collections.md#access-and-disclosure), [Source selection](../collection-source.md#authority-and-source-selection); `collections`, `collection-reads`, routes and activated output. | 400 |
| `07-saved-query-refresh.md` | Replace complete A with complete B, or withdraw visibility immediately, defeating delayed old workers and projections. | [Dynamic disclosure](../dynamic-collections.md#access-and-disclosure) and [publication](../dynamic-collections.md#selected-whole-query-publication-contract-native-bodies-pending); existing rule/source generations, episodes and output hooks. | 450 |
| `08-saved-query-lifecycle.md` | Delete/Undo a saved view; terminal deletion purges private rules/results and freezes only eligible completed public A, never pending B. | [Dynamic lifecycle](../dynamic-collections.md#account-deletion-and-adopted-public-output), [deletion](../deletion.md), [native inventory](../../services/kernel/src/library/README.md#retention-inventory); Collection retention and existing Library erasure participant. | 450 |

## How the outcomes compose

Private members (01), retained meaning (02), finite preparation (03) and complete currentness (04) compose the
private saved-view journey. Explicit complete publication (05) feeds the public/unlisted reading journey (06).
Refresh/revocation (07) and lifecycle (08) preserve that journey across changes and deletion. Completion requires
all relevant native producer bindings; a helper landing alone cannot advertise the composed journey as ready.

There are no new sibling exports, schemas or executable discriminants on which another brief must compile. Every
brief consumes the already installed contracts linked above, so all `after` arrays are empty. This is product
composition order, not a fabricated code dependency or serialization for overlapping paths. If dispatch discovers
a genuinely new producer export is necessary, bind its actual queued task as a dependency then; filename strings
cannot be used as task IDs by the continuation harvester.

Cross-Goal prerequisites keep their existing owners: Semantic supplies immutable definitions and complete scoped
identity observations; Search supplies catalogue compilation, whole-query privacy acknowledgement and mechanical
scope evaluation; Accounts supplies current Access, operational transactions, durable initiators and terminal
fences. Consume those documented ports or a minimal adapter to them. Missing evidence stays explicit 202/503 or
unsupported 422 as specified; it is never a fabricated successful empty result or a second authority.

## Acceptance ownership

Keep the original [dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts) and
[Collection rule HTTP cases](../../services/kernel/test/library/collection-rules-http.test.ts). Brief 01 reuses
existing native creation/CAS/replay/clear/Undo cases instead of duplicating them. Brief 06 updates only the old
unconditional public-creation expectation when a complete provider exists, preserving the missing-provider 503
case. Briefs 02–08 add small scenario files named in their contracts for the distinct edges above. No frozen test
is edited by this planning task; workers reconcile a frozen contradiction through its owner.

No interface stories are assigned here: Web's planning owns the saved-query editor and its named states. No
product workspace changed in this task, so there is no workspace type-check or changed test file to run. Native,
browser, growth and frozen acceptance execution is deferred to the controller after integration; this plan claims
ready briefs and adopted sequencing, not a runtime or promotion result.
