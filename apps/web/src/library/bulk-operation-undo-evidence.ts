import * as v from 'valibot';
import type { BulkRead, BulkOutcomes } from './bulk-operation-recovery-native';

// The authorized native outcome route owns subject binding. Decode its additive wire fields
// until the shared generated client declarations include the installed receiving contract.
const deletion = v.object({
  deletionId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  restoreUntil: v.string(),
});
const evidence = v.object({ deletion: v.nullish(deletion, null) });
export type BulkUndoOutcome = BulkOutcomes['outcomes'][number] & {
  deletion: v.InferOutput<typeof deletion> | null;
};
export type BulkUndoRead =
  | Exclude<BulkRead, { state: 'ready' }>
  | {
      state: 'ready';
      operation: Extract<BulkRead, { state: 'ready' }>['operation'];
      page: { outcomes: BulkUndoOutcome[]; next: string | null };
    };

export function receiveUndoEvidence(result: BulkRead): BulkUndoRead {
  if (result.state !== 'ready') return result;
  return {
    ...result,
    page: {
      ...result.page,
      outcomes: result.page.outcomes.map((outcome) => {
        const parsed = v.safeParse(evidence, outcome);
        return { ...outcome, deletion: parsed.success ? parsed.output.deletion : null };
      }),
    },
  };
}
