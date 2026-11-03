---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/library/list-import-vndb*",
    "services/kernel/src/rating/votes*",
    "services/kernel/db/library/**",
    "services/kernel/db/rating/**",
    "services/kernel/test/library/**",
    "services/kernel/test/rating/**",
    "services/kernel/src/http/kernel.ts",
    "packages/client/src/kernel/library*",
    "docs/library-import-vndb.md",
    "docs/commerce.md",
    "docs/goals/library.capabilities.md"
  ],
  "riskAreas": ["authorization", "disclosure", "rights", "deletion", "account"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "estimate": {"lines": 1000, "files": 9},
  "acceptance": [
    "Use the Content-owned conditional admission guard around createVoteCommands.putVoteOutcome so reviewed question revision, current own vote or absence, target identity/counting identity, and competing local corrections cannot drift before mutation.",
    "Apply explicit confirmed native vote or clear with the reviewed operands and stable command key; preserve other imported fields and retry uncertain acknowledgements without rereading or changing operands.",
    "Return and persist the actual accepted, skipped, stale, unsupported, failed, and unavailable outcomes while preserving Content receipt/component semantics and native authorization before replay disclosure.",
    "Prove cancellation, expiry, source deletion, foreign ownership, and terminal account denial stop later effects while retaining already acknowledged native votes; test unsupported precision, consent, changed reviews, and lost acknowledgements.",
    "Use installed generated client requests/results and send Web303 the exact supported interface and losses; update the VNDB owner contract and capability entry with delivered behavior."
  ]
}
---

Finish native VNDB score adoption in the existing upload, review, apply, and results journey. The current implementation retains exact source scores and supports explicit native meaning, units, and consent in review, but leaves effects typed unavailable because Content has not supplied an atomic admission guard for its vote writer. Build the concrete cross-owner guard and connect the existing importer to the actual Content writer. Preserve the imported source score and original review, do not round 7.3, do not change votes for state-only imports, and do not add a vote writer or aggregate path in Library. Complete the bounded apply/replay lifecycle and tests, including the actual native receipt and public data permitted by Content. Do not add broad history discovery, an upload/evidence store, provider aggregate import, or a shared provider ABI.
