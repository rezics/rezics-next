import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmSubmissionSelectionDeclaration = {
  id: 'realm-submission-selection-v1',
  canonical: {
    selection: { types: ['rv:RealmSubmissionSelection'] },
    slot: { types: ['rv:RealmResourceSlot'] },
  },
} as const satisfies TurtleDeclaration;

export const realmSubmissionSelectionProfile = parseTurtleProfile(
  realmSubmissionSelectionDeclaration.id,
  readFileSync(new URL('./realm-submission-selection-v1.ttl', import.meta.url), 'utf8'),
  realmSubmissionSelectionDeclaration,
);
