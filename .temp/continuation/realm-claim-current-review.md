---
{
  "goal": "web",
  "manager": "web",
  "kind": "interface",
  "riskAreas": ["authorization", "disclosure", "rights", "account", "deletion"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "paths": [
    "apps/web/src/community/realm-claim-review*.ts*",
    "apps/web/src/community/realm-claim-status*.ts*",
    "apps/web/src/community/realm-claim-caller-lifetime.ts",
    "apps/web/src/community/realm-claim-callers.md",
    "apps/web/src/community/realm-claim-current*.md",
    "apps/web/src/routes/realms/$id_.claims.tsx",
    "apps/web/src/routes/realms/$id_.claim-requests.$requestId.tsx",
    "apps/web/src/stories/realm-claim-current-review.stories.tsx",
    "apps/web/tests/realm-claim-current*.test.ts*",
    "apps/web/messages/*.json",
    "docs/goals/web.md"
  ],
  "acceptance": {
    "command": ["bun", "apps/web/scripts/focused.ts", "--private-network", "--", "bun", "test", "tests/realm-claim-current-review.test.tsx"],
    "placement": "default",
    "tests": [
      "The existing approver queue recognizes permitted current claimant identity and orphan episode; one selected request uses installed native action advice and exact inspection before existing approval/readback.",
      "Claimant own status remains separately authorized and distinguishes legitimate absence, pending, approved and historical episode without exposing approver-only facts.",
      "Sparse raw20 continuation, same-input retry and exact selected inspection remain independent; no clock, Realm role or transport success grants Global approval.",
      "Unknown approval preserves original request, episode, sender, credentials and key; retirement conceals private facts and late effects without claiming cancellation or replaying the write.",
      "One page and one selection stay bounded at 1/10/20 rows without per-claim identity or authority calls. Native eligibility, succession and growth stay Content/Accounts evidence."
    ],
    "failing": true
  },
  "estimate": {"lines": 2200, "files": 24}
}
---

Finish the existing Realm claim review page after Content publishes its current-review fields, reviewer-qualified exact
inspection and native action advice. Inspect the installed generated methods, exact response types and delivered native
examples before composing them. Keep the existing bounded queue, requester-owned status, native approval command and
private caller lifetime. Do not invent a route or DTO, use the claimant's exact status endpoint for an approver, add
another queue, or infer eligibility from Realm roles, elapsed time or transport success.

Show a display-safe claimant identity and the exact original orphan episode, with safe fallbacks for concealed or erased
identity and missing optional Realm context. Bind one selected request to the exact reviewer observation and episode
before confirmation. Keep one raw page of at most 20 rows, exact opaque continuation, sparse empty-plus-next behavior,
same-input retry, explicit first-page restart, independent selected inspection and native typed cursor failures. Keep
requester `mine` absence, exact missing policy, pending/approved state and `currentEpisode` historical meaning separate
from approver facts.

An unknown approval keeps its original Realm, request, episode, source, actor/session/CSRF and command key. Exact
inspection is read-only and cannot erase or replace that intent. Offer original-intent recovery only after an explicit
separate user action; never create a new key, automatically write again, replay after retirement, cancel native work or
infer owner grants from a pending row. Preserve committed native receipts while readback is pending and retain the
existing departure Stay/Leave owner, focus behavior and synchronous private-lifetime retirement.

Finish the named review stories, focused adapter/panel tests and localized recovery/status/refusal/history across all
eight locales. Compose actual adapters at 1/10/20 rows and track native reads, selected inspections, projected bytes
and retained state through continuation, retry and retirement. Keep Content/Accounts eligibility, identity history,
authority, succession and native growth claims out of Web fixture evidence. The final work must review the ordinary
admitted page at phone and desktop widths, in light and dark themes, with keyboard focus and long admitted values.

Current generated list, requester-status reader, caller lifetime and transport behavior are recorded in
`apps/web/src/community/realm-claim-current-review.md`; the remaining producer operation and exact examples are still
required before this continuation can be accepted.
