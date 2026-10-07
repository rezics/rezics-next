import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const structureWorkCompositionDeclaration = {
  id: 'structure-work-composition-v1',
  canonical: {
    structure: {
      types: ['rv:Structure'],
      when: [{
        path: 'rv:structureProfile',
        value: 'rv:WorkComposition',
      }],
    },
    placement: {
      types: ['rv:OccurrencePlacement'],
      when: [{
        path: 'rv:occurrenceRole',
        value: 'rv:PartRole',
      }],
    },
    'removed-placement': {
      types: ['rv:RemovedPlacement'],
      when: [{
        path: 'rv:occurrenceRole',
        value: 'rv:PartRole',
      }],
    },
    part: {
      types: ['rv:WorkPart'],
    },
  },
} as const satisfies TurtleDeclaration;

export const structureWorkCompositionProfile = parseTurtleProfile(
  structureWorkCompositionDeclaration.id,
  readFileSync(new URL('./structure-work-composition-v1.ttl', import.meta.url), 'utf8'),
  structureWorkCompositionDeclaration,
);
