# Anonymous report rejected and replay admission growth

This operation binding covers [Content Done-when 5](../goals/content.md#done-when) and the
[report HTTP admission Cost](../../services/kernel/src/content/README.md#cost).
It extends the missing rejected/replay measurements beside the unchanged successful submission series in
`reports-http.test.ts`; it makes no live provider configuration or promotion claim.

Decision: measure each admission branch against report, receipt and grant history independently, with one fixed
selected board and completed anonymous report; unrelated fixture rows never supply a selected workflow result.

## Anonymous POST admission, rejection and replay

- **Touches:** `POST /v1/reports` runs the native shared write/report rate admission and the production Access
  factory. The production Turnstile adapter calls deterministic Siteverify transport: missing proof makes zero
  provider calls, invalid proof is rejected, transport 503 is unavailable, and accepted opaque tokens are one-use.
  Missing/invalid proof includes current target disclosure. Provider unavailability exits before target disclosure.
  Safe replay and changed-reason conflict include current target eligibility, Access and the report-home receipt
  lookup. Revoked public eligibility returns concealed 404 before receipt/report retrieval. Every measured run
  also invokes the production registered effects relay on the command home and asserts an empty source batch.
- **Bound:** for fixed board ancestry, submitted bytes and empty relay batch, constant examined rows and
  statements; logarithmic shared buffers in unrelated indexed report, receipt and grant histories. This follows
  the owning admission/storage Cost and the shared command envelope, without planner, TTL, budget or classifier
  overrides. Rejected paths require no report command result. Replay retains one report, receipt, created event
  and registered target projection. Conflict and revoked replay disclose neither report identity nor evidence.
- **Growth check:** `test/content/growth-anonymous-report-admission-boundaries.test.ts` uses the shared native
  `checkGrowth` capture and series classifier for all six branches, independently on each of three axes, at
  32/256/2048 rows, three measured repetitions and one warmup per scale. Every repetition requires physical rows,
  buffers, statements and plans; access-path assertions retain the shared scan classification. Failed native
  statements remain in the inclusive capture. Reports and receipts share each selected command's home range;
  grants share the target resource but name unrelated accounts. Only the named population changes per series;
  private noise is removed before the next series. Fixed default native limits use distinct trusted transport
  peers, following the existing HTTP fixture semantics; no forwarded client identity is trusted.

Setup seeds one published board using the existing migrated HTTP fixture semantics. Selection then submits the
first report through real HTTP with an uppercase UUIDv4 key. Completion dispatches its committed outbox event
through `relayEffects` and waits for the exact `content_report_target` registered DBOS workflow. The command,
registered module, runner and relay all use the growth database's instrumented pool. This setup/completion is
outside the replay capture; no direct effect call or SQL result substitutes for it. The lowercase key selects
the same home on replay. Fresh proofs have fixed byte length and are excluded from semantics and retained rows.

Population seeding, revocation setup, administrative snapshots and cleanup are outside observation. The captured
operation includes HTTP completion, current eligibility/Access, native receipt/conflict work and empty registered
relay work. Selected-row snapshots and total report/receipt/event/projection counts check non-mutation, including
partial or unexpected receipts; all issued proofs and rejected token strings must be absent from retained data.
Revocation changes only the selected board's native visibility/security revision before the series and restores
it afterward. No additional target, page size, batch size or retained selected report is introduced at higher scales.

## Execution limits

The clean starting source is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. Inspection confirmed the successful
three-scale HTTP series and functional rejected/replay scenarios described in the brief; those files remain
unchanged. The new fixture is private to this suite. No product or shared runtime contract changes are included.

Permitted verification commands, from the worktree root:

```sh
bun run --cwd services/kernel typecheck
bun run --cwd services/kernel check test/content/growth-anonymous-report-admission-boundaries.test.ts
```

Native execution remains subject to controller launch deferral and admission. Authored scales and assertions are
not observed passes: only an executed runner's per-series JSON contains three-scale observations, reached
assertions and physical costs. No live provider, browser, root/full-workspace acceptance or promotion is claimed.

Sources inspected: the Goal's Done-when/Acceptance; the owning Content admission/storage Cost; the existing
`reports-http`, `report-anonymous-proof-http`, `growth-report-effect` and native reaction registration fixtures;
the shared growth capture/classifier/access-path interfaces; native report, Siteverify, command-home, shared
write-rate, content registration and effects relay boundaries; and the relevant report/receipt/grant seed shapes.
