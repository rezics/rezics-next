---
{
  "goal": "search",
  "manager": "search",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/search/facet-discovery-runtime.ts",
    "services/kernel/src/search/facet-discovery-operations.ts",
    "services/kernel/src/search/facet-discovery-storage.ts",
    "services/kernel/src/search/scoped-facet-source.ts",
    "services/kernel/src/search/service.ts",
    "services/kernel/src/search/public-runtime.ts",
    "services/kernel/src/search/scope-source.ts",
    "services/kernel/src/search/service-scope.ts",
    "services/kernel/test/search/second-scope-facet-source.test.ts",
    "docs/search-facet-runtime-plan.md"
  ],
  "riskAreas": [
    "authorization",
    "disclosure"
  ],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "acceptance": {
    "tests": [
      "Scoped native facets enumerate only values contributed by the complete authorized matching population, with useful pages and proven exhaustion.",
      "Scope/membership/authorization changes invalidate or repair the retained observation before disclosure; no private rows, sampled counts or Global fallback establish success."
    ]
  },
  "estimate": {
    "lines": 650,
    "files": 10
  }
}
---

Remaining outcome: connect the immutable Realm or Collection admission request to the existing facet reader without changing the public facet DTO. Adapt the existing scope owners' native candidate and membership seams to the new scoped source, honoring their producer limits. Carry the real source identity, query meaning, population observation and current authorization through the retained build and opaque continuation. Enumerate complete value projections for only current members, seek canonical item/code/type keys, and revalidate the scope before retained publication and page disclosure. Add integration cases for full pages, final exhaustion, hidden or unmatched members, and membership or authorization changes during a read. The scope-to-facet caller handoff and native scoped acceptance remain to be completed.
