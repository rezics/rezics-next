# Shared database substrate for QA

Review proposal, measured on this host on 2026-10-14. Keep one QA-only
PostgreSQL process and one QA-only Fuseki process alive across ordinary runs;
give each run independent owner databases, a TDB2 store and a Lucene index.
Keep destructive and engine-specific tests on private stacks. These services
must be separate from the shared development backend.

The intended gain is fewer container starts, PostgreSQL restores and JVM
warmups per prove wave. This note proposes a harness change; it does not
implement or qualify a shared multi-dataset REZICS server.

The credible alternatives are the existing warmed private-stack pool and
PostgreSQL-only sharing. The pool preserves process failure isolation and
already amortizes startup for eligible shards; PostgreSQL-only sharing avoids
the native-module redesign. Full sharing is worthwhile only if it improves
whole-wave throughput over those alternatives after contention and cleanup
costs. Shared SQL schemas or RDF graph prefixes do not provide the required
run boundary.

## Decision (program, 2026-10-14)

Deferred. On the native Docker engine an empty QA stack reached both HTTP services 8.7 s after admission and used 1.34 GiB, so per-run startup no longer limits a prove wave. The measured costs are fixture preparation: the medium restore's 292 s RustFS copy, the medium build failing on default `max_locks_per_transaction` (`53200`), and persistent restores running PostgreSQL, RustFS, toxiproxy and Mailpit without the caps admission charges for. Those are repaired first. The shared substrate's isolation work (per-run roles and ACLs, a multi-dataset Fuseki JVM, crash reaping) is weighed again only if repeated prove waves still show preparation, not tests, as the limit.

## Host measurements and reproduction

Worktree revision `8808031df5851ee9e0be1c7e4dc1ed4eda0c6e75`, Linux
`7.2.10-200.fc44.x86_64`, 62.64 GiB host RAM; Docker Desktop engine 29.8.2,
64 reported VM CPUs, 23.45 GiB VM RAM and `overlayfs`. Images were PostgreSQL
18.6-trixie, REZICS Fuseki 6.2.0/cmd0.5.40 and RustFS 1.0.0 at this checkout's
Compose pins. No cache eviction or host exclusivity was requested. There is
one successful restore observation per profile and three clone observations
per profile, not a latency distribution or a concurrent-wave qualification.

The host's retained fixtures failed the current compatibility selection, so
the experiment built fresh local cuts: `fx-small-b7d0ac231213` (1,000 Works,
10 Agents, 100 public units) and `fx-medium-1ac58e77294a` (100,000 Works,
1,000 Agents, 10,000 public units). Small built in 109.800 seconds. Medium's
first build failed with PostgreSQL error `53200`, exhausting advisory-lock
entries during verification. The retry set
`REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION=2048` and built in 549.466 seconds
of active work, including 403.182 seconds loading online owners. This is an
explicit experiment setting, not a repair or a qualification of the default
medium build. Build and restore each have their own 600-second budget.

Measured restore IDs were `fixture-measure-small-mv80kxt8` at 11:18 UTC and
`fixture-measure-medium-mv80vvqb` at 11:35 UTC. All durations below are seconds.

| Phase | Small | Medium | Boundary |
| --- | ---: | ---: | --- |
| Admission wait | 1.122 | 2.152 | Excluded from active work |
| Fixture volume restore | 6.888 | 292.458 | Before container admission; three copies in parallel |
| PostgreSQL copy | 5.490 | 22.211 | Included in parallel restore wall |
| Fuseki copy | 2.476 | 21.960 | Included in parallel restore wall |
| RustFS copy | 6.703 | 292.292 | Included in parallel restore wall |
| Containers start to Compose ready | 23.259 | 18.725 | After admission; full five-service topology |
| SQL migration check | 0.295 | 0.521 | No new migrations pending in either cut |
| Model alignment/bootstrap | 3.488 | 2.620 | Includes current model installation |
| Owner readiness and sampled smoke | 0.412 | 0.466 | Includes graph/Lucene and object checks |
| Account process start to `/health/ready` | 1.537 | 2.637 | Real service, then Main starts |
| Main process start to `/health/ready` | 3.275 | 3.466 | Real service |
| Total active fixture restore | 35.395 | 315.779 | Includes compatibility/configuration and phase overhead |
| After-admission ready components, including Account/Main | 32.266 | 28.435 | Sum of disjoint phase measurements |

The last row is a **component sum**, not one uninterrupted wall observation:
the clone experiments were interposed between restore readiness and HTTP
process startup. It excludes those experiments and observation overhead.
Actual restore wall was 36.517 seconds small and 317.931 seconds medium;
active restore plus HTTP-start components was 40.207 and 321.882 seconds.
Neither migration-check duration estimates applying a fresh schema: small's
initial build migrations took 38.290 seconds, medium's retry 6.871 seconds.

Memory is Docker's reported working set at readiness and around HTTP startup,
not a measured startup/test peak. Small had three snapshots from 11:19:08 to
11:19:57 UTC, medium four from 11:40:22 to 11:41:37 UTC.

| Container | Small observed range | Medium observed range | Actual restored-container cap | Admission budget component |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 113–244 MiB | 91.25–322.6 MiB | Unlimited | 2 GiB |
| Fuseki | 688.8–1,000 MiB | 1.012–1.596 GiB | 7 GiB | 7 GiB |
| RustFS | 463.2–484.9 MiB | 572.8–658.3 MiB | Unlimited | 1 GiB |
| toxiproxy | 6.461–7.777 MiB | 5.324–7.062 MiB | Unlimited | 128 MiB |
| Mailpit | 27.88–30.77 MiB | 12.46–14.05 MiB | Unlimited | 256 MiB |

Total simultaneous sampled container use was 1.27–1.72 GiB small and
1.68–2.57 GiB medium, against the 10.375 GiB startup promise. Separate host
process RSS after readiness was Account/Main 162.6/208.6 MiB small and
163.0/212.1 MiB medium. Those observations do not justify shrinking caps:
Docker working set excludes some cache, restores used disk rather than tmpfs,
and no destructive, sustained-write or concurrency peak was sampled.

### Clone primitives on those cuts

Each SQL observation created all four databases serially with
`CREATE DATABASE measure_<owner>_<iteration> TEMPLATE <owner> OWNER <owner>`
on the already-running restored PostgreSQL, then dropped them. Each dataset
observation ran `cp -a /from/rezics /to/rezics` from the **stopped fixture**
volume into a fresh volume, followed by `du -sk` for TDB2/Lucene and removal.
Copy timing includes helper-container launch, copying and `du`; it excludes
volume creation/deletion and registration in a running multi-dataset server.

| Primitive | Small trials | Medium trials |
| --- | --- | --- |
| Four SQL databases, seconds | 0.923, 1.017, 0.602 | 3.826, 7.555, 4.789 |
| TDB2 + Lucene directory, seconds | 3.878, 1.337, 1.248 | 15.173, 6.487, 11.268 |
| SQL database bytes, all four | 79,887,100 | 425,491,196 |
| Copied allocated TDB2 size, KiB | 11,860 | 1,139,916–1,139,944 |
| Copied allocated Lucene size, KiB | 300 | 27,768 |

The SQL median was 0.923/4.789 seconds and directory-copy median
1.337/11.268 seconds. These separately measured medians cannot be presented
as a shared run's ready time. Medium's object-copy cost would remain in the
first rollout below; sharing the two database processes alone does not remove
its 292-second restore bottleneck.

### Commands and retained evidence

The temporary experiment is `.temp/qa-shared-databases/measure.test.ts` in
this worker worktree. It calls the existing fixture builder and
`restoreFixture(..., { artifactsRoot, runPhase })`, records the restore's
admission-adjusted phases, executes the SQL/directory commands above, starts
`bun services/account/src/index.ts` then `bun services/main/src/index.ts` with
the restored `apps.env`, and probes their `/health/ready` endpoints. It reads
memory with `docker stats --no-stream --format '{{json .}}`, actual caps with
`docker inspect --format '{{.Name}} {{.HostConfig.Memory}}`, and host RSS with
`ps -o pid=,rss=,comm= -p <account-pid>,<main-pid>`.

Exact admitted experiment invocations:

```sh
REZICS_FIXTURE_ROOT="$PWD/.temp/qa-shared-databases/fixtures" \
  bun scripts/goal/goalctl.ts test ./.temp/qa-shared-databases/measure.test.ts
MEASURE_PROFILE=medium REZICS_POSTGRES_MAX_LOCKS_PER_TRANSACTION=2048 \
  REZICS_FIXTURE_ROOT="$PWD/.temp/qa-shared-databases/fixtures" \
  bun scripts/goal/goalctl.ts test ./.temp/qa-shared-databases/measure.test.ts
task stack:reset -- --profile qa --run-id fixture-measure-medium-mv80vvqb --persistent
```

Local `host.json`, `results.json`, `restore/<run-id>/run.json`, service logs
and `fixtures/<fixture-id>/manifest.json` under that temporary directory retain
commands' inputs, measurements and fixture identities. The builder's
`.artifacts` output was redirected by a worktree-local symlink to
`.temp/qa-shared-databases/artifacts`; no shared fixture metadata was written.
The QA reaper removed these run-owned temporary backup volumes at command exit;
the retained local manifests are provenance, not reusable backups after exit.
The first invocation failed at the medium lock limit after completing small;
the retry completed all measurements and both HTTP readiness assertions, then
failed its 120-second final stack-reset wrapper. Teardown was retried separately.
The wrapper's overall failure must not be represented as a passing QA run.
The separate stack-reset retry completed successfully. Supplemental attempts
to obtain an uninterrupted full HTTP-ready timing failed during startup
(a Docker API 500 on fixture restart, then PostgreSQL container exit on fresh
tmpfs and persistent startup); those failures are excluded from the timing tables.
By 11:57 UTC the selected engine had changed to native Docker 29.9.0 on Fedora
Linux 44 with 62.64 GiB server RAM. The tables describe the earlier Docker
Desktop allocation; its 23.45 GiB VM concurrency arithmetic must not be applied
to the new engine. Re-measure startup, enforced limits and concurrent peaks on
that configuration before sizing the shared substrate.
The native-engine startup blocker was captured from the private PostgreSQL
container: `/usr/local/bin/docker-entrypoint.sh: line 188:
/docker-entrypoint-initdb.d/00-owners.sh: Permission denied`. Its source file
in this worktree was mode `700`, owned by `edge`, while the image sources it
as the `postgres` user. The measurement restored local read permissions with
`chmod 755 infra/dev/postgres/00-owners.sh`; file contents and Git's tracked
executable mode did not change. The diagnostic command before this repair was
`MEASURE_PERSISTENT=1 bun scripts/goal/goalctl.ts test ./.temp/qa-shared-databases/cold-start.test.ts`;
its private stack was reset successfully afterwards, with logs retained in
`.temp/qa-shared-databases/native-startup-failure.json` as a diagnostic excerpt.

### Uninterrupted startup on the new native engine

After the local permission repair, the admitted command
`bun scripts/goal/goalctl.ts test ./.temp/qa-shared-databases/cold-start.test.ts`
passed five assertions on `measure-cold-mv82dw1b` at 12:06:39 UTC. The test
started a fresh **empty** tmpfs QA stack with all five services, the product
assembler and a 7 GiB Fuseki allocation, ran the harness's real
`stageQaBootstrap` command, then started Account and Main and probed both
`/health/ready` endpoints. It recorded admission when the child emitted its
`Admitted; QA memory:` line. This is one uninterrupted wall observation;
it restores no background fixture and must not be compared as the same workload
as the populated restores above.

| Native-engine phase | Seconds |
| --- | ---: |
| Reported admission wait | 0.156 |
| Admission to Compose ready | 4.334 |
| SQL/graph/template bootstrap | 1.514 |
| Account start to HTTP ready | 0.946 |
| Main start to HTTP ready | 1.947 |
| Admission to both HTTP services ready, uninterrupted | 8.742 |
| Request to both HTTP services ready | 10.044 |
| Final stack reset | 2.956 |

Its post-readiness memory snapshot was PostgreSQL 518.6 MiB, Fuseki 729.7 MiB,
RustFS 113.8 MiB, toxiproxy 3.129 MiB and Mailpit 8.902 MiB: **1.34 GiB total**.
Inspection confirmed all five enforced caps, respectively 2 GiB, 7 GiB,
1 GiB, 128 MiB and 256 MiB, totaling 10.375 GiB. Thus the uncapped-services
finding concerns the persistent restore path, not this tmpfs path.
`cold-start.json` retains this successful result, engine identity, capped
allocations, memory snapshot and phase timings.

The current engine's shorter empty-stack startup and larger memory envelope
reduce the original scarcity premise. Compare prove-wave throughput and warmed
pool hits there before prioritizing the full shared-Fuseki redesign. The
earlier fixture clone timings still establish primitives on this host, but
their new-engine and concurrent costs remain unmeasured.

The existing implementation is more varied than the brief's full-stack model:
[ordinary integration shards](../../scripts/qa/resource-classes.ts) allocate a
2 GiB Fuseki and [omit toxiproxy](../../scripts/qa/stack-ownership.ts).
Their storage promise is 5.25 GiB; the full ordinary topology is 5.375 GiB.
A full topology with the 7 GiB Fuseki allocation promises 10.375 GiB.
The [admission guard](../../scripts/qa/memory-admission.ts) charges startup
promises, then reads actual running memory. Thus 10.38 GiB is a particular
allocation, not a permanent charge for every ordinary file.

Inspection of the measured persistent restores found `HostConfig.Memory = 0`
for PostgreSQL, RustFS, toxiproxy and Mailpit; only Fuseki had a 7 GiB limit.
The restore starts from the base Compose topology, whereas the other service
caps are declared in the QA override. The 10.375 GiB admission promise therefore
does not establish a physical bound for this persistent path. Align its actual
limits with admission in a separate harness change before relying on caps to
size concurrency; this note changes no runtime configuration.

The [preparation ceiling](workload-budgets.md#data-preparation-and-import)
remains 600 seconds of active work. Queue wait is reported separately. Physical
fixture restore copies volumes **before** container-start admission, then starts
containers, applies newer SQL migrations, aligns the model, verifies owners
and checks sampled state. Main and Account startup are additional costs for
files that serve HTTP; many integration files use their real apps in-process.
Do not add these HTTP-process measurements to every integration estimate.

## Allocation and template lifecycle

Use the current fixture manifest compatibility decision as the template key:
owner generators and declared profile inputs, applied migration bytes and
order, model alignment, pinned engines and assembler mode. Prepare a consistent
fixture once, import the four PostgreSQL owners into the shared cluster and
retain an immutable, closed TDB2/Lucene directory pair. Publish the key only
after owner readiness and the fixture's exact sampled checks pass. Preparing
templates remains an explicit operation; an ordinary run never rebuilds one
silently. Keep an empty migrated template for files that require an empty
population; do not force a small background corpus into those files.

For each admitted run, the existing harness supervisor allocates a random
namespace and records its lease before creating anything. Clone account,
access, content and relay serially using `CREATE DATABASE ... TEMPLATE ...`.
The [PostgreSQL 18 contract](https://www.postgresql.org/docs/18/sql-createdatabase.html)
requires a source without other connections. Seal templates with
`ALLOW_CONNECTIONS false`; only the supervisor can clone them. Measure default
`WAL_LOG` first. `FILE_COPY` performs checkpoints and may penalize other runs;
do not select it from a single isolated copy result.

Copy the stopped fixture's whole dataset directory, including Lucene and
REZICS search-journal state, into a staging directory; publish by rename only
after copying succeeds. Use independent files, never hard links to mutable
stores. Open it in Fuseki under `/qa_<namespace>/` with an assembler whose TDB2
and text-index paths both point to that run. A shared RDF dataset with graph
prefixes would not isolate dataset epochs, journal receipts, restore holds or
queries over the default/union graph. [TDB2 administration](https://jena.apache.org/documentation/tdb2/tdb2_admin.html)
documents the store lock and consistent logical backup; a logical N-Quads
backup does not include Lucene. Never copy a live physical store without a
coordinated owner cut.

Keep RustFS and Mailpit run-local in the first rollout: private object state,
credentials and inboxes preserve existing tests. Retain any filesystem-backed
Main object/candidate directories per run as well. Add no toxiproxy to ordinary
runs. Later sharing of object storage or mail needs separate bucket/inbox
authority and cleanup proof. The first saving removes PostgreSQL and Fuseki
startup per run; it does not remove the remaining container readiness costs.

## Tests that retain private stacks

Selection is per file, before sharding. Conservatively keep all
`fault/recovery` files private initially, including entries in
[`selfManagedFaultAdmission`](../../scripts/qa/core.ts), and all load/resource
qualification files until concurrent shared-load evidence exists. Concrete
reasons include:

| Reason | Existing files or selection markers | Why database names are insufficient |
| --- | --- | --- |
| Network fault injection | `tests/qa/fault-recovery/lost-response.test.ts`, `semantic-lost-response.test.ts`, `account-key-remote-placement.test.ts`; use of `TOXIPROXY_*` or `/toxics` | Disabling an upstream or changing a proxy must not disturb unrelated requests. |
| Physical restore, erasure and maintenance drills | `tests/qa/fault-recovery/owner-restore-erasure-*.test.ts`, `erasure-restore*.test.ts`, `coordinated-owner-cut.test.ts`, `protection-restore.test.ts`, `tdb2-compact-history.test.ts`; `services/account/tests/account-pitr.integration.test.ts`, `services/main/tests/access-pitr.integration.test.ts` | Exercise stopped volumes, WAL custody, physical purge, recovery holds and independent installation, not just SQL/RDF state. |
| Process/container death and restart | `tests/qa/fault-recovery/crash-fence-contract.test.ts`, `search-ops-generation.test.ts`, `content-projection-crash.test.ts`, `second-host-format-upgrade.test.ts`; `services/main/tests/content-projection.integration.test.ts`, `tests/qa/integration/local-read-basis.test.ts` | A Fuseki JVM or PostgreSQL restart crosses every dataset/database in that process. |
| Image/runtime/installation contracts | `tests/qa/fault-recovery/fixed-release-recovery.test.ts`, `second-host-format-upgrade.test.ts`, `tests/qa/integration/fresh-install.test.ts`, container-backed native tests under `infra/jena/tests/`; explicit image overrides or container allocation assertions | A pinned engine, startup flag, module version or filesystem format belongs to the tested process. |
| Cluster administrator access | Any file requesting the `privileged` connection mode in `cloneQaOwnerDatabases`, or direct stack `compose.env`/admin URL access | A superuser can read or alter every database in a shared cluster. |

The existing [isolated integration list](../../scripts/qa/isolated-integration-files.ts)
also contains files needing fresh populations, epochs or graph heads. Those
requirements can eventually use a fresh run dataset on shared servers; they
do not intrinsically require a private JVM. Initially preserve their private
selection until each file's physical-resource and privilege dependencies are
reviewed. `commandOnlyIntegrationFiles`, raw-SPARQL assembler selection,
resource classes and self-managed startup remain authoritative inputs.

Extend that existing selection owner with explicit shared eligibility and
private reasons, rather than introducing a second independent classifier.
The planner partitions shared and private files before batching; a mixed batch
never downgrades a private requirement. Unit/static checks retain no-stack
execution; unclassified stack-backed files use private stacks.
Within shared selections, files currently requiring isolated state get fresh
namespaces; only the harness's existing shared-state batches may intentionally
reuse one namespace. Print the choice, template key and reason in the run
evidence. A denied shared allocation must fail or take a recorded private
fallback; it must not borrow another run's resources.

## Isolation contract

**PostgreSQL:** allocate independent login credentials for every run and owner.
Runs receive no supervisor credential, `CREATEDB`, `CREATEROLE`, superuser
privilege or membership in another run's role. Revoke `PUBLIC` database access
on every template, clone and administrative database; grant `CONNECT` only to
the matching owner. Enforce database/user pairing in server authentication as
well. [PostgreSQL privileges](https://www.postgresql.org/docs/18/ddl-priv.html)
give databases `PUBLIC` access by default, so unique names and passwords alone
are insufficient.

`OWNER` on `CREATE DATABASE` changes the database owner, not all copied table
owners and ACLs. Normalize object ownership, schema/default privileges and
function grants inside the clone to its run roles before opening connections;
never grant all runs membership in fixture owner roles. Preserve owner
separation within a run. Audit hard-coded owner role names and security-definer
functions; apply migrations before sealing the template or supply scoped role
bindings. Ownership normalization must not change cluster-wide database or
tablespace ownership as a side effect. Replace supervisor-backed test cloning with a scoped
allocation API; leave tests needing true superuser behavior private. Audit
`pg_read_all_stats` grants in
[`00-owners.sh`](../../infra/dev/postgres/00-owners.sh): they expose other
runs' session/query information. Horizon diagnostics must be scoped or use a
restricted supervisor result. Cross-database roles and transaction horizons
are cluster-wide concerns even when table data is separated.

**Fuseki:** authenticate every read and write endpoint and bind credentials to
exactly one run dataset. Give each dataset independent command, maintenance
and title-admission capabilities. Deny another dataset's URL, server admin
API, unauthenticated raw updates and remote `SERVICE` paths that could bypass
the boundary. The [Fuseki Main ACL contract](https://jena.apache.org/documentation/fuseki2/fuseki-data-access-control.html)
offers dataset and endpoint controls; graph ACLs alone are unsuitable for
writable isolation. Do not assume the Fuseki Full administration API is
available in this repository's command-line server. Dynamic registration,
safe dataset closure/removal and per-dataset command registration need proof
on the pinned server.

Today [`CommandService`](../../infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java)
reads capabilities from process environment. The
[`CommitHalt`](../../infra/jena/command-module/src/main/java/com/rezics/jena/CommitHalt.java)
path halts the whole JVM. Audit module registration, profile registries,
search recovery, caches and diagnostics for dataset identity; maps keyed by
dataset are a useful start, not a multi-dataset qualification. A shared JVM
failure aborts all attached runs, which must report infrastructure failure
and discard their clones.

These guarantees cover authorized QA clients on a trusted runner. Ordinary
shared files must receive neither Docker/host administration nor filesystem
access to other runs' stores or supervisor secrets. Database ACLs cannot
contain a test that can administer their server or read its data directory.

**Crash cleanup:** extend the existing harness lease/ownership registry with
namespace, owner PID and process start time, template key, databases, roles,
dataset paths and lifecycle state (`allocating`, `ready`, `closing`). Heartbeats
alone are insufficient to distinguish an orphan from a temporarily stalled
live run. On normal exit stop clients, deny new connections, wait for pools,
drop databases, close/unregister the dataset, delete its files and drop roles.
The existing clone helper already avoids forced asynchronous disconnects
during ordinary teardown. A supervisor reaper handles dead owners after
verifying lease identity: terminate orphan sessions, then drop their resources.
[`DROP DATABASE ... FORCE`](https://www.postgresql.org/docs/18/sql-dropdatabase.html)
can still fail with prepared transactions or replication objects; retain a
failed cleanup record and its capacity charge until verified absent. Never
reap by a broad prefix or age alone, and never remove templates. Recover
partial allocations from the recorded manifest; reconcile server resources
against it when the supervisor restarts. A dataset cannot be deleted while
still open by the JVM.

Shared services and templates belong to the long-lived harness supervisor,
outside any individual run's container-reaper scope. A test exit must remove
only that run's allocations, never the shared server or another run's template.

## Rollout, risks and decision gates

1. Preserve private execution and the existing warmed stack pool as the
   baseline. Record queue wait, active preparation, test time, memory and
   cleanup separately, with explicit pool hits. A pool hit already avoids
   infrastructure startup; compare shared servers against both hits and misses.
2. Implement the supervisor allocation/cleanup contract and restricted owner
   roles on a dedicated QA PostgreSQL. Prove A cannot connect to B, inspect B's
   query text, mutate the template or retain access after disposal. Kill the
   allocator after each allocation step and prove the reaper removes only A.
3. Qualify the pinned Fuseki module on two simultaneous copied datasets: A's
   query, raw update, command, model generation change, restore hold and
   cleanup cannot change B's state or capabilities. Prove closure releases
   TDB2/Lucene mappings and stale recovery tasks cannot mutate a replacement
   dataset. Until this passes, share PostgreSQL alone and keep Fuseki private.
4. Opt in reviewed ordinary files, using empty/small templates as their
   population contracts require. Run identical selected files privately and
   shared, then under concurrent writers. Keep the 600-second preparation
   ceiling and existing host reserve. The registry, slots and memory admission
   remain the harness's owners; sharing does not bypass them.
5. Charge shared service caps once and reserve per-run host work, connections,
   dataset mapped pages, object/mail caps and copy I/O separately. Bound open
   dataset count, PostgreSQL connections, JVM heap/direct memory and disk/WAL
   growth. Size from concurrent peak measurements, not the idle snapshots here.
   Admit clones through the existing startup/work queues; physical copies
   also consume bandwidth. Keep large/resource qualification runs private.
6. Promote only after repeated waves show lower end-to-end time, successful
   crash cleanup, no cross-run reads and stable memory after repeated
   allocate/drop cycles. Publish warm and cold p50/p95 preparation and wave
   throughput, queue time and failures. Roll back selection to private without
   rewriting tests; shut down shared servers only after their leases drain.

Principal risks are shared JVM failure, query/connection/cache contention,
cluster-wide role and horizon leakage, WAL/checkpoint pressure, accumulating
mapped pages, fixture ownership normalization and multi-owner identity drift.
Fixture account issuer/client configuration, lineage and graph/SQL receipts
must travel as one cut; changing a port is not permission to rewrite semantic
identity. Rotate service secrets and provision run-specific OAuth clients through the
supported bootstrap/fixture operations; a backup's baked-in credentials are
not per-run credentials. Verify issuer-bound authority after this normalization.
SQL clone and stopped-directory copy timings exclude authorization,
dataset registration, object restore and concurrent load. Their composition
must be measured before claiming a shared run's ready time or slot gain.
