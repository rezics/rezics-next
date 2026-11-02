---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "claim",
  "paths": [
    "services/kernel/src/library/members-preparation*",
    "services/kernel/src/library/members-preparation-work*",
    "services/kernel/src/library/collection-reads.ts",
    "services/kernel/src/library/collection-preview*.ts",
    "services/kernel/src/library/owner-filter-plan.ts",
    "services/kernel/src/search/scope-members-work*.ts",
    "services/kernel/db/library/schema.sql",
    "services/kernel/db/library/migrations/*members-preparation*.sql",
    "services/kernel/test/library/members-preparation*.test.ts",
    "services/kernel/test/library/support/members-preparation*.ts",
    "apps/web/src/library/collection-load.ts",
    "apps/web/tests/collection-read-page.test.ts",
    "docs/dynamic-collections.md",
    "docs/filtered-lists.md",
    "docs/goals/library.md",
    "services/kernel/src/library/README.md"
  ],
  "riskAreas": ["authorization", "disclosure", "rights", "account", "deletion"],
  "acceptance": {
    "command": ["bun", "run", "--cwd", "services/kernel", "check", "test/library/members-preparation-budget.test.ts", "test/library/members-preparation-durable-native.test.ts", "test/library/members-preparation-native.test.ts", "test/library/members-preparation.test.ts"],
    "tests": ["Preserve original positive native reservation, concurrency, completion, stale and terminal outcomes; prove the funded filtered journey and size-independent budgets."],
    "failing": true
  },
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "estimate": {"lines": 900, "files": 15}
}
---

Complete the producer and reader for funded filtered Members preparation. Retain and compare the complete canonical definition against the real immutable release, execute it through the selected runtime's complete Source child declaration and physical Source authority, and save only derived candidate rows. A locator, workflow state, or selected History response is never Source authority.

Connect bounded prepared/direct dispatch to the existing direct filtered reader without changing its cursor contract. Revalidate the current Collection, filter meaning, owner authorization, disclosure, and selected provenance both when loading and retrying. Keep every operation within the finite parent reservation across Core/Access, History registration and receive, Source, transfer, executor control, retry, rollback, and cleanup. Add cleanup and readback that use the current Source as final authority. Extend the native fixture with useful results, duplicate/concurrent admission, expiry, stale and terminal transitions, cleanup, and size-independent measurements across all eight budget axes. Preserve existing direct-reader and native reservation assertions.
