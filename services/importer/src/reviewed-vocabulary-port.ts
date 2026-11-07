import {
  releasedReviewedVocabulary as definitionsReviewedVocabulary,
  reviewedVocabularyRevision as definitionsReviewedVocabularyRevision,
  type ReviewedVocabularyFact,
  type ReviewedVocabularyMetadata,
  type ReviewedVocabularyNativeType,
  type ReviewedVocabularySeed,
} from '@rezics/definitions/reviewed-vocabulary';

export type {
  ReviewedVocabularyFact,
  ReviewedVocabularyMetadata,
  ReviewedVocabularyNativeType,
  ReviewedVocabularySeed,
};

export const reviewedVocabularyRevision = definitionsReviewedVocabularyRevision;

export type ReviewedVocabularyPort = Readonly<{
  revision: string;
  inventory: readonly ReviewedVocabularySeed[];
}>;

export type ReviewedSchemeIndex = Readonly<{
  scheme?: ReviewedVocabularySeed;
  concepts: readonly ReviewedVocabularySeed[];
  literalMembers: ReadonlySet<string>;
}>;

export type ReviewedReleaseVocabulary = Readonly<{
  developmentStatus: ReadonlySet<string>;
  releasedState: ReadonlySet<string>;
}>;

/** Released Definitions inventory; composition and ordinary callers bind this, never private JSON. */
export function releasedReviewedVocabulary(): ReviewedVocabularyPort {
  return definitionsReviewedVocabulary();
}

export function reviewedSchemeIndex(
  inventory: readonly ReviewedVocabularySeed[],
  schemeURI: string,
): ReviewedSchemeIndex {
  let scheme: ReviewedVocabularySeed | undefined;
  const concepts: ReviewedVocabularySeed[] = [];
  const literalMembers = new Set<string>();
  for (const seed of inventory) {
    if (seed.schemeURI !== schemeURI) continue;
    if (seed.type === 'skos:ConceptScheme' && seed.literalMember === '') scheme = seed;
    if (seed.type === 'skos:Concept' && seed.literalMember !== '') {
      concepts.push(seed);
      literalMembers.add(seed.literalMember);
    }
  }
  return scheme ? { scheme, concepts, literalMembers } : { concepts, literalMembers };
}

export function reviewedConceptSeed(
  inventory: readonly ReviewedVocabularySeed[],
  schemeURI: string,
  literalMember: string,
): ReviewedVocabularySeed | undefined {
  return inventory.find(
    (seed) => seed.schemeURI === schemeURI && seed.type === 'skos:Concept' && seed.literalMember === literalMember,
  );
}

export function reviewedReleaseVocabulary(
  inventory: readonly ReviewedVocabularySeed[],
  schemes: Readonly<{ developmentStatus: string; releasedState: string }>,
): ReviewedReleaseVocabulary {
  return {
    developmentStatus: reviewedSchemeIndex(inventory, schemes.developmentStatus).literalMembers,
    releasedState: reviewedSchemeIndex(inventory, schemes.releasedState).literalMembers,
  };
}

export function reviewedVocabularyKeys(inventory: readonly ReviewedVocabularySeed[]): ReadonlySet<string> {
  return new Set(inventory.map((seed) => seed.key));
}
