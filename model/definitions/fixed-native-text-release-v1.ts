import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const fixedNativeTextReleaseDeclaration = {
  id: 'fixed-native-text-release-v1',
  canonical: {
    release: { types: ['rv:FixedRelease'] },
  },
  binding: {
    required: [
      'release', 'work', 'main', 'revision', 'selection', 'contribution', 'decision', 'draft',
      'language', 'digest', 'manifest', 'actor', 'receipt', 'scope', 'epoch',
    ],
    roles: ['release'],
    demandedBy: ['rv:FixedRelease'],
  },
} as const satisfies TurtleDeclaration;

export const fixedNativeTextReleaseProfile = parseTurtleProfile(
  'fixed-native-text-release-v1',
  readFileSync(new URL('./fixed-native-text-release-v1.ttl', import.meta.url), 'utf8'),
  fixedNativeTextReleaseDeclaration,
);
