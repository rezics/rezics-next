---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/board-pin-advice*.ts
  - services/kernel/src/content/board-pin-advice*.sql
  - services/kernel/src/content/routes.ts
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/runtime.ts
  - services/kernel/src/content/register.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/board-pin-advice*.ts
  - services/kernel/test/content/board-pin-management-journey.test.ts
  - apps/web/src/threads/board-pins/**
  - apps/web/src/threads/board-pins.md
  - apps/web/tests/board-pins*.test.tsx
  - apps/web/src/stories/board-pins*.tsx
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 89a84db1-8f3d-4293-8489-7229372f078d
  - b20c4b9c-6b6d-4b1f-bd6f-3cff3600ce43
  - c1e3cdb6-e3af-4e74-96a4-e858d16c591d
  - c023b977-fc2f-48a4-8bcf-77e0995f4282
  - e27d5886-80a4-4a23-8a94-10a2ed65726c
  - 717dd15a-ecc2-4374-90e3-fc8f56297133
  - 0b1f322f-8123-476a-8093-2af11583c3e7
  - 64856b3e-c5ad-4e01-92a3-a0df1b9553c3
waiting: []
acceptance:
  command:
    - bun
    - run
    - "--cwd"
    - services/kernel
    - check
    - test/content/board-pin-management-journey.test.ts
  placement: default
  tests:
    - "A current Board curator receives bounded selected pin advice, pins/unpins through the existing native writer and refreshes the same Board cohort under its new pin revision."
    - "Denied, missing and stale advice never derives authority from Board visibility, membership, pin position or previous selection; unknown writes preserve their original intent."
    - "Native selected advice is bounded by the displayed cohort and fixed response budget under independent threads, pins, revisions and Access growth."
  failing: true
estimate:
  lines: 1600
  files: 12
---

# Complete native Board pin management from selected inspection

The public Web `BoardPinAdviceWire` seam and optional `BoardPinProducer.inspectSelected` now validate and freeze closed exact sources, bind account viewer/Board/generation/selected output, preserve denied/stale/unavailable results, and withhold aborted completion. No generated declaration or Board opening composition changed. Owner contracts: services/kernel/src/content/README.md (Board pins and Cost) and apps/web/src/threads/board-pins.md. Continue retained complete-input publication through 416-retained-content-publication.md; record actual declaration head and installed typing when supplied.

Remaining outcome: connect the mounted manager to explicit advice for the displayed ordinary/pinned cohort and exact source revisions. Remove action inference from readBoard management flags and membership. Preserve the account, session, client, credentials, locale, source and visit lifetime. Missing advice and read-only views have no controls; full capacity retains explicit unpin. Changed sources require fresh explicit inspection and a restart of the same sort without the old cursor. Keep the single writer and one uncertain intent with frozen operands, sender, credential and key; readback never acknowledges it. Retire recovery on selected source/rows, Board or visit replacement with abort and generation guards. Restore keyboard focus to a surviving control. Inspect mounted states before final choices.

Write the missing services/kernel/test/content/board-pin-management-journey.test.ts using native Board/thread creation and pin commands: curator, member, nonmember, governance and suspended actors; concurrent five-slot claims; moved/erased/concealed exact sources, wrong parents, every duplicate, generation changes between observations and revoked authority before receipt lookup. Ensure off-page hidden pin IDs and whole-Board enumeration never escape selected advice. Measure independent threads, pins/history, revisions and nested Access at 256/1024/4096 with fixed selection/response budgets and all native Accounts/Realm/Subject work, authentication, both disclosure observations, pools, controls, preparations/evaluations/runners, indexed examined prefixes/rows/blocks, raw bodies/copies/serialization charged; update the existing Cost operation with actual results. No output-only bound claim.

Add route interaction tests for source binding, denied/unavailable controls, same-key retry, readback separation, cursor restart, retirement and keyboard focus. Only usable curator, read-only, full-capacity, unknown and changed-source stories, with screen-reader, keyboard, long text and 390/1280 widths. Native and rendered evidence remain separate from source and emitted typing. Existing source references in the original contract were inspected without porting legacy code. Do not import Realm reordering/highlights or private Home filter stores.
