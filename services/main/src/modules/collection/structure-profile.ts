import { RV } from '../work/activate.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';

/** A Collection is its own Structure component; its identity never follows a Work version. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'collection-membership',
  graphProfile: `${RV}CollectionMembership`,
  ownerType: `${RV}Collection`,
  componentType: `${RV}Collection`,
  structurePredicate: `${RV}structure`,
  editScopePrefix: 'collection:edit:',
  editPermission: 'collection:edit',
  editAction: 'collection.edit',
  receiptFamily: 'structure-command',
  roles: ['group', 'member'],
  targetRoles: ['member'],
  selectionRequiredRoles: ['member'],
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
}];
