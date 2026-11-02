---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "claim",
  "paths": [
    "services/kernel/src/library/members-preparation*",
    "services/kernel/src/library/collection-reads.ts",
    "services/kernel/src/library/collection-preview*.ts",
    "services/kernel/src/library/owner-filter-plan.ts",
    "services/kernel/src/library/collection-source-work*.ts",
    "services/kernel/src/library/collection-source-output*.ts",
    "services/kernel/src/search/scope-members-work*.ts",
    "services/kernel/src/search/scope-work-context.ts",
    "services/kernel/db/library/schema.sql",
    "services/kernel/db/library/migrations/*members-preparation*.sql",
    "services/kernel/test/library/members-preparation*.test.ts",
    "services/kernel/test/library/support/members-preparation*.ts",
    "apps/web/src/library/collection-load.ts",
    "apps/web/tests/collection-read-page.test.ts",
    "docs/dynamic-collections.md",
    "docs/filtered-lists.md",
    "docs/goals/library.md",
    "services/kernel/src/library/README.md",
    "services/kernel/src/library/members-preparation-contract.md"
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
  "estimate": {"lines": 1000, "files": 19}
}
---

The current base has the native reservation, read touch, fenced step admission and mounted status recovery. The
selected worker still returns `dependency_unavailable` instead of actual prepared filtered results. Complete the
producer and readback only with the complete Source child declaration and current physical authority; a locator,
selected History success, cached completion flag, raw-prefix exhaustion or expired transfer grants no authority.

Prepay one finite C3 parent before first I/O across all eight axes and every charge, transfer each child before
checkout, register once per preparation key, and never refill or add a payer. Keep work independent of catalogue,
owner and history size. Install bounded prepared/direct dispatch without invalidating direct cursors. Preserve the
original Collection, filter and cursor through loading/retry, current authorization and disclosure, and selected
native provenance. Prove useful completion, duplicate/concurrent admission, expiry, terminal outcomes, cleanup and
size-independent work with the existing native fixture.
