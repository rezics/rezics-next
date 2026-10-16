import { RV } from '../work/activate.ts';
import { genericWorkType } from '../work/work-kinds.ts';
import { authorizeWorkTarget, workTargetGuard } from '../composition/structure-profile.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import { hydrateQualifierFields, projectQualifierFields, type QualifierTemplate } from '../structure/qualifier-template.ts';

/** An entry note is one declared text field. The cycle guard stays on the Work target. */
const entryNote: QualifierTemplate = {
  id: 'entry', form: 'fields', rdfType: 'EntryNote', idPrefix: 'urn:rezics:entry-note:',
  fields: [{ name: 'note', kind: 'text', predicate: 'note', required: true, maxLength: 4000 }],
  composedWork: true, onPlacement: true,
};

export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'section-list-v1', graphProfile: `${RV}SectionList`,
  ownerType: genericWorkType, componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  targetReadPermission: 'work:read', targetDisclosure: 'work',
  authorizeTarget: authorizeWorkTarget, targetGuard: workTargetGuard,
  withholdUnreadableTargets: true,
  roles: ['section', 'entry'], containerRoles: ['section'], targetRoles: ['entry'],
  readingRoles: ['entry'],
  selectionRequiredRoles: [],
  qualifiers: { entry: { type: 'fields', required: true, fieldId: 'entry', textFields: ['note'] } },
  projectQualifier: (state, generation) => projectQualifierFields(entryNote, state, generation),
  hydrateQualifier: (env, state) => hydrateQualifierFields(entryNote, env, state),
}];
