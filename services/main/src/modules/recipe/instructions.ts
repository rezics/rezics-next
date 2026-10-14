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
  text?: string;
}

export const isAdoptedInstruction = (record: OccurrenceRecord) =>
  (record.role === 'instruction' || record.role === 'step') && record.selection?.mode === 'fixed-revision'
    && !!record.selection.selector;

/** Hydrates only this bounded page, deduplicating revisions without deduplicating ordered uses. */
export async function readRecipeInstructions(session: WorkReadSession, records: readonly OccurrenceRecord[],
  cut?: { work: string; revision: string; admitted?: true }):
  Promise<RecipeInstruction[]> {
  const adopted = records.filter(isAdoptedInstruction);
  const instructions: RecipeInstruction[] = [];
  const readAdoptions = () => cut ? readPublicInstructionAdoptions(session.deps.environment, cut, session.viewer,
    cut.admitted ? new Set([cut.work]) : undefined) : Promise.resolve([]);
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
        && value.reference.variantId === selector.variantId && (value.body.document || typeof value.body.body === 'string')) {
        instruction.status = 'available';
        if (value.body.document) instruction.document = value.body.document as DocumentSnapshot;
        else instruction.text = value.body.body as string;
      }
    } else {
      const adoption = adoptions.find(item => item.occurrence === record.occurrence && item.target === record.target
        && JSON.stringify(item.selector) === JSON.stringify(selector));
      if (adoption?.mediaUse && session.deps.media) {
        const use = adoption.mediaUse;
        const read = () => session.deps.media!.store.presentation.metadata([{ representation: selector.representation, use }]);
        const metadata = await read();
        session.observeDependency(`recipe-instruction-media:${use}`, metadata, read);
        const occurrence = { owner: 'media' as const, kind: 'media-use' as const,
          resource: `https://rezics.com/id/${use}`, revision: `https://rezics.com/id/${use}` };
        const allowed = metadata[0] && (await session.disclosure([
          { owner: 'media', resource: `https://rezics.com/id/${use}`, component: 'media_use', occurrence },
          { owner: 'media', resource: `https://rezics.com/id/${metadata[0].metadata.asset}`, component: 'cover', occurrence },
        ], 'media')).every(decision => decision === 'visible');
        if (allowed) {
          instruction.status = 'available';
          instruction.mediaUse = use;
        }
      }
    }
    instructions.push(instruction);
  }
  if (Buffer.byteLength(JSON.stringify(instructions)) > 1_048_576) throw new WorkReadLimit('Recipe instructions exceed 1 MiB');
  return instructions;
}
