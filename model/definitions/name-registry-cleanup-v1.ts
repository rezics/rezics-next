import type { ProfileDefinition } from '../compiler/ir.ts';

export const nameRegistryCleanupProfile = {
  id: 'name-registry-cleanup-v1',
  comments: ['Names live in Access. Native migration cleanup proves the former graph naming predicates are absent.'],
  prefixes: [['sh','http://www.w3.org/ns/shacl#'],['rv','https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/name-registry-cleanup-v1/cleaned-shape',
    canonical: { types: ['rv:RetiredNameProjection'] },
    properties: [
      { path: 'rv:communityHandle',maxCount: 0 },
      { path: 'rv:routeSegment',maxCount: 0 },
      { path: 'rv:routeNamespace',maxCount: 0 },
      { path: 'rv:normalizedSlug',maxCount: 0 },
    ] }],
} as const satisfies ProfileDefinition;
