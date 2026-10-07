import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const STRUCTURE_ROLES = [
  'rv:GroupRole',
  'rv:ChapterRole',
  'rv:MemberRole',
  'rv:MountRole',
  'rv:NavigationRole',
  'rv:IngredientRole',
  'rv:StepRole',
  'rv:EquipmentRole',
] as const;

export const structureCompositionDeclaration = {
  id: 'structure-composition-v1',
  canonical: {
    structure: { types: ['rv:Structure'] },
    generation: { types: ['rv:StructureGeneration'] },
    segment: { types: ['rv:OrderSegment'] },
    'item-list': { types: ['schema:ItemList'] },
    occurrence: { types: ['schema:ListItem'] },
    placement: { types: ['rv:OccurrencePlacement'] },
    'removed-placement': { types: ['rv:RemovedPlacement'] },
    revision: { types: ['rv:StructureRevision'] },
    seal: { types: ['rv:StructureSeal'] },
  },
} as const satisfies TurtleDeclaration;

export const structureCompositionProfile = parseTurtleProfile(
  structureCompositionDeclaration.id,
  readFileSync(new URL('./structure-composition-v1.ttl', import.meta.url), 'utf8'),
  structureCompositionDeclaration,
);
