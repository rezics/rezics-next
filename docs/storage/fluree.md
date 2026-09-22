# Fluree storage and query binding

## Selected engine profile

Fluree is the selected native semantic fact store. Pin release, full commit,
binary digest, feature flags, storage format and configuration for each deployment.
RDF 1.1 and JSON-LD 1.1 form the exchange baseline; enable additional RDF/SPARQL,
SHACL and reasoning features only through explicitly qualified profiles.

The v4.2.1 compatibility documentation identifies partial RDF 1.2/update support,
temporal canonicalization and assertion behavior for edge reification. Preserve
original temporal lexicals/offsets and represent unaccepted claims as identified
assertions so ingest does not assert their alleged base edge inadvertently.
These are selected adapter obligations, not a new database-selection exercise.

## Facts and history

Model ordinary values as typed/language literals and references; use identified
occurrences and n-ary relations for repeated/qualified roles. Graph names can
delimit model/native/source/derived data but do not themselves prove permissions
or context. Resource writer ownership is an application contract enforced at
admitted transaction paths.

Use native historical transitions and retained commit anchors for business
revisions. Large payloads are immutable object references. History retention and
GC must preserve every admitted exact reference or explicitly retire it under
policy. Retraction is not byte erasure. No ordinary product revision creates a
database branch or duplicates a full database snapshot.

## Commands and validation

Use guarded exact-target transactions with expected resource/component head,
operation receipt and outbox fact. Verify zero-match/no-op and concurrent retry
behavior against the actual server/embedded entry point. SHACL validates staged
data under the chosen profile; cross-service authority still follows Access.
Privileged storage credentials are not exposed to browsers or user scripts.

## Query and indexing

Queries bind dataset, context, current identity and budgets. Reuse HTTP clients;
separate logical query and transaction endpoints even when one process initially
serves both. Peers can lag: carry source-specific minimum commit fences for
read-after-write. Snapshot pins and current-head freshness are distinct.

Full-text remains an operator/Graph Source in the plan. Track index/novelty lag,
memory, query shape and candidate work. Query peers improve read capacity; they
do not automatically shard one ledger's writes. General operators, DISTINCT memory
and policy/history fast-path restrictions need bounded query admission.

## Evidence and operational qualification

[Compatibility](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/reference/compatibility.md),
[performance tradeoffs](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/design/performance.md),
[query peers](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/operations/query-peers.md)
and [Raft operations](https://github.com/fluree/db/blob/v4.2.1/docs/operations/raft-clusters.md)
inform the binding. Qualify exact commands, failover/restart, history retention,
backup restoration and index-generation changes. A vendor benchmark is not REZICS
concurrency or capacity acceptance.
