import type { DocumentSnapshot } from '@rezics/document';
import type { OccurrenceRecord } from '../structure/format.ts';
import type { ExactInstructionSelector } from '../structure/selection.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadLimit } from '../work/read-session.ts';
import { readPublicInstructionAdoptions } from '../work/instruction-adoption.ts';

export interface InstructionReference { target: string; selector: ExactInstructionSelector }
export interface RecipeInstruction {
  occurrence: string; reference: InstructionReference; status: 'available' | 'unavailable';
  document?: DocumentSnapshot; mediaUse?: string;
}

export const isAdoptedInstruction = (record: OccurrenceRecord) =>
  (record.role === 'instruction' || record.role === 'step') && record.selection?.mode === 'fixed-revision'
    && !!record.selection.selector;

/** Hydrates only this bounded page, deduplicating revisions without deduplicating ordered uses. */
export async function readRecipeInstructions(session: WorkReadSession, records: readonly OccurrenceRecord[],
  cut?: { work: string; revision: string }):
  Promise<RecipeInstruction[]> {
  const adopted = records.filter(isAdoptedInstruction);
  const instructions: RecipeInstruction[] = [];
  const readAdoptions = () => cut ? readPublicInstructionAdoptions(session.deps.environment, cut) : Promise.resolve([]);
  const adoptions = adopted.some(record => record.selection?.mode === 'fixed-revision'
    && record.selection.selector?.grain === 'representation') ? await readAdoptions() : [];
  if (adoptions.length) session.observeDependency(`recipe-instruction-adoptions:${cut?.revision}`, adoptions, readAdoptions);
  const revisions = [...new Set(adopted.flatMap(record => record.selection?.mode === 'fixed-revision'
    && record.selection.selector?.grain === 'content' ? [record.selection.revision] : []))];
  const exact = new Map<string, Awaited<ReturnType<NonNullable<typeof session.deps.content>['readExactBatch']>>[number]>();
  for (let offset = 0; offset < revisions.length; offset += 16) {
    const batch = revisions.slice(offset, offset + 16);
    const read = () => session.deps.content!.readExactBatch(batch, async ids => new Set(ids));
    if (!session.deps.content) continue;
    const results = await read();
    session.observeDependency(`recipe-instruction-content:${batch.join(',')}`, results, read);
    for (const result of results) exact.set(result.revisionId, result);
  }
  for (const record of adopted) {
    if (record.selection?.mode !== 'fixed-revision' || !record.selection.selector || !record.target) continue;
    const reference = { target: record.target, selector: record.selection.selector };
    const instruction: RecipeInstruction = { occurrence: record.occurrence, reference, status: 'unavailable' };
    const selector = reference.selector;
    if (selector.grain === 'content') {
      const value = exact.get(selector.revision);
      if (value?.status === 'available' && value.reference.resourceId === reference.target
        && value.reference.variantId === selector.variantId && value.body.document) {
        instruction.status = 'available';
        instruction.document = value.body.document as DocumentSnapshot;
      }
    } else {
      const adoption = adoptions.find(item => item.occurrence === record.occurrence && item.target === record.target
        && JSON.stringify(item.selector) === JSON.stringify(selector));
      if (adoption?.mediaUse && await session.deps.media?.store.itemDelivery(adoption.mediaUse)) {
        instruction.status = 'available';
        instruction.mediaUse = adoption.mediaUse;
      }
    }
    instructions.push(instruction);
  }
  if (Buffer.byteLength(JSON.stringify(instructions)) > 1_048_576) throw new WorkReadLimit('Recipe instructions exceed 1 MiB');
  return instructions;
}
