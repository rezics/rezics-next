import type { ProfileDefinition } from '../compiler/ir.ts';

export const themeBundleProfile = {
  id: 'first-party-bundle-v1',
  comments: [
    'First-party bundles name one host Zone, exact emitted bytes, bounded slots and allowed origins.',
    'The manifest is validated before an independent review; the profile itself never grants execution.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/first-party-bundle-v1/revision-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:ThemePackageRevision', maxCount: 1 },
      { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:hostZone', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dependencyDigest', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
    ],
  }],
} as const satisfies ProfileDefinition;
