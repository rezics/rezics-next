import type { ProfileDefinition } from '../compiler/ir.ts';

export const agentProvisionProfile = {
  id: 'agent-provision-v1',
  comments: [
    'A public Agent has an explicit native identity and one bounded display name.',
    'Private principal mapping and representation are Access-owned and absent from this graph.',
  ],
  prefixes: [['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['sh', 'http://www.w3.org/ns/shacl#'], ['rv', 'https://rezics.com/vocab/'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#']],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/agent-provision-v1/agent-shape',
    canonical: { types: ['rv:Agent'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:Agent' },
      { path: 'rv:agentKind', minCount: 1, maxCount: 1,
        in: ['rv:PersonAgent', 'rv:OrganizationAgent', 'rv:ServiceAgent'] },
      { path: 'rdfs:label', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      // Optional only for legacy public provision heads. New provisioning also
      // validates agent-profile-v1, which requires both allocated fields.
      { path: 'rv:profileHandle', maxCount: 1, datatype: 'xsd:string',
        pattern: '^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:profileDisclosure', maxCount: 1, in: ['rv:Public', 'rv:Private'] },
    ] },
    { iri: 'https://rezics.com/definition/agent-provision-v1/tombstone-shape',
      canonical: { types: ['rv:AgentTombstone'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:AgentTombstone' },
        { path: 'rv:compensatedFrom', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ] },
  ],
} as const satisfies ProfileDefinition;
