# Review destination receiver

Goal: content. Manager: content. Continue with the same receiver owner.

Authority: [Review destinations](../../services/kernel/src/content/README.md#review-destinations).
Work in `apps/web/src/threads/review-board-choices.ts` and
`apps/web/tests/review-destination-journey.test.tsx`; leave shared context and composer lifetimes with their owners.

At base `d4d47cbfdeffe0eb8a79ef5fe3abedd52720857a`, the official public root is
`packages/client/src/index.ts` (`@rezics/client`). Its installed
`packages/client/src/kernel/content/routes.d.ts` has no review-destinations declaration. The mounted producer is
`GET /v1/realms/:realmId/review-destinations` in `services/kernel/src/content/routes.ts`, using
`ReviewDestinationPageSchema` from `schemas.ts`. The production receiver and existing journey assertions are retained.

Obtain the complete-input publisher's installed export, head and callable before changing the receiver. Publication
is independent of this consumer; do not edit generated paths or create another declaration, endpoint or generator.
Then remove the local route mirror, wire DTO and unknown assertion escape. Call the public method directly and derive
response and preparation types from its result. Preserve boundary validation, complete native states, Subject source,
Realm head and Board security binding. Preserve the existing supplying action's private transport and cancellation.

Add focused typing and boundary cases needed by that migration without weakening existing assertions. Retain explicit
Board inspection, sparse continuation, exact-cursor retry, denial/expiry and permanent visit retirement, including equal
replacement and A-B-A. No selected label or installed type admits creation.

Commit before checks. Run Web workspace typing and the focused landing command:
`bun apps/web/scripts/focused.ts --private-network -- bun test tests/review-destination-journey.test.tsx`.
Native execution, browser presentation, broader end-to-end/growth and root acceptance remain controller checks after
integration. Read only the linked contract and relevant mounted/public declarations; no history reconstruction.
