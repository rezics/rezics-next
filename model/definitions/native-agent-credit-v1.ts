import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const nativeAgentCreditDeclaration = {
  id: 'native-agent-credit-v1',
  canonical: {
    credit: { types: ['rv:NativeAgentCredit'] },
    revision: { types: ['rv:NativeAgentCreditRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const nativeAgentCreditProfile = parseTurtleProfile(
  nativeAgentCreditDeclaration.id,
  readFileSync(new URL('./native-agent-credit-v1.ttl', import.meta.url), 'utf8'),
  nativeAgentCreditDeclaration,
);
