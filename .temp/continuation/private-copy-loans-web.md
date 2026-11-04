---
goal: commerce
manager: commerce
kind: implementation
paths:
  - services/kernel/test/library/loan-*
  - apps/web/src/library/loans-*
  - apps/web/src/library/copies-page.tsx
  - apps/web/src/library/library-nav.tsx
  - apps/web/src/routes/library/loans.tsx
  - apps/web/src/stories/library-loans.stories.tsx
  - apps/web/tests/library-loans*
  - apps/web/messages/*.json
  - docs/library-loans.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - c34814a2-1b67-46e0-b7cf-6f44cd32c40d
waiting: []
acceptance:
  tests:
    - "Owner can lend or borrow an eligible copy, browse overdue and open loans, extend a due date, return it and read exact history through the mounted API and page."
    - "A conflicting open loan, stale version, copy disposal, concealed identity, account retirement and forged foreign copy never create an unauthorized loan or disclose private party data."
    - Original create/extend/return receipts survive lost acknowledgements and refresh without a duplicate loan; cursor membership changes are explicit and cleanup remains bounded.
    - "Independent 64/512/4096 native cases price all participating pools, indexes, authorization, locks, receipts, dispatch, hydration, serialization, retention and cleanup."
  failing: true
  workerOwned: true
estimate:
  lines: 1900
  files: 18
---

Finish the private copy-loan journey on top of the committed native API and migration. The mounted HTTP slice, copy disposal/deletion interlock, retained owner history, bounded terminal erasure, migration, derived schema, and one focused native journey test are already installed. Keep current copy editing and edition/format presentation intact.

Use the generated client contract from the content publication owner before implementing web calls. Keep missing client delivery explicitly unavailable until its matching generated output lands; do not use raw fetch, casts, handwritten declarations, suppressed compiler inputs or another generator. Build `/library/loans` from `/library` overflow navigation, add an eligible-copy action and a bounded accessible picker that can also reach an empty create/select-copy path. Preserve all locale translations, mobile full names, keyboard behavior, 44px controls and focus restoration.

Bind the page, selection, query/cache state, credentials and replies to current origin, owner, locale, resource and operation generation. A viewer replacement or late request must not mutate the newly selected row or another viewer's page. Use response-owned action/reason data, preserve form input on validation/conflict, retain the exact original command key and input across refresh or lost acknowledgement, and provide explicit reload/review for stale edits, invalid cursors, unresolved receipts and unavailable copy context.

Seed only the named rendered states: pending, empty, overdue, concealed person, unavailable copy context, stale edit, unresolved receipt and returned history. Add focused native HTTP cases for concurrent create, create/disposal, extension/return, exact due boundary, absent due date, lost create/return acknowledgement, repeated return, changed cursor membership, another account and owner retirement. Cover page response-derived actions, original command replay after refresh, viewer replacement during selection, invalid-cursor recovery, unavailable contexts and a late selection response.

Add independent 64/512/4096 native scale cases with inclusive cost bounds for each pool: admission/currentness, SQL statements/rows/blocks, indexes, locks, command dispatch during lost acknowledgement, receipts, presentation hydration, serialization, retention and bounded cleanup. Keep all shared schema and acceptance files frozen. Update `docs/library-loans.md` with the installed page behavior, actual measured bounds, unavailable states, exact checks run and outstanding acceptance. Run only the validation policy attached to the continuation.
