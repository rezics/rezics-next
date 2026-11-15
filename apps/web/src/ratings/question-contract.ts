import type { KernelClient } from '@rezics/client';
import { QUESTION } from './question-ids';

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

/** Subject pages present the Global standard scale; custom question controls retain native units. */
export function voteDisplayNumber(locale: string, { id, scale }: Pick<RatingQuestion, 'id' | 'scale'>) {
  const number = new Intl.NumberFormat(locale);
  const display = (units: number) => (id === QUESTION ? displayRating(units, scale) : units);
  return {
    value: (units: number) => number.format(display(units)),
    min: number.format(display(scale.min)),
    max: number.format(display(scale.max)),
    step: number.format(display(scale.min + scale.displayStep) - display(scale.min)),
  };
}
