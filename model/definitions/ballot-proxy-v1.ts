import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const fixed = (path: Term, hasValue: Term): PropertyDefinition =>
  ({ path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true });

export const ballotProxyProfile = {
  id: 'ballot-proxy-v1',
  comments: [
    'Ordinary proxy voting: one explicit hop per seat, designated while the poll is a',
    'draft and frozen by its opening. Received units are never redelegable; a revoked',
    'route blocks new use but keeps its frozen history. Live rerouting and liquid',
    'delegation are separate profiles and are rejected here.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/ballot-proxy-v1/route-shape',
      canonical: { types: ['rv:ProxyRoute'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ProxyRoute' },
        link('rv:poll', 'rv:Poll'),
        link('rv:seat', 'rv:VotingSeat'),
        link('rv:sourceEntitlement', 'rv:SourceEntitlement'),
        one('rv:proxyHolder', { nodeKind: 'sh:IRI' }),
        link('rv:routeHead', 'rv:ProxyRouteRevision'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/ballot-proxy-v1/revision-shape',
      canonical: { types: ['rv:ProxyRouteRevision'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ProxyRouteRevision' },
        link('rv:proxyRoute', 'rv:ProxyRoute'),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ProxyRouteRevision' },
        one('rv:routeState', { in: ['rv:RouteActive', 'rv:RouteRevoked'] }),
        { ...fixed('rv:proxyHopLimit', '1'), datatype: 'xsd:integer' },
        fixed('rv:redelegation', 'rv:RedelegationForbidden'),
        link('rv:electorateCharter', 'rv:ElectorateCharterRevision'),
        one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' }),
        one('rv:revisedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
