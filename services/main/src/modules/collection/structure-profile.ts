import { RV } from '../work/activate.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';

/** A Collection is its own Structure component; its identity never follows a Work version. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'collection-membership',
  graphProfile: `${RV}CollectionMembership`,
  ownerType: `${RV}Collection`,
  componentType: `${RV}Collection`,
  structurePredicate: `${RV}structure`,
  ownerValidation: { profile: 'collection-curation-v1',
    shape: 'https://rezics.com/definition/collection-curation-v1/structure-link-shape' },
  editScopePrefix: 'collection:edit:',
  editPermission: 'collection:edit',
  targetReadPermission: 'work:read',
  authorizeTarget: ({ access, principal, actingSubject, target }) =>
    access.canReadWork(principal, actingSubject, target),
  editAction: 'collection.edit',
  receiptFamily: 'structure-command',
  roles: ['group', 'member'],
  targetRoles: ['member'],
  selectionRequiredRoles: ['member'],
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
}];
