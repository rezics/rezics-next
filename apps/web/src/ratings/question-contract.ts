import type { KernelClient } from '@rezics/client';

export type RatingQuestion = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['rating-questions']>['get']>>['data']
>;

/** PublicFigure numbers already use this documented display domain, rather than vote units. */
export const PUBLIC_RATING_SCALE = { min: 0, max: 10 } as const;

/** The standard question maps its stored bounds and step to the published display domain. */
export function displayRating(units: number, scale: RatingQuestion['scale']): number {
  return (
    PUBLIC_RATING_SCALE.min +
    ((units - scale.min) / (scale.max - scale.min)) * (PUBLIC_RATING_SCALE.max - PUBLIC_RATING_SCALE.min)
  );
}
