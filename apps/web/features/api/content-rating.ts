import type { ImageAgeRating } from '@rezics/ui/media-image';
import { BFF_PREFIX } from './browser.ts';

/** Null is an unresolved assessment, never evidence that the body is unavailable or unrated. */
export type ContentRatings = Readonly<Record<string, ImageAgeRating | null>>;
export const contentRatingTarget = (target: string) => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target);

function assessment(value: unknown): ImageAgeRating | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.status === 'unassessed') return { status: 'unassessed' };
  if (item.status !== 'assessed' || !Array.isArray(item.labels) || item.labels.length > 2
    || item.labels.some(label => !['r15', 'r18', 'r18g'].includes(label))
    || new Set(item.labels).size !== item.labels.length
    || item.labels.includes('r15') && item.labels.length !== 1) return null;
  return { status: 'assessed', labels: item.labels as Extract<ImageAgeRating, { status: 'assessed' }>['labels'] };
}

/** Responses identify their actual target; response ordering grants no rating to another body. */
export async function resolveContentRatings(targets: string[], actingSubject?: string | null,
  fetcher: typeof fetch = fetch): Promise<ContentRatings> {
  if (!targets.length || targets.length > 64 || targets.some(target => !contentRatingTarget(target)))
    throw new Error('Content rating batch is invalid');
  const wanted = new Set(targets);
  const response = await fetcher(`${BFF_PREFIX}/v1/suitability/reads`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    // Without an eligible page identity, public reads must omit the session cookie/bearer.
    credentials: actingSubject ? 'same-origin' : 'omit',
    body: JSON.stringify({ targets, ...(actingSubject ? { actingSubject } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Content rating unavailable');
  const result = await response.json() as { items?: unknown };
  if (!Array.isArray(result.items)) throw new Error('Incomplete content ratings');
  const ratings: Record<string, ImageAgeRating | null> = Object.fromEntries(targets.map(target => [target, null]));
  const received = new Set<string>();
  for (const value of result.items) {
    if (!value || typeof value !== 'object') throw new Error('Invalid content rating');
    const item = value as { target?: { resource?: unknown }; assessment?: unknown };
    const target = item.target?.resource;
    if (typeof target !== 'string' || !wanted.has(target) || received.has(target))
      throw new Error('Unexpected content rating target');
    received.add(target);
    ratings[target] = assessment(item.assessment);
  }
  return ratings;
}
