import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';

type SemanticSourceApi = Pick<
  typeof import('../semantic/index.ts'),
  | 'createPublicFilterSourceBinding'
  | 'createSubjectSourceKeyPages'
  | 'publicFilterSource'
  | 'readNativePublicFilterPublicationCompletion'
>;
type SemanticIdentityReadApi = Pick<typeof import('../semantic/identity-adapters/read.ts'), 'readIdentityMappings'>;
type SemanticSearchSourceApi = Pick<typeof import('../semantic/search-source.ts'), 'subjectSource'>;
type SemanticDefinitionReadApi = Pick<typeof import('../semantic/definitions.ts'), 'activeRelease' | 'readRelease'>;

/** Search declares the Semantic capabilities required by its native publication and discovery consumers. */
export type SearchSemanticSourcePort = Readonly<
  SemanticSourceApi & SemanticIdentityReadApi & SemanticSearchSourceApi & SemanticDefinitionReadApi
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
