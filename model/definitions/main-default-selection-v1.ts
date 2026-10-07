import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const mainDefaultSelectionDeclaration = {
  id: 'main-default-selection-v1',
  canonical: {
    selection: {
      types: ['rv:PublicationSelection'],
      when: [{ path: 'rv:selectionBasis', value: 'rv:MainMaintainer' }],
    },
  },
} as const satisfies TurtleDeclaration;

export const mainDefaultSelectionProfile = parseTurtleProfile(
  mainDefaultSelectionDeclaration.id,
  readFileSync(new URL('./main-default-selection-v1.ttl', import.meta.url), 'utf8'),
  mainDefaultSelectionDeclaration,
);
