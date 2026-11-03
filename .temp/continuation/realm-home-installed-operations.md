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
  'after':
    [
      '67d35a0b-0266-40a7-ad13-76769a662e5a',
      'ad9468d7-c356-4bbc-b09f-680d0de12de9',
      '65a4b80c-e821-4afe-b6df-4e4aefb5e973',
      '1027e722-0bc6-4c84-bf2b-6a338f813a08',
      'd2f544f0-b0db-4be7-967c-64ed197da8e7',
    ],
  'estimate': { 'lines': 900, 'files': 14 },
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
      'tests':
        [
          'Default Space and Realm destinations consume the mounted home with its current native viewer observation and generated Client operation.',
          'Native advice alone admits participation, join, leave, claim and management; anonymous, member, denied, banned, orphaned, concealed, missing carrier and operational failure remain distinct.',
          'Complete visits retire on credential, locale, route, container, lifecycle, presentation and native-observation replacement; native batches and independent continuations retain keyboard retry and return focus.',
        ],
      'failing': true,
      'placement': 'default',
    },
}
---

Complete the remaining Realm home visit in
[the owner contract](../../apps/web/src/community/space-page-lifetime.md).

Bind default Space and selected Realm destinations to the actual installed generated composed home, board shelf and
publication shelf operations after address resolution. Kernel's mounted home currently returns anonymous sign-in
advice or signed-in readability, membership episode, participation and current entry/manage/leave advice; the
installed Client declarations do not expose these operations. Consume the producer's real response and examples in
`services/kernel/test/community/realm-home.test.ts` and `realm-home-publications.test.ts`. The normal producer and
controller own generation, preparation and deferred native acceptance. Missing publication remains explicitly
unavailable: do not cast it into existence, invent a DTO, use raw endpoints, edit generated declarations or run a
competing generator. Do not manufacture join or claim advice from another observation.

Finish standing, participation, join/leave/claim and management from each explicit composed native advice field.
Preserve original credentials and CSRF, uncertain command intent, explicit same-input retry and supported readback.
Retain orphan read-only identity, canonical redirects, concealed/absent/unavailable carriers, independent opaque shelf
cursors, sparse native windows, supplied order, no per-row enrichment, keyboard retry and return focus, and all eight
locales. Preserve account, source, locale, exposure and selected-revision retirement. No unrelated continuation work.

Keep the delivered native head/selected-presentation validation, route and injectable complete-visit source retirement,
and fresh-response remount of both shelves. Preserve the original frozen acceptance above. Write only missing focused
consumer tests; ordinary rendered verification and conditional publication remain with their controller owners.
