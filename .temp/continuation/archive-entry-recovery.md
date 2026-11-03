---
goal: web
manager: web
kind: interface
paths:
  - apps/web/src/library/archive-entry-recovery/page.tsx
  - apps/web/src/library/archive-entry-recovery/upload.tsx
  - apps/web/src/library/archive-entry-recovery/review.tsx
  - apps/web/src/library/archive-entry-recovery/selection.ts
  - apps/web/src/library/archive-entry-recovery/results.tsx
  - apps/web/src/library/archive-entry-recovery/contract.ts
  - apps/web/src/library/archive-entry-recovery/native.ts
  - apps/web/src/library/archive-entry-recovery/server.ts
  - apps/web/src/library/archive-entry-recovery/visit.ts
  - apps/web/src/library/archive-entry-recovery/cost.ts
  - apps/web/src/library/archive-entry-recovery/departure.tsx
  - apps/web/src/library/archive-entry-recovery/index.ts
  - apps/web/src/library/archive-entry-recovery.md
  - apps/web/src/routes/library/recover-archive.tsx
  - apps/web/src/stories/archive-entry-recovery.stories.tsx
  - apps/web/tests/archive-entry-recovery.test.tsx
  - apps/web/tests/archive-entry-recovery-native.test.ts
  - apps/web/messages/en.json
  - apps/web/messages/zh-Hant.json
  - apps/web/messages/zh-Hans.json
  - apps/web/messages/ja.json
  - apps/web/messages/ko.json
  - apps/web/messages/de.json
  - apps/web/messages/fr.json
  - apps/web/messages/es.json
estimate:
  lines: 1600
  files: 25
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/archive-entry-recovery.test.tsx
    - tests/archive-entry-recovery-native.test.ts
  placement: default
  tests:
    - "The mounted journey uploads a completed producer artifact, reviews bounded inventory and conflicts, maps current states and labels explicitly, and applies only the exact native reviewed selection."
    - "Wrong or incomplete formats, unavailable old vocabulary, revision or incarnation changes, replaced selections, partial receipts, lost checkpoints, original retry, cancellation, and account or source retirement preserve privacy and exact intent. Pending or recoverable applications expose no progress facts; only checkpointed native receipts expose outcomes."
    - "Supplied pages of 1, 50, and 100 rows add no per-row hydration or full-archive traversal with 64, 512, and 4096 unrelated records; unsupported sections are never restored."
  failing: true
criticalPath: false
waiting: []
after:
  - 50cd17f7-d206-410e-bbe4-0122b0d0c7ff
  - 9d309281-e72d-4c26-9454-9c95801bcf06
  - 580e0b1f-f3ac-478d-aee2-7805b3334a30
  - 8bb77283-1922-4ff2-88aa-eb598a35f98c
  - 6478b4af-229d-4293-9322-e0a021613820
  - 5d6007c0-f10d-48a2-b569-4ff1c8b53a27
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
---

# Finish the reviewed archive recovery journey

The clean base already has local visit custody for upload replacement, review invalidation, evidence expiry,
uncertain/recoverable replay, cancellation, and retirement. The mounted page remains unavailable and its file input is
disabled. Keep it that way until the installed generated archive client can carry immutable native review identity.

The installed `@rezics/client` declaration currently omits `reviewRevision` from preview records and review results,
and its apply request accepts ordinals without revisions. The upload input is also declared `unknown`. This means the
mounted journey cannot bind a person's exact confirmation to the review they saw using the generated types. Resume
after the archive producer publishes the complete contract and it is present in the installed declarations. Use the
generated methods directly; do not repair this gap with casts, handwritten declarations, raw endpoints, or invented
native receipts.

Then deliver the private mounted journey: admit a completed producer artifact, show inventory from bounded pages, let
the person preserve local conflicts and map supported current entries, states, and labels explicitly, confirm the
exact selected review, and show only checkpointed native results. An unresolved application must replay the same
review, key, and immutable operands. Unsupported sections remain inert. Add the named connected upload, review/conflict,
and partial-result stories, eight localized scope guides, and mounted tests for the acceptance cases above. Use
`docs/library-archive-merge.md`, `docs/library-export.md`, and
`apps/web/src/library/archive-entry-recovery.md` as owners.
