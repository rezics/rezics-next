---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
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
          "Use Content's installed generated /v1/me/realms schema and examples for separate current entry, membership transition, presentation, media and action advice; do not invent a browser DTO or widen a cast.",
          'A signed-in person recognizes current permitted Realm presentation, distinguishes readable entry from unavailable entry, and reaches an admitted existing management or leave flow before returning to the current My Realms page.',
          "Ordinary membership never implies management, a submitted leave stays pending until actual readback, and leave/rejoin or replaced native action advice cannot retain a previous membership episode's actions.",
          'Sparse continuation, same-cursor retry and explicit restart preserve the existing inventory; account, credentials, locale, disclosure, presentation and source replacement retire labels, media grants, selected actions and late effects.',
          'At 1/10/20 rows the expanded native page is consumed once with O(N) formatting and one selected action, without per-row presentation, permission or membership reads. Native raw80 and growth256/1024/4096 remain producer evidence.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 2500, 'files': 25 },
}
---

# Remaining outcome

Complete the current My Realms entry and action experience once Content's expanded `GET /v1/me/realms` contract is
installed with its generated client and real examples. The source on this base provides only `realmId`, `name`, the
literal `role: 'member'`, and the opaque `next` cursor. It has no native current address, readable/unavailable entry,
presentation/media, membership episode, or action advice. The named Content backlog brief was absent from both the
worktree and its named read-only main-checkout path at this attempt, so Web must bind the actual published schema when
it arrives rather than guessing its fields.

Build the extension into the existing caller and `/realms` route. Render only admitted current presentation and media,
use the admitted current destination, distinguish hidden/unavailable entry without leaking old metadata, and show an
existing management destination only when native advice allows it. Add one selected-Realm leave review through the
existing membership command owner. Reauthorize when executing, preserve accepted/unknown/rejected command semantics,
keep a submitted leave pending until native readback confirms the transition, and bind retries to the original operation
and membership episode.

Retain one page, one selected action and O(N) formatting for at most 20 rows. Do not enrich rows with per-Realm,
Account, Media, Access or membership reads; do not infer capabilities from `role: 'member'`, refill sparse pages,
store private page data, or let retired account/locale/source responses disclose labels, images, destinations or stale
actions. Preserve the current route/caller's session preparation, null-CSRF read-only behavior, cursor ownership,
first-page recovery distinctions, focus restoration and exact Query retirement.

Add the named mounted journeys, retirement regressions and stories only for the contract's states. Cover permitted and
long presentation, readable and unavailable entry, concealed presentation, sparse continuation, failed same-cursor
retry, ordinary member and actual manager, pending/unknown leave, replacement membership, account/locale/source
retirement and late readbacks. Inspect phone390 and desktop1280 in light/dark, keyboard entry/review/confirm/return,
44px controls and all eight locales. Document delivered pending, retry and unavailable meanings plus Touches, Bound and
Growth. Native raw80 traversal and 256/1024/4096 growth remain Content's evidence; this continuation does not claim
them from Web fixtures.
