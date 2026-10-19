import type { TurtleDeclaration } from '../compiler/shacl.ts';
import { workAuthorCreditDeclaration } from './work-author-credit-v1.ts';

/** Reuse the actual Work-edit binding; a role extension grants no authority. */
export const workAuthorCreditV2Declaration = {
  id: 'work-author-credit-v2',
  canonical: {
    credit: { types: ['rv:AuthorCredit'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/work-author-credit-v2>' }] },
    revision: { types: ['rv:AuthorCreditRevision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/work-author-credit-v2>' }] },
  },
  // The existing type demand retains its V1 default; the selected V2 route
  // requires this same owner binding against its explicit successor shapes.
  binding: { ...workAuthorCreditDeclaration.binding, demandedBy: [] },
} as const satisfies TurtleDeclaration;
