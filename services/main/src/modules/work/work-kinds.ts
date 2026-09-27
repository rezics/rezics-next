import type { FeedKind } from '../feed/contract.ts';
import type { HomeInterestKind } from '../onboarding-interests/contract.ts';

export type WorkPrimaryAction = 'read' | 'install' | 'copy' | 'watch';
type WorkKind = { interest: Exclude<HomeInterestKind, 'discussions'> | null;
  primaryAction: WorkPrimaryAction };

/** Native and source-adopted Work types share the same catalogue meaning.
 * A bare DigitalDocument has no human kind until a classification is accepted. */
export const workKinds = {
  'https://schema.org/Book': { interest: 'books', primaryAction: 'read' },
  'https://schema.org/BookSeries': { interest: 'books', primaryAction: 'read' },
  'https://schema.org/DigitalDocument': { interest: null, primaryAction: 'read' },
  'https://schema.org/Recipe': { interest: 'recipes', primaryAction: 'read' },
  'https://schema.org/SoftwareApplication': { interest: 'software', primaryAction: 'install' },
  'https://schema.org/SoftwareSourceCode': { interest: 'software', primaryAction: 'install' },
  'https://rezics.com/vocab/ModPackage': { interest: 'software', primaryAction: 'install' },
  'https://rezics.com/vocab/SkillPackage': { interest: 'ai', primaryAction: 'install' },
  'https://rezics.com/vocab/PromptTemplate': { interest: 'ai', primaryAction: 'copy' },
  'https://schema.org/Movie': { interest: 'media', primaryAction: 'watch' },
  'https://schema.org/TVSeries': { interest: 'media', primaryAction: 'watch' },
  'https://schema.org/VideoObject': { interest: 'media', primaryAction: 'watch' },
  'https://schema.org/AudioObject': { interest: 'media', primaryAction: 'watch' },
  'https://schema.org/MusicRecording': { interest: 'media', primaryAction: 'watch' },
  'https://schema.org/MusicAlbum': { interest: 'media', primaryAction: 'watch' },
} as const satisfies Record<string, WorkKind>;

export const workSemanticTypes = Object.keys(workKinds) as (keyof typeof workKinds)[];
export const interestKinds = ['books', 'software', 'ai', 'recipes', 'media', 'discussions'] as const satisfies readonly HomeInterestKind[];

export interface InterestSources {
  workTypes: readonly string[];
  /** Exact, case-insensitive labels on accepted global Classification Senses. */
  classificationTerms: readonly string[];
  activityKinds: readonly FeedKind[];
}

const typesFor = (interest: HomeInterestKind): string[] => workSemanticTypes
  .filter(type => workKinds[type].interest === interest);

export const interestSources = {
  books: { workTypes: typesFor('books'), classificationTerms: ['fiction', 'serial', 'serial fiction'], activityKinds: [] },
  software: { workTypes: typesFor('software'), classificationTerms: ['software', 'software package', 'package', 'mod', 'game mod',
    'go module', 'modrinth', 'curseforge'], activityKinds: [] },
  ai: { workTypes: typesFor('ai'), classificationTerms: ['ai', 'artificial intelligence', 'prompt', 'skill'], activityKinds: [] },
  recipes: { workTypes: typesFor('recipes'), classificationTerms: ['recipe'], activityKinds: [] },
  media: { workTypes: typesFor('media'), classificationTerms: ['film', 'tv', 'animation', 'music', 'video'], activityKinds: [] },
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
