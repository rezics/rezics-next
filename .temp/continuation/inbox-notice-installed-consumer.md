---
{
  "goal": "performance",
  "manager": "performance",
  "kind": "implementation",
  "paths": [
    "apps/web/src/inbox/inbox-notice-detail.tsx",
    "apps/web/src/inbox/inbox-read.ts",
    "apps/web/src/inbox/inbox-query.ts",
    "apps/web/src/inbox/inbox-page.tsx",
    "apps/web/src/routes/inbox.notice.tsx",
    "apps/web/src/routes/inbox.tsx",
    "apps/web/src/routeTree.gen.ts",
    "apps/web/messages",
    "apps/web/tests/inbox-notice-detail.test.tsx",
    "apps/web/tests/inbox-read.test.ts",
    "apps/web/tests/inbox-session-authority.test.ts"
  ],
  "riskAreas": [],
  "criticalPath": false,
  "after": [
    "06531661-8526-4bab-b8e7-a3731fa4b8ca",
    "c156a592-59c5-449a-9b99-d5ae76f7660a",
    "d9c5a408-5c67-4d33-bf97-76a9918a21b5"
  ],
  "waiting": [],
  "estimate": {
    "lines": 1400,
    "files": 11
  }
}
---

# Complete the installed Inbox notice journey

Acceptance:

- Use Content's official complete compiler and generator output for the mounted exact-owned-notice GET, the closed response DTO and the root-derived Inbox query including `selection`. Remove the `exactNoticeRoute` cast and any handwritten detail wire mirror. Do not edit generated declarations or substitute another generator.
- A signed-in person can open one owned notice directly or from the selected Inbox range. The private SSR read and retry use that notice's exact identity. Show its current actor name, avatar and handle with a safe name fallback, the full localized event time, native current context and only the owner-admitted destination. Conceal withheld actor or target data.
- Detail viewing and destination navigation do not acknowledge notices. The individual acknowledgement uses the original immutable notice, key and mounted viewer. Keep denied, unavailable, refused and uncertain outcomes distinct; retry the same intent after an unknown result. A confirmed receipt invalidates only that viewer's badge, list and detail. It never advances a bulk frontier.
- Return and back navigation preserve the exact All or Unread selection and opaque cursor. Expired cursors offer an explicit cursor-free restart. Keep 402's one-page replacement window, duplicate-ID ordering, exact failed-frontier retry and its existing acceptance ownership.
- Session change, A-to-B-to-A, replacement and unmount retire late reads and acknowledgement completions. Keep private data out of persistence.
- Use the existing detail renderer and focused test added by the predecessor. Add only the route, typed transport, retry wiring and focused assertions needed to complete direct-entry, keyboard/phone retry and return behavior; do not add a new test family for 402-owned cases.

Content's active admitted publisher continuation must deliver the official callable and root evidence. The consumer must not treat its source-lineage commit or the two-line handwritten selection module as that evidence.
