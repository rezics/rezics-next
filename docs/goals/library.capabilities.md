# Library capability acceptance inventory

The owner-only `GET /v1/libraryReportedYearSummary?year=...` and typed
`libraryReportedYearSummary.get({query:{year}})` extend the delivered native journal and all-time counters.
The [reported-year contract](../library-reported-year-summary.md) owns precision, independent bucket grouping,
installation/currentness and the integrating reader’s clear/cancellation/retry receiving. Focused scenarios are in
`test/library/reported-year-summary.test.ts`; three-scale and full lifecycle acceptance remain deferred to integration.

Personal consumption statistics now have the mounted owner-only
`GET /v1/libraryConsumptionSummary` and typed `libraryConsumptionSummary.get()` caller.
The [statistics contract](../library-consumption-statistics.md) owns exact occurrence,
distinct-subject, repeat, completeness and retry/clear semantics for the existing Web interface.
Focused native scenarios: `test/library/consumption-statistics.test.ts` cover explicit native
completion, repeats, independent entry state, clear/replay, corrections, removal, unknown
historic profiles, other owners, terminal fences, bounded reads and unavailable/cancelled reads.
Broader acceptance and Web interface validation remain deferred to integration.

This inventory maps the seven Library Done-when clauses to their existing native acceptance, persona denials,
owned routes and current page-story source exports. Product behavior remains in the linked owner documents and the
[Library Goal](library.md). This file records evidence status; it does not replace frozen outcomes or establish
completion.

## Source binding and evidence status

The clean worker source inspected before editing was 5ff5df48738f205a35b56f18576c101e2c310567. The integrated
current-dev quality reports are retained at these source commits:

- commerce-outcomes-quality.md: 75c114ed143ed5c5834d1f34d840bdddcd6b5af3
- library-outcomes-quality.md: dc0e18618eecace62cebd39ebeb9cd91b428d27a
- profiles-labels-quality.md: 327cf74ccadc20d3c16bbf1a12fb7e17141e77f6
- commerce-page-review-quality.md: e903579b1311b6e421d61bc282db5c7b7b02d525
- library-growth-quality.md: e8c73df39740e4325578311e3ab8515e6a18e319
- commerce-cost-lifecycle-quality.md: 3e18811b1f7b2770c2a958bee309d6d282a46f54
- collections-outcomes-quality.md: 33ec58e4d47a648a378006c9c20a389fb1d1e051
- library-page-review-quality.md: b5627d8073412ea5e6d43978c2456c3855b87911

The page-review inventory is bound to source 88a6a9c65a15ad5314f9337a2ddf4362c9df9bed. Comparing that source with
the worker base found no changes to the Library routes, the 53 listed Library story families, the frozen Library
outcome specifications, the Kernel Library wrappers, or the nested Web personal host. Eight other story files
changed. Source equality for these named paths verifies the export inventory only; it is not a fresh Storybook
runtime index or acceptance result.

Every capability below is bound to the worker base plus its cited source review and remains UNMEASURED. The review
reports contain source-declared unavailable fixture or observation seams, not observed failing exits. No Library
native, Web native, acceptance, browser, screenshot, root, worker-check or remote-check was run for this inventory.
The controller defers those checks to integration. Do not infer a pass, failure, flake, visual approval or promoted
revision from a file, a story, a recorded JSON response or a wrapper.

The exact story references below are apps/web/src/stories/<file>#<export>. Viewport selection is global; a single
source export may cover both desktop and phone only when that export renders the named state at both sizes. No
runtime IDs or viewport-suffix IDs are claimed.

## Native acceptance register


Personal VNDB XML upload now has mounted preview/page/source/review/apply/cancel/delete methods documented in
[its owner contract](../library-import-vndb.md), with focused native HTTP scenarios in
`services/kernel/test/library/list-import-vndb-http.test.ts`. This adds explicit released entry-state application
and private loss retention; it does not establish broader frozen acceptance or support for live provider accounts.
