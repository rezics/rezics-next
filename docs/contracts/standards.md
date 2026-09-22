# Standards and semantic profiles

## Adoption contract

Semantic Web is the native modeling/storage direction, with Fluree selected as
the engine. A standard's vocabulary, preserved source representation, native
operations, query semantics, validation, exchange and workflow support are separate
qualification dimensions. Importing a vocabulary does not implement all of them.

## Foundation profiles

| Area | Selected use |
| --- | --- |
| RDF 1.1 / JSON-LD 1.1 | Stable IRIs, language/typed literals, datasets and exchange; parser/context behavior qualified. |
| SKOS / SKOS-XL where useful | Concepts, schemes, labels and cross-vocabulary mappings; REZICS owns contextual acceptance. |
| RDFS / selected OWL rules | Explicit bounded type/property inference, separate from capabilities and authorization. |
| SHACL | Qualified staged shape constraints; domain commands own concurrency and cross-service rules. |
| PROV-O | Evidence/entity/activity/agent lineage and dependency-aware source interpretation. |
| Web Annotation / media selectors | Exact revision-qualified text/block/time/region references. |
| Schema.org | Reviewed mappings for books, media, software, recipes and public structured data. |
| Wikibase | Full statements/qualifiers/references/ranks for admitted source profiles, not truthy-edge substitution. |
| BIBFRAME / music source models | Grain-aware Work/publication/recording/release/occurrence mappings. |
| BCP 47 / Unicode | Content-language identity and reversible lexical/derived-normalization policy. |
| OAuth/OIDC / HTTP / OpenAPI | Authentication/delegation and shared typed client contracts. |
| Package ecosystems / PURL | Native version/dependency semantics and portable package coordinates. |

## Meaning and exceptions

The [model profile contract](model-profiles.md) selects native standard terms,
exchange-only mappings and local residuals. Reuse matching terms directly;
do not import every axiom of every related ontology into native reasoning.
Shapes, selected entailment rules and domain operations have independent artifact
and authority boundaries. The [implementation binding](../implementation/model-profile-validation.md)
defines unsupported-feature rejection, affected validation scope and model activation.

Do not collapse Class, Concept and Capability. SKOS broader is not subclass;
exactMatch is not permission or native identity merge; a graph name is not a
universal trust/context boundary. Preserve original lexicals, units, calendars,
directions and source uncertainty when an engine normalizes or cannot interpret
them. Unsupported native operations return explicit outcomes while source data
can remain preserved.

RDF 1.2/SHACL extensions, geo/observation/dataset profiles and full-corpus
Schema.org/Wikidata indexing are admitted with exact capability/evidence boundaries.
They need not block first-stage Space/classification and the five indexing domains.
External contexts/imports use bounded controlled acquisition; ordinary requests
cannot force arbitrary ontology downloads or executable validators.

## Definition releases

Pin normative artifacts, parser/model versions and generated contexts/shapes in
release manifests. Live provider checks fetch current external contracts/data on
each run and retain their own snapshot. Treat those two version policies separately.
Definition meaning changes preserve old referenced interpretation through a new
identity/revision or explicit conversion with losses.

Sources: [RDF](https://www.w3.org/TR/rdf11-concepts/),
[JSON-LD](https://www.w3.org/TR/json-ld11/), [SKOS](https://www.w3.org/TR/skos-reference/),
[SHACL](https://www.w3.org/TR/shacl/), [PROV-O](https://www.w3.org/TR/prov-o/),
[Web Annotation](https://www.w3.org/TR/annotation-model/).
