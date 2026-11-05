# Review destination receiver continuation

Goal: content. Manager: content. Continue with the same receiver owner and serial lineage.

Authority: [Review destinations](../../services/kernel/src/content/README.md#review-destinations). Keep shared thread
context and write-review lifetimes with their owners. The mounted producer is
`GET /v1/realms/:realmId/review-destinations` in `services/kernel/src/content/routes.ts`, using the native page
schema in `services/kernel/src/content/schemas.ts`.

## Goal content

At this attempt's base, `apps/web/src/threads/review-board-choices.ts` still declares a local route/page mirror and
calls through an `unknown` assertion. The installed `@rezics/client` resolves to `packages/client`; its public root
and installed content routes have no review-destinations declaration or callable. This is the only missing
prerequisite observed here. The existing receiver, journey assertions and content owner decision are retained.

Wait for the sole complete-input publisher to install the actual public export, head and callable. Do not change
generated paths or create a local declaration, endpoint, generator or raw transport. After publication, inspect the
actual installed public method, call it directly, and derive response and preparation types from its public result.
Keep complete runtime validation of untrusted response states and bindings, Subject source, Realm head and Board
security. Preserve the private transport and cancellation in the existing supplying action.

Continue the connected path: original Subject entry, bounded current Realm membership preparation, native sparse
destinations, deliberate exact Board inspection, existing composer and native command, admitted review navigation
and exact return. Retain explicit inspection for one Board, exact-cursor retry, denied/expired distinctions, original
disclosure, permanent visit retirement including equal replacement and A-B-A, and no admission from a label or
installed type. Preserve reader/CSRF provenance, uncertain command ownership and physical-growth acceptance.

## Manager content

Keep typing, chooser, composer handoff, recovery and return in this content-owned outcome; do not split them into
successor owners. Once the publisher's callable is present, finish the receiver and connected journey together. Run
Web workspace typing and the focused landing command:
`bun apps/web/scripts/focused.ts --private-network -- bun test tests/review-destination-journey.test.tsx`.
Native execution, browser presentation, broader end-to-end/growth and root acceptance remain controller checks after
integration as specified by the owner brief.
