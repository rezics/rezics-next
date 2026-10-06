import type { ProfileDefinition } from '../compiler/ir.ts';

export const realmPolicyHeadProfile = {
  id: 'realm-policy-head-v1',
  comments: ['A creation policy head binds its Realm to the creation command receipt without writing a second receipt.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/realm-policy-head-v1/head-shape',
    canonical: { types: ['rv:RealmPolicyHead'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmPolicyHead' },
      { path: 'rv:realm', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:receipt', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ],
  }],
} as const satisfies ProfileDefinition;
