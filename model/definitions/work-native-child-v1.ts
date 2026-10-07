import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workNativeChildDeclaration = {
  id: 'work-native-child-v1',
  canonical: {
    child: { types: ['rv:NativeChild'] },
  },
} as const satisfies TurtleDeclaration;

export const workNativeChildProfile = parseTurtleProfile(
  workNativeChildDeclaration.id,
  readFileSync(new URL('./work-native-child-v1.ttl', import.meta.url), 'utf8'),
  workNativeChildDeclaration,
);
