import { RV } from '../work/activate.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';

/** Zone navigation belongs to the Zone capability, independent of its Space's Realm. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'zone-navigation',
  graphProfile: `${RV}ZoneNavigation`,
  ownerType: `${RV}Zone`,
  componentType: `${RV}Zone`,
  structurePredicate: `${RV}navigation`,
  editScopePrefix: 'zone:edit:',
  editPermission: 'zone:edit',
  editAction: 'zone.edit',
  receiptFamily: 'structure-command',
  roles: ['group', 'mount'],
  targetRoles: ['mount'],
  selectionRequiredRoles: [],
}];
