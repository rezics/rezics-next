import type { TurtleDeclaration } from '../compiler/shacl.ts';

export const workEditorialFieldV2Declaration = {
  id: 'work-editorial-field-v2',
  canonical: {
    slot: { types: ['rv:EditorialFieldSlot'], when: [
      { path: 'rv:modelRevision', value: '<https://rezics.com/definition/work-editorial-field-v2>' },
    ] },
  },
} as const satisfies TurtleDeclaration;
