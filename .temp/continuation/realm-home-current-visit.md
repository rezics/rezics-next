---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'account', 'deletion', 'rights'],
  'criticalPath': false,
  'waiting': [],
  'paths':
    [
      'apps/web/src/community/space.ts',
      'apps/web/src/community/space-actions.ts',
      'apps/web/src/community/space-queries.ts',
      'apps/web/src/community/space-page.tsx',
      'apps/web/src/community/space-page-lifetime.tsx',
      'apps/web/src/community/space-page-lifetime.md',
      'apps/web/src/community/realm-home*.ts*',
      'apps/web/src/community/realm-membership.tsx',
      'apps/web/src/community/publication-controls*.ts*',
      'apps/web/src/stories/realm-home*.stories.tsx',
      'apps/web/tests/space-page*.test.ts*',
      'apps/web/tests/realm-home*.test.ts*',
      'apps/web/tests/realm-shelf-continuation-focus.test.tsx',
      'apps/web/messages/*.json',
      'docs/goals/web.md',
      'services/kernel/src/community/realm-home.ts',
      'services/kernel/src/community/routes.ts',
      'packages/client/src/kernel/community/routes.d.ts',
    ],
  'after': ['67d35a0b-0266-40a7-ad13-76769a662e5a'],
  'estimate': { 'lines': 1500, 'files': 22 },
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
          'tests/space-page-render.test.ts',
          'tests/space-page-lifetime.test.tsx',
          'tests/realm-home-header-interface.test.tsx',
          'tests/realm-shelf-continuation-focus.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A person enters the current Realm through its Space address or Realm destination, recognizes native identity/standing and opens disclosed boards/publications with independent continuation.',
          'Anonymous, member, denied, banned, orphaned, missing carrier and operational failure retain distinct truthful states; readable identity never grants actions.',
          'Viewer/credentials, source/container/locale changes retire presentation/media/standing/actions and stale continuations before late effects; 1/6/12 publications use native batches with no per-cover read or refill.',
        ],
      'failing': true,
    },
}
---

Complete the current Realm-home visit after Content's mounted page carries the composed native viewer observation and the generated client exposes the mounted operation. The current server `createRealmHomeReader` returns only anonymous/unavailable standing and sign-in/unavailable advice, and `@rezics/client` currently has no generated declarations for `home`, `boardShelf`, or `publicationShelf`; the current Web separate reads are not evidence of that composed observation.

Bind the delivered DTOs and operation through the existing Space route, preserving address resolution, identity, language, presentation, board and publication shelves, their independent source-bound cursors, and command owners. Remove per-publication Subject reads. Render join, leave, claim, manage and participation destinations only from native advice. Preserve truthful anonymous, member, denied, banned, orphaned, concealed, missing-carrier and operational-failure states. Retire the complete visit, including media and private standing, on credential, locale, route, Realm/Space, lifecycle, presentation or native-observation replacement. Keep deliberate-visit keyboard continuation, retry and return focus.

Add the fewest mounted tests for populated and empty pages, sparse continuation, same-cursor failure/retry, missing carrier, changed presentation, replaced membership/reader and late results. Use existing shared cards, safe body/media rendering, all eight locales, wrapping 44px actions and phone390/desktop1280 layouts. Do not claim fixture, browser or native evidence; the controller owns generated delivery and the frozen acceptance.
