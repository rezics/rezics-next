# Context, perspective and effective decisions

## Typed context roles

| Role | Question |
| --- | --- |
| Governance | Which authority can decide/adopt this state? |
| Classification perspective | Under which interpretation and acceptance rules is the proposition applied? |
| Rating context | What question, target grain, eligible population, scale and cadence are evaluated? |
| Publication selection | Which Main Version/contribution/revision is served? |
| Semantic canon | In which fictional world, narrative continuity or evidential setting does a claim hold? |
| Presentation | Which Zone/site/navigation frames the response? |

A Space may participate in several roles, but a single undifferentiated context
ID cannot transfer rights or interpretations between them. Context selections
carry exact policy/definition revisions, scope and source references. A UI preset
can choose several roles while the API exposes the resolved selection.

## Effective classification

One Resource and Concept can have independent Global and Realm Applications.
An Application identifies the target grain, Expression/Sense, authority,
provenance, state and effective decision. Vocabulary identity is shared unless
the meaning is genuinely different; a Realm label alone does not allocate a copy.

| Local state | Inherit policy | Isolate policy |
| --- | --- | --- |
| Accepted | Use local decision and evidence. | Use local decision and evidence. |
| Rejected/suppressed | Suppress the claim; never fall back. | Suppress the claim. |
| No local decision | Use eligible Global decision, labeled as inherited. | Unknown/no selection. |
| Unreadable/unavailable local state | Return an admitted unavailable outcome; do not infer absence. | Same. |

Fallback is a versioned policy with explicit priority and cycle-free finite
dependencies. It never merges vote identities or populations. Missing data and
negative evidence remain distinct. Queries and cursors bind the resolved policy,
context generation and disclosure domain.

## RDF and named graphs

Context is modeled explicitly through identified assertions, decisions and typed
relations. Named graphs may delimit acquisition, lifecycle, exchange or query
datasets; they are not automatically truth, access, Realm or transaction scopes.
One Realm does not require one graph or ledger, and graph membership alone cannot
prove the authority behind a claim.

Keep Realm-dependent concept relations scoped as relation resources or explicitly
selected graphs. `skos:inScheme` does not scope every predicate on a concept.
Do not union conflicting context graphs before reasoning: first choose eligible
facts/rules, then derive within that selection. Derived results carry their input
contexts and rule generation and are incrementally invalidated.

## Ratings and selection

One Realm can define several [rating contexts](ratings.md). Targeting a Work/Main
Version, a translation and an exact package release answers different questions.
No implicit score roll-up crosses those grains. Show inherited/global series
separately from local results with their populations and uncertainty.

An exact requested publication/revision either resolves under current disclosure
or returns unavailable; it does not silently fall back to a newer head. Ordinary
requests use the [Main Version selection](main-version.md). Zone placement does
not publish drafts or override Realm acceptance.

## Acceptance

Use one resource in two Realms with opposite decisions, different label choices,
different rating questions and different adopted text. Query each separately and
compare explicitly. Reject inference leakage, negative-to-absence fallback,
mixed populations, contextless cache reuse and stale-generation pagination.

Basis: [RDF datasets](https://www.w3.org/TR/rdf11-concepts/#section-dataset) and
[SKOS](https://www.w3.org/TR/skos-reference/) provide graph and vocabulary semantics;
the resolution and governance rules here are REZICS design.
