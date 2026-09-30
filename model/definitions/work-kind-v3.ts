import type { ProfileDefinition } from '../compiler/ir.ts';

/** Descriptive kinds are admitted registry data; the Work base stays structural. */
export const workKindV3Profile = {
  id: 'work-kind-v3',
  layout: 'compact',
  comments: ['Descriptive Work types are admitted by Access, without changing this shape.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  shapes: [
    {
      iri: 'https://rezics.com/definition/work-kind-v3/work-shape',
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
  ],
} as const satisfies ProfileDefinition;
