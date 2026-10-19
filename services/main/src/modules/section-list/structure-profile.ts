import { CompositionUnavailable } from '../structure/unavailable.ts';
import { checkExactInstructionSelection } from '../structure/selection.ts';
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
  workPublication: true,
  async verifySourceCorrespondence(input) {
    const { verifySectionListSource } = await import('./source-correspondence.ts');
    return verifySectionListSource(input);
  },
  id: 'section-list-v1', graphProfile: `${RV}SectionList`,
  ownerType: genericWorkType, componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`, editScopePrefix: 'work:edit:',
  editPermission: 'work:edit', editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
  targetReadPermission: 'work:read', targetDisclosure: 'structure-target',
  async authorizeTarget(authority) {
    if (!authority.environment) return false;
    const { canReadContentTarget, resolveContentTarget, ContentDraftUnavailable } = await import('../content-publication/draft.ts');
    try {
      const owner = await resolveContentTarget(authority.environment, authority.target);
      if (owner.type === `${RV}Post`) return canReadContentTarget(authority.environment, authority.access,
        authority.principal, authority.actingSubject, authority.target, owner);
    } catch (error) {
      if (!(error instanceof ContentDraftUnavailable)) throw error;
    }
    return authorizeWorkTarget(authority);
  },
  targetGuard: (env, owner, targets) => workTargetGuard(env, owner, targets, [`${RV}Post`]),
  async validateSelection(reader, target, selection) {
    if (selection.mode !== 'fixed-revision' || !selection.selector) return;
    const selector = checkExactInstructionSelection(target, selection.revision, selection.selector);
    if (selector.grain !== 'content') throw new CompositionUnavailable('Section-list entries select Content');
    await reader(async session => {
      const { WorkReadSession } = await import('../work/read-session.ts');
      if (!(session instanceof WorkReadSession)) throw new CompositionUnavailable('Content owner read is unavailable');
      const { resolveContentReference } = await import('../content-publication/reference.ts');
      if ((await resolveContentReference(session, { target, selector })).status !== 'available')
        throw new CompositionUnavailable('Section-list Content is unavailable');
    });
  },
  withholdUnreadableTargets: true,
  searchableRoles: ['entry'],
  roles: ['section', 'entry'], containerRoles: ['section'], targetRoles: ['entry'],
  readingRoles: ['entry'],
  selectionRequiredRoles: [], selectionOptionalRoles: ['entry'], selectionSelectorRoles: ['entry'],
  qualifiers: { entry: { type: 'fields', required: true, fieldId: 'entry', textFields: ['note'] } },
  projectQualifier: (state, generation) => projectQualifierFields(entryNote, state, generation),
  hydrateQualifier: (env, state) => hydrateQualifierFields(entryNote, env, state),
}];
