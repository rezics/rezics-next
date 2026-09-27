# Semantic Web coverage and local model decisions

Reviewed 2026-09-26. This is a vocabulary comparison, not Jena, mapping or
performance qualification. The earlier domain inventory counted application
contracts as Semantic Web gaps. Existing vocabularies already represent much of
their structure; REZICS still chooses exact identity, interpretation, authority,
selection and recovery policies. Reuse needs a tested mapping, not a similar name.

## Selected and rejected equivalences

| Candidate | Decision and reason |
| --- | --- |
| [SKOS](https://www.w3.org/TR/skos-reference/) concepts, labels and collections | Reuse for eligible concepts and vocabulary organization. A concept is not automatically an OWL class, and a collection or broader link does not assert target membership. |
| [RDF reification](https://www.w3.org/TR/rdf-schema/#ch_reificationvocab), [n-ary relations](https://www.w3.org/TR/swbp-n-aryRelations/) and [PROV-O](https://www.w3.org/TR/prov-o/) | Reuse identified claim, role-bearing occurrence and provenance patterns where they fit. They do not select exact definition, acceptance scope or source reconciliation. Reification alone does not assert the base triple. |
| [OntoLex](https://www.w3.org/2016/05/ontolex/) lexical sense and usage | Reuse for actual lexical modeling; reject mandatory Sense identities for every Resource or Statement. The community report does not prescribe shared Context authority. |
| [RDF datasets](https://www.w3.org/TR/rdf11-concepts/#section-dataset) and named graphs | Reuse graph scoping; reject graph name as automatic truth, Realm, transaction or permission scope. RDF does not define the graph-name referent relationship. |
| [SIOC](https://www.w3.org/submissions/sioc-spec/) Space and [ORE Proxy](https://www.openarchives.org/ore/1.0/datamodel) | Useful precedents, not identity equivalences for admitted Space capabilities or repeated, editable Occurrences. Compare cardinality and lifecycle before mapping. |
| [Web Annotation](https://www.w3.org/TR/annotation-model/), [GeoSPARQL 1.1](https://docs.ogc.org/is/22-047r1/22-047r1.html), [OWL-Time](https://www.w3.org/TR/owl-time/) | Reuse annotation targets, geometry/SRS and time where applicable. They do not determine world instance/epoch continuity, game generation or anchor migration. |

## Shared Context decision

Select reusable Context identity with exact scoped definitions, separately
versioned preferences and separate acceptance. Reject mandatory new concepts
for every differing criterion: renaming cannot end contextual use or later
disagreement. Reject viewer-Realm reinterpretation of authored statements:
quotations and history must retain their original meaning. Reject one mandatory
Context copy per Realm/person: use is not ownership or governance. The
[Context contract](../contracts/context.md) records remaining selection and
authority obligations; [Statement identity](../contracts/classification.md)
does not require a Tag/Path/Expression/Sense/Application chain.

## Spatial and maturity limits

[GeoSPARQL WKT](https://docs.ogc.org/is/22-047r1/22-047r1.html) can name a
custom SRS, but that does not provide game transforms or every 3D operator.
Its GeoJSON literal profile uses WGS84 longitude/latitude; game coordinates
need an explicit selected profile. [OGC CRS ontology work](https://github.com/opengeospatial/ontology-crs)
and [GeoWebAnnotations](https://ceur-ws.org/Vol-3743/paper5.pdf) are candidates,
not evidence of a maintained universal implementation. OntoLex is a Community
Report; SIOC is a Member Submission. Source maturity and engine support must be
checked before activation.

Before adopting a mapping, test round trips and counterexamples for repeated
targets, same-language alternatives, local rejection, fit/spoiler independence,
source withdrawal, equal seeds in different worlds, custom CRS interpretation,
revoked representation and changed dependency scope. Compare identity,
cardinality, inference and residual loss. No external ontology dependency or
namespace migration is activated by this review.
