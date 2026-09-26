import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/semantic-definition-v1>';
const kinds = ['rv:RelationDefinition', 'rv:PropertyDefinition', 'rv:ValueDefinition',
  'rv:UnitDefinition', 'rv:InterpretationDefinition'] as const;

export const semanticDefinitionProfile = {
  id: 'semantic-definition-v1',
  comments: [
    'A versioned semantic definition Resource. Each immutable revision is an exact DefinitionRef.',
    'Retirement appends a Retired revision and an optional successor; referenced revisions never retarget.',
    'Definitions assert no identity or equivalence axioms; admitted mappings are separate definitions.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/semantic-definition-v1/definition-shape',
      canonical: { types: ['rv:SemanticDefinition'] }, closed: true, properties: [
      { path: 'rdf:type', hasValue: 'rv:SemanticDefinition' },
      { path: 'rv:definitionKind', minCount: 1, maxCount: 1, in: kinds },
      { path: 'rv:definitionHead', minCount: 1, maxCount: 1, class: 'rv:DefinitionRevision' },
      { path: 'rv:successor', maxCount: 1, class: 'rv:SemanticDefinition' },
      { path: 'owl:sameAs', maxCount: 0 },
      { path: 'owl:hasKey', maxCount: 0 },
    ] },
    { iri: 'https://rezics.com/definition/semantic-definition-v1/revision-shape',
      canonical: { types: ['rv:DefinitionRevision'] }, closed: true, properties: [
      { path: 'rdf:type', in: ['rv:DefinitionRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:SemanticDefinition' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:DefinitionRevision' },
      { path: 'rv:definitionKind', minCount: 1, maxCount: 1, in: kinds },
      { path: 'rv:lifecycle', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
      { path: 'rv:successor', maxCount: 1, class: 'rv:SemanticDefinition' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelGeneration', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
