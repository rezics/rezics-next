import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workEditorialFieldDeclaration = {
  id: 'work-editorial-field-v1',
  canonical: {
    slot: { types: ['rv:EditorialFieldSlot'] },
  },
} as const satisfies TurtleDeclaration;
