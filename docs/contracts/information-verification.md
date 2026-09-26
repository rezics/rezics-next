# Claims, evidence and information verification

Status: adopted target contract, expanded 2026-09-26. The general verification
records, quality queries and reassessment workflow remain unqualified. Existing
source observations/title support do not implement every obligation below.

## Model

A Claim is a precise proposition with referent, context, temporal scope and exact
meaning. Source observations provide evidence; Assessments record a method's
evaluation; Acceptance selects a result under a policy. Source-supported data
can be queried before a verdict exists. A popular classification or vote is not proof.

Evidence identifies exact observations, spans/selectors, origin lineage and
known dependencies. Repeated syndicated/AI-derived copies are not independent
corroboration. Preserve counterevidence, uncertainty, inaccessible sources and
unknown dependence. Use PROV-compatible activity/entity/agent links where suitable.

Keep quality independent of [editorial protection](editorial-protection.md):
locking a value does not verify it, human takeover does not prove it, and a
quality downgrade does not authorize replacing it. A protected adopted value can
remain disputed while its correction is reviewed.

## Quality dimensions and records

| Dimension | Required representation |
| --- | --- |
| Provenance | Exact observation/representation, selectors, acquisition/observation time, method, responsible Agent and known derivation/quotation/primary-source links. |
| Source reliability | A versioned assessment keyed by source, domain definition and evaluation context, with applicable interval, method and rationale. No universal reputation number follows from one reliable field. |
| Claim support | Support, counterevidence, coverage and known/unknown source dependence for one exact claim revision. Count independent origins only when the evidence establishes them. |
| Value qualification | Precision, approximation, disputed attribution, valid time and other uncertainty belong to the value/claim's meaning; a display badge cannot replace them. |
| Review and acceptance | Review status, dispute status and the context's exact adoption decision remain separate. Reviewed and disputed can coexist; rejection/deprecation retains its reason. |
| Freshness | `current`, `stale` or `pending` relative to declared exact dependencies and owner positions. Missing input does not become a negative verdict. |

Use logical records through the existing model IR and history adapters:

- `EvidenceSetRevision` binds a complete admitted set/manifest of supporting,
  contradicting and uncertain evidence, its predecessor and known dependence.
- `SourceReliabilityAssessment` retains the source/domain/context, exact inputs,
  method/profile/calibration revision, result, limitations and predecessor.
- `AssessmentRevision` binds the claim revision, evidence-set revision, exact
  source assessments, method/version, policy revision, coverage, result and limits.
- `QualitySummary` is a rebuildable projection keyed by target/context and exact
  adopted revision. It carries the assessment, policy revision, dependency
  manifest/digest, owner positions, summary generation, reason codes and freshness.
- `AcceptanceDecision` selects an exact result in its owning context. Reuse an
  existing selection/decision rather than duplicating its authority in a quality
  record; [protection](editorial-protection.md#record-contracts) binds corrections.

Immutable observations may be PostgreSQL-owned; semantic claims, assessment
anchors and acceptance follow their Jena owner. Preserve exact owner references,
retention and disclosure; do not copy private source bytes or principal/control
identities into publicly queryable provenance. An absent or inaccessible evidence
payload remains explicit even when its permitted anchor is retained.

Ordinary adopted scalar values remain direct predicates. Add identified claims
and evidence records where source qualification, contest, independent provenance
or review requires them; do not reify every fact or preallocate quality rows for
the full corpus. A component summary only summarizes that declared component and
coverage, never every field on the Resource. First delivery retains the admitted
RDF 1.1 exchange profile; RDF 1.2/reifier qualification is a separate profile
choice, not a dependency of this feature or a proven storage saving.

## Workflow and methods

Acquire -> extract/propose -> resolve correspondence -> assess -> review/adopt ->
publish quality-indexed result. AI extraction proposes data and records inputs,
model/tool/profile versions and limits; it cannot grant itself authority or make
its output an independent source on re-ingestion. Methods have applicability,
coverage, cost and calibration contracts. Human and automated assessments coexist.

Assessment revisions cite exact claim/evidence/method state. Corrections or
withdrawals schedule bounded dependency invalidation and reassessment. Preserve
independent support, earlier reasoning and explicitly superseded outcomes. A
source unavailable now is not automatically false; confidence is not a truth flag.

Source-derived propositions identify the relevant edition/version and valid time.
A newly announced release date, for example, may describe changed circumstances
rather than prove that a previously recorded announcement was false. Preserve
these distinctions before grouping claims as conflicting or corroborating.

Unknown source dependence is not independent support. Detect and retain circular
derivations within the declared analysis budget; abstain/report incomplete work
when a dependency closure cannot be established. Multiple pages, domains, models
or accounts do not themselves establish separate origins. A domain policy may
accept a suitable primary record without two independent sources; no universal
source-count or vote threshold establishes truth.

A submitted challenge records a precise target/evidence and `pending` review,
not an immediate authoritative `disputed` or false verdict. A qualified human or
automated assessment under an admitted policy may establish material conflict.
Preserve the challenge and counterevidence according to disclosure rules while
preventing a submitter from granting its own verdict authority. Resolving a
dispute appends a decision; it does not erase the earlier disagreement.

Replacing a protected adopted result uses the exact proposal/decision protocol in
[editorial protection](editorial-protection.md#operations-and-state-transitions).
Corrections keep their earlier assessment/acceptance history. Source withdrawal
removes that source's support only; independent native confirmation, other source
support and unrelated contexts survive. Editorial confirmation is not rights
clearance under [source lifecycle](source-lifecycle.md).

## Summary policy and freshness

Derive a reader-facing quality summary with a versioned deterministic function
over exact inputs. Retain support, review, dispute, coverage and freshness even
if a consumer requests one display tier. The policy has explicit unknown and
abstention outcomes, applicability and reason codes. A review badge must not
conceal an unresolved dispute or stale evidence. Never treat `sealed` as a quality
tier or let payment change the result.

Model scores belong on the Assessment with task, method/model version, labeled
evaluation/calibration references and uncertainty. They are not stored as an
unqualified probability on an accepted fact. Source reliability and claim support
can use different scales; any conversion is an explicit, validated method.

The dependency manifest includes the claim/adopted revision, evidence-set head,
source-reliability/disposition revisions, required rule/policy heads and any
acceptance input used by the policy. A digest identifies those inputs but does
not prove complete coverage. Local activation compares the exact dependency
heads and atomically publishes the new summary generation/receipt; a stale worker
cannot overwrite a newer assessment.

Changing a dependency records durable invalidation work with the owner's event.
Use indexed reverse dependencies, deduplicated paged work and resumable cursors;
do not synchronously rescan all claims that use a popular source. Reads check
the summary's bounded dependency heads and required producer/checkpoint positions,
so invalidation-queue lag cannot make an old result appear current. A cross-owner
input needs its declared freshness/fence proof; a lagging unqualified mirror is
insufficient. `current` describes that proven snapshot, not an assertion that an
external website has never changed since acquisition. If freshness cannot be
proved within budget, return stale/pending or typed unavailable as appropriate.

Do not use one global invalidation epoch that forces every unrelated component
to be rewritten after a local source change. Large dependency sets require a
qualified generation/coverage protocol; they cannot be silently truncated to the
first page. Reassessment never changes protection or adopted content by itself.

## Planned API and cost contracts

These operations are targets, not installed routes. They share the existing
command envelope, current Access/disclosure checks and operation outcomes.

| Operation | Exact basis and outcome |
| --- | --- |
| `POST /v1/claims` | Typed proposition, referent/context/valid time and exact source references -> identified claim revision. Equal text alone does not merge identities. |
| `POST /v1/claims/{claim}/evidence` | Claim revision, expected evidence-set head including explicit null for absence, bounded references/selectors/dependencies -> new evidence-set revision. |
| `POST /v1/source-reliability-assessments` | Source/domain/context, expected rating head, exact method and inputs, authorized evaluator -> immutable assessment and scoped head. |
| `POST /v1/claims/{claim}/assessments` | Exact claim/evidence/source-assessment/method/policy revisions -> immutable assessment or pending operation; publication requires current dependency checks. |
| `GET /v1/claims/{claim}/assessments/{assessment}` | Exact retained assessment with current disclosure and explicit evidence availability; no current-head substitution. |
| `POST /v1/claims/{claim}/challenges` | Exact claim/adopted revision, reason and counterevidence -> pending challenge; no submitter-controlled verdict. |
| `POST /v1/quality-queries` | Bounded target/context selection and optional freshness fence -> exact adopted revision, summary basis/coverage/freshness and per-item availability. |

Mutations require idempotency and exact expected mutable heads; omitted and null
are not interchangeable. Conflicting input/head yields 409, denied authority
uses the API disclosure convention, and unsupported/over-budget input is refused
without partial adoption. An uncertain commit remains pending until the owner
receipt resolves it. Evidence collection and expensive evaluation run outside
the Jena writer; they cannot keep a transaction open while calling an AI or source.

The first bounded scalar assessment shares the protection profile's 32-evidence
and 32-source-assessment ceilings; ordinary result pages contain at most 50
entries. A quality query admits at most 50 targets and caps the total dependency
and byte work in its profile. Work is derived from candidate bytes and admitted
dependency count, plus indexed head/reverse-edge reads. Wider evidence campaigns
stage complete manifests and use separate job budgets. Establish actual engine
plans, writer time, queue lag and cold/skewed reads under
[complexity verification](../testing/complexity.md); these admission ceilings do
not qualify deployment capacity.

## Quality and exchange

Evaluate methods against representative labeled cases and held-out comparisons,
including disagreement and known adversarial errors. Report calibration, coverage,
abstention and error types; do not equate a vendor/model score with probability.
Independent consumers can inspect/export claims, evidence references, assessments,
policy and losses without adopting REZICS's chosen verdict.

Broad claim search and selected-answer retrieval are separate query modes.
Jena binds context, provenance and quality conditions with full-text matching.
Cached assessments bind target/context, exact content and quality generations,
policy and current disclosure; a historical calculation does not imply a currently
valid summary. Exports preserve dimensions, provenance/dependence, exact policy,
coverage, uncertainty and unavailable inputs instead of flattening to a score.
Correction notifications state material changes to affected published selections.

## Activation and boundaries

The claim/evidence model participates in source and classification design now.
Large verification campaigns and commercially packaged indexes follow their own
admission/quality gates. Funding or subscription status cannot buy a verdict.
Delivery uses [Subscribe](subscriptions.md) only when that service is offered.
Untrusted source/tool content stays data; outbound execution is separately admitted.

Restore exact assessments and their dependencies before activating derived
summaries. Reconcile later withdrawal, authority and erasure frontiers; changing
an epoch or rebuilding an index cannot establish assessment freshness.

## Evidence and qualification

Primary sources reviewed 2026-09-26:

| Source | Selected lesson and limit |
| --- | --- |
| [PROV-O](https://www.w3.org/TR/prov-o/#wasDerivedFrom) | Represent derivation, quotation, primary sources and responsible activities/agents. These links do not prove accuracy or source independence. |
| [Dong, Berti-Equille and Srivastava, Data Fusion](https://arxiv.org/abs/1503.00310), WAIM 2013, archived 2015 | Source copying affects conflict resolution. Reuse the dependence lesson, not an assumption that every REZICS question has one true value or that a published algorithm qualifies this workload. |
| [Wikidata Ranking](https://www.wikidata.org/wiki/Help:Ranking) | Rank, references and disputed qualifiers serve different purposes. Its ranks are not calibrated probabilities or a direct replacement for this acceptance model. |

This design chooses inspectable dimensions and a versioned summary over a single
unqualified score. Calibrated numerical assessments remain possible within their
declared method. Run the [FACT acceptance cases](../testing/information-verification.md)
and [protection scenarios](../testing/editorial-protection.md) through actual
owners; no upstream system or documentation check qualifies their composition.
