import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const definition = '<https://rezics.com/definition/agent-profile-v2>';
const legacyDefinition = '<https://rezics.com/definition/agent-profile-v1>';

export const agentPublicV2Declaration = {
  id: 'agent-profile-v2',
  canonical: {
    profile: {
      types: ['rv:Agent'],
      when: [{ path: 'rv:profileNameFormat', value: 'rv:LocalizedNameV2' }],
    },
    revision: {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: definition }],
    },
    'legacy-revision': {
      types: ['rv:AgentPublicProfileRevision'],
      when: [{ path: 'rv:modelRevision', value: legacyDefinition }],
    },
  },
} as const satisfies TurtleDeclaration;

export const agentPublicV2Profile = parseTurtleProfile(
  agentPublicV2Declaration.id,
  readFileSync(new URL('./agent-profile-v2.ttl', import.meta.url), 'utf8'),
  agentPublicV2Declaration,
);
