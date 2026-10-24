import { projectRecipeFacts, hydrateRecipeFacts, recipeFactValidations, projectRecipeMeasures, canonicalRecipeQualifier } from './fact-projection.ts';
import { RV, iri } from '../work/activate.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import { InvalidStructureObject } from '../structure/format.ts';
import { checkExactInstructionSelection } from '../structure/selection.ts';
import { CompositionUnavailable } from '../structure/unavailable.ts';
import { checkRecipeQualifier } from './occurrence-validation.ts';
import { ingredientReferences } from './references.ts';

/** Recipe work owns a Main Version Structure whose revisions retain each line occurrence. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'recipe-composition',
  workPublication: true,
  // The verifier reads the completed Structure registry. Loading it during
  // discovery would make registration wait for its own pending module.
  async verifySourceCorrespondence(input) {
    const { verifyRecipeSource } = await import('./source-correspondence.ts');
    return verifyRecipeSource(input);
  },
  projectPublicationDependency: (source, dependency) =>
    `${iri(source)} <https://schema.org/recipeInstructions> ${iri(dependency)} .`,
  graphProfile: `${RV}RecipeComposition`,
  ownerType: 'https://schema.org/Recipe',
  componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`,
  editScopePrefix: 'work:edit:',
  editPermission: 'work:edit',
  editAction: 'recipe.edit',
  receiptFamily: 'structure-command',
  targetPattern: /^(?:https:\/\/rezics\.com\/id\/|urn:rezics:media:asset:)[0-9a-f-]{36}$/,
  async authorizeTarget(authority) {
    const { canReadContentTarget, ContentDraftUnavailable, resolveContentTarget } = await import('../content-publication/draft.ts');
    if (!authority.environment) return false;
    if (authority.target.startsWith('urn:rezics:media:asset:')) {
      if (!authority.targetReader || !await authority.access.canManageMedia?.(authority.principal, authority.actingSubject)) return false;
      return authority.targetReader(async session => {
        const asset = await session.deps.media?.store.readAsset(authority.target.slice('urn:rezics:media:asset:'.length));
        return asset?.owner === authority.actingSubject;
      });
    }
    try {
      const target = await resolveContentTarget(authority.environment, authority.target);
      return await canReadContentTarget(authority.environment, authority.access, authority.principal,
        authority.actingSubject, authority.target, target);
    } catch (error) {
      if (error instanceof ContentDraftUnavailable) return false;
      throw error;
    }
  },
  async validateSelection(reader, target, selection) {
    if (selection.mode !== 'fixed-revision' || !selection.selector) return;
    const selector = checkExactInstructionSelection(target, selection.revision, selection.selector);
    await reader(async session => {
      const { WorkReadSession } = await import('../work/read-session.ts');
      if (!(session instanceof WorkReadSession)) throw new CompositionUnavailable('Instruction owner read is unavailable');
      const { resolveContentReference } = await import('../content-publication/reference.ts');
      if (selector.grain === 'content') {
        const { resolveContentTarget } = await import('../content-publication/draft.ts');
        const owner = await resolveContentTarget(session.deps.environment, target);
        if (owner.type !== 'https://rezics.com/vocab/Post') throw new CompositionUnavailable('Instructions require an authored Post');
      } else {
        const exact = (await session.deps.content?.readExactBatch([selector.revision], async ids => new Set(ids)))?.[0];
        if (exact?.status !== 'available' || !['audio', 'video'].includes(String(exact.body.mediaKind))) {
          throw new CompositionUnavailable('Instructions require an exact recording representation');
        }
      }
      const selected = await resolveContentReference(session, { target, selector });
      if (selected.status !== 'available') throw new CompositionUnavailable('Instruction selection is unavailable');
      if (selector.grain === 'content' && selector.block) {
        const block = selected.document?.doc.content?.[0];
        if (block?.type !== 'extensionBlock' || block.attrs?.definition !== 'https://rezics.com/definition/procedure-v1') {
          throw new CompositionUnavailable('Instruction procedure block is unavailable');
        }
      }
    });
  },
  catalogTargetTypes: ['https://schema.org/Recipe', 'https://schema.org/HowToStep',
    'https://schema.org/HowToSection', 'https://schema.org/Thing'],
  searchableRoles: ['instruction', 'step'],
  roles: ['group', 'ingredient', 'step', 'instruction', 'equipment'],
  containerRoles: ['group'], readingRoles: ['ingredient', 'step', 'instruction', 'equipment'],
  localReferences: ingredientReferences,
  mixedOperationKinds: [['update', 'remove']],
  targetRoles: ['instruction'],
  optionalTargetRoles: ['ingredient', 'equipment', 'step'],
  selectionRequiredRoles: ['instruction'],
  selectionOptionalRoles: ['step'],
  selectionSelectorRoles: ['instruction', 'step'],
  checkOccurrence(record) {
    if (record.qualifier) checkRecipeQualifier(record.qualifier);
    if (record.role !== 'instruction' && record.role !== 'step') return;
    if (record.target) {
      if (record.qualifier || record.selection?.mode !== 'fixed-revision') {
        throw new InvalidStructureObject('adopted instructions require an exact selection and no text qualifier');
      }
      try { checkExactInstructionSelection(record.target, record.selection.revision, record.selection.selector); }
      catch (error) { throw new InvalidStructureObject((error as Error).message); }
    } else if (!record.qualifier) throw new InvalidStructureObject('instructions require an admitted authored form');
  },
  measures: true,
  qualifiers: {
    ingredient: { type: 'ingredient-line', required: true },
    step: { type: 'recipe-step', required: false },
  },
  projectQualifier: projectRecipeFacts,
  canonicalQualifier: canonicalRecipeQualifier,
  hydrateQualifier: hydrateRecipeFacts,
  qualifierValidations: recipeFactValidations,
  projectRevisionFacts: projectRecipeMeasures,
  projectionBatchRecords: 16,
}];
