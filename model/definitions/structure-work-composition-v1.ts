import type { ProfileDefinition } from '../compiler/ir.ts';

export const structureWorkCompositionProfile = {
  id: 'structure-work-composition-v1',
  comments: [
    'One Composed profile admits independently maintained Works at every creative level and medium.',
    'A part qualifier holds its local display label and inclusion; order remains the Structure order.',
    'The composing Work owns the Main Version component. Membership never writes schema:isPartOf.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/structure-work-composition-v1/part-shape',
    canonical: { types: ['rv:WorkPart'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:WorkPart', maxCount: 1 },
      { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
      { path: 'rv:displayLabel', minCount: 1, maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 500 },
      { path: 'rv:partInclusion', minCount: 1, maxCount: 1, in: ['rv:RequiredPart', 'rv:OptionalPart', 'rv:ExtraPart'] },
    ],
  }],
} as const satisfies ProfileDefinition;
