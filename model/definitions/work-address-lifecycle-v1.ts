import type { ProfileDefinition } from '../compiler/ir.ts';

const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1,
  nodeKind: 'sh:IRI' as const });
const slug = { path: 'rv:normalizedSlug', minCount: 1, maxCount: 1,
  datatype: 'xsd:string', minLength: 1, maxLength: 64,
  pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } as const;

export const workAddressLifecycleProfile = {
  id: 'work-address-lifecycle-v1',
  comments: ['A redirected Work route preserves its original target and points to a current Work identity.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/work-address-lifecycle-v1/redirect-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RouteBinding' },
        { path: 'rv:routeNamespace', hasValue: '"work"', maxCount: 1 },
        slug, oneIri('rv:targetWork'),
        { path: 'rv:routeState', hasValue: 'rv:Redirected', maxCount: 1 },
        oneIri('rv:routeRevision'), oneIri('rv:redirectWork'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/work-address-lifecycle-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
        oneIri('rv:component'), oneIri('rv:targetWork'), slug,
        oneIri('rv:previousRevision'), oneIri('rv:redirectWork'),
        { path: 'rv:routeState', hasValue: 'rv:Redirected', maxCount: 1 },
        { path: 'rv:routeChangeKind', hasValue: 'rv:Renamed', maxCount: 1 },
        oneIri('rv:modelRevision'), oneIri('rv:shapeRevision'),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
