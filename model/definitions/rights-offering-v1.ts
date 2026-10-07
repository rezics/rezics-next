import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const rightsOfferingDeclaration = {
  id: 'rights-offering-v1',
  canonical: {
    declaration: { types: ['rv:RightsDeclaration'] },
    slot: { types: ['rv:RightsOfferingSlot'] },
    offering: { types: ['rv:RightsOffering'] },
    'offering-revision': { types: ['rv:RightsOfferingRevision'] },
    'recognition-revision': { types: ['rv:RightsRecognitionRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const rightsOfferingProfile = parseTurtleProfile(
  'rights-offering-v1',
  readFileSync(new URL('./rights-offering-v1.ttl', import.meta.url), 'utf8'),
  rightsOfferingDeclaration,
);
