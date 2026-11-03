# Appeal queue boundary growth

## Cost binding

The [Content Appeals Cost contract](../../services/kernel/src/content/README.md#appeals) bounds a pending list at no
more than `L + 1` queue candidates and `L` independently authorized source reads, with `L <= 100`. Rows and
statements therefore stay constant as unrelated histories grow when the measured page limit is fixed at `L = 2`.
The acceptance retains the existing appeal growth series' logarithmic shared-block bound and constant row and
statement bounds.

## Operation binding

`services/kernel/test/content/growth-appeal-boundaries.test.ts` uses a production native Content system, its Access
factory, real Kernel HTTP requests, the shared `checkGrowth` observer/classifier and registered `registerContent`
effects. It creates six selected pending appeals from native report, takedown and author-appeal commands. The
reporter reads the actioned report receipt; the author submits and replays each appeal with the same key. A separately
registered moderator reads the queue across author-created boards using explicit moderation grants, without board
membership.

The five list operations are measured separately: the first page, a second page using a cursor returned by the real
first page, a terminal empty page using a real cursor after the queue is resolved, a denied author request, and a
page after the moderator loses current target authority. The selected active queue is fixed at six rows for the
first, deep, denied and authority-loss paths; the terminal queue is fixed at zero after four native appeals are
resolved. Page limit stays at two. The authority-loss control confirms the selected appeal before revocation and
checks that its decision projection is absent afterward.

Each path runs two independent growth series at scales 64, 256 and 1024. `unrelated-pending` adds unrelated decision,
appeal and pending-board-index rows on a separate board. `retained-history` adds decision and resolved-appeal rows
with `pending = false` on that board. The fixture seeds only those unrelated rows outside the observation. Each
measured operation is a real HTTP selection captured by `checkGrowth`; the registered runner completes the source
report, takedown, appeal and resolution events before the corresponding queue state is selected. Setup, queue
selection, registered completion and same-key appeal replay are kept distinct.

## Assertions and execution record

The acceptance asserts reporter receipt access, author appeal and replay, moderator first/deep page identity,
terminal emptiness, denied `404`, and suppression after current target authority is removed. `checkGrowth` records
native rows, shared blocks, statements and failed-statement counts for each path and each independent axis; the test
prints each three-scale report.

Acceptance command: `bun run --cwd services/kernel check test/content/growth-appeal-boundaries.test.ts`.
This controller run defers that acceptance to integration. No three-scale observation is claimed here; the report
output from the exact integrated revision is the measured record. The frozen
`services/kernel/test/content/appeals-http.test.ts` remains unchanged.
