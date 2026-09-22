# Access placement and interaction research

Placement evidence reviewed 2026-09-22; architecture reconciled 2026-09-23.
The bootstrap hosts Access inside Main and stores ordinary durable likes/favorites
in the Jena product dataset (Fuseki + TDB2). The owning
[interaction and cache blueprint](../implementation/interactions-and-cache.md)
contains the graph representation, guarded HTTP commands, application receipts/
outbox, Redis progression and limits. PostgreSQL remains private authority storage;
an additional interaction authority is a later workload-driven alternative.

## Access evidence

| Source | Finding and applicability |
| --- | --- |
| [Zanzibar, USENIX ATC 2019](https://storage.googleapis.com/gweb-research2023-media/pubtools/5068.pdf), sections 4.1–4.2 | A remote authorization service can meet low-latency goals. Its measured Safe/Recent Check p95 values were 9.46/60.0 ms, illustrating freshness costs; these are historical server-side results, not our request budgets. |
| [OPA deployment guidance](https://www.openpolicyagent.org/docs/deploy) | Locating evaluation near enforcement reduces network dependencies; central service placement has other scaling/operational benefits. |
| [Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html) and [Rust library](https://docs.rs/cedar-policy/latest/cedar_policy/) | In-process policy evaluation is feasible, but the application still supplies complete and current entity data. This does not select Cedar for REZICS. |
| [SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency) | Minimum-revision tokens and cache tradeoffs inform the freshness protocol; a token is not knowledge of all later revocations or a cross-store transaction. |

## Access recommendation: a Main module with an explicit interface

Use `services/main/src/modules/access/` for grant commands, decision evaluation,
private storage and freshness/fence handling. Other Main modules call its typed
interface in process. Keep Account independently responsible for authentication,
credentials and OIDC. Keep Access's schema/migrations and permission definitions
owned and testable even while it shares Main's executable.

Compare the alternatives before extracting another process:

| Placement | Advantage | Cost | Initial choice |
| --- | --- | --- | --- |
| Inside Main | Avoids the Main-to-Access RPC and duplicate request serialization; allows request-scoped reuse. | Shares CPU, memory, failure and release lifecycle with Main. A module is not a security sandbox against compromised Main code. | Recommended while Main owns the principal protected workflows. |
| Sidecar/local daemon | Separates runtime/language and some resource management while staying near Main. | Still IPC, another lifecycle and synchronization path; data loading remains. | Use if an engine/runtime boundary justifies it. |
| Independent remote service | One policy service for many independently deployed consumers; independent scaling and release. | RPC, queues and failure handling on the decision path; cache/freshness remain necessary. | Revisit when those benefits are observed requirements. |

The saved boundary should make later extraction possible, but the first deployment
does not have to pay for it. Package runtime and workers use Main's admitted
operations or a protected Main-hosted bulk-decision endpoint when their own effects
need a decision. They receive scoped decisions with bounded validity, not direct
database access. Long-running work revalidates at the required activation boundary.

### Hot-path rules

- Verify authentication assertions locally where the protocol permits, subject to
  Account enforcement freshness. Do not introduce a remote login/session request
  for every graph node or every item in a response.
- Load relevant grants, target descriptors and epochs in bounded batches. Reuse
  the verified subject/context and decision inputs within a request. Cache keys
  include subject, action, context, scope and relevant generations.
- In-process evaluation removes one RPC, not PostgreSQL I/O, policy traversal,
  Fuseki I/O or query cost. A cold request may still need authoritative reads.
- Cache invalidation events alone cannot prove strict revocation. An initial
  simple admission path can read the authoritative fence with its required data.
  Any cross-request cached allowance requires a qualified freshness/lease protocol;
  on an unprovable fence it refreshes or fails closed. A strict revoke closes new
  admissions and drains/cancels prior work before acknowledging its stronger effect.
- Multiple Main replicas are separate evaluators. All must respect the same
  authoritative fence protocol; a mutex in one process cannot fence another.
- Preserve the [Jena bridge](../implementation/authorization-bridge.md): protected
  facts, intermediate matches, counts and ranking require admitted policy inside
  the query plan. A local Access module does not automatically execute inside the
  separate Fuseki JVM. Main compiles only admitted graph/text patterns; there is
  no inherited Fluree policy engine. Qualify graph/subject restriction before
  protected text matching and statistics isolation; private text remains gated
  until then. Avoid per-fact RPCs and final-page-only authorization.

## Remaining qualification

Compare in-process, local daemon and remote evaluation with identical policies and
freshness guarantees, warm/cold caches, bounded result pages, grant churn and mixed
content traffic. Measure end-to-end tails, database/network calls and resources.
Extract a process only for a demonstrated consumer, isolation or scaling requirement
within the chosen latency budget. No Access performance test has been run here.

Interaction authority is no longer an unanswered directory-layout question: use
the [Jena bootstrap](../implementation/interactions-and-cache.md). Its Jena runtime gates remain unexecuted. The
[eleven historical Fluree checks](retired-interaction-engine-evidence.md) establish
no Jena behavior, production throughput, privacy or Redis correctness. The blueprint names evidence that could justify
another store and the contracts its projection would need.
