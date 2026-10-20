import { RV } from '../work/activate.ts';
import { hydrateBookGroup, projectBookGroup, validateBookGroups } from './book-group.ts';
import type { StructureProfileRegistration } from './profiles.ts';
import { episodeStructureProfile } from './episode-profile.ts';

/** Book composition is a registration, the same way every other owner is. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'book-composition', graphProfile: `${RV}BookComposition`,
  ownerType: 'https://schema.org/Book', componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  targetReadPermission: 'work:read',
  targetDisclosure: 'resource',
  catalogTargetTypes: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'],
  searchableRoles: ['chapter'],
  roles: ['group', 'chapter'], containerRoles: ['group'], readingRoles: ['chapter'],
  targetRoles: ['chapter'], selectionRequiredRoles: ['chapter'],
  qualifiers: { group: { type: 'book-group', required: false } },
  // Volumes, parts and extras sit directly under the book; chapters under the book or one group.
  maxDepth: 2,
  projectQualifier: projectBookGroup, hydrateQualifier: hydrateBookGroup,
  qualifierValidations: validateBookGroups,
}, episodeStructureProfile];
