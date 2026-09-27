# Standards and semantic profiles

REZICS uses RDF/JSON-LD for native semantic data and exchange, Fuseki/TDB2 for
storage, and trusted ARQ queries. The authored
[model definitions](../../model/definitions/) choose admitted vocabulary terms;
the [compiler IR](../../model/compiler/ir.ts) pins their namespace bindings.
Vocabulary reuse, source preservation, native operations, query support,
validation, exchange and workflows are separate qualifications. A term in a
graph does not prove the others.

Reuse RDF Statement for an identified binary claim, SKOS/SKOS-XL for concepts
and labels, PROV-O for genuine lineage, Web Annotation for exact targets and
selectors, and Schema.org where the referent fits. Role-qualified or repeated
relations retain occurrence identity. Source Wikibase statements retain their
qualifiers and ranks; a truthy edge alone is insufficient. BIBFRAME and music
source mappings compare Work, publication, recording, release and occurrence
grains before adoption. Package coordinates, BCP 47 language tags and OAuth
descriptions keep their own owner contracts. These mapping choices require
owner fixtures before broader native admission.

Do not infer native identity from `skos:exactMatch`, subclass from
`skos:broader`, a base fact from `rdf:Statement`, or authority from RDF type,
graph name or ontology axiom. The [reasoning tests](../../model/tests/reasoning-profile.test.ts)
and [source reification tests](../../model/tests/source-reification.test.ts)
exercise selected counterexamples. Preserve lexicals, units, calendars,
directions and source uncertainty when normalization loses them; the
[exact-value profile](../../model/definitions/value-exact-v1.ts) covers its
admitted subset. Unsupported native operations have explicit outcomes, while
source bytes may remain available separately.

New syntax, ontology axioms, geospatial/observation profiles, and large
Schema.org or Wikidata indexing need their own bounded engine and source
qualification. External contexts and imports use controlled acquisition;
ordinary requests cannot fetch arbitrary ontologies or validators. A release
pins normative artifact and parser versions, while live provider checks capture
their current input independently. Changed definition meaning keeps old exact
references or uses an explicit conversion with declared losses.
