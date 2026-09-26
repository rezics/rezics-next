import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/semantic-resource-v1>';

export const semanticResourceProfile = {
  id: 'semantic-resource-v1',
  comments: [
    'General semantic component of a native Resource: an open current envelope and its immutable revision anchor.',
    'The resource shape stays open to other admitted types, properties and components; a type grants no capability.',
    'The owning command rejects reserved owner types/predicates and schema axioms; identity merging is never native.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['skosxl', 'http://www.w3.org/2008/05/skos-xl#'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/semantic-resource-v1/resource-shape', properties: [
      { path: 'rdf:type', minCount: 1, maxCount: 32, nodeKind: 'sh:IRI' },
      { path: 'rv:semanticHead', minCount: 1, maxCount: 1, class: 'rv:SemanticRevision' },
      { path: 'rv:nameRecord', maxCount: 64, class: 'skosxl:Label' },
      { path: 'owl:sameAs', maxCount: 0 },
    ] },
    { iri: 'https://rezics.com/definition/semantic-resource-v1/revision-shape', properties: [
      { path: 'rdf:type', in: ['rv:SemanticRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:SemanticRevision' },
      { path: 'rv:lifecycle', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelGeneration', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:semanticHead', maxCount: 0 },
    ] },
  ],
} as const satisfies ProfileDefinition;
