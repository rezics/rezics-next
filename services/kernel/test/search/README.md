# Search real-worker outcome harness

Status: the harness contract is adopted. Adapter tests pin default registrations and starters, Search-only
pause/resume, replacement-runner stop, real Semantic writes and witnesses, rebuild/alias/cursor recovery,
observable consumer checkpoints, drain, and concurrent fixture isolation. Adapter cursor recovery uses the
production Search service bound to the worker-owned prefix and generation. Public rating-sort consumption
remains the existing native-rating-outcomes suite. Native execution of those suites, frozen Search API
suites against this driver, production scope activation and promotion remain pending. This document is not
evidence that the proof passed. The [Search contract](../../src/search/README.md#visibility-completeness-and-convergence), [Semantic witness and dependency design](../../src/semantic/relation-facets-design.md), and [durable rebuild design](../../src/semantic/relation-facet-rebuilds-design.md) remain authoritative for their product behavior. Research rationale is in the [visibility report](../../../../docs/research/search-visibility-witnesses.md) and [worker harness report](../../../../docs/research/search-worker-outcome-harness.md).

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

In the worker child, call `startWorker` with the imported [default module list](../../src/work/modules.ts). Decorate
every imported default registration in place: preserve the full list, order and configuration, invoke each original
`register` exactly once, and do not filter or replace registrations. Observe service starters only when the real
[`composeWork`](../../src/work/registry.ts) invokes them after SDK launch. Registration may create a starter without
running it; do not manually invoke dormant Semantic factories.

Capture the real Search runner through its original starter in [search/work.ts](../../src/search/work.ts). Keep a
stable lifecycle slot whose stop operation always targets the currently active runner, including a replacement
created by resume. Adapt [worker.ts](../../src/worker.ts), [the current Search outcome driver](outcome-driver.ts),
and [worker test environment](../support/worker-env.ts) without changing the default callers' behavior.

Pause drains and stops only Search through its captured starter. Resume starts only Search through that same real
starter. DBOS, the worker, default registrations, Semantic services and relays continue running. Rebuild uses the
real `rebuildSubjects`, the child's real source, partition counts and OpenSearch client, and the active runner's
real `refresh` method. Keep the node connectivity proxy, real clocks, scopes, session headers and actual kernel
responses. Do not add fake sources, schedule deletion, accelerated clocks, a second indexer or a production admin API.

## Private IPC and cleanup

Use private plain-data IPC with request IDs and explicit operation completion. Every command has a bounded deadline;
responses carry either the actual result or an explicit serialized error. A send acknowledgment or process signal is
not completion. Await child exit and drain both stdout and stderr for startup, operations and shutdown, retaining
diagnostics on failure. Child exit, disconnect, send failure, startup rejection and deadline expiry reject pending
operations; none becomes an empty successful result.

Cleanup attempts all owned stages and preserves the original failure. The worker must stop before its owned pools,
indices or databases are closed or deleted, and Auth must stop before its fixture resources are removed. Forced
termination after a failed graceful deadline may permit cleanup only after confirmed exit; it never proves that
services drained. Repeated close shares completion, and parent/supervisor disconnect initiates cleanup of their
owned child.

## Required proof and current limits

The [frozen Search API suites](../../../../specs/search-outcomes.test.ts) and [relation-facet API suite](../../../../specs/search-relation-facets.test.ts) must execute unchanged against this driver with every declared case run, zero skipped/todo cases and the real default registrations active. Verification must also confirm registration names/order/count, one launch per SDK-owning process, real post-launch starter execution, and a real Semantic command whose relation witness is observed through Search.

The [existing Search wrapper](outcomes.test.ts) and [relation-facet wrapper](relation-facet-outcomes.test.ts) currently use `outcome-driver.ts`, which invokes a captured starter outside `startWorker` and the full default module composition. The [Semantic source fixture](../semantic/relation-facet-source.test.ts) and other controlled source/unit fixtures prove only their own layer. None of those alone proves the real-worker claim.

The final proof must include Search-only pause/resume, replacement-runner stop, worker drain, restart recovery, real node-proxy outage and recovery, real rebuild with cursor/generation behavior, and finite witness convergence using actual API responses and real elapsed-time deadlines. It must exercise startup failure and sequential and concurrent fixtures, proving one fixture can close without affecting another and that owned resources are gone only after drain. Rebuild and restart must use production paths, not injected engine/source results or direct index writes.

Until these suites and lifecycle/convergence checks run against the integrated worker, keep real-source and composition verification explicitly pending. A passing specification, controlled fixture, starter construction, send acknowledgment or process signal is not a passing end-to-end outcome.
