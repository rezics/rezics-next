---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/library/personal-list-import',
      'apps/web/src/library/personal-list-import.md',
      'apps/web/src/routes/library/import-vndb.tsx',
      'apps/web/src/library/navigation.ts',
      'apps/web/messages',
      'apps/web/tests/personal-list-import.test.tsx',
      'docs/goals/web.md',
    ],
  'riskAreas': [],
  'criticalPath': false,
  'after': ['2bb1fbdd-fd3b-4f51-a945-0faf1a112617'],
  'waiting': [],
  'estimate': { 'lines': 2500, 'files': 12 },
}
---

# Complete the signed-in VNDB list import visit

Continue after the installed `@rezics/client` `KernelClient` exposes the mounted native
`libraryImports.vndb` methods for preview, bounded page reads, source evidence, review, apply, cancellation and
deletion. The native service and owner contract already exist; this attempt found the generated client composition
missing. Bind those generated methods directly. Keep the route unavailable until they are present; do not add a local
endpoint, parser, synchronizer, or native implementation.

Add a discoverable signed-in Library entry and mounted route. Upload the person's own VNDB XML export, show native
preview, traverse rows page by page, and let the person inspect ambiguous, unmatched, skipped and unsupported rows.
Titles may help with display and explicit catalogue search but never select identity. Keep VN identifiers distinct
from release IDs. Permit only native-supported explicit target and Library-state choices. Show score scale and source
state, progress measures, date precision, notes, privacy and unmapped evidence, and explain what remains private
source evidence. Existing facts stay unless the person chooses a reviewed native replacement. Preview makes no
changes; no private note becomes a public review or local rating.

Use native admission only. Explain the independent 2 MiB XML bound (invalid XML or XML overflow returns HTTP 400) and
the escaped JSON request wire bound of 12 MiB + 64 bytes (overflow returns HTTP 413). Browser file size is not wire
size. Preserve the actual native error states, bounded pages and row receipts. Confirm only the displayed admitted
selection. Keep original unknown apply command operands, sender, credentials, key and exact selection for explicit
retry. Preserve acknowledged rows across cancellation, departure and partial failure; stopping work does not promise
rollback. Session or source replacement retires the upload, preview, late callbacks and retry authority. Keep private
content out of URLs, persistent browser storage, public metadata and diagnostics.

Use the existing form, review, departure and target-search patterns. Preserve viewer and CSRF-session custody,
current-reading retirement, independent disclosure and keyboard focus through upload, review, confirmation and
results. Cover all eight locales, phone width 390, desktop, wrapping 44px actions, recovery and partial application.
Add focused consumer tests with fewer lines than product; keep native execution evidence with its producer/verifier.
Update the Web owner page with delivered behavior and any remaining native limitations. Do not combine MAL or
provider-catalogue imports, add export behavior, or start a visual campaign.
