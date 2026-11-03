# Rating-question directory growth binding

## Operation binding

- Owner contract: [rating HTTP and Operation Cost](../../services/kernel/src/rating/README.md).
- Source base reviewed: `2702fd3050540c8a75cc0dbbeb38f598babba679`.
- Measurement command: `bun run --cwd services/kernel check test/rating/growth-question-directory.test.ts`.
- Fixture: `test/rating/support/growth-question-directory-fixture.ts` mounts the real kernel HTTP route with the production Access factory and the shared native growth database observer.
- Decision: retained-history growth uses closed Global `definitions:read` denial intervals for the measured reader; the current denial row is seeded separately.

The test fixes the selected question neighbourhood and limit 20, then grows one axis at a time: unrelated catalogue rows or closed history for the exact Global authority key. Each axis uses 64, 512 and 4,096 seeded rows. The first-page case omits `limit` to exercise default 20. Deep-page setup mints a reader cursor across two pages, changes the next question's current metadata, then measures its continuation. The terminal-empty cursor is minted while a lookahead exists, then the lookahead is deleted. The denied case mints a cursor before current authority is denied.

`checkGrowth` captures the real HTTP selection and response completion. Its two measured repetitions replay the same request and signed position. It classifies all Access and question statements, native rows, buffers, statement counts and recorded SQL failures. Successful pages assert UUID-ascending metadata, 20 returned entries and at most 21 native question rows. Denial asserts `404` and no `rating.question` relation in the captured operation. Cursor setup also checks viewer, anonymous and alternate-credential mismatches.

## Execution record

| Path | Unrelated catalogue axis | Closed authority-history axis |
| --- | --- | --- |
| First page | 64 / 512 / 4,096: not measured | 64 / 512 / 4,096: not measured |
| Deep continuation with current metadata | 64 / 512 / 4,096: not measured | 64 / 512 / 4,096: not measured |
| Terminal empty continuation | 64 / 512 / 4,096: not measured | 64 / 512 / 4,096: not measured |
| Current-authority denial | 64 / 512 / 4,096: not measured | 64 / 512 / 4,096: not measured |

The controller launch defers native and acceptance execution. No native assertions were reached and no three-scale observations are claimed. The command above is authored but was not run on this source; the reviewed base is recorded for provenance. Type checking and authored test code are not native growth evidence. No product implementation, schema, second metadata reader or feed-source activation is included.
