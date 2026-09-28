import type { ProfileDefinition } from '../compiler/ir.ts';

/** Named terms do not acquire the retired Path/Expression/Sense chain. */
export const tagProposalConceptProfile = {
  id: 'tag-proposal-concept-v1', layout: 'compact',
  comments: ['An author-proposed named concept is an identity, never an accepted classification.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'], ['skos', 'http://www.w3.org/2004/02/skos/core#'], ['schema', 'https://schema.org/']],
  shapes: [{ iri: 'https://rezics.com/definition/tag-proposal-concept-v1/concept-shape',
    canonical: { types: ['rv:AuthorTagConcept'] }, properties: [
      { path: 'rdf:type', hasValue: 'schema:DefinedTerm' },
      { path: 'rdf:type', hasValue: 'rv:AuthorTagConcept' },
      { path: 'skos:prefLabel', minCount: 1, maxCount: 1, datatype: 'rdf:langString', uniqueLang: true },
      { path: 'rv:conceptState', hasValue: 'rv:Active', maxCount: 1 },
      { path: 'rv:conceptRealm', maxCount: 1, class: 'rv:Realm' },
    ] }],
} as const satisfies ProfileDefinition;
