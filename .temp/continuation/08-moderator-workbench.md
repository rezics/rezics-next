---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'interface',
  'paths':
    [
      'apps/web/src/routes/realms/$id_.moderation.tsx',
      'apps/web/src/moderation/workbench*.ts',
      'apps/web/src/moderation/workbench*.tsx',
      'apps/web/src/moderation/workbench.md',
      'apps/web/src/moderation/reports-read.ts',
      'apps/web/src/moderation/appeals-read.ts',
      'apps/web/src/routes/boards/$id_.moderation.tsx',
      'apps/web/src/community/space-page.tsx',
      'apps/web/src/community/space.ts',
      'apps/web/src/stories/moderator-workbench.stories.tsx',
      'apps/web/tests/moderator-workbench.test.tsx',
      'services/kernel/src/content/README.md',
      'services/kernel/src/community/README.md',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
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
          'tests/moderator-workbench.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A currently authorized Realm moderator opens the workspace, continues the native board directory, selects a board and reaches existing Reports/Appeals and ban management with retained return context.',
          'Session/CSRF replacement, role/read loss or navigation retires private queue content; sparse continuation, unavailable retry and denied access remain distinct, and no aggregate count or fabricated empty queue appears.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 400, 'files': 13 },
}
---

# Give Realm moderators one place to begin triage

A Realm moderator starts triage from one discoverable workspace instead of assembling board URLs. Select a board, reach its existing Reports and Appeals, and open existing Realm ban management; return to the original board/tab/selection.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Content appeals](services/kernel/src/content/README.md#appeals), [Community authority](services/kernel/src/community/README.md), [Reports lifetime](apps/web/src/moderation/reports-page-lifetime.md), and [Appeals reads](docs/research/content-moderation-appeals-design.md#private-appeals-reads-and-recovery). Update Content/Community owner docs and adopt the page contract in apps/web/src/moderation/workbench.md in the same change.

The initial workbench is explicitly board-scoped. Page the existing Realm board directory once per user action, keep its native cursor and distinguish sparse/terminal/unavailable states. Reuse current board report projection, filters, loaded selection, bulk commands, independent appeal resolution and ban surface. Do not add a Realm-wide report index or queue counts. Current native action checks admit entry/controls; cached role labels are presentation only. Global board moderation keeps its current route and never inherits Realm authority.

Use the existing signed-in/private loader, no-store and mounted reader generation. Session/account/CSRF replacement, navigation or revoked admission immediately retires private content and stale callbacks. Keep in-progress decisions and exact uncertain retries under their existing owners. A navigation wrapper must not bypass departure confirmation, silently resend a command, expose withheld bodies or turn report authority into read authority.

Done includes a Realm-home entry, keyboard-usable board selection and reliable return links, composing existing pages rather than rebuilding queues. One focused route journey and one retirement/recovery case suffice; tests stay shorter than product. Stories: moderator board selection, selected board with Reports/Appeals entry, and denied entry, phone/desktop using recorded API responses. Target 350–450 product lines.
