/** Proposed review output only. No producer, registration, resolver or ready value is exported. */
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import type { Item, Statement } from './item.ts';
import type { createSubject } from './subject.ts';
import type { adoptCandidates, decideCandidate } from './candidates.ts';
import type { batchCommand } from './bulk.ts';

type NativeCreation = Awaited<ReturnType<typeof createSubject>>;
type NativeAcceptance = Awaited<ReturnType<typeof decideCandidate>>;
type NativeAdoption = Awaited<ReturnType<typeof adoptCandidates>>;
type NativeBatch = Awaited<ReturnType<typeof batchCommand>>;

/** A logical vocabulary key, not a provider record number or native subject ID. */
export type ProposedVocabularyIdentity = Readonly<{
  status: 'proposed';
  mechanism: 'external_claim';
  namespace: 'requires-semantic-imports-root-review';
  schemeURI: string;
  literalMember: string;
}>;

export type BindingEvidence = Readonly<{
  sourceURL: string;
  pinURL: string;
  sha256: string;
  /** Omit unavailable upstream dates/revisions; archive dates are not record revisions. */
  sourceDate?: string;
  nativeRevision?: string;
  archiveRow?: Readonly<{
    member: 'subject.jsonlines';
    line: 457;
    byteStart: 1116919;
    byteEndExclusive: 1119528;
    lineWithLFSHA256: string;
    archiveSHA256: string;
  }>;
}>;

/** These are observations from ordinary APIs, never IDs supplied by this type file. */
export type NativeReviewedFact = Readonly<{
  holder: Pick<Item, 'id' | 'type' | 'release' | 'context'>;
  candidate: Statement['id'];
  statement: BatchStatement;
  acceptance: NativeAcceptance;
  adoption: NativeAdoption;
  publicRead: Item;
}>;

export type NativeClaimObservation = Readonly<{
  source: Source;
  command: Extract<BatchCommand, { op: 'create' }>;
  first: BatchWriteResult;
  freshKeyReplay: BatchWriteResult;
  otherAuthorizedActorReplay: BatchWriteResult;
  subject: Item['id'];
}>;

type VocabularySubject = Readonly<{
  subject: Pick<Item, 'id' | 'type' | 'release' | 'revision'>;
  claim: NativeClaimObservation;
  schemeMembership: NativeReviewedFact;
}>;

/** Required shape for future accepted output. Structural typing itself certifies no review. */
export type ReviewedCatalogueBinding =
  | Readonly<{
      kind: 'bangumi-public-tag';
      property: 'schema:keywords';
      sourceField: 'meta_tags';
      literalMember: '后宫';
      schemeExternalKey: 'https://rezics.com/schemes/bangumi/public-tags';
      sourceConcept: VocabularySubject;
      schemeIdentity: NativeReviewedFact;
      canonicalConcept: VocabularySubject;
      canonicalMeaning: 'http://www.wikidata.org/entity/Q690342';
      canonicalIdentity: NativeReviewedFact;
      correspondence: NativeReviewedFact & { statement: BatchStatement & { property: { id: 'skos:closeMatch' } } };
      evidence: BindingEvidence;
    }>
  | Readonly<{
      kind: 'japanese-light-novel-form';
      property: 'wdt:P7937';
      externalProperty: 'http://www.wikidata.org/entity/P7937';
      externalMeaning: 'http://www.wikidata.org/entity/Q747381';
      concept: VocabularySubject;
      exactCorrespondence: NativeReviewedFact;
      evidence: BindingEvidence;
    }>
  | Readonly<{
      kind: 'schema-diet-enumeration';
      property: 'schema:suitableForDiet';
      externalMeaning: 'https://schema.org/VegetarianDiet';
      concept: VocabularySubject;
      exactCorrespondence: NativeReviewedFact;
      evidence: BindingEvidence;
    }>;

export type CatalogueBindingReview =
  | Readonly<{
      status: 'proposed';
      identity: ProposedVocabularyIdentity;
      missing: readonly (
        | 'reviewed-seed-namespace'
        | 'native-close-correspondence'
        | 'native-source-metadata'
        | 'admitted-sealed-run-metadata-ack'
        | 'accepted-native-binding-producer'
        | 'bangumi-resolved-reference-key'
      )[];
    }>
  | Readonly<{ status: 'accepted-output'; binding: ReviewedCatalogueBinding }>;

/** No platform member is frozen by this contract. Exact inventory/code review is still required. */
export type PlatformBindingReview = Readonly<{
  status: 'not-yet-frozen';
  reason: 'exact-current-inventory-and-native-code-meaning-review-required';
}>;

/** Existing implementation signatures for comparison, not new operational ports. */
export type ExistingNativeBindingAPIs = Readonly<{
  create: { input: Parameters<typeof createSubject>[1]; output: NativeCreation };
  batch: { input: Parameters<typeof batchCommand>[1]; output: NativeBatch };
  accept: { input: Parameters<typeof decideCandidate>[1]; output: NativeAcceptance };
  adopt: { input: Parameters<typeof adoptCandidates>[1]; output: NativeAdoption };
}>;
