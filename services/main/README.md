# Main startup and current command boundary

Main runs on Bun 1.4.2 with pinned Elysia 2.0.0-beta.16. Yarn 4.18.0 owns
dependency resolution. The service factory is importable without starting
Fuseki; the process entry listens on loopback and requires a private Fuseki URL.

```sh
corepack yarn install --immutable
FUSEKI_URL=http://127.0.0.1:3030/rezics/ MAIN_PORT=3001 \
  corepack yarn main:dev
```

`GET /health/live` checks the process; `GET /health/ready` queries Fuseki and
returns 503 when it cannot reach the configured dataset. The service currently
exposes no product write route. `activateMetadataWork` is an internal graph
activation primitive; its `admittedScope` must come from a verified Account/Access
decision. Do not bind it to a request body or publish it until that admission
bridge and the full command/error contract are implemented.

The primitive validates a complete small Work/MainVersion candidate with the
[fixed profile](../../model/README.md), stages content-addressed immutable payloads
and manifests, then sends one conditional update through Fuseki's text wrapper.
The update writes current heads, revision anchors, an operation receipt, sequence
and outbox batch together. It looks up its own receipt after the update, including
after an ambiguous response. An unmatched guard stays pending; it is never treated
as success merely because Fuseki accepted the SPARQL request.

To run the owner integration test, provide the extracted, checksum-verified Jena
and Fuseki 6.2.0 distributions and Java 21 runtime:

```sh
export REZICS_FUSEKI_HOME=/absolute/path/to/apache-jena-fuseki-6.2.0
export REZICS_JENA_HOME=/absolute/path/to/apache-jena-6.2.0
export REZICS_JAVA_HOME=/absolute/path/to/java-21
corepack yarn main:typecheck
corepack yarn main:test
```

The test starts disposable Fuseki state in repository `.temp/`, checks a network
HTTP readiness response, graph/text bindings, retained object bytes, receipt
replay, conflicting keys, a lost response, a same-key race, stale epoch rejection
and the outbox count. [Executed JUnit evidence](tests/evidence/2026-09-24-main-storage.xml)
records the first run. These checks cover a storage sub-slice of SYS02/SYS10/SYS14;
they do not establish Account/Access admission, historical resolution, HTTP product
commands or complete S1 acceptance. The [plan](../../docs/plan/README.md#active-execution)
owns current scope and next action.
