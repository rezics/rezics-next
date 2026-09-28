import type { ProfileDefinition } from '../compiler/ir.ts';

export const structureBookProfile = {
  id: 'structure-book-v1',
  comments: [
    'A Book group qualifier says how one group of a Book composition divides the book.',
    'Volumes are numbered in reading order, parts are read by their titles, and extras (such as 番外) stay unnumbered.',
    'The qualifier belongs to one placement of one generation; moving the group keeps it, and it copies no content.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/structure-book-v1/group-shape',
      canonical: { types: ['rv:BookGroup'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:BookGroup', maxCount: 1 },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        { path: 'rv:bookDivision', minCount: 1, maxCount: 1,
          in: ['rv:VolumeDivision', 'rv:PartDivision', 'rv:ExtrasDivision'] },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
