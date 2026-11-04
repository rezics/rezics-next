---
goal: commerce
manager: commerce
kind: implementation
paths:
  - services/kernel/src/rating/votes.ts
  - services/kernel/src/library/list-import-vndb.ts
  - services/kernel/test/library/list-import-vndb-http.test.ts
  - apps/web/src/library/personal-list-import/**
  - apps/web/tests/personal-list-import*.test.tsx
  - apps/web/tests/m1-vndb-library-return.test.tsx
riskAreas: [authorization, disclosure, rights, account, deletion]
criticalPath: false
waiting: []
estimate:
  lines: 650
  files: 7
acceptance:
  tests:
    - "The native guarded vote writer atomically checks account, target, standard question revision, current-vote basis and import review identity before applying or clearing a vote."
    - "Commerce applies the original scoreReviewId through that writer and returns exact applied, stale, refused or unknown outcomes without falling back to the unguarded writer."
    - "The score review and Library return journey retains independent state outcomes and exact receipt references after native score adoption is delivered."
  failing: true
  workerOwned: true
---
# Finish VNDB native score adoption

Commerce now consumes the published VNDB score review and apply identities. Readers can compare the original source score with the native question and current vote, explicitly select an exact supported unit, consent to the choice, and review score effects independently from Library state. The native import currently records score reviews but reports `unavailable` for score apply because Content's existing guarded vote writer still throws `atomic_guard_unavailable`.

Content must deliver that conditional native writer through its existing question and vote authority. Commerce can then replace the explicit unavailable seam in `services/kernel/src/library/list-import-vndb.ts` with guarded apply and durable exact outcomes. Keep the official callable and generated schema as the only public contract. Do not add a vote endpoint, use the unguarded writer, or reinterpret an unavailable receipt as an applied vote.
