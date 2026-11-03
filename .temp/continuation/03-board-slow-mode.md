---
{
  "goal": "content", "manager": "content", "kind": "implementation",
  "paths": [
    "services/kernel/src/content/board-slow-mode*.ts",
    "services/kernel/src/content/board-slow-mode*.sql",
    "services/kernel/src/content/commands.ts",
    "services/kernel/src/content/routes.ts",
    "services/kernel/src/content/schemas.ts",
    "services/kernel/src/content/setup.ts",
    "services/kernel/src/content/README.md",
    "services/kernel/db/content/migrations/*_board_slow_mode.sql",
    "services/kernel/db/content/schema.sql",
    "apps/web/src/threads/board-slow-mode*.tsx",
    "apps/web/src/threads/composer.tsx",
    "apps/web/src/threads/post-writes.ts",
    "services/kernel/test/content/board-slow-mode-http.test.ts",
    "apps/web/tests/board-slow-mode.test.tsx",
    "apps/web/src/stories/board-slow-mode.stories.tsx"
  ],
  "riskAreas": ["authorization", "disclosure"],
  "criticalPath": false, "after": [], "waiting": [],
  "acceptance": {"command": ["sh", "-c", "bun run --cwd services/kernel check test/content/board-slow-mode-http.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/board-slow-mode.test.tsx"], "placement": "default", "tests": ["A moderator selects off/30/60/300 seconds; one account cannot bypass the interval by using another tab, thread or simultaneous new-thread/reply request on that board.", "Failed writes and receipt replays consume no extra interval; edits and currently authorized curators remain allowed; 429 preserves the draft and explicit retry succeeds after Retry-After."], "failing": true},
  "estimate": {"lines": 450, "files": 15}
}
---

# Give participants a clear board posting interval

A participant understands a board's posting interval and keeps their draft when posting too quickly. A moderator sets off, 30, 60 or 300 seconds; off is the default.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [atomic commands](services/kernel/src/content/README.md#atomic-content-commands) and [Community participation](services/kernel/src/community/README.md). Adopt the setting, command admission and error contract in the Content README in this change.

The interval is per account/board, covering successful new thread openings and replies, across tabs. Edits do not consume it. Current board:curate authority exempts a moderator; a cached role label does not. Install that action for existing local board and containing-Realm owner/moderator roles, composing idempotently with pins if present. Cross-partition review creation must use a bounded native admission/commit protocol: failure releases admission and no split account/thread check may permit two concurrent successes. Receipt replays repeat ordinary authority and do not charge again. Do not hold a foreign checkout while authoring in another home.

Return 429 with Retry-After and an exact retry boundary for a refused admitted write. A deadline only enables explicit retry; never auto-send. Preserve CSRF, command key, draft, target, ban and publication checks. Done includes moderator setting and participant composer feedback on real routes. Keep assertions for off, edits and ordinary authorization; add the two named native cases and one draft/retry interaction, with fewer test lines than product. Stories: off, participant waiting with draft, and moderator interval selector, phone/desktop using recorded native responses. Target 400–500 product lines.
