# Graph records, shapes and history resolution

## Namespaces and identity

Native Resource IRIs use `https://rezics.com/id/{uuid}`; application predicates
use `https://rezics.com/vocab/`. Keep the compact resource prefix `rezics`
distinct from `rezics-vocab` or `rv`. The
[compiler guard](../../model/compiler/ir.ts) pins these bindings in authored
profiles. A reviewed JSON-LD context may abbreviate terms but cannot grant
authority, replace a writer or redefine a protected predicate at request time.
Captured external context bytes remain source evidence.

## Qualified records and transaction

The [authored definitions](../../model/definitions/) specify admitted Work,
MainVersion, Context, Statement, relation occurrence, decision, revision and
source shapes. Identified `rdf:Statement` claims and their independent decisions
may yield different outcomes in different Contexts; the base edge is not a
Global fact. A Statement pins speaker and applied definitions. A shared Context
can have independent Realm and personal consumers without sharing edit authority
or voter population. The [Context](../contracts/context.md) and
[classification](../contracts/classification.md) contracts state the remaining
meaning decisions; [MODEL/CTX cases](../../scripts/qa/cases/) name the checks.

The owner selects the required pre-state and post-state focuses and affected
dependents. The [command module](../storage/jena.md#transactional-command-endpoint)
validates the proposed named-graph post-state inside its guarded TDB2 write,
then commits projection, anchor, receipt and outbox together. A shape, stored
`shapeRef` or optional Fuseki `/shacl` endpoint does not validate ordinary raw
updates. Source observations may remain incomplete outside accepted native
state. PostgreSQL, immutable object upload and later HTTP effects have separate
transaction boundaries.

## Immutable revision representation

Content retains its authoritative revision, manifest and bounded bytes in
PostgreSQL. Semantic owners retain anchor metadata in TDB2 and seal exact
manifests/payloads in immutable object storage. These are two adapters for one
logical history contract, not duplicate copies of Content history. TDB2 MVCC
generations are not permanent public revision IDs.

An anchor binds component, predecessor, operation, model/shape references and
original source position. A format-versioned manifest binds exact payload roots,
digests, byte sizes, encoding and any pinned dependent revisions. Activation is
the owner-local receipt; a prepared object alone is invisible. SHA-256 checks
stored bytes, without claiming semantically equivalent RDF has the same digest.
The payload preserves exact occurrence IDs, typed/language lexicals and selection
modes. Mutable contexts cannot be fetched to reinterpret old payloads.

Large components use bounded immutable pages under a complete root manifest;
edits replace affected pages and ancestors, rather than replaying an unbounded
delta chain. A fixed release pins selected transitive dependencies. A stable
resource reference alone does not become a fixed snapshot, and a multi-dataset
manifest does not claim a globally atomic historical instant. Owners must set
page, fan-out, byte and traversal budgets before admitting larger profiles.

## Revision-anchor resolver

The logical owner routes exact revision reads and verifies anchor binding,
manifest format, retained bytes and digests under current disclosure/erasure
policy. [Work history](../../services/main/src/modules/work/history.ts) and
[semantic reads](../../services/main/src/modules/semantic/read.ts) implement
their admitted components. Reads never reconstruct an old state from the current
projection or silently follow HEAD. A missing committed object is unavailable
or corrupt and enters recovery; `pending` applies only to a staged operation.
Batch resolution has fixed item and byte limits, with no per-result lookup loop.

Retained anchors pin required payloads and exact dependencies through GC and
relocation. Erasure may make a reference unavailable and leave a permitted audit
marker, never retarget it. Restore makes a new revision after current validation.
Moving storage verifies registry and objects before retiring the old owner;
original receipt positions keep their epoch and sequence. Historical
cross-component analytics need admitted manifests or materializations, not a
SPARQL time-travel parameter. See [structure history](../contracts/structure-history.md).

## Query request shape

The installed [graph query schemas](../../services/main/src/modules/graph-query/schema.ts)
admit bounded relation and Statement pages with exact definition/role filters,
authority checks, continuation source positions and declared work limits. A
broader compound query descriptor would need its own typed schema, trusted
lowering, deterministic tie-break, dataset/context/authority budget, source
snapshot and explicit completeness result before admission. Result count cannot
be inferred from a full page; changing a viewer preference cannot rewrite an
authored Statement or saved exact filter.
