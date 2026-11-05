---
goal: content
manager: content
kind: interface
---

# Continue thread document image reading

## Outcome

Finish the visible current-thread image journey through the exact installed `ReadingPageResponse.documentMedia`
projection. Remove `readThreadDocumentMedia` from the thread page only after that installed response is available.
Retain the shared Media DTO and reflective transport for its other consumers until their official callable is installed.

## Current state

The native producer is in the base: `services/kernel/src/content/reading-page.ts` composes and returns
`documentMedia` from `reading-page-documents.ts`. The installed client does not yet expose the field:
`packages/client/src/kernel/content/reading-page.d.ts` omits it from `ReadingPageResponseSchema`, and
`packages/client/src/kernel/content/routes.d.ts` omits it from the generated `threads({ id })['reading-page'].get`
response. `packages/client/src/index.ts` derives `ReadingPageResponse` from that generated method. The official
client publisher owns that output; do not edit generated/client/OpenAPI/root files in this continuation.

This attempt committed the owner decision in `apps/web/src/threads/README.md` and sent the exact missing-field
evidence to the content inbox. `thread-page.ts`, the local thread-media adapter, and tests remain unchanged.

## Finish

Once the publisher installs the route-derived response, derive all Web wire types from `ReadingPageResponse`, remove
only the duplicate current-thread media read, and adapt the mounted body to the installed closed projection. Preserve
exact post/thread/revision/hash/reference binding, explicit unavailable/overflow behavior, native variants and credit,
readable text, cursor and selected-post recovery, and the existing reader retirement lease across edits, replies,
session and route replacement, invalidation, remount and A/B/A. Keep mention reads and unrelated Media consumers.
Add the smallest mounted acceptance test for the actual installed response, then run the landing test command and
Web typecheck after committing each change. Native, browser and root acceptance remain controller verification.
