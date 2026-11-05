# Board report candidate queue growth

This operation binding covers the board-selected report queue and its native cost contract in [Content](../../services/kernel/src/content/README.md) and [the Content goal](../goals/content.md). It exercises the public report and board APIs with the registered `content_report_target` effect; candidate rows are references and do not supply disclosure authority.

## Bound operation

The private fixture creates a foreign board and report, then six reports on one fixed board neighbourhood: two each for board, thread, and post targets. It records each committed `report.created` envelope with the native event reader, applies it through the registered Content runtime, and verifies the resulting candidate placement. A native dismissal command gives one post report a current resolved outcome. The selected board, neighbourhood, page limit (2), and registered runner remain fixed for every measurement.

The acceptance test reads first and deep pages, checks newest ordering and evidence disclosure, intersects status with target kind, and walks a resolved-thread selection through sparse continuation to terminal empty. It also checks cursor rejection when selection, order, route, or credential scope changes. Separate measured requests cover first, deep, resolved-post, sparse, terminal-empty, initial-authority-denied, and final-authority-lost paths. Empty and concealed responses are checked for report IDs and evidence.

The unrelated-candidate and retained-report/command-history axes run independently at 32, 256, and 2048 seeded rows. Candidate pressure alternates same-route and other-route references. History pressure adds unrelated report, receipt, and command history on same and other report routes. Each check keeps the selected neighbourhood and page size unchanged. Only those unrelated pressure rows are seeded directly; selected reports, authority changes, dismissal, queue reads, event reads, registered effects, and replay use native APIs or the registered runtime.

For each measured queue operation, the shared growth observer captures native rows, shared buffer hits and reads, and statement count. The private query trace separately counts raw candidate references, current `content.report` source rows, and whether the final authority revocation occurred inside selection. Assertions require at most `limit + 1` candidate references and at most `limit` current report-source rows, including empty and denied branches. The test emits each three-scale observation as JSON and checks constant rows/statements and logarithmic buffer growth. Registered projection and replay captures separately record rows, buffers, and statements; replay must leave exactly one candidate placement.

Decision: the final-authority-loss branch revokes the moderator's board grant through the native grant command immediately after candidate selection, so the production final check must conceal hydrated report data; this grant mutation uses the uninstrumented setup connection and stays outside queue cost capture.

Run the focused acceptance with `bun run --cwd services/kernel check test/content/growth-report-candidate-queues.test.ts`. The controller defers integrated acceptance and native/browser checks; results from source inspection, type-checking, or queued checks are not integrated acceptance passes.
