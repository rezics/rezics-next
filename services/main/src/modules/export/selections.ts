import type { DocumentSnapshot } from '@rezics/document';
import type { OccurrenceRecord } from '../structure/format.ts';
import type { ExactInstructionSelector } from '../structure/selection.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadLimit } from '../work/read-session.ts';
import { resolveContentReference } from '../content-publication/reference.ts';

export interface NativeSelectionReference { target: string; selector: ExactInstructionSelector }
export interface NativeSelection {
  occurrence: string; reference: NativeSelectionReference; status: 'available' | 'unavailable';
  document?: DocumentSnapshot; mediaUse?: string;
  text?: string;
}

export interface NativeSelectionAdmission {
  occurrence: string; target: string; selector: ExactInstructionSelector; mediaUse?: string;
}
export type NativeSelectionAdmissionReader = () => Promise<readonly NativeSelectionAdmission[]>;

export const isExactNativeSelection = (record: OccurrenceRecord) =>
  record.selection?.mode === 'fixed-revision'
    && !!record.selection.selector;

/** Hydrates only this bounded page, deduplicating selections without deduplicating ordered uses. */
export async function readNativeSelections(session: WorkReadSession, records: readonly OccurrenceRecord[],
  admissions?: NativeSelectionAdmissionReader):
  Promise<NativeSelection[]> {
  const adopted = records.filter(isExactNativeSelection);
  const instructions: NativeSelection[] = [];
  const readAdoptions = admissions ?? (() => Promise.resolve([]));
  const adoptions = adopted.length ? await readAdoptions() : [];
  if (adoptions.length) session.observeDependency('native-selection-admissions', adoptions, readAdoptions);
  const exact = new Map<string, Awaited<ReturnType<typeof resolveContentReference>>>();
  for (const record of adopted) {
    if (record.selection?.mode !== 'fixed-revision' || !record.selection.selector || !record.target) continue;
    const reference = { target: record.target, selector: record.selection.selector };
    const instruction: NativeSelection = { occurrence: record.occurrence, reference, status: 'unavailable' };
    const selector = reference.selector;
    if (selector.grain === 'content') {
      const key = JSON.stringify(reference);
      let value = exact.get(key);
      if (!value) {
        const matches = (items: typeof adoptions) => items.some(item => item.occurrence === record.occurrence
          && item.target === record.target && JSON.stringify(item.selector) === JSON.stringify(selector));
        // The surrounding Structure read already admits this publication. Repeat
        // its exact cut without rediscovering the same Work for every block.
        value = await resolveContentReference(session, reference,
          matches(adoptions) ? async () => matches(await readAdoptions()) : undefined);
        exact.set(key, value);
      }
      if (value.status === 'available') {
        instruction.status = 'available';
        if (value.document) instruction.document = value.document;
        else if (value.text !== undefined) instruction.text = value.text;
      }
    } else {
      const adoption = adoptions.find(item => item.occurrence === record.occurrence && item.target === record.target
        && JSON.stringify(item.selector) === JSON.stringify(selector));
      if (adoption?.mediaUse && session.deps.media) {
        const use = adoption.mediaUse;
        const read = () => session.deps.media!.store.presentation.metadata([{ representation: selector.representation, use }]);
        const metadata = await read();
        session.observeDependency(`native-selection-media:${use}`, metadata, read);
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
      } else {
        // A readable private Structure has no publication Use. Resolve its
        // exact selection through Media's existing owner/disclosure authority;
        // previewing it must not manufacture a public attachment.
        const resolved = await resolveContentReference(session, reference);
        instruction.status = resolved.status;
      }
    }
    instructions.push(instruction);
  }
  if (Buffer.byteLength(JSON.stringify(instructions)) > 1_048_576) throw new WorkReadLimit('Native selections exceed 1 MiB');
  return instructions;
}
