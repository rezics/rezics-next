# Apache Jena storage and query binding

## Selected launch profile

Use Apache Jena Fuseki as the private HTTP server, TDB2 as the authoritative RDF
dataset, and jena-text with embedded Lucene as its rebuildable full-text index.
Pair it with PostgreSQL Content/Access/operations. Jena owns semantic text,
relations, selection and semantic revisions; JSON body authority and Content
history are [PostgreSQL-owned](postgresql.md). Body text in RDF MatchUnits is a
derived search representation, not a second editable body.
Start with one logical `product` dataset and one Fuseki JVM owning its database
directory. The quickstart serves it at `/rezics`; its stable `datasetId` is distinct
from the HTTP service name and remains stable if that route changes.
Application processes use pooled HTTP connections; they never open its TDB2 files.
Pin the Jena/Fuseki distribution, matching jena-text artifact, resolved Lucene and
Java versions, binary digests, assembler and analyzer configuration in the release
manifest. The public documentation's compatibility table is not a dependency lock.

TDB2 supplies transactional RDF storage with one active writer and concurrent
readers. Its MVCC supports transaction isolation; REZICS does not treat it as a
permanent time-travel service. The second host provides application/worker capacity
and recovery storage, not a live TDB2 replica or another writer to shared files.
See [Jena's transaction documentation](https://jena.apache.org/documentation/tdb/tdb_transactions.html).

Keep RDF 1.1, SPARQL 1.1 Query/Update and the admitted JSON-LD 1.1 profile as the
launch exchange baseline. Extra syntax, inference and validation profiles require
explicit qualification. The application owns semantic identity, authorization,
revision history, idempotency and event delivery.

## Dataset layout and admitted writers

One configured `text:TextDataset` wraps one `tdb2:DatasetTDB2`; Fuseki query and
the REZICS command endpoint both reference that wrapper. Current facts, control records,
revision metadata, outbox batches, source observations and staged generations use
explicit named graphs. A graph name conveys scope, not permission. Ordinary query
compilation selects allowed graphs and never enables an unrestricted union view.
Large immutable payloads/manifests live in [object storage](objects.md).

All live changes, including deletion, staging, cleanup and projection updates, go
through the wrapped dataset and their owning command adapter. Do not expose a
second writable endpoint for the base TDB2 dataset. Direct loaders and file access
are restricted to an offline bootstrap/recovery procedure followed by a complete
Lucene rebuild. Indexed predicates, graph/language fields and UID deletion behavior
are specified by the [search binding](../contracts/search.md).

Native Main owns domain writes. Maintenance uses separate privileged commands with
bounded scope and the same epoch/receipt/outbox rules. Raw SPARQL Update, Graph Store
writes, administrative configuration and arbitrary `SERVICE`/`LOAD` access are
not client capabilities. PostgreSQL Content/Account/Access/operations remain
separate logical owners. Query/domain modules use typed storage interfaces;
SQL/SPARQL remains inside those adapters.

## Application source positions

Every dataset has stable `datasetId`, a random `dataEpoch` identifying its admitted
write lineage, and an `xsd:integer` `sequence`, exposed as a decimal string. A new
dataset begins at sequence zero. An admitted graph mutation reads the current
sequence inside its write transaction and increments it once, along with its
receipt and outbox batch. The sequence is not a TDB2 transaction ID or content hash.
It orders committed application changes only within the same dataset and epoch.
It is not supplied as a global expected counter on unrelated business edits.

Normal restart preserves the epoch. Restore, destructive reload or cutover that
cannot prove continuity fences the old writer and allocates a fresh epoch before
admission resumes. New-lineage sequence begins at zero; retained old receipts keep
their original positions. Previous-epoch client fences require explicit recovery
resolution or return unavailable; a larger number in a different epoch never
satisfies them. Physical placement has a separate routing epoch.

A read-after-write fence is `{datasetId, dataEpoch, sequence}`. Query the same owner
and include the required epoch/minimum sequence in the same SPARQL request that
reads the data. Return the observed position even for an empty result envelope.
Separate HTTP position and data queries cannot promise one snapshot. The current
state may be newer than the requested minimum; exact historical selection resolves
an immutable component revision instead. Lucene readiness is an additional search
condition, not implied by an RDF fence.

## Transactional command endpoint

Fuseki's standard update handler commits one update request per transaction, and
an unmatched `WHERE` returns HTTP success without a business effect. Jena's remote
RDFConnection does not turn separate HTTP requests into one server transaction.
[Update handler](https://github.com/apache/jena/blob/jena-6.2.0/jena-fuseki2/jena-fuseki-core/src/main/java/org/apache/jena/fuseki/servlets/SPARQL_Update.java),
[remote transaction boundary](https://jena.apache.org/documentation/rdfconnection/#remote-transactions).

Main therefore sends every admitted write to `/rezics/command`, an operation of
the REZICS Fuseki command module. The [toolchain lock](../development/toolchain.md#fuseki-image-and-command-module)
owns its build and qualification gate. The module runs one command in one TDB2
write transaction on the configured text dataset, so jena-text sees exactly the
committed writes. The request is a JSON envelope (protocol version 1):

- `receipt` and `digest`: the receipt IRI and the canonical request digest.
- `update`: one generated SPARQL Update, compiled by Main as described below.
- `validations`: a list of `{profile, sha256, shape, focus[], graphs[], binding?}`
  entries. Profiles are the generated shapes loaded at module startup. For five
  profiles, `binding` supplies exact expected role identities and scalar values;
  the server fixes the allowed keys and predicates for each profile.
- `deadlineMs`: the server-side time limit.

Before execution, module version 0.4.0 admits one bounded named-graph
`INSERT/DELETE ... WHERE` operation or a fresh-control bootstrap `INSERT DATA`.
It rejects default-graph writes, unsupported update operations, arbitrary graph
names and writes to another receipt. For product data it requires nonempty
validations, covers each changed current-graph subject directly or through a
validated revision, and selects canonical shapes for recognized native types.
The default product assembler exposes no raw update or Graph Store endpoint;
the disposable QA assembler alone retains raw update for fault fixtures. This
policy also checks the control epoch, sequence advance, receipt and outbox
invariants. Each domain head still needs its operation-specific guarded update.

Inside the transaction the module:

1. Executes the update.
2. Reads the receipt. If it is absent, the guards did not match: it aborts and
   returns `guard-unmatched`. If the digest differs, it aborts and returns `conflict`.
3. Checks required fixed focus/link bindings, then validates each focus against
   its shape with jena-shacl, over the post-state union of only the listed named
   graphs. An unknown profile or digest mismatch aborts with `unknown-profile`.
   Missing bindings or disallowed keys reject the request. Any graph violation
   aborts with `invalid` and a bounded report.
4. Commits, and returns `committed` with `{datasetId, dataEpoch, sequence}`.

A deadline, transport failure or 5xx leaves the outcome unknown; Main then reads
the receipt as in step 5 below. Validation reads the actual post-state inside the
writing transaction, so no preflight read set has to be guarded for the local
dataset. Guards are still required for exact heads, uniqueness and absence, and
for authority owned outside the graph. `GET /rezics/command` reports the module
version and loaded profile digests; Main checks it at startup.

The command adapter performs these steps:

1. Verify authority and bounded input; derive the receipt IRI from the declared
   idempotency scope/key and retain the canonical request digest. A retry uses the
   same identity and payload. Current authorization still controls disclosure of
   the receipt/result.
2. Read the exact component heads needed to build the change. Verify and durably
   stage immutable payload/manifest bytes before their activation.
3. Compile one guarded update requiring the expected data/routing epoch, exact
   target/component heads, relevant model/shape/dependency heads, and absence of
   the receipt identity. Include create-only/uniqueness predicates and existence
   or absence tests inside that update. Declare the validations that the profile
   requires for every affected focus, including pre-state focuses whose type or
   selector the change removes.
4. Send the envelope. In its transaction the module atomically changes the current
   projection/head, inserts immutable revision metadata and the receipt, increments
   the sequence, inserts one outbox batch and validates. The object upload is not
   part of the RDF transaction; activation references only verified, retained
   bytes. A failed activation leaves reclaimable staging.
5. On `committed`, use the returned position. On `guard-unmatched`, an unknown
   outcome or a lost response, read the receipt through Fuseki: a matching digest
   replays its committed result, and a different digest is a conflict. Never infer
   success from HTTP status alone, an increased dataset sequence or the mere
   presence of a newer resource head. On `invalid`, record the typed rejection
   through the same endpoint with a receipt-absence guard and no validations.

A simplified scalar change illustrates the generated guard. Identifiers and
values below are explanatory fixtures; the adapter serializes RDF terms safely
and generates complete profile-specific payload/dependency records. Production
revision/operation IRIs follow the [identity contract](../contracts/semantic-model.md).

```sparql
PREFIX rv: <https://rezics.com/vocab/>
PREFIX ex: <https://example.org/rezics-command/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DELETE {
  GRAPH ex:current { ex:component rv:head ex:rev-old ; rv:value ?oldValue }
  GRAPH ex:control { ex:product rv:sequence ?n }
}
INSERT {
  GRAPH ex:current { ex:component rv:head ex:rev-new ; rv:value "new value" }
  GRAPH ex:revisions {
    ex:rev-new a rv:RevisionAnchor ; rv:component ex:component ;
      rv:predecessor ex:rev-old ; rv:operation ex:operation ;
      rv:manifest ex:verified-manifest ; rv:modelRevision ex:model-1 ;
      rv:shapeRevision ex:shape-1 ; rv:datasetId ex:product ;
      rv:dataEpoch "epoch-a" ; rv:sequence ?next .
  }
  GRAPH ex:control { ex:product rv:sequence ?next }
  GRAPH ex:receipts {
    ex:receipt rv:operation ex:operation ; rv:requestDigest "request-digest" ;
      rv:outcome rv:Succeeded ; rv:result ex:rev-new ;
      rv:datasetId ex:product ; rv:dataEpoch "epoch-a" ; rv:sequence ?next .
  }
  GRAPH ex:outbox {
    ex:batch rv:dataEpoch "epoch-a" ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ex:event .
    ex:event rv:operation ex:operation ; rv:revision ex:rev-new .
  }
}
WHERE {
  GRAPH ex:current { ex:component rv:head ex:rev-old ; rv:value ?oldValue }
  GRAPH ex:control {
    ex:product rv:dataEpoch "epoch-a" ; rv:routingEpoch "routing-a" ;
      rv:sequence ?n ; rv:modelHead ex:model-1 ; rv:shapeHead ex:shape-1 .
  }
  FILTER NOT EXISTS { GRAPH ex:receipts { ex:receipt ?p ?o } }
  FILTER NOT EXISTS { GRAPH ex:revisions { ex:rev-new ?p ?o } }
  BIND(?n + 1 AS ?next)
}
```

This example assumes the native profile's single-valued head/value invariants.
The production adapter fails closed on malformed cardinalities and verifies the
manifest's bound component, predecessor, model/shape and new value before sending
this update. The verified immutable manifest contains the exact resulting value;
the scalar projection is not the only retained copy. Edits with additional
mutable dependencies add their exact guards. A predicate uniqueness check belongs
inside `WHERE`; a shape check performed earlier cannot create that uniqueness.

If a receipt remains absent and the expected guards still hold, keep the outcome
pending and retry the same command within its deadline. If guards are stale or a
validated failure must be finalized, use a receipt-absence guarded transaction to
record the typed rejection/no-op/cancellation plus its sequence/outbox batch. Guard
any observed state used to choose that outcome. The rejection and an in-flight
original command compete on the same receipt identity: whichever commits first
wins; reread the receipt. Thus a delayed original cannot apply after a terminal
rejection. Storage unavailability remains an unknown result, never proof of failure.
Receipts/replay tombstones obey [command retention](../contracts/commands.md).
A restored epoch does not readmit missing old-lineage operations: reconcile their
prior receipts and external effects before deciding an outcome.

## Validation and large changes

Jena provides SHACL validation APIs and an optional Fuseki validation operation;
configuring a shapes graph or `/shacl` endpoint does not automatically reject
ordinary SPARQL writes. Validation runs inside the command transaction described
above. The module validates only the named graphs each entry lists, never an
indiscriminate union including private or source graphs. Generated TypeScript
schemas may precheck inputs but are not a substitute for the selected SHACL
profile. [Jena SHACL](https://jena.apache.org/documentation/shacl/).
If the module fails its gate, the documented fallback is a long-lived validator
process that keeps preflight validation. In that case the adapter must again
cover the validation read set with guards in its update.

For an ownership tree, all topology changes advance the structure head, so cycle
validation against that exact head remains valid if CAS succeeds. For predicates
whose invariants cannot be represented by a bounded guarded update, stage and
validate an immutable generation and CAS its activation pointer. Do not admit a
new write profile until its concurrent invariants can be enforced. Transactional
validation is a property of the REZICS command module, not of the standard HTTP
update endpoint.

Staged pages have an operation/generation identity and fence. Activation verifies
a complete immutable manifest and expected live dependency heads; incomplete pages
cannot become current. Source captures and unpublished staging remain outside
ordinary product and full-text result scopes. Keep writer occupancy, staged bytes,
query memory/time and queue lengths within [workload budgets](workload-budgets.md).

## Exact history and index recovery

Semantic business revisions are application-owned immutable component payloads
and manifests. Store their metadata as ordinary retained RDF facts and bytes as
immutable objects; resolve by anchor identity. TDB2 compaction copies the latest
RDF view, so old database generations are not the history contract. Retained
revision records survive compaction because they remain part of that view.
[History resolver](../implementation/graph-records.md#revision-anchor-resolver),
[TDB2 administration](https://jena.apache.org/documentation/tdb2/tdb2_admin.html).

Lucene is derived state. jena-text intercepts RDF writes through the wrapper and
connects index work to transaction lifecycle; this design does not claim a proved
crash-atomic commit across TDB2 and Lucene. After a crash, uncertain index failure,
offline load or incompatible analyzer change, mark full-text unavailable and
rebuild from a verified indexed RDF projection under a fenced generation. If that
projection is missing, stale or belongs to another source cut, regenerate it from
retained PostgreSQL Content revisions and graph publication references first.
The [body projection](../contracts/search.md#postgresql-body-projection) owns
cross-owner checkpoints and activation; a graph receipt does not certify body
availability or text-reader readiness.
Reopen search only after source frontier, index configuration and membership checks
pass. Ordinary RDF reads and exact history resolution do not depend on that index.
[Text dataset implementation](https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/DatasetGraphText.java),
[full-text integration](https://jena.apache.org/documentation/query/text-query.html).

## Evidence and qualification boundary

Primary sources reviewed 2026-09-23. The official docs and Jena 6.2.0 source
establish available mechanisms; implementation must pin and review the deployed
release. The guarded protocol, payload manifests and epoch rules are REZICS design
decisions, not engine features or completed experiments.

Before accepting runtime delivery, test competing edits, same/different-digest
retries, zero-match success, lost responses, delayed originals versus terminal
receipts, dependency/profile changes, restart and restored epochs, interrupted
staging, erasure, outbox gaps, and Lucene failure/rebuild. Measure practical
single-writer occupancy and query/index work on the available hosts. This document
does not establish 500M/3B scale, HA, distributed query or historical RDF/Lucene
snapshot equivalence.
