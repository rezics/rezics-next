---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "claim",
  "paths": [
    "services/kernel/src/library/members-preparation*",
    "services/kernel/src/library/collection-reads.ts",
    "services/kernel/src/library/owner-filter-plan.ts",
    "services/kernel/src/search/scope-members-work*",
    "services/kernel/src/search/scope-work-context.ts",
    "services/kernel/src/library/collection-source-work-native.ts",
    "services/kernel/src/work/selected-runtime.ts",
    "services/kernel/src/history/operational-work-selected.ts",
    "services/kernel/test/library/members-preparation*.test.ts",
    "services/kernel/test/library/support/members-preparation*.ts",
    "docs/dynamic-collections.md",
    "docs/filtered-lists.md",
    "docs/goals/library.md",
    "services/kernel/src/library/README.md"
  ],
  "riskAreas": ["authorization", "disclosure", "rights", "account", "deletion"],
  "acceptance": {
    "command": ["bun", "run", "--cwd", "services/kernel", "check", "test/library/members-preparation-budget.test.ts", "test/library/members-preparation-durable-native.test.ts", "test/library/members-preparation-native.test.ts", "test/library/members-preparation.test.ts"],
    "tests": ["Prove the funded filtered journey, prepared/direct dispatch, original positive reservation and concurrency, completion, stale and terminal outcomes, cleanup, provenance revalidation and size-independent budgets across all eight axes."],
    "failing": true
  },
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "estimate": {"lines": 850, "files": 14}
}
---

Complete the native Members preparation worker and readback. Bind every episode to the complete current physical
Source authority and retain that authority through the producer, result rows, and each read. Add bounded
prepared/direct dispatch without changing direct cursors. Revalidate the current Collection, filter,
authorization, disclosure, and selected provenance through load and retry. Keep all eight budget axes in the finite
parent, charging Core/Access, History registration and receiving, transfers, executor controls, retries, rollback,
and cleanup. Extend the original native fixture to prove useful results, duplicate/concurrent admission, expiry,
stale and terminal outcomes, cleanup, provenance revalidation, and size-independent work at the original scales.
Update the owner docs for the completed behavior. Collection list previews remain read-only; only the common
Members GET may reserve preparation because it carries the current bound Source and filter.
