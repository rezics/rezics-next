import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const spaceRealmProfile = {
  id: 'space-realm-v1',
  comments: ['First Space profile with one independently identified Realm capability.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/space-realm-v1/space-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Space' },
        requiredIri('rv:owner'),
        requiredIri('rv:realmCapability'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/space-realm-v1/realm-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Realm' },
        requiredIri('rv:space'),
        { path: 'rv:realmState', hasValue: 'rv:Active' },
        { path: 'rv:selectionPolicy', hasValue: '<https://rezics.com/definition/realm-manager-fixed-main-fallback-v1>' },
        { path: 'rv:membershipPolicy', hasValue: '<https://rezics.com/definition/realm-closed-v1>' },
        { path: 'rv:reviewPolicy', hasValue: '<https://rezics.com/definition/realm-manager-reviewed-v1>' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
