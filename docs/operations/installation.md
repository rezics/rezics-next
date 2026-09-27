# Install the local REZICS stack

## Fresh checkout

Use the pinned Bun, Node, Yarn and Task versions in the
[toolchain lock](../development/toolchain.md#runtimes-and-languages), with a
running Docker daemon. From the repository root:

```sh
task toolchain:install
task dev
task urls
```

`task dev` starts the shared backend through Aspire in the main checkout.
In a worktree it starts web, Accounts and Storybook on available ports against
that backend; use `task dev -- --backend` for an isolated backend. `task urls`
shows addresses and readiness, `task aspire -- logs <resource>` shows logs, and
`task env` shows configuration with secrets masked. Keep generated private
configuration in `.temp/stack/` out of support bundles.

Check Main and Account readiness before using product commands. Storage process
liveness alone does not prove that authority, graph commands or search are
available. A fresh graph has no public Works, so an empty public search is
expected. Sign-in requires a registered local client, member and Access grants;
the QA OAuth bootstrap is a disposable fixture.

Stop application processes with `task dev:stop`. `task stack:down` retains
Compose volumes; `task stack:reset` deletes the selected project's volumes
and object directories. Inspect the project with `task stack:status` and
`task stack:logs` before cleanup.

### Pinned release and format record

After installing the toolchain, build and verify a local release:

```sh
REZICS_ARTIFACT="$(task release:build)"
task release:install -- --artifact "$REZICS_ARTIFACT"
```

Retain the entire content-addressed release directory with a matching recovery
set, including its private `release-format.json`. A marker without its owner
data is not a recovery set. A pending format upgrade blocks ordinary start and
requires the [offline recovery procedure](recovery.md). The
[OPS01 drill](../../tests/qa/integration/fresh-install.test.ts) checks repeat
installation, migration idempotence and owner readiness.

## Standalone graph-substrate drill (S0)

S0 is a disposable Fuseki/TDB2/Lucene check with Java 21 and the pinned Jena
6.2.0 image. Its [raw-update assembler](../../infra/jena/fuseki-text-quickstart.ttl)
exposes `/rezics/query` and `/rezics/update`; the
[product assembler](../../infra/jena/fuseki-text.ttl) uses guarded commands.
Keep the S0 listener private and never send product writes to its raw endpoint.
Only one JVM may own a TDB2 directory. Preserve the exact assembler, analyzer
and state directory across restart.

The [OPS14 quickstart test](../../tests/qa/fault-recovery/search-ops-quickstart.test.ts)
is the runnable insert, RDF/text query, restart, delete, stale-index and rebuild
recipe. It asserts returned bindings, including a direct text query that detects
stale postings hidden by an RDF join. The
[substrate verifier](../../scripts/operations/verify_graph_substrate.py) accepts
`--fuseki-home`, `--java-home`, `--assembler`, `--fuseki-archive` and a new
disposable `--state` directory; use the S0 assembler above. It records
`result.json` and service logs in that directory. Neither drill qualifies
product authority or multi-store recovery.

After an unclean shutdown, raw load, analyzer change or index failure, keep text
unavailable until the [rebuild procedure](recovery.md#offline-lucene-rebuild)
qualifies its generation. Reconcile uncertain commands from receipts before
retrying; a failed HTTP response does not identify the graph transaction outcome.
