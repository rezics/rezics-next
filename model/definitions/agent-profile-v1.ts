import type { ProfileDefinition } from '../compiler/ir.ts';

export const agentProfile = {
  id: 'agent-profile-v1',
  comments: [
    'Provisioning creates a public Agent profile; private Account identity is never copied.',
    'The immutable agent-UUID handle is allocated from the native Agent identity, not its name.',
    'Only active Access Agents with a public profile and unerased head are publicly readable.',
    'Pen names are independent PersonAgents; no principal or same-person link is published.',
  ],
  prefixes: [['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['sh', 'http://www.w3.org/ns/shacl#'], ['rv', 'https://rezics.com/vocab/'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#']],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/agent-profile-v1/profile-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:Agent' },
      { path: 'rv:profileHandle', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:profileDisclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
    ] }],
} as const satisfies ProfileDefinition;
