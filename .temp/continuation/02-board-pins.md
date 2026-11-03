---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/content/board-pins*.ts',
      'services/kernel/src/content/board-pins*.sql',
      'services/kernel/src/content/routes.ts',
      'services/kernel/src/content/schemas.ts',
      'services/kernel/src/content/setup.ts',
      'services/kernel/src/content/README.md',
      'services/kernel/db/content/migrations/*_board_pins.sql',
      'services/kernel/db/content/schema.sql',
      'apps/web/src/threads/board-pins*.tsx',
      'apps/web/src/threads/board-feed.tsx',
      'apps/web/src/routes/boards/$id.tsx',
      'services/kernel/test/content/board-pins-http.test.ts',
      'apps/web/tests/board-pins.test.tsx',
      'apps/web/src/stories/board-pins.stories.tsx',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'command':
        [
          'sh',
          '-c',
          'bun run --cwd services/kernel check test/content/board-pins-http.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/board-pins.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A local moderator pins/unpins idempotently, readers see up to five pins on the first page, and ordinary sort/cursor continuation remains intact.',
          'Cross-board pins, a sixth pin and unauthorized writes are refused; takedown, Realm ban or read revocation removes a pin from disclosed results.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 400, 'files': 14 },
}
---

# Keep important threads visible with board pins

A board reader sees important threads in a small pinned section; a local moderator can pin and unpin without changing Hot, Active or New ordering.

Read [plan decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Content boards](services/kernel/src/content/README.md#global-boards), [Community authority](services/kernel/src/community/README.md), and the existing boards.ts/board-cursor.ts readers. Update the Content README with routes, board-curation authority, bounds and disclosure behavior in this change.

Decisions: maximum five pins, newest pin first then thread ID; same-board threads only. Introduce board:curate for the existing board owner/moderator and containing-Realm owner/moderator roles, requiring current exact-board/container authority. Share this action declaration idempotently with slow mode if both land; there is no code dependency. Add idempotent put/delete and a bounded pins read. Pinning grants no read access. Independently disclose board, thread, opening, Realm and Space before/final; withheld pins expose no identifier. Show pins only on the first board page, deduplicate the visible ordinary page without changing its native cursor or candidate budget.

Done includes moderator controls with stable uncertain-retry intent, a reader section and preserved ordinary board traversal. Preserve existing rank tests; update only a nonfrozen expectation whose behavior changes and list it. Add the named native cases and one UI interaction, fewer test lines than product. Stories: first-page reader with pins, moderator pin/unpin, and empty pins, phone/desktop from recorded native responses. Target 350–450 product lines.
