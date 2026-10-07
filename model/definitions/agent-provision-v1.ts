import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const agentProvisionDeclaration = {
  id: 'agent-provision-v1',
  canonical: {
    agent: { types: ['rv:Agent'] },
    tombstone: { types: ['rv:AgentTombstone'] },
  },
} as const satisfies TurtleDeclaration;

export const agentProvisionProfile = parseTurtleProfile(
  agentProvisionDeclaration.id,
  readFileSync(new URL('./agent-provision-v1.ttl', import.meta.url), 'utf8'),
  agentProvisionDeclaration,
);
