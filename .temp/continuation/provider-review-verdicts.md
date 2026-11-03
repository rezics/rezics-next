---
{"goal":"imports","manager":"imports","kind":"claim","paths":["services/kernel/src/semantic/candidates.ts","services/kernel/src/semantic/http/subjects.ts","services/kernel/src/semantic/provider-review-queue.ts","services/kernel/test/semantic/provider-review-queue.test.ts","docs/import-review.md"],"riskAreas":[],"criticalPath":false,"waiting":[],"after":[],"acceptance":"A reviewer can record accept, reject, or abstain through ordinary native permissions. Provider review exposes each verdict separately from statement rank, including deprecated rank, and the current-dev native queue acceptance passes.","estimate":"small"}
---

# Keep all provider review verdicts distinct

Complete the reviewer journey for contributor proposals. Reviewers can explicitly accept, reject, or abstain through
the native API and ordinary permissions. Queue and Subject readings preserve each exact verdict separately from
statement rank, including deprecated rank. Update the owning review contract and freeze the native acceptance for
contributor and reviewer personas.

The current native API exposes only `:accept` and `:reject`; `decideCandidate` also accepts only those verdicts.
Provider queue hydration maps a stored abstention to `decision: null`, so the queue cannot distinguish abstention from
no decision. Extend the Semantic-owned decision and queue contracts; Imports consumes the resulting proposals.
