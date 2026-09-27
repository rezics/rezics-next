import type { FeedKind } from '../feed/contract.ts';
import type { HomeInterestKind } from './contract.ts';

export interface InterestSources {
  /** RDF types on a Work. DigitalDocument alone is deliberately unclassified. */
  workTypes: readonly string[];
  /** Exact, case-insensitive labels on accepted global Classification Senses. */
  classificationTerms: readonly string[];
  activityKinds: readonly FeedKind[];
}

export const interestKinds = ['books', 'software', 'ai', 'recipes', 'media', 'discussions'] as const satisfies readonly HomeInterestKind[];

/** Product mapping over admitted Work types, Hub types, curated terms and
 * Realm activity. Package and mod labels cover Works classified from those
 * providers; a generic DigitalDocument never proves a software kind. */
export const interestSources = {
  books: { workTypes: ['https://schema.org/Book', 'https://schema.org/BookSeries'],
    classificationTerms: ['fiction', 'serial', 'serial fiction'], activityKinds: [] },
  software: { workTypes: ['https://schema.org/SoftwareApplication',
    'https://schema.org/SoftwareSourceCode'],
    classificationTerms: ['software', 'software package', 'package', 'mod', 'game mod',
      'go module', 'modrinth', 'curseforge'], activityKinds: [] },
  ai: { workTypes: ['https://rezics.com/vocab/SkillPackage',
    'https://rezics.com/vocab/PromptTemplate'],
    classificationTerms: ['ai', 'artificial intelligence', 'prompt', 'skill'], activityKinds: [] },
  recipes: { workTypes: ['https://schema.org/Recipe'], classificationTerms: ['recipe'], activityKinds: [] },
  media: { workTypes: ['https://schema.org/Movie', 'https://schema.org/TVSeries',
    'https://schema.org/VideoObject', 'https://schema.org/AudioObject',
    'https://schema.org/MusicRecording', 'https://schema.org/MusicAlbum'],
    classificationTerms: ['film', 'tv', 'animation', 'music', 'video'], activityKinds: [] },
  discussions: { workTypes: [], classificationTerms: [], activityKinds: ['discussion', 'reply'] },
} as const satisfies Record<HomeInterestKind, InterestSources>;

export function matchingWorkKinds(types: readonly string[], terms: readonly string[]): HomeInterestKind[] {
  const typeSet = new Set(types);
  const termSet = new Set(terms.map(term => term.trim().toLowerCase()));
  return interestKinds.filter(kind => interestSources[kind].workTypes.some(type => typeSet.has(type))
    || interestSources[kind].classificationTerms.some(term => termSet.has(term)));
}

export function matchingActivityKinds(kind: FeedKind): HomeInterestKind[] {
  return interestKinds.filter(interest => interestSources[interest].activityKinds.some(item => item === kind));
}
