# Package management intent

REZICS catalogs software and mod packages, resolves dependencies, locks exact
artifacts, and manages controlled installation, update, rollback and removal.
A common workflow must preserve each ecosystem's native identity, version order,
dependency meaning and instance scope. Package URL is an exchange identifier;
matching names or versions do not prove equivalent bytes or rights.

Resolution binds a declared environment, policy and source snapshot. Source gaps,
unsupported clauses, cancellation and exhausted budgets remain distinct from an
unsatisfiable graph. A lock binds exact selections and evidence; a Main Version
recommendation alone cannot authorize an artifact or executable effect. Mutable
references need exact observed evidence before they enter a lock.

The admitted profiles and their remaining boundaries are in [package ecosystem
profiles](package-profiles.md). The current Cargo solver is TypeScript in Main;
there is no separate Rust package runtime. [Exact lock](../../services/main/src/modules/package/lock.ts)
and [controlled installation](../../services/main/src/modules/package/install.ts)
own the implemented workflow. [Package cases](../../scripts/qa/cases/packages.ts)
and [source conformance](../testing/source-conformance.md) retain the native
comparisons and provider coverage.

Installing a package never grants permission to execute its scripts. The local
installer admits verified artifacts, confined staging and explicit hook approval;
the [executor](../../services/main/src/modules/package/install-hooks.ts) has a
declared capability and resource profile. Wider native installation adapters,
generic candidate discovery and persistent hostile-code hosting need separate
admission. [Execution decisions](../research/ai-hub-execution.md) record the
hosting boundary and its unresolved isolation and recovery choices.
