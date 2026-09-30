import { workTypeEntries, workSemanticTypeOptions } from '../types/registry.ts';
import type { FeedKind } from '../feed/contract.ts';
import type { HomeInterestKind } from '../onboarding-interests/contract.ts';

export type WorkPrimaryAction = typeof workTypeEntries[number]['primaryAction'];

/** Native and source-adopted Works share the compiled catalogue metadata.
 * A bare DigitalDocument has no human kind until a classification is accepted. */
export const workKinds = Object.fromEntries(workTypeEntries.map(entry => [entry.type,
  { interest: entry.interest, primaryAction: entry.primaryAction, creation: entry.creation }])) as {
  [Entry in typeof workTypeEntries[number] as Entry['type']]: Pick<Entry, 'interest' | 'primaryAction' | 'creation'>;
};

export const workSemanticTypes = workSemanticTypeOptions;
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
