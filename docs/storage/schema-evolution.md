# Model, schema and index evolution

## Independent versions

Version semantic definitions, operation contracts, storage bindings, API schemas,
analyzers and deployment builds separately. A release manifest pins a compatible
combination. A new storage index does not change predicate meaning; changed meaning
requires a new definition or explicit migration that preserves historical readings.

The TypeScript model IR is the source for admitted semantic/value/language profiles,
generated SHACL, types, runtime schemas and JSON-LD contexts. Storage adapters bind
that meaning to RDF and PostgreSQL; SQL migrations and projection recipes are
versioned alongside it. Predicate identity/definition evolution is separate from
localized label revisions. A new community predicate must not require an unbounded
set of per-predicate SQL columns or search mapping fields.

## Evolution protocol

Prepare definition/context/shape changes, determine affected predicates/operations,
stage conversion with retained source evidence, validate bounded samples and full
required coverage, then activate a generation with expected heads. Unknown values
remain explicit residuals, never discarded to satisfy a new validator. Long jobs
resume with fences and do not overwrite intervening human edits.

Jena stores ontology/shape/profile metadata as ordinary RDF; schema publication
does not automatically validate or migrate stored data. Validate candidate states
explicitly, guard the selected profile/dependency heads during activation, and
retain model/shape references in immutable revision manifests. TDB2 internal file
generations and application revision/generation IDs are independent. PostgreSQL owners use forward migrations
and disposable replay. Object formats have versioned readers/writers. Search
changes build a new generation and switch only after catch-up and comparison.

## Editorial protection activation

Activate [editorial protection](../contracts/editorial-protection.md) as a
versioned owner/operation profile after its schemas and all admitted writer paths
enforce the same state transitions. Generate types, schemas, shapes and API
contracts from the owning IR during implementation; editing this contract does
not install those artifacts or make the planned routes callable.

For an already populated owner, introduce sparse protection/control heads with
explicit default/absence semantics. Preserve exact previous revisions and
source/application receipts. Classify source-managed eligibility only from a
proven binding and current source-controlled basis; ambiguous history cannot
authorize automatic overwrite. Do not mark existing content human-reviewed or
verified merely because a migration ran. Once a protection record exists,
relaxation appends a revision rather than deleting it back to an implicit default.

Fence incompatible writers before enabling protected targets. An older API or
worker profile missing required protection/control expectations must be rejected
or routed through a qualified adapter that supplies and enforces the same proof;
it cannot continue as an unchecked fallback. Root-scope support, additional target
kinds and larger evidence manifests each need explicit profile qualification.
Test interrupted conversion and held restoration of a pre-protection backup;
backfill cannot overwrite a concurrent human edit or erase a later restriction.

## Compatibility and recovery

The redesign has no legacy-system compatibility or online-transfer obligation.
Within the new released system, define reader/writer compatibility windows and
forward recovery. Downgrade across incompatible engine formats restores a qualified
snapshot rather than opening new files with an old binary. Back up data, metadata,
keys and manifest before upgrade; test failure halfway through conversion.

Keep normative vocabulary dependencies pinned for compilation. Live-provider
conformance refreshes upstream inputs each run. Per-run tool/source capture makes
failures reproducible without permanently freezing external versions.
