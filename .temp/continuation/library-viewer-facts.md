---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
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
waiting: []
estimate:
  lines: 20
  files: 2
---

# Generate the typed Library viewer facts client

## Acceptance

After Library schema repair `1322e3d50121a45cf7faf74d6eaf67c1050f5354` reaches this source through normal integration and supported Kernel database placement is available, run `bun run --cwd services/kernel client` and commit the generated declarations exposing Library and readable Collection `viewerFacts`. Use only the existing supported compiler/database placement; do not add a tooling workaround. Confirm producer currentness and bounded page declarations where installed. Run `bun run --cwd packages/client typecheck`, distinguishing unchanged base failures. Run the focused declaration regression with `bun test packages/client/tests/library-viewer-facts.test.ts` from the worktree root.

## Remaining outcome in user terms

Library and readable Collection consumers still need their generated viewer-facts client declarations. The declaration regression already checks both response types, optional current facts, row states, producer currentness failures and the row bound; it currently detects the missing output. Direct generation on the retained base reports `error reylo4: No database URL`. The supported `bun run --cwd services/kernel typecheck --emit-client` prepares its compiler database but exits before generation on existing Kernel diagnostics. Resume generation when the schema repair is normally integrated and those dependencies permit it. Preserve the existing three client baseline diagnostics: the missing `./kernel/rating/own-votes-counted` export and the unused expect-error and false/true mismatch in `tests/post-history-contract.test.ts`.

The Library schema repair is not yet an ancestor of this retained base. The schema owner reports two supported derivations, the second unchanged. Comparison/native acceptance remain deferred and directory outcomes zero. Kernel typecheck still reports pre-existing missing own-votes-counted output and other unchanged-source errors. Do not hand-edit schema or declarations; keep admission unavailable until actual declarations and their producer contracts agree. Preserve the original gates and unavailable admission until actual delivery.
