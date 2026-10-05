# Production deployment

Deployment follows the production-readiness [Goal](../../GOAL.md); that Goal
delivers what this page lists as [ready to deploy](#ready-to-deploy) and does not
deploy. The maintainer has prepared the hosts and the Cloudflare side.

Boot Main with `PLATFORM_FIRST_ADMIN_ACCOUNT` unset. Have the first real
operator sign in through Account and provision its Agent through Main. Then set
the variable to that existing active Account subject and restart Main.
Access consumes this configuration through its own
startup command only when no platform administrator exists, committing the role
and an audit receipt together. Verify the startup receipt and bootstrap, then
remove the setting. An unknown or inactive principal fails without designation.
Later boots log that a supplied setting is ignored once a designation exists;
it cannot restore a deactivated administrator or designate a second one.
Follow [first installation and launch intake](production-install.md#operator-and-authority)
for Account ownership, Agent provisioning, scoped credentials and bootstrap.

## Production fleet

A private NixOS flake (the maintainer's `nixos` repository) defines two hosts.
The old REZICS site's `deploy/nomad` jobspecs ran on them and are the precedent
for this system's jobs.

- **A, edge and control.** The sole Nomad server and an `edge` client; Traefik,
  the release gateway and the private image registry. A two-server Nomad quorum
  was rejected: it tolerates no failure.
  The hosts are 16-core/64 GB and 12-core/32 GB: placement constraints, not
  qualified production capacity.
- **B, data.** A `data` client with the stateful volumes and Databasus backups.
  SigNoz belonged to the old site's deployment; rezics-next has no SigNoz wiring.
- **Network.** WireGuard between A and B. The public interface exposes only
  SSH; Cloudflare Tunnel carries public routes to loopback listeners on A.
- **Releases.** A stable tag sends one GitHub OIDC request to the gateway, which
  runs fixed, pre-registered Nomad jobs: image build, database release,
  maintenance cutover behind an HTTP 503 fallback, then API and worker rollout.
  Web, Accounts and about are Cloudflare Workers released from GitHub's protected
  `production` environment, outside the Nomad graph.

Proposed placement, to confirm by measurement when deploying:

| Component | Placement | Reason |
| --- | --- | --- |
| Fuseki (TDB2, Lucene) and Main | B | Main is Fuseki's only client and issues several graph calls per request; keep them on one host. |
| PostgreSQL for Content, Account, Access and operations | B | Separate databases and roles per owner, with continuous WAL archiving. |
| Account service | A or B | Decide from measured latency over WireGuard; Content runs inside Main on B. |
| Imports, index rebuilds, restore drills | B, as batch jobs | They read and write the data volumes. |
| Media and snapshots | Cloudflare R2 | `MAIN_S3_*` already speaks S3. |
| Web, Accounts and about | Cloudflare Workers | Web and Accounts make authenticated private calls through the Tunnel; about serves public pages and its notify form. |
| Telemetry | Collector beside each application host; GreptimeDB on B, Perses on A or B | Shared OTLP instrumentation; [checked-in configuration](../../infra/observability/compose.yaml) and [operating procedure](observability.md#configuration-and-operation). Host integration remains a deployment task. |

### PostgreSQL settings

Every request-serving connection starts with `lock_timeout=5s`,
`idle_in_transaction_session_timeout=60s` and `transaction_timeout=5min`
([`pg-pool.ts`](../../services/main/src/infrastructure/pg-pool.ts) holds the
values and the reasons); restore, rebuild and migration jobs open their own
connections. The server runs with `max_prepared_transactions=0`, as in
[the local stack](../../infra/dev/compose.yaml): nothing uses two-phase commit,
and a prepared transaction would hold locks and the snapshot horizon across restarts.

## Open decision: NixOS and Nomad

Settle this when the deployment phase starts. Planning view of 2026-09-29:

- **Keep NixOS.** Declarative hosts, sops secrets, pinned closures and
  whole-host rollback already work; nothing here needs another OS.
- **Keep Nomad for stateless services and batch work.** The release graph,
  maintenance fallback and autoscaler are precedents, and bulk imports,
  rebuilds, migrations and restore drills are batch jobs by nature.
- **Stateful singletons are the open question.** Fuseki and PostgreSQL gain
  little from a scheduler, and a scheduling mistake there is the costliest (a
  second JVM on live TDB2). Either run them as Nomad jobs pinned to B with host
  volumes, one allocation, no canary and stop-before-start, backed by the
  application's writer fence; or run them as NixOS services on B and keep Nomad
  for the rest. The first keeps one release path; the second removes the failure
  mode at the cost of two. Try the first, with a drill that starts a second
  Fuseki allocation and proves it is refused; move to NixOS services if the
  drill cannot pass.
- **Not recommended:** Kubernetes or k3s (more machinery than two hosts need)
  and Compose (loses Nix pinning and the release graph).

## Ready to deploy

The production-readiness Goal leaves deployment as operations work:

- OCI images with pinned digests for Main, its relay and initialization job,
  Account, the migration job and the Fuseki bundle; Content runs in Main, not
  a separate HTTP service. Web, Accounts and about build as production Workers.
  The [release runbook](release.md) covers local builds, schema checks, migration,
  rollout, rollback and edge pauses; registry publication belongs to deployment.
- Configuration only through the validated environment specs, with production
  examples and no development defaults that could reach production.
- Migrations runnable as their own job before a rollout; readiness endpoints that
  reflect storage, schema, graph epoch and index generation.
- A production bootstrap that creates operators, official Realms, Zones and the
  shared vocabulary without demo data, then runs imports as resumable batch jobs.
- Backup and restore commands per owner, encrypted complete recovery sets and
  pinned release artifacts held under separate custody, and a timed restore
  drill at launch data scale on an isolated copy.
- OTLP traces, metrics and logs with redaction as [observability](observability.md)
  requires.
- Runbooks for first installation, release, rollback, restore and bulk import.

The host inventory in [practical load](#practical-load-objective) still applies:
measure disk, IOPS, page cache, JVM heap, Lucene merge space, WAL and object
staging on the real hosts before setting process and worker limits. One JVM owns
each TDB2 directory; a second host cannot mount the live files as a replica.

## Practical load objective

`task load` runs the named host profile. Its executable thresholds and
evidence checks live in [the load runner](../../scripts/load/practical.ts) and
[OPS05 cases](../../scripts/qa/cases/operations.ts). The recorded
[qualification](../plan/README.md#current-state) applies only to its exercised
fixture and host. Storage and restore capacity for 500 million entities, and
the three-billion-entity scenario, require separate measurement. Preserve
failed attempts and distinguish setup cost from measured request latency.

## Failure and upgrade model

A principal-host failure causes an outage. Fence its writers, capture or choose
a complete stopped recovery cut, restore into separate writable volumes,
verify Account, Access, Content, graph/text generations and exact samples, then
route manually. The [OPS02 drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
simulates this locally; it does not measure cross-host transfer or physical
host failure.

For a format upgrade, hold Main admission, reconcile uncertain receipts, retain
the complete recovery set and format marker, close the Access recovery fence,
then stop the one Fuseki writer and other application writers. Run only a
compatible pinned release. A failed incompatible conversion leaves the
candidate offline; restore its matching prior bytes and marker into an isolated
project, check current and exact reads plus authority, and promote manually.
The [OPS04 drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
exercises a small Access format rewrite and rollback. Production rewrite and
cross-host recovery time remain unmeasured. Follow the
[recovery runbook](recovery.md) for owner cuts and search reconstruction.

## Email rollout

Configure `ACCOUNT_SMTP_*` and `ACCOUNT_EMAIL_FROM` from
[Account's example environment](../../services/account/.env.example).
Development uses Mailpit; a remote sender needs verified identity (SPF, DKIM,
DMARC), TLS, bounce/complaint handling and separately held secrets. Account mail
serves security and recovery. Optional notification mail, such as the daily
digest, requires consent, suppression and signed unsubscribe. Follow the
[email runbook](email.md) for provider event wiring, DKIM coverage of unsubscribe
headers and the aggregate uncertain-delivery report. Inspect uncertain delivery
counts after a lost acknowledgement; the queue never resends them automatically.

## Commercial rollout

Only the fake payment adapter is admitted. The 2026-09-29
[creator-distribution decision](../contracts/distribution.md#creator-distribution)
selects Stripe conditionally; establish provider approval, currency, tax,
collection, refund and payout policy before taking transactions. Seller
onboarding and persistent hosting need their own operating arrangements.

## Launch shape

Decision 5, product manager under maintainer delegation, 2026-09-29.
There is no closed beta. Open registration quietly after launch gates pass;
announce after one to two weeks of healthy operation. Operators can separately
pause registration, uploads or public posting while reporting and recovery stay
available. This gives operators time to observe real demand before promotion
without creating artificial scarcity. [StoryGraph's founder account](https://buttondown.com/nodunayo/archive/55-the-storygraph-explodes/)
illustrates how a sudden migration queue can overwhelm a young service; it does
not establish REZICS capacity. The [safety runbook](trust-and-safety.md) owns
responder coverage and drills.
