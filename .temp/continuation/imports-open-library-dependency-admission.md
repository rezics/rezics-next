# Open Library dependency admission after retryable bootstrap failure

Goal: imports
Manager: semantic

## Receiving status

The complete integrated scheduler repair through f869641 is received. Its width-one dependency, exact replay and cancellation tests pass in the owning importer check. This draft is consumed; do not dispatch another scheduler repair. Native Work/Edition acceptance remains part of the retained integrated receiving command after the existing producer and supported-host repairs.

## Custody and scope

This is a separable Importer scheduler repair for controller harvest. Semantic owns the existing readiness/proposal failure; Content owns sourceFences. Neither changes the dependency slot accounting described here. The current walk remains the only native/browser caller. Preserve Tags' same-handle continuation and Semantic's concurrent Sources erasure ownership. No duplicate Semantic repair is requested.

Expected files: services/importer/src/importer.ts, services/importer/tests/own-reference-refresh.test.ts and the existing overload/concurrency tests. Use the public Importer and ordinary transport contracts. Do not add a replacement driver, fixed per-provider deadline, broad refactor or provider special-case workaround.

## Observed native input and result

Retained command: `bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts`.
Revision: `3308cd5a887f021b586562315d407de37aca6c9b`.
Admitted host: c; run `mw6czi9j-01ba53a5`; settled exit 124.
Full check log: `.temp/check-logs/77f077ea-b0f9-4813-900b-cf6570dbcddd.log`.
Controller receipt: 2026-11-07T14:08:48.335Z. Remote active-row timestamp: 2026-11-07T12:16:06.500Z. These clocks differ; row elapsed time is unknown. The original run lifetime ended at 7,204,023ms with `remote-check: infrastructure failure: remote run timed out`.

Returned `.temp/imports-walk/i03/requests.jsonl` contains twelve `POST /v1/subjects:batchWrite` responses, all retryable HTTP 503 `semantic_not_ready`. The final response is at 2026-11-07T12:16:18.986Z with public request ID `01a1b5f0-2e14-7386-9087-06b576c7f023`. No subsequent request or terminal CLI result was retained. Auth sign-in/token and source-fence checks returned HTTP 200 before bootstrap. Do not misclassify this as HTTP 403 or a sourceFences denial.

`records.jsonl` has active staged `/books/OL2M` and `/works/OL1W`, neither completed. `progress.jsonl` ends in reconciling, two staged records, zero acknowledgements. The Edition refers to the same-run Work.

Readonly journal inspection of `i03/state.sqlite` (retain its returned WAL/SHM alongside it) establishes:

- run_generations: source openlibrary, id 1, status ready, supplied 2, resolved 0, prepared 0.
- run_entries: both native keys unresolved, kind null, pending/remaining 0.
- binding_journal: only `/works/OL1W`, acknowledgement null.
- exact bootstrap key: `openlibrary:/works/OL1W:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`.
- exact source tuple: source openlibrary, external_id /works/OL1W, record_revision 7, converter_revision open-library@5, digest 22ce7b206f4ec1fd4d468021a7c30de19cacf031334d5f97daaea7dbb8f73947, field_group facts.
- command create, type schema:Book, label und `Lantern 🌙`; no run_commands or acknowledged native identity.

## Causal repair contract

Source inspection of Importer.concurrent, planOnce and bindOwnDependencies gives a concrete hypothesis: Edition occupies an active record slot while awaiting the Work's inflight plan. Work's failed write is paused into the retry queue. With default width 16, four write invocations (three HTTP transport attempts each) narrow the shared width through 8, 4, 2, 1. The dependency waiter still counts active=1, so pump cannot resume the paused Work. The waiter cannot finish until Work runs. The twelve retained responses and lack of further HTTP agree with this ordering; no CPU profile was retained, so do not claim a measured stack trace.

Fix admission/ownership of dependency waiters and actual writes so a paused dependency can resume under width one without repeating earlier planning, metadata, bootstrap or media effects. Preserve maximum write invocation count, server retry deadlines, cancellation, exact bytes/key and existing durable ACK rules. On exhausted readiness failures, the CLI must return its original safe nonzero outcome promptly without acknowledging an effect, then reopen/resume the same sealed intent successfully when ordinary service recovers. Cancellation must settle and close owned SQLite handles.

## Minimal verification and acceptance

Use the existing two-record Work/Edition fixture through the public Importer, default concurrency and an ordinary injected transport. Make the Work create return retryable 503 enough times to shrink the width to one while Edition awaits it; observe both the original nonzero terminal outcome and later successful sealed replay. Include the earlier wide-cohort and cancellation cases, without a test that merely asserts a new timer. Assert exact bytes/key on every retry, zero acknowledgement before success, no duplicate native identity, and independently current Work/Edition relation/provenance after separate acceptance/adoption.

Run the changed Importer test files once through worker-check using the landing's bun test command and run Importer typing. After integration, receive through the same retained native twelve-row command; preserve all current authority, rights, exact tuple/id/type, publisher/volume, reopening and phone/desktop assertions. A pure fixture or source landing does not establish a native/browser pass. Report passing/12, slowest measured failure and any unknown duration separately.
