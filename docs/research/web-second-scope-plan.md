# Web second scope

People can save useful Library queries, refine and scope discovery, choose rating populations, manage busy
discussions and resolve moderation through the existing site. [Public scope](../scope.md) admits these outcomes;
[Web's second-scope interfaces](../goals/web.md#second-scope-interfaces) owns the interface decisions. This plan
assigns slices and dependencies, rather than replacing the product contracts.

## Starting point and boundaries

The retained source is `66b9e2b45ba6da313f488d4ff60349ed4a73b166`. Its dev history includes the scope change
`fba75760f6`. The scope premise holds. Its existing [saved-rule editor][rule-editor], [Search refinement][refinement],
[Global rating control][rating-control] and [moderation reports][reports] make replacements unnecessary.
The missing work is the connected second-scope journey around those components, not their first implementation.

The current Goal queue already assigns Library page-story repair, session-control measurement, held SEO/document
quality work and separate Search, Commerce and Content second-scope planning. These briefs add none of those
outcomes. In particular, the delivered Home Space/question selector and Subject population chooser remain intact;
neither is a new second-scope assignment here.

Decision: extend existing routes with ten independent interface slices and small owner-backed consumer seams;
producer integration is a named contract boundary, not a reason to duplicate native logic or serialize shared files.

The continuation files below live under `.temp/continuation/` for controller intake. Each uses goal/manager `web`,
kind `interface`, default placement, a focused worker-owned test and a 300–500-product-line working slice. Every
slice updates the Web owner section and any named topic wording it changes in the same delivery. Tests should be
shorter than product changes. Existing tests asserting unchanged behavior stay intact; changed assertions are
updated and listed by that worker. No product code or frozen acceptance is changed by this planning delivery.

## Outcomes and ready briefs

| Brief | Person's outcome | Owner documents | Existing surface and size |
| --- | --- | --- | --- |
| [01 Save a Library query](../../.temp/continuation/01-save-library-query.md) | Review current owned filters and save a private dynamic Collection, then open its members or edit its rule. | [Dynamic queries][dynamic], [Collection editor][collection-editor], [Web][web] | Existing rule editor and common Collection filters; about 350 product lines. |
| [02 Advanced Collection facets](../../.temp/continuation/02-collection-facets.md) | Find released fields and page native values without losing the current selection. | [Facet transport][facets], [filtered lists][filtered], [Collection filters][collection-filters], [Web][web] | Extend the common filter overlay rather than rebuild Search refinement; about 420 product lines. |
| [03 Exact Search scopes](../../.temp/continuation/03-search-scopes.md) | Apply viewer-self Library or a reviewed exact Collection, Realm or Zone condition and recover a lost selection. | [Resource meaning][conditions], [Search interface][search-ui], [Web][web] | Existing Search condition tree, header scope presentation and request builder; about 430 product lines. |
| [04 Realm rating order](../../.temp/continuation/04-realm-rating-sort.md) | Keep Global ordering or explicitly choose one readable Realm population, with honest unavailable/suppressed states. | [Rating order][rating], [Search conditions][conditions], [Web][web] | Extend existing Search sort and reuse population presentation; about 380 product lines. |
| [05 Board pins](../../.temp/continuation/05-board-pins.md) | Recognize pinned discussions and let an admitted moderator pin or unpin one. | [Content][content], [thread interface][threads], [Web][web] | Existing BoardFeed and board caller; about 320 product lines. |
| [06 Board slow mode](../../.temp/continuation/06-board-slow-mode.md) | Understand when writing can resume, keep a draft while waiting and let a moderator set the interval. | [Content][content], [thread authoring][threads], [Web][web] | Board settings plus existing thread/reply composers; about 400 product lines. |
| [07 Thread watch](../../.temp/continuation/07-thread-watch.md) | Watch or stop watching an admitted thread for preference-governed in-app activity. | [Content notifications][notifications], [thread interface][threads], [Web][web] | Existing thread route and notification navigation; about 350 product lines. |
| [08 Public Collection discovery](../../.temp/continuation/08-collection-discovery.md) | Find and open a public Collection in Search and mixed Home without exposing its private rule or membership facts. | [Universal kinds][conditions], [Collection disclosure][dynamic-disclosure], [feed summaries][feeds], [Web][web] | Existing discovery decoder, ContentItem rows and Home renderer; about 390 product lines. |
| [09 Review and Space discovery](../../.temp/continuation/09-review-space-discovery.md) | Find and open a review or Space with the correct native identity, context and destination. | [Universal kinds][conditions], [reviews][reviews], [Community][community], [feeds][feeds], [Web][web] | Extend the same native-summary consumers with two independent variants; about 460 product lines. |
| [10 Moderator workbench](../../.temp/continuation/10-moderator-workbench.md) | Move between authorized queues and resolve a selected case with its evidence and appeal navigation. | [Content moderation][content-goal], [appeals][appeals], [existing reports][reports], [Web][web] | Compose existing board/catalogue reports, decisions and appeals; about 420 product lines. |

## Dependency and integration map

All ten briefs have empty `after`: none requires another brief's new API, schema or component. Common files,
messages, stories and owner documents are integration overlaps, not code dependencies. The existing Collection
filter/editor supports both 01 and 02 independently; the current Search request builder supports 03 and 04;
08 and 09 independently extend existing tagged discovery rows. The workbench consumes the current queues and
does not require the new board controls. No artificial chain holds idle interface workers.

| Consumer slices | Producer contract that remains with its owner | Integration rule |
| --- | --- | --- |
| 01 | Commerce: saved-rule admission, create/CAS, common dynamic members and explicit complete publication. | Use existing private create/rule routes and `id` sort. Missing execution stays unavailable; do not add an evaluator. First save stays private. |
| 02–03 | Search: count-free facets for the exact predicate, request resource admission and current scope execution; Commerce/Content/Semantic supply their native populations. | Apply the exact whole query. A rejected private/scope plan cannot become global facets or an all-result fallback. |
| 04 | Search and Content/Rating: current ordered native Realm population output and its private transport. | Reuse Global unchanged. A Web population control does not publish Realm figures or implement order by fetching aggregates. |
| 05–07 | Content: bounded pin state and authorized commands; slow-mode setting/caller eligibility; private watch state/command and notification delivery. | Use actual owner declarations when integrated. Until then a small Web read/command seam exposes unavailable, never fabricated native success. |
| 08–09 | Search: admitted kinds, comparable ranked output, kind metadata and current disclosure; Commerce/Content/Community: public summaries, lifecycle and canonical destinations. | Extend one mixed response/renderer. Do not federate browser searches, hydrate rows or invent a `review` kind when the owner uses a review thread. |
| 10 | Existing Content/Semantic report, decision and owner-resolved appeal APIs; future Content workbench producer only if it adds capabilities. | Navigate one current queue at a time; no cross-owner enumeration or replacement moderation authority. |

These are external producer obligations, not `after` references to unrelated planning tasks. A worker may implement
the interface against the documented outcome with a minimal local seam while producer work proceeds. It must name
an absent producer, preserve the installed unavailable state and distinguish source delivery from a successful
native journey. The controller joins producer source and generated clients; a fixture cannot establish that join.

## Story and acceptance boundary

Each brief names its page, states and viewer. Use the actual routed page in AppShell at phone390 and desktop1280,
both themes and all launch locales. Prefer recorded responses from the stated owner API; if the producer is absent,
label native-format illustrations and retain positive native acceptance as deferred. Add only the listed states.
Focused regressions pin the user action, exact request, refusal/recovery and late-result isolation without mirroring
implementation internals. Private selections and rows stay out of shared SSR, metadata and persistent storage.

The controller runs this task's frozen plan acceptance after integration. This documentation-only change has no
workspace typecheck or changed test file to execute. Each later interface brief names its focused Web test command.

## Sources consulted

The plan uses [public scope](../scope.md), [Web][web], its [Search capability](../goals/web.capabilities.md#search-page),
[Collection capability](../goals/web.capabilities.md#library-collections-progress-and-copies-interfaces) and
[community capability](../goals/web.capabilities.md#community-and-content-surfaces), the topic sections linked above,
[Library](../library-and-collections.md), [Search mixed-kind foundation](../../services/kernel/src/search/README.md#mixed-kind-foundation),
[mixed-kind integration](../search-mixed-kind-plan.md#selected-boundary) and the existing interface sources cited
below. Dev history and the current Goal status were consulted to avoid parallel duplicate outcomes. The read-only
reference `INDEX.md` was consulted; no external implementation or legacy source is needed for this interface split.

[web]: ../goals/web.md#second-scope-interfaces
[dynamic]: ../dynamic-collections.md#saved-queries-and-execution-admission
[dynamic-disclosure]: ../dynamic-collections.md#access-and-disclosure
[collection-editor]: ../collection-presentation.md#dynamic-editor-boundary
[facets]: ../search-facets.md#transport-and-values
[filtered]: ../filtered-lists.md#meaning-and-indexed-observations
[collection-filters]: ../../apps/web/src/library/README.md
[conditions]: ../search-conditions.md#conditions-and-resource-meaning
[search-ui]: ../../apps/web/src/search/README.md
[rating]: ../../services/kernel/src/search/README.md#global-rating-order
[content]: ../../services/kernel/src/content/README.md#global-boards
[content-goal]: ../goals/content.md#done-when
[threads]: ../../apps/web/src/threads/README.md
[notifications]: ../../services/kernel/src/content/README.md#notifications
[reviews]: ../../services/kernel/src/content/README.md#reviews
[community]: ../../services/kernel/src/community/README.md
[feeds]: ../feeds.md
[appeals]: ../../services/kernel/src/content/README.md#appeals
[rule-editor]: ../../apps/web/src/library/collection-rule-editor.tsx
[refinement]: ../../apps/web/src/search/refinement/refinement.tsx
[rating-control]: ../../apps/web/src/search/sort.tsx
[reports]: ../../apps/web/src/moderation/reports-page.tsx
