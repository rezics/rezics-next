import type { OccurrenceRecord } from '../structure/format.ts';
import { readNativeSelections } from '../export/selections.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { readPublicInstructionAdoptions } from '../work/instruction-adoption.ts';

export function readRecipeInstructions(session: WorkReadSession, records: readonly OccurrenceRecord[],
  cut?: { work: string; revision: string; admitted?: true }) {
  return readNativeSelections(session,records.filter(isAdoptedInstruction),cut ? () =>
    readPublicInstructionAdoptions(session.deps.environment,
      { ...cut,occurrences: records.filter(isAdoptedInstruction).map(record => record.occurrence) },session.viewer,
      cut.admitted ? new Set([cut.work]) : undefined) : undefined);
}
export type { NativeSelectionReference as InstructionReference, NativeSelection as RecipeInstruction } from '../export/selections.ts';

export const isAdoptedInstruction = (record: OccurrenceRecord) =>
  (record.role === 'instruction' || record.role === 'step') && record.selection?.mode === 'fixed-revision'
    && !!record.selection.selector;
