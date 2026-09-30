import type { ProfileDefinition } from '../compiler/ir.ts';

/** Lexicon keys have their own component; accepted semantic definitions stay closed. */
export const definitionKeyProfile = {
  id: 'definition-key-v1',
  comments: ['A lexicon-owned stable registry key identifies one semantic definition independently of its labels.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['skos', 'http://www.w3.org/2004/02/skos/core#'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/definition-key-v1/key-shape',
    canonical: { types: ['rv:DefinitionKey'] }, closed: true,
    properties: [
      { path: 'rdf:type', hasValue: 'rv:DefinitionKey', minCount: 1, maxCount: 1 },
      { path: 'rv:keyDefinition', minCount: 1, maxCount: 1, class: 'rv:SemanticDefinition' },
      { path: 'skos:notation', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
    ],
  }],
} as const satisfies ProfileDefinition;
