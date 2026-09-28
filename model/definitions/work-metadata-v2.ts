import type { ProfileDefinition } from '../compiler/ir.ts';

const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';

/** Revision of work-metadata-v1. v1 remains the canonical Work shape; this
 * revision admits links to releases without changing v1 data. */
export const workMetadataV2Profile = {
  id: 'work-metadata-v2',
  comments: [
    'Work and Main Version shapes from work-metadata-v1, plus release links.',
    'A release is a separate closed or virtual record; it is not a Work property that later translations extend.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', schema],
    ['rv', rv],
  ],
  layout: 'expanded',
  shapes: [
    {
      iri: 'https://rezics.com/definition/work-metadata-v2/work-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
        { path: 'rv:mainVersion', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:MainVersion' },
        { path: 'rv:continuityProfile', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:scalarValue', maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
        { path: 'rv:release', maxCount: 64, nodeKind: 'sh:IRI', class: 'rv:Release' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/work-metadata-v2/main-version-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MainVersion' },
        { path: 'rv:work', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'schema:CreativeWork' },
        { path: 'rv:hostingPolicy', minCount: 1, maxCount: 1, hasValue: 'rv:MetadataOnly' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
