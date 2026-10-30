import type { CoverRatio } from './cover-model.ts';
import type { CoverSubject } from './cover-model.ts';

export type ListImageAspect = 'portrait' | 'landscape' | 'square';

/** The optional presentation released for one semantic Type. */
export type ListPresentation = {
  imageAspect: ListImageAspect;
  keyFacts: readonly string[];
};

const aspectRatios: Record<ListImageAspect, CoverRatio> = {
  portrait: '3:4',
  landscape: '16:9',
  square: '1:1',
};

const validCurie = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

/** Read the agreed optional annotation without filling or merging any of its values. */
export function parseListPresentation(value: unknown): ListPresentation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const imageAspect = record.imageAspect;
  const keyFacts = record.keyFacts;
  if (
    (imageAspect !== 'portrait' && imageAspect !== 'landscape' && imageAspect !== 'square') ||
    !Array.isArray(keyFacts) ||
    keyFacts.length > 4 ||
    !keyFacts.every((property) => typeof property === 'string' && validCurie.test(property)) ||
    new Set(keyFacts).size !== keyFacts.length
  )
    return undefined;
  return { imageAspect, keyFacts: [...keyFacts] as string[] };
}

export function listPresentationRatio(presentation: ListPresentation): CoverRatio {
  return aspectRatios[presentation.imageAspect];
}

const typeFallbacks = new Map<string, ListImageAspect>([
  ['schema:Book', 'portrait'],
  ['bf:Instance', 'portrait'],
  ['wd:Q47461344', 'portrait'],
  ['wd:Q3331189', 'portrait'],
  ['schema:BookSeries', 'portrait'],
  ['wd:Q277759', 'portrait'],
  ['schema:ComicSeries', 'portrait'],
  ['wd:Q21198342', 'portrait'],
  ['schema:PublicationVolume', 'portrait'],
  ['wd:Q1238720', 'portrait'],
  ['schema:Movie', 'landscape'],
  ['wd:Q11424', 'landscape'],
  ['schema:TVSeries', 'landscape'],
  ['wd:Q5398426', 'landscape'],
  ['schema:TVSeason', 'landscape'],
  ['wd:Q3464665', 'landscape'],
  ['schema:Episode', 'landscape'],
  ['wd:Q1983062', 'landscape'],
  ['schema:MusicAlbum', 'square'],
  ['wd:Q482994', 'square'],
  ['schema:Recipe', 'landscape'],
  ['wd:Q219239', 'landscape'],
]);

const factualFallbacks = new Map<string, readonly string[]>([
  ['schema:Movie', ['schema:duration']],
  ['wd:Q11424', ['schema:duration']],
  ['schema:TVSeries', ['schema:numberOfEpisodes']],
  ['wd:Q5398426', ['schema:numberOfEpisodes']],
  ['schema:TVSeason', ['schema:numberOfEpisodes']],
  ['wd:Q3464665', ['schema:numberOfEpisodes']],
  ['schema:Episode', ['schema:episodeNumber', 'schema:duration']],
  ['wd:Q1983062', ['schema:episodeNumber', 'schema:duration']],
]);

function firstTypeValue<T>(types: readonly string[], values: ReadonlyMap<string, T>): T | undefined {
  for (const type of types) {
    const value = values.get(type);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Explicit list geometry for current Types; an unknown Type leaves composition fallback in control. */
export function fallbackListPresentation(types: readonly string[]): ListPresentation | undefined {
  const imageAspect = firstTypeValue(types, typeFallbacks);
  return imageAspect === undefined ? undefined : { imageAspect, keyFacts: [] };
}

/** Runtime and episode facts are preferred only when the bounded read already supplied those properties. */
export function fallbackListFactProperties(types: readonly string[]): readonly string[] | undefined {
  return firstTypeValue(types, factualFallbacks);
}

/** Resolve the list geometry while leaving standalone Cover's legacy coverRatio behavior untouched. */
export function listPresentationForCover(
  subject: Pick<CoverSubject, 'types'>,
  optionalPresentation?: unknown,
): ListPresentation | undefined {
  return parseListPresentation(optionalPresentation) ?? fallbackListPresentation(subject.types);
}
