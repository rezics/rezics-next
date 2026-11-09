# Search real-worker outcome harness

Status: the harness contract is adopted. Native CJK analyzer and source-to-query/evidence cases live in
`cjk-engine.test.ts` and the retained `index-definition.test.ts` analyzer tokens; they use the check's OpenSearch
node and do not prove the default-worker harness. Adapter tests pin default registrations and starters, Search-only
pause/resume, replacement-runner stop, real Semantic writes and witnesses, rebuild/alias/cursor recovery,
observable consumer checkpoints, drain, and concurrent fixture isolation. Adapter cursor recovery uses the
production Search service bound to the worker-owned prefix and generation. Default
Search starts the trending timer plus one runner, so adapter defaults require
`startedServices.search` to exceed that single runner invocation. Public rating-sort consumption
remains the existing native-rating-outcomes suite. Native execution of those suites, frozen Search API
suites against this driver, production scope activation and promotion remain pending. This document is not
evidence that the proof passed. The [Search contract](../../src/search/README.md#visibility-completeness-and-convergence), [Semantic witness and dependency design](../../src/semantic/relation-facets-design.md), and [durable rebuild design](../../src/semantic/relation-facet-rebuilds-design.md) remain authoritative for their product behavior. Research rationale is in the [visibility report](../../../../docs/research/search-visibility-witnesses.md) and [worker harness report](../../../../docs/research/search-worker-outcome-harness.md).

Keep analyzer-token results, native source/query/evidence results and the six-path seeded browser journey as
separate acceptance records at the checked revision. The CJK source case independently reads the current source
after its revision changes and before indexing, so stale-hit rejection is distinct from successful writer refresh.
Its locale switches retain original-language evidence, and folded prefixes compare installed suggestions with
current disclosure. `current-text.test.ts` and `engine-analysis.test.ts` pin malformed third-party replies locally;
typing or the presence of these cases supplies no native or browser pass.

## Process and resource ownership

The test parent creates one isolated fixture supervisor for each `SearchDriver` factory invocation. That supervisor
reuses the real Semantic Auth and database fixture provisioning; the child uses the real kernel composition. The
supervisor owns the Auth SDK and fixture-level Auth binding; a separate child owns the kernel SDK and runs the real
default worker. Launch each runtime-owning SDK once in its own process. Keep the kernel SDK out of the Auth supervisor
process.

Add only test-support lifecycle/resource hooks to the existing Semantic provisioning. Default callers retain their
current behavior. In external-link mode, the worker is the sole owner of the link relay, so the supervisor does not
start a duplicate. Record both owned process identities and database/index names before creating resources, so a
failed startup still leaves enough ownership metadata for cleanup. Stop and drain the worker and supervisor-owned
Auth before closing fixture pools or deleting databases and indices.

The current [Semantic outcome driver](../semantic/outcome-driver.ts) provides the provisioning to adapt; its
process-global fixture cleanup and independently started link projection do not satisfy this ownership contract.
The [Auth fixture](../semantic/outcome-auth.ts) keeps Auth's SDK in the supervisor.

## Run and observe the default worker

The callable composition entry is [`createKernelWorkModules`](../../src/composition/work-modules.ts). In the worker
child, call `startWorker` and decorate that live list: `startWorker` invokes `createKernelWorkModules` with Content
ambient (clock, fetch, identity) and the same producer/Semantic composers the production worker uses. Decorate every
default registration in place; preserve the full list, order and configuration; invoke each original `register`
exactly once; do not filter, replace, or import a second pre-built module list. Observe service starters only when
the real [`composeWork`](../../src/work/registry.ts) invokes them after SDK launch. Registration may create a starter
without running it; do not manually invoke dormant Semantic factories.

Capture the real Search runner through its original starter in [search/work.ts](../../src/search/work.ts). Keep a
stable lifecycle slot whose stop operation always targets the currently active runner, including a replacement
created by resume. Adapt [worker.ts](../../src/worker.ts), [the current Search outcome driver](outcome-driver.ts),
and [worker test environment](../support/worker-env.ts) without changing the default callers' behavior.

The runner returns its owned stop handle before the initial native inventory completes. That inventory uses the
same installed production Search and Semantic owners under a runner-scoped cancellation signal. Stop aborts native
requests and drains admitted work; worker service startup does not certify current Search output. The default
discovery integration test must continue through a useful current page and retained continuation.

Pause drains and stops only Search through its captured starter. Resume starts only Search through that same real
starter. DBOS, the worker, default registrations, Semantic services and relays continue running. Rebuild uses the
real `rebuildSubjects`, the child's real source, partition counts and OpenSearch client, and the active runner's
real `refresh` method. Keep the node connectivity proxy, real clocks, scopes, session headers and actual kernel
responses. Do not add fake sources, schedule deletion, accelerated clocks, a second indexer or a production admin API.

## Private IPC and cleanup

Use private plain-data IPC with request IDs and explicit operation completion. The child announces readiness only
after installing its RPC listener; the parent sends init and starts its operation deadline after that handshake.
Every command has a bounded deadline; responses carry either the actual result or an explicit serialized error. A
send acknowledgment or process signal is not completion. Await child exit and drain both stdout and stderr for
startup, operations and shutdown, retaining diagnostics on failure. Child exit, disconnect, send failure, startup
rejection and deadline expiry reject pending operations; none becomes an empty successful result.

Cleanup attempts all owned stages and preserves the original failure. The worker must stop before its owned pools,
indices or databases are closed or deleted, and Auth must stop before its fixture resources are removed. Forced
termination after a failed graceful deadline may permit cleanup only after confirmed exit; it never proves that
services drained. Repeated close shares completion, and parent/supervisor disconnect initiates cleanup of their
owned child.

## Required proof and current limits

The [frozen Search API suites](../../../../specs/search-outcomes.test.ts) and [relation-facet API suite](../../../../specs/search-relation-facets.test.ts) must execute unchanged against this driver with every declared case run, zero skipped/todo cases and the real default registrations active. Verification must also confirm registration names/order/count, one launch per SDK-owning process, real post-launch starter execution, and a real Semantic command whose relation witness is observed through Search.

The Search and relation-facet wrappers use `outcome-driver.ts` and the private `DriverClient` supervisor. Its child decorates the live `createKernelWorkModules` list supplied by `startWorker`, invokes each original registration once, and captures Search only through the real post-launch starter. The [Semantic source fixture](../semantic/relation-facet-source.test.ts) and other controlled source/unit fixtures prove only their own layer. The wrappers still require native execution; composition and typing alone do not prove the real-worker claim.

The final proof must include Search-only pause/resume, replacement-runner stop, worker drain, restart recovery, real node-proxy outage and recovery, real rebuild with cursor/generation behavior, and finite witness convergence using actual API responses and real elapsed-time deadlines. It must exercise startup failure and sequential and concurrent fixtures, proving one fixture can close without affecting another and that owned resources are gone only after drain. Rebuild and restart must use production paths, not injected engine/source results or direct index writes.

Until these suites and lifecycle/convergence checks run against the integrated worker, keep real-source and composition verification explicitly pending. A passing specification, controlled fixture, starter construction, send acknowledgment or process signal is not a passing end-to-end outcome.

Default-worker erasure inventory is the live OpenSearch subject generations; empty settings are no-data, and discovery Account copies stay on their own purge. Native wrappers still wait for Semantic's all-home source proof before Search ACK.

`coverage-default-worker.test.ts` requests the ordinary native rebuild without waiting for publication,
retains its job and physical UUID, drains and restarts the owned worker against the same databases and
prefix, and loses one real alias response after OpenSearch has applied it. Each child launches the complete
default registrations once. Serving reads continue during replacement. Final observations require the
native final pass for all homes and complete engine identities and settled external versions, including
engine extras; legacy coverage certificates and equal counts do not stand in for native publication. Its
read-only receiving oracle records a digest of all 4096 native home epochs and positions, verifies that digest
against `core.partition`, and compares it with the Source revision captured before rebuild. Current projection,
checkpoint convergence, native receiving and recovery therefore refer to one unchanged Source cut. The digest
supplements those real-worker assertions; it does not certify worker convergence, generation activation or current
public output by itself.
The publication suite separately pins filtered/terminal native cursors and maintenance resumption, and
the metadata suite pins released calendar metadata under an applied-but-lost write response.

Native identity receiving suites construct `searchIdentityReceivingComposition` and run each step inside
Semantic's Source maintenance frame. They consume published mappings and the resolved public-filter
definition; a missing mapping is unavailable, not a self binding. Collection source setup composes the
Library domain through `composeLibraryDomain`; Collection create does not invent a Search presentation
path. Cutover keeps Collection create on the owner account through own-account commands and JWT
scopes, and mounts follow:create/delete as own-account so follow writes keep the verified Access
actor. access.grant of collection:* onto the owner-account resource is denied because
collection:create is typed to library.collection. Accounts original-funded transfer is
observed on the next native run.
