import type { ProfileDefinition } from '../compiler/ir.ts';

/** Retyping changes description, while retaining Work and revision identities. */
export const workTypeV3Profile = {
  id: 'work-type-v3',
  layout: 'compact',
  comments: [
    'Descriptive Work types are admitted by Access, without changing this shape.',
    'A Book with a composition remains a Book; the owning command guards that dependency.',
    'Work revision payloads keep their work-metadata-v1 model identity.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
  ],
  shapes: [
    {
      iri: 'https://rezics.com/definition/work-type-v3/work-shape',
      properties: [
        {
          path: 'rdf:type',
          minCount: 1,
          maxCount: 4,
          hasValue: 'schema:CreativeWork',
          nodeKind: 'sh:IRI',
        },
        {
          path: 'rv:mainVersion',
          minCount: 1,
          maxCount: 1,
          nodeKind: 'sh:IRI',
          class: 'rv:MainVersion',
        },
      ],
    },
    {
      iri: 'https://rezics.com/definition/work-type-v3/work-revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        {
          path: 'rv:modelRevision',
          hasValue: '<https://rezics.com/definition/work-metadata-v1>',
          maxCount: 1,
        },
        {
          path: 'rv:shapeRevision',
          hasValue: '<https://rezics.com/definition/work-metadata-v1>',
          maxCount: 1,
        },
        { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
