import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** Explicit authored successor; the six-role V1 profile remains unchanged. */
export const nativeAgentCreditV2Declaration = {
  id: 'native-agent-credit-v2',
  canonical: {
    credit: { types: ['rv:NativeAgentCredit'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/native-agent-credit-v2>' }] },
    revision: { types: ['rv:NativeAgentCreditRevision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/native-agent-credit-v2>' }] },
  },
} as const satisfies TurtleDeclaration;
