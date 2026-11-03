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
  lines: 1900
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
    - "The mounted journey uploads an actual admitted final artifact, reviews one conflict and one preserved local edit, explicitly maps labels/state and presents only native selected outcomes."
    - "Wrong/incomplete format, unavailable old vocabulary, changed revision/incarnation, replaced review selection, partial success, original retry, cancellation and account/source retirement preserve privacy and exact intent."
    - Three-scale supplied-page checks add no per-row hydration or full-archive traversal; unsupported sections never become restored.
  failing: true
---

# Finish reviewed archive recovery

The mounted route, generated archive merge DTOs and native immutable review identity are still required. The current
installed `KernelClient` composition omits `libraryArchiveMerges`, and native selected apply still accepts ordinals
without the exact review identity shown to the person. Keep production file transfer disabled until both contracts
exist. Continue from `selection.ts` and `visit.ts` as transport-neutral custody; do not replace them with simulated
native admission or native receipts.

Finish the mounted upload, private inventory, bounded evidence page, explicit state and label mapping, conflict
review, exact selected confirmation, partial results, original uncertain retry, cancellation and account/source
retirement after the generated methods carry the review identity through preview/review/apply. Use the generated
client directly, preserve original credentials, key and body on retry, and derive response bounds with the native
owner. Dispose the visit on unmount and session replacement, supply a live binding reader, and do not copy projected
page rows into page context.

Add connected upload, review/conflict and partial-result Storybook states through the existing route custody, eight
localized scope guides, and the mounted tests named in acceptance. Include actual producer artifacts and all specified
stale, retry, cancellation, retirement and 1/50/100 by 64/512/4096 growth cases. Keep unsupported sections inert,
retain native receipts, and verify the completed page through the controller's post-integration acceptance and browser
inspection.
