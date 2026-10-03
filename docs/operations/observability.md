# Observability, health and diagnosis

## Telemetry configuration

Decision, maintainer, 2026-10-02: use Aspire for development and OpenTelemetry,
GreptimeDB and Perses for the server observability plane. This change prepares
configuration; it does not deploy a host or change the private NixOS flake.

Main, Account and Main relay share
[`@rezics/observability`](../../packages/observability/src/runtime.ts). Bun
preloads it before `pg` imports, through the Task commands, AppHost and release
entrypoint. Content runs inside Main and shares its service resource. Aspire's
`withOtlpExporter(HttpProtobuf)` injects its endpoint and secret headers. An
authenticated loopback HTTP listener on an Aspire-assigned port is used for
development OTLP: Bun 1.4.2 rejects Aspire's self-signed development leaf even
when explicitly trusted, matching [Aspire issue #17455](https://github.com/microsoft/aspire/issues/17455).
The dashboard and resource service retain HTTPS; application TLS verification
stays enabled. The local runtime check must verify dashboard ingestion, because
an HTTP protobuf sink alone cannot qualify Aspire's transport.
After `task dev`, run `task observability:aspire-smoke`: it performs read-only
liveness requests with unique W3C parents, checks the corresponding server spans
and startup logs in the dashboard, and checks that OTLP rejects missing API keys.
An absent endpoint or `OTEL_SDK_DISABLED=true` disables the SDK. Supported settings
come from the [common spec](../../packages/observability/src/config.ts) and the
generated Main and Account `.env.example` files. Production examples use a
parent-based 10% root trace sample; metrics and logs remain independent.

The application owns SDK startup and bounded shutdown after requests, jobs and
pools drain. Traces, metrics and selected structured service events use OTLP
HTTP protobuf. Console output is not blindly forwarded: use `telemetryLog` with
public event names and explicitly chosen attributes. Fetch spans measure time
to response headers and preserve streaming bodies. For the configured Fuseki
origin, the client span stays open until body consumption or cancellation,
counts decoded body bytes without buffering or teeing, and records headers
latency separately. It exports a bounded peer service label and only a numeric
Jena server timer when one is available. A partial or failed stream has
`rezics.http.body.complete=false`, never a complete zero-byte observation.
The current Fuseki build has no native timing producer; HTTP latency is not
engine timing. The application and Collector allowlists retain these fields
together. The [API profiling method](../testing/complexity.md#api-request-work-profiles)
describes calibration, collection and the unobserved engine work.
Only configured internal
origins receive generated W3C headers; baggage is not propagated. `pg` query
spans omit SQL text, parameters and results at export. These signals cover HTTP,
outbound fetch, PostgreSQL and relay/mail jobs, not every business outcome or
host/Fuseki resource metric.

Scheduled Main workers and Account mail use `withWorkerTelemetry` for each
finite invocation. Their named parent spans group PostgreSQL and fetch children;
`rezics.worker.outcome` distinguishes idle/current, work, deferral, retry, blockage
and failure. The wrapper preserves business return values and errors, and does
not change polling intervals, leases, batch sizes or retries. A worker that does
not report its result uses `completed`, rather than implying it was idle.
`rezics.worker.runs` and `rezics.worker.processed` are cumulative counters;
`rezics.worker.duration` is an explicit-bucket histogram in seconds, excluding
the scheduled wait. Processing counters state their unit and count examined or
acknowledged units, not successful external deliveries. Metric labels contain
only fixed worker names, outcomes, triggers and units, never job IDs or source
positions. Metrics continue when traces are sampled out. Failed and explicitly
retrying/blocked invocations emit correlated `worker_run_failed` or
`worker_run_deferred` events without exception payloads. Existing console
diagnostics remain separate. The application and Collector span allowlists both
retain these worker fields; changing only one loses them on the other path.

The pinned Elysia 2 beta plugin has a
[small Yarn patch](../../.yarn/patches/elysia-opentelemetry-status.patch)
to read the actual `Response.status` and defer span status until response mapping
finishes. Without it, direct Responses and mounted
Better Auth responses can report 200. The regression test covers these forms,
exceptions, redirects, streams, unmatched routes, overlapping request context,
PostgreSQL, privacy, correlated logs and real protobuf export. Keep one resolved
OTel API version: mixed API copies previously disabled providers silently.

Span exports allowlist operational attributes and omit raw URLs, path values,
query strings, bodies, headers, IPs, user agents, exception payloads and status
messages. Unmatched requests get a bounded name. Metrics retain bounded route
templates and explicit histogram buckets with cumulative temporality. This
matches [GreptimeDB's OTLP limitations](https://docs.greptime.com/user-guide/ingest-data/for-observability/opentelemetry/),
which currently exclude exponential histograms and store delta values without
converting them to cumulative series.

## Configuration and operation

The optional [observability Compose model](../../infra/observability/compose.yaml)
is a runnable reference for pinned versions and local validation, independent
of the application stack. It is also the source topology for a later NixOS or
Nomad translation. It supplies resource limits, non-root service data ownership,
private loopback ports, authenticated GreptimeDB, persistent WAL/data and a
Collector disk queue with bounded capacity and retries. Queue exhaustion, disk
failure and process crashes can still lose data. The GreptimeDB exporter uses
separate pipelines and the required `greptime_trace_v1` header, following
[the official Collector integration](https://docs.greptime.com/user-guide/ingest-data/for-observability/otel-collector/).

Use [the environment example](../../infra/observability/.env.example) to supply
four external secret files. The GreptimeDB user file contains
`telemetry=<password>`; the Collector password file contains that password.
Perses needs a persistent exactly 32-byte encryption key, and a JSON `Secret`
resource named `greptimedb` in project `rezics`, with
`spec.basicAuth.username=telemetry` and `spec.basicAuth.password` matching the
database. Keep those files outside Git. Secret rotation must update every
consumer; retain the encryption key with the Perses data backup.

Perses uses [File DB configuration](../../infra/observability/perses/config.yaml)
and [Git-owned provisioning resources](../../infra/observability/perses/provisioning/services.json).
Provisioning synchronizes every minute; edit the checked-in datasource and
dashboard resources and review their diff. The HTTP API is read-only. File DB
stores runtime state and encrypted secrets on a persistent volume; it is not
the source for dashboard edits. A single Perses process owns this volume. To
remove a resource, remove its source and deliberately remove the retained File
DB object during maintenance: removing a provisioning file alone need not
delete an existing resource. Back up this volume and its encryption key before
changing Perses versions. See [Perses provisioning](https://perses.dev/perses/docs/configuration/provisioning/).

Datasources proxy through Perses using the external secret. The dashboard
includes request rate, 5xx ratio, p95 latency, recent events and traces. Initial
table-creation hints retain metrics for 30 days and logs/traces for 7 days.
Changing these headers does not change existing tables; explicitly review and
apply `ALTER TABLE ... SET 'ttl'=...` for existing data. Shortening TTL deletes
older telemetry asynchronously. Capacity and retention need measurement under
the real workload.

`task observability:check` validates Compose and the pinned Collector binary in
a disposable container. `task observability:smoke` creates only an isolated
local observability project, exercises authentication, ingestion and Perses
provisioning, and removes its containers/volumes. It never starts or changes the
shared application stack. Both need a running local Docker daemon. Tests use
disposable files under `.temp/observability`; no production secrets are needed.

The reference exposes only loopback HTTP endpoints. Access Perses through SSH
or an authenticated private ingress; its native auth is disabled under this
boundary. Cross-host application traffic needs a host-local Collector or an
explicit receiver bind plus WireGuard/authenticated TLS transport. Public
ingress and the private NixOS/Nomad configuration are separate deployment work.
Perses displays signals; automated alert evaluation and delivery still require
a separately configured rule engine and notification receiver.

## Signals and readiness

Use operation/causation IDs, graph epoch and sequence, index generation and
owner checkpoints to correlate Main, Access, Content, Fuseki and workers. Track
receipt outcomes, latency, retries, outbox age, JVM/OS memory, PostgreSQL WAL,
Lucene/TDB2 growth and storage headroom. Keep credentials, private mappings,
body text and matched literals out of routine logs and support bundles.

Liveness means the process responds. Owner readiness requires its storage,
schema and command path. Graph readiness requires the guarded writer and
correct epoch; text readiness requires a qualified analyzer/index generation.
An uncertain or rebuilding index stays unavailable even when graph reads work.
Check `task urls`, `task aspire -- logs <resource>`, owner health endpoints
and the QA artifact for the operation in question.

## Incident workflow

Identify the owner, epoch and index generation. Fence unsafe admission, retain
bounded traces and receipts, then reconcile unknown outcomes before retrying.
Reproduce storage faults on an isolated copy; never start another JVM against
live TDB2. Repair the cause, requalify the affected owner, and report any
remaining gap. Follow [recovery](recovery.md) for a suspect text generation.
