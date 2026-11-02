import type { Figure } from './subject-ratings';

export type RatingPopulationPageValue = {
  populations: { population: string; count: number }[];
  next: string | null;
};

export type RatingAggregateValue = {
  question: string;
  subject: string;
  figures: Figure[];
};

type RatingFreshness = { asOf: string | null; updating: boolean };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateTime = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function ratingFreshness(value: unknown): RatingFreshness | null {
  if (!record(value) || !exactKeys(value, ['asOf', 'updating']) || typeof value.updating !== 'boolean') return null;
  if (value.asOf !== null && (typeof value.asOf !== 'string' || !dateTime.test(value.asOf) || !Number.isFinite(Date.parse(value.asOf))))
    return null;
  return { asOf: value.asOf, updating: value.updating };
}

function ratingFigure(value: unknown): Figure | null {
  if (!record(value) || !uuid.test(String(value.population)) || !safeInteger(value.count, 0)) return null;
  const freshness = ratingFreshness(value.freshness);
  if (!freshness) return null;

  const hasMean = Object.prototype.hasOwnProperty.call(value, 'mean');
  const hasHistogram = Object.prototype.hasOwnProperty.call(value, 'histogram');
  const hasRemaining = Object.prototype.hasOwnProperty.call(value, 'remaining');
  if (hasMean || hasHistogram) {
    if (
      !hasMean ||
      !hasHistogram ||
      hasRemaining ||
      !exactKeys(value, ['population', 'count', 'freshness', 'mean', 'histogram']) ||
      typeof value.mean !== 'number' ||
      !Number.isFinite(value.mean) ||
      !Array.isArray(value.histogram) ||
      value.histogram.length < 1 ||
      !value.histogram.every((bin) => safeInteger(bin, 0))
    )
      return null;
    return {
      population: value.population as string,
      count: value.count,
      mean: value.mean,
      histogram: value.histogram,
      freshness,
    };
  }

  if (hasRemaining) {
    if (!exactKeys(value, ['population', 'count', 'freshness', 'remaining']) || !safeInteger(value.remaining, 1))
      return null;
    return { population: value.population as string, count: value.count, remaining: value.remaining, freshness };
  }

  if (!exactKeys(value, ['population', 'count', 'freshness'])) return null;
  return { population: value.population as string, count: value.count, freshness };
}

/** Admit only a native rating population page, while retaining sparse pages and opaque native cursors. */
export function admitRatingPopulationPage(value: unknown): RatingPopulationPageValue | null {
  if (
    !record(value) ||
    !exactKeys(value, ['populations', 'next']) ||
    !Array.isArray(value.populations) ||
    value.populations.length > 20 ||
    (value.next !== null && typeof value.next !== 'string')
  )
    return null;

  const seen = new Set<string>();
  const populations: RatingPopulationPageValue['populations'] = [];
  for (const item of value.populations) {
    if (
      !record(item) ||
      !exactKeys(item, ['population', 'count']) ||
      typeof item.population !== 'string' ||
      !uuid.test(item.population) ||
      !safeInteger(item.count, 1) ||
      seen.has(item.population)
    )
      return null;
    seen.add(item.population);
    populations.push({ population: item.population, count: item.count });
  }

  return { populations, next: value.next };
}

/** Admit one aggregate only when it matches the exact subject, question and unique requested identities. */
export function admitRatingAggregate(
  value: unknown,
  expected: { subject: string; question: string; populations: readonly string[] },
): RatingAggregateValue | null {
  if (
    !uuid.test(expected.subject) ||
    !uuid.test(expected.question) ||
    expected.populations.length < 1 ||
    expected.populations.length > 20 ||
    expected.populations.some((population) => !uuid.test(population)) ||
    new Set(expected.populations).size !== expected.populations.length ||
    !record(value) ||
    !exactKeys(value, ['question', 'subject', 'figures']) ||
    typeof value.question !== 'string' ||
    !uuid.test(value.question) ||
    value.question !== expected.question ||
    typeof value.subject !== 'string' ||
    !uuid.test(value.subject) ||
    value.subject !== expected.subject ||
    !Array.isArray(value.figures) ||
    value.figures.length < 1 ||
    value.figures.length > 20 ||
    value.figures.length !== expected.populations.length
  )
    return null;

  const requested = new Set(expected.populations);
  const seen = new Set<string>();
  const figures: Figure[] = [];
  for (const rawFigure of value.figures) {
    const figure = ratingFigure(rawFigure);
    if (!figure || !requested.has(figure.population) || seen.has(figure.population)) return null;
    seen.add(figure.population);
    figures.push(figure);
  }
  return seen.size === requested.size ? { question: value.question, subject: value.subject, figures } : null;
}
