import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workAuthorCreditDeclaration = {
  id: 'work-author-credit-v1',
  canonical: {
    credit: {
      types: ['<https://rezics.com/vocab/AuthorCredit>'],
    },
    revision: {
      types: ['<https://rezics.com/vocab/AuthorCreditRevision>'],
    },
  },
  binding: {
    required: ['credit', 'revision', 'work', 'work-head', 'key', 'ordinal', 'actor', 'receipt', 'scope', 'epoch', 'intent'],
    optional: ['source-role'],
    roles: ['credit', 'revision'],
    demandedBy: ['<https://rezics.com/vocab/AuthorCredit>', '<https://rezics.com/vocab/AuthorCreditRevision>'],
  },
} as const satisfies TurtleDeclaration;
