# Storage architecture comparison

This is a synthetic architecture probe, not the product acceptance harness.
The [architecture evaluation](../../../docs/research/storage-architecture.md)
owns conclusions and limitations. Tools and pins are admitted by the
[toolchain research exception](../../../docs/development/toolchain.md#architecture-evaluation-exception-2026-09-24).

## Reproduction

Use the admitted Bun/Yarn/TypeScript dependencies and native PostgreSQL/Java
versions. All runtime data, downloads and build output stay in
`.temp/storage-architecture/`. These commands create new isolated databases and
loopback servers; they do not connect to the application's running databases.

```sh
yarn research:architecture prepare
yarn research:architecture inspect
yarn test scripts/research/storage_architecture/graph.test.ts scripts/research/storage_architecture/search.test.ts scripts/research/storage_architecture/bridge.test.ts
yarn check
GRAPH_SIZES=10000,50000 yarn research:architecture graph
yarn research:architecture search
yarn research:architecture opensearch
yarn research:architecture bridge
yarn research:architecture dgraph --prepare-only
yarn research:architecture dgraph
yarn test scripts/research/storage_architecture/dgraph.test.ts
yarn research:architecture report --retain
```

The final evidence also contains three controlled supplements:

```sh
yarn research:architecture search --pg-contains-control
GRAPH_POST_INDEX=1 yarn research:architecture graph
REZICS_BRIDGE_SNAPSHOT=1 yarn research:architecture bridge
```

They reuse only the probe's retained isolated databases. The first adds PostgreSQL
Realm-first literal filtering and real query plans; the second compares graph
metadata/payload reads after an explicit Fluree index build. The bridge supplement
updates all 2,001 rows atomically between two SQL chunks to demonstrate that the
composed result need not correspond to one PostgreSQL snapshot. It preserves
the preceding timing result as `measurement-baseline.json`. `search --report-only`
refreshes the explanatory recommendation without repeating or changing measurements.

Run measured commands one at a time. `prepare` validates the Fluree release hash,
the Jena jar hash, records the pinned source archive hash and compiles the SQL
bridge using its lockfile. `prepare --skip-bridge` can omit the bridge build.
`inspect` records host/storage versions and the search container identity, and
adds the matching installed image/runtime to `tools.json`.

The CJK probe currently requires the inspected local old-repository image
`rezics-postgres:18.6-pgroonga-4.0.8` (exact ID/digest in the toolchain). Its
PostgreSQL/extension versions are verified at runtime. This custom image is not
a public downloadable distribution; reproducing that part on another host
requires building/providing the same image or admitting and recording a replacement.
The probe reports a missing engine explicitly rather than treating a skipped
comparison as a pass. Java source-file launch compiles the small search HTTP
probe using the pinned server jar; no Maven build is needed.

The OpenSearch supplement uses the separately pinned official 3.6.0 image. Its
runner resolves and records the container image identity, starts a disposable
loopback-only service and verifies the server version before measurement. It
tests a public, fixed-policy relationship projection, not an authoritative graph
replica, private search or arbitrary SPARQL. Its field layout and scoring grain
differ from the earlier normalized-substring probe; latencies are not an
apples-to-apples engine ranking.

The Dgraph challenger pins v25.4.1 by image ID and digest. `--prepare-only`
inspects the image before execution; a changed digest must be admitted in the
toolchain first. The runner uses a private disposable Zero/Alpha pair, not an
existing cluster. DQL occurrence nodes and application context resolution cover
a bounded domain model, not arbitrary RDF equivalence. History, receipt and
outbox are ordinary records in a guarded transaction. The recorded retry case
discards a committed response; it is not a transport-fault or crash test.

## What is measured

- Graph: deterministic Work metadata, selected revisions, sparse accept/reject
  overrides, tag parents, skewed relationship edges, bounded two/four-hop reads,
  PostgreSQL batched hydration, concurrent CAS and publication failure cases.
  SQL uses domain tables, not a universal triple table. It is a control for these
  bounded queries, not an implementation of arbitrary RDF semantics.
- Search: an explicit normalized-substring oracle with 11 CJK/mixed-script cases,
  10k/50k documents and deliberately late eligible matches, using Jena text and
  PGroonga. This tests matching and completeness, not human relevance judgments.
- OpenSearch: Chinese text combined with same-occurrence credits, sparse Realm
  publication/classification and a contextual rating criterion in one engine
  request. Preserve mapping/query fixtures, independent eligibility expectations,
  latency samples, update visibility and the exact bounded scope of each check.
  The corrected retained run verifies five selective eligible IDs, broad joined
  counts/top-20 membership and tiny/200-chunk root updates. It does not qualify a
  graph relay, private search, broad full-ID equivalence or human relevance.
- Bridge: actual PostgreSQL-to-Fluree R2RML mapping, exact-value round trips and
  statement counts around the 2,000-key batching boundary in default/cache-off
  modes. Sources and runtime observations remain distinct.
- Dgraph: 10k Work fixture, identified repeated relations and parameterized claim
  filters, stored context cases, eight competing same-head edits, retained exact
  history and retry/failed-mutation behavior. One Alpha does not test distributed
  scale, failover, general semantic validation or full multilingual search.

The graph probe initially reports 15 warm observations per shape. Its p95/p99 are
sample order statistics, often the maximum, not reliable production tail estimates.
The first measured query is after setup/warm connections, not an OS-cache-cold
measurement. HTTP graph queries and native PostgreSQL wire queries use different
protocols; compare application paths rather than claiming an isolated CPU ranking.
Payload byte counts exclude wire framing. Disk figures include engine-specific
baseline files, logs/indexes/history and different representations; they are not
normalized compression comparisons.

Retained raw JSON is under `evidence/2026-09-24/`. Logs and disposable data remain
under `.temp/`. The scripts stop their own services in cleanup. No mixed-load,
power-loss, production-host or billion-record capacity qualification is implied.
