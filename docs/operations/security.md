# Security and disclosure boundaries

## Fuseki is a private dependency

Only Rust Main and explicitly admitted maintenance tools can reach Fuseki's
query/update endpoints. Product users call Main. Fuseki service authentication
can protect an endpoint; it does not evaluate REZICS resource, component, exact
revision, Agent representation or revocation rules. Named graphs organize RDF
and query scope; they are not automatically authorization boundaries.

The [quickstart](installation.md) uses loopback, no CORS and no UI/admin workspace.
It intentionally supplies no product authentication and is suitable only for an
isolated local substrate check. Other local processes may still reach loopback.
Use OS/network isolation and an authenticated service boundary on a shared host;
remote access additionally needs authenticated private transport. No public
proxy route, wildcard container port publication or browser credential may expose
the raw database endpoints. See the upstream
[Fuseki security documentation](https://jena.apache.org/documentation/fuseki2/fuseki-security.html)
when selecting the release's service authentication configuration.

Do not infer protection from disabling Graph Store endpoints: a privileged SPARQL
Update endpoint can still rewrite the dataset. Main owns admitted query templates
and guarded commands; clients cannot choose protected graphs, arbitrary SPARQL,
`SERVICE` targets, update `LOAD` sources, filesystem paths or administrative
operations. Restrict network/file egress of the Fuseki process as defense in depth.
If a public graph query language is added, its parser, graph scope, remote-service
restrictions and budgets must be independently qualified before exposure.

## Authority and input boundaries

Account keeps separate origins/cookies and private PostgreSQL credentials. Access
runs inside Main behind its separately owned PostgreSQL interface. Bind service
calls to an audience, rotate credentials and reject unavailable authority for
protected operations. An HTTP transaction does not atomically commit PostgreSQL
and TDB2; apply the [transaction protocol](../contracts/commands.md) and durable
receipts/fences across owners.

Validate typed IDs, lossless values, expected revisions, mutation boundaries,
JSON-LD context acquisition, URL/redirect/DNS rules, archive paths, payload size
and execution budgets. Parameterize RDF terms and encode user text safely;
SPARQL and Lucene query syntax must not be assembled by unchecked concatenation.
Jena SHACL support does not make the sample assembler a shape-enforcing gateway.
Main performs domain validation and rechecks commit guards; any later transactional
SHACL integration must preserve those guarantees.

Source text, templates, Skills, model output and tool responses are data. Only
explicit admitted operations grant network, filesystem, credential or execution
use. Executable themes and package scripts keep their own execution isolation.

## Query disclosure and revocation

Main applies current resource and exact-content disclosure to history, text
matches, returned literals, snippets, facets, graph paths, exports, media and
notifications. Lucene relevance scores and candidate counts can also disclose
restricted content; do not expose raw results before the admitted query protocol.
Search generation/graph fence and authority context bind candidate handles and
caches. A final RDF join may remove stale hits but cannot establish complete
ranking, consistent text snapshots or current authority by itself.

Access denial/unavailability never becomes allowance. Stop-after-revocation
workflows use admission/drain fences rather than token expiry alone. Search
remains unavailable while a suspect index is rebuilt; graph readiness does not
mean text readiness. Redact credentials, account mappings, private query text and
stored matched literals from routine logs and support bundles.

## Erasure and restore

Distinguish logical RDF/text deletion, hidden publication, tombstone, retention
expiry and physical erasure. Inventory current TDB2 files, retired generations,
revision manifests/payloads, Lucene segments, object bytes, captures and backups.
Advance the durable erasure frontier before bounded deletion/rewrite and carry it
through restores, index rebuilds and imports. The [erasure runbook](erasure.md)
owns completion evidence.

Published legal/privacy text must be supplied through its actual legal owner
before product activation. This documentation-only checkout does not contain the
previously referenced legal pages; the architecture does not invent retention
or legal-compliance guarantees in their place.
