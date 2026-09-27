import type { WorkCoverImage, WorkCoverKind } from '@rezics/ui/work-cover';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { WorkCover as MainCover, WorkName } from '../discover/types.ts';

/**
 * One Work as a catalogue card shows it: what a reader recognizes (cover,
 * title, authors, rating), never scopes, Contexts or identifiers. Each surface
 * builds these from its own Main read.
 */
export interface CatalogueWork {
  /** The Work IRI; it seeds the generated cover and keys reader state. */
  id: string;
  href: string;
  /** Null when Main could not name the Work; the card falls back to its short ID. */
  title: WorkName | null;
  cover: MainCover | null;
  kind: WorkCoverKind;
  /** Display names in credit order. Empty when Main names no author. */
  authors: readonly string[];
  rating: CardRating | null;
}

/** A mean on its own scale; `own` is the reader's single rating (Mine), which has no count. */
export interface CardRating { mean: number; count: number; max: number; own?: boolean }

// Main's Work semantic types (`WORK_SEMANTIC_TYPES` in services/main/src/modules/work/activate.ts).
const kinds: Record<string, WorkCoverKind> = {
  'https://schema.org/Book': 'book',
  'https://schema.org/DigitalDocument': 'document',
  'https://schema.org/Recipe': 'recipe',
};

/** The cover a Work's types call for; a Work that is also a Book is shown as one. */
export function coverKindOf(types: readonly string[]): WorkCoverKind {
  const known = types.map(type => kinds[type]).filter(kind => kind !== undefined);
  return known.includes('book') ? 'book' : known[0] ?? 'book';
}

/**
 * A selected cover image through the BFF, which adds the session's token;
 * `avatarQuery` names the acting Agent Main then requires. Only Main media
 * paths are loaded.
 */
export function coverImage(cover: MainCover | null, avatarQuery = ''): WorkCoverImage | null {
  if (cover?.kind !== 'image' || !cover.url.startsWith('/v1/media/')) return null;
  return { src: `${BFF_PREFIX}${cover.url}${avatarQuery}`, width: cover.width, height: cover.height };
}

/** The first eight characters of a Work IRI's UUID, a readable stand-in while it has no name. */
export const shortWorkId = (iri: string) => iri.slice(-36, -28);

/** The tallest cover proportion in a set, so a row of mixed kinds lines up at the foot. */
export function slotRatio(works: readonly Pick<CatalogueWork, 'kind'>[]): number {
  if (works.some(work => work.kind === 'book')) return 2 / 3;
  return works.some(work => work.kind === 'document') ? 3 / 4 : 1;
}

/** "4.26", "4" or "8.6": up to two decimals, as Goodreads shows a mean. */
export function formatMean(mean: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(mean);
}

/** "41.9K", "4.2万": a count as a short number in the interface language. */
export function formatCompact(count: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}
