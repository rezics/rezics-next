# Collection editor operation plans

Goal: performance  
Manager: performance

## Delivered in the preceding attempt

`collection-history-bounds.ts` declares immutable nine-axis SQL plans for metadata history initialization, owner
reconciliation, transition append, retained-entry pruning, coverage update, state, first/next page and exact detail.
`collection-metadata-history.ts` executes those bound operands at the existing journal DAO. The plan prices both
metadata snapshots with escaped schema maxima, retains the 128-entry set for filtered page scans, and includes the
51-row page sentinel. The existing private editor and history behavior remain the owner contract.

## Remaining work

Complete the operation plans and bindings across the current Collection owner path:

- Private reopen: first capture, native read times, current account/Collection/stored expanded rule, each distinct
  private-family group admission including negative/nonmatching leaves, terminal capture, currentness comparison,
  and the private HTTP result. Preserve current owner, authentication floor, fence, operator, partition epoch/node,
  collection-update capability, private scopes, current partition, `sort=id`, release digest and source generation.
- Create/edit/no-change/replay: current semantic compiler/admission, parent lock and CAS, exact rule revision/digest,
  source-generation invalidation, metadata transition when applicable, original receipt/event/result, retry,
  rollback and transaction controls. Authorization must precede replay. Rule-only changes remain outside metadata
  history; no-op/replay adds no transition.
- History page/detail HTTP: current owner access and lifetime, collection capture, state/page/detail SQL, cursor and
  response serialization, current media readability for no more than two historical covers, released Library
  connection during foreign media observation, and final owner/revision/cursor-basis check.
- Bind one immutable plan to each actual native producer and compose nested metadata work once. Do not add a second
  history model, route, schema, index, producer limit, mutable catalogue or funding protocol. Keep current HTTP
  privacy, owner custody, replay input, deadline and command/transaction ownership.
- Rewrite the Library owner explanation to describe complete edit/reopen/review composition and add a small number
  of causal assertions to the existing native HTTP/growth/currentness suites. Run the required focused landing tests
  and workspace typecheck after committing each fix; controller-owned native and root verification remain deferred.

## Contract sources to follow

Use the Collection editor/history sections in `services/kernel/src/library/README.md`, the Collection operation
costs in `services/kernel/src/library/performance-contract.md`, `services/kernel/performance-contract.md#finite-bounds`,
and the existing native lifetime/privacy/growth suites named in the performance brief. Preserve the brief's
owner boundaries: Commerce owns Library semantics and SQL, Accounts owns admission and public views, Semantic owns
summaries/filter meaning, Content owns media readability, and Search owns Source contracts.
