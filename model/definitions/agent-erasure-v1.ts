import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const agentErasureDeclaration = {
  id: 'agent-erasure-v1',
  canonical: {
    tombstone: {
      types: ['rv:AgentTombstone'],
      when: [{ path: 'rv:agentKind', value: 'rv:PersonAgent' }],
    },
  },
} as const satisfies TurtleDeclaration;

export const agentErasureProfile = parseTurtleProfile(
  agentErasureDeclaration.id,
  readFileSync(new URL('./agent-erasure-v1.ttl', import.meta.url), 'utf8'),
  agentErasureDeclaration,
);
