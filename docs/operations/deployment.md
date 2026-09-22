# Two-host deployment assessment

## Available machines and placement intent

Available capacity is one 16-core/64GB host and one 12-core/32GB host. The starting
candidate concentrates principal/stateful services on one host. The other mainly
serves API/edge work and services unrelated to the principal REZICS workload.
Account may run on the second host, but its placement is not fixed. Do not turn
the two machines into a mandatory database-versus-workers split.

| Placement candidate | Workloads | Assessment |
| --- | --- | --- |
| Principal host | Fluree transaction/query/indexing, PostgreSQL control owners, object service if local, broker and principal domain processes. | Prefer the larger host subject to actual storage/network and existing workloads. |
| API/other host | Reverse proxy/BFF/API instances and unrelated services; optionally Account. | Preserve isolation and reserve capacity; remote owner calls carry deadlines and credentials. |
| External durable backup destination | Encrypted recoverable backups and required manifests/keys under separate access. | A backup objective, not an assumed third compute server. |

## Measurements before final placement

Inventory disk capacity/type/IOPS, filesystem durability, bandwidth/latency between
hosts, persistent workloads, exposed origins, backup bandwidth and operational
ownership. Budget OS page cache, Fluree cache/novelty/index builds, PostgreSQL,
API concurrency and worker peaks together. Place hard per-process limits and
headroom; published RAM totals are not all available to application caches.

Start with one effective Fluree writer and qualified local query/indexing. Add a
query peer only when read load and memory/storage access justify it. Independent
worker processes can share the principal host with bounded concurrency. Do not
start OpenSearch or a distributed orchestration fleet as a prerequisite.

## Failure model

Two machines do not provide three independent voting failure domains. Three Raft
processes placed 2+1 can survive loss of the one-voter host, but lose majority when
the two-voter host fails. Initial operation accepts
a principal-host outage, uses recoverable backups and explicit manual failover
with old-writer fencing. A second copy is useful but is not automatically a
consistent backup or disaster-recovery guarantee.

If Account is remote, measure login/session/revocation dependencies and isolate
its cookies, keys and private DB access. Placement does not change service data
ownership. API hosts never get blanket access to raw private storage.

## Deployment units and release

Use reproducible container/process artifacts, a versioned configuration manifest,
secret references and health/readiness checks. Keep database/admin endpoints private;
public ingress exposes product APIs and Account only. Upgrade owner dependencies
in a documented sequence with migration/backup preconditions and rollback rules.
The exact scheduler is an implementation choice evaluated against these needs.

Initial acceptance exercises restart, resource saturation, interrupted writes,
backup restoration and documented principal-host outage. Billion-row throughput,
automatic global sharding and multi-region HA are later qualifications.
