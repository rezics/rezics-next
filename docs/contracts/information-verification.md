# Claims, evidence and information verification

Status: source lineage, claim analysis and bounded summaries have owner slices;
general verdict, quality-query and campaign qualification remain prospective.
[FACT01–06](../../scripts/qa/cases/information-verification.ts) retain their
existing evidence; added combinations remain explicitly pending.

## Model

A claim is a precise proposition with referent, context, edition and valid time.
Provenance describes observations and derivation; source reliability applies to a
domain/context; claim support evaluates exact evidence; acceptance selects a result
in an owning context. None substitutes for another. Protection remains an
independent [editorial decision](editorial-protection.md): a lock does not verify a
claim, and a quality change does not authorize replacing adopted content.

## Quality dimensions and records

The [owner schema](../../services/main/src/modules/verification/schema.ts) binds
lineage, evidence-set revisions, dispositions, challenges, summary generations,
dependency heads and invalidation effects; graph claims and assessments remain
exact owner records. Preserve source availability, qualification, review, dispute,
coverage and freshness separately. Reviewed and disputed can coexist. Unknown
dependence is not independent support; a missing payload or stale assessment is
not a negative verdict. Public provenance cannot expose private source bytes or
principal/control identities. Ordinary scalar values need no preallocated quality
record. RDF 1.1 is the admitted exchange profile; RDF 1.2 is a later choice.

## Workflow and methods

Acquire, propose, resolve, assess, review/adopt, then publish. AI output records
inputs and method and cannot grant itself authority on re-ingestion. Methods need
declared applicability, cost, coverage and held-out calibration. A challenge is
pending until qualified assessment; withdrawal removes only that source's support.
Preserve exact older assessments and independent support. Editorial confirmation
does not clear [source rights](source-lifecycle.md).

## Summary policy and freshness

The [analysis](../../services/main/src/modules/verification/analysis.ts) abstains
on incomplete, circular or over-budget lineage. A versioned summary retains
support, review, dispute, coverage, dependence, reason codes and exact dependency
positions. Activation checks heads atomically; reads cannot call a queued old
summary current merely because invalidation delivery lags. Paginate reverse
dependency work with resumable cursors; never label a truncated prefix complete.
Scores are method output with calibration limits, not bare fact probabilities.
Restored summaries require reconciled withdrawal, authority and erasure frontiers.

## Planned API and cost contracts

Claims, evidence, source assessments, claim assessments, challenges and quality
queries require exact mutable-head expectations, idempotency, Access/disclosure and
bounded work. An omitted head differs from explicit absence. Reject over-budget
input without partial adoption; resolve uncertain commits by receipt. Keep external
fetch and model evaluation outside the Jena writer. Scalar evidence/rating ceilings
are 32 each; ordinary pages and quality queries cap at 50 targets, with separate
dependency and byte budgets. Large campaigns need complete staged manifests and
engine-plan, writer-time, queue-lag and cold/skewed-read qualification.

## Activation and boundaries

Method evaluations must report held-out errors, calibration, coverage and
abstention; deterministic policy tests alone cannot qualify a method. Exports
retain exact policy, provenance, uncertainty and disclosure losses. Funding and
subscription status cannot buy a verdict. Untrusted source/tool content stays data.
