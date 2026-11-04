---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/board-slow.ts
  - services/kernel/src/content/board-slow-policy*.ts
  - services/kernel/src/content/board-slow-policy*.sql
  - services/kernel/src/content/routes.ts
  - services/kernel/src/content/reading-page.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/board-slow-policy-journey.test.ts
  - apps/web/src/threads/slow-mode/**
  - apps/web/src/routes/boards/$id.tsx
  - apps/web/src/routes/boards/$id_.new.tsx
  - apps/web/tests/slow-mode*.test.tsx
  - apps/web/tests/board-slow-policy*.test.tsx
  - apps/web/src/stories/slow-mode*.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 64856b3e-c5ad-4e01-92a3-a0df1b9553c3
  - b20c4b9c-6b6d-4b1f-bd6f-3cff3600ce43
  - e27d5886-80a4-4a23-8a94-10a2ed65726c
  - 717dd15a-ecc2-4374-90e3-fc8f56297133
  - d7615d61-fbfe-4b0f-9cd6-1c168186b123
  - fc61a92e-ab1e-4120-a0db-31e2772c2c65
waiting: []
acceptance:
  command:
    - bun
    - run
    - "--cwd"
    - services/kernel
    - check
    - test/content/board-slow-policy-journey.test.ts
  placement: default
  tests:
    - Bound work and retained bytes while Boards, thread homes, posts, Access history, permits and reservations grow independently
    - Mounted Board settings and posting visits preserve separate current authority, command acknowledgement and browser-visit retirement
    - Exact additive source and OpenAPI inputs feed the shared publisher without an acceptance dependency cycle
  failing: true
estimate:
  lines: 900
  files: 8
---

Finish the slow-mode policy journey by measuring the full native selection and authorization work at fixed bounds while independently growing completed permits, unrelated reservations and Boards, posts and thread homes, and Access history through 256, 1024 and 4096 records. Count both actor-key paths, fresh final authority, Auth, nested authority work, every database, control, preparation, evaluation and runner, examined prefix, row and block; charge raw bodies, copies and serialization. Extend the cost documentation and acceptance test to prove these bounds. Wire the exact additive source and OpenAPI inputs into the existing shared publisher without making acceptance depend on its own publication. Add mounted route coverage for current authority, opposite and malformed command acknowledgements, independent post-command inspection, source/session replacement and late return visits. Preserve the already implemented complete-policy controls, frozen uncertain command operands, pending advice, original admission behavior, writer and recovery protocol.
