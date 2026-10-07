# State

Checkpoint: 2026-10-07 06:55 UTC. Manager GPT-6.1 Sol in tmux
`goal-kernel`, registered as `goal-kernel-codex`. Live truth:
`task goal -- status`; inbox `.temp/goal-orchestration/messages/kernel.md`.

## Immediate priority

Repair kernel's introduced serialization point first: G-1300's landed Content
1520 adds writable singleton `verification.lineage_change_head`. Main
reproduction was our own earlier landing, not inherited debt. Attempt 4 is
redesigning freshness on default codex/xhigh with a forward migration that
retires the singleton; no allowance or site-wide quiet-period substitution.
Require independent-source concurrency, delayed-commit correctness, bounded
work and stale-proof handling before asynchronous fan-out. Challenge counts
are deferred. Program and trust-ops have been notified.

The shared stack is repaired. G-1315 landed at 67883e853690, artifacts at
ea78e29c6. The product assembler regression keeps `/update` absent and proves
authenticated Statement conversion, replay and narrow native policy. Final
`task dev:refresh -- --wait` succeeded on 18a969c808a2 with retained volumes;
`task urls` confirms all six resources Healthy. Model generation 9 is current
(159c5c9549ae); Access 1650 and Content 1700/1701 are current. Evidence:
`.temp/kernel/dev-refresh-final-shared.log`. Shared lifecycle hold is released.

G-1296 has its native claims restored and is resumed on default codex. Its
authored draft was stashed, rebased onto the repair, and restored; the stash
remains as backup. Strict Statement replay/template checks were preserved.
Class audit found another raw update in `work/reconcile-restored.ts` (offline
classification representation recovery); reuse the repair worker for it next.
Do not enable a product raw-update endpoint.

## Contracts

| Contract | State |
| --- | --- |
| C0 | Landed: G-1217 e75dda7b4, generation 4bc72dab2. |
| C2 | First slice G-1226 7adef77bc + fac97ab59. G-1289 queued behind launch G-1284 and landed trust-ops G-1288. Every profile off the DSL remains. |
| C3 | First path G-1228 d27907918, bf6503e96, 02542960b. |
| C4 | First slice G-1243 932f08a28182 repaired by G-1315 67883e853690; real product-layout QA and shared refresh passed. Claim folding/classification and retained restore audit remain. |
| C5 | G-1282 resumed attempt 3: reviewed templates/paging pass focused QA, but epoch-wide pending row locks serialized unrelated applies. Fix concurrent independent-anchor reconciliation before acceptance. |
| C6 | G-1296 resumed attempt 3: five-quad proof, durable custody and exact models pass focused checks, but enabled slim writes have no owner-outbox relay reader. Delivery must work before landing. Legacy exact-model backfill remains a restore prerequisite. |

Other landings: G-1297 246110a9d12f gives truthful complete on three list
reads; G-1290 first slice a72bb482c197 gives live parent name fences and durable
bounded repair (generation b79d327b7); G-1271 3411b8982d0f fixes private names,
keeps readable resource names and role identities. G-1243/G-1297/G-1271 closed.

## Active work and next slices

- G-1245 closed: 0efe4da103dd, artifacts 267614db8. ItemList/Recipe and Post
  chapter GET/PUT progress passed focused QA; Recipe duplicate transports
  retired. Shared refresh queued. Candidate normalization still scans/sorts
  the full population before bounded writes; physical-work followup remains.
- G-1282 running attempt 3: C5 independent-anchor pending consumption fix;
  three Work templates and query/schema/fixture-only Concept feed remain.
  Send launch/program exact acceptance after review and landing. Populated
  startup directory rebuild qualification remains explicit.
- G-1290 attempt 2 is in merge gate: bounded owner publication proofs,
  <=65 visited label values per turn and complete 1,001-label recovery proven.
  Reuse worker for the adjacent CatalogueNamePolicy/TS recipe caps after landing.
- G-1300 first slice 302a6cf8e8a8 landed, API 5309dcbbb and refresh passed,
  but its singleton makes C3 acceptance incomplete. Attempt 4 fixes it first
  as described above; preserve the durable DFS and exact authority checks.
- G-1306 resumed attempt 2 on codex: incremental Event projection is done, but
  source backfill still sorts the full graph before LIMIT. Qualify/fix physical
  work bounds; returned row counts alone are insufficient.
- G-1289 queued: dispatch when G-1284 lands; G-1288 landed 0e5218da741d.
  Stage exact owner hooks and publication membership signatures in its worktree.
- G-1315 closed and archived after product-layout and shared-stack acceptance.
- G-1326 first slice f624193d388d landed; artifacts b190b56a5, refresh queued.
  Three source profiles preserve 56 constraints and five focus roles through
  authored Turtle. Same worker now migrates six rating profiles.
- G-1330 queued behind C6 core claims: offline classification restore must use
  authenticated native maintenance on the product assembler, never /update.

## Cross-Goal commitments

Program gets only contract landings, blockers and cross-Goal requests. Launch
was told G-1271 creditedName is lexical or `{reference,status:'unavailable'}`;
its relation/wiki callers need that shape. Trust-ops awaits C6 custody/restore
acceptance before suppression/restore work. Its authorized G-1301 rate-limit
metadata additions landed at 6b4504057; preserve them on worker rebases.

G-1289 uses trust-ops `withZonePageContentTarget(request, zone)` and
`zonePageContentAllowed(client, graph, principalId, actingSubject, zone,
emailVerified)` in `access/zone-content-authority.ts`; never a second check.
Launch owns receipt binding and published-revision membership. Person-owned
schemes remain gated by `platform:person-schemes`.

## Operating notes

Persist: handle ready work, then foreground `scripts/goal/next-event.sh kernel`.
Inbox grows outside the Codex session. Keep Sol workers busy; cap 24 host-wide,
never dispatch below 12 GiB available. Own worker checks never use --heavy or
whole model/owner suites; program owns broad regression. Merge runs unit and
19 guards; retry when main moves. New goalctl land reviews then merges/closes,
and `land: auto` is available for routine briefs.

After model/native artifact or migration changes: generate, types, committed
artifacts, shared refresh. Preserve peer dirty files. References must be copied
into a worktree only after dispatch succeeds; workers cannot read main .temp.
New dispatches/resumes use default codex until account usage converges; reserve
xhigh for first-of-kind design. Next checkpoint is singleton retirement, then C5/C6 acceptance. Full Goal
completion cannot yet be projected reliably: remaining population queries and
profile migrations still need slices.

Later work: chapter seek/default-graph qualification, remaining population
queries, classification capability, external search documents, cold RDF Patch
history, Jena stats/CLI with program, reply restore, and Discover remeasurement.
