import type { WorkCoverImage, WorkCoverKind, WorkCoverProps } from '@rezics/ui/work-cover';
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
  /** A one-line pitch in the reader's language, set under the title. */
  tagline?: WorkName | null;
  /** Serial state; only unfinished serials are marked on the cover. */
  completion?: 'ongoing' | 'completed' | 'hiatus' | null;
}

/** A mean on its own scale; `own` is the reader's single rating (Mine), which has no count. */
export interface CardRating { mean: number; count: number; max: number; own?: boolean }

// Main's Work semantic types (`workKinds` in services/main/src/modules/work/work-kinds.ts) as the
// object a generated cover imitates: bound books, recipe cards, package tiles for what is
// installed, and posters for documents, prompts and media.
const kinds: Record<string, WorkCoverKind> = {
  'https://schema.org/Book': 'book',
  'https://schema.org/BookSeries': 'book',
  'https://schema.org/Recipe': 'recipe',
  'https://schema.org/SoftwareApplication': 'package',
  'https://schema.org/SoftwareSourceCode': 'package',
  'https://rezics.com/vocab/ModPackage': 'package',
  'https://rezics.com/vocab/SkillPackage': 'package',
  'https://schema.org/DigitalDocument': 'document',
  'https://rezics.com/vocab/PromptTemplate': 'document',
  'https://schema.org/Movie': 'document',
  'https://schema.org/TVSeries': 'document',
  'https://schema.org/VideoObject': 'document',
  'https://schema.org/AudioObject': 'document',
  'https://schema.org/MusicRecording': 'document',
  'https://schema.org/MusicAlbum': 'document',
};
const precedence: readonly WorkCoverKind[] = ['book', 'recipe', 'package', 'document'];

/**
 * The cover a Work's types call for, the same on every surface: a Work that
 * is also a Book is shown as one, then a recipe, then a package. Main types
 * a Work with at most three, in no order. A read that does not carry the
 * types draws a book, so every surface that shows covers should read them.
 */
export function coverKindOf(types: readonly string[]): WorkCoverKind {
  const known = new Set(types.map(type => kinds[type]));
  return precedence.find(kind => known.has(kind)) ?? 'book';
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

// The most specific first: a prompt that is also a document is a prompt.
const typeLabels = [
  ['https://rezics.com/vocab/PromptTemplate', 'typePrompt'], ['https://rezics.com/vocab/SkillPackage', 'typeSkill'],
  ['https://rezics.com/vocab/ModPackage', 'typeMod'], ['https://schema.org/Recipe', 'typeRecipe'],
  ['https://schema.org/Book', 'typeBook'], ['https://schema.org/BookSeries', 'typeBook'],
  ['https://schema.org/SoftwareApplication', 'typeSoftware'], ['https://schema.org/SoftwareSourceCode', 'typeSoftware'],
  ['https://schema.org/Movie', 'typeFilm'], ['https://schema.org/TVSeries', 'typeSeries'],
  ['https://schema.org/VideoObject', 'typeVideo'], ['https://schema.org/AudioObject', 'typeAudio'],
  ['https://schema.org/MusicRecording', 'typeMusic'], ['https://schema.org/MusicAlbum', 'typeMusic'],
  ['https://schema.org/DigitalDocument', 'typeGuide'],
] as const;

/** The catalogue message naming what a Work is ("Recipe", "Prompt"), or null for an untyped Work. */
export function workTypeLabel(types: readonly string[]): (typeof typeLabels)[number][1] | null {
  return typeLabels.find(([type]) => types.includes(type))?.[1] ?? null;
}

/** What a Work's one cover is drawn from, wherever it appears. */
export type CoverWork = Pick<CatalogueWork, 'id' | 'title' | 'cover' | 'kind' | 'authors'>;

/**
 * The `WorkCover` props for a Work: its id (only the UUID picks the design),
 * kind, title and authors, and a selected image through the BFF. Main's
 * fallback avatar key is never the seed: reads choose it differently, and the
 * Work would wear another cover on another page.
 */
export function coverProps(work: CoverWork, avatarQuery = ''): WorkCoverProps {
  return { id: work.id, kind: work.kind, title: work.title?.value ?? '', lang: work.title?.language,
    dir: work.title?.direction, authors: work.authors, image: coverImage(work.cover, avatarQuery) };
}

const spoken = (tag: string) => {
  try {
    const locale = new Intl.Locale(tag).maximize();
    return `${locale.language}-${locale.script ?? ''}`;
  } catch { return tag.toLowerCase(); }
};

/**
 * Whether a title is in another language than the interface, so a screen
 * reader hears why it is not in theirs. Main marks a title `fallback` when it
 * had none in the requested language, or when the read asked for none; only a
 * title whose language (and script: 简体 is not 繁體) differs counts.
 */
export function otherLanguageTitle(title: WorkName | null, locale: UiLocale): boolean {
  return title?.basis === 'fallback' && spoken(title.language) !== spoken(locale);
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
