import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const definition = '<https://rezics.com/definition/agent-profile-address-v1>';

export const agentAddressDeclaration = {
  id: 'agent-profile-address-v1',
  canonical: {
    profile: {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:PlainNameAddressV1' }],
    },
    'localized-profile': {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' }],
    },
    revision: {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: definition }],
    },
    'localized-revision': {
      types: ['rv:AgentPublicProfileRevision'],
      when: [
        { path: 'rv:modelRevision', value: definition },
        { path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' },
      ],
    },
  },
} as const satisfies TurtleDeclaration;

export const agentAddressProfile = parseTurtleProfile(
  agentAddressDeclaration.id,
  readFileSync(new URL('./agent-profile-address-v1.ttl', import.meta.url), 'utf8'),
  agentAddressDeclaration,
);
