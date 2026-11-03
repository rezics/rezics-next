---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/test/rating/growth-segment-terminal.test.ts",
    "services/kernel/test/rating/support/growth-segment-terminal-fixture.ts",
    "docs/research/content-rating-segment-terminal-growth.md"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "after": [],
  "acceptance": {
    "command": [
      "bun",
      "run",
      "--cwd",
      "services/kernel",
      "check",
      "test/rating/growth-segment-terminal.test.ts"
    ],
    "placement": "default",
    "tests": [
      "Done-when 4: native rating segment and eligibility terminal/replay growth; missing registered completion evidence"
    ],
    "failing": true
  },
  "estimate": {
    "lines": 250,
    "files": 3
  },
  "criticalPath": false,
  "waiting": []
}
---

Complete the committed native terminal and replay growth measurement. First run the kernel typecheck and fix only diagnostics introduced by these declared files. Do not weaken or bypass the schema consistency check. Once the check can reach the focused test, fix failures caused by this fixture and test, then record the exact revision, reached assertions, and independent 256/1024/4096 observations for unrelated votes and retained history in the operation-binding document. Preserve the existing re-key page binding and do not add product or shared runtime code. If an actual product failure is reached, report its exact failure and proposed owning seam.
