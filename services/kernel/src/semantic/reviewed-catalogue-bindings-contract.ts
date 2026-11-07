/** Native evidence shapes. The explicit operator implementation lives in services/importer. */
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import type { Item, Statement } from './item.ts';
import type { createSubject } from './subject.ts';
import type {
  CandidateAdoptionOptions,
  CandidateAdoptionResult,
  CandidateDecisionOptions,
  CandidateDecisionResult,
  CandidateObservation,
} from './candidate-contract.ts';
import type { batchCommand } from './bulk.ts';

type NativeCreation = Awaited<ReturnType<typeof createSubject>>;
type NativeAcceptance = CandidateDecisionResult;
type NativeAdoption = CandidateAdoptionResult;
type NativeBatch = Awaited<ReturnType<typeof batchCommand>>;
export type NativeCandidateObservation = CandidateObservation;

/** A logical vocabulary key, not a provider record number or native subject ID. */
export type ReviewedVocabularyIdentity = Readonly<{
  status: 'approved';
  mechanism: 'external_claim';
  namespace: 'rezics_reviewed_vocabulary';
  encoding: 'v1:base64url-utf8-canonical-json-tuple';
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
  /** Retraction does not remove Context adoption. Require the current native listing too. */
  currentCandidate: NativeCandidateObservation & {
    decision: 'accepted';
    rank: 'normal' | 'preferred';
    retracted: null;
    retraction: null;
  };
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

/** Full native evidence shape. Structural typing alone certifies no current authority. */
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
  | Readonly<{ status: 'source-complete'; identity: ReviewedVocabularyIdentity; nativeProof: 'integration-required' }>
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
  accept: { input: CandidateDecisionOptions; output: NativeAcceptance };
  adopt: { input: CandidateAdoptionOptions; output: NativeAdoption };
}>;
