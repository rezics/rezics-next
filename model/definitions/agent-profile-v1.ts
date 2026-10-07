import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const agentProfileDeclaration = {
  id: 'agent-profile-v1',
} as const satisfies TurtleDeclaration;

export const agentProfile = parseTurtleProfile(
  agentProfileDeclaration.id,
  readFileSync(new URL('./agent-profile-v1.ttl', import.meta.url), 'utf8'),
  agentProfileDeclaration,
);
