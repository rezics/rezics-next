# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | The active Codex [Goal](../../GOAL.md) implements retained M01–M10 backend/API only under the maintainer's 2026-09-26 direction. UI consumes the APIs; frontend, Storybook and browser acceptance are excluded. |
| Program | Retain TypeScript/Bun, Better Auth, PostgreSQL and Jena. Follow the [ten-hour proposal](#backend-only-ten-hour-proposal), API contracts, reusable backups with a 600-second routine preparation ceiling, and affected checks under the [batch cadence](execution-workflow.md#batch-cadence). |
| Agent strategy | The current management Goal dispatches up to two justified, independent worktree tasks from fresh briefs under the [delegation policy](execution-workflow.md#delegation-and-worker-lifecycle). Workers finish after handoff. Compare accepted results against total manager and worker usage under [efficiency measurement](execution-workflow.md#efficiency-measurement); expand only after measured integrated throughput supports it. |
| Authority | This active Goal authorizes local backend implementation, dependency setup, disposable QA stacks and coherent local commits on `main`. Remote pushes, production publication and paid provisioning remain outside this scope. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Status | The current management Goal started at 03:57:20 UTC on clean `f2c8aa1`. G-001 through G-018 are integrated and affected-verified on `main`. RATE03 is a declared complete-case candidate with passing merged selected checks, not recorded backend qualification. The last broad historical run `20260925t151147-02d115` passed 11 of 277 mixed cases; no `yarn qa --backend --record` result exists. See the [active management program](#active-management-program) and generated [qualification page](qualification.md). |
| Next action | Integrate G-019 npm migration 020 and run its first real API and physical recovery selection on combined source. G-020 independently works on organization-bound Realm moderation. Preserve complete field control, other package ecosystems, recovery and the remaining owner schemas; final reconstruction and recorded backend QA remain the final gate. |
| Forecast | The 276-case retained backend scope and measured partial-slice throughput forecast a miss of the 13:57:20 UTC ten-hour target. RATE03 is a candidate, not a recorded pass. Continue the full authorized scope and report only actually qualified cases; no defensible later completion timestamp exists yet. |

### Active management program

The sole scheduling and integration owner is task
`01a0dbdb-af13-7a71-b5a1-936826c4d64a`, activated 2026-09-26 03:57:20 UTC
on clean `main` at `f2c8aa1`. The previous implementation task
`01a0d1d3-22b4-7ba0-8e69-37de6d474faa` was stopped and its workers
interrupted; its predecessor was paused. Do not dispatch from either. The
[management handover](../goals/README.md#management-handover) and task files
describe the scheduling protocol; this plan is the status and assignment ledger.
The ten-hour target ends 2026-09-26 13:57:20 UTC. Initial evidence still
forecasts a miss: the last broad run passed 11 historical IDs, while all 276
retained backend IDs require fresh complete qualification. This historical run
does not supply a current backend completion percentage.

| Slice | Assignment and dependency | Current state and next evidence |
| --- | --- | --- |
| [G-001](../goals/tasks/G-001.md) / B75 | Exact Go pseudo-version checksum provenance; package owner and oracle. Independent of Access lifecycle. | Integrated and affected-verified on `c4136cd`: three unit files (5 passing tests), real PostgreSQL integration `20260926t040806-d9f055` and `yarn check:backend` passed on stable merged source. Signed pseudo-version provenance remains partial PKG05/PKG14/PKG20; full cases and final backend QA remain open. Worker task `01a0dbdf-f9e9-7ae0-aded-bb6b36315431` finished. |
| [G-002](../goals/tasks/G-002.md) / IAM06 | Org/Realm Agent-member leave/rejoin, bans, policy/terms CAS and direct-grant dependency; Access owner and API. | Integrated and affected-verified on `dc43d94`: selected Account OAuth/Main/Access/PostgreSQL membership and grant integration `20260926t041552-0ec038` plus `yarn check:backend` passed on stable merged source. IAM06 remains partial: consent reference is not an Account-verified artifact, private-principal membership and group/role dependent authority are not implemented. Worker task `01a0dbe0-250d-7e63-8944-04fa01863c35` finished. |
| [G-003](../goals/tasks/G-003.md) / IAM06 | Exact membership-episode dependency for group grants and role bindings; Access admission/claim and recovery owner. | Integrated and affected-verified on `ec52812` (including repair commit): three Access integration files passed together on stable merged source in `20260926t043554-36f7ab`; `yarn check:backend` passed. Test DB clone isolation and role recovery digest coverage were repaired. IAM06/IAM33 remain partial. Worker task `01a0dbee-930a-7da1-8f08-d837374cfb0c` finished. |
| [G-004](../goals/tasks/G-004.md) / IAM06 | Recipient-verified consent artifact for one membership episode; depends on integrated G-003. | Integrated and affected-verified on `2ef77f2`: four Access integration files passed together in `20260926t045038-2bda5c`; isolated Access PITR `20260926t045038-360a3a` and `yarn check:backend` passed on stable merged source. Recipient issue/revoke/one-use, exact generation and current mandate checks are present. IAM06 remains partial for private-principal and wider Realm participation. Worker task `01a0dc00-925a-7d40-8578-388f6c47a690` finished. |
| [G-005](../goals/tasks/G-005.md) / PKG05 | Exact local Go module replacement snapshot and pinned native oracle; independent of G-004 Access consent. | Integrated and affected-verified on `87d5d11`: unit Go MVS 10/10, real PostgreSQL/Main API `20260926t044924-01fc3a`, Go 1.27.1 native oracle and `yarn check:backend` passed on merged source. PKG05/PKG12 remain partial; worker task `01a0dc02-72a1-7ca0-8881-fce754cd1b13` finished. |
| [G-006](../goals/tasks/G-006.md) / IAM06 | Private-principal Org/Realm membership and authority; depends on G-004 consent owner. | Integrated and affected-verified on `766f0db`: five Access integration files passed together in `20260926t050749-e1bf42`; isolated Access WAL restore `20260926t050749-9c4541` and `yarn check:backend` passed on stable merged source. Private tuple, consent and direct grant are present without a public Agent surrogate. IAM06 remains partial for private group/role and wider Realm obligations. Worker task `01a0dc0e-79c1-7750-8c1e-d64e7c2c85b0` finished. |
| [G-007](../goals/tasks/G-007.md) / PKG05 | Captured Go 1.17+ module graph pruning and pinned native differential oracle; depends on integrated G-005. | Integrated and affected-verified on `a873927`: 16 package parser/MVS unit tests, isolated Main API `20260926t050226-48f551`, native Go 1.27.1 oracle and `yarn check:backend` passed on merged source. PKG05/PKG12/PKG13 remain partial; worker task `01a0dc0e-a361-75c0-a5d1-9d196e573a2c` finished. |
| [G-008](../goals/tasks/G-008.md) / PKG01 | First bounded Cargo resolver snapshot and native oracle; independent of G-006. | Integrated and affected-verified on `abc8a48`: Cargo unit 2/2, pinned Cargo 1.98.1 local registry oracle, real Account/Access/PostgreSQL API `20260926t052253-6797d9`, `yarn check:backend` and docs checks passed. Follow-on `c22034b` includes Cargo in version-three signed Content recovery coverage; selected isolated recovery `20260926t054322-e213b1` and backend static checks passed on that clean commit. PKG01/PKG02/PKG12/PKG13 remain partial; worker task `01a0dc18-e688-70a3-8537-495f11a4e9fa` finished. |
| [G-009](../goals/tasks/G-009.md) / IAM06 | Private-principal membership dependent group and role authority, exact episode claim; depends on G-006. | Integrated and affected-verified on `f0c1f69`: combined private/group/role API `20260926t053132-7513db`, isolated Access WAL restore `20260926t053132-9c3815`, backend static and docs checks passed on merged source. Exact private episode, group/role receipt, claim and leave dependency are present; IAM06/IAM33/IAM34 remain partial for wider Realm, impact and capacity. Worker task `01a0dc1d-e68d-7640-a089-959d09fa0090` finished. |
| [G-010](../goals/tasks/G-010.md) / LIVE05 | Explicit withdrawal of one title-only source support while preserving exact Work and human control. | Integrated and affected-verified on `1c9b35e`: real Source API `20260926t054842-fb0f45`, held-graph recovery `20260926t054945-cd34c4`, backend static and docs checks passed on merged source. Exact withdrawal receipt, human title head and pending intent fence are present; LIVE01/LIVE03/LIVE05/OPS03 remain partial. Worker task `01a0dc2b-293d-7951-8a1d-85254cb55763` finished. |
| [G-011](../goals/tasks/G-011.md) / PKG02 | Versioned exact Cargo `links` conflict proof against pinned native Cargo. | Integrated and affected-verified on `10cbafd`: Cargo unit 8/8, pinned native oracle (v1 and ten v2 scenarios), combined real API `20260926t055142-cf5e59`, coordinated physical restore `20260926t055206-dc75de`, backend static and docs checks passed on merged source. PKG01/PKG02/PKG12/PKG13/PKG14/PKG19/IAM10/OPS03 remain partial; worker task `01a0dc33-44c5-7983-9a49-b6534e58717c` finished. |
| [G-012](../goals/tasks/G-012.md) / IAM23 | Independent Org-to-Realm participation episode with two-party admission and no implicit management. | Integrated and affected-verified on `f1852f7`: three-file real Account/Main/Access API selection `20260926t061701-47ed20`, isolated Access WAL restore `20260926t061811-6b4fd0`, backend static and docs checks passed on merged source. Two-party invitation/acceptance, exact proofs, ban/history and independent tuple are present; IAM06/IAM23/IAM24/OPS03 remain partial. Worker task `01a0dc42-aaf7-7901-8add-b2881ea2a622` finished. |
| [G-013](../goals/tasks/G-013.md) / PKG02 | Versioned Cargo admitted-lock yanked eligibility versus fresh selection. | Integrated and affected-verified on `704cc7f`: Cargo unit 15/15, pinned native oracle (baseline, ten `links`, 16 lock and three format scenarios), real API `20260926t062113-a74da4`, coordinated physical restore `20260926t062132-64e94a`, backend static and docs checks passed on merged source. PKG02/PKG12/PKG13 remain partial; worker task `01a0dc48-e285-70a0-9f06-ba896b1d5a1b` finished. |
| [G-014](../goals/tasks/G-014.md) / LIVE05 | Two independent title supports for one native Work, with per-support withdrawal. | Integrated and affected-verified on `629496b`: merged Source API `20260926t064709-3f8ca0`, held-graph recovery `20260926t064753-ff858c`, unit, generation, backend static and docs passed. RustFS-backed human heads, independent withdrawal and Access revocation races are exercised. Abrupt Access connection loss and a coordinated Source backup cut remain unqualified; LIVE03/LIVE05/OPS03 are partial. Worker task `01a0dc5d-0539-70c0-9fa5-b1a1f05ce1d9` finished. |
| [G-015](../goals/tasks/G-015.md) / RATE03 | Daily Rating slot keyed by server calendar and private principal across DST/persona changes. | Integrated and affected-verified on `cfcb5a1`: merged daily real Account/API and graph-loss recovery `20260926t065911-65864f`, backend native model `20260926t065949-33c2ab`, standing compatibility `20260926t070006-614929`, 35 affected unit tests, generation, backend static and docs passed on stable source. Exact RATE03 complete-case declaration remains a candidate pending final recorded backend acceptance; RATE02 remains partial. Worker task `01a0dc60-fe32-73c2-ae38-942dbbbdb527` finished. |
| [G-016](../goals/tasks/G-016.md) / PKG05 | Go 1.17+ pruned graph with main remote replace/exclude against pinned Go. | Integrated and affected-verified on `f54c79f` with manager Jena-version readiness repair `6a98d53`: 26 merged unit tests, pinned Go 1.27.1 differential oracle, real private API `20260926t071418-ef61d7`, six-receipt physical restore `20260926t071823-bba00f`, backend static and docs passed. Original/replacement coordinates, captured versus unexpanded source evidence and older receipts stay distinct. Live provider, wider directives, artifact checks, lock/install and PKG05/PKG12/PKG13 remain partial. Worker task `01a0dc77-47f7-72d2-9107-af093722638b` finished. |
| [G-017](../goals/tasks/G-017.md) / IAM24 | Explicit managed-organization authority with one real protected operation. | Integrated and affected-verified on `c2a2f55`: merged managed API `20260926t072821-c7bea4`, Access WAL `20260926t072852-554a5e`, generation and backend static/docs passed. The real organization roster admission policy is protected by exact organization-issued mandate, recipient proof, ceiling, generation and revocation. Independent participation cannot imply management. IAM06/IAM23/IAM24 remain partial. Worker task `01a0dc7f-9f18-7443-a567-4d5bd4e15dc3` finished. |
| [G-018](../goals/tasks/G-018.md) / LIVE04 | One source-qualified Open Library author occurrence becomes an explicit native Work credit. | Integrated and affected-verified on `043aec3` plus guard `9ccb77f`: stable merged real API `20260926t075733-1b2d57`, held-graph recovery `20260926t080007-6f309b`, native Jena command `20260926t080046-23284b`, model units 17/17, generation, backend static and docs passed. Exact external author occurrence becomes one append-only native credit; LIVE04/MODEL05/MODEL06 remain partial. Worker task `01a0dc8f-baf0-7b11-9328-a691aa18d3d7` finished. |
| [G-019](../goals/tasks/G-019.md) / PKG03 | Bounded npm lockfile-v3 nested-instance and peer-host topology against a pinned offline native oracle. | Worker `845895d` handed off with eight native npm oracle cases, eight npm units, Cargo regression units, generation and static/docs passing. Real API attempt stopped before npm behavior at the duplicate migration number; 020 is now reserved after merged Source 019. Manager integration and first real API/physical restore remain required. PKG03/PKG12/PKG13 stay partial. Worker task `01a0dc9d-2462-7df3-9090-26f2ab24f871` finished. |
| [G-020](../goals/tasks/G-020.md) / IAM23 | Realm-local moderation of one organization-authored selected publication, with exact admitted episode and local-only effect. | Running in independent Access/Work worktree task `01a0dcb4-4438-76b0-a8f7-ac03816abfee` from clean `043aec3`. Atomic saved participation episode and manager proof must precede graph dispatch. Combine with G-012 suspension to target a complete IAM23 candidate only after whole-row merged evidence. Moves, quota/review and paid benefits remain retained. |
| Authority and model backlog | IAM07–IAM37 and MODEL05–MODEL27 gaps, sequenced behind required Access and semantic owner decisions. | Planned at the [operation map](backend-operations.md); create bounded briefs when interfaces stabilize. |
| Content, Space and community backlog | CTX, WORK, RATE, GRAPH, VIEW, BOOK, RECIPE, SUB and other M01–M10 gaps. | Planned at the operation map; retain all backend assertions. |
| Search, sources and packages backlog | SEARCH, LIVE, PKG and HUB gaps after B75, with source/owner integration and recovery. | Planned at the operation map; selected B14–B74 evidence remains partial where named. |
| Operations and final acceptance | Fresh construction, 600-second routine restore, bounded cost and host evidence, G1–G4/G6, then one clean `yarn qa --backend --record`. | Pending; reserve final window and never count an unrun or partial case as passed. |

The manager handles completed or blocked handoffs when observed and runs a
30-minute same-task reconciliation. Each checkpoint updates newly verified
behavior, blockers and owners, integration queue, critical path and forecast
here. Task files carry the brief; local thread/worktree mappings and leases live
under `.temp/goal-orchestration/`. No task is dispatched twice while an earlier
attempt may still write. Start with two workers and one active integration batch;
expand only after a complete measured batch shows useful throughput.

**30-minute checkpoint, 2026-09-26 04:27 UTC.** G-001 and G-002 are integrated
with passing affected checks; they add signed Go pseudo-version evidence and the
first Org/Realm Agent-member lifecycle, but no newly complete retained backend
ID. G-003 is the one active worker. Its combined Access integration selection
exposed shared scope-gate fixture interference; G-003 owns isolation/cleanup
repair and must pass the combined selection before handoff. No committed worker
result is waiting in the integration queue. G-004 is ready after G-003 releases
the Access/app.ts boundary; the second worker slot stays unused while that
boundary is shared. The critical path includes G-003, recipient consent,
principal-member admission and the broader M01–M10 owner backlog before fresh
construction and one full recorded backend run. The 13:57 UTC target is forecast
to miss: two integrated slices have produced zero newly complete IDs against
the 276 retained cases. The remaining dependency graph is not yet measured well
enough for a defensible later finish timestamp. Continue the full scope and
revise this forecast at the next checkpoint or sooner on a material change.

**30-minute checkpoint, 2026-09-26 04:57 UTC.** G-003, G-004 and G-005 joined
G-001/G-002 on clean `main`. The merged selections passed real Access membership,
grant, group and role integration, recipient-consent PITR, local Go replacement
API, native Go oracle and backend static checks; no newly complete retained
backend ID has been established by these partial slices. G-006 and G-007 occupy
the two permitted independent worktree slots, with no committed handoff waiting
for integration. The critical path still includes private-principal and wider
Realm admission, the remaining package ecosystems, source field/child/withdrawal
owners, most M01–M10 operation families, a complete reusable fixture, fresh
construction and full recorded backend QA. The small stopped-state restore
probe does not qualify the complete fixture. The 13:57 UTC ten-hour target is
still forecast to miss: five integrated slices in one hour produced zero newly
complete IDs against 276 retained backend cases. A later finish time is not
defensible until the remaining owner interfaces and full-case throughput are
measured. Keep the full acceptance set and dispatch immediately on handoff or
blocker; revisit by 05:27 UTC or sooner on a material change.

**30-minute checkpoint, 2026-09-26 05:27 UTC.** G-006, G-007 and G-008 have
joined G-001–G-005 on clean `main`. Their merged selections passed private
principal membership and Access WAL restoration, Go 1.17+ pruning against native
Go, exact Cargo resolver 2 snapshot against pinned native Cargo, real API tests
and backend static checks. All remain partial contributions; no newly complete
retained backend ID is established. G-009 is active with private group/role
integration and isolated Access WAL restore passing in its worktree; its static
gate and handoff review are underway. G-010 is active on explicit source
title-support withdrawal, with an exact binding/receipt and serialization design.
No committed worker result is waiting for integration. G-011 is prepared for
the next package slot after a handoff. The critical path remains wider Realm
authority, source field/child lifecycle, the other package ecosystems, most
M01–M10 owners, reusable full fixture and recovery, clean reconstruction, then
one recorded full backend QA. Eight integrated slices in 90 minutes have added
zero fully qualified IDs against 276 retained cases. The 13:57 UTC ten-hour
target is forecast to miss; a later finish timestamp remains unsupported by
measured full-case throughput. Retain every acceptance assertion, dispatch on
the next handoff or blocker, and reconcile again by 05:57 UTC.

**30-minute checkpoint, 2026-09-26 05:57 UTC.** G-009, G-010 and G-011 have
joined G-001–G-008 on clean `main`. Their merged selections passed private
membership-dependent group/role authority and Access WAL restore; source
title-support withdrawal, read and held-graph recovery; Cargo native `links`
conflict oracle, real API and coordinated owner-cut restore. The signed Content
recovery coverage was extended to include Cargo before the merged physical
restore. The eleven slices are partial; no newly complete retained backend ID is
established against the 276-case scope. G-012 now owns two-party independent
Org-to-Realm participation; G-013 owns fresh versus admitted-lock Cargo yanked
eligibility. Both independent worktree slots are active and no committed handoff
awaits integration. Docker Desktop returned API 500 but its daemon answered a
later 05:57 probe; one concurrent Podman PostgreSQL startup also failed, but
isolated tests passed on the documented Podman socket after cleanup. Neither
incident currently blocks backend work. The critical
path still spans wider Realm authority, complete source field/child control,
other package ecosystems, most M01–M10 owners, reusable complete fixture and
recovery, clean reconstruction and one recorded full backend QA. Eleven slices
in two hours produced zero fully qualified IDs. The 13:57 UTC target is forecast
to miss; a later finish timestamp remains unsupported by full-case throughput.
Preserve all acceptance assertions, dispatch at the next handoff or blocker, and
reconcile again by 06:27 UTC.

**30-minute checkpoint, 2026-09-26 06:27 UTC.** G-012 and G-013 have joined
G-001–G-011 on clean `main`. Merged selections passed independent Org-to-Realm
two-party admission, bounded contention and Access WAL restore; Cargo fresh
versus admitted-lock yanked eligibility against native Cargo 1.98.1, real private
API and signed coordinated physical restore. The parser distinguishes malformed
floating lock version from accepted integer spellings; the lock remains
caller-supplied evidence rather than an artifact verification claim. All thirteen
slices are partial contributions: zero newly complete retained backend IDs are
established against 276. G-014 Source and G-015 daily Rating occupy the two
independent worktree slots; G-016 Go pruning/directives is prepared for the next
handoff. No committed result waits for integration. G-014 found that Access and
Source use different PostgreSQL databases, so its short read-only Access lock
envelope can fence revocation across a Source commit but cannot assert a
cross-owner atomic backup cut or that a preflight Work head remained current.
G-015 is designing a durable server-calendar slot and new native command
profile; standing receipts must stay unchanged. The critical path remains
complete Realm management/authority, Source field/child/rights lifecycle,
remaining package ecosystems and installation, the wider M01–M10 owner APIs,
reusable complete fixture, host/capacity/recovery evidence, clean rebuild and a
recorded full backend QA run. Thirteen integrated slices in two and a half hours
produced no fully qualified ID. The 13:57 UTC target remains forecast to miss;
the available evidence still cannot support a later complete finish time. Keep
the full acceptance contract, dispatch on handoff or blocker, and reconcile again
by 06:57 UTC.

**30-minute checkpoint, 2026-09-26 06:57 UTC.** G-014 joined G-001–G-013 on
clean `main` after passing merged Source API, held-graph recovery, unit, generation,
backend static and docs checks. The new attachment preserves singular receipts,
checks an S3-backed human Work head and holds a bounded live Access authority
envelope through the Source SQL commit. Abrupt Access connection loss and a
coordinated cross-owner backup cut remain explicit unqualified boundaries. G-015
is merged and its selected unit, generation, backend static and docs checks pass;
the merged real-owner recovery run is still preparing the updated native Jena
image and its remaining owner/model checks follow. RATE03 has a complete-case
declaration and passing worker evidence but is only a candidate until merged and
final recorded backend verification. G-016 and G-017 immediately took the two
independent worktree slots after the handoffs; no completed worker waits in the
integration queue. An unrelated editorial-protection documentation batch was
committed separately at `5d54e6a`; its new prospective assertions are retained,
without counting documentation as implemented backend behavior. The critical
path remains wider Access/Realm authority, Source child and field control, package
ecosystems and installation, the other M01–M10 owner APIs, reusable complete
fixture and recovery, host/capacity qualification, clean reconstruction and a
recorded full backend QA. Fourteen fully merged/verified slices and one merged
slice under checks have added zero newly recorded complete backend IDs against
276; the 13:57 UTC target remains forecast to miss, with no defensible later
finish timestamp. Continue all retained requirements and reconcile by 07:27 UTC.

**30-minute checkpoint, 2026-09-26 07:27 UTC.** G-015 and G-016 are now fully
integrated and affected-verified with G-001–G-014. G-015's daily server-calendar
rating passed merged Account/API, model and standing integration plus stable
graph-loss recovery; RATE03 is a declared complete-case candidate pending final
recorded backend qualification. G-016's pruned Go profile passed a native Go
oracle, merged private API and six-receipt physical restore. A stale Main Jena
command-version constant initially failed `/health/ready`; the manager repaired
it at `6a98d53` and the stable restore rerun passed. Docker Desktop's transient
API failures cleared; neither daemon nor Podman currently blocks work. G-017
passed its managed-authority API selection, static/docs checks and Access WAL
restore in its independent worktree and is committing its handoff; the manager
must still merge and repeat affected checks. G-018 has fixed its native author
credit/source-support design and is implementing it in the other worktree.
G-019 is ready for the next independent package slot. No committed handoff is
waiting in the integration queue at this checkpoint; two worker slots remain
occupied until G-017 finishes. Sixteen integrated partial slices have established
zero newly recorded complete IDs against 276 retained backend cases. The critical
path still includes general Access/Realm authority, complete Source field/child
control, package ecosystems and installation, the other M01–M10 owner APIs,
complete reusable fixture/recovery, clean reconstruction and one recorded full
backend QA. The 13:57:20 UTC ten-hour target remains forecast to miss, and full
case throughput does not support a defensible later completion timestamp. Keep
all assertions and reconcile again by 07:57 UTC or immediately on handoff or
blocker.

**30-minute checkpoint, 2026-09-26 07:57 UTC.** G-017 is integrated and
affected-verified with G-001–G-016. G-018's author-credit commit is merged on
`main` as `043aec3`; the manager repaired the combined OpenAPI path guard at
`9ccb77f`, and generation plus backend static checks pass. Its merged real API,
held-graph recovery and native model selections are the current integration
batch. G-019 finished its independent npm handoff at `845895d`; its migration
was renumbered 020 after the merged Source 019, and first real API/physical
restore checks wait for that integration. G-020 is the one active worker on
Realm-local organization publication moderation, with an atomic saved Access
participation and manager proof as its owner boundary. One handoff waits in the
integration queue; one worker slot is deliberately unused while the Source
integration is serialized. Docker Desktop's earlier transient API response is
clear, and Podman-backed QA is available. RATE03 remains the only declared
complete-case candidate; zero retained backend IDs have a new recorded full
pass. The critical path still includes the remaining Realm and Source owner
surfaces, package ecosystems and installation, other M01–M10 API families,
complete reusable fixture and recovery, clean reconstruction, and the recorded
full backend run. Seventeen verified partial slices and one merged slice under
verification leave the 13:57:20 UTC ten-hour target forecast to miss. No later
completion time is defensible at this throughput. Preserve all 276 retained
backend assertions and reconcile by 08:27 UTC or immediately on handoff or
blocker.

### Backend-only ten-hour proposal

The maintainer's 2026-09-26 direction is authoritative: API operations define
backend scope; UI consumes those APIs. Frontend, Storybook and browser acceptance
are outside this Goal. Ten hours includes setup, implementation, coordination,
checks and repair. The current task activated the Goal from `GOAL.md`; the earlier
planning revision did not start its clock.

**Diagnosis.** The toolchain selected `pg` and confined Kysely to Better Auth.
The inspected stack/toolchain owners contain no ORM comparison justifying that
restriction for ordinary application tables. Content now hand-maintains row
mapping and a migration branch per version. The previous plan already required
fixture reuse; repeating 166/174-minute command seeding did not implement that
requirement. The fix is an enforced preparation path, not another recommendation
to optimize later. Existing 277-ID results mix frontend/backend obligations and
cannot be presented as a backend completion percentage.

**Engineering decisions.**

| Area | Decision | Limit |
| --- | --- | --- |
| PostgreSQL | Adopt a bounded Drizzle ORM typed-query slice over Content's existing `pg` transaction. Keep Content's numbered SQL migrations as the single DDL owner and discover them automatically. | Expand typed table coverage with owner features; do not run Drizzle Kit as a second migration history. A later Kit handoff needs a complete baseline and empty/existing upgrade gate. Keep necessary parameterized locking/recursive/recovery SQL. |
| Database design | Design the retained owners' tables, constraints, indexes and relationships together before bulk fixture creation. | Use ordinary schema definitions and migrations; do not build a universal schema framework. Preserve separate owner credentials and transaction boundaries. |
| Test data | Bulk-build one reusable complete fixture generation, save a consistent backup of PostgreSQL, TDB2/Lucene and objects, restore isolated copies thereafter. | All routine preparation, including restore, startup, migration and minimal readiness, must finish within 600 seconds. Do not seed the background corpus through public commands or re-prove it on every restore. |
| Authentication | Keep Better Auth and its admitted official plugins/schema tooling. | Keep the present adapter during the Content pilot; ordinary account features do not need homemade protocol machinery. |
| APIs | Keep Elysia + TypeBox + generated OpenAPI/Eden. All user-visible business operations have callable API contracts. | No UI/BFF-owned business authorization, direct storage access or workflow steps unavailable to API clients. Backend API tests must run without the web app. |
| Jobs | Candidate pg-boss for a concrete scheduling/retry consumer after pinning and a small compatibility gate. | Preserve domain outbox, idempotency and projection checkpoints; do not rebuild a scheduler or claim exactly-once external effects from a queue. |
| Graph/search | Keep Jena/TDB2/jena-text. | ORM covers PostgreSQL, not RDF/SPARQL/SHACL. No new engine comparison or graph ORM project. |
| Package ecosystems | Thin adapters around admitted native resolvers/installers where semantics fit. | Reuse their algorithms; keep REZICS source/lock/authority semantics and qualify each retained ecosystem. |
| Daily verification | Changed backend behavior, affected contracts and relevant static checks only, using the existing harness. | No unrelated browser build, full restore matrix, full corpus check or full suite per small batch. |
| Final verification | One fresh construction path and complete backend integration, recovery and required load qualification; repair discovered defects. | Final evidence still covers the full retained backend scope. Missing features cannot be replaced with mocks or declared complete. |

Drizzle ORM is used for Content's first typed writes because it reuses `pg`
and infers query types from TypeScript table declarations. The bounded real
PostgreSQL slice passed the transaction/CAS/outbox and bigint gates; broader
table coverage and any migration-owner handoff remain open. This is a fit
judgment, not a measured speedup. Official sources:
[existing PostgreSQL](https://orm.drizzle.team/docs/get-started/postgresql-existing),
[migrations](https://orm.drizzle.team/docs/migrations),
[transactions](https://orm.drizzle.team/docs/transactions) and
[Better Auth adapter](https://better-auth.com/docs/adapters/drizzle).
The Content test covers JSONB/bigint representation, CAS, transaction
connection, receipt/outbox atomicity, empty install and existing v3 upgrade.
Later Kit adoption must baseline the existing migrations; never let two runners
own the same table history. Account integration remains unchanged.

[Kysely](https://www.kysely.dev/) 0.29.6 is the lower-change fallback already in
Account; it offers typed queries but not the proposed schema-diff workflow by
itself. Prisma's [introspection](https://docs.prisma.io/docs/orm/prisma-schema/introspection)
is also viable; its separate model/client workflow has no demonstrated payoff
for this time box. Do not conduct a broad ORM benchmark.
[pg-boss](https://github.com/timgit/pg-boss) supplies scheduling, retries and
transactional enqueue, but its REZICS integration is still a candidate.
Sources were checked on 2026-09-26. Pin new tools and root commands in the
toolchain before installation; current Drizzle onboarding uses `@rc`, which must
not be copied as an unpinned dependency or mixed with another release's APIs.

**Budgeted delivery.** These are allocations, not evidence that the entire
remaining M01–M10 backlog fits. Current evidence cannot support a guaranteed
100% backend completion within ten hours.

| Elapsed window | Work and observable exit |
| --- | --- |
| 0:00–0:30 | Freeze the API operation/acceptance inventory and owner schema design. Identify missing implementations and external prerequisites. Split mixed cases without dropping backend assertions. |
| 0:30–1:30 | Qualify the ORM slice and routine backup/restore path; add explicit backend/affected QA selection. Restore plus startup/readiness must fit 600 seconds. Reuse an existing compatible backup immediately; do not wait for another command-seeded baseline. |
| 1:30–7:30 | Implement API capability slices with tests, in dependency order: authority/commands, Content/Space/classification, query, sources/packages and remaining community/commercial operations. Run affected checks per coherent batch. This is six hours of work allocation, not a claim that all these domains fit. |
| 7:30–8:30 | Close cross-owner gaps and prepare final clean installation/data rebuild and practical-load checks. Start any necessary long final experiment earlier on an isolated pinned source. |
| 8:30–10:00 | Full backend qualification, consolidated repair and final evidence. Report the exact commit, callable APIs, passed/partial/missing cases and blockers. |

At 1:30 and each accepted batch, forecast remaining work using actual elapsed
time and the operation-level backlog. Report a forecast miss immediately; keep
doing authorized independent backend work within budget. Keep one integration
batch; workers only own justified independent modules. Stop new large subsystem
work at 8:30 to reserve integration and repair time.

The user authorized frontend removal only. No other backend requirement is
silently cut to make the percentage reach 100. A reduced ten-hour release would
require an explicit scope decision. At the deadline an incomplete backend remains
incomplete; time exhaustion never satisfies the completion gate.

**General rule.** Check every repeated task for reusable outputs: dependencies,
images, generated schemas, source fixtures, backups, indexes and test environments.
Invalidate only artifacts affected by a format/schema/semantic change. Do not
invalidate data solely because an application commit changed. Full-corpus scans,
receipt replay, source refetches and capacity experiments belong to a relevant
diagnostic or final gate, not normal startup. Keep a short setup/check/feature-time
summary in the existing batch row; do not add another reporting framework.

Backend completion is fully passed retained backend cases divided by the frozen
backend total, with partial cases contributing zero. Report implemented API
operations separately. Follow the [scope rules](backend-acceptance.md#backend-only-scope)
and [harness contract](../testing/test-harness.md#backend-only-goal-scope).

### Implemented baseline

This is the state at commit `5823d1b` (2026-09-24). Its scoped checks ran as
one-off integration tests before the harness existed; they count toward the
listed IDs only as *partial*. Detailed narrative evidence for these slices is in
git history up to that commit.

| Area | Implemented | Partial scoped checks | Main gaps |
| --- | --- | --- | --- |
| Graph substrate | Pinned Fuseki 6.2.0/TDB2/jena-text, `cjk-bigram-v1` assembler, offline CJK rebuild, generation-bound public text readiness gate. | OPS14, OPS16 | Privileged activation of rebuilt existing indexes; crash-time rebuild. |
| Account | Better Auth 1.7.5 OIDC authorization code with PKCE, client credentials, introspection, member deletion with an Access fence, WAL recovery manifests. | IAM01, IAM02, IAM10 | Web sign-in, email flows, consent, passkeys. |
| Access (in Main) | PostgreSQL admission, receipts, scope and principal fences, strong closure, PITR recovery fence. | IAM07 | Grant management lifecycle; complete strong revocation. |
| Main commands | Guarded Work create/edit, immutable manifests and exact history reads, receipts, RDF outbox relay with checkpoints. | SYS02, SYS04, SYS05, SYS09, SYS10, SYS12, SYS14, G3 | The baseline's host validator path was replaced by P0.2; native command ingress still needs a complete validation gate. |
| Work and publication | Text Contribution draft/edit, contributor eligibility, Main Version default, Realm-local adoption and rejection. | WORK02, WORK03, CTX01 | Web journey; management grants. |
| Space and classification | Space/Realm creation, classification contexts, shared Global propositions, curated decisions, effective resolution. | MODEL15, MODEL17 | Broader Application paths; web. |
| Ratings | Realm standing RatingContext and observations, bounded latest-per-rater aggregate. | MODEL15, MODEL17 | Materialized generations, persona rules. |
| Search | Bounded public phrase search for Main and Realm, classified and rated joins, CJK and mixed-script fixtures. | SEARCH01, SEARCH03 | Private search, broader descriptors and relevance. |
| Recovery | Isolated graph/Access/object restore, mixed-cut outcome replay, deletion journals and coverage envelopes. | OPS03, SYS13 | Coordinated owner cuts, erasure state, downstream checkpoints. |
| Web client | The baseline had none; later P0.6 adds a built Worker shell, public search, Work metadata page, sign-in/studio routes and Storybook. | See P0.6's scoped public/authenticated browser evidence below; it does not qualify the full product journey. | Complete authenticated Work/Realm/edit/search journey and broad frontend acceptance. |

### Execution program

The historical P0.6/browser results below remain evidence of prior work; frontend
deliverables and remaining browser gaps are outside the current Goal. New batches
follow affected backend verification and reusable backups, not the historical
full-suite-per-batch cadence.

Documentation batch `D-20260926-protection` implements the maintainer's approved
editorial-protection and evidence-quality design in the owning contracts,
storage/API bindings and prospective acceptance scenarios. Work stays local
because these edits share one state/authority model. Scope is documentation only;
the active manager retains runtime scheduling and the frozen acceptance inventory.

| Batch | Owners and acceptance scope | State and next action |
| --- | --- | --- |
| D-20260926-protection | Editorial protection/correction; information verification; names/source control; commands, Access bridge, Jena/PostgreSQL, schema evolution and recovery. Refine existing MODEL, LIVE, FACT, GOV, SYS and OPS cases without claiming new passes. | Documentation complete; `yarn docs:check` passed for 189 Markdown files and 9 checker tests. Runtime handoff: owner schemas and all writer guards, then Work title control/protection/correction, then quality and recovery qualification. The active manager schedules those slices; no runtime pass or frozen-inventory change follows from this batch. |

Phase 0 names foundation dependencies, not an all-or-nothing barrier. The working
root commands and shared QA core unblock product slices whose owner dependencies
are available. Carry other P0 cases with their consumers and retain every required
case in the final gate. Parallel work stays within the active slice and the
workflow's work-in-progress limit.
Prioritize a root-command run of one existing real integration path, with shared
setup and a compact result, before expanding coverage. This is the harness's
first increment, not P0.4 completion. Use scoped module briefs and the
[context discipline](execution-workflow.md#context-and-agent-coordination) to
reduce model round trips and repeated context loading as well as test overhead.

| ID | Deliverable | Exit check | Progress |
| --- | --- | --- | --- |
| P0.1 | Service/image topology in `infra/dev/` and `infra/jena/`; root commands and host process wiring in `scripts/dev/` and root `package.json`. OPS01/OPS14/OPS16 and the existing Main/Account integration path are affected. | From a clean clone, `yarn toolchain:install && yarn dev` serves healthy Main and Account. No `REZICS_*` host paths remain. | Exit check passed from a sibling fresh clone with no Yarn install state: exact install completed, then `yarn dev` served Main and Account `/health/ready` with HTTP 200; teardown left no running stack. The existing checkout also served both without host Jena/Java/Python variables. This does not certify full OPS01/14/16 cases. |
| P0.2 | Java command endpoint, assembler/image wiring and transactional gate under `infra/jena/`; Main command adapter and writer migration under `services/main/`. SYS02/SYS09/SYS10/SYS14 and model validity cases are affected. | The module gate in the toolchain lock passes; Main has no `execFile` validator path. | Partial: pinned native module 0.5.10 keeps fenced Content rebuild commands, per-JVM identity and a public-search write epoch, and validates focus graphs through a read-only union rather than copying their triples. Main claims Access grants before dispatch. The native model gate passed 26 tests and all 66 recorded outcomes/path checks; broader command families and external Access binding still need qualification. |
| P0.3 | TypeScript model IR and compiler for the historical and newly admitted profiles, with generated shapes, TypeBox schemas, types, constants, registry and arbitraries. | Recorded candidate outcomes reproduce; the Python validators and hand-written profile Turtle are deleted; `yarn gen:check` is clean. | The 12 historical generated profile digests and all 66 recorded native outcomes retain zero result-path differences; three Content publication/search profiles bring the current total to 15. The merged model tier passed in `20260924t195652-538b84`. The handwritten Turtle definitions and Python validator/test execution files were removed; historical fixtures remain. MODEL17/MODEL27 retain partial acceptance status pending broader cases. |
| P0.4 | Shared-stack `yarn qa` core under `tests/qa/` and `scripts/qa/`, starting with real Account signup/session and Main/Fuseki readiness. OPS01/IAM01 have partial smoke coverage; later increments add oracles, split cases, model/fault/e2e/load tiers, fixture fetcher and `--record`. | `yarn qa` passes within 30 minutes on this host; setup is shared, overlapping full runs on one checkout are rejected, failure reruns preserve their partial scope, and `--record` verifies and records in one run. Any failure can be rerun by ID. | Clean merged `20260925t035859-06b5a7` passed static, 120 unit, 24 integration, 27 model, 10 fault/recovery, 4 browser and 1 load case within the 30-minute budget. It reports 8 passed IDs, 30 partial and 239 uncovered. The five host-Jena owner tests are explicitly outside the QA registry until migrated to the shared stack; their prior failed paths remain visible in failed-run diagnostics and certify no IDs. Final clean `--record` and broad coverage remain open. |
| P0.5 | Explicit response schemas, OpenAPI export, `MainApp` type export, S3 object adapter on RustFS. | The Eden and object-storage gates pass. | Partial: aws4fetch signed conditional creation, read-back checks and eight same-key writers passed against RustFS. Main Work create/edit, exact and recovery reads use the adapter when configured. All 36 Main `/v1` routes now have explicit response schemas and inferred types; `yarn gen:check` checks `generated/openapi/main/public.json`, and the standalone Eden consumer compiles and makes two actual calls. The earlier merged static, unit and integration tiers passed in `20260924t202630-48ca4a`; the new routes await full merged QA. Other semantic object consumers, backup/restore, multipart/GC and the web Eden BFF gate remain. |
| P0.6 | `apps/web`: vinext on Workers, Eden with TanStack Query, Tailwind/SharkUI in `packages/ui`, `native-i18n`, Storybook, Playwright; sign-in through Account, one RSC Work page and one client search component. | Playwright on `wrangler dev` and the Storybook tests pass inside `yarn qa`. | The merged English/Simplified Chinese shell, search, auth, Studio and exact Work page passed the built-Worker browser tier in `20260924t202630-48ca4a`. Cases covered PKCE, denied actor, Work creation, explicit QA read grant, Chinese exact revision on mobile, locale persistence, per-browser isolation and independent search language. Integration proves exact read denied before and allowed after the Access grant. The complete authenticated Content/Realm/edit journey and broader frontend acceptance remain. |
| P0.7 | README, installation, service READMEs and model README describe the actual commands. | `yarn docs:check` passes; the documented commands run as written. | Root README, installation, operations index, Main/Account service READMEs and model README document the current commands and separate the S0 raw-update drill from the product command path. Merged `yarn docs:check` passed 166 Markdown files and 9 checker tests. `yarn dev --profile qa --run-id p06-install` then launched Main, Account and web from an isolated stack: both readiness endpoints and `/sign-in` returned 200, registered OAuth/runtime files were mode 0600, and teardown left no QA containers. Final documentation reconciliation follows the Content search and broader browser boundaries. |
| P0.8 | PostgreSQL Content revisions/drafts/receipts/outbox and preparation pins; common history adapters; exact-revision publication; bounded two-owner relay into RDF MatchUnits and embedded Lucene; coherent readiness and two-stage rebuild. | WORK02–03/09–10, SEARCH01–04/06–08/15–20 and OPS03/09/11–12/15–16 pass through the harness. Derive path costs, assert multi-scale work and retain plans, amplification/recovery evidence and separately scoped host objectives. | Partial cmd0.5.17 evidence covers public paging, Content history/pins, link replay, projection, rebuild and restore. The 10-Work diagnostic passed a bounded native delta and private Contribution restart probe. The two 10,000-Work attempts failed 26 and two mixed reads after approximately 166 and 174 minutes of command seeding; the latter two were transient `search_index_unavailable` Content responses. Clean 100-Work one/four-worker seeding took 79/82 seconds; clean 1,000-Work seeding took 899 seconds and its mixed phase passed. Implement compatible isolated background preparation and a bounded read-race reproducer before another large run. Private paging, native cost coverage and complete P0.8 acceptance remain open. |

With their required foundations, backend/API batches follow the [dependency order](#dependency-order)
until every retained M01–M10 capability has a working API and its required
storage, authorization, cross-service and operations behavior. UI consumes those
APIs in a separate future scope. Existing web files remain; browser regression
and new web work are outside this Goal.
P0.7's final documentation verification includes the P0.8 commands once supplied.
P0.8 reuses the selected engines: it does not authorize a new query optimizer or
an automatic engine migration if a gate fails. Correct the bounded plan/index
binding first; a material remaining failure reopens only the affected decision
with retained evidence. Do not pass by excluding the core graph/text/Realm query.
Add one row per batch; keep the rows short and cite the qualification page.

| Batch | Scope and acceptance IDs | Result |
| --- | --- | --- |
| B1 | Complete the S2 authenticated Work/Realm/edit/search journey through real API calls and owner state, including denied, stale, concurrent and recovery outcomes. IDs from [native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [identity/access](../testing/identity-and-access.md); required Content, Access, Account, Main and graph integrations are in scope. | The real Account OAuth, Access, Main, Content, Realm classification, adoption/rejection, search, exact history and paragraph-comment journey passed the merged integration tier `20260925t035859-06b5a7`. Content recovery coverage and a translated-link graph-loss replay passed the fault tier. The older host-Jena OAuth restore owner test is outside QA pending shared-stack migration, so the broader coordinated Account/Access/Content/graph restoration and mixed-cut gates remain open. Full web flows follow backend/API completion. |
| B2 | Establish the Access read-admission side of SEARCH11/SEARCH12 private phrase search, then bind exact Content and graph/index positions and enforce pre-match field/unit eligibility at the API. | The ten-second durable Contribution read lease, generation recheck and strong-closure pending accounting passed the merged QA; native private MatchUnit and field isolation have direct integration coverage. The internal adapter requires a command-only service and awaits the next small `yarn load` diagnostic and retained restart proof. A full-size WebSocket frame followed by a matching nonce pong proved ordered peer receipt in a loopback probe, while early/wrong pongs and a buffered half-closed peer remain counterexamples for terminal delivery. The HTTP route stays closed at 503 pending a proven delivery/cancellation protocol. SEARCH11/12 and broader Content mapping remain unqualified. `admission.ts` exceeds 800 lines pending extraction after live behavior is qualified. |
| B3a | Begin M01 private acting-context discovery and selection over real Account/Access/Main boundaries. IAM01/IAM03/IAM04; one principal may represent several Agents, and an Agent may have several controllers without publishing the private mapping. | Merged with B3b. Private discovery, task-scoped checks, an OpenAPI consumer and the shared-stack test have scoped evidence; the latest merged tree remains unqualified. Grant mutation, full group/role composition and web flows remain subsequent work. |
| B3b | Merge the next backend boundary slice: IAM09 explicit-consent authorization-code, refresh and introspection fence; IAM01/03/04 private acting-context preference CAS and Access recovery coverage; SEARCH02/10 rejected-candidate budget; SEARCH13 named-graph sentinel; SEARCH11/12 durable private-send receipt and final position recheck; OPS03 coordinated Account/Access/Content/graph physical restore. Owners are Account, Access, Main, Content, graph and the QA integration/fault tiers. | Merged `yarn qa` `20260925t082555-6980ba` passed all seven tiers after Access fixture, restore-run ID and Account JSONB consent fixes. It reports 9 passed IDs, 31 partial and 237 uncovered across the retained scope. Private delivery/search and broader owner coverage remain unqualified. |
| B4 | Integrate Stage A IAM04 direct-principal `work.create` authority beside represented-Agent selection; SEARCH11/12 native private field, position and receipt boundaries; SEARCH20 public Content projection/index restoration after loss. Owners are Account, Access, Main, Content and graph/index fault fixtures. Review the selected path, negative/recovery outcomes and bounded work under the cost contracts. | Full merged `yarn qa` `20260925t085124-7fa328` passed all seven tiers after an Access migration-fixture repair and a command-only native private-search fixture. It reports 9 passed IDs, 32 partial and 236 uncovered across the retained scope. SEARCH11/12 keep the HTTP route closed; SEARCH20 and broader IAM04/SQL-cost gates remain partial. |
| B5 | Extend Stage A IAM05/IAM36 with private same-scope Agent group inheritance for `work.create`; qualify SEARCH04 rated-relation multiplicity and SEARCH06 CJK Main/Realm selection; add an optional bounded seed-worker profile for OPS05/SEARCH18/SEARCH19 diagnostics. Owners are Access schema/context/admission, Main native query fixtures and the practical-load runner. Derive and check path costs, bounds and denied/stale outcomes. | Full merged `yarn qa` `20260925t091518-584f03` passed all seven tiers after a SQL alias repair, an Access migration fixture update and a bounded restore-promotion wait. It reports 9 passed IDs, 32 partial and 236 uncovered. Seed concurrency defaults to one and awaits a small 100-Work A/B diagnostic. Public group management, impact approval, general roles, wider IAM36 and bounded discovery SQL remain open. |
| B6 | Extend M01 and native Work boundaries: IAM11 older/current Account and Access physical restore against retained deletion evidence; IAM33 exact represented `work.create` proof across mandate, grant, Agent and principal generations; WORK04 explicit adaptation, recording and fork derivation from an exact retained source revision. Owners are Account, Access, Main, graph/model and the integration/fault tiers. | Full merged `yarn qa` `20260925t095644-8fd772` passed all seven tiers after fixture repairs and cmd0.5.17's successive restore-cutover correction. It reports 9 passed IDs, 34 partial and 234 uncovered. IAM11, IAM33 and WORK04 retain broader paths; Work derivation query plans and cold-cache costs remain open. |
| B7 | Complete SEARCH05/09's current-only public search refusal contract across all six query and page profiles, and extend IAM11's isolated Account erasure restore to retain an unrelated public Work and exact PostgreSQL Content revision. Owners are Main public API, Account, Access, Content, graph and the integration/fault tiers. | Full merged `yarn qa` `20260925t100655-4e1b04` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The two supported refusal cases returned typed 422 before native reads; the IAM11 physical restore retained unrelated public Work and exact Content bytes. Historical copy sanitization and off-host custody remain open. |
| B8 | Batch IAM04/IAM36 acting-context discovery's represented Agent grants and same-scope group inheritance. Preserve current group depth, membership and 50/51 result ceilings, private path hiding, recovery fence and selected-command recheck; assert fixed SQL call count against a real Access owner. | Full merged `yarn qa` `20260925t102029-423253` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The 20-group-Agent plus mixed 50/51 owner case passed with 13 total SQL calls, including transaction setup, versus candidate-dependent calls before batching. Physical plans and cold-cache costs remain open. |
| B9 | Diagnose the failed 10,000-Work mixed read boundary without another multi-hour seed. Retain phase-specific read/retry traces only in load Main logs, reproduce an over-deadline writer with a bounded fake, and select a falsifiable fixture candidate. | Full merged `yarn qa` `20260925t105949-a05211` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The bounded fake times out in writer-wait and then succeeds after release; this does not establish the cause of the two retained Content 503s. A stopped-state clone of a command-seeded baseline is the next 100-Work experiment; compatible cloning and the 10,000-Work profile remain open. |
| B10 | Falsify a stopped-state clone on a 100-Work command-seeded source: copy all owner/index volumes and immutable objects into a separate QA project, validate compatibility and a fresh ten-Work admitted cohort, and diagnose live Main/Realm/Content retry exhaustion without relaxing query budgets. | Full merged `yarn qa` `20260925t113601-8a29bc` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. `load-20260925t112243-a396dc` had five Main/Realm movement failures and `load-20260925t112646-7977c5` had one Content movement failure. Coherent later metadata cuts removed those specific unnecessary retries; `load-20260925t113037-83d446` passed 129 reads/22 writes with no failures. `clone-image-b` passed cold cases, receipts, exact Content bytes, a fresh ten-Work cohort and restart; the source remained isolated. Short passes do not qualify 10,000 Works. |
| B11 | Turn the verified stopped-state clone into a reusable load fixture: prepare a command-created background with expired baseline grants and retained manifest, clone it into an isolated run, create a small fresh writable cohort, then exercise exact cold/mixed/restart checks against the combined corpus. | Full merged `yarn qa` `20260925t115249-d6903a` passed all seven tiers. Source `load-20260925t120124-ff88f9` prepared 90 Works with 368 sealed admissions; clone `load-20260925t120333-daae78` passed 129 reads, 23 writes, zero errors and 104 retained units after restart. Source `load-20260925t120450-1ecb71` prepared 990 Works with 3,968 sealed admissions; clone `load-20260925t121817-08beab` passed 136 reads, 28 writes, zero errors and 1,004 retained units after restart. Both sources had seven exact cases after baseline grant expiry, zero relay lag and a stopped, hashed owner/index manifest. This remains diagnostic below 10,000 Works. |
| B12 | Qualify the 10,000-Work host profile from a command-created 9,900-Work stopped baseline and a fresh 100-Work writable cohort, retaining exact owner/index identity and full 180-second mixed thresholds. | Passed on clean `2f9a0ed`: source `load-20260925t122019-660a32` retained 9,900 Works, 39,608 sealed admissions, exact cold cases after grant expiry, zero relay lag and a hashed stopped owner/index manifest. Compatible-source clone `load-20260925t160348-90e989` verified the same schema/model/analyzer digest and Fuseki image ID, created 100 fresh admitted Works, then passed 2,376 reads and 394 writes in 180 seconds with zero HTTP or writer errors, 15.39 total requests/s, read p95 154 ms and Content p95 316 ms. Relay lag was zero; sampled exact heads/receipts and cold/warm public cases passed after a storage restart; 10,004 MatchUnits remained. The run recorded a stable source and reset its volumes. An earlier clone had one Content 503 after three native index movements; the bounded retry repair passed merged QA before this profile. Podman required an explicit `DOCKER_HOST` after Docker Desktop also became available; cross-engine source selection remains an installation/recovery issue. |
| B13 | Complete the first WORK04 graph-loss recovery boundary: replay an admitted exact Work derivation from retained relay and Access evidence into the held graph, reject changed/missing evidence, preserve the relation and receipt identity, and verify idempotent duplicate replay. Owners are Main's native derivation/recovery modules, relay, the model profile and fault/recovery tests. | Integrated into `main` at `2f9a0ed`; full merged `yarn qa` `20260925t151147-02d115` passed all seven tiers, including 14 recovery cases in 351 seconds, with 11 passed IDs, 35 partial and 231 uncovered. The single-snapshot relay repair passed real WORK04/WORK02 restore and a concurrent PostgreSQL mutation case; a 1,001-position engine test caught and verified numeric relay ordering, and a 12-event Content owner test caught the corresponding outbox ordering bug. The same batch included B12's bounded search-race repair and explicit compatible-source load option with focused tests. |
| B14 | Establish WORK05's first fixed release owner path for an eligible native text selection. A separate release identity must pin an exact Main Version revision, selection, publication decision, selected draft and verified bytes under a complete bounded manifest; later Work metadata edits and default changes must not alter that release. Add admitted seal and exact read APIs with denied, stale, concurrent, idempotent, damaged-byte and restart tests, plus a derived cost contract. Owners are Main release commands/history, Access admission, generated model profile and the integration/recovery tiers. | The first path is implemented: cmd0.5.18 native binding commits one release anchor, receipt and typed relay event; `POST/GET /v1/fixed-releases` pass denied, stale, same-key concurrent convergence, replay, changed-intent conflict, current Work disclosure, retained body after metadata/default changes, service restart and damaged manifest checks. Real API run `20260925t165922-31315b` also held result/body fixed across one and nine unrelated Works and observed equal graph call counts under a working read budget. Model tier `20260925t165108-1bd395`, isolated graph-loss replay `20260925t170009-d283fb` and `yarn check:backend` passed. Replay rejects changed Access intent and missing/changed relay evidence, then retains original identity and exact bytes. These selected passes do not declare full WORK05. Physical graph costs, recovery throughput, multi-member composition, metadata claims, availability and package resolution remain open in B15+; WORK05 stays partial. |
| B15 | Start the typed Content owner pilot without splitting DDL ownership: exact-pinned Drizzle over the existing `pg` transaction for owner position, receipts and outbox; discover the existing numbered SQL migrations rather than branching per version. Prove empty install, v3 upgrade, trigger retention, CAS, forced outbox rollback, JSONB and bigint above 2⁵³. | Selected real PostgreSQL integration `20260925t170904-8a5086` passed. Broader Content table typing, Drizzle Kit baseline adoption, all-owner schema design and reusable full fixture remain open. This infrastructure slice qualifies no full acceptance ID. |
| B16 | Make stopped-state fixture compatibility depend on storage/model inputs rather than application runner code, then provide a root restore command with a 600-second end-to-end deadline and minimal owner/index readiness. Verify it against an isolated retained source and a writable clone; preserve provenance and separate full-corpus certification from routine setup. | `85c23f8` added the facade, storage-only compatibility with legacy manifests, and unit coverage; `9f15aac` fixed Docker daemon selection after a failed source attempt, with unit and backend static checks passing. One-time current-image source `load-20260925t171808-58c1f9` prepared ten Works. `fixture-b16-first` restored in 10.361 seconds with four owner DBs and Fuseki ready; `load:clone-probe` then sealed ten fresh Works, retained old receipts/exact Content, and passed restart. The original stopped source's read-only probe retained graph sequence 51 versus clone sequence 102 after writes. The complete all-owner M01–M10 fixture remains open. |
| B17 | Map every retained backend acceptance ID to a concrete owner API operation, using existing routes where present and explicit planned operations for gaps. Check that the map has exactly the frozen 276 IDs with no duplicate or frontend-only entry; identify the next owner schema/operation dependency from it. | The [operation map](backend-operations.md) assigns all 276 backend IDs once; the unit gate compares it with the frozen inventory and verifies every existing Main method/path against generated OpenAPI. It corrected the Realm selection write to `POST /v1/publication-selections`. `yarn test tests/qa/unit/backend-operation-map.test.ts` and `yarn check:backend` passed. Planned paths are targets, not implemented behavior; IAM05 group/role impact approval is the next owner schema/operation gap. |
| B18 | Expose the existing Access-owner same-scope work.create group profile through admitted API operations for bounded current-state read, create, empty reparent, member/grant add and revocation. Use Account-scoped caller proof, Access permission/assignment ceiling, current recovery gate, typed denied/stale/unavailable outcomes, and bounded owner work. Reject populated reparent and other impact-changing operations until the independent approval schema is delivered. Cover real denied, stale, concurrent, replay/read, grant lifetime and selected-proof invalidation. | The real OAuth/Main/Access journey `20260925t174136-90d043` passed alongside the existing acting-context fixture: an authorized bounded state read, CAS winner, replay across app instances and after grant expiry, changed-intent conflict, grant lifetime ceiling, selected-proof invalidation, populated reparent denial, immutable receipt and over-cap refusal. Generated OpenAPI and backend static checks passed. IAM05/IAM36 remain partial; no independent impact approval or general role/grant administration exists. |
| B19 | Add an Access-owned populated-reparent proposal with bounded potential grant/member impact, then require a distinct current approver and its own work.create approval ceiling for atomic approve-and-activate. Bind preview to exact scope/object generations, fail stale proposals, retain immutable activation identity and prove no self-approval or partial activation through real OAuth/Main/Access. Owners are Access SQL and group transactions, Account scope, Main API/OpenAPI and IAM05/IAM30 owner tests. | Selected real Account/Main/Access integration `20260925t175421-c312b7` passed stale proposal, distinct principal and issuer, separate approval ceiling, key conflict/replay, atomic topology activation, current selected descendant grant and immutable activation receipt. The proposal exposes bounded potential impact and stale/activated status; the generated OpenAPI marks all group routes private and write keys required. General role/representation impact and physical cost remain open; IAM05/IAM30 stay partial. |
| B20 | Add an Access-owner institutional `work.create` Agent grant create/revoke/read API. Separate issuer subject from actual principal, require current Account scope, exact issuer representation and an explicit assignment ceiling through the grant lifetime. Bind scope/object generations and principal/key receipts, advance the authority fence on mutation, and prove a grant survives issuing operator departure but not recipient-path loss. Owners are Access SQL and grant transactions, Account scope, Main API/OpenAPI and IAM13/IAM14 owner tests. | Selected real OAuth/Main/Access integration `20260925t180337-25c0aa` passed denied and over-lifetime assignments, exact replay/conflict, concurrent CAS, 50/51 keyset read, operator departure, new representative issuing as the same recipient Agent, and revocation of selected use. Generated OpenAPI and backend static checks are the batch gate. IAM13/IAM14 remain partial; general roles, mandate creation, dependent grant lifecycle and physical cost remain open. |
| B21 | Admit an ordinary `work.create` representation through a recipient-authenticated, purpose-bound request handle and a manager's exact mandate/assignment ceiling. Accept and revoke under the Access scope fence with principal/key receipts and object generations. Expose only the request/representation handle through Main APIs, retain recipient consent and private Account identity in Access, and test real Account OAuth, current selected Agent and command admission. | Selected real OAuth/Main/Access integration `20260925t181322-6dc851` passed private principal creation from a verified request, purpose-bound handle read, missing and short assignment ceiling denial, exact replay/conflict, selected context and registered command proof, revocation, and a fresh mandate that cannot revive the old claim. Generated OpenAPI and backend static checks are the batch gate. IAM25/IAM26/IAM33 remain partial; protected and composed representation and physical cost remain open. |
| B22 | Introduce immutable same-scope Agent role revisions and bindings pinned to a revision, with the first permission family `work.create`. Role creation/revision and binding activation require separate manager/binder authority and current assignment ceilings. Add an actual represented Work admission proof path for a selected binding; show that a new role revision does not change old bindings or saved admissions. Provide bounded read/write APIs, current discovery, stale/CAS/replay/revoke tests and derived costs. | The real Account/Main/Access selected integration `20260925t182755-e1c783` passed empty revision/binding denial, assignment ceiling, immutable revision append, pinned old binding, new selected admission proof, later revision stability, saved claim invalidation on revocation, exact replay/conflict, stale head, concurrent epoch CAS, bounded current reads and immutable receipts. The operation-map unit and `yarn check:backend` passed. First `work.create` roles are callable; general permissions, protected role approval and physical path costs remain open. IAM05/IAM30/IAM33 stay partial. |
| B23 | Reconcile RATE04's existing exact-head withdrawal operation with the backend operation map and register a real owner fixture that proves current aggregation never resurrects an older opinion after withdrawal while retaining exact immutable history. Use an API consumer and declare complete-case coverage only for that narrow retained scenario. | The planned withdrawal route was redundant: `POST /v1/rating-observations` already writes a `value: null` revision. The registered real Fuseki/Main fixture `20260925t183302-fd4807` passed two-rater correction, withdrawal, immutable prior revisions, current aggregate and restoration. RATE04 is declared for full-run coverage; the selected run still reports it partial. Other rating cadence, context and event-time cases remain open. |
| B24 | Qualify CTX02 through the existing Main resolution operation and the registered real owner fixture: inherited Global acceptance, a Realm-local rejection with its own exact decision, Global independence and another Realm's isolation. Declare complete-case coverage only for this retained scenario. | The two-Realm integration `20260925t183629-db4f16` passed explicit `POST /v1/classification-resolutions` before and after local rejection alongside the joined search checks. CTX02 is declared for full-run coverage; the selected run still reports it partial. CTX03 unavailable-local behavior and rule/vocabulary changes remain open. |
| B25 | Add the first Main-owned `work` namespace address claim and public resolution API. Bind one normalized slug to one current metadata Work, preserve a separate route identity and immutable receipt, require an Account assertion and current Access `address.claim` grant, deny absent targets at resolution, and prove one winner under concurrent claims without retargeting. | The real Account/Access/Main/Fuseki integration `20260925t190251-2f11d0` passed denied claim, normalized claim/replay, changed-key conflict, public resolution, concurrent one-winner claim and relay handoff. The backend model tier `20260925t190442-72cd3e`, `yarn check:backend`, and documentation checks passed. VIEW01 has a complete-case declaration for the final run; selected evidence still reports it partial. Rename, merge, retire, reverse links, private-target disclosure and exact historical route selection remain open. |
| B26 | Before address lifecycle, enforce at most one current `work` address per Work so reverse canonical resolution has a unique target. Preserve the old claim receipt and add an explicit conflict reason for a second slug. Derive a fixed-call and indexed-access cost contract for the claim and public read, with an affected real-owner counterexample. | The selected real owner integration `20260925t191155-13a371` passed a same-Work two-slug race, normalized namespace collision, stable prior receipt and adapter call ceilings; the contract records the conditional indexed-work bound and missing physical counters. VIEW01 is still partial pending full QA; VIEW02 remains open. |
| B27 | Add an admitted, exact-head Work address rename. Retain the old binding and target identity, mint one new current binding, and resolve old slugs directly to the Work's current canonical slug with no redirect chain. Add reverse canonical lookup and exact revision read that never follows the current head. Use an immutable lifecycle revision, receipt and outbox event; qualify denied, stale, replay, concurrent rename and bounded read paths. | The real Account/Access/Main/Fuseki integration `20260925t192406-292569` passed denied, stale, normalized replay, competing renames, direct redirects after two renames, reverse/exact reads, outbox relay and adapter call bounds. The backend model tier `20260925t192334-24062c` and `yarn check:backend` passed. VIEW02 remains partial until merge/retire and full qualification. |
| B28 | Add admitted address merge and retire dispositions at an exact route head. Keep the source binding's original Work identity, point a merge to one current canonical target Work, and leave a retired slug unavailable. Preserve immutable revisions/receipts/events and bounded current, reverse and exact reads; qualify denied, stale, competing, replay and outbox behavior. | The real owner integration `20260925t193537-c024de` passed direct merge/retire, denied, stale, replay, competing dispositions, exact reads and both relay events. The backend model tier `20260925t193558-6ff268` passed. VIEW02 remains partial: a later merge of the target Work can strand an earlier merged or renamed alias. |
| B29 | Make merged and renamed aliases resolve through subsequent target merges within an explicit fixed bound, retaining the original route identity and exact history. Qualify a two-step chain, deeper bounded growth, cycle rejection and error behavior; do not count a long valid chain as an exact missing route. | The real Account/Access/Main/Fuseki integration `20260925t194716-8eaaa2` passed three merge hops, an intervening rename, terminal retirement, a cycle-forming write denial and exact original revision. Unit checks passed the 32nd hop, overflow, a cycle and a missing target. Overflow returns 503. VIEW02 has a complete-case declaration for the final full run; a larger route index and physical plan remain open. |
| B30 | Qualify CTX03 against a real local Realm rejection above Global acceptance. At the Main graph-read boundary, inject an incomplete local decision and a failed read; assert both resolution and public classified search fail closed without returning a Global fallback or private decision details. | The selected real owner integration `20260925t194147-c1de17` passed both fault modes on both API routes after a real local decision. CTX03 has a complete-case declaration for the final run; the selected result remains partial. Total loss of all local application triples is outside this fault model. |
| B31 | Reconcile WORK05's first fixed native text release with its exact retained scenario. Re-run the real authenticated API journey that corrects metadata and changes the default after sealing, plus the isolated graph-loss replay that checks retained identity and bytes; declare complete-case coverage only for this case. | Selected integration `20260925t195015-cc40f7` and fault/recovery `20260925t195040-50e39d` passed. WORK05 is declared for the final full run; selected passes remain partial. Broader composition and cross-owner release pins stay open. |
| B32 | Qualify IAM10 on the existing authenticated Work API journey with real Account bearer and Access owner. Simulate each owner becoming unavailable through its actual connection boundary, assert a typed 503 and prove neither attempt advances the graph. | The selected real integration `20260925t195424-739f4a` passed both owner faults and unchanged graph position. IAM10 is declared for the final full run; selected evidence remains partial. |
| B33 | Add a bounded multi-type Work creation profile with two reviewed schema.org types. Bind the set to the admitted create digest, current RDF type triples and exact immutable Work manifest; retain it across metadata edits and graph recovery. Qualify API syntax, exact reads, denied edit authority and real owner behavior. This is a partial MODEL01/MODEL08 slice until general semantic changes are implemented. | Selected real-owner integration `20260925t200223-bfeed7` and graph-loss recovery `20260925t200335-f56474` passed canonical set replay, unsupported type rejection, exact reads, Access denial, retained types after title edit and restored triples. MODEL01/MODEL08 remain partial; general semantic changes and arbitrary Resource types are open. |
| B34 | Add the first private manual source intake boundary: immutable provider/namespace/external identity, distinct exact observations, bounded retained bytes, explicit coverage and rights evidence, idempotent receipts and a private exact read. Keep intake staged, separate from native adoption and acquisition. Exercise the PostgreSQL owner and API denial/replay paths. Partial LIVE01/LIVE02/LIVE13/LIVE16 only. | Selected real PostgreSQL/Main API integration `20260925t201457-5c3dc9` passed replay/conflict, private reads, distinct source grains, exact/non-retained bytes, 64 KiB bounds and immutable rows; `yarn check:backend` passed. Account verification is isolated in this fixture. Acquisition, adoption, native source graph, physical SQL-plan evidence and real OAuth scopes remain open, so none of these IDs is declared complete. |
| B35 | Acquire a single Open Library Work JSON record through a fixed-origin, bounded fetch, preserving exact bytes, HTTP metadata and source revision as a private staged observation. Qualify malformed, partial, failed, oversized, redirect, replay and changed-key behavior without marking native adoption complete. Partial LIVE01/LIVE02/LIVE09/LIVE11. | Selected real PostgreSQL/Main API integration `20260925t202231-12cd41`, Open Library parser unit tests and `yarn check:backend` passed. A malformed response left no receipt; replay made no second fetch; redirected, missing, malformed and oversized bodies failed. Account and provider transport are isolated in this fixture; live current-provider capture and native adoption remain open. No LIVE ID is declared complete. |
| B36 | Convert a retained Open Library Work observation into a private immutable structured source projection. Enumerate every top-level field with an explicit disposition, keep text facts and author/subject references source-qualified, and reject incomplete/wrong-grain captures. Qualify conversion replay and private reads against PostgreSQL; do not adopt native Work identity or rights. Partial LIVE01/LIVE02/LIVE07/LIVE13. | Selected PostgreSQL/Main API integration `20260925t202910-3a3b46`, unit cases and `yarn check:backend` passed private conversion, replay, unknown-field retention, incomplete/wrong-grain rejection and no native Work write. One current live Open Library Work capture and conversion enumerated 16 fields; raw evidence is retained under `.artifacts/source-live/`. No LIVE ID is declared complete. |
| B37 | Admit `source:intake`, `source:acquire`, `source:convert` and `source:read` at Account's Main resource, then exercise a real Account OAuth bearer and Access active-principal fence through manual intake, fixed-origin acquisition, conversion and private reads. Qualify missing-scope and deactivated-principal denial before source mutation. Partial IAM10/LIVE owner-boundary coverage. | Selected real Account/Access/Main/PostgreSQL integration `20260925t203408-408374` and `yarn check:backend` passed. Read-only OAuth denied all three source writes before fetch or persistence; the full bearer completed intake, acquisition and conversion; deactivation blocked a later write and read. The provider transport is isolated and native adoption remains open. |
| B38 | Compare two complete retained Open Library Work conversions of one SourceRecord through the private API. Verify each conversion against its immutable observation, report added/removed/changed/unchanged field statuses and dispositions, and flag exact-byte changes separately. Refuse cross-record/unauthorized comparison and make no native mutation. Partial LIVE01/LIVE02/LIVE09 only. | Selected real PostgreSQL/Main API integration `20260925t204259-e88f47` and `yarn check:backend` passed. It covered field changes, formatting-only bytes, private/cross-record denial and bounded-depth failure. No LIVE ID is declared complete; live version sets, source graph, reconciliation and native adoption remain open. |
| B39 | Project one immutable private Open Library Work conversion into a separate validated source graph through the native Jena command gate. Bind its source identity, observation, digest, source title and expression to a deterministic receipt, preserve source-only status and private read authority, and qualify replay, denial and command-family rejection. Full restore/reprojection is a later fault batch. No native Work adoption. Partial LIVE01/LIVE02/LIVE07. | Selected real PostgreSQL/Main/Fuseki integration `20260925t210746-1c1306` passed replay, private denial, invalid command/profile/shape rollback and typed source outbox envelope; native command model tier `20260925t205851-16577a`, model generation unit cases and backend static checks passed. The three selected source integration files shared one QA stack and passed together after principal-scoped denial assertions. Current provider versions, graph restore/reprojection, real OAuth for the projection route and native adoption remain open; no LIVE ID is complete. |
| B40 | Record a private immutable new-native-Work proposal from a verified Open Library source graph conversion. Freeze the source identities, digest, graph receipt position, candidate title and rights evidence; leave expression, author references and terms source-only. Add a distinct `source:propose` OAuth scope and qualify replay, private reads, missing graph and deactivated-principal denial through real owners. The proposal grants no Work creation authority. Partial LIVE01/LIVE13. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t211637-dc4824` passed scope denial, missing graph, replay, private/inactive-principal reads, immutable row and overlong-title rejection; backend static and documentation checks passed. No native Work was created, and no LIVE ID is complete. |
| B41 | Admit one title-only, English-language native Work creation from a private source proposal under real `work:create` Access authority and a distinct `source:adopt` bearer scope. Reserve one source adoption intent with a server-generated Work idempotency key before dispatch, then bind the Work receipt immutably to the proposal. Qualify denied, concurrent, replay and post-graph persistence recovery without adopting description, authors, subjects or rights. Partial LIVE01/LIVE13. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t212731-69c4bd` passed scope/grant denial, subsequent grant, post-graph binding failure and same-Work recovery, concurrent same-proposal creation, private read, replay and deactivation. Backend static checks passed. Human edit-control, non-English titles, rights and source-support triples remain open; no LIVE ID is complete. |
| B42 | Replay a retained private source projection into an isolated held graph restore using the original relay event and immutable PostgreSQL source evidence. Require the exact source receipt/digest, coverage, source shape and ordered recovery cursor; reject changed or missing evidence, then prove private read and idempotent replay. This closes the source-event restore gap without changing native adoption. Partial OPS03/LIVE01/LIVE02. | Selected isolated fault/recovery `20260925t213510-a73d87` passed the held restore, original receipt/position/outbox and private read, duplicate replay and open-fence/altered-relay/missing-Content rejection. Backend static checks passed. Combined adoption restore and full mixed-owner backup remain open; no ID is complete. |
| B43 | Qualify a two-event source-to-native restore: the retained source projection followed by an Access-admitted title-only Work create. Replay each against its exact source and native owners under the held restore, then verify the immutable private binding resolves to the same Work receipt. Refuse missing source evidence and mismatched adoption proof. Partial OPS03/LIVE01/LIVE13. | Selected isolated fault/recovery `20260925t213841-0592bc` passed the ordered source and Work replay, exact private binding, idempotence and changed-proof refusal; backend static checks passed. It does not prove a complete mixed-owner backup frontier, and no ID is complete. |
| B44 | Add a private Work-to-source support read for the title-only adoption. Resolve the immutable proposal/binding and Work receipt from the native Work ID, report the exact applied revision and current head, and verify that a later same-value human edit changes the head without changing the source evidence. Scope the reverse lookup to the active source principal. Partial LIVE01/LIVE03/LIVE13. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t214357-2e33e2` passed exact reverse provenance, same-value Work head change, other-principal 404 and inactive-principal denial; backend static checks passed. Source refresh/edit-control and later rights actions remain open; no ID is complete. |
| B45 | Assess a later verified source proposal against the title-only native Work binding without changing native state. Require the same SourceRecord and private principal, report source title change and the Work head relative to its adoption revision, and show that a same-value human edit changes the head assessment. Reject cross-record and other-principal candidates. Partial LIVE01/LIVE03. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t214830-f0b604` passed changed-source and changed-head assessment, cross-record 409, other-principal 404 and inactive denial; backend static checks passed. No source-controlled Work edit was dispatched, and no ID is complete. |
| B46 | Apply one later same-epoch, same-SourceRecord title proposal to a source-controlled native Work head through the existing Access-admitted Work edit CAS. Retain an immutable source intent and exact native receipt binding, recover after a post-graph binding fault, and reject changed or same-value human heads. Partial LIVE01/LIVE03/LIVE13. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t215604-5790ff` passed missing-scope/grant denial, post-graph PostgreSQL binding fault and same-receipt retry, private read, same-value human-head refusal and cross-record conflict. Backend static checks passed. Concurrent human/source dispatch and full field-control remain open; no ID is complete. |
| B47 | Race an Access-admitted same-value human Work edit with a source title application at the exact same native head. Require one CAS winner, settle a stale or pending loser from its idempotency key, and prove that human confirmation at the final head blocks a later distinct source proposal. Partial LIVE01/LIVE03. | Selected real Account/Access/Main/PostgreSQL/Jena integration `20260925t215833-95465f` passed one-CAS-winner, stale loser, human final head and later-source conflict; backend static checks passed. Full field-control and all interleavings remain open; no ID is complete. |
| B48 | Compare author and subject child occurrences across two complete verified conversions of one SourceRecord. Preserve observation-qualified position, match unique stable keys through reorder, report repeated-key ambiguity, and refuse missing/unmapped lists as deletion evidence. Partial LIVE04/LIVE01. | Selected real PostgreSQL/Main API integration `20260925t220311-cba7bb` passed unique-key reorder matching, repeated-key ambiguity, missing-list unavailable, private denial and cross-record rejection. Backend static checks passed. Durable child mapping and native adoption remain open; no ID is complete. |
| B49 | Record an explicit one-to-one source-only correspondence for ambiguous same-key child occurrences from two verified complete conversions of one SourceRecord. Use a private source:correspond scope, immutable PostgreSQL decision, idempotent key, conflict constraints and evidence-verified exact read. Partial LIVE04. | Selected PostgreSQL/Main API integration `20260925t220828-d5741a` passed ambiguous-pair recording, exact private read, idempotent replay, key and both-side uniqueness conflict, immutable row and cross-record rejection; backend static checks passed. Account verifier was isolated, and native child adoption remains open; no ID is complete. |
| B50 | Qualify source:correspond against real Account OAuth and active Access principal, using verified repeated child occurrences through Main and PostgreSQL. A read-only token cannot write, a correspondence-only token can record but cannot read, another principal cannot read, and deactivation blocks both. Partial IAM10/LIVE04. | Selected real Account/Access/Main/PostgreSQL integration `20260925t221015-f1bb1c` passed separate write/read scopes, active-principal fence, other-principal 404 and deactivation denial; backend static checks passed. Native child adoption remains open; no ID is complete. |
| B51 | Add a first immutable private package resolution for a bounded, caller-supplied Go 1.16 unpruned module snapshot with stable release tags. Traverse required module manifests by MVS, select per-path maximum requirements rather than latest available, preserve major paths, distinguish missing manifests from solved, and report declared unsupported clauses/budgets explicitly. Partial PKG05/PKG13. | Selected unit and real PostgreSQL/Main API integration `20260925t221834-907295` passed MVS selection, missing/unsupported/budget statuses, private immutable idempotent resolution and denial cases; backend static checks passed. The Account verifier was isolated and no native Go/live provider was used; no ID is complete. |
| B52 | Qualify package:resolve and package:read against real Account authorization-code tokens, Main and active Access principal for the first Go MVS snapshot. Read-only and write-only tokens stay separate, another principal cannot read, and deactivation blocks both. Partial IAM10/PKG05/PKG13. | Selected real Account/Access/Main/PostgreSQL integration `20260925t222044-4cf935` passed separated OAuth scopes, private read and active-principal fence; backend static checks passed. Native Go comparison and complete package semantics remain open; no ID is complete. |
| B53 | Pin official Go 1.27.1 and compare B51's `go 1.16` unpruned snapshot against `go list -mod=mod -m all` with a generated local file proxy. Preserve the lower visited version dependency, selected higher version, major path and unrequired newer release distinction. Partial PKG05/PKG12. | `yarn package:go-oracle` matched all six selected modules exactly with a SHA-256 verified official archive and no module network; `.temp/package-go-oracle/result.json` retains the local output. Live provider capture, replace/exclude/retract, checksum provenance and general native coverage remain open; no ID is complete. |
| B54 | Extend the immutable Go snapshot with a v2 main-directive profile for exact-version exclusion and version-specific same-path or fork replacement. Preserve original build-list identity and report selected replacement sources; reject missing or inconsistent source manifests and collisions. Compare both directed graphs with pinned native Go and qualify private real-owner API persistence. Partial PKG05/PKG12. | Selected unit (4 pass), three-scenario pinned native oracle and real PostgreSQL/Main API integration `20260925t223203-ccb975` passed; backend static checks passed. Retraction, wildcard/local replacement, live provider capture and checksum provenance remain open; no ID is complete. |
| B55 | Record bounded retraction declarations in the supplied latest Go release manifests and advise when an exactly required retracted version remains selected. Match native `go list -m -u -json` retraction metadata; preserve the immutable build list and exact private read. Partial PKG05/PKG12. | Selected unit (5 pass), four-scenario pinned native oracle and real PostgreSQL/Main API integration `20260925t223547-4c696f` passed; backend static checks passed. Live provider latest-version capture and checksum authenticity remain open; no ID is complete. |
| B56 | Capture one stable tagged Go module release directly from the fixed official module proxy. Bound list/info/manifest bytes and time, retain raw immutable evidence/digests, expose private idempotent capture/read under separate Account scopes and active Access principal, and prove one live provider observation. Partial PKG05/PKG20/IAM10. | Fixed-origin/bounds unit and real PostgreSQL/Main API integration `20260925t224146-39f3c5` passed; live `yarn package:go-probe` captured `golang.org/x/sync@v0.1.0` at 2026-09-25 22:42 UTC with 23 stable tags and exact raw digests under `.temp/package-go-provider/`. Real Account scope, manifest parsing and Go checksum verification remain open; no ID is complete. |
| B57 | Qualify `package:capture` against real Account authorization-code scopes, active Access principal, Main and PostgreSQL with a deterministic proxy response. Prove read-only token sends no fetch, capture-only token cannot read, another principal cannot read, and deactivation blocks both. Partial IAM10/PKG05/PKG20. | Selected real Account/Access/Main/PostgreSQL integration `20260925t224359-6036a4` passed the scope, provider-call, private-read and deactivation fences; backend static checks passed. Parser and checksum provenance remain open; no ID is complete. |
| B58 | Add a conservative parsed requirement view to immutable Go proxy captures. Admit simple module/go/require grammar, refuse unsupported syntax without partial requirements, require explicit `go 1.16` for compatibility, compare a fixture with pinned native `go mod edit -json`, and read the live provider manifest. Partial PKG05/PKG13. | Selected unit, native parser oracle, real PostgreSQL/Main API integration `20260925t224700-d2703f` and backend static checks passed. Live `golang.org/x/sync@v0.1.0` had no `go` directive and was marked incompatible with the first resolver profile. Provider-derived MVS and checksum proof remain open; no ID is complete. |
| B59 | Resolve a bounded Go 1.16 graph from exact private provider capture IDs. Derive requirements from retained manifest bytes under the same active principal, bind capture IDs and raw digests in the immutable resolution, and distinguish complete closure, missing required capture and unsupported parser/directive outcomes. Partial PKG05/PKG12/PKG13. | Selected real PostgreSQL/Main API integration `20260925t225211-037dc3` passed closed A→B graph, missing B, incompatible directive, cross-principal capture denial, exact private read, changed-key conflict and replay; backend static checks passed. Go checksum-database proof and broader Go syntax remain open; no ID is complete. |
| B60 | Qualify capture-derived resolution with real Account authorization-code tokens, Access principal, Main and PostgreSQL. Keep `package:capture` and `package:resolve` separate, deny cross-principal capture use, preserve unsupported Go directive outcome, and fence deactivation. Partial IAM10/PKG05/PKG13. | Selected real Account/Access/Main/PostgreSQL integration `20260925t225337-7e36da` passed the scope, private capture ownership, unsupported outcome and deactivation fences; backend static checks passed. Go checksum-database proof remains open; no ID is complete. |
| B61 | Calculate Go's single-file `go.mod` `h1:` from retained capture bytes, expose it on exact private reads, and compare a fixed live capture against pinned Go 1.27.1 `GoModSum` with `sum.golang.org` enabled. Partial PKG05/PKG14. | Selected unit, real PostgreSQL/Main API integration `20260925t225611-b2a623`, backend static checks and `yarn package:go-checksum-oracle` passed; the live `golang.org/x/sync@v0.1.0` h1 matched Go's verified GoModSum. Main still lacks signed sumdb verification; no ID is complete. |
| B62 | Accept a retained caller main-module `go.mod` with private capture IDs, derive its module identity and direct requirements from bounded exact bytes, store its text and SHA-256 in the immutable v3 request, and refuse unsupported syntax before yielding a build list. Partial PKG05/PKG12/PKG13. | Selected real PostgreSQL/Main API integration `20260925t230359-2d9c7b` passed closed graph, private capture ownership/read, exact main bytes, malformed base64, unsupported main directive, incompatible Go directive, replay and changed-key conflict; backend static and documentation checks passed. A fresh-cache native metadata-only probe retrieved `.mod` without a module archive but returned no checksum fields. Signed sumdb verification remains open; no ID is complete. |
| B63 | Verify the official Go checksum database's signed tree note with the pinned public verifier key, reject tampered or malformed notes, and compare a fixed lookup note observed by pinned native Go. This is a prerequisite for record inclusion and consistent trust-state updates, not an API provenance claim. Partial PKG05/PKG14. | Selected unit, `yarn package:go-checksum-oracle`, backend static and documentation checks passed against a fixed real Go 1.27.1 lookup note. Main still has no record inclusion proof or monotonic trust state; no ID is complete. |
| B64 | Verify a checksum record's RFC 6962 Merkle inclusion from a bounded proof against a signed tree head, including uneven trees, changed records/hashes and exact proof consumption. This is the proof primitive before bounded Go tile retrieval. Partial PKG05/PKG14. | Selected unit passed every leaf of nine balanced/uneven tree sizes and changed record/hash, missing/extra hash, wrong index/root refusals; backend static and documentation checks passed. No live tile proof or monotonic trust state exists, so no ID is complete. |
| B65 | Fetch a fixed Go checksum lookup and bounded tree tiles, derive the RFC 6962 audit path, verify record inclusion under the signed head, and compare its `/go.mod` h1 to exact capture bytes. Prove a live fixed module and refusal cases; do not expose verified provenance until monotonic trust state exists. Partial PKG05/PKG14. | `yarn package:go-checksum-oracle` verified a fixed live `golang.org/x/sync@v0.1.0` record under its signed 65,209,736-record tree with seven bounded tiles; selected unit passed a synthetic cross-tile 300-record tree and redirect/oversize/mismatched-h1 refusals. Backend static and documentation checks passed. Monotonic trust state remains open; no ID is complete. |
| B66 | Check that a later signed Go checksum tree contains the exact earlier signed prefix, rebuilding both roots from the later tree's bounded hash tiles. Reject equal-size forks, rollback, prefix divergence and false later roots; compare the native lookup tree with a fresh signed `/latest` head. Partial PKG05/PKG14. | Selected unit, live `yarn package:go-checksum-oracle`, backend static and documentation checks passed: the 65,209,736-record lookup tree extended consistently to a 65,215,452-record latest head using five tiles. Durable monotonic state remains open; no ID is complete. |
| B67 | Persist a Go checksum trust checkpoint and immutable capture-bound inclusion receipt in PostgreSQL. Revalidate the signed note, exact captured h1 and offline audit path, advance the checkpoint only after a consistent signed tree, and preserve idempotent private exact reads. Partial PKG05/PKG14. | Selected real PostgreSQL owner integration `20260925t232455-b764c5` passed baseline/advance, exact offline read, replay, private denial, inconsistent candidate, key conflict, mutation guards and same-key race; backend static and documentation checks passed. The owner fixture injected consistency while independent live/fixture tests exercise the real checker. API authority and cross-restore rollback protection remain open; no ID is complete. |
| B68 | Expose private Go checksum verification and exact receipt read through Main with distinct `package:verify` and `package:read` scopes, active Access principals, idempotency, generated schema and authenticated denial paths. Partial PKG05/PKG14/IAM10. | Selected real Access/Main/PostgreSQL API integration `20260925t232828-32bfc4` passed separated scopes with isolated Account verifier, other-principal denial, private exact read, replay without lookup, changed-key conflict and deactivation. OpenAPI generation, operation-map unit, backend static and documentation checks passed; a pre-existing source route placeholder mismatch was corrected in the map. Real Account OAuth and recovery remain open; no ID is complete. |
| B69 | Qualify `package:verify` through real Account authorization-code tokens, active Access principal, Main and PostgreSQL. Deny read/capture-only scopes before sumdb work, keep the receipt private, replay without provider work, and block verification/read after deactivation. Partial IAM10/PKG05/PKG14. | Selected real Account/Access/Main/PostgreSQL integration `20260926t030902-dbecb4` passed scope separation, other-principal denial, private receipt, no-lookup replay and deactivation; backend static and documentation checks passed. The checksum function was injected from retained signed fixtures, while independent live checks qualify the real verifier. Recovery remains open; no ID is complete. |
| B70 | Retain a Go checksum capture, signed head and inclusion receipt across the existing coordinated PostgreSQL physical backup and isolated restore. Revalidate exact offline read and replay from the restored Content owner while the original owner remains fenced. Partial OPS03/PKG14. | Selected fault/recovery run `20260926t031243-858f24` passed exact offline receipt read and no-provider replay after isolated physical restore. Signed mixed-owner coverage still excludes `pkg.*`; OPS03/PKG14 remain partial. |
| B71 | Bind all five package evidence tables into version-two signed Content recovery coverage, require the Content owner in capture and release even without graph references, and reject a mismatched restored package checkpoint before release. Partial OPS03/PKG14. | Selected coordinated owner and Account erasure recovery `20260926t032239-fad04d` passed three partial cases with stable source, including changed-checkpoint refusal and package-only coverage. Backend static and documentation checks passed. An independent witness for complete-backup rollback remains open. |
| B72 | Extend the bounded Go 1.16 main-directive snapshot with path-wide remote replacements and exact-version precedence. Retain exact selected source identity and compare the result with the pinned native Go oracle and private resolution API. Partial PKG05/PKG12. | Six selected unit cases, seven pinned Go 1.27.1 oracle scenarios, real PostgreSQL/Main integration `20260926t033016-ae6a43`, backend static and documentation checks passed. The selected API tier reports partial cases only; local replacements, pruning and authenticated capture provenance remain open. |
| B73 | Admit bounded canonical Go pseudo-versions in the unpruned MVS snapshot and compare their ordering and module-path majors with the pinned native Go toolchain. Carry them through the private resolution schema and capture parser. Partial PKG05/PKG12/PKG13. | Twelve selected unit cases, nine pinned native Go 1.27.1 oracle scenarios, real PostgreSQL/Main resolution `20260926t033758-22bd61`, stable-tag capture `20260926t033835-c14c92`, backend static and documentation checks passed. Pseudo-version source capture, build metadata, pruning and complete PKG05 behavior remain open. |
| B74 | Capture exact Go pseudo-version `.info`/`.mod` from the fixed proxy without inventing version-list membership. Bind an explicit second capture profile and timestamp check to immutable owner rows and propagate source selection evidence into capture-derived resolution. Partial PKG05/PKG14/PKG20. | Ten selected unit cases, capture/checksum-trust integration `20260926t034444-a51524`, coordinated physical restore `20260926t034509-cf6c9e`, backend static and documentation checks passed. The real PostgreSQL/Main response keeps `versionList: null` and an exact pseudo selection marker without a fake list digest. Signed checksum verification for pseudo-version capture remains open. |
| B75 | Compare an exact pseudo-version capture from the official Go toolchain's retained module manifest with Go's verified checksum and a signed `sum.golang.org` record inclusion and tree-consistency proof. Partial PKG05/PKG14/PKG20. | Worker commit `20353a8` was integrated as `c4136cd`. Pinned Go 1.27.1's `rsc.io/markdown` pseudo-version matched exact captured `.mod` and verified Go checksum; signed lookup inclusion and tree consistency passed, including an older `/latest` tree. Merged unit, PostgreSQL integration `20260926t040806-d9f055` and backend static checks passed. All three IDs remain partial. |
| B53+ | Continue remaining M01–M10 backend/API dependencies through stages A–G: persistence, authority, cross-service contracts, source/package workflows and operations. The [backend map](backend-acceptance.md) selects later batches; no required backend behavior is waived. | Pending; no required backend behavior is waived. |
| W1+ | Future web journeys consuming the delivered APIs, with their own frontend/browser acceptance. | Removed from this Goal by the maintainer on 2026-09-26. |

The backend/API exit gate requires every retained M01–M10 backend behavior to have
a working owner interface and passing owner-boundary evidence, with no failing or
uncovered retained backend case in the [backend map](backend-acceptance.md).
It includes storage, authority, cross-service, recovery, path-level complexity
and scoped practical-load checks. Small growth checks and larger host qualification
have distinct claims; the latter is not a prerequisite for unrelated slices.
Run affected backend checks during this stage. Final qualification uses one clean,
complete backend recorded run after fresh construction; it does not wait for W1+
or include frontend. Use the implemented
[backend harness scope](../testing/test-harness.md#backend-only-goal-scope);
the unscoped command still includes web.

Follow the [execution workflow](execution-workflow.md). The user-selected design
supersedes single-database assumptions. Keep implementation and executed
qualification distinct.

## Fast-start milestones

Deliver a small usable path before widening the product surface. These milestones
are dependency order and acceptance requirements, not reports of completed code.

| Milestone | Implement / execute | Exit evidence |
| --- | --- | --- |
| S0 Graph substrate | Pinned Fuseki bundle, Java, one text-wrapped TDB2 dataset and persistent directories; follow [installation](../operations/installation.md). | Insert/read/text-match public fixture, graceful restart, backup and isolated restore; service remains private. |
| S1 Safe command foundation | Minimal Main HTTP adapter, Account verification, PostgreSQL Access, fixed model/shape artifact, guarded graph updates, immutable component revisions and polling outbox. | Same-head race has one winner; lost response reconciles its receipt; denied/invalid writes change nothing; old revision still resolves. |
| S2 First authenticated API journey | Create metadata-only Work/MainVersion, publish one text contribution, assign different classification decisions in two Realms, search the eligible public view, then edit and read the prior revision through real APIs. | Shared Work identity, distinct Realm decisions, exact comments, current authority and graph/text completeness remain correct end to end. |
| S3 Broaden to retained backend/API gates | Add ratings, multilingual relevance, qualified private search, all indexing domains, sources and package flows through stages B–G below. | Owning backend/API capability, integration and operations matrices pass independently of frontend. |

S0 can be followed from this documentation checkout; S1 and later require new
runtime code. S0 does not require a model compiler, Redis, a broker, a cluster,
full-corpus import or a billion-row benchmark. S1 can begin with a pinned authored
profile and generated or packaged validator artifacts; the reusable compiler grows
with admitted profiles rather than blocking the first command behind a universal
metamodel implementation. Public-only text is the first admitted search lane;
private text remains a required capability gated by scoped security qualification.

Fresh installation uses new datasets and explicitly seeded owners. No automatic
Fluree migration or dual-write mode is selected. If retained source data exists,
inventory it, export exact RDF/objects/revisions, convert to the new manifests and
verify identity, disclosure and restore before retiring the old copy. Do not infer
that TDB2 can recover missing historical content from a current-state RDF dump.

## Task reading routes

Start with the active scope above and the [coverage map](../architecture/coverage.md).
These routes select initial context; follow additional owning links when a change
affects their invariants. They do not redefine contracts or waive acceptance cases.

| Slice | Initial owners and realization | Exit evidence owner |
| --- | --- | --- |
| S0 Graph substrate | [Installation](../operations/installation.md), [Jena](../storage/jena.md), [recovery](../operations/recovery.md). | S0 above and [operations cases](../testing/operations.md): graph/text persistence, restart and isolated restore. |
| S1 Safe commands | [Commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md), [Access implementation](../implementation/access-control.md). | [Model](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [integration](../testing/backend-integration.md): admission, validation coverage, same-head races, idempotency, receipts, outbox and retained revisions. |
| S2 Authenticated API journey | [Main Version](../contracts/main-version.md), [Space](../contracts/space.md), [classification](../contracts/classification.md), [search](../contracts/search.md) and [vertical workflows](../implementation/vertical-workflows.md). | [Native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [backend integration](../testing/backend-integration.md): one Work, two Realm decisions, eligible search and exact historical reads through actual APIs. |
| S3 Remaining backend/API capabilities | Select the next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage); use the corresponding [coverage row](../architecture/coverage.md). | Owning [backend](backend-acceptance.md) and operations evidence for every retained API capability, including G1–G4 and G6 at the backend boundary. |
| Full web journeys (outside Goal) | In a separately selected frontend task, load [frontend acceptance](frontend.md) and affected [experience](../experience/README.md) owners. | G5 and browser journeys consume delivered APIs; these do not gate this backend Goal. |

For each batch, keep one short row in the [execution program](#execution-program)
with its scope, acceptance IDs and result, and cite the
[qualification page](qualification.md) for evidence. Resolve the decisions needed
for that batch before expanding speculative design elsewhere. The [external source index](../development/external-sources.md)
supplies upstream lookup routes; supporting evidence stays beside its decision.
For a wording/link-only task, inspect the affected document and consumers without
activating runtime stages or loading all these routes.

## First-stage product and indexing scope

Space (Realm + Zone), contextual classification/ratings and REZICS Main Version
form the first foundation. Books, software, media, recipes, Skills and Prompts
exercise it. Universal package resolution/installation workflows are selected,
with Cargo, npm-family, Go, Nix, Minecraft and mod-provider profiles.

Collections, wikis, discussions, character/background/causal graphs and ordinary
interactions compose these foundations. [Capabilities](../product/capabilities.md)
retains the complete native product coverage. Provider limitations do not erase
native requirements. Full source-corpus indexing and separately operated hosting/
commerce/verification campaigns retain explicit rollout boundaries.

Stage A establishes typed authority composition and scoped institutional
representation. Stage F applies the [voting contract](../contracts/votes-and-references.md)
to institutional entitlements and approved collective decisions. Direct proxies
and explicit allocations are charter-enabled capabilities under that contract;
live proxy rerouting and full liquid delegation require a separate qualified
profile. Numeric Access work limits and 99% legitimate-task coverage remain
qualification targets in the [depth study](../research/access-depth-representation-and-voting.md).

Redis is outside the first release's delivery and acceptance scope. Likes and
favorites must work through Main's TDB2 authority without Redis. Redis deployment,
client integration, cache consumers and Redis-specific recovery/performance tests
belong to a later optimization scope; their absence does not block a first-release
gate. Existing correctness, bounded-query and practical-load obligations remain.

## Dependency order

The [repository organization proposal](../development/repository-structure.md)
defines the workspace layout and bootstrap preparation for these stages. It does
not change the selected owners or mark any runtime gate complete.

| Stage | Complete implementation scope | Exit evidence |
| --- | --- | --- |
| A | Minimal identity/value profile, Fuseki guarded commands, PostgreSQL Content and local receipts/outbox, common immutable history, Context and Account/Access; expand the IR as profiles grow. | Semantics, rejected states, retries, publication preparation and authority fences. |
| B | Space capabilities, concepts/expressions/applications, Realm fallback and rating contexts. | Two-Realms/one-resource journey with conflicting decisions and private data. |
| C | Work/Main Version, content/structure anchors, translations, Post chapters and fixed releases. | Stable common entry, precise history/comments and publication/adoption recovery. |
| D | Graph-integrated full-text/CJK, exact PostgreSQL-body projections and all five native indexing domains. | Joint relation/text/context queries, complete ranking, fixed whole-request bounds and bounded updates/rebuild. |
| E | Live source conversion and universal package profiles, lock/install/update/rollback. | Current-source semantics, native-tool comparisons and interrupted operation recovery. |
| F | Remaining native interactions, governance, communication, export and admitted commercial applications. | Capability coverage and cross-owner workflows. |
| G | Deployment selection, installation, practical load and recovery on available hosts. | Measured bounded behavior, restore and explicitly accepted initial outage model. |

Dependencies permit independent work but do not excuse leaving one stage's required
behavior as a stub. Space/classification comes before treating Book or package
success as the whole product. Large-volume/fleet qualification is a later scale
stage, not a gate blocking this sequence.

## Acceptance gates

The [interaction/cache bootstrap](../implementation/interactions-and-cache.md)
provides a concrete Jena slice and later cache growth. Prior-engine probes are
historical research only; Jena, application, security and capacity gates remain pending.

[Backend scope](backend-acceptance.md) and [frontend acceptance](frontend.md)
detail the integration and experience obligations for these gates.

| Gate | Meaning |
| --- | --- |
| G1 Design | Owners, state transitions, identities, authority, failures and required tests are specified. |
| G2 Persistence | Actual Jena/PostgreSQL/object bindings pass positive, rejected, concurrent and recovery cases. |
| G3 API | Stateful producer-to-consumer HTTP/SDK/MCP flows preserve the same contracts. |
| G4 Integration | Cross-owner source, publication, search, package and revocation journeys pass. |
| G5 Experience | Separate frontend scope: affected deterministic checks and authorized Storybook reviews. Outside the current backend Goal. |
| G6 Operations | Fresh installation, backup restoration and measured practical workload meet elected objectives. |

## Delivery and qualification

The capability table is the scope denominator; this table summarizes program
status by scope. Per-ID results come from the [qualification page](qualification.md);
do not insert narrative evidence here.

| Scope | Design | Runtime qualification |
| --- | --- | --- |
| Shared architecture and selected technology | Jena startup boundary, TypeScript/Elysia 2/Bun, Yarn and vinext/Workers selected; [toolchain lock](../development/toolchain.md) adopted. | S0 passed OPS14 and OPS16. Phase 0 connects the toolchain and harness. Complete S1–S3 and product gates pending. |
| Space, Context, classification and Main Version | Selected first-stage foundation. | Partial scoped checks listed in the [implemented baseline](#implemented-baseline); harness qualification and the web journey pending. |
| Five domains and universal packages | Selected with ecosystem profiles and live validation. | Pending conversion/resolver/install tests. |
| Security, operations and user experience | Specified owner protocols and acceptance. | Pending their respective gates. |

## Documentation verification

On 2026-09-24, the toolchain reconciliation added the [toolchain lock](../development/toolchain.md),
the [executable harness](../testing/test-harness.md), the transactional command
endpoint and the batch cadence. It condensed this plan's evidence narrative into
the implemented baseline. The documentation checks listed in
[development](../development/README.md) passed for it. Versions were checked
against the npm registry, Docker Hub and upstream releases; no runtime was executed.

Earlier on 2026-09-24, goal preparation passed all nine documentation-tool regressions,
local links/fragments/navigation checks for 160 Markdown files and diff whitespace
review. The added regression checks links from the root goal file and navigation
through it. Eight upstream `llms.txt` indexes were fetched as recorded in the
[source index](../development/external-sources.md).

Source-level walkthroughs traced a substantive S1 command change through contract,
storage/authority and acceptance owners, an ordinary wording/link fix through its
local consumers without runtime activation, and continuation after S2 toward the
remaining capabilities. These inspect instruction consistency; no GPT-6 Sol Goal
run or measured agent-effectiveness comparison was performed. Runtime acceptance
remains pending until implementation executes its owning cases.

The preceding source-data reuse review completed documentation integrity and
source/diff review with all eight documentation-tool tests passing. Legal/provider
review supports the documented distinctions, not blanket clearance or § 512
eligibility; VNDB's data-license page was unavailable. Its substantive evidence
remains in the [source-data review](../research/source-data-rights.md). Runtime and
live-provider acceptance remain prospective.

On 2026-09-23, local link/fragment/navigation checks passed for 153 Markdown files;
all seven checker regression cases passed. Syntax-only checks with RDFLib 7.6.0,
Python JSON parsing and `sh -n` accepted eight SPARQL examples, twelve shell blocks,
three JSON blocks, two inline Turtle examples and the Fuseki assembler. Source/diff
review covered single-JVM ownership, conditional receipts, permanent revision
manifests, query scope, index deletion and restored epochs. Historical scripts and
recorded JSON evidence were preserved.

The subsequent application-stack reconciliation passed local documentation checks
for 157 Markdown files and all eight checker regressions. The new regression keeps
installed dependencies and disposable research output outside authored-document
navigation checks. The [framework probe](../../scripts/research/http_framework_comparison/README.md)
passed a Yarn 4.18 immutable install, TypeScript 7 fixture type checking and Bun
1.4.2 behavioral assertions against pinned Elysia 2 and Hono packages. Its
[result](../../scripts/research/http_framework_comparison/result.json) records
request/response validation differences and an Elysia OpenAPI configuration issue;
it does not certify the future product services. Diff whitespace checks passed.

These checks did not execute shell examples, start product Fuseki/Main/PostgreSQL, validate
assembler behavior, verify all external links or measure runtime/capacity. S0–S3
and runtime gates remain pending. [Development](../development/README.md) provides
the reproducible local integrity commands.

## Completion boundary

New-system integrity, source fidelity and recoverability are required. Old-system
schema/API/data compatibility and migration-only dual writes are not required.
Current-site inputs refresh each live-source run; verified captures reproduce one
run. The current baseline is 500M business entities/documents; 3B is a future
scenario. Keep derived complexity, executed growth checks and measured rollout
capacity separate. No small-data pass certifies that all existing data fits.
