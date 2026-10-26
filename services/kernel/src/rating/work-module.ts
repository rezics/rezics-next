import { createRatingCounter, type RatingCounter } from '../access/rating-counter.ts';
import type { WorkModule } from '../work/registry.ts';
import { createRatingAggregateEffect } from './aggregate-effect.ts';

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
      context.addEffects([createRatingAggregateEffect(context.pool, counter)]);
    },
  };
}

export const ratingWorkModule = createRatingWorkModule();
