import type { ProfileDefinition } from '../compiler/ir.ts';

const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';

export const workMetadataProfile = {
  id: 'work-metadata-v1',
  comments: [
    'Fixed S1 profile for a metadata-only Work and its maintained MainVersion.',
    'The trusted caller must add sh:targetNode for both proposed identities.',
    'These shapes cover candidate structure; the owning command enforces',
    'uniqueness, authority, immutable revisions and transactional guards.',
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
      iri: 'https://rezics.com/definition/work-metadata-v1/work-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
        { path: 'rv:mainVersion', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:MainVersion' },
        { path: 'rv:continuityProfile', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:scalarValue', maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/work-metadata-v1/main-version-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MainVersion' },
        { path: 'rv:work', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'schema:CreativeWork' },
        { path: 'rv:hostingPolicy', minCount: 1, maxCount: 1, hasValue: 'rv:MetadataOnly' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
