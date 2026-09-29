# Objects, semantic statements and contextual classification

The adopted model uses shared Resource identity and independently attributed
Statements. It rejects a mandatory Tag/Path/Expression/Sense/Application chain:
tags are source terms to map, Paths are navigation, structured conditions belong
in versioned definitions, and exact DefinitionRefs carry interpretation without
a universal Sense wrapper. A named concept and a contextual interpretation are
independent editorial choices. Creating `真後宮` does not rename, delete or settle
anyone's contextual use of `後宮`.

Classification is this write side: stating Concepts about a Resource and
accepting them in a Context. Reads of those Statements, like reads of types,
relations and characters, go through [Facets](queries.md); a product grouping
is a Saved Filter, not a Concept.

A Statement identifies its speaker, exact subject grain, relation and applied
definitions, value, qualifiers, semantic Context revision and evidence. Its
existence is separate from acceptance. Different sources can support one exact
meaning while retaining independent identities and withdrawal history; a shared
label or Context ID alone proves neither equality nor acceptance. A viewer's
different reading is a new attributed statement or labeled projection. The
[Context contract](context.md) keeps interpretation separate from decisions.

## Installed profiles and transition

The installed [Statement schema](../../services/main/src/modules/statement/schema.ts)
defines exact meaning keys, bounded support and decision slots. Its v1 migration
preserves retained Application/Sense/Decision heads and does not infer narrower
relations from labels. The [CTX inventory](../../scripts/qa/cases/classification.ts)
and owner tests identify the replacement profile's required behavior.

## Remaining contract

- Source tag conversion requires reviewed identity and meaning, with loss
  accounting; a matching label cannot create an equivalent native statement.
- Repeated participant roles need domain-owned occurrence identities. An
  appearance in one Work is not a permanent character property, and a statement
  about that appearance has a different referent.
- Group exact accepted meanings before pagination while retaining support,
  decision scope, count grain and disclosure. Navigation or display grouping
  creates no fact. Correlate role occurrence, release and trait: a red-haired
  supporting character cannot satisfy a red-haired female-lead query.
- Derived edges and inverse reads need admitted context-bound rules and exact
  provenance. Inference cannot grant authority or accept a statement. Bound
  query, invalidation and recovery work before declaring broad qualification.

## Restricted structure and open vocabulary

Decision 15, product manager under maintainer delegation, 2026-09-29.
Structural types come from a versioned registry; descriptive types and properties
can be added under a namespace and steward without adding behaviour. Anyone may
propose; definition, application, acceptance and activation are separate powers.
Ship everyday application, contest, translation and alias review first. Merge
and split retain IDs but wait for a later workbench.

The reason is safe extension without forcing each subject into a new executable
profile. [SHACL's open and closed shapes](https://www.w3.org/TR/shacl/#ClosedConstraintComponent)
support controlled structural boundaries; [SKOS](https://www.w3.org/TR/skos-reference/)
supports multilingual descriptive vocabulary. Neither label nor namespace creates
authority. The [vertical manifest](../product/platform-thesis.md#the-vertical-engine-is-the-product)
composes these admitted definitions.

## Classification journeys

Decision 17, product manager under maintainer delegation, 2026-09-29.
One multilingual selector serves applying and voting, term/translation proposals,
review, Concept pages, saved include/exclude Home filters and onboarding interests
without a cap. Fit and spoiler judgments stay separate; spoiler reveal respects
the reader's consumption position. Concrete vote and query meaning stays in the
[judgment](classification-judgments.md) and [query](queries.md) owners.

The reason is a reusable path from discovery to contribution and return, rather
than isolated tag widgets. [AO3's tag filtering](https://archiveofourown.org/faq/search-and-browse?language_id=en)
is a precedent for inclusion/exclusion, and SKOS above supplies language-aware
labels without conflating translated words with new identities.
