# Terminal account erasure native graph continuation

Goal: accounts  
Manager: accounts

## Committed foundation

The capability manifest records the decision to preserve all eight existing outcome scenarios, use fixture-only retention inputs, and provision Collection rules through the current `source.kind` wire shape. The inbox carries the same decision.

The kernel test support now has an isolated native fixture constructor and a child that starts the complete default worker composition. Its test barrier is a database-backed gate around each registered DBOS step body: the worker uses its real scheduler, and hold waits until already-running step bodies finish. The fixture owns and closes its kernel clone, Auth fixture, work client, worker, and independent read-only inspection pool. It also provides actual native persona credentials, HTTP command helpers, and exact handle reads.

## Owner seams needed before the complete driver can be bound

1. **Access:** deliver bounded paging for minimization of actual Zone resource grants. Input is the terminal account identity and barrier plus a cursor; output identifies the exact selected page, next cursor, and durable completion or pending disposition after physical grant minimization. Do not infer completion from an empty page or ACK.
2. **History:** deliver a Zone receiving consumer for each exact receipt, outbox, and durable-work locator, using captured primary-owner custody and the original receiving hold. Output is a persisted complete/pending disposition with physical copy closure; preserve protected originals, reversal locators, and unrelated owners.
3. **Semantic:** replace account-erasure's direct Zone update with the sole Zone CAS writer. Input is the terminal account/barrier, exact Zone identity, and bounded cursor; output proves the committed CAS page and completion/pending state. Keep the existing terminal fence and captured custody.
4. **Commerce:** deliver an explicit deterministic fixture configuration seam for the real retention obligation: actual retained fields, purpose, access restriction, and deadline. The fixture supplies test values only; production retention policy and money guards remain owner-controlled.
5. **Auth:** align the native deletion HTTP boundary with the frozen suite's typed-confirmation input. The suite passes the registered handle and expects missing or incorrect text to be refused before deletion. The current account-operation transport has no confirmation field and the page only checks its static phrase locally; Accounts must not translate confirmation policy in the driver.

These operations were sent to the respective owner inboxes with their exact expected disposition. Compose only callable delivered exports when they arrive.

## Remaining Accounts work

Create `services/kernel/test/access/terminal-erasure-outcomes.test.ts` with the established native-wrapper pattern, import the unchanged `specs/terminal-erasure-outcomes.test.ts`, and implement its complete `TerminalErasureDriver` in `services/kernel/test/access/terminal-erasure-outcomes-driver.ts`. Use the committed fixture and worker helpers. Provision every kind and distinct role through its owning native command; seed the public/pending Collection generations, published log, history, imports, copies, financial order, Bob controls, and late effects. Keep all eight scenario assertions and inspect complete exact-locator persisted rows over read-only native connections. Do not create fixture routes or write erasure outcomes directly.

After owner exports are available, repair only Accounts-owned composition defects, update the Access README only for a real adopted composition repair, replace the manifest's missing-binding references with the delivered wrapper and exact command, then run the focused suite once and typecheck each changed workspace. The broader acceptance remains owned by the controller.

## Checks from this attempt

`bun run --cwd services/kernel typecheck` reached the compiler and exited 2 on existing diagnostics in unchanged Content, Search, Semantic, and growth-test files. The focused `bun run --cwd services/kernel check test/access/support/terminal-erasure-fixture.ts test/access/support/terminal-erasure-worker.ts test/access/support/terminal-erasure-worker-process.ts` exited 1 before TypeScript compilation because the base's generated `db/semantic/schema.sql` differs from its checked-in snapshot. The frozen eight-scenario native suite is not yet bound and was not run.
