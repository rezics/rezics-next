# Thread document media

Goal: content
Manager: content

Finish the visitor journey under `apps/web/src/threads/README.md` (Composed current thread page and Document image
inspection) and `services/kernel/src/content/README.md` (Current thread reading page and Document image presentations).

The installed `packages/client/src/index.ts` derives ReadingPageResponse from the generated reading-page route.
Its generated `content/reading-page.d.ts` and `content/routes.d.ts` still omit documentMedia. Obtain the complete
official-client publication from its publisher before migrating; do not replace it with an overlay, copied DTO,
private import, cast or reflective access. The content inbox contains this dependency decision.

This attempt propagates the current request's abort signal through the retained thread media batch and shared
transport. The focused selected-post receiver test now covers optional media failure preserving readable opening
and reply text, next cursor and selected-post availability, and abort retirement reaching the media request.

After publication, derive the closed page/document/image types from ReadingPageResponse.documentMedia, bind only
exact readable post/thread/revision/hash and declared references, and remove only current-thread hydration. Keep the
shared adapter for its unrelated consumers. Reuse the original renderer and retiring browser lease. Complete mounted
first/continued/selected-post, variants/credit, inspect/return, revision/accepted-reply refresh, unavailable/overflow
recovery, exact cursor retry and A/B/A retirement tests. Keep original assertions and native 21-document/32-image
selection, final admission, disclosure/erasure and physical/growth acceptance intact.

The installed projection migration and full mounted journey remain unfinished. Native, browser and root acceptance
are deferred to integration. Worker verification commands for the changed receiver:

    bun run --cwd apps/web typecheck
    bun apps/web/scripts/focused.ts --private-network -- bun test tests/thread-page-reading.test.ts

Controller native acceptance remains:

    bun run --cwd services/kernel check test/content/reading-page-documents.test.ts test/content/thread-reading-page-contract.test.ts
