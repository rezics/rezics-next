---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'claim',
  'paths':
    [
      'services/kernel/src/content/feed-subject-reactions.ts',
      'services/kernel/src/content/feed-contract.ts',
      'services/kernel/test/content/feed-subject-reactions-growth.test.ts',
      'services/kernel/test/content/feed.test.ts',
      'services/kernel/test/content/feed-contract.test.ts',
      'docs/feeds.md',
      'apps/web/src/stories/home-subject-reactions.stories.tsx',
      'apps/web/src/kernel/recorded/',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'waiting': [],
  'after': [],
  'estimate': { 'lines': 900, 'files': 8 },
  'criticalPath': false,
  'acceptance':
    [
      'Emit the mounted feed-local Subject reaction schema through the existing sole publisher and use its generated Web alias without hand-editing generated outputs.',
      'Complete mounted GET /v1/feedItems coverage for discovery, Following and Continue with native accounts, Subjects, Access and registered reaction delivery, including withheld or failed lanes and cursor behavior.',
      'Add feed-subject-reactions-growth.test.ts at fixed S/H/limits/admitted bytes and scales 256/1024/4096; capture plans, rows/blocks, SQL/control and pool/runner phases, retained bytes and serialized UTF-8 bytes across empty, stale, denied and retry cases.',
      'Use recorded mounted native responses for the three Home stories and review the 390 and 1280 widths under the active launcher policy.',
      'Complete the retained native, generated typing, rendered and growth acceptance after integration under the controller verification policy.',
    ],
}
---

Continue from the committed Home Subject reaction implementation. The mounted native composition and Home controls are present, and the focused Home Subject reaction test passes. Finish publisher emission, route-level lane coverage, operation-local growth evidence, and stories backed by recorded mounted responses. Keep missing foreign authority unavailable, preserve exact retry operands and source retirement, and retain the existing Commerce viewerPersonalActions dependency. Do not create a second generator, edit generated outputs by hand, or wait for receiver acceptance before publishing the source schema. Native, generated typing, rendered and growth acceptance remain separate integration outcomes.

The focused Web test passed. The `packages/ui` typecheck passed. Web and Kernel typechecks currently fail on large unrelated workspace error sets; inspect and resolve only errors attributable to this change, and report the baseline failures. The controller policy defers native, browser, root and growth acceptance until integration.
