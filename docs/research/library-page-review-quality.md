# Library and Collection page quality review

Source review, 3 November 2026. Bound source and recorded local `dev` both resolve to
`88a6a9c65a15ad5314f9337a2ddf4362c9df9bed`; the retained worktree was clean before this report.
This report answers which owned pages and evidence exist, and what still needs measurement against the owned bars.
**Current-dev rendered quality and Library Done-when clause 7 remain unmeasured.**

The final launch policy defers acceptance, native and browser execution to integration. Consequently this attempt
captured no screenshots, opened no rendered pages and reached no runtime assertions. It makes no visual pass/fail,
flakiness, native success, growth, main-promotion or Goal-completion claim. Missing screenshots are missing
measurements, not observed layout defects. No promotion proof is registered.

Decision: retain source-level inventory and explicit evidence gaps under the final validation policy; reuse Web's
visual-review and existing product owners rather than introduce a renderer, producer or implementation.
This decision was sent to Commerce through its supported inbox command.

## Authority and interpretation

The following are exact owner clauses. Later references to their keys retain the quoted obligation.

| Key | Owner and exact clause |
| --- | --- |
| G7 | [Library, Done when, seventh bullet](../goals/library.md#done-when): “Real APIs and storage support subject actions, Library/Collection browsing and editing, labels, copies, progress, Following and History through reviewed pages using Web's shared shell and patterns.” |
| GA | [Library, Acceptance](../goals/library.md#acceptance): “Pages need real APIs, recorded-response stories, Web visual review and representative locale/theme/device states.” |
| GP | [Library, Acceptance](../goals/library.md#acceptance): “Cover owner, another viewer, anonymous and suspended/terminal personas, Collection visibility, duplicate occurrences, CAS/replay conflicts, progress preservation, private exclusions and sparse filtered pages.” |
| GL | [Library, Acceptance](../goals/library.md#acceptance): “Unsupported native surfaces throw explicit `dependency_unavailable` errors; no missing-driver pass, modeled backend, skipped case or fabricated readiness replaces them.” |
| VC | [Capability evidence](../development/verification.md#capability-evidence): “Each Goal maintains `docs/goals/<goal>.capabilities.md`.” |
| VR | [Page story map](../development/page-stories.md): “A reference is coverage only for the state the named story actually renders.” |
| OW | [Collection presentation, Ownership and required proof](../collection-presentation.md#ownership-and-required-proof): “Web owns one actual Collection browse/editor, the independent renderer, screenshots and visual review.” |

The [sole behavior authorities](../goals/library.md#ownership-and-sole-behavior-authorities) remain in force:
personal facts/destinations in [Library and Collections](../library-and-collections.md#destinations-and-actions),
common curated/dynamic behavior in [Dynamic Collections](../dynamic-collections.md#one-collection-page),
labels in [Privacy and disclosure](../library-labels.md#privacy-and-disclosure), Continue in
[Membership and independence](../library-continue.md#membership-and-independence), and counts in
[Disclosure authority](../private-follow-counts.md#disclosure-authority).
The joint [Collection presentation/editor contract](../collection-presentation.md) owns Type/cover/FULL facts,
occurrence edits and selected-publication recovery. Its delivery tables describe staged obligations; prose saying
“missing runtime” is not independently a current-dev defect. The source inventory below is the current binding.

Commerce owns these product journeys and native Library behavior. Web owns shared shell/patterns and visual review;
Semantic owns definitions and native fact producers, Search owns its catalogue plans, Content owns image/publication
sources, and Accounts owns Access/account lifecycle. Existing Members, filter and product producers retain their
boundaries. A missing measurement does not authorize a substitute producer.

## Routed surface inventory

Paths below are relative to `apps/web/src/routes/`. Runtime URLs carry the locale prefix; TanStack's trailing `_`
is a route-tree escape and is omitted from the public URL. Query states remain on their existing routes.

| Route file | Owned page or region and source binding |
| --- | --- |
| `library/index.tsx` | Personal Library, tracked entries, Everything/Liked links, state/type/label selections, display/selection and pinned Collections; `personal-library-current`, `label-shelf-current`, `shelf-params`, subject-slot form actions. |
| `library/collections.tsx` | My Collections, previews, pins and paging; `mine-collections-route`, `mine-collections-page`. |
| `library/continue.tsx` | Dedicated Continue; `continue`, `continue-read`, `continue-address`, shared Library nav. |
| `library/following.tsx` | Following, hidden/unavailable targets, unfollow/retry; `mine-following-page`, `mine-following-actions`. |
| `library/follow-counts.tsx` | Private contextual and outgoing counts, permission/recovery states; `private-follow-counts-page`. |
| `library/labels.tsx` | Private label catalogue, prefix/paging, create/rename/delete/Undo; `labels-current`, `labels-actions`. Label membership shelves also appear on the Library route. |
| `library/copies.tsx` | Copies/holdings filter and paging, create/edit/note/status, retained historical meaning and removal/Undo; `copies-current`, `copies-actions`, `copies-query`. |
| `library/progress.index.tsx` | Progress index, subject/version choice, unknown historical meaning, continuation; `progress-page`, `progress-server`. |
| `library/progress.$id.tsx` | Session recording, exact completed units/changes, historic profile values and recovery; `progress-session`, `progress-detail-server`. |
| `library/logs.tsx` | Owner published-log history, paging and reader recovery; `my-logs-page`, `logs-server`. |
| `logs/$id.tsx` | Published log reader and owner controls; `log-current`, `logs-server`. |
| `library/operations/$id.tsx` | Durable bulk-operation recovery/status, private result report; `bulk-operation-recovery-view`, `bulk-operation-recovery-server`. No dedicated story family located in the owned inventory. |
| `library/operations/$id_.undo.tsx` | Bulk-operation Undo; `bulk-operation-undo-page`. No dedicated story family located in the owned inventory. |
| `collections/$id.tsx` | Shared curated/dynamic detail, filters, preparing/unavailable, canonical members and curated editor; `collection-page`, `dynamic-collection-page`, `collection-queries`. Occurrence notes, duplicate editing, moves, batch removal, export and access live here, not on a new route. |
| `collections/new.tsx` | Curated metadata/kind/cover creation and correction; shared `collection-editor`/presentation helpers. |
| `collections/$id_.rule.tsx` | Existing saved-rule editor; `collection-rule-current`, `collection-rule-actions`. |
| `library/rules/new.tsx` | Saved private rule creation using the same owner editor. |
| `collections/$id_.publish.tsx` | Explicit selected-publication preview/review/recovery; `collection-publication-page`. |
| `subjects/$id.tsx`, `subjects/$id_.$slug.tsx`, `subjects/$id_.$slug_.$view.tsx` | Canonical reader entry, resolved reader and selected view; Library subject slot uses `subject-slot-view` and native form actions. Subject page composition stays with its existing owner. |

Shared consumer boundaries also need integration coverage: Home's Continue source, Settings' Collection visibility,
and Zone-mounted membership. Their whole pages remain with Web/Accounts/Zones; this inventory does not claim their
unrelated stories as Library-owned. There is no separate owned `/library/history` route: session history, My published
logs and published-log detail are distinct existing destinations. Collection public ItemList export policy is in
`collection-load.ts` (`publicExport`) and the Collection story family; an export story is not evidence of complete
native export/mount execution.

## Existing API and test evidence

All source paths in this section refer to the bound dev revision. Under `apps/web/src/kernel/recorded/`, there are
19 `library*.json` response files:

- Collection detail, members and own Collections: `library-collection`, `library-collection-members`,
  `library-collections`, each with base and `-zh-Hans` files.
- Tracked and Continue entries: `library-entries`, `library-continue-entries`, each with base and `-zh-Hans` files;
  `library-continue-progress-sessions` has one file.
- Copies and Following: `library-copies`, `library-follows`.
- Progress: `library-progress-sessions`, `library-progress-session`, `library-progress-changes`,
  `library-progress-units`.
- Published logs: `library-published-log`, `library-published-logs`.

These are existing committed response operands, not fresh recordings from this review. Their top-level data contains
responses and status, without a recording-run dev SHA or native-check result. `apps/web/scripts/record.ts:664–702`
identifies the API reads and records `en`/`zh-Hans` for five localized families. In particular,
`:768–789` assembles `library-continue-progress-sessions` from multiple responses; its presence does not establish
that the dedicated Continue endpoint was captured. The recorder also sets up fixtures and exposure; replaying its
output cannot establish present authorization or exposure behavior. No fresh recorder run or schema assertion was
executed here.

Additional states are explicitly constructed by `src/kernel/fake/collection-page-stories.ts`, `collection-rules.ts`,
`collection-publication.ts`, `collection-filters.ts`, `dynamic-collections.ts`, `library-labels.ts`,
`library-label-assignments.ts`, `library-holdings-history.ts`, `copies-page-stories.ts`, `library-entry-undo.ts`,
`library-following-story.ts`, `library-pins.ts`, `library-continue.ts` and progress-profile modules.
For example, `collection-add-members-phone.stories.tsx:15` explicitly says there is no recorded add-occurrence
response. It uses the real page components with constructed outcomes. This supports authored interface scenarios;
it cannot satisfy G7's real-API evidence. The nine starting families in the brief are **Patterns** stories, not
additional Pages stories; they still belong in the review because they exercise the actual owned regions.

Existing verification inventory, with results deliberately unmeasured on this source:

| Evidence source | What is authored; what a future result could establish |
| --- | --- |
| `services/kernel/test/library/{outcomes,labels-outcomes,profiles-outcomes,dynamic-outcomes,shelves-outcomes}.test.ts` | Five wrappers retain the original frozen specifications and set absolute native drivers. Original outcomes, persona denials, growth and lifecycle need their owning runner; wrapper discovery establishes no pass. |
| `services/kernel/test/library/support/native-conformance.ts:54–55` | Missing producers throw `Native Library dependency_unavailable: <surface>`. `outcome-driver.ts:1023` refuses incomplete cross-pool cost attribution. These are explicit source limitations, not observed failing exits in this attempt. |
| `apps/web/tests/native/web-personal-driver.host.test.ts` and `specs/web-personal-outcomes.test.ts` | Original 23-case personal journey binding, each independent fixture and 180-second case bound. Covers Alice/Bob/anonymous, real pagination/state/Collection/Zone filters, private exclusions, current BFF authority, revocation/suspension, Auth and checkout journeys. The complete original wrapper must run unchanged; selecting only successful cases is not acceptance. |
| `apps/web/tests/native/{library-navigation,library-labels,native-curated-collections,native-following}.host.test.ts` | Focused native fixture sources exist for built-in navigation, labels/privacy/no-JS actions, curated edit/publication/export and Following. Their existence and assertion names are not current results or proof of discovery by the general host runner. |
| `apps/web/tests/recorded-responses.test.ts` | Existing client-schema check for recorded response shapes; shape checks cannot prove fresh native behavior. |
| `apps/web/tests/{collection-add-members-phone,collection-note-reader,collection-rule-editor-details,dynamic-collection-page-recovery,continue-reader-phone,copy-editor-phone-journey,copy-note-reader,entry-removal-undo-phone}.test.tsx` | Focused consumer/control tests for the starting regions, including bounded text, exact retry operands and keyboard reading. |
| `apps/web/tests/{library-following,follow-controls,library-collection-editing,library-collection-editing-cost,library-private-follow-counts,library-progress,library-labels}.test.ts` | Existing owner/consumer suites; their mocked or native boundaries must be read with the result, rather than inferred from filenames. |
| `apps/web/tests/{progress-index-historical-meaning,progress-history-reader-recovery,progress-log-reader-recovery,published-log-history-phone,label-shelf-table-family,subject-library-controls-presentation}.test.tsx` | Existing historical meaning, readable recovery, list/table and subject-action coverage; source-level repairs already have owners and tests. |

`docs/goals/library.capabilities.md` is absent on this source. VC therefore lacks its required per-capability command,
persona and surface-cell mapping. The five original suite links remain available in the Goal; this report does not
invent a replacement acceptance command. In `docs/development/page-stories.md`, the existing Library/Collection
sections still contain planned suspended-session cells: Collection detail has 16 planned device cells, creation and
each mapped Library route have ten. Published-log detail has 28 literal missing device cells. These counts describe
ledger text, not confirmed absence of current stories: published-log recovery stories now exist. Several actual
routes above have no heading in that map. Reconcile the ledger to source before dispatching missing UI work.

## Earlier evidence and current-source limits

[Web library launch review](web-review-library.md) is explicitly a code/document review at
`50253f81316a8e975d67971fb62ed42db3145c10`, with no screenshots or runtime checks. Its old missing-feature inventory
must not be reapplied as today's defect list: Labels, pins, Undo, progress and subject controls now have source/stories.
[Web Library design research](web-library-design.md) likewise calls its inventories partial and non-runtime.

[Quality round-three backlog](quality-round3-backlog.md#progress-index-explain-unknown-history-without-presenting-enums-as-the-task)
records an older Progress index observation and an existing Commerce repair boundary. Its source was
`4761a82e99595ca2cd4878ca26914e0f427bb634`; publication was
`d1d188d5316129d585a39bba43fca50eb358c0b3`. The earlier report names
`.temp/goal/web/research-shots/quality-round3-fresh/`, `capture-manifest.json`, and
`reporter-diagnostic.json`. The diagnostic had no PNG and incomplete failure payload, so it cannot establish flakiness.
These artifacts were not supplied in this worktree and were not opened or revalidated here.

The bound `apps/web/src/library/progress-page.tsx:84–85` now gives the continuation controls a 44px minimum;
`:1045–1066` renders an ordinary localized historical-meaning explanation and keeps raw mode/unit keys inside
closed technical details. The earlier suggested source repair is therefore already present. Reuse
`progress-index-historical-meaning.stories.tsx` and its test for rendered remeasurement; do not redispatch the old
code change. This is source confirmation, not a visual approval or runtime pass.

## Bars and bounded next review proposals

Every case below is **missing evidence or unmeasured**, with **no current screenshot path**. The requested full-size
390/1280, light/dark, locale and keyboard/touch inspection must precede any new visual-defect judgment. Exact story
IDs below are derived from source metadata/exports, not a freshly built Storybook index. Appendix references provide
the complete selected family/export inventory. Each proposal belongs in its existing owner's work; none is enqueued.

### Common measurement gap: G7, GA, GP, GL and OW

The exact clauses quoted above require real APIs, reviewed pages, representative states and the original denials;
none has a current-dev execution result here. Integration should first run the existing native entries below at a
recorded clean dev commit, retain actual exit and per-case evidence, then render its matching recorded stories.
Owner/curator, another viewer, anonymous and suspended/terminal must remain independent cases. Separate API assertion
failure, native dependency error before assertions, browser settlement/a11y failure, and missing screenshot measurement.
Call a case flaky only after attributable repeats on the same source, never from one historical timeout.

```sh
bun run --cwd services/kernel check test/library/outcomes.test.ts test/library/labels-outcomes.test.ts test/library/profiles-outcomes.test.ts test/library/dynamic-outcomes.test.ts test/library/shelves-outcomes.test.ts
bun apps/web/scripts/check.ts --personal-host
```

These are existing owning entry points, **not commands run by this attempt**. The latter retains the whole original
23-case personal suite, including its existing deterministic provider fixture; no live processor calls or invented
successful dependencies are authorized. The Goal documents deferred Auth, historical, semantic privacy, export/mount,
bulk, preparation and native observation bindings. Assign a reached missing seam to its existing producer; an
environment failure belongs to the runner's owner and does not justify speculative product changes.

For Web visual measurement, the supported screenshot runner builds once, waits for rendering/fonts, writes full-page
PNG files and fails capture errors. Its default covers all eight locales and both themes; explicit widths preserve
the two device cells in filenames (`screenshots.ts:488–489,963,1238`). For example:

```sh
bun run --cwd apps/web screenshots --story 'pages-library-*' --width 390 --width 1280 --out .temp/library-page-review/pages
bun run --cwd apps/web screenshots --story 'patterns-library-*' --width 390 --width 1280 --out .temp/library-page-review/patterns
bun run --cwd apps/web screenshots --story 'patterns-collection-*' --width 390 --width 1280 --out .temp/library-page-review/collection
bun run --cwd apps/web screenshots --story 'patterns-following-*' --width 390 --width 1280 --out .temp/library-page-review/following
```

These are deferred examples, not a complete acceptance replacement: include the subject-specific ID prefixes and
every listed export, plus shared page consumers through their owners. Intended screenshot names follow
`<story-id>.<locale>.<theme>.<width>px.png`; no file under those proposed directories exists from this attempt.
Inspect original full-size images before crops or judgments. Use all eight supported locales when practical;
at minimum make the representative `en`, `zh-Hans`, `ja`, `de` selection explicit alongside both themes/devices.
Keyboard and coarse-pointer/touch are independent states; a 390px viewport alone proves neither touch behavior nor
focus order. Verify open/close/Back/Escape, trigger focus restoration, disclosure reading and pending/retry states.

| Missing measurement and exact bar | Reproducing source case; next user-visible outcome | Existing owner and likely paths; bounded next brief |
| --- | --- | --- |
| Library/built-ins/Continue: UI **Shelves** says “Continue appears above Collection shortcuts and one paged list of tracked entries.” | `pages-library-personal-library--continue-present`, `pages-library-entries--signed-in`, `patterns-library-continue-reader--region-navigation`, `patterns-library-continue-native-binding--full-projection`; measure 390/1280 × light/dark × representative locales. PNG: none. Readers should reach truthful current Continue destinations and distinct empty/preparing/unavailable recovery without losing shelf context. | Existing Library/Continue consumers, with Web visual authority; `apps/web/src/library/{personal-library-current,continue,continue-read,shelf-view}*`, matching stories/tests. Brief only current native binding and rendered composition/recovery gaps actually reproduced. |
| Common Collection detail/filter: Dynamic **One Collection page** says “Dynamic results expose no global count.” | `pages-library-dynamic-collection--preparing`, `patterns-library-dynamic-collection-recovery--later-filtered-empty-with-next`, `--ignored-filter`; same measurement matrix, PNG: none. Sparse continuation and unavailable filtering must preserve the requested scope, with no false empty count or broader replacement query. | Existing common Members/Collection/filter owners; `collection-queries.ts`, `dynamic-collection-page*`, `collection-filters*`; bind existing producer evidence and measure real states, without a second list authority. |
| Curated edits/notes/moves/removal: joint **Batch removal and cross-Collection move** says “Preserve member IDs, notes, `addedAt` and selected source relative order regardless of request ID order.” | `patterns-collection-editor--owner-adds-occurrence`, `--lost-response-recovery`, `patterns-collection-notes--occurrence-list`, `patterns-collection-editor--selected-move`; measure note/edit/move/Undo controls across the matrix. PNG: none. Occurrences must remain distinguishable and preserve their notes/order through conflict, retry and retained removal. | Existing Collection editor and native lifecycle owners; `collection-editor.tsx`, `collection-batch-remove.tsx`, `collection-move-chooser.tsx`, `collection-move-read.ts`, kernel Library counterparts. Narrow proposal: native-backed duplicate/move/remove cases plus control-state visual review; do not label an illustrative response a successful native transfer. |
| Dynamic rule/publication/export: joint **Selected-publication recovery** says “After an uncertain selected-publication response, retain the exact request, source revision and review selection until verified completion; a refused retry or source reload cannot authorize a replacement intent.” | `patterns-library-collection-rule-details--unconfirmed-save`, `pages-library-collection-publication--retry`, `pages-library-collection--public-item-list-export-incomplete`; both devices/themes/locales, PNG: none. Keep exact private intent through uncertainty; public output must come from verified explicit publication, excluding private rule/note context. | Existing rule/publication/source and Web page owners; `collection-rule-*`, `collection-publication*`, `collection-preview.ts`, native selected-set/source producer. Brief a matching native response record and full control-state review; saved-runtime limitations remain explicit. |
| Labels/subject actions: Labels **Privacy and disclosure** says “Label definitions, names, assignments, revisions, cursors, and receipts are private owner data.” | `pages-subject-library-controls--label-picker-and-assignment`, `pages-subject-personal-labels--undo-visible`, `pages-library-labels--phone-capacity`, `patterns-library-label-shelf-table-family--authority-retired`; same matrix, PNG: none. Owners should read/edit exact labels and Undo; another viewer or retired authority must see none of that private state. | Existing label and subject-slot owners; `labels-*`, `label-shelf-*`, `subject-slot-*`, `apps/web/tests/native/library-labels*`. Reuse the native Alice/Bob/anonymous/no-JS fixture and existing capacity/recovery cases, then inspect page and subject-slot controls. |
| Copies/holdings: UI **Form fields** says “Below 768px or with a coarse primary pointer, editable controls and standard action buttons have a minimum 44px target.” | `patterns-library-copy-editor-journey--sheet-or-dialog`, `patterns-library-copy-note-reader--separate-physical-copies`, `pages-library-copies--required-release-unavailable`; same matrix, PNG: none. Distinct holdings, exact notes and retained historical labels must stay readable/editable through long content, uncertainty and missing current advice. | Existing Copies/history owner and Web shared form/popup owner; `copies-current.tsx`, `copies-page.tsx`, `copies-actions.ts`, copy editor/note tests and stories. Brief native create/edit/remove/Undo evidence and measured touch/form/focus states, retaining the established accepted-meaning contract. |
| Progress/log/history: UI **Progress** says “The bar and the number never sit on separate lines.” | `patterns-library-progress-history--missing-historical-meaning`, `pages-library-progress-session--sparse-history`, `pages-library-published-log-history-navigation--later-empty-recovery`, `patterns-library-progress-log-reader-recovery--authority-retired`; same matrix, PNG: none. Exact history remains readable without invented percentages; paging/retry and public/private log boundaries remain honest. | Existing Progress index/detail/log owners, coordinated rather than overlapping; `progress-page.tsx`, `progress-session*`, `my-logs-page.tsx`, `log-current.tsx`. Reuse the repaired historical-meaning case; measure it and bind actual histories/publication, without reopening the completed source amendment. |
| Following/counts: UI **Menu** says “Escape closes either form, and focus returns to the trigger.” | `pages-library-following--unfollow-menu-phone`, `--unfollow-menu-desktop`, `patterns-following-follow-control--ambiguous-retry`, `pages-library-private-follow-counts--independent-recovery-and-withdrawal`; same matrix plus touch/keyboard, PNG: none. People can leave unavailable targets, recover ambiguous commands and read only authorized counts without leaked identities or false zeros. | Existing Following/private-count product owner and Accounts authority; `mine-following-*`, `private-follow-counts*`, `follow-controls`, native Following fixture. Brief native current-denial/next-request evidence plus menu/focus measurement; reuse shared `Menu`. |
| Shared list/cover/form/focus bars: UI **Cover cards** says “The tile has no background, outline, border or shadow, including on hover.” **Content items** says “Buttons and links in state/action slots have at least 44 px targets, including on touch.” | `pages-library-collection--mixed-types-grid`, `patterns-collection-notes--member-list`, `patterns-library-label-shelf-table-family--narrow-long-text` and all inventory Pages exports. Same matrix, PNG: none. Covers keep member Type presentation; readable rows, independent controls and visible keyboard focus survive long translations. | Web shared components and existing consumers; `packages/ui/src/components/{cover-card,content-item,list-row,progress-row,menu}*` and Library consumers only if a reproduced defect needs them. Review shared classes first; a small icon's class alone is not a measured target defect. |
| Ledger/operation coverage: VC and VR quoted above are unsatisfied as evidence. | No capability manifest, no dedicated operation-status/Undo story family in this inventory, stale planned/missing ledger cells. No viewport screenshot exists for those route/control states here. Readers need observable status, safe read-only recovery and explicit Undo outcomes on the actual existing operation pages. | Commerce capability owner and existing bulk-operation recovery owner; `docs/goals/library.capabilities.md`, `docs/development/page-stories.md`, `apps/web/src/library/bulk-operation-*`. Bounded proposal: map original native commands/personas to current exports and supply missing route stories against existing native recovery contracts. Do not invent a new bulk protocol. |

## Primary-source comparison and recommendation

Reference clones were reused as untrusted source data; nothing in them was installed, built or executed.
The required catalogue entries were added to the main checkout's permitted `.reference/INDEX.md` under this report's
topic. Both inspected repositories use the MIT licence in their root `LICENSE` files.

| Primary source | Inspected path, pinned URL and finding |
| --- | --- |
| Primer React, `f733dcb2b086c6da7902bfecfcf68cd61c7daab3`, MIT | `.reference/storybook-practice/primer-react/packages/react/src/ActionList/LinkItem.tsx:36–100` and `Item.tsx:149–268`; [LinkItem source](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/ActionList/LinkItem.tsx), [Item source](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/ActionList/Item.tsx), [licence](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/LICENSE). LinkItem delegates shared item anatomy while preserving native navigation and an explicit inactive rendering; Item centralizes inferred roles and focus/keyboard behavior. |
| Komga, `023ec905c10a35bbb8e29095420d266cd3adad60`, MIT | `.reference/shelves/komga/komga-webui/src/components/ItemCard.vue:1–120`; [source](https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga-webui/src/components/ItemCard.vue), [licence](https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/LICENSE). A common card combines a ratio-bound thumbnail, independent edit/action controls, title destination and progress. Its hover overlay, orange progress and surface styling are product-specific, not REZICS's selected bars. |
| Playwright official screenshot documentation | [Full-page screenshots](https://playwright.dev/docs/screenshots#full-page-screenshots) describes `fullPage` as the entire scrollable page. This supports the existing runner's full-size capture requirement; a viewport-only image cannot support judging content below the fold. Documentation was consulted, not copied as code. |
| Storybook official interaction-test documentation | [Interaction tests](https://storybook.js.org/docs/writing-tests/interaction-testing) distinguishes rendering a configured story from executing its play function and assertions. Authored plays are scenarios until executed; a recorded response alone is neither an interaction result nor a native proof. Documentation was consulted, not copied as code. |

Inference from the two established component sources: shared anatomy and explicit navigation/action/state slots make
cross-surface consistency practical. Neither source proves REZICS accessibility, exact historical semantics or native
authorization. Recommend retaining the repository's React/TanStack pages, shared `ContentItem`/`MemberListRow`,
`CoverCard`/`ProgressRow`, native form fields and adaptive `Menu`. Apply fixes at the smallest existing shared or
consumer boundary after a full-size reproduced observation; copy no Vue/Vuetify or Primer implementation.

For the manager, the adoptable order is: reconcile capability/story mapping; run the original native bindings at the
bound integration revision; obtain full-size page and complex-region evidence; assign only reproduced gaps to their
existing owners. Keep the frozen outcomes and main-promotion pause unchanged. This recommendation changes no owner
contract; adoption belongs in those owner documents.

## Commands, disposition and changed paths

Source-binding commands executed successfully (exit 0): `git status --short` (empty), `git rev-parse HEAD` and
`git show-ref --verify refs/heads/dev` (the SHA above). Bounded `rg`/Python reads produced the inventory below;
temporary inventory JSON is under `.temp/` and is not a submitted runtime-evidence artifact.
The decision command was:

```sh
bun tools/goal/src/cli.ts inbox send commerce info "This review will retain current-dev source inventory and recorded-evidence gaps; the final validation policy defers all browser/native acceptance, so no visual or Goal-completion verdict will be inferred and existing Web/product repair ownership will be reused."
```

It returned exit 0. API recordings, original/native acceptance, host tests, Storybook plays/a11y, browser/touch
checks, screenshots, growth, root/worker/remote checks and promotion were **not run by policy**, with no runtime
exit code or current evidence path. No infrastructure failure or assertion failure was observed; no unavailable
check was converted into a pass. This documentation change creates/changes no tests or executable workspace, so
workspace typechecks and landing commands for changed test files do not apply.

The tracked change is this report. Outside its declared path, only the permitted reference catalogue
`/home/edge/projects/rezics/rezics-next/.reference/INDEX.md` was updated to record the two reused primary-source clones;
it is outside this worktree's commit. Temporary inventory data stays in `.temp/`. No source implementation,
generated binding, dependency manifest, frozen outcome or continuation brief is changed.

## Complete owned story-family inventory

Each row is an exact source family plus all its exported scenarios. Files are relative to
`apps/web/src/stories/`; `#Export` is the stable source reference used by the coverage map. Pages are routed stories;
Patterns exercise owned regions. Presence here records authored scenarios only. All exports remain unmeasured at
390 and 1280, in both themes, all eight locales and applicable keyboard/touch states on the bound revision.
Runtime IDs normally combine the sanitized title and export name; subject Labels and Controls provide explicit
prefixes `pages-subject-personal-labels` and `pages-subject-library-controls`.

| Source file | Story title | Exact exports |
| --- | --- | --- |
| `collection-add-members-phone.stories.tsx` | Patterns/Collection Editor | `OwnerAddsOccurrence`, `LongSubjectAndNote`, `OwnerCancelsOccurrence`, `PendingOccurrence`, `CorrectableRefusal`, `UncertainOccurrenceRecovery`, `LostResponseRecovery`, `AcceptedReloadRecovery` |
| `collection-note-reader.stories.tsx` | Patterns/Collection Notes | `OccurrenceList`, `MemberList`, `Grid`, `DisclosedRowsWithdrawn`, `NoDisclosedNotes` |
| `collection-rule-editor-details.stories.tsx` | Patterns/Library/Collection rule details | `Available`, `NarrowLongText`, `RetainedStateSet`, `UnavailableChoices`, `UnconfirmedSave`, `NewPrivateDraft` |
| `continue-reader-phone.stories.tsx` | Patterns/Library/Continue reader | `RegionNavigation`, `DestinationNavigation`, `UnavailableRecovery`, `Loading`, `Empty`, `Preparing`, `CurrentDestinationUnavailable` |
| `copy-editor-phone-journey.stories.tsx` | Patterns/Library/Copy editor journey | `Inline`, `SheetOrDialog`, `HistoricalClose` |
| `copy-note-reader.stories.tsx` | Patterns/Library/Copy note reader | `ExactNote`, `LongSourceAndLocation`, `SeparatePhysicalCopies`, `UnresolvedHistory`, `RetiredCurrentKind`, `HistoricalMeaningUnavailable`, `EmptyAndWhitespace`, `KeyboardReading` |
| `dynamic-collection-page-recovery.stories.tsx` | Patterns/Library/Dynamic Collection recovery | `FirstEverythingEmpty`, `FirstLikedEmpty`, `FirstStateEmpty`, `FirstFilteredEmpty`, `LaterEmpty`, `LaterFilteredEmptyWithNext`, `SparseFirstPage`, `LaterMembers`, `RepeatedFiltersAndKeyboardRecovery`, `Unavailable`, `Preparing`, `FilterUnsupported`, `FilterFailed`, `FilterPreparing`, `IgnoredFilter` |
| `entry-removal-undo-phone.stories.tsx` | Patterns/Library/Entry Removal Journey | `RemovalAndUndo`, `OccupiedRecovery`, `StaleRecovery`, `ExpiredRecovery`, `RestoredFullText`, `OccupiedFullText`, `OccupiedWithoutEntry`, `UnavailableResult`, `ClosedResult`, `RemovedWithoutReceipt` |
| `following-controls.stories.tsx` | Patterns/Following/Follow control | `FollowAndRemove`, `DeleteOnly`, `UnavailableTarget`, `Loading`, `Pending`, `AmbiguousRetry`, `Conflict`, `Revoked` |
| `label-shelf-table-family.stories.tsx` | Patterns/Library/Label shelf table family | `Normal`, `NarrowLongText`, `Unavailable`, `TitleOnlyActions`, `NoUnassignAdmission`, `AuthorityRetired` |
| `library-collection-access.stories.tsx` | Patterns/Library/Collection access | `Loading`, `Concealed`, `Unavailable` |
| `library-collection-dynamic.stories.tsx` | Pages/Library/Dynamic Collection | `Everything`, `Liked`, `State`, `EmptyEverything`, `RenamedEverything`, `StateOther`, `Paged`, `Preparing`, `Unavailable` |
| `library-collection-editor.stories.tsx` | Patterns/Collection Editor | `Details`, `Members`, `RowActionContext`, `Selection`, `Reordering`, `Note`, `SavePending`, `SaveError`, `DynamicRule`, `Presentation`, `RemovalAndUndo`, `ExpiredUndo`, `SelectionUnavailable`, `SelectedRemoval`, `SelectedMove`, `AddItems`, `LaterPageBoundaries`, `BoundaryPending`, `BoundaryUnknown`, `BoundaryResolved`, `BoundaryReadRecovery` |
| `library-collection-filters.stories.tsx` | Patterns/Library/Collection filters | `Reference`, `ConceptSelected`, `WordRangeApplied`, `CombinedFilters`, `NoMatches`, `Preparing`, `FilterSourceUnavailable` |
| `library-collection-patterns.stories.tsx` | Patterns/Library/Collection controls | `EditFormOpen`, `MembersReordered`, `FollowingEnabled` |
| `library-collection-preview.stories.tsx` | Patterns/Collection Preview | `Members`, `Empty`, `Unavailable`, `Preparing` |
| `library-collection-publication.stories.tsx` | Pages/Library/Collection publication | `SelectedEmpty`, `SelectedNonempty`, `Denied`, `Stale`, `SourceUnavailable`, `Retry` |
| `library-collection-row.stories.tsx` | Patterns/Collection Row | `Public`, `Private`, `Empty`, `MenuOpen` |
| `library-collection-rule.stories.tsx` | Pages/Library/Collection rule | `Draft`, `ActualCreate`, `PrivateUnavailable`, `Denied` |
| `library-collection-shortcuts-patterns.stories.tsx` | Patterns/Library/Collection destinations | `None`, `Some`, `Many` |
| `library-collection.stories.tsx` | Pages/Library/Collection | `SignedIn`, `SignedOut`, `PublicItemListExport`, `PublicItemListExportOwnerUnavailable`, `PublicItemListExportIncomplete`, `CuratorPublicMany`, `GridLayout`, `ReaderPublicMany`, `CuratorPrivateEmpty`, `ReaderPrivate`, `CuratorPublicOnePage`, `OwnerMenu`, `DestinationOverflow`, `MixedTypes`, `MembersPreparing`, `Unavailable`, `Error`, `AnotherReader`, `AnotherReaderGrid`, `MixedTypesGrid`, `SuppliedBookFactsIllustrative`, `Curator`, `PrivateCurator`, `PrivateNotFound`, `UnknownNotFound`, `UnlistedVisitor`, `PublicVisitor`, `Empty`, `OnePage`, `ManyPages`, `NotesAndDuplicates`, `DeepPage`, `FinalPage`, `Preparing`, `RestartAfterEpochChange` |
| `library-collections.stories.tsx` | Pages/Library/Collections | `NoCollections`, `OneCollection`, `ManyCollections`, `PreviewMembers`, `PreviewPending`, `PreviewUnavailable`, `LongCollectionTitles`, `Unavailable`, `Error`, `PinsUnavailable`, `LibraryNoPins`, `LibraryThreePins`, `LibraryNinePins`, `LibraryUnavailablePin`, `CollectionsThreePins`, `CollectionsNinePins`, `CollectionsUnavailablePin`, `CollectionsNoPins`, `PinAndUnpin`, `MovePinnedCollection`, `PinConflict`, `PinAtCapacity`, `PhoneSelectorOpen`, `CreateValid`, `CreateInvalid`, `CreatePending`, `CreateFailed`, `CollectionsAndPinsUnavailable`, `HealthyPinsCollectionsRecovery`, `SignedOutNextStep` |
| `library-continue-native-binding.stories.tsx` | Patterns/Library/Continue Native Binding | `FullProjection`, `WithheldHeader`, `UnlabelledSubject` |
| `library-continue-patterns.stories.tsx` | Patterns/Library/Continue | `FractionProgress`, `PositionOnlyProgress`, `NoProgress`, `SessionOnly`, `Empty`, `Unavailable`, `Preparing`, `Loading`, `Denied`, `Navigation` |
| `library-continue.stories.tsx` | Pages/Library/Continue | `Unavailable` |
| `library-copies-patterns.stories.tsx` | Patterns/Library/Copies forms | `AddFormOpen`, `EditFormOpen`, `CreateRefused`, `MultipleCopyTypes`, `HistoricalMeaningUnavailable`, `StaleDelete` |
| `library-copies.stories.tsx` | Pages/Library/Copies | `ManyCopies`, `None`, `OneCopy`, `LongContent`, `Unavailable`, `Error`, `NoLongerOffered`, `UnsupportedProfile`, `KnownHistoricalLabels`, `UnknownLegacy`, `RequiredReleaseUnavailable`, `DeniedDetail`, `ExactCapturedStatusEdit`, `HeadRenamedPairRetired`, `EmptyLaterPage`, `FilteredEmptyLaterPage`, `LongLaterPage`, `UnavailableLaterPage` |
| `library-entries-patterns.stories.tsx` | Patterns/Library/Entry layouts | `GridMedium`, `ListLayout`, `TableLayout`, `SmallGrid`, `LargeGrid`, `StateFilter`, `PhoneTileMenuOpen` |
| `library-entries.stories.tsx` | Pages/Library/Entries | `SignedIn`, `ExposureOpen`, `ExposureClosed`, `StateFilterCleared`, `FilteredEmpty`, `UndoAfterShelfRemoval`, `RestoreOccupied`, `RestoreStale`, `RestoreExpired`, `UndoRestored`, `SelectedLoadedPage`, `ChosenColumns`, `SelectedLabelChoice`, `TypeSelected`, `TypeNoMatch`, `TypePickerUnavailable` |
| `library-entry-undo.stories.tsx` | Pages/Library/Entry Removal | `NoJavaScriptUndo` |
| `library-following.stories.tsx` | Pages/Library/Following | `SignedIn`, `UnfollowMenuPhone`, `Empty`, `InactivePage`, `AfterLastUnfollow`, `LongContent`, `Unavailable`, `Error`, `HiddenTarget`, `UnfollowFailure`, `ListRowBehavior`, `RemoveUnavailableTarget`, `UnfollowMenuDesktop` |
| `library-label-shelf.stories.tsx` | Pages/Library/Label Shelf | `ThreeWorks`, `FortyWorks`, `Empty`, `ShelfActions`, `RetainedUndo`, `Unavailable`, `Preparing`, `Hidden` |
| `library-labels.stories.tsx` | Pages/Library/Labels | `SignedIn`, `SignedOut`, `Empty`, `NextPage`, `RenameConflict`, `Undo`, `LiteralPrefix`, `SparsePrefix`, `EmptyPrefix`, `LaterPagePrefix`, `StalePage`, `UnconfirmedChange`, `RetainedUndoAfterStale`, `Unavailable`, `Preparing`, `UnprofiledSubject`, `Capacity`, `PickerPages`, `PhoneBeforeCapacity`, `PhoneCapacity`, `RenameSelected`, `DeleteConfirmation` |
| `library-log.stories.tsx` | Pages/Library/Published Log | `SignedIn`, `SignedOut` |
| `library-logs-patterns.stories.tsx` | Patterns/Library/Published log | `Snapshot`, `ConfirmDelete`, `Deleted`, `Restored`, `RestoreRefused` |
| `library-my-logs.stories.tsx` | Pages/Library/My published logs | `Owner`, `Empty`, `Long`, `UnknownSubject`, `Denied`, `Unavailable`, `Preparing`, `NewestPage`, `Restarted`, `SignedOut` |
| `library-navigation-patterns.stories.tsx` | Patterns/Library/Navigation | `PhoneSelectorOpen`, `SelectedCollectionSelector` |
| `library-page-states.stories.tsx` | Pages/Library/Personal Library | `Empty`, `ContinuePresent`, `ContinueAbsent`, `LongContent`, `Unavailable`, `Error`, `PinsUnavailable`, `EverythingAndLiked`, `PinnedCollections` |
| `library-patterns.stories.tsx` | Patterns/Library/Tracked entries | `EntryPresentations`, `SmallEntryGrid`, `MediumEntryGrid`, `LargeEntryGrid`, `EntryGridSizes`, `ProfileStateDestinations`, `TrackedEntries`, `StateFilterActive`, `SelectionMode`, `LongTitles`, `SubjectUnavailable`, `ViewerRetired` |
| `library-personal-library.stories.tsx` | Patterns/Library/Personal Library | `ContinueAbsent`, `ContinuePresent`, `ContinuePreparing`, `ContinueUnknown`, `ContinueUnavailable`, `TypePickerSecondPage`, `ChronologicalOrder`, `ChronologicalPreparing`, `ChronologicalDenied`, `ChronologicalUnavailable`, `SelectedPartialOutcomes`, `SelectedUnknownRecovered`, `SelectedNoCommonState`, `SelectedAuthorityLost`, `ChosenColumns`, `SelectedLabelPartialOutcomes`, `SelectedLabelUnknownRecovered` |
| `library-private-follow-counts.stories.tsx` | Pages/Library/Private follow counts | `ReadyZero`, `ReadyNonzero`, `ContextualZero`, `DeniedContext`, `Unavailable`, `Loading`, `InvalidContext` |
| `library-progress-patterns.stories.tsx` | Patterns/Library/Progress controls | `UnitSelectorOpen`, `UpdateFormOpen`, `HistoricalMeaningUnavailable` |
| `library-progress-session.stories.tsx` | Pages/Library/Progress Session | `SignedIn`, `ProfileUnits`, `ProfileUnitsRecordingUnavailable`, `DeclaredRecordingRefused`, `RetiredPair`, `EmptyChanges`, `LongContent`, `NarrowOriginalHistory`, `CompletedAmountHistory`, `Unavailable`, `Error`, `HistoricScalar`, `SparseHistory`, `OpaqueCursor`, `UnresolvedUnit`, `WithheldSummaries` |
| `library-progress.stories.tsx` | Pages/Library/Progress | `SignedIn`, `ExposureOpen`, `ExposureClosed`, `SelectorSheetOpen`, `Empty`, `LaterPageEmpty`, `FilteredLaterPageEmpty`, `UnknownUnitNarrow`, `UnknownUnitDetailsOpen`, `LongContent`, `Unavailable`, `Error`, `UnsupportedProfile`, `ExplicitVersionChoice` |
| `library-subject-return-context.stories.tsx` | Pages/Subjects/Library Sign-in Return Context | `RealmReader`, `CurrentReaderView`, `CanonicalFallback`, `PrivateParametersExcluded` |
| `private-follow-counts-phone.stories.tsx` | Pages/Library/Private follow counts | `RecoveryToFollowing`, `BackToLibrary`, `LongCountAndGuidance`, `IndependentRecoveryAndWithdrawal` |
| `progress-history-reader-recovery.stories.tsx` | Pages/Library/Progress history reader recovery | `ShortZeroDuplicatesAndLifecycle`, `LongFactsPhone`, `FirstPageEmpty`, `LaterEmptyIndependentRecovery`, `SparseFirstPageWithContinuation`, `AbsentOperation`, `RetiredCurrentAuthority` |
| `progress-index-historical-meaning.stories.tsx` | Patterns/Library/Progress history | `MissingHistoricalMeaning`, `ExactValuesByKeyboard`, `KnownUnitUnchanged`, `LongPaginationLabels` |
| `progress-log-reader-recovery.stories.tsx` | Patterns/Library/Progress Log Reader Recovery | `Normal`, `NarrowLongText`, `FirstPageEmpty`, `LaterPageEmpty`, `EmptyPageWithContinuation`, `Unavailable`, `AuthorityRetired`, `RetirementWhileMounted` |
| `published-log-history-phone.stories.tsx` | Pages/Library/Published log history navigation | `OwnerHistoryNavigation`, `LongNotesAndNavigation`, `FirstPageEmpty`, `LaterEmptyRecovery`, `UnavailableRecovery`, `DeniedRecovery`, `PreparingRecovery`, `RestartedHistory`, `RestartedEmpty`, `SignedOutRecovery` |
| `subject-labels.stories.tsx` | Pages/Subjects/Personal Labels | `NoLabels`, `ThreeLabels`, `ThirtyTwoLabels`, `PickerOpen`, `UndoVisible` |
| `subject-library-controls.stories.tsx` | Pages/Subjects/Library Controls | `LoadedCollectionChoices`, `LabelPickerAndAssignment`, `LabelRemoveAndUndo` |
| `subject-library-view.stories.tsx` | Pages/Subjects/Library Reader View | `DetailsSignedOut`, `DetailsSignedIn`, `RealmCredits`, `RelationsSignedOut` |

The inventory contains 53 owned families (25 Pages and 28 Patterns), with 456 exported scenarios.
The two private-count files share a title but export different cases; they are separate source families.

Additional embedded/shared page cases required at the ownership boundary:

- `subject.stories.tsx` / `Pages/Subjects/Subject`: `SignedIn`, `SignedOut`, `LibrarySlotMenuPhone`, `LibrarySlotMenuDesktop`, `ExposureOpen`, `ExposureClosed`, `UndoAfterLibraryRemoval`, `UndoRestored`, `RestoreOccupied`, `RestoreStale`, `RestoreExpired`.
- `settings.stories.tsx` / `Pages/Account/Settings`: `SignedIn`, `StaleVisibility`, `SavedVisibility`, `CollectionsClosed`, `SignedOut` for existing Collection privacy controls.
- `home.stories.tsx` / `Pages/Discovery/Home`: `SignedIn`, `SignedOut`, `PartialSources`, `Preparing`, `Unavailable`, `Empty`, `Following`, `KindSelection`, `KindChoicesUnavailable`, `KindChoicesNextPage` for the shared Continue source boundary.

These cross-owner cases supplement the complete Library family list; their other page regions are not reassigned.
