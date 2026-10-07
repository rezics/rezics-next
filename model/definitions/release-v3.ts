import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const profile = '<https://rezics.com/definition/release-v3>';

export const releaseV3Declaration = {
  id: 'release-v3',
  canonical: {
    release: {
      types: ['rv:Release'],
      when: [{ path: 'rv:definitionProfile', value: profile }],
    },
    coverage: { types: ['rv:ReleaseCoverage'] },
    revision: {
      types: ['rv:ReleaseRevision'],
      when: [{ path: 'rv:modelRevision', value: profile }],
    },
  },
} as const satisfies TurtleDeclaration;

export const releaseV3Profile = parseTurtleProfile(
  releaseV3Declaration.id,
  readFileSync(new URL('./release-v3.ttl', import.meta.url), 'utf8'),
  releaseV3Declaration,
);
