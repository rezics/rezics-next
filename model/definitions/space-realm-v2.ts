import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const spaceRealmV2Profile = {
  id: 'space-realm-v2',
  comments: ['Second Space profile adds a community handle and global Concept topics.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/space-realm-v2/space-shape',
      canonical: { types: ['rv:Space'], when: [{ path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v2>' }] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Space' },
        { path: 'rv:definitionProfile', hasValue: '<https://rezics.com/definition/space-realm-v2>', maxCount: 1 },
        requiredIri('rv:owner'),
        requiredIri('rv:realmCapability'),
        { path: 'rv:disclosure', maxCount: 1, nodeKind: 'sh:IRI', in: ['rv:Public', 'rv:Private'] },
      ],
    },
    {
      iri: 'https://rezics.com/definition/space-realm-v2/realm-shape',
      canonical: { types: ['rv:Realm'], when: [{ path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/space-realm-v2>' }] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Realm' },
        { path: 'rv:definitionProfile', hasValue: '<https://rezics.com/definition/space-realm-v2>', maxCount: 1 },
        requiredIri('rv:space'),
        { path: 'rv:communityHandle', maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:topic', maxCount: 3, nodeKind: 'sh:IRI' },
        { path: 'rv:realmState', hasValue: 'rv:Active' },
        { path: 'rv:selectionPolicy', hasValue: '<https://rezics.com/definition/realm-manager-fixed-main-fallback-v1>' },
        { path: 'rv:membershipPolicy', hasValue: '<https://rezics.com/definition/realm-closed-v1>' },
        { ...requiredIri('rv:reviewPolicy'), in: [
          '<https://rezics.com/definition/realm-manager-reviewed-v1>',
          '<https://rezics.com/definition/realm-members-direct-v1>',
          '<https://rezics.com/definition/realm-open-v1>',
        ] },
        { path: 'rv:visibility', maxCount: 1, in: ['"public"', '"restricted"', '"private"'] },
        { path: 'rv:reviewMode', maxCount: 1, in: ['"mandatory"', '"trusted-members"', '"open"'] },
        { path: 'rv:realmPolicyHead', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
