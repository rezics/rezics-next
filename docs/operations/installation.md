# Install the local REZICS stack

The supported development installation uses the pinned root commands. It starts
PostgreSQL, Fuseki with the REZICS command module, RustFS, Mailpit and Toxiproxy
in a private Compose project. Main and Account run on the host. The current
checkout still needs the web journey, Content-to-Main publication/search binding
and remaining [acceptance gates](../plan/README.md#execution-program).

## Fresh checkout

Use the exact Bun, Node and Yarn versions in the [toolchain lock](../development/toolchain.md#runtimes-and-languages)
and a working Docker-compatible daemon. The root facade uses the Podman user
socket when Docker Engine is unavailable. From the repository root:

```sh
yarn toolchain:install
yarn dev
```

`toolchain:install` performs an immutable Yarn install, checks the runtimes,
pulls the pinned service images, builds the local Fuseki command image and
installs Playwright Chromium. `yarn dev` starts the persistent `rezics-dev`
Compose project, applies Account/Access/relay migrations, initializes a fresh
graph with its data and routing epochs, and starts Account and Main in watch
mode. It prints the generated loopback endpoints and waits for both application
readiness checks. No host Jena or Java installation is needed for this path.
The service endpoint and private configuration are saved under
`.temp/stack/rezics-dev/`; `compose.env` and `apps.env` contain secrets and must
stay private. The generated configuration persists across ordinary restarts.

In another terminal, run `yarn stack:status`. The expected local application
readiness URLs are `http://127.0.0.1:3002/health/ready` for Account and
`http://127.0.0.1:3001/health/ready` for Main. A healthy Compose stack alone
does not prove that Main/Account started or that product commands are admitted.
The initial graph has no public Works; a successful empty search is expected.
Client registration, a member and Access grants are still required for an
authenticated Work command. The isolated QA-only bootstrap in
`scripts/dev/web-auth-bootstrap.ts` provisions a localhost PKCE fixture, not a
production web client or a default development account.

Stop `yarn dev` with Ctrl-C. Then run `yarn stack:down` to stop the service
containers while retaining their named volumes and the private configuration.
`yarn stack:up`, `yarn stack:status`, `yarn stack:logs` and `yarn stack:down`
also work without host application processes. `yarn stack:reset` removes the
local project's volumes and object/candidate directories; use it only when
that project's data may be discarded. A restart against retained data checks
the stored data/routing epochs and fails rather than silently replacing them.

For isolated checks, `yarn qa` creates separate `rezics-qa-<run>` projects on
generated ports and tears them down. Its summary in `.artifacts/qa/<run>/`
distinguishes passed tiers from partial and uncovered acceptance IDs. The
current runner does not qualify the full retained M01–M10 scope or a recorded
release. The [harness](../testing/test-harness.md) owns its current tier list.

## Standalone graph-substrate drill (S0)

The following older host procedure starts only Apache Jena Fuseki, TDB2 and
jena-text/Lucene. It remains useful for the isolated S0 restart/restore drill;
it does not install the current product stack. It intentionally uses the
[raw-update example assembler](examples/fuseki-text.ttl), whereas the product
[assembler](../../infra/jena/fuseki-text.ttl) exposes `/rezics/command` and
does not expose `/rezics/update`. Do not direct product writes to the S0
endpoint. See the [implementation sequence](../plan/README.md).

## Baseline and release pins

The documentation baseline, checked on 2026-09-23, is **Apache Jena/Fuseki 6.2.0**
with **Java 21**, using the official binary distribution. The release includes
jena-text and pins **Lucene 10.3.1**. Do not independently replace Lucene jars or
mix Jena module versions. The rolling text guide's old compatibility table is
not a release manifest: use the [6.2.0 parent POM](https://github.com/apache/jena/blob/jena-6.2.0/pom.xml)
for dependencies and the [official release page](https://jena.apache.org/download/)
for binaries/Java requirements.

A release records the downloaded archive and SHA-512, Java vendor/build, OS,
configuration digest, analyzer/index generation, RDF/model definitions, and each
participating service/PostgreSQL version. Pin the Java patch/build in the actual
host or image manifest; this design does not invent a universal platform image.
Retain the verified archive for restoration. A later Jena release requires explicit
manifest review and a restore/reindex check, not a floating `latest` download.

## Download and configure

Run these blocks in a POSIX shell from the repository root, on Linux with Java
21, `curl`, `tar` and GNU `sha512sum` installed. Choose an empty private directory
outside the checkout; the example path is local to the current user. Do not use a
shared or network-mounted TDB2 directory. No Redis, broker, container runtime or
separate search service is required for this host graph step.

```sh
REZICS_REPO="$PWD"
REZICS_STATE="$HOME/.local/state/rezics-jena-6.2.0"
export REZICS_REPO REZICS_STATE
umask 077
mkdir -p "$REZICS_STATE/downloads" "$REZICS_STATE/run"
cd "$REZICS_STATE/downloads"
curl --fail --location --remote-name \
  https://dlcdn.apache.org/jena/binaries/apache-jena-fuseki-6.2.0.tar.gz
curl --fail --location --remote-name \
  https://downloads.apache.org/jena/binaries/apache-jena-fuseki-6.2.0.tar.gz.sha512
sha512sum --check apache-jena-fuseki-6.2.0.tar.gz.sha512
```

Continue only if verification succeeds. The expected SHA-512 from the official
checksum on the research date is recorded here so the example is pinned even
when the download mirror changes:

```text
ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132
```

If the current mirror no longer retains this version, obtain this exact archive
and checksum from the [Apache archive](https://archive.apache.org/dist/jena/binaries/).
Release operators also verify the signature using Apache's
[artifact verification procedure](https://www.apache.org/info/verification.html)
and trusted release keys before promotion.

```sh
tar -xzf apache-jena-fuseki-6.2.0.tar.gz -C "$REZICS_STATE"
export FUSEKI_HOME="$REZICS_STATE/apache-jena-fuseki-6.2.0"
export FUSEKI_BASE="$REZICS_STATE/run"
mkdir -p "$FUSEKI_BASE/databases/rezics/tdb2" \
  "$FUSEKI_BASE/databases/rezics/lucene"
cp "$REZICS_REPO/docs/operations/examples/fuseki-text.ttl" \
  "$FUSEKI_BASE/fuseki-text.ttl"
java -version
cd "$FUSEKI_BASE"
```

Confirm Java reports the intended 21 build. The [assembler](examples/fuseki-text.ttl)
exposes only `/rezics/query` and `/rezics/update`. Both use the same
`text:TextDataset`, wrapping the persistent TDB2 dataset and Lucene directory.
The `uid` field enables deletion of matching text documents, `graph` preserves
named-graph identity and `lang` records literal language. The `cjk-bigram-v1`
bootstrap maps `rdfs:label` and public `rv:searchBody`, uses the bundled Lucene
`CJKAnalyzer` for both index and query analysis, and stores matched literal
values. The bounded selected-body tests qualify only their exercised phrases;
broader multilingual relevance and complete product indexing remain under the
[search contract](../contracts/search.md). An existing StandardAnalyzer index
must be rebuilt offline with this assembler. The current runtime gate also
requires a qualified generation activation for existing datasets, which is
pending. Follow [offline Lucene rebuild](recovery.md#offline-lucene-rebuild).

## Start one JVM

Keep this command in the foreground. Use another terminal for HTTP probes.

```sh
MAIN=main JVM_ARGS='-Xms512m -Xmx4g' \
  "$FUSEKI_HOME/fuseki-server" \
  --localhost --port=3030 --no-cors --timeout=10000 \
  --config="$FUSEKI_BASE/fuseki-text.ttl"
```

The pinned [launcher](https://github.com/apache/jena/blob/jena-6.2.0/jena-fuseki2/apache-jena-fuseki/fuseki-server)
selects the server without UI/admin workspace with `MAIN=main`;
[command arguments](https://github.com/apache/jena/blob/jena-6.2.0/jena-fuseki2/jena-fuseki-main/src/main/java/org/apache/jena/fuseki/main/runner/FusekiArgs.java)
provide localhost binding, CORS disabling, query timeout and assembler selection.
Do not add `--update`, `--tdb2`, `--loc` or a dataset path to this command: the
assembler already owns dataset type, location and writable endpoint selection.

This is a local development boundary: any process able to reach these endpoints
can read or write the dataset. Named graphs are not permission boundaries. Keep
the port off public ingress; only Main and authorized maintenance tools receive
access in a product deployment. On a multi-user host, isolate the process/network
or add service authentication. Cross-host access requires authenticated private
transport. See [security](security.md) before adapting the listener.

Exactly one JVM owns both storage directories at a time. Every other process,
including Main and workers, uses HTTP. Never run a local loader, query,
backup, compactor or text indexer against these paths while Fuseki is running.
Do not remove database lock files to bypass ownership.

## Smoke writes, graph queries and text queries

Run in another terminal. The synthetic `urn:rezics:smoke` graph is for this
substrate check only; do not use these raw update examples as product commands.
All queries explicitly select their graph; the assembler does not enable a union
default graph.

```sh
curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-update' \
  --data-binary @- http://127.0.0.1:3030/rezics/update <<'SPARQL'
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
INSERT DATA {
  GRAPH <urn:rezics:smoke> {
    <urn:rezics:smoke:book> rdfs:label "REZICS launch atlas"@en ;
      <urn:rezics:smoke:probeAnchor> true .
  }
}
SPARQL

curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-query' \
  -H 'Accept: application/sparql-results+json' \
  --data-binary @- http://127.0.0.1:3030/rezics/query <<'SPARQL'
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?s ?label WHERE {
  GRAPH <urn:rezics:smoke> { ?s rdfs:label ?label }
}
SPARQL

curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-query' \
  -H 'Accept: application/sparql-results+json' \
  --data-binary @- http://127.0.0.1:3030/rezics/query <<'SPARQL'
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX text: <http://jena.apache.org/text#>
SELECT ?s ?score ?literal WHERE {
  GRAPH <urn:rezics:smoke> {
    (?s ?score ?literal) text:query (rdfs:label "atlas" 10) .
    ?s rdfs:label ?literal .
  }
}
SPARQL
```

The graph response must contain `urn:rezics:smoke:book` and the English label;
the text response must contain that same resource and literal. Lucene score is
not a stable expected constant. HTTP success alone is insufficient; inspect the
bindings. The graph join checks the matching assertion is still current, but does
not turn a stale text index into a complete query or provide authorization.

Stop with Ctrl-C and wait for the process to exit. Restart from the same
`FUSEKI_BASE` working directory using the same command; rerun both queries without
reinserting the resource. Both must still return it. This checks planned durable
restart behavior when executed; it is not proof of crash consistency or recovery.

Finally remove the synthetic literal through the text wrapper:

```sh
curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-update' \
  --data-binary @- http://127.0.0.1:3030/rezics/update <<'SPARQL'
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
DELETE DATA {
  GRAPH <urn:rezics:smoke> {
    <urn:rezics:smoke:book> rdfs:label "REZICS launch atlas"@en .
  }
}
SPARQL
```

Rerun the graph label query and the joined text query; both must be empty. The
non-indexed `probeAnchor` triple deliberately retains the named graph, so an
index-only probe cannot be skipped because the graph vanished. First require the
following ASK to return `true`, then require the direct text query to return no
bindings. If ASK is false, the deletion check is invalid; do not interpret an
empty text response as index-deletion evidence.

```sh
curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-query' \
  -H 'Accept: application/sparql-results+json' \
  --data-binary @- http://127.0.0.1:3030/rezics/query <<'SPARQL'
ASK {
  GRAPH <urn:rezics:smoke> {
    <urn:rezics:smoke:book> <urn:rezics:smoke:probeAnchor> true .
  }
}
SPARQL

curl --fail-with-body --show-error \
  -H 'Content-Type: application/sparql-query' \
  -H 'Accept: application/sparql-results+json' \
  --data-binary @- http://127.0.0.1:3030/rezics/query <<'SPARQL'
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX text: <http://jena.apache.org/text#>
SELECT ?score ?literal WHERE {
  GRAPH <urn:rezics:smoke> {
    (<urn:rezics:smoke:book> ?score ?literal)
      text:query (rdfs:label "atlas") .
  }
}
SPARQL
```

Only after that check, remove the remaining synthetic graph with
`DROP SILENT GRAPH <urn:rezics:smoke>` through `/rezics/update`. The direct probe
has no RDF join, bounds the subject to the smoke resource and leaves no global
hit limit that could hide it behind unrelated hits. This verifies logical
text deletion, not [physical erasure](erasure.md).

## Automated substrate qualification

The [OPS14/OPS16 drill](../../scripts/operations/verify_graph_substrate.py)
executes the insertion, graph/text queries, graceful restart, stopped-state
backup, isolated restore and index-deletion checks above. Run it only with a new
disposable `--state` directory. Supply the extracted, checksum-verified Fuseki
6.2.0 archive and a Java 21 runtime. For example, after setting `FUSEKI_HOME`,
`JAVA_HOME` and `REZICS_REPO` to those exact locations:

```sh
python3 "$REZICS_REPO/scripts/operations/verify_graph_substrate.py" \
  --fuseki-home "$FUSEKI_HOME" \
  --java-home "$JAVA_HOME" \
  --assembler "$REZICS_REPO/docs/operations/examples/fuseki-text.ttl" \
  --fuseki-archive "$REZICS_STATE/downloads/apache-jena-fuseki-6.2.0.tar.gz" \
  --state "$REZICS_STATE/qualification-s0"
```

The drill rejects an incorrect Fuseki archive digest or a non-Java-21 runtime.
It writes `result.json` and separate service logs inside the state directory and
asserts returned bindings, not just HTTP status. The saved original remains
stopped; deletion is checked on the isolated restored copy. It qualifies the
graph substrate only, not product command receipts or multi-store recovery.

## Product activation and upgrade gate

The next delivery connects Main's internal guarded command and Elysia 2 HTTP
adapter to Account/Access PostgreSQL authority and a first authenticated journey.
Main owns resource/revision manifests, operation receipts and atomic outbox
records within its TDB2 updates. Access owns admission and revocation; Fuseki
endpoint authentication cannot replace it. Jena SHACL is available, but this
assembler does not enforce shapes automatically.

Keep graph and text readiness separate. After an unclean shutdown, index error,
bulk load bypassing the text wrapper or analyzer change, suspend text results
until [recovery/rebuild](recovery.md) requalifies the generation. jena-text joins
normal dataset transactions; that does not establish a recoverable two-store
commit protocol for every crash. Reconcile uncertain product updates through
TDB2 operation receipts rather than blindly resending mutations.

Before a product upgrade, capture the complete recovery set, qualify the new
release in isolation, rebuild incompatible indexes and verify current/denied/
exact-revision reads. A rollback crossing TDB2 or Lucene format changes uses the
recorded backup and compatible binary; an old executable is not a rollback plan.
The commands and assembler here were reviewed against official documentation and
6.2.0 source. The automated S0 drill executed the substrate probes; its result is
linked from the [active plan](../plan/README.md#active-execution). It did not
measure capacity or certify a production release.
