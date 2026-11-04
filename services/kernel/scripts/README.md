# Kernel scripts

`typecheck`, `check`, `derived` and `search` share one compiler database lifetime on an admitted check host.

## Typecheck phases

`bun run --cwd services/kernel typecheck` places through the [compiler placement contract](../../../docs/development/compiler-check-placement.md). Slot wait and rsync stay on the transport receipt. After admission the command appends paired markers to `REZICS_CHECK_PHASES`:

| Phase            | Work                                                     |
| ---------------- | -------------------------------------------------------- |
| `database-image` | Postgres image and one throwaway container               |
| `migrations`     | Schema migrations on that container                      |
| `compiler`       | Optional client emit, `tsc`, construct, optional OpenAPI |
| `sql-schema`     | Optional `--emit-schema=` dump from the same database    |
| `cleanup`        | Remove the one-run container and its volume              |

Client emit stays before the workspace compiler so tests see source-checked declarations. Client emit, `tsc` and construct share the same migrated database; they do not start a second compiler database. `--emit-client` still runs a declaration compiler and then `tsc --noEmit`; that is the accepted client-publication order, not duplicate preparation.

The one-run compiler database uses a labelled anonymous volume inside the run slice, matching kernel check storage. It does not use a 1 GiB tmpfs and does not bind-mount the checkout. Persistent derived reuse for local schema/contract generation keeps its existing tmpfs cache.

When `REZICS_CHECK_PHASES` is set, stderr also records source HEAD, argv, concurrency, and slice `anon` / `file` / `inactive_file` plus `io.pressure` averages when those cgroup files are readable. Missing counters stay omitted. Compare like command/source classes using those command phases and the transport `slotWaitSeconds` / rsync lines separately. Do not treat wrapper wall time as compiler duration.

Decision: after cache-aware admission (`3afee00d49`, formatted as `b1841e43808feae3d6f1c1f8617bc8ffdde2512f`), the 10–25 minute host-b symptom is slice file-cache pressure, not extra Kernel compiler or schema preparation. Command phases exist so a later receipt can show that without timing assertions.

### Cost: Kernel typecheck phases

- Touches: one phase-file append per start/end, one optional cgroup `memory.stat` and `io.pressure` read, one `git rev-parse`.
- Bound: constant in the number of Kernel phases (at most five paired markers).
- Growth check: `test/scripts/command-phases.test.ts` pins pairing, observation keys, one-run volume/slice args and a single throwaway database for compiler work.
