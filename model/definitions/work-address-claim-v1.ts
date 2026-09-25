import type { ProfileDefinition } from '../compiler/ir.ts';

const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1,
  nodeKind: 'sh:IRI' as const });

export const workAddressClaimProfile = {
  id: 'work-address-claim-v1',
  comments: ['One normalized route binding targets one native Work in the work namespace.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/work-address-claim-v1/binding-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RouteBinding' },
        { path: 'rv:routeNamespace', hasValue: '"work"', maxCount: 1 },
        { path: 'rv:normalizedSlug', minCount: 1, maxCount: 1,
          datatype: 'xsd:string', minLength: 1, maxLength: 64,
          pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
        oneIri('rv:targetWork'),
        { path: 'rv:routeState', hasValue: 'rv:Current', maxCount: 1 },
        oneIri('rv:routeRevision'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/work-address-claim-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
        oneIri('rv:component'), oneIri('rv:targetWork'),
        { path: 'rv:normalizedSlug', minCount: 1, maxCount: 1,
          datatype: 'xsd:string', minLength: 1, maxLength: 64,
          pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
        oneIri('rv:modelRevision'), oneIri('rv:shapeRevision'),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
