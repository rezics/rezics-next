import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** Publication identity and custody are independent of every Book placement. */
export const postDeclaration = {
  id: 'post-v1',
  canonical: { post: { types: ['rv:Post'] } },
  binding: { required: ['post', 'publisher', 'revision'], roles: ['post'], demandedBy: ['rv:Post'] },
} as const satisfies TurtleDeclaration;
