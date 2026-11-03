---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/content/board-watch*.ts',
      'services/kernel/src/content/board-watch*.sql',
      'services/kernel/src/content/notice-inbox.ts',
      'services/kernel/src/content/notices.ts',
      'services/kernel/src/content/events.ts',
      'services/kernel/src/content/register.ts',
      'services/kernel/src/content/work.ts',
      'services/kernel/src/content/README.md',
      'services/kernel/src/access/notification-kinds.ts',
      'services/kernel/src/access/README.md',
      'services/kernel/db/content/migrations/*_board_watch.sql',
      'services/kernel/db/content/schema.sql',
      'apps/web/src/threads/board-watch*.tsx',
      'apps/web/src/routes/boards/$id.tsx',
      'apps/web/src/inbox/inbox-page.tsx',
      'services/kernel/test/content/board-watch-http.test.ts',
      'apps/web/tests/board-watch.test.tsx',
      'apps/web/src/stories/board-watch.stories.tsx',
    ],
  'riskAreas': ['authorization', 'disclosure', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'command':
        [
          'sh',
          '-c',
          'bun run --cwd services/kernel check test/content/board-watch-http.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/board-watch.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Watch survives reload and creates one in-app board_activity notice per new published thread, including reviews; replay, own activity, replies, edits and historical threads create no extra notice.',
          'Unwatch, disabled preference, suspension, protected read loss or ban before delivery suppresses notices; workers page watchers and retries resume without duplicate delivery.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 500, 'files': 18 },
}
---

# Notify readers about new threads on watched boards

A signed-in reader watches a board from its page, receives new-thread notices in the existing inbox, and can unwatch. Watching is private Content state, independent of Library follows and membership.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Content notifications](services/kernel/src/content/README.md#notifications), existing notice-inbox.ts/register.ts/work.ts and [feed boundaries](docs/feeds.md). Update the Content owner contract and Accounts' notification catalogue contract in the same change.

Use a distinct board_activity in-app preference kind through the existing Accounts notificationAllowed port. The catalogue addition is a minimal Accounts seam, not a new preference service. A committed first publication of a thread opening, including a review, is the only source. No backfill, reply/edit notices, email or public watcher totals. Store identity references, never body copies. Keep idempotent watch/unwatch commands and current own-watch read; unwatch must remain possible after read loss.

Page recipients on the existing durable worker with an indexed frontier, excluding the actor. At send, recheck current subscription, account standing, preference and native board/thread/opening/Realm/Space read authority. A unique recipient/thread source prevents replay duplicates; inbox hydration repeats current disclosure. Extend existing bounded account-erasure cleanup for subscriptions rather than inventing a scheduler. Watch grants neither read nor participation.

Done includes board toggle, pending/uncertain retry behavior and inbox navigation. Add the two native cases and one toggle/reload case; fewer test lines than product. Stories: signed-out, watching and uncertain toggle, phone/desktop using recorded native responses. Target 450–500 product lines; keep ordinary reply/mention/moderation assertions intact.
