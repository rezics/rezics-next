# Initial host deployment

## Email rollout

Configure `ACCOUNT_SMTP_*` and `ACCOUNT_EMAIL_FROM` from
`services/account/.env.example`. Development uses Mailpit on
`127.0.0.1:1025` (inbox `http://127.0.0.1:8025`); production needs a verified
transactional sender and TLS for remote SMTP. Keep credentials in deployment
secrets. Account mail is for security/recovery; optional notification mail needs
its own consent, suppression and signed unsubscribe integration before rollout.
SMTP can lose an acknowledgement after delivery, so inspect `rezics_account_email`
uncertain counts rather than resending those intents automatically. Integrate
provider bounce and complaint processing before using a remote sender. Do not use
the transactional sender for an unselected marketing campaign.

## Commercial rollout

Only the in-stack fake payment adapter is admitted today. Select a real provider,
currency, tax, collection and refund policy before enabling transactions. Third-
party seller onboarding, payouts and persistent hosting require separate operating
arrangements. A stored provider status alone does not promise legal or financial
settlement.

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
workload fit the available hosts. The current source baseline is 500 million
business entities/documents, not triples. Storage amplification, import/index
throughput, multilingual relevance, history and restore time need measured
qualification before placing that corpus on these hosts. The available hardware
is a starting constraint, not proof that it can hold or serve the existing data.

## Practical load objective

Separate three kinds of evidence:

1. **Complexity.** Every path has a derived cost contract and small multi-scale
   counterexample checks under [complexity verification](../testing/complexity.md).
   No fixed minimum corpus size qualifies this gate; native engine work matters.
2. **Latency, contention and recovery.** Select a named host profile, fixture
   distribution, concurrency, thresholds and cold/restart behavior. Run it when
   qualifying that deployment claim or investigating a relevant boundary.
3. **Production capacity.** Estimate bytes and write amplification, then measure
   representative import/indexing, storage, sustained service and restore costs
   for the actual rollout. Neither small growth tests nor the profile below
   establishes capacity for 500 million entities. Three billion is a future scenario.

Retain the existing `task load` default as the **10,000-Work mixed host profile**:
a reproducible corpus of 10,000 Works with published MatchUnits and a hot 10% of
Works receiving 50% of requests. Run a three-minute steady mix at 10 concurrent
clients: 80% public Work reads/search and 20% admitted edits, selections and
ratings. The target is at least 300 completed requests, p95 whole-request latency
at most 1,500 ms for reads and 2,500 ms for writes, under 0.1% unexpected HTTP
errors, zero 5xx responses, and no growing relay backlog at the end of the run.
Record p99, throughput, memory high-water marks, Lucene/TDB2 size, query plans,
update amplification and outbox lag; repeat after a cold start and verify sampled
receipts, selection heads and search visibility. These are initial qualification
objectives to test against the actual host, not measured capacity claims. Another
profile must state its qualified scope explicitly; changing fixture size must not
silently replace this objective or erase a failure. Background setup follows the
[bulk/reuse policy](../storage/workload-budgets.md#data-preparation-and-import);
testing online commands does not require creating every background object online.

The current QA load tier establishes a two-client, 20-second bounded mixed
public query probe over 10 Works with Main, Realm and Content phrase paths. It
checks a 50% hot-Work offered mix, nonempty exact results, rejected-candidate
absence, response counts and per-lane latency thresholds. This does not satisfy
the 10,000-Work, concurrent-write, cold-start or relay-backlog portions of OPS05.
The public phrase profiles currently admit up to 20,000 MatchUnits and reject a
513th raw phrase candidate. These implementation caps are not production scale
acceptance. The two 2026-09-25 10,000-Work attempts failed, as recorded in the
[harness](../testing/test-harness.md#load); the host objective remains unqualified.
Do not repeat their multi-hour command seed as a universal backend gate. Repair
the smallest failing case and preparation path first. OPS05 retains growth,
lag, memory and recovery requirements; a bounded probe qualifies only its scope.

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

## Manual second-host drill and format boundary

The [OPS02 local drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
stops a small provisioned project, copies all owner volumes and the object
directory into a retained recovery cut, then restarts the principal. It restores
the cut into a second persistent Compose project with separate writable owner
volumes, but leaves it stopped. The drill records the cut, network, release digest
and graph epochs. It refuses to start the second project while the principal still
runs. After a simulated process crash, the operator fences the principal with
`task stack:down`, starts the second project on a separate Docker network, then
checks its Account, Access, Content and
relay databases, graph/text readiness and exact saved samples before any manual
routing decision.
This simulates the second host locally; it measures neither cross-host transfer
time nor physical host failure recovery. Routing is an operator action after the
checks, with an outage until then.

Before changing a storage format, preserve the complete stopped recovery set and
its `release-format.json`; stop Main, Account and other application writers.
The offline OPS04 operation closes the Access recovery fence, records the
pending candidate and stops the single Fuseki writer before changing Access's
persisted `principal.account_subject` from UTF-8 text to bytea. Access migration
180 records format version 1 and
guards recovery-fence reopening against a pending or incompatible format.
The operation records the pending target in Access and the private marker, then
rewrites the table and its unique index in one PostgreSQL transaction. This is
an incompatible format: the version-one reader cannot interpret the new column.
The graph writer remains stopped and the Access fence remains closed after the
rewrite. This release contains no version-two runtime and never advertises the
candidate as ready.

The [OPS04 drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
injects failure after the rewrite commits, observes bytea, the closed Access
fence and unavailable graph writer, and checks that `release:install` and
`stack:up` refuse the pending candidate. It restores the matched version-one
owner volumes, objects and marker into a fresh
isolated project, then checks exact Account, Access, Content and graph samples,
the original text column and the ready format record before manual routing.
Retire the failed copy only after the restored set is qualified. PostgreSQL's
[ALTER TABLE type conversion](https://www.postgresql.org/docs/18/sql-altertable.html)
can rewrite the table and indexes under an exclusive lock, so this step is
offline and its resource cost grows with the saved principal rows and index.
The local drill proves the small exercised cut; production sized rewrite time
and cross-host transfer remain separate capacity qualifications.

Let M be the migration-file count, B the bytes in the complete recovery set and
F its file count. Provisioning reads O(M) migration ledgers and applies only
pending owner DDL, then makes a fixed set of readiness calls. The OPS01 replay
test requires zero new migrations on the second pass. A stopped backup and
restore copy O(B + F) data and need space for the source, retained cut and
restored target. The copy helpers run once per owner volume; they do not scan
application rows. The 600-second routine preparation limit includes copying and
readiness. Promotion uses fixed owner probes and three indexed exact samples:
Account email, Access principal ID and Content revision ID, plus graph lineage
and text readiness. Those point reads depend on owner index plans and serialized
sample bytes, not unrelated history. The OPS02 drill checks all three through
the restored owners; large-volume restore time, physical database plans and
contention remain unmeasured. The format marker transition is one atomic file
replacement, with its disk durability dependent on the host filesystem. The
Access format record and column rewrite commit together; if the process stops
after that commit, the marker remains pending and both routine start paths
refuse the copy.
