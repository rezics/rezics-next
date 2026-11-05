---
goal: semantic
manager: semantic
kind: implementation
---

Complete the canonical identity public binding boundary and native Search acceptance from the original contract.

Owner: services/kernel/src/semantic/README.md, Canonical identity boundary;
docs/architecture.md, Modules and boundaries. Retain the original contract's native behavior and controller acceptance.

The delivered read entry is services/kernel/src/semantic/identity-adapters/read.ts. All eleven declared read callers
use it; their eleven rule-2 baseline exceptions are removed. Keep Content's community-projection core, Content
exclusion/dependency, realm-board-home entry and removed Community exceptions, and Web's checkout/reader-origin.ts entry.

Resolve the binding boundary before adding a re-export facade. The existing baseline identifies these concrete cycles:
access/agent-verification-identity-retention.ts -> semantic/identity-adapters/identity-epoch-binding.ts ->
access/agent-verification-identity-retention.ts; and binding -> index.ts -> binding.
Reversal and both deferred imports in agent-verification-identity.ts also belong to the existing cyclic component.
A new binding.ts re-export would put that new entry and its outgoing edge in the same component. The architecture
checker records every value edge inside a strongly connected component (scripts/architecture.ts, auditArchitecture).
Do not add baseline entries for these new edges. The original contract requires re-exporting existing functions,
forbids relocating unchanged implementations again, and requires an acyclic public entry. The owner must reconcile
that scope with architecture rule 3 before the binding correction can be completed.

Declared binding consumers require identityBindingData, readAcceptedAccountIdentityBinding, readAccountIdentityUndo,
lookupIdentityBinding and type IdentityReceiptBinding. Keep static versus deferred imports and the existing opaque
proof WeakMaps; expose no unrelated custody helpers. Retire the replaced rule-2 binding exceptions only after the
supported entry is in place. Preserve the existing compatibility entries.

Add focused native cases in services/kernel/test/search/account-population-native.test.ts: actual mapped
original/candidate with exact reciprocal stored link and published matching epochs; pending/unavailable and differing
epoch refusal. Exercise readAccountContextBindings or its installed discovery caller, including both observations
around anonymous Subject hydration, active/public disclosure, and detached private advice. Keep verified publication
and exact unverified graph linkage separate. Existing DTO-only account-context tests do not cover this seam.
No tests were changed in the read-only correction. The original boot case already cold-loads the installed roots;
add to it only for a concrete uncovered cold-import failure, preserving DATABASE_URL setup before deferred imports.

Run the original integration acceptance and architecture checks through the controller after completing the boundary.
Contract-named sources read before implementation: docs/architecture.md (Modules and boundaries),
docs/research/engineering-modularity-gpt-6-astra.md (section 4),
docs/research/engineering-modularity-opus-5-5.md (section 4), and the Semantic README canonical identity section.
No main-checkout files were opened or changed.
