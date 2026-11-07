import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';

type SemanticSourceApi = Pick<
  typeof import('../semantic/index.ts'),
  | 'createIdentityScopedObservations'
  | 'createIdentitySourceSupportReader'
  | 'createPublicFilterSourceBinding'
  | 'createPublicIdentitySourceCapture'
  | 'createSubjectSourceKeyPages'
  | 'publicFilterSource'
  | 'readNativePublicFilterPublicationCompletion'
  | 'readPublicFilterSourceDefinition'
>;
type SemanticIdentityReadApi = Pick<typeof import('../semantic/identity-adapters/read.ts'), 'readIdentityMappings'>;
type SemanticSearchSourceApi = Pick<
  typeof import('../semantic/search-source.ts'),
  'readIdentitySourceProjection' | 'subjectSource'
>;
type SemanticDefinitionReadApi = Pick<typeof import('../semantic/definitions.ts'), 'activeRelease' | 'readRelease'>;
type SemanticPublicFilterBindingApi = Pick<
  typeof import('../semantic/public-filter-source-binding.ts'),
  | 'PublicFilterSourceDefinitionError'
  | 'advanceNativePublicFilterPreparation'
  | 'joinNativePublicFilterRepair'
  | 'readNativePublicFilterAccountRepair'
  | 'readNativePublicFilterRepairStart'
>;
type SemanticPublicFilterOriginApi = Pick<
  typeof import('../semantic/public-filter-source.ts'),
  'publicFilterSourceOrigin'
>;
type SemanticReadApi = Pick<typeof import('../semantic/read.ts'), 'currentReadSnapshot' | 'withReadTransaction'>;
type SemanticIdentityStoreApi = Pick<
  typeof import('../semantic/identity-adapters/index.ts'),
  'identityEpochStore' | 'recordIdentityEpochNativeCommit'
>;
type SemanticObservationApi = Pick<
  typeof import('../semantic/identity-scoped-observations.ts'),
  'identityScopeAddress'
>;
type SemanticRelationApi = Pick<typeof import('../semantic/search-relations.ts'), 'relationSource'>;
type SemanticErasureProofApi = Pick<
  typeof import('../semantic/account-erasure-source.ts'),
  'readSubjectErasureSourceProof' | 'verifySubjectErasureSourceProof'
>;
type SemanticLeafEvidenceApi = Pick<typeof import('../semantic/scope-leaf-evidence.ts'), 'readScopeLeafEvidence'>;
type SemanticSummaryApi = Pick<typeof import('../semantic/summaries.ts'), 'readSubjectSummaries'>;

/** Search declares the Semantic capabilities required by its native publication, discovery and scope consumers. */
export type SearchSemanticSourcePort = Readonly<
  SemanticSourceApi &
    SemanticIdentityReadApi &
    SemanticSearchSourceApi &
    SemanticDefinitionReadApi &
    SemanticPublicFilterBindingApi &
    SemanticPublicFilterOriginApi &
    SemanticReadApi &
    SemanticIdentityStoreApi &
    SemanticObservationApi &
    SemanticRelationApi &
    SemanticErasureProofApi &
    SemanticLeafEvidenceApi &
    SemanticSummaryApi
>;

export type SearchPublicFilterSource = ReturnType<SearchSemanticSourcePort['publicFilterSource']>;
export type SearchPublicFilterSourceBinding = Parameters<
  SearchSemanticSourcePort['readNativePublicFilterPublicationCompletion']
>[0];
export type SearchPublicFilterSourceKeyPages = ReturnType<SearchSemanticSourcePort['createSubjectSourceKeyPages']>;
export type SearchPublicFilterSourceKeyCursor = NonNullable<
  Parameters<SearchPublicFilterSourceKeyPages['read']>[0]['after']
>;
type ResolvePublicFilterSource = SearchPublicFilterSourceBinding['resolve'];
export type SearchPublicFilterProjectionMeaning = Parameters<ResolvePublicFilterSource>[0]['meaning'];
export type SearchPublicFilterSourceDefinition = Extract<
  Awaited<ReturnType<ResolvePublicFilterSource>>,
  { status: 'resolved' }
>['definition'];
export type SearchPublicFilterCost = Awaited<ReturnType<ResolvePublicFilterSource>>['cost'];
export type SearchNativePublicationRequest = Parameters<
  SearchSemanticSourcePort['readNativePublicFilterPublicationCompletion']
>[1];
export type SearchNativePublicationCompletion = Awaited<
  ReturnType<SearchSemanticSourcePort['readNativePublicFilterPublicationCompletion']>
>;
export type SearchNativePublicationCompletionReader = (
  request: SearchNativePublicationRequest,
  context: PublicFilterConsumerContext,
) => Promise<SearchNativePublicationCompletion>;
export type SearchIdentityMapping = Awaited<ReturnType<SearchSemanticSourcePort['readIdentityMappings']>>[number];
