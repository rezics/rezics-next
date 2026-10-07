import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const profile = '<https://rezics.com/definition/release-v2>';

export const releaseV2Declaration = {
  id: 'release-v2',
  canonical: {
    release: {
      types: ['rv:Release'],
      when: [{ path: 'rv:definitionProfile', value: profile }],
    },
    revision: {
      types: ['rv:ReleaseRevision'],
      when: [{ path: 'rv:modelRevision', value: profile }],
    },
  },
} as const satisfies TurtleDeclaration;

export const releaseV2Profile = parseTurtleProfile(
  releaseV2Declaration.id,
  readFileSync(new URL('./release-v2.ttl', import.meta.url), 'utf8'),
  releaseV2Declaration,
);
