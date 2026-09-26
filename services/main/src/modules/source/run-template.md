# Source acquisition run template

The general acquisition owner is the template for bounded external source
surfaces (LIVE01/02/09/11/12). Copy it for a new provider or surface.

| Concern | Files |
| --- | --- |
| Owner schema | `services/content/migrations/040`–`045` (runs, feeds, field catalog, seed) |
| Fixed-origin fetch and failure classes | `open-library.ts` (`fetchOpenLibraryJson`) |
| Run store: frozen captures, settlement, completion | `acquisition-run.ts` |
| Field drift against a sealed catalog | `acquisition-drift.ts` |
| Dump/bootstrap baseline and change windows | `acquisition-feed.ts` |
| Composition | `acquisition.ts`, `services/main/src/routes/source-runs.ts` |
| Tests | `tests/qa/integration/source-run-{acquisition,feed,schema}.test.ts`, `source-run-harness.ts`, `tests/qa/unit/source-run-window.test.ts`, `tests/live/source-run-open-library.test.ts` |

## Extending

1. Add the provider's fixed-origin fetch that returns classified failures:
   access limits are `unqualified`; network, status, shape, size, redirect and
   identity problems are `failed`. Never return bytes for a failure.
2. Declare the surfaces (`SurfacePlan`) with required/optional and a capture
   limit, and one `CaptureRequest` per provider request with a stable
   `requestKey`, record identity, coverage scope and validator.
3. Register a sealed field catalog in a new migration (as `045`). Unknown fields
   stay explicit `unsupported`/`undeclared-field`; statistics and provider
   accounts are never native.
4. Reuse `SourceRunStore.start/exclusive/acquire/settle/complete`. Do not write
   `source.observation` outside `acquire`, and do not add another receipt.
5. Tests follow `source-run-harness.ts`: a controlled origin that can change
   mid-run, a gate that can interrupt, and assertions on replay, resume,
   denial, stale intent and derived completion.

## Cost contract

- A run makes at most the sum of its surface capture limits in provider calls
  (Open Library works run: 8 Works, 8 edition pages of 25 per Work, one frontier;
  at most 81), each through the shared one-per-second provider gate and at most
  64 KiB. Replay, resume and every read make no provider call.
- Each capture is one transaction with a fixed number of indexed inserts. Run
  settlement locks one surface row and reads that surface's capture set; the
  completion reads at most 32 surface rows.
- `GET /v1/sources/runs/{run}` is a primary-key run lookup plus captures by the
  `(run_id, surface, ordinal)` index; it returns no bytes.
- Drift reads the two runs' frozen captures (at most 81 × 64 KiB each), verifies
  their digests and compares in O(B + I·F) for bytes B, items I and at most 256
  fields per grain. It never reads other runs or fetches.
- A feed window holds at most 8 pages of at most 100 entries (≤ 512 KiB), commits
  its checkpoints in one transaction on the head row lock and never scans feed
  history; feed reads return the head, at most 64 open gaps and 20 checkpoints.
- The owner-growth plans are asserted in `source-run-schema.test.ts` at 256 and
  2048 runs/checkpoints.
