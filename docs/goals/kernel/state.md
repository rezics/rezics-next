# State

Checkpoint: 2026-10-07 13:50 UTC. Manager `goal-kernel-codex`, tmux `goal-kernel`.
Live truth: `task goal -- status`; inbox `.temp/goal-orchestration/messages/kernel.md`.
Goal remains active. Completion cannot be projected reliably until the physical
locality and exact restore/Claim qualifications pass.

## Shared stack

The storage upgrade and singleton redesign are landed and serving. Content1521
uses immutable source streams and a saved PostgreSQL snapshot; no site-wide
singleton correctness head. C4 repair67883e853690, redesign8c6793a04dbb and
classification restore1dbd4a099fe2 are applied.

Latest completed refresh: b7c8d34c0b59f7091eddd6be2c59057cb05562e7,
native0.5.39-d57155aafd87, modelab6d394, no pending SQL. All six application
resources were healthy. Main/Account use fixed3011/3012 behind3001/3002.
It includes ordered membership88ce032c80a2, exact Zone delivery107f23261259,
Trust public catalogue6ee3f226f, Realm policy receiptsf6383bc94 and notification
paging84a06c164. Membership preparation completed before the final checkpoint.
The old native operation inspection failure is fixed by d04038cac: prepare changed
storage before inspecting membership through the candidate native module; retain
interactive budgets. Program owns queued refresh re-execution from staged code.

Latest Realm refresh completed13:49: fe7fb82d49222eab3ec88148a0541fa32ef835ec,
native0.5.39-eeaa550c0acc, no pending SQL, unchanged modelab6d394. Log
`.temp/kernel/refresh-realm-owner-pool.log` ends Shared stack refresh complete.
Canonical Realm ownera299f1f16255 and admission112b05137e45 are now activated.
Main code hold released; no kernel lifecycle waiter. Preserve retained volumes.
Cold populated600sec startup/restore remains unqualified; a successful shared
small-stack prepare is insufficient.

## Accepted contracts and evidence

C0 current basis e75dda7b4; C2 Post slice and131/133 authored Turtle profiles;
C3 local Work/Context/relay first path; C4 catalogue Statement operation and
storage redesign; C5 four reviewed native templates35c3fe3c5 and fair local seek
Access1761–1764; C6 owner custody before slim6-quad proof3348b4ad6 with
Access1765/1766 and Content1522. These are slices, not full contract closure.
Trust erasure campaign192d5e825979 is applied.

Legacy model custody G1296 d9bb1413 is verified/closed:15 exact committed builds,
1976 artifacts,31 turns,9010ms; independent reader15 generations/1961 shapes,
2536ms. Evidence `.temp/kernel/model-custody-shared-result.json`,
`retained-model-reader-result.json` and `exact-model-source-evidence.json`.
Public-name backfill completed3458 identities; evidence
`.temp/kernel/public-name-backfill-shared-1153.log`.

Membership88ce passed159 affected unit/guards,24 native and39 preservation
cases;3501 placements/6902 seek tuples and137 high-degree metadata reads.
Finite maintenance signal spans seek-only/fixture preparation; ordinary request
10sec, call and byte budgets stay enforced. Zone107f passed154 gate cases and
actual final-disclosure race20261007t125122-f00a73; G1358 closed.

Realm ownera299f passed161 gate cases, actual HTTP20261007t131817-b5b01a,
manager80 membership/name/delta native cases and independent review. Alternate
current or immutable selection owners are refused; body/name share canonical
owner and ordinary deltas probe at most64 touched owners. Matching postings and
unrelated Realm name scope remain C5 debt. Admission112b passed159 gate cases
and actual max1PG44 assertions20261007t130706-5e3fc4: durable admission precedes
held native work, final seal follows permit release, revocation is fenced.

## Running work and ready reviews

- G1282 attempt9 builds fixed ClaimStatementFoldPolicy and native tests. Core
  claims are released to G1330; stage minimal hooks for manager union. Preserve
  exact old Claim/revision provenance, sealed qualification/receipt, fresh
  Statement revision without predecessor/SPO rewriting. Exhaustive seek and
  completion/release qualification are mandatory.
- G1345 attempt4 moves the last Claim/Assessment constraints into Turtle while
  retaining its accepted preparation-only fold candidate4ed1c3183. No successful
  fold or release claim yet. Native completion must drain admissions after
  closures, not rely on a pre-fence pending probe. Exact candidate artifacts and
  original stored pins remain unchanged.
- G1330 attempt6 integrates three Core hooks, approved Trust native erasure inputs
  and the loaned restore-lineage dual-stream check. Historical reader93c059092
  uses the supplied client and original exact custody without nested checkout or
  native proof.71 owner cases/694 assertions,12 native and actual PG/S3/Jena224
  assertions passed; final integrated TypeScript cutover/mixed raw+slim replay
  remains required. Private original draft roots need journal-bound erased or
  unavailable outcomes before retirement. Trust G1343/G1351 compose consumers.
- G1289 attempt4 adds Content1702 exact original manifest-to-GroupRole mapping,
  <=256-entry CAS preparation, pending/completed root custody and actual restore
  release checks. Numbering/root parity passed22 units,3 physical and3 API cases.
  Trust loans owner operations/restore-lineage hooks; Main index and Taskfile
  minimal wiring require manager union after handoff. Preserve original bytes,
  top-level counts and historical manifests; no empty legacy fallback.
- G1306 attempt5 replaces rejected global actual/planned Event heads with scoped
  pending-effect coverage registered before graph writes. Outside-window backlog
  must not spoil readiness/cursors; relevant uncertain writes still refuse.
  Cold2048 unrelated prefix passed513.3sec. Program approved explicit/regression
  fixture12GiB/3GiBheap, unchanged600sec, excluded from per-merge affected/gate.
- G1300 attempt15 implements narrow potential-publication Statement seek under
  atomic subject-local coverage, Access1769. Previous subject leafd52a7d95eacc
  passed159 gate cases and320-proposal one-hydration proof, but rawSQL still
  visits324 rows/17 batches. New channel only truly absent unframed Global;
  ordinary empty proposals do not advance publication membership. Stage G1345
  held hooks, require real integrated EXPLAIN/freshness/recovery proof.
- G1290 attempt8 returned a scoped-copy design but identified a false-empty
  insertion gap: Work name writes can publish before async adoption fanout reaches
  a Realm. Next source-promotion decision brief is committed/reclaimed45146c8f0;
  resume file .temp/kernel/resume-g1290-source-promotion.md. Resume was refused
  at10.57GiB available below12GiB floor; retry when memory recovers. Candidate
  head promotion needs exact Work-local adoption basis and finite copy turns.
  No query-time population inventory, principal cache or global frontier.
- G1341 attempt7 repairs classification-vocabulary integration to use real current
  Statement and acceptance, preserving all vocabulary/replay/disclosure assertions.
  Launch G1368 owns ordinary readers. Legacy conversion/recovery readers and
  context-statement retired-route refusal tests remain intentional.
- G1352 attempt4 repairs Composition100-target pages with existing batch disclosure,
  preserving exact/current/private/final rights fences.9 owner cases passed;
  actual100-target API proof pending. Launch G1365 needs explicit accepted
  schema:episodeNumber seek within disclosed main-episodes group next, not ordinal.
- G1354 seven rating declarations landed3fe6866cf24e,154 gate files green and
  exact source/generated bytes preserved. Attempt9 Luna now moves the final
  eight declarations beside Turtle. Independent C2 audit recommends first
  removing TS author rendering/fallback, separately from16 current families.
  Claim/Assessment author conversion is accepted against its unlanded candidate,
  so Main still131 authors; candidate133. DSL/current-family work remains open.
- G1326 attempt14 repairs Jena CLI concurrency and PID-only cancellation after
  review found global container/stage deletion and orphan watchdogs. Unique owned
  resources, honest finite inspect/execution/cleanup, controlled ordinary unit
  tests and actual concurrent Docker proof required. Program wires regression and
  affected mapping after accepted landing; no per-merge hook yet.

## Operation and remaining debt

Handle ready merges/rebases/resumes, then run foreground
`scripts/goal/next-event.sh kernel`. Up to24 workers host-wide, dispatch only with
at least12GiB available. Sol/high for backend; Luna/max for mechanical work;
workers never use --heavy. Reclaim changed brief before resume. Retry merges
when Main changes during gates. No workers access vault; no push or production.
Maintain clean Main and preserve maintainer/peer edits. Native/model/migration
landings require `task dev:refresh -- --wait` and checkpoint verification.

Still open: full Claim fold,133-profile/current-family/DSL convergence, external
search copies and physical population locality, Discover remeasurement, exact
populated restore/erasure/startup, and Jena tools with Program. Zone v1-to-v2
conversion waits for Launch G1284 phase2 claim release. Optional RDF Patch cold
comparison is deferred until a measurable consumer. Close accepted completed
slices only; whole Goal stays active.
