---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "implementation",
  "paths": [
    "apps/web/src/library/shelf-*",
    "apps/web/src/library/entries-*",
    "apps/web/src/library/*priority*",
    "apps/web/src/library/rich-private-entry/*",
    "apps/web/test/library/*priority*"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "account",
    "deletion"
  ],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "estimate": {
    "lines": 300,
    "files": 6
  },
  "acceptance": {
    "tests": [
      "The existing shelf offers native priority order and both directions, shows each returned rank and explicit Unranked state, and retains current status/type filters and URL cursor reset behavior.",
      "Priority edits use the existing revisioned private annotation seam and exact Entry incarnation; stale/currentness conflicts require fresh review, uncertain writes retain their original request key and operands, and navigation/account retirement prevents late responses from changing another visit.",
      "The actual installed @rezics/client typing accepts orderBy priority and exposes priority as number|null without casts, handwritten declarations, or an untyped endpoint."
    ],
    "failing": true,
    "workerOwned": true
  }
}
---

Finish the Web receiving journey after the retained Content publisher installs the generated contract requested in the commerce handoff. Use the existing Library shelf and shared item family. Connect the existing `@rezics/client` `KernelClient.libraryEntries` seam to native priority order, opening ascending so rank 1 leads, explicit ascending/descending controls, current status/type filters, URL state, and cursor reset on query changes. Render the returned 1–100 rank beside retained rows and label null as Unranked; do not calculate a second local ordering.

Reuse the current rich private-entry annotation editor and its action/review flow. Submit the expected annotation revision, exact Entry incarnation, originating account lifetime, and existing command operands. Preserve note and source operands on rank change or clear. Keep the original request key and intent when acknowledgement is uncertain; on a definitive stale or currentness conflict, require fresh review. Fence late reads and writes after subject, query, or account navigation/retirement so they cannot alter or disclose a different visit's rows.

Do not edit generated client declarations or enable the control until the installed generated type accepts the exact `orderBy: 'priority'`, `direction: 'asc' | 'desc'`, and `priority: number | null` response contract. The native producer already implements live keyset behavior: ascending ranks 1–100 then Unranked, descending ranks 100–1 then Unranked, ties by Subject UUID ascending. Priority mutations between pages follow the current-keyset semantics documented in the Library contract. Keep priority private; do not add it to Collection, feed, Search, or public votes.

Add focused Web tests for sort/filter/address behavior, rank and Unranked presentation, editor preservation and currentness, uncertain acknowledgement, stale navigation, and account retirement. Verify against the actual installed generated typing and run the Web workspace typecheck and focused tests through the supported wrapper.
