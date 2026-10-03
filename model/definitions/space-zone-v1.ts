import type { ProfileDefinition } from '../compiler/ir.ts';

export const spaceZoneProfile = {
  id: 'space-zone-v1',
  comments: ['A Space with one Zone capability and no required Realm. Creation includes its navigation.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/space-zone-v1/space-shape',
    canonical: { types: ['rv:Space'], when: [{ path: 'rv:definitionProfile',
      value: '<https://rezics.com/definition/space-zone-v1>' }] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:Space' },
      { path: 'rv:definitionProfile', hasValue: '<https://rezics.com/definition/space-zone-v1>', maxCount: 1 },
      { path: 'rv:owner', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:head', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:zoneCapability', minCount: 1, maxCount: 1, class: 'rv:Zone' },
      { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
      { path: 'rv:listing', minCount: 1, maxCount: 1, in: ['"listed"', '"unlisted"'] },
      { path: 'rdfs:label', minCount: 1, maxCount: 1, datatype: 'rdf:langString', minLength: 1, maxLength: 120 },
    ],
  }],
} as const satisfies ProfileDefinition;
