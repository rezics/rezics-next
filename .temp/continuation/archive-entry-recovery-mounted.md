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
  - docs/library-archive-merge.md
  - packages/client/src/kernel/library/library-archive-merge-routes.d.ts
estimate:
  lines: 1600
  files: 27
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
    - >-
      The mounted journey uploads an actual admitted producer artifact, shows private inventory and a supplied bounded
      page, maps current state and label IDs explicitly, preserves conflicts, confirms exact selected review revisions
      and displays native partial results.
    - >-
      Recoverable and lost-checkpoint applies suppress uncheckpointed progress facts, preserve original upload, review
      ID, idempotency key and operands for retry, and reveal only checkpointed native results.
    - >-
      Wrong and incomplete artifacts, unavailable old vocabulary, changed revision or incarnation, replaced review,
      partial cancellation, and account or source retirement preserve privacy and intent.
    - >-
      Supplied pages of 1, 50 and 100 rows add no per-row hydration or full-archive traversal at unrelated-record
      counts of 64, 512 and 4096.
    - >-
      Connected upload, review/conflict and partial-result stories render in all eight localized scope guides;
      unsupported sections remain inert.
  failing: true
criticalPath: false
waiting: []
after:
  - 9d309281-e72d-4c26-9454-9c95801bcf06
  - 580e0b1f-f3ac-478d-aee4-7805b3334a30
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

# Finish the mounted reviewed archive recovery journey

Complete the existing signed-in `/library/recover-archive` route with the generated `libraryArchiveMerges` client.
Keep the file control disabled until the installed declarations expose `preview.records[].reviewRevision`,
`review.reviewed[].reviewRevision`, and `apply.post({items:[{ordinal,reviewRevision}]})`. The service route source
already declares these fields, but the checked-in generated merge declaration remains ordinal-only. The client
declaration generator failed twice because the compiler reported:
`error: src/access/account-agent-active-page.sql(1,1): error reylo4: No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in .reylo.yaml.`
Use the configured kernel compiler database or check host when available. Do not hand-edit or substitute a client
declaration.

The current attempt strengthens the transport-neutral visit state so a cancellation that overlaps a claimed apply
keeps its original review and key, permits exact replay while unresolved, and cannot report partial results until a
native results checkpoint is admitted. Its tests use local values only and do not claim native admission or receipts.

Finish the real mounted upload, bounded private inventory and preview, explicit current state/label mapping, conflict
preservation, immutable selected confirmation, native partial outcomes, recoverable replay and cancellation. Bind
each choice to the original upload, review revision, receiving identities, Session credentials, idempotency key,
canonical operands and expected revisions. Add the live binding reader, clear private state on unmount/session
replacement, and keep unsupported sections inert. Receive the generated `CopyArchiveProgressApplication` and
`CopyArchiveProgressResult` directly where the existing route reconciles progress-copy receipts. Never expose
`progressSession` or `completedEpisodes` while an application is pending or recoverable; a current Session read does
not prove the original receipt.

Use the native owner's current composed cost: at most twenty archive operations, no separate Session reads during
Apply, and one bounded archive reload per lost-checkpoint replay (`20+L`). Keep the earlier `21+9` observation as
historical evidence only. Preserve export V3 assessment meanings and V4 provider evidence as specified by their
owners; provider evidence remains unsupported here. Add the connected stories, eight locales and mounted acceptance
cases above. Run only the current launch policy's permitted verification; controller acceptance, native growth and
browser checks remain deferred.
