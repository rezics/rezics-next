---
{
  "goal": "performance",
  "manager": "performance",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/semantic/read-subject.sql",
    "services/kernel/src/content/routes.ts",
    "services/kernel/test/content/board-read-growth.test.ts",
    "services/kernel/src/content/README.md"
  ],
  "riskAreas": ["services/kernel/src/semantic/read-subject.sql"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "acceptance": {
    "command": ["bun", "run", "--cwd", "services/kernel", "check", "test/content/board-read-growth.test.ts"],
    "placement": "default",
    "tests": [
      "Concept board creation through the route wrapper has constant rows and statements and logarithmic blocks as unrelated board, Realm and subject history grows at scales [1, 4, 16]"
    ],
    "failing": false
  },
  "estimate": {"lines": 100, "files": 3}
}
---

# Bound concept board creation as unrelated community history grows

The existing expected-failing route check in `board-read-growth.test.ts` says `semantic.read-subject.sql` reads growing
`semantic.fact` rows and crosses the background block bound. Its scale inputs are `[1, 4, 16]` with 500 population
units per scale: 500, 2,000 and 8,000. Focused remote checking did not reach the tests in this attempt, so per-scale
measured block counts are not available here. Preserve the check's native Access and route wrapper, then fix the
growing read and record the measured rows, statements and blocks at each scale.
