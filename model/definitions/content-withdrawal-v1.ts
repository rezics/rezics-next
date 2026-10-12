import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const contentWithdrawalDeclaration = {
  id: 'content-withdrawal-v1',
  canonical: {
    decision: { types: ['rv:ContentWithdrawalDecision'] },
  },
} as const satisfies TurtleDeclaration;
