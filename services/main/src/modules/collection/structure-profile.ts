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
  authorizeTarget: async ({ targetReader, target }) => {
    const { WorkReadUnavailable } = await import('../work/read-session.ts');
    if (!targetReader) throw new WorkReadUnavailable('Collection target reader is unavailable');
    const { resolveTargets } = await import('../target/resolve.ts');
    await targetReader(session => resolveTargets(session, [target], 'collection-member'));
    return true;
  },
  editAction: 'collection.edit',
  receiptFamily: 'structure-command',
  roles: ['group', 'member'],
  targetRoles: ['member'],
  // Membership addresses a resource. Retain existing Work pins when present;
  // neither Works nor other admitted bases require published Content to be members.
  selectionRequiredRoles: [],
  selectionOptionalRoles: ['member'],
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
}];
