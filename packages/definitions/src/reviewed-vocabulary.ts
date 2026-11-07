/** Released reviewed vocabulary: immutable public data, not native IDs or publication authority. */
import authored from './reviewed-vocabulary.json';

export const reviewedVocabularyRevision = 'reviewed-vocabulary@1' as const;

export type ReviewedVocabularyNativeType = 'skos:ConceptScheme' | 'skos:Concept';

export type ReviewedVocabularyLicence = Readonly<{
  id: string;
  url?: string;
}>;

export type ReviewedVocabularyMetadata = Readonly<{
  name: string;
  url: string;
  licence?: ReviewedVocabularyLicence;
  attribution?: string;
}>;

export type ReviewedVocabularyFact = Readonly<{
  property: string;
  target?: string;
  value?: string;
  citations: readonly string[];
}>;

export type ReviewedVocabularySeed = Readonly<{
  key: string;
  schemeURI: string;
  literalMember: string;
  type: string;
  labels: Readonly<Record<string, string>>;
  metadata: ReviewedVocabularyMetadata;
  facts: readonly ReviewedVocabularyFact[];
}>;

function freezeFact(fact: ReviewedVocabularyFact): ReviewedVocabularyFact {
  return Object.freeze({
    property: fact.property,
    ...(fact.target === undefined ? {} : { target: fact.target }),
    ...(fact.value === undefined ? {} : { value: fact.value }),
    citations: Object.freeze([...fact.citations]),
  });
}

function freezeMetadata(metadata: ReviewedVocabularyMetadata): ReviewedVocabularyMetadata {
  return Object.freeze({
    name: metadata.name,
    url: metadata.url,
    ...(metadata.attribution === undefined ? {} : { attribution: metadata.attribution }),
    ...(metadata.licence === undefined
      ? {}
      : {
          licence: Object.freeze({
            id: metadata.licence.id,
            ...(metadata.licence.url === undefined ? {} : { url: metadata.licence.url }),
          }),
        }),
  });
}

function freezeSeed(seed: ReviewedVocabularySeed): ReviewedVocabularySeed {
  return Object.freeze({
    key: seed.key,
    schemeURI: seed.schemeURI,
    literalMember: seed.literalMember,
    type: seed.type,
    labels: Object.freeze({ ...seed.labels }),
    metadata: freezeMetadata(seed.metadata),
    facts: Object.freeze(seed.facts.map(freezeFact)),
  });
}

function freezeInventory(rows: readonly ReviewedVocabularySeed[]): readonly ReviewedVocabularySeed[] {
  return Object.freeze(rows.map(freezeSeed));
}

export const reviewedVocabularyInventory: readonly ReviewedVocabularySeed[] = freezeInventory(
  authored as ReviewedVocabularySeed[],
);

const byKey = new Map(reviewedVocabularyInventory.map((seed) => [seed.key, seed]));

export function reviewedVocabularySeed(key: string): ReviewedVocabularySeed | undefined {
  return byKey.get(key);
}

export function reviewedVocabularyScheme(schemeURI: string): ReviewedVocabularySeed | undefined {
  return reviewedVocabularyInventory.find(
    (seed) => seed.schemeURI === schemeURI && seed.type === 'skos:ConceptScheme' && seed.literalMember === '',
  );
}

export function reviewedVocabularyConcept(
  schemeURI: string,
  literalMember: string,
): ReviewedVocabularySeed | undefined {
  return reviewedVocabularyInventory.find(
    (seed) => seed.schemeURI === schemeURI && seed.type === 'skos:Concept' && seed.literalMember === literalMember,
  );
}

export function reviewedVocabularyLiteralMembers(schemeURI: string): readonly string[] {
  return reviewedVocabularyInventory
    .filter((seed) => seed.schemeURI === schemeURI && seed.type === 'skos:Concept' && seed.literalMember !== '')
    .map((seed) => seed.literalMember);
}

export function reviewedVocabularyByScheme(schemeURI: string): readonly ReviewedVocabularySeed[] {
  return reviewedVocabularyInventory.filter((seed) => seed.schemeURI === schemeURI);
}

export type ReleasedReviewedVocabulary = Readonly<{
  revision: typeof reviewedVocabularyRevision;
  inventory: readonly ReviewedVocabularySeed[];
}>;

export function releasedReviewedVocabulary(): ReleasedReviewedVocabulary {
  return { revision: reviewedVocabularyRevision, inventory: reviewedVocabularyInventory };
}
