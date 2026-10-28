# Performance

## Outcome

People and API consumers receive predictable work bounds as the catalogue, history and tenant population grow.
Contributors can demonstrate those bounds using a shared native growth harness rather than machine speed.

## Done when

- Each read, write, authorization, validation, projection and cleanup path has a derivation identifying its anchors,
  examined work and admitted expansion, linked to a native growth check.
- The shared harness measures statements, examined rows, buffers and other relevant engine work at three seeded
  scales, growing unrelated data and history independently of the selected neighborhood.
- Kernel command execution, keyset reads, receipts, outbox/relays, Access/Auth, semantic/content, search, library,
  commerce, imports, lifecycle jobs and control-plane operations meet their stated bounds.
- Large jobs make bounded resumable progress; denied, empty, deep-page and cleanup paths obey the same principle.
- Filter/source/order plans have derived budgets in honest work units, including preparation, rereads, discarded
  candidates and native disclosure. Returned page size is never the only cost evidence.
- Every violated derivation or growth assertion is corrected with its owner and verified through native acceptance.
  Load-sensitive classification and background work attribution preserve visible diagnostic evidence.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes shared growth measurement, fixtures, cost derivations, hot-path audits and bounded-work corrections across
[public scope](../scope.md). Slow engine constants are distinct from work growing with unrelated data. Wall-clock
thresholds alone do not prove asymptotic behavior. Runtime features remain with their product owners.

## Ownership

Owns `services/kernel/test/support/growth*` and growth suites under module test directories.
The [kernel README](../../services/kernel/README.md), module Cost sections and
[verification](../development/verification.md) describe the evidence. Product-code fixes require coordination with
the owning Goal and one writer per shared path. A shared harness API change is a cross-owner contract.

## Dependencies

Requires native owner operations and realistic fixtures with isolated resources. Other Goals use the common harness
and own their local derivations. Semantic supplies disclosure dependencies; search and commerce expose concrete
admitted plans; performance sets and verifies their budgets. Do not reproduce owner logic inside a benchmark.

## Acceptance

Use [growth harness tests](../../services/kernel/test/support/growth.test.ts), module growth suites and
[import growth](../../specs/imports-growth.test.ts) as applicable through their owning check runners.
Measure at three scales, such as 1×, 8× and 64×, against constant, logarithmic or change-proportional bounds derived
before implementation. Include native examined work, not only call counts. Observe projection/worker work within
its operation context and report independent background work separately without allowing its per-statement cost to
grow with scale. Use [verification](../development/verification.md) for targeted admission, diagnostic reruns,
root typecheck and promoted evidence. Document failures by algorithm, fixture or classifier ownership.

## External conditions

Check capacity and production resource provisioning are external inputs, kept in private configuration. Queue for
shared check admission. Capacity limits do not excuse an unproved bound or convert infrastructure failure into denial.
