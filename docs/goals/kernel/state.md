# State

Checkpoint: 2026-10-07 05:44 UTC. Manager GPT-6.1 Sol in tmux
`goal-kernel`, registered as `goal-kernel-codex`. Live truth:
`task goal -- status`; inbox `.temp/goal-orchestration/messages/kernel.md`.

## Immediate priority

The shared refresh failed during Statement storage preparation: product Fuseki
exposes query + command, while the landed conversion calls raw `/update`.
Account was independently restarted and is Healthy; Main and main-relay remain
stopped. G-1315 (Sol/xhigh) repairs this through a narrow authenticated native
maintenance command and tests the real `fuseki-text.ttl` layout. Merge it first,
run `task gen`, commit pins/artifacts, then `task dev:refresh -- --wait`; verify
named resources and readiness before reporting restored health. Trust-ops and
program are standing down from overlapping lifecycle actions. Their Access
1650 migration should be applied by this refresh too.

G-1296 is stopped with all C6 uncommitted work preserved in its worktree. Its
three native command core claims were temporarily released for G-1315. After
repair, restore those claims, preserve/rebase the unfinished C6 work and resume.
Class audit found another raw update in `work/reconcile-restored.ts` (offline
classification representation recovery); reuse the repair worker for it next.
Do not enable a product raw-update endpoint.

## Contracts

| Contract | State |
| --- | --- |
| C0 | Landed: G-1217 e75dda7b4, generation 4bc72dab2. |
| C2 | First slice G-1226 7adef77bc + fac97ab59. G-1289 queued behind launch G-1284 and landed trust-ops G-1288. Every profile off the DSL remains. |
| C3 | First path G-1228 d27907918, bf6503e96, 02542960b. |
| C4 | First slice G-1243 932f08a28182, generation 763722058. Unit gate and focused QA passed, but product storage acceptance failed; G-1315 must repair and qualify it. Claim folding/classification remain. |
| C5 | G-1282 running, shared adapter + three Work views + followed-Concept feed. Merge with --allow-scope for expanded migrations. |
| C6 | G-1296 paused operationally (task stopped) for the urgent native repair. Slim write, proof retirement and model-generation custody unfinished. |

Other landings: G-1297 246110a9d12f gives truthful complete on three list
reads; G-1290 first slice a72bb482c197 gives live parent name fences and durable
bounded repair (generation b79d327b7); G-1271 3411b8982d0f fixes private names,
keeps readable resource names and role identities. G-1243/G-1297/G-1271 closed.

## Active work and next slices

- G-1245 running attempt 3: finish ItemList/Recipe/episode and membership
  refresh integration. Both Statement and membership upgrade paths must stay.
  On landing send launch episode acceptance.
- G-1282 running attempt 2: C5; send launch feed query IRI and program exact
  acceptance after landing. It holds FusekiClient; urgent repair uses existing
  maintenance receipt auth family to avoid conflict.
- G-1290 running attempt 2: remaining Work eligibility and authored label
  population scans; first slice already landed, reuse worker.
- G-1300 running: verification lineage bounded expansion and durable resume.
- G-1306 running: Event incremental projection and local read dependencies.
- G-1289 queued: dispatch when G-1284 lands; G-1288 landed 0e5218da741d.
  Stage exact owner hooks and publication membership signatures in its worktree.
- G-1315 running: urgent shared-stack repair described above.

## Cross-Goal commitments

Program gets only contract landings, blockers and cross-Goal requests. Launch
was told G-1271 creditedName is lexical or `{reference,status:'unavailable'}`;
its relation/wiki callers need that shape. Trust-ops awaits C6 custody/restore
acceptance before suppression/restore work. Its G-1301 requests route-owned
rate-limit metadata on held kernel routes; exact assignments are in
`.temp/trust-ops/held-rate-limit-families.json`.

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
C6 must resume once the stack is healthy. No reliable completion projection
until urgent populated acceptance and C5/C6 handoffs; remaining population
queries and profile migrations still need slices.

Later work: chapter seek/default-graph qualification, remaining population
queries, classification capability, external search documents, cold RDF Patch
history, Jena stats/CLI with program, reply restore, and Discover remeasurement.
