# Resume catalogue paths after shared seed failure

Goal: imports
Manager: semantic

Command: bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts
Revision: 3308cd5a887f021b586562315d407de37aca6c9b
Started: 2026-11-07T12:14:28.623Z; ended: 2026-11-07T14:08:48.335Z
Elapsed seed work: 3888ms
Affected rows: I05, I06, I07, I08, I09, I10, I11, I12
Cause: seed exited 1: Import transport failed phase=http method=POST target=http://127.0.0.1:20033/v1/subjects:batchWrite status=503 problem=semantic_not_ready network=none correlation=none remaining{POST /v1/subjects:batchWrite}

Existing owner: Semantic cf23. This is input for that repair, not a second implementation assignment. Proposal contention and sourceFences remain separate incidents. Operation/partition/server phase are unretained unless present in the safe request evidence. No catalogue current read or browser path was exercised after the failed seed.

Use the returned seed.log and remaining-request.json, retaining the exact prepared source tuple, native type, converter, method/path/status and any safe problem/correlation. Resume only through ordinary APIs and the original sealed body/key. The complete fresh manifest must finish before catalogue reads. Rerun this same twelve-row command; preserve exact id/type, public facts, provenance, separate acceptance/adoption and phone/desktop assertions. Tags' same-handle continuation and Semantic's concurrent Sources erasure keep their existing owners.
