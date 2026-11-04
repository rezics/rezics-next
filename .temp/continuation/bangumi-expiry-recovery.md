---
goal: "commerce"
manager: "commerce"
kind: "implementation"
paths: ["services/kernel/src/library/list-import-bangumi.ts", "services/kernel/src/library/list-import-entry-metadata.ts", "services/kernel/src/library/entry-personal.ts", "services/kernel/test/library/list-import-bangumi*", "services/kernel/test/library/*erasure*", "docs/library-import-bangumi.md", "docs/goals/library.capabilities.md"]
riskAreas: ["authorization", "disclosure", "rights", "account", "deletion"]
criticalPath: false
after: ["fd3f1482-f0f5-4efd-952e-89b3dbcef992", "098e5c16-2b7b-432d-822f-24722abab2b4"]
waiting: []
acceptance: {"tests": ["An in-flight private note, privacy or date adoption cannot start a new native effect after source expiry, while an exact prior native receipt can reconcile without refreshing source authority.", "Unresolved command linkage remains recoverable and bounded after evidence is scrubbed, and terminal owner erasure removes that linkage without undoing acknowledged native facts.", "Composed expiry, retry, cancellation, terminal fence, cleanup restart and inclusive-cost acceptance passes at native scale."], "failing": true}
estimate: {"lines": 700, "files": 7}
---

Complete the remaining Bangumi expiry and private recovery edge cases. The current change installs an absolute seven-day upload deadline, bounded indexed cleanup, fresh state and label admission fences, private review receipts, export filtering and terminal erasure coverage. Finish the race where an already-started private note, privacy or source-date command crosses expiry: block a fresh native effect while allowing the original native receipt to reconcile. Scrub provider evidence at expiry while retaining only the bounded command operands needed to resolve unknown outcomes. Then verify replay, cleanup, erasure and inclusive cost through the owning native acceptance. The Content-owned canonical schema artifact and the frozen/full native gates remain integration responsibilities.
