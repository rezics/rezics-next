---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['rights', 'authorization', 'disclosure', 'account', 'deletion'],
  'criticalPath': false,
  'after':
    [
      '7c3bb4f1-8e6e-4137-8d4d-45a7a7d8760b',
      'd6b1bd94-1216-4957-b467-bd90d8608a2e',
      'bba004ce-703b-43f4-81db-de03a3ee4261',
    ],
  'waiting': [],
  'paths':
    [
      'apps/web/src/community/my-realms-*.tsx',
      'apps/web/src/community/my-realms-*.ts',
      'apps/web/src/community/my-realms-*.md',
      'apps/web/src/community/space.ts',
      'apps/web/src/community/realm-membership-actions.ts',
      'apps/web/src/routes/realms/index.tsx',
      'apps/web/src/stories/my-realms-current-entry.stories.tsx',
      'apps/web/tests/my-realms-current-entry*.test.ts*',
      'apps/web/messages/*.json',
      'docs/goals/web.md',
    ],
  'acceptance':
    {
      'precondition': 'The mounted generated KernelClient.me.realms.get contract and recorded my-realms.json example expose the native current-entry, presentation, media, membership-episode and action-advice fields. A service-side schema/source change alone is not mounted proof. Do not invent a browser DTO or widen a cast while they are absent.',
      'command':
        [
          'bun',
          'apps/web/scripts/focused.ts',
          '--private-network',
          '--',
          'bun',
          'test',
          'tests/my-realms-current-entry.test.tsx',
          'tests/my-realms-current-entry-actions.test.tsx',
          'tests/my-realms-current-entry-retirement.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Bind the expanded generated /v1/me/realms response and real examples without an invented browser DTO or widened cast.',
          'Mounted journeys cover admitted presentation/media, readable and unavailable entry, actual manager, selected leave review, pending/unknown/rejected results and current-page return.',
          'Readback and retry remain bound to the original operation and membership episode; replacement advice and all retirement boundaries discard stale actions and late effects.',
          'Sparse continuation, same-cursor retry and restart preserve inventory; one 1/10/20-row page receives O(N) formatting and one selected action with no per-row enrichment.',
          'Stories cover the named states; phone390/desktop1280 light/dark, keyboard flows, 44px controls and all eight locales remain legible and operable.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 2450, 'files': 24 },
}
---

Complete the current My Realms entry and action experience after the expanded generated response and its recorded
example are mounted in this branch. The installed Web client declaration and recording currently expose only
`realmId`, `name`, `role` and `next`; a service-side schema or producer change alone is not mounted proof. Keep the
existing generated-type inventory projection until the mounted contract and example provide the additional fields.

Retain the existing caller, route, session preparation, null-CSRF read-only behavior, exact Query retirement, cursor
ownership, first-page recovery and focus restoration. Consume separate native current entry, presentation, media,
membership episode and action advice. Use admitted destinations and presentation/media only; distinguish concealed
presentation from unavailable entry without leaking prior metadata. Ordinary membership grants no management access;
offer an existing management destination only on native advice.

Add one selected Realm leave review through the existing membership command owner. Reauthorize at execution, preserve
accepted/unknown/rejected outcomes and keep a submitted leave pending until native readback confirms the transition.
Bind retries and readback to the same operation and membership episode. Replacement membership or native advice retires
previous actions. Return to the current My Realms page after existing flows.

Keep one page, one selected action and O(N) formatting for at most 20 rows. Do not add per-Realm, Account, Media,
Access or membership enrichment, sparse-page refill or private-page storage. Account, credentials, locale, disclosure,
presentation and source replacement retire labels, grants, selected actions and late effects.

Extend the named test to mounted journeys and add the action and retirement files. Cover permitted and long
presentation, readable/unavailable entry, concealment, sparse continuation, failed same-cursor retry, ordinary member
and actual manager, pending/unknown/rejected leave, replacement membership, account/locale/source retirement and late
readbacks. Add only those stories. Inspect phone390 and desktop1280 in light/dark, keyboard entry/review/confirm/return,
44px controls and all eight locales. Document pending, retry and unavailable meanings plus Touches, Bound and Growth in
`docs/goals/web.md`. Native raw80 traversal and growth256/1024/4096 remain Content evidence.
