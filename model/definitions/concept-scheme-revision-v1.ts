import type { ProfileDefinition } from '../compiler/ir.ts';

/** Validation for v2's three revision anchors, separate from its five bound current roles. */
export const conceptSchemeRevisionProfile = {
  id: 'concept-scheme-revision-v1',
  layout: 'compact',
  comments: ['Three attributed revision anchors for a shared scheme append.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  shapes: [
    {
      iri: 'https://rezics.com/definition/concept-scheme-revision-v1/anchor-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
        { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:recordedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        {
          path: 'rv:modelRevision',
          hasValue: '<https://rezics.com/definition/classification-proposition-v2>',
          maxCount: 1,
        },
        {
          path: 'rv:shapeRevision',
          hasValue: '<https://rezics.com/definition/classification-proposition-v2>',
          maxCount: 1,
        },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
