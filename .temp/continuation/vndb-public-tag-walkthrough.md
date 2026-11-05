goal: imports
manager: imports

# Pending VNDB public-tag walkthrough

The component implementation and local publication scenario are complete. The local scenario proves exact work/path/tag citation, current Concept and Scheme rereads, refusal and reopen, source association refresh, proposal ACK replay, adoption, and anonymous current work reads.

The actual reviewed default run and served-page walkthrough remain pending for integration. Run `runCrossMediaSeedCli` against the pinned archive and actual reviewed catalogue receipts; return each admitted `(work key, source path, source tag code, current Concept UUID)` and its current public work outcome. The reviewed source codes include `g105` and `g249`; do not infer their work or Subject IDs from this test fixture. The previous archive fetch returned HTTP 404, so no real default mapping or native outcome is claimed here.

After integration, run the registered native file through the controller policy: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/vndb-public-tags.test.ts`. Complete the anonymous current work-read and VN/anime/book served-page walkthrough with the seed owner. No check ID was started in this attempt.
