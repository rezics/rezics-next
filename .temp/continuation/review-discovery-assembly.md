---
{
  "goal": "search",
  "manager": "search",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/search/discovery.ts",
    "services/kernel/src/search/discovery-registry.ts",
    "services/kernel/src/search/discovery-hydration.ts",
    "services/kernel/src/search/discovery-documents.ts",
    "services/kernel/src/search/discovery-current.ts",
    "services/kernel/src/search/account-discovery.ts",
    "services/kernel/src/search/discovery-query.ts",
    "services/kernel/src/search/generations.ts",
    "services/kernel/src/search/generation-publication.ts",
    "services/kernel/test/search/second-scope-reviews.test.ts"
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
      "The shared mixed registry, document validator, generation projection and current-disclosure path consume the Content review leaf adapter without reimplementing its source.",
      "A ready review is returned only when the thread identity, native revision and source position match current authorized Content summaries; withdrawal, deletion and restoration remain safe during lag."
    ]
  },
  "estimate": {
    "lines": 650,
    "files": 10
  }
}
---

Connect the review adapter to the existing mixed Search pipeline after the shared owner adds its Content registration slot. Keep the canonical identity `(content, review, thread ID)`, consume only the bounded revisioned source in `review-discovery.ts`, and preserve the existing generic response, global frontier, whole-query disclosure and generation rules. The Content owner still needs to supply the complete native review population and current authorized summaries implementing the named seam; do not add a second producer or infer coverage from a listing sample.
