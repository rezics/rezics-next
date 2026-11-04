---
goal: 'commerce'
manager: 'commerce'
kind: 'implementation'
paths:
  [
    'services/kernel/src/library/collection-bulk-*',
    'services/kernel/src/library/bulk-*',
    'services/kernel/test/library/*bulk*',
    'services/kernel/db/library/migrations/*',
    'docs/library-and-collections.md',
    'docs/goals/library.capabilities.md',
    'services/kernel/src/library/README.md',
  ]
riskAreas: ['authorization', 'disclosure', 'rights', 'account', 'deletion']
criticalPath: false
after: ['a04a37f9-755a-4c76-917d-f0d7f20ba142']
waiting: []
acceptance:
  {
    'tests':
      [
        'Mounted Collection capture accepts a currently authorized filtered source and binds the complete native target set to review without page narrowing.',
        'Native status and Collection writers preserve exact receipts, effects and mixed result groups through replay, authority loss and partial cancellation.',
        'Bounded operation status and result cursors restore the existing Web flows and retention cleanup without a new selection engine.',
      ],
    'failing': true,
  }
estimate: { 'lines': 1400, 'files': 12 }
---

# Finish mounted native bulk review and result continuity

Continue the existing capture and bulk operation work. Current source includes persisted remote receipt reconciliation, bounded outcomes, cancellation handling and the original operation identity. Complete the mounted full-filter capture, actual target execution and recoverable result path with native acceptance.

The focused journey still exposes three user-visible gaps: Collection-backed preview returns `not_found` for both an unfiltered 101-occurrence source and a filtered review source; the real status writer records `target_denied` when the retained scenarios require an applied effect; and exact native add replay stops with `evidence_missing`. Diagnose each against the installed owner and Access contracts. Preserve the complete captured set, current account and membership fences, receipt identity, cancellation effects, retirement disclosure fences, bounded result pages and cleanup. Keep the existing four Web flows and do not add a second selection engine.

Run the focused changed test after each committed fix. The changed Kernel check also reports unrelated compiler errors in `packages/client/src/index.ts`, `src/community/routes.ts` and `src/content/appeal-routes.ts`; leave those foreign areas closed unless the owner contract requires them. The shared check runner may additionally fail while returning the generated schema-diagnostics directory; do not weaken acceptance to work around that infrastructure result.
