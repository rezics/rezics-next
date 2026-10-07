import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workTitleControlV2Declaration = {
  id: 'work-title-control-v2',
  canonical: {
    control: {
      types: ['rv:EditorialControlRevision'],
      when: [
        {
          path: 'rv:modelRevision',
          value: '<https://rezics.com/definition/work-title-control-v2>',
        },
      ],
    },
  },
} as const satisfies TurtleDeclaration;

export const workTitleControlV2Profile = parseTurtleProfile(
  workTitleControlV2Declaration.id,
  readFileSync(new URL('./work-title-control-v2.ttl', import.meta.url), 'utf8'),
  workTitleControlV2Declaration,
);
