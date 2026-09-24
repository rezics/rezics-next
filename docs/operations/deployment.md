# Initial host deployment

## Start with one graph process

Use a single Fuseki JVM containing TDB2 and jena-text/Lucene, TypeScript/Elysia 2 Main on Bun with its
Access/Content modules, and PostgreSQL databases/schemas separately owned by
Content, Account, Access and operations. Account keeps its TypeScript/Bun service boundary. Run only dependencies
for the active journey: Redis, NATS/JetStream, OpenSearch, extra query peers and a
cluster scheduler are not first-start prerequisites. The graph-only
[quickstart](installation.md) is available before those product services exist.

The available capacity is one 16-core/64GB host and one 12-core/32GB host. Start
principal/stateful workloads on one host after storage assessment; the second can
serve API/edge work and unrelated services. Account may run on either host.

| Placement | Initial responsibility |
| --- | --- |
| Principal host, preferably larger | One Fuseki JVM with local persistent TDB2/Lucene; PostgreSQL Content/control/operations owners; Main; participating object/worker processes. |
| API/other host | Reverse proxy/BFF/API and unrelated workloads; optionally Account, using authenticated private owner calls. |
| External backup destination | Encrypted complete recovery sets and release manifests under separate access; not an assumed third compute host. |

Allocate only one process ownership of each TDB2/Lucene directory. A query peer
cannot mount and open the live files in another JVM. Other consumers use Fuseki
HTTP through Main or their explicitly admitted maintenance interface. Read replicas
would require independently built, fenced copies and a freshness/authority design;
they are deferred rather than implied by the second host.

## Capacity and process boundaries

Inventory local durable disk capacity, latency/IOPS, filesystem, backup bandwidth,
network exposure and existing workloads. Budget OS page cache, TDB2 mapped files,
JVM heap, Lucene indexing/merge space, PostgreSQL memory/WAL, object staging and
worker concurrency together. The quickstart's 4 GiB JVM heap is a bounded starting
configuration, not total memory usage or demonstrated corpus capacity. Apply
per-process limits and reserve disk for backup/rebuild generations.

Long graph reads and large imports compete with product writes and text maintenance.
Set request deadlines, result/expansion budgets and bounded import batches in Main;
limit worker concurrency using measured headroom. TDB2 is a single-machine store
with serialized writes and concurrent transaction readers; it does not make every
workload fit the available hosts. Billion-row volume, multilingual relevance,
large-volume history and throughput require later measured qualification.

## Practical load objective

For OPS05 qualification on the elected initial host, use a reproducible corpus of
at least 10,000 Works with published MatchUnits, including a recorded hot 10% of
Works receiving 50% of requests. Run a three-minute steady mix at 10 concurrent
clients: 80% public Work reads/search and 20% admitted edits, selections and
ratings. The target is at least 300 completed requests, p95 whole-request latency
at most 1,500 ms for reads and 2,500 ms for writes, under 0.1% unexpected HTTP
errors, zero 5xx responses, and no growing relay backlog at the end of the run.
Record p99, throughput, memory high-water marks, Lucene/TDB2 size, query plans,
update amplification and outbox lag; repeat after a cold start and verify sampled
receipts, selection heads and search visibility. These are initial qualification
objectives to test against the actual host, not measured capacity claims.

The current QA load tier establishes only a two-client, 20-second empty-corpus
Main/Fuseki query baseline with its own 1,500 ms p95 threshold. It cannot satisfy
the corpus, write or backlog portions of OPS05. Expand the corpus and command mix
before treating OPS05 or the P0.8 mixed-load gate as qualified.

## Routing and service lifecycle

Bind the bootstrap Fuseki endpoint to loopback. Product ingress exposes Main/API
and Account routes only. If Main is remote, use a private authenticated channel
with endpoint allowlists and no public Fuseki/admin access. Databases and object
maintenance credentials are owner-specific. Named graphs do not authenticate
clients or constrain product permission.

Use reproducible process/container artifacts, pinned Java/Jena/service builds,
explicit working directories, persistent mounts, service credentials and separate
graph/text readiness. Preserve the configured TDB2/Lucene paths across restart;
an image filesystem is not durable state. Readiness includes model and index
configuration, graph epoch and dependencies required for the advertised operation.
Supervisor restart alone must not advertise a suspect text index as ready.

Initial workers can poll committed owner outbox records with durable checkpoints
and bounded batches. Introduce a broker only for a demonstrated routing/fan-out
need; it never replaces owner receipts or delivery idempotency. Keep jobs in
participating owner processes until isolation or cost warrants separate runners.

## Failure and upgrade model

The first release accepts a principal-host outage and uses [offline recovery](recovery.md)
with manual writer fencing. Two hosts do not provide automatic distributed
consensus, shared-file HA or atomic TDB2/Lucene replication. A second copy is useful
only with a recorded cut, external object coverage and restore qualification.

Upgrade through a compatible pinned release and retained recovery set. Hold Main
admission, reconcile uncertain commands, stop the one file owner, upgrade/rebuild
as required, run current/exact-revision/authority probes and reopen with the
correct epochs. Automatic restart, unsafe lock deletion or rollback to an
incompatible binary cannot substitute for that sequence.
