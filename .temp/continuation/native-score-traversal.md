---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'paths':
    [
      'apps/web/src/library/shelf-params.ts',
      'apps/web/src/library/shelf-rows.ts',
      'apps/web/src/library/shelf-view.tsx',
      'apps/web/src/library/shelf-columns.tsx',
      'apps/web/src/library/entries-read.ts',
      'apps/web/src/library/reads.ts',
      'apps/web/src/library/personal-shelf-origin.tsx',
      'apps/web/src/routes/library/index.tsx',
      'apps/web/src/stories/library-page-states.stories.tsx',
      'apps/web/tests/shelf-score-order.test.tsx',
      'apps/web/tests/shelf-page.test.ts',
      'apps/web/messages/*.json',
      'docs/library-and-collections.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': ['e35e13cf-e5e6-4797-889d-9d16a052b942', 'b0bfd56d-40ea-42d8-88f1-e8d0c234afe7'],
  'waiting': [],
  'estimate': { 'lines': 1100, 'files': 14 },
  'acceptance':
    {
      'command':
        [
          'bun',
          'apps/web/scripts/focused.ts',
          '--private-network',
          '--',
          'bun',
          'test',
          'tests/shelf-score-order.test.tsx',
          'tests/shelf-page.test.ts',
          'tests/personal-shelf-current-origin.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Both personal-score directions traverse first, middle and final native pages in full-shelf order, including equal scores, zero, unrated-after-rated entries and existing state/type filters; no local page sorting.',
          'A changed score, clear, replaced entry/filter/direction/question or retired viewer uses the native currentness/restart outcome and retires obsolete rows/cursors and delayed effects.',
          'Ready, native preparation, unavailable order, stale cursor, empty and final page remain distinct; grid/list/table, existing saved display preferences and keyboard return remain coherent.',
          'One fixed-size supplied page remains bounded at 1/10/20 rows and growing unrelated shelf populations, with no per-row score fetch or browser shelf aggregation.',
        ],
      'failing': true,
    },
}
---

# Complete native score traversal after generated publication

The current part recognizes explicit personalScore addresses and renders honest unavailability with disabled score controls, retained display/filter choices, restart and date-order recovery. Unsupported saved rating orders remain unsupported. Existing date orders keep their reader. This is not completed native score traversal.

At base ed91a343d2998cbacb1211c2a59abab8bd010bdd, packages/client/src/kernel/library/personal-routes.d.ts omits the personalScore order literal, entry personalScore, page scoreQuestion, and libraryShelfScorePreparation method; generated shelf-contract.d.ts omits score order/descriptor. Do not fabricate these declarations or activate from native source alone. Read the actual published generated signatures before activation. Content currentness remains required; supplied own-facts are independent.

Use docs/library-and-collections.md#web-personal-score-availability, docs/library-personal-score-order.md and services/kernel/src/library/shelf-contract.md#personal-score-extension as owners. Once published, replace the explicit unavailable guard in readEntryPage with the generated native binding. Keep its unavailable branch for actual failures. Consume the standard question identity/meaning/revision and unit scale exactly. Preserve the supplied full-identity order, zero and unrated handling without sorting locally. Add bounded supplied own-fact decoration only when its actual question identity and scale match.

Finish native preparation controls with existing command receipt/uncertainty handling only through the published method. Preserve native invalid/stale cursor restarts after vote changes, clear, removal, merge or question changes; a row refresh cannot repair the old visit. Retire delayed row actions and cursors through the current personal shelf owner. Complete mounted first/middle/final, filter/direction/question/viewer replacement cases and bounded 1/10/20-row checks, preserving all existing row-action assertions. Add only ready/preparing/stale/empty/final connected stories supported by the producer. Keep eight locales, phone390/desktop1280 wrapping, 44px actions and keyboard return. Derive actual retained response-byte bounds and fixed explicit next/restart read sequence without claiming native indexed growth acceptance. Controller owns native publication and acceptance. Follow the current controller's minimal verification policy.
