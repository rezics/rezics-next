import type { Pool } from 'pg';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import {
  RatingInventoryConflict,
  MAX_RATING_AGGREGATE_SLOTS,
  listTargetsNeedingReconstruction,
  readTargetRatingReconstructionBatch,
  recordTargetRatingValues,
} from './aggregate-inventory.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { RatingAggregateUnavailable } from './aggregate.ts';
import { readTargetRatingContext } from './target.ts';
import { TARGET_AGGREGATE_COST, verifyTargetRatingHeads } from './target-aggregate.ts';

/** The operator retains this cursor between invocations. A recovery cut requires
 * a fresh job; an old cursor can never certify inventory from a different cut. */
export interface LegacyRatingCursor {
  context: string;
  target: string;
  contextRevision: string;
  recoveryGeneration: string;
  afterSlot: string;
}

/** Each invocation verifies at most 100 immutable manifests within one aggregate
 * byte budget and deadline, then commits one CAS batch. No read endpoint runs it.
 * Retrying the last cursor after a lost response is safe: only unvalued live heads
 * are updated. Revisions racing the job already record their own new values. */
export const LEGACY_RECONSTRUCTION_COST = {
  heads: MAX_RATING_AGGREGATE_SLOTS,
  graphCalls: 3,
  accessCheckouts: 2,
  manifestBytes: TARGET_AGGREGATE_COST.manifestBytes,
  graphBytes: TARGET_AGGREGATE_COST.graphBytes,
  deadlineMs: TARGET_AGGREGATE_COST.deadlineMs,
} as const;

/** Targets whose heads still lack recorded values. Up to 100 raters stay readable
 * through the head-by-head check; larger ones answer 503 until reconstructed. */
export const listLegacyTargetsNeedingReconstruction = listTargetsNeedingReconstruction;

export async function reconstructLegacyTargetRatings(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: { context: string; target: string; batchSize?: number; cursor?: LegacyRatingCursor },
) {
  const batchSize = input.batchSize ?? LEGACY_RECONSTRUCTION_COST.heads;
  const signal = AbortSignal.timeout(LEGACY_RECONSTRUCTION_COST.deadlineMs);
  const manifestBudget = { bytesLeft: LEGACY_RECONSTRUCTION_COST.manifestBytes as number, signal };
  return fusekiReadBudget.run(
    {
      signal,
      callsLeft: LEGACY_RECONSTRUCTION_COST.graphCalls,
      bytesLeft: LEGACY_RECONSTRUCTION_COST.graphBytes,
    },
    async () => {
      const cursor = input.cursor;
      if (cursor && (cursor.context !== input.context || cursor.target !== input.target)) {
        throw new RatingInventoryConflict('Reconstruction cursor names another target');
      }
      const snapshot = await readTargetRatingReconstructionBatch(
        pool,
        input.context,
        input.target,
        cursor?.afterSlot ?? '',
        batchSize,
        signal,
      );
      if (
        cursor &&
        (cursor.recoveryGeneration !== snapshot.recoveryGeneration ||
          cursor.contextRevision !== snapshot.contextRevision)
      ) {
        throw new RatingInventoryConflict('Reconstruction cursor is stale');
      }
      const context = await readTargetRatingContext(env, input.context, manifestBudget);
      if (
        !context ||
        context.contextRevision !== snapshot.contextRevision ||
        context.realm !== snapshot.realm
      ) {
        throw new RatingAggregateUnavailable('Target Context seal differs');
      }
      const verified = await verifyTargetRatingHeads(
        env,
        snapshot,
        snapshot.heads,
        null,
        input,
        context,
        signal,
        true,
        manifestBudget,
      );
      const recorded = await recordTargetRatingValues(
        pool,
        input.context,
        input.target,
        snapshot.recoveryGeneration,
        verified.heads,
        signal,
      );
      const complete = snapshot.heads.length < batchSize;
      return {
        complete,
        scanned: snapshot.heads.length,
        recorded,
        cursor: complete
          ? null
          : {
              context: input.context,
              target: input.target,
              contextRevision: snapshot.contextRevision,
              recoveryGeneration: snapshot.recoveryGeneration,
              afterSlot: snapshot.heads.at(-1)!.slot,
            },
      };
    },
  );
}
