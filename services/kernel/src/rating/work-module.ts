import { createRatingCounter, type RatingCounter } from '../access/rating-counter.ts';
import type { WorkModule } from '../work/registry.ts';
import { createRatingAggregateEffect } from './aggregate-effect.ts';
import { createVoterEligibilityEffect } from './eligibility.ts';
import { createPopulationTotalEffect } from './population-total.ts';
import { createPublicFigureDrainEffect } from './public-figure.ts';
import { registerRatingSegmentWork } from './segment-job.ts';
import { createVoterRealmsEffect } from './voter-realms.ts';
import { registerRatingSubjectMergeWork } from './merge-job.ts';

// Controller composition invokes bounded repair steps; no second repair workflow owns replacements.
export { createRatingIdentityRepairCommands } from './identity-repair.ts';

export const RATING_COUNTER_SECRET_ENV = 'KERNEL_RATING_COUNTER_SECRET';

function counterSecret(value: string | undefined): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${RATING_COUNTER_SECRET_ENV} must be configured as base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || decoded.byteLength < 32)
    throw new Error(`${RATING_COUNTER_SECRET_ENV} must contain at least 32 bytes`);
  return new Uint8Array(decoded);
}

/** Trusted worker composition may inject the stable private counting-key port. */
export function createRatingWorkModule(ratingCounter?: RatingCounter): WorkModule {
  return {
    name: 'rating',
    register(context) {
      const counter =
        ratingCounter ?? createRatingCounter({ secret: counterSecret(context.env[RATING_COUNTER_SECRET_ENV]) });
      context.addEffects([
        createRatingAggregateEffect(context.pool, counter),
        createPopulationTotalEffect(context.pool),
        createPublicFigureDrainEffect(context.pool),
        createVoterRealmsEffect(context.pool),
        createVoterEligibilityEffect(context.pool),
      ]);
      // The direct module-registration test uses a minimal context; composed workers always provide a DBOS client.
      if (context.client) {
        registerRatingSegmentWork(context, counter);
        registerRatingSubjectMergeWork(context);
      }
    },
  };
}

export const ratingWorkModule = createRatingWorkModule();
