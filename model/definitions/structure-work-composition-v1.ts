import type { ProfileDefinition, ShapeDefinition } from '../compiler/ir.ts';
import { structureCompositionProfile } from './structure-composition-v1.ts';

// Extend canonical routing only for this owner; accepted kernel bytes remain fixed.
const ownerShapes: ShapeDefinition[] = structureCompositionProfile.shapes.flatMap(shape => {
  const role = shape.iri.split('/').at(-1)!;
  if (!['structure-shape', 'placement-shape', 'removed-placement-shape'].includes(role)) return [];
  return [{ ...shape,
    iri: `https://rezics.com/definition/structure-work-composition-v1/${role}`,
    canonical: { ...shape.canonical, when: [{
      path: role === 'structure-shape' ? 'rv:structureProfile' : 'rv:occurrenceRole',
      value: role === 'structure-shape' ? 'rv:WorkComposition' : 'rv:PartRole',
    }] },
    properties: shape.properties.map(property => property.path === 'rv:structureProfile'
      ? { ...property, in: ['rv:WorkComposition'] as const }
      : property.path === 'rv:occurrenceRole'
        ? { ...property, in: ['rv:GroupRole', 'rv:PartRole'] as const } : property),
  }];
});

export const structureWorkCompositionProfile = {
  id: 'structure-work-composition-v1',
  comments: [
    'One Composed profile admits independently maintained Works at every creative level and medium.',
    'A part qualifier holds its local display label and inclusion; order remains the Structure order.',
    'The composing Work owns the Main Version component. Membership never writes schema:isPartOf.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [...ownerShapes, {
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
