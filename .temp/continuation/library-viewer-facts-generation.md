---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
  - packages/client/src/kernel/http/kernel.d.ts
  - packages/client/tests/library-viewer-facts.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 360f7b9b-415b-4952-9625-c349ed050b0f
  - 8e9f5e61-0b92-48fa-aac2-cc370bcaf7e6
  - a4e55488-394a-40c7-b652-808ff70b85ac
  - 89c73430-a3ba-477f-93f8-ac871af8583d
waiting: []
estimate:
  lines: 20
  files: 3
---

# Generate the typed Library viewer facts client

## Acceptance

Generate and commit Library and readable Collection viewer-facts declarations through the existing supported
compiler/database placement. The documented entrypoint is `bun run --cwd services/kernel typecheck --emit-client`;
it runs the official client generator after compiler and construction succeed. Do not bypass its admission or
compiler failures, hand-edit declarations, or introduce a tooling workaround. Retain the existing Library schema
repair and subsequent schema changes.

Confirm both response types expose optional current viewer facts, row states, producer currentness failures and
the 100-row bound. Run `bun run --cwd packages/client typecheck` and
`bun test packages/client/tests/library-viewer-facts.test.ts` from the worktree root under the landing policy.
Preserve existing assertions, including the post-history unused expect-error and false/true mismatch; do not
remove the missing own-votes-counted export to silence its baseline diagnostic. The current retained source also
has missing content/schemas and community home declarations; regenerated outputs must agree with their producers.

## Remaining outcome in user terms

Library and readable Collection consumers still need generated viewer-facts declarations. Keep admission
unavailable until those declarations and producer contracts agree. The existing declaration regression now
explicitly pins optional Library facts as well as optional Collection facts; its other assertions remain intact.

The supported compiler placement reaches host b but its full Kernel compiler fails before invoking the generator.
Its compiler inputs are unchanged by this attempt. Existing diagnostics span multiple owners, including nullable
community results, mismatched route responses and search contract fixtures. Resolve those through their owning
contracts before repeating supported generation. No generated declarations were published, and the three actual
client workspace diagnostics concern missing content/schemas, missing rating/own-votes-counted and community home.
These failures leave the declaration outcome unverified; deferred broader acceptance is not a passing result.
