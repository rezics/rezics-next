# Native review restoration growth binding

## Measurement choice

Measure the production `restorePost` command with the native system's production `Access` on the shared growth-observed
pool. Use the registered native HTTP runtime to create the selected review, delete its opening, create and delete a
replacement in the same author/subject/board slot, verify disclosure, and replay the measured idempotency key. The
selected command result is real; only unrelated fixture pressure is seeded directly.

Decision: grow unrelated review and vote rows under the same author and board across fresh subjects, and grow retained
revision and command history on a separate review and subject. Keep the selected review, author, subject and board fixed.

## Operation and assertions

The private fixture is `services/kernel/test/content/support/growth-review-restore-success-fixture.ts`; it builds on
the read-only `review-native-lifecycle-fixture.ts` and its registered native composition. The measured operation uses
the shared `test/support/growth.ts` observer and access-path classifier. Its selected restore calls use the original
post ID, `restorePost`, native `Access`, and the fixture's route key. Setup and disclosure results use real HTTP.

Two independent series seed 256, 1024 and 4096 rows. The population series adds one unrelated review, revision and vote
per row. The history series revises one unrelated native review through `revisePost`, retaining each revision, command
receipt and outbox event. Both keep the selected review neighborhood and the operation limits fixed. The owning Cost
contract in `services/kernel/src/content/README.md` requires constant rows and statements per restore command and
logarithmic blocks; the check uses those bounds.

The focused test asserts the slot is free before restore; deleted content is not disclosed; the original review,
revision, CC-BY-4.0 SPDX licence, vote citation, author, subject and board own the restored slot; and same-key replay
adds no receipt, outbox event, vote, revision or slot. Each report retains rows, shared-buffer hits/reads, statements,
plans and classified relations at all three scales.

## Execution record

Acceptance command: `bun run --cwd services/kernel check test/content/growth-review-restore-success.test.ts`.
The current worker launch defers native acceptance to the controller after integration, so no measured revision or
numeric scale observations are claimed here. The focused test records those observations when the controller reaches
its assertions.
