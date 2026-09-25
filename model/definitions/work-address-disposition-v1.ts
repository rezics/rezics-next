import type { ProfileDefinition } from '../compiler/ir.ts';

const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1,
  nodeKind: 'sh:IRI' as const });
const slug = { path: 'rv:normalizedSlug', minCount: 1, maxCount: 1,
  datatype: 'xsd:string', minLength: 1, maxLength: 64,
  pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } as const;
const baseRoute = [
  { path: 'rdf:type', hasValue: 'rv:RouteBinding' },
  { path: 'rv:routeNamespace', hasValue: '"work"', maxCount: 1 },
  slug, oneIri('rv:targetWork'), oneIri('rv:routeRevision'),
] as const;
const baseRevision = [
  { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
  oneIri('rv:component'), oneIri('rv:targetWork'), slug,
  oneIri('rv:previousRevision'), oneIri('rv:modelRevision'),
  oneIri('rv:shapeRevision'),
] as const;

export const workAddressDispositionProfile = {
  id: 'work-address-disposition-v1',
  comments: ['A Work route merge or retirement never changes the original target identity.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/work-address-disposition-v1/merged-route-shape',
      properties: [...baseRoute,
        { path: 'rv:routeState', hasValue: 'rv:Redirected', maxCount: 1 },
        { path: 'rv:routeDisposition', hasValue: 'rv:Merged', maxCount: 1 },
        oneIri('rv:redirectWork')] },
    { iri: 'https://rezics.com/definition/work-address-disposition-v1/retired-route-shape',
      properties: [...baseRoute,
        { path: 'rv:routeState', hasValue: 'rv:Retired', maxCount: 1 },
        { path: 'rv:routeDisposition', hasValue: 'rv:Retired', maxCount: 1 },
        { path: 'rv:redirectWork', maxCount: 0 }] },
    { iri: 'https://rezics.com/definition/work-address-disposition-v1/merged-revision-shape',
      properties: [...baseRevision,
        { path: 'rv:routeState', hasValue: 'rv:Redirected', maxCount: 1 },
        { path: 'rv:routeDisposition', hasValue: 'rv:Merged', maxCount: 1 },
        oneIri('rv:redirectWork')] },
    { iri: 'https://rezics.com/definition/work-address-disposition-v1/retired-revision-shape',
      properties: [...baseRevision,
        { path: 'rv:routeState', hasValue: 'rv:Retired', maxCount: 1 },
        { path: 'rv:routeDisposition', hasValue: 'rv:Retired', maxCount: 1 },
        { path: 'rv:redirectWork', maxCount: 0 }] },
  ],
} as const satisfies ProfileDefinition;
