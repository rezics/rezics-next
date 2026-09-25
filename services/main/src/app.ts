import { Elysia, ParseError, ValidationError, t } from 'elysia';
import { ContentConflict, ContentLimitExceeded, ContentUnavailable,
  type ContentCore } from '../../content/src/core.ts';
import { ContentCommentCursorStale, ContentCommentInvalid, ContentCommentMissing, resolveParagraphSelector,
  type ContentComments } from '../../content/src/comments.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { CommandRejected, FusekiClient, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded }
  from './infrastructure/fuseki.ts';
import { assertCommandProfiles } from './infrastructure/profile.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from './modules/access/admission.ts';
import type { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale, ActingContextUnavailable,
  type AccessActingContexts } from './modules/access/contexts.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from './modules/account/verify-assertion.ts';
import type { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { createAdmittedMetadataWork, PendingAdmittedWork } from './modules/work/create-admitted.ts';
import { createAdmittedTranslationLink, InvalidTranslationLink, readTranslationLinks,
  validateTranslationLink,
  TranslationLinkConflict, TranslationSourceUnavailable, TranslationTargetUnavailable }
  from './modules/work/translation-links.ts';
import { createAdmittedWorkDerivation, InvalidWorkDerivation, readWorkDerivations,
  validateWorkDerivation, WorkDerivationConflict, WorkDerivationStale,
  WorkDerivationUnavailable } from './modules/work/derivations.ts';
import { editAdmittedMetadataWork } from './modules/work/edit-admitted.ts';
import { StaleWorkHead, WorkEditUnavailable } from './modules/work/edit.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionCorrupt, RevisionNotFound,
  RevisionUnavailable } from './modules/work/history.ts';
import { assertGraphAdmissionOpen, RecoveryHold } from './modules/work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict, iri, type WorkActivationEnvironment } from './modules/work/activate.ts';
import { createAdmittedTextContribution } from './modules/contribution/create-admitted.ts';
import { ContributionWorkUnavailable, InvalidContributionInput } from './modules/contribution/draft.ts';
import { readExactContributionDraft } from './modules/contribution/history.ts';
import { editAdmittedTextContribution } from './modules/contribution/edit-admitted.ts';
import { ContributionEditUnavailable, StaleContributionDraftHead } from './modules/contribution/edit.ts';
import { publishAdmittedTextContribution } from './modules/contribution/publish-admitted.ts';
import { InvalidPublicationInput, PublicationUnavailable,
  StalePublicationHead } from './modules/contribution/publish.ts';
import { selectAdmittedMainDefault } from './modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from './modules/work/select-realm-admitted.ts';
import { rejectAdmittedRealmLocal } from './modules/work/reject-realm-admitted.ts';
import { InvalidRealmRejectionInput, RealmRejectionUnavailable,
  StaleRealmRejection } from './modules/work/reject-realm.ts';
import { InvalidRealmSelectionInput, RealmSelectionUnavailable, StaleRealmSelection,
  realmSelectionSlotIri } from './modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from './modules/space/create.ts';
import { InvalidMainSelectionInput, MainSelectionUnavailable, PUBLIC_SEARCH_GRAPH,
  StaleMainSelection } from './modules/work/select-main.ts';
import { InvalidNativeVariant, listEligibleNativeVariants, NativeVariantLimit,
  NativeVariantUnavailable, readEligibleNativeVariant, readMainDefaultVariant, readNativeMainWork,
  ReaderVariantIdempotencyConflict, ReaderVariantPreferenceStore,
  StaleReaderVariantPreference }
  from './modules/work/native-variants.ts';
import { readRealmAdoptedVariant, readRealmVariantDecision,
  RealmVariantRecommendationConflict, RealmVariantRecommendationStore,
  StaleRealmVariantRecommendation } from './modules/work/realm-variant-recommendation.ts';
import { InvalidPublicQuery, PublicQueryBudgetExceeded, PublicQueryUnavailable,
  PublicRealmUnavailable, queryPublicMainClassifiedPhrase, queryPublicMainPhrase,
  queryPublicRealmClassifiedPhrase, queryPublicRealmPhrase } from './modules/work/search-public.ts';
import { InvalidSearchContinuation, pageCompletePublicRelation, SearchContinuationRestart }
  from './modules/work/search-continuation.ts';
import { queryPublicRealmClassifiedRatedPhrase } from './modules/work/search-joined.ts';
import { assertPublicTextReady, SearchIndexBudgetExceeded, withStableSearchSnapshot,
  SearchIndexUnavailable, type SearchAttemptDiagnostic } from './modules/work/search-readiness.ts';
import { ContentProjectionGap, ContentProjectionProfileUnavailable,
  ContentProjectionUnavailable } from './modules/content-publication/relay.ts';
import { assertPublicContentSearchReady, ContentSearchBudgetExceeded,
  InvalidContentPhrase, queryPublicContentPhrase } from './modules/content-publication/search.ts';
import { pageCompleteContentRelation }
  from './modules/content-publication/search-continuation.ts';
import { ContentDraftDenied, ContentDraftStale, ContentDraftUnavailable,
  saveAdmittedContentDraft } from './modules/content-publication/draft.ts';
import { ContentCommentDenied, ContentCommentWorkUnavailable,
  createAdmittedContentComment } from './modules/content-publication/comment.ts';
import { publishAdmittedContent } from './modules/content-publication/publish-admitted.ts';
import { ContentPublicationConflict, ContentPublicationProfileUnavailable,
  InvalidContentPublication, StaleContentOwnerEpoch }
  from './modules/content-publication/publish.ts';
import { selectAdmittedPublicContentSearch }
  from './modules/content-publication/eligibility-admitted.ts';
import { ContentEligibilityConflict, ContentEligibilityDenied, ContentEligibilityPending,
  ContentEligibilityProfileUnavailable, ContentEligibilityStale, ContentEligibilityUnavailable,
  InvalidContentEligibility } from './modules/content-publication/eligibility.ts';
import { createAdmittedRealmSpace } from './modules/space/create-admitted.ts';
import { InvalidSpaceInput } from './modules/space/create.ts';
import { createAdmittedClassificationContext } from './modules/classification/context-admitted.ts';
import { ClassificationRealmUnavailable, InvalidClassificationContextInput,
  GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY } from './modules/classification/context.ts';
import { createAdmittedClassificationProposition } from './modules/classification/proposition-admitted.ts';
import { InvalidClassificationPropositionInput } from './modules/classification/proposition.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from './modules/classification/proposition.ts';
import { readComponentState } from './modules/work/history.ts';
import { setAdmittedClassificationDecision } from './modules/classification/decision-admitted.ts';
import { ClassificationDecisionUnavailable, InvalidClassificationDecisionInput,
  StaleClassificationDecision } from './modules/classification/decision.ts';
import { resolveClassification, InvalidClassificationResolution,
  ClassificationResolutionUnavailable, ClassificationTargetUnavailable } from './modules/classification/resolve.ts';
import { createAdmittedRatingContext } from './modules/rating/context-admitted.ts';
import { InvalidRatingContextInput, RatingRealmUnavailable,
  REALM_STANDING_RATING_CONTEXT_PROFILE, RATING_STANDING_CADENCE,
  RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY } from './modules/rating/context.ts';
import { setAdmittedStandingRating } from './modules/rating/observation-admitted.ts';
import { InvalidRatingObservationInput, RatingObservationUnavailable,
  sameRatingInstant, StaleRatingObservation, standingRatingSlotIri,
  STANDING_RATING_OBSERVATION_PROFILE } from './modules/rating/observation.ts';
import { InvalidRatingAggregateQuery, queryStandingRatingAggregate,
  RatingAggregateBudgetExceeded, RatingAggregateUnavailable } from './modules/rating/aggregate.ts';
import { exactMainRevision, exactWorkRevision, pendingOperation, problemResult, publicPhrasePageRequest,
  publicPhrasePageResult, publicQueryResult, unsupportedPublicSearchSelectors,
  workResult } from './api-contract.ts';
import { actingContextCheck, actingContextDiscovery, actingContextPreference,
  authorizedReadProblems, classificationContextReadResult,
  classificationContextWriteResult, classificationDecisionWriteResult,
  classificationPropositionReadResult, classificationPropositionWriteResult,
  contentCommentPageResult, contentCommentResult,
  classificationResolutionResult, contentDraftWriteResult, contentEditWriteResult,
  contentEligibilityWriteResult, contentPublicationWriteResult, exactContentRevision,
  contributionDraftReadResult,
  contributionEditWriteResult, contributionPublicationWriteResult, contributionWriteResult,
  mainSelectionReadResult, publicationRejectionWriteResult, publicationSelectionWriteResult,
  ratingAggregateResult, ratingContextReadResult, ratingContextWriteResult,
  ratingObservationReadResult, ratingObservationWriteResult, readProblems,
  realmSelectionReadResult, spaceReadResult, spaceWriteResult, writeProblems } from './api-responses.ts';

export interface MainWorkDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  content?: Pick<ContentCore, 'owningResourceForRevision' | 'readExactBatch'>;
  contentAuthoring?: ContentCore;
  comments?: ContentComments;
  contentProjection?: { content: ContentCore; cursor: ContentProjectionCursor; consumer: string };
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork' | 'canReadContributionDraft'
    | 'canReadStandingRating' | 'canLinkTranslation' | 'activePrincipalId'>
    & Partial<Pick<AccessAdmissionRegistry, 'verifyContentDraftProof'>>;
  actingContexts?: AccessActingContexts;
  readerPreferences?: ReaderVariantPreferenceStore;
  realmRecommendations?: RealmVariantRecommendationStore;
}

const nativeVariantRef = t.Object({ contribution: t.String(), publicationDecision: t.String(),
  selectedDraft: t.String(), language: t.String(), author: t.String() });
const readerPreferenceRef = t.Nullable(t.Object({ contribution: t.String(), revision: t.String() }));
const nativeVariantSelection = t.Object({ profile: t.Literal('reader-native-variant-selection-v1'),
  work: t.String(), mainVersion: t.String(), mainSelection: t.Nullable(t.String()),
  reason: t.Union([t.Literal('personal-preference'), t.Literal('main-default'),
    t.Literal('preferred-ineligible')]), preference: readerPreferenceRef,
  chosen: t.Object({ ...nativeVariantRef.properties, body: t.String() }),
});
const realmRecommendationRef = t.Nullable(t.Object({ contribution: t.String(), revision: t.String() }));
const realmNativeVariantSelection = t.Union([
  t.Object({ profile: t.Literal('reader-realm-native-variant-selection-v1'),
    status: t.Literal('suppressed'), work: t.String(), mainVersion: t.String(),
    realm: t.String(), rejection: t.String() }),
  t.Object({ profile: t.Literal('reader-realm-native-variant-selection-v1'),
    status: t.Literal('selected'), work: t.String(), mainVersion: t.String(), realm: t.String(),
    mainSelection: t.Nullable(t.String()), realmSelection: t.Nullable(t.String()),
    reason: t.Union([t.Literal('realm-adoption'), t.Literal('personal-preference'),
      t.Literal('realm-recommendation'), t.Literal('main-default'),
      t.Literal('preferred-ineligible'), t.Literal('recommended-ineligible'),
      t.Literal('preferred-and-recommended-ineligible')]),
    preference: readerPreferenceRef, recommendation: realmRecommendationRef,
    chosen: t.Object({ ...nativeVariantRef.properties, body: t.String() }),
  }),
]);
const translationLinkRef = t.Object({ link: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.Nullable(t.String()),
  sourceVersionStatus: t.Union([t.Literal('exact'), t.Literal('unresolved')]),
  status: t.Union([t.Literal('official'), t.Literal('third-party')]),
  contentLanguage: t.String(), translator: t.String(), publisher: t.String(),
  evidence: t.String(), authorizingParty: t.Nullable(t.String()),
  authorizationScope: t.Nullable(t.String()), authorizationEpoch: t.Nullable(t.String()) });
const translationLinkWrite = t.Object({ profile: t.Literal('translation-link-v1'),
  ...translationLinkRef.properties, receipt: t.String(), sourcePosition: t.Object({
    datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });
const workDerivationRef = t.Object({ derivation: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.String(),
  kind: t.Union([t.Literal('adaptation'), t.Literal('new-recording'),
    t.Literal('software-fork')]), evidence: t.String(), linkedBy: t.String() });
const workDerivationWrite = t.Object({ profile: t.Literal('work-derivation-v1'),
  ...workDerivationRef.properties, receipt: t.String(), sourcePosition: t.Object({
    datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });

function problem(status: number, code: string, title: string, headers?: HeadersInit): Response {
  return Response.json({ type: `https://rezics.com/problems/${code}`, title, status, code }, {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });
}

function logLoadSearchFailure(profile: string, error: unknown,
  diagnostics: SearchAttemptDiagnostic[] | undefined): void {
  if (!process.env.REZICS_LOAD_RUN_ID || !(error instanceof SearchIndexUnavailable)) return;
  console.error(JSON.stringify({ event: 'load-search-failure', profile,
    error: error.constructor.name, message: error.message,
    cause: error.cause instanceof Error ? { error: error.cause.constructor.name,
      message: error.cause.message } : undefined,
    attempts: diagnostics }));
}

function commandError(error: unknown): Response {
  if (error instanceof PendingAdmittedWork) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.phase,
      result: null, retry: { allowed: true, afterMs: 1000 } }, {
      status: 202, headers: { 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
  if (error instanceof AccountAssertionDenied) {
    return problem(401, 'account_assertion_denied', 'Account assertion is invalid or inactive',
      { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof ActingContextInvalid) return problem(400, 'invalid_request', 'Acting context request is invalid');
  if (error instanceof ActingContextDenied) return problem(403, 'acting_context_denied', 'Selected Agent is unavailable for this task');
  if (error instanceof ActingContextStale) return problem(409, 'stale_context', 'Acting context authority changed');
  if (error instanceof ActingContextUnavailable) return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
  if (error instanceof ContentDraftDenied) return problem(403, 'authority_denied', 'Content draft is not admitted');
  if (error instanceof ContentCommentDenied) return problem(403, 'authority_denied', 'Comment is not admitted');
  if (error instanceof ContentCommentInvalid) return problem(400, 'invalid_selector', 'Comment selector or body is invalid');
  if (error instanceof ContentCommentCursorStale) return problem(409, 'comment_page_changed',
    'Comment list changed; restart at the first page');
  if (error instanceof ContentCommentMissing) return problem(404, 'comment_unavailable', 'Comment source is unavailable');
  if (error instanceof ContentCommentWorkUnavailable) return problem(503, 'content_unavailable', 'Current Work is unavailable');
  if (error instanceof ContentDraftStale) return problem(409, 'stale_head', 'Expected Content draft head is stale');
  if (error instanceof InvalidContentPublication || error instanceof InvalidContentEligibility) {
    return problem(400, 'invalid_request', 'Content publication request is invalid');
  }
  if (error instanceof ContentEligibilityDenied) return problem(403, 'authority_denied', 'Content eligibility is denied');
  if (error instanceof ContentPublicationConflict || error instanceof StaleContentOwnerEpoch
    || error instanceof ContentEligibilityConflict || error instanceof ContentEligibilityStale) {
    return problem(409, 'content_conflict', 'Content publication state changed');
  }
  if (error instanceof ContentPublicationProfileUnavailable
    || error instanceof ContentEligibilityProfileUnavailable
    || error instanceof ContentEligibilityUnavailable || error instanceof ContentEligibilityPending) {
    return problem(503, 'content_unavailable', 'Content publication is unavailable');
  }
  if (error instanceof ContentConflict) return problem(409, 'content_conflict', 'Content owner rejected the draft');
  if (error instanceof ContentLimitExceeded) return problem(413, 'content_limit', 'Content draft exceeds its limit');
  if (error instanceof ContentUnavailable || error instanceof ContentDraftUnavailable) {
    return problem(503, 'content_unavailable', 'Content or current Work is unavailable');
  }
  if (error instanceof CommandRejected) {
    if (error.result.status === 'invalid') {
      return problem(400, 'invalid_request', 'Persisted profile validation rejected the request');
    }
    if (error.result.status === 'conflict') {
      return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
    }
    return problem(503, 'dependency_unavailable', 'Command profile or storage is unavailable');
  }
  if (error instanceof InvalidContentPhrase || error instanceof InvalidContributionInput || error instanceof InvalidPublicationInput
    || error instanceof InvalidMainSelectionInput || error instanceof InvalidPublicQuery
    || error instanceof InvalidSpaceInput || error instanceof InvalidRealmSelectionInput
    || error instanceof InvalidRealmRejectionInput
    || error instanceof InvalidClassificationContextInput
    || error instanceof InvalidClassificationPropositionInput
    || error instanceof InvalidClassificationDecisionInput
    || error instanceof InvalidClassificationResolution
    || error instanceof InvalidRatingContextInput
    || error instanceof InvalidRatingObservationInput
    || error instanceof InvalidRatingAggregateQuery) {
    return problem(400, 'invalid_request', 'Request fields are invalid');
  }
  if (error instanceof AdmissionConflict || error instanceof IdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof CancelledActivation) return problem(409, 'operation_cancelled', 'Work operation was cancelled');
  if (error instanceof StaleWorkHead) return problem(409, 'stale_head', 'Expected Work revision is stale');
  if (error instanceof StaleContributionDraftHead) {
    return problem(409, 'stale_head', 'Expected Contribution draft revision is stale');
  }
  if (error instanceof StalePublicationHead) {
    return problem(409, 'stale_head', 'Expected Contribution publication state is stale');
  }
  if (error instanceof StaleMainSelection) {
    return problem(409, 'stale_head', 'Expected Main Version selection is stale');
  }
  if (error instanceof StaleReaderVariantPreference) {
    return problem(409, 'stale_head', 'Expected reader preference revision is stale');
  }
  if (error instanceof ReaderVariantIdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Reader preference key conflicts with an earlier request');
  }
  if (error instanceof StaleRealmVariantRecommendation) {
    return problem(409, 'stale_head', 'Expected Realm recommendation revision is stale');
  }
  if (error instanceof RealmVariantRecommendationConflict) {
    return problem(409, 'idempotency_conflict', 'Realm recommendation key conflicts with an earlier request');
  }
  if (error instanceof StaleRealmSelection) {
    return problem(409, 'stale_head', 'Expected Realm selection is stale');
  }
  if (error instanceof StaleRealmRejection) {
    return problem(409, 'stale_head', 'Expected Realm decision is stale');
  }
  if (error instanceof StaleClassificationDecision) {
    return problem(409, 'stale_head', 'Expected classification decision is stale');
  }
  if (error instanceof StaleRatingObservation) {
    return problem(409, 'stale_head', 'Expected standing rating revision is stale');
  }
  if (error instanceof WorkEditUnavailable || error instanceof ContributionWorkUnavailable) {
    return problem(404, 'work_unavailable', 'Work is unavailable');
  }
  if (error instanceof ContributionEditUnavailable || error instanceof PublicationUnavailable) {
    return problem(404, 'contribution_unavailable', 'Contribution is unavailable');
  }
  if (error instanceof MainSelectionUnavailable) {
    return problem(404, 'selection_unavailable', 'Main Version selection is unavailable');
  }
  if (error instanceof InvalidNativeVariant) {
    return problem(400, 'invalid_request', 'Reader variant request is invalid');
  }
  if (error instanceof InvalidTranslationLink) {
    return problem(400, 'invalid_request', 'Translation link request is invalid');
  }
  if (error instanceof TranslationSourceUnavailable || error instanceof TranslationTargetUnavailable) {
    return problem(404, 'translation_version_unavailable', 'Translation source or target revision is unavailable');
  }
  if (error instanceof TranslationLinkConflict) {
    return problem(409, 'translation_link_conflict', 'Target revision already has a translation link');
  }
  if (error instanceof InvalidWorkDerivation) {
    return problem(400, 'invalid_request', 'Work derivation request is invalid');
  }
  if (error instanceof WorkDerivationUnavailable) {
    return problem(404, 'work_derivation_version_unavailable', 'Source or target revision is unavailable');
  }
  if (error instanceof WorkDerivationStale) {
    return problem(409, 'stale_target_head', 'Target Main Version head changed');
  }
  if (error instanceof WorkDerivationConflict) {
    return problem(409, 'work_derivation_conflict', 'Target revision already has a derivation');
  }
  if (error instanceof NativeVariantLimit) {
    return problem(422, 'query_budget_exceeded', 'Native variant inventory exceeds the complete-result bound');
  }
  if (error instanceof NativeVariantUnavailable) {
    return problem(404, 'variant_unavailable', 'Native variant is unavailable');
  }
  if (error instanceof RealmSelectionUnavailable) {
    return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
  }
  if (error instanceof RealmRejectionUnavailable) {
    return problem(404, 'selection_unavailable', 'Realm decision is unavailable');
  }
  if (error instanceof ClassificationRealmUnavailable) {
    return problem(409, 'realm_classification_unavailable', 'Realm classification context cannot be created');
  }
  if (error instanceof RatingRealmUnavailable) {
    return problem(404, 'realm_unavailable', 'Rating Realm is unavailable');
  }
  if (error instanceof RatingObservationUnavailable) {
    return problem(409, 'rating_observation_unavailable', 'Standing rating is unavailable');
  }
  if (error instanceof ClassificationDecisionUnavailable) {
    return problem(409, 'classification_decision_unavailable', 'Classification decision is unavailable');
  }
  if (error instanceof ClassificationTargetUnavailable) {
    return problem(404, 'classification_target_unavailable', 'Classification target is unavailable');
  }
  if (error instanceof ClassificationResolutionUnavailable) {
    return problem(503, 'classification_unavailable', 'Classification state is unavailable');
  }
  if (error instanceof ContentSearchBudgetExceeded || error instanceof PublicQueryBudgetExceeded
    || error instanceof FusekiQueryResponseTooLarge || error instanceof FusekiReadBudgetExceeded) {
    return problem(422, 'query_budget_exceeded', 'Public query exceeds the complete-result budget');
  }
  if (error instanceof SearchIndexBudgetExceeded) {
    return problem(422, 'query_budget_exceeded', 'Public text population exceeds the complete-result budget');
  }
  if (error instanceof SearchIndexUnavailable) {
    return problem(503, 'search_index_unavailable', 'Public text index is unavailable');
  }
  if (error instanceof ContentProjectionUnavailable || error instanceof ContentProjectionGap
    || error instanceof ContentProjectionProfileUnavailable) {
    return problem(503, 'content_projection_unavailable', 'Public Content projection is unavailable');
  }
  if (error instanceof RatingAggregateBudgetExceeded) {
    return problem(422, 'query_budget_exceeded', 'Rating population exceeds the complete-result budget');
  }
  if (error instanceof RatingAggregateUnavailable) {
    return problem(503, 'rating_aggregate_unavailable', 'Rating aggregate snapshot is unavailable');
  }
  if (error instanceof PublicQueryUnavailable) {
    return problem(503, 'query_unavailable', 'Public query snapshot is unavailable');
  }
  if (error instanceof PublicRealmUnavailable) {
    return problem(404, 'realm_unavailable', 'Realm is unavailable');
  }
  if (error instanceof RevisionNotFound) return problem(404, 'revision_unavailable', 'Revision is unavailable');
  if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt) {
    return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
  }
  if (error instanceof RecoveryHold) {
    return problem(503, 'recovery_hold', 'Product access is held for recovery reconciliation');
  }
  if (error instanceof AccountAssertionUnavailable || error instanceof AdmissionUnavailable) {
    return problem(503, 'dependency_unavailable', 'A required authority service is unavailable',
      { 'retry-after': '1' });
  }
  return problem(503, 'dependency_unavailable', 'Work operation could not be completed', { 'retry-after': '1' });
}

function unsupportedSearchSelection(body: { sourcePolicy?: unknown; asOf?: unknown }) {
  if (body.sourcePolicy !== undefined) {
    return problem(422, 'search_source_policy_unsupported',
      'Multi-dataset public search is unsupported');
  }
  if (body.asOf !== undefined) {
    return problem(422, 'historical_search_unsupported',
      'Historical public search is unsupported');
  }
  return null;
}

export function createMainApp(fuseki: FusekiClient, work?: MainWorkDependencies) {
  const app = new Elysia()
    .error(({ error }) => {
      if (error instanceof ValidationError || error instanceof ParseError) {
        return problem(400, 'invalid_request', 'Request does not match the Work contract');
      }
      return problem(500, 'internal_error', 'Request could not be processed');
    })
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        if (work) {
          await assertCommandProfiles(fuseki);
          await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        }
        return { status: 'ready' as const };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .get('/health/search-ready', {
      response: {
        200: t.Object({ status: t.Literal('ready'), dataEpoch: t.String(),
          sequence: t.String(), indexGeneration: t.String() }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      if (!work) return status(503, { status: 'unavailable' as const });
      try {
        if (work.contentProjection) {
          const { content, cursor, consumer } = work.contentProjection;
          const projection = await assertPublicContentSearchReady(work.environment, content, cursor, consumer);
          return { status: 'ready' as const, dataEpoch: projection.graphPosition.dataEpoch,
            sequence: projection.graphPosition.sequence, indexGeneration: projection.indexGeneration };
        }
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const index = await assertPublicTextReady(fuseki, work.environment.lineage);
        return { status: 'ready' as const, dataEpoch: index.dataEpoch,
          sequence: index.sequence, indexGeneration: index.generation };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    });
  if (work) {
    return app.get('/v1/me/acting-contexts', {
      query: t.Object({ task: t.Literal('work.create') },
        { additionalProperties: false }),
      response: { 200: actingContextDiscovery, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, ['work:create']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = await work.actingContexts.discover(principal);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/acting-context-checks', {
      body: t.Object({ profile: t.Literal('work-create-acting-context-check-v1'),
        task: t.Literal('work.create'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedAuthorityEpoch: t.String({ pattern: '^(0|[1-9][0-9]*)$' }),
        authorityPath: t.Optional(t.Union([
          t.Literal('represented-agent'), t.Literal('direct-principal')])),
      }, { additionalProperties: false }),
      response: { 200: actingContextCheck, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:create']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = await work.actingContexts.check(principal,
          body.actingSubject, body.expectedAuthorityEpoch, body.authorityPath);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/me/acting-context-preferences/work.create', {
      body: t.Object({ profile: t.Literal('work-create-acting-context-preference-v1'),
        task: t.Literal('work.create'),
        actingSubject: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
        idempotencyKey: t.String({ minLength: 1, maxLength: 128 }),
      }, { additionalProperties: false }),
      response: { 200: actingContextPreference, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:create']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = await work.actingContexts.setPreference(principal,
          { actingSubject: body.actingSubject,
            expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/private-queries', {
      body: t.Object({ profile: t.Literal('private-contribution-phrase-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
      }, { additionalProperties: false }),
      response: { 400: problemResult(400), 503: problemResult(503) },
    }, () => problem(503, 'private_search_unavailable',
      'Private phrase delivery is unavailable'))
    .post('/v1/content-drafts', {
      body: t.Object({
        profile: t.Literal('content-text-v1'),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        language: t.Object({ kind: t.Literal('tag'), tag: t.String(),
          originalTag: t.String() }, { additionalProperties: false }),
        direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
        expectedHead: t.Union([t.String({ pattern: '^[0-9a-f-]{36}$' }), t.Null()]),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentDraftWriteResult, 201: contentDraftWriteResult,
        ...writeProblems, 413: problemResult(413) },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring) return problem(503, 'content_unavailable', 'Content authoring is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const saved = await saveAdmittedContentDraft(work.environment,
          work.contentAuthoring, work.account, work.access, request,
          { resourceId: body.resourceId,
            variant: { id: body.variantId, resourceId: body.resourceId,
              language: body.language, direction: body.direction },
            expectedHead: body.expectedHead, body: body.body,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ resourceId: body.resourceId, variantId: body.variantId,
          revisionId: saved.revisionId, predecessor: saved.predecessor,
          sourcePosition: saved.position, replayed: saved.replayed }, {
          status: saved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-comments', {
      body: t.Object({ profile: t.Literal('content-paragraph-comment-v1'),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        revisionId: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        exact: t.String({ minLength: 1, maxLength: 4096 }),
        body: t.String({ minLength: 1, maxLength: 8192 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentCommentResult, 201: contentCommentResult,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.comments) return problem(503, 'content_unavailable', 'Comment owner is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const comment = await createAdmittedContentComment(work.environment,
          work.comments, work.account, work.access, request, {
            resourceId: body.resourceId, revisionId: body.revisionId,
            exact: body.exact, body: body.body,
            author: body.actingSubject, idempotencyKey });
        return Response.json(comment, { status: comment.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/content-comments/:comment', {
      params: t.Object({ comment: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: contentCommentResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.comments || !work.content) {
          return problem(503, 'content_unavailable', 'Comment or Content owner is unavailable');
        }
        const comment = await work.comments.read(params.comment);
        if (!comment || !await work.access.canReadWork(principal, query.actingSubject,
          comment.resourceId)) {
          return problem(404, 'comment_unavailable', 'Comment is unavailable');
        }
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> {
            ${iri(comment.resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'comment_unavailable', 'Comment is unavailable');
        const exact = (await work.content.readExactBatch([comment.revisionId],
          async ids => new Set(ids)))[0];
        if (exact?.status !== 'available' || exact.reference.resourceId !== comment.resourceId
          || exact.reference.variantId !== comment.variantId
          || exact.reference.byteDigest !== comment.byteDigest) {
          return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
        }
        const text = exact.body.body;
        const selector = comment.target.selector;
        try {
          if (typeof text !== 'string') throw new ContentCommentInvalid('source has no text body');
          const resolved = resolveParagraphSelector(text, selector.exact);
          if (resolved.prefix !== selector.prefix || resolved.suffix !== selector.suffix) {
            throw new ContentCommentInvalid('stored selector context differs');
          }
        } catch (error) {
          if (!(error instanceof ContentCommentInvalid)) throw error;
          return problem(503, 'revision_unavailable', 'Comment selector no longer resolves');
        }
        return Response.json({ ...comment, resolvedText: selector.exact },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/content-revisions/:revision/comments', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }), pageSize: t.Optional(t.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      cursor: t.Optional(t.String({ pattern: '^[A-Za-z0-9_-]{1,512}$' })),
      }, { additionalProperties: false }),
      response: { 200: contentCommentPageResult,
        ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.comments || !work.content) {
          return problem(503, 'content_unavailable', 'Comment or Content owner is unavailable');
        }
        const resourceId = await work.content.owningResourceForRevision(params.revision);
        if (!resourceId || !await work.access.canReadWork(principal, query.actingSubject,
          resourceId)) return problem(404, 'comment_unavailable', 'Comments are unavailable');
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> {
            ${iri(resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'comment_unavailable', 'Comments are unavailable');
        let page;
        try {
          page = await work.comments.list(params.revision,
            query.pageSize ? Number(query.pageSize) : 50, query.cursor);
        } catch (error) {
          if (error instanceof ContentCommentInvalid) {
            return problem(400, 'invalid_comment_page', 'Comment page request is invalid');
          }
          throw error;
        }
        const exact = (await work.content.readExactBatch([params.revision],
          async ids => new Set(ids)))[0];
        if (exact?.status !== 'available' || exact.reference.resourceId !== resourceId) {
          return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
        }
        const text = exact.body.body;
        if (typeof text !== 'string') {
          return problem(503, 'revision_unavailable', 'Comment source text is unavailable');
        }
        const comments = [];
        for (const comment of page.comments) {
          if (comment.resourceId !== resourceId
            || comment.variantId !== exact.reference.variantId
            || comment.byteDigest !== exact.reference.byteDigest) {
            return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
          }
          const selector = comment.target.selector;
          try {
            const resolved = resolveParagraphSelector(text, selector.exact);
            if (resolved.prefix !== selector.prefix || resolved.suffix !== selector.suffix) {
              throw new ContentCommentInvalid('stored selector context differs');
            }
          } catch (error) {
            if (!(error instanceof ContentCommentInvalid)) throw error;
            return problem(503, 'revision_unavailable', 'Comment selector no longer resolves');
          }
          comments.push({ ...comment, resolvedText: selector.exact });
        }
        const payload = { ...page, comments };
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1_048_576) {
          return problem(422, 'comment_page_budget_exceeded',
            'Comment page is too large; request fewer comments');
        }
        return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-publications', {
      body: t.Object({ profile: t.Literal('content-publication-v1'),
        preparationId: t.String({ minLength: 1, maxLength: 200 }),
        revisionId: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        expectedDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        expectedContentEpoch: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        expectedPublicationHead: t.Nullable(t.String()),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentPublicationWriteResult, 201: contentPublicationWriteResult,
        202: contentPublicationWriteResult, ...writeProblems },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring) return problem(503, 'content_unavailable', 'Content owner is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const { profile: _profile, ...input } = body;
        const result = await publishAdmittedContent(work.environment, work.contentAuthoring,
          work.account, work.access, request, { ...input, idempotencyKey });
        return Response.json(result, { status: result.status === 'pending' ? 202
          : result.replayed || result.status === 'rejected' ? 200 : 201,
        headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-search-eligibility', {
      body: t.Object({ profile: t.Literal('content-search-eligibility-v1'),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        publicationDecision: t.String(), expectedEligibilityHead: t.Nullable(t.String()),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        rightsBasis: t.Literal('original-contribution'), disclosure: t.Literal('public'),
      }, { additionalProperties: false }),
      response: { 200: contentEligibilityWriteResult, 201: contentEligibilityWriteResult,
        ...writeProblems },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring || !work.access.verifyContentDraftProof) {
        return problem(503, 'content_unavailable', 'Content owner or author proof is unavailable');
      }
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const { profile: _profile, ...input } = body;
        const result = await selectAdmittedPublicContentSearch(work.environment,
          work.contentAuthoring, work.account,
          work.access as Required<MainWorkDependencies['access']>, request,
          { ...input, idempotencyKey });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/rating-aggregates', {
      body: t.Object({ profile: t.Literal('realm-standing-latest-mean-v1'),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: ratingAggregateResult, ...readProblems, 422: problemResult(422) },
    }, async ({ body }) => {
      try {
        const result = await queryStandingRatingAggregate(work.environment,
          { context: body.context, work: body.work, mainVersion: body.mainVersion });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/rating-observations', {
      body: t.Object({ profile: t.Literal('realm-standing-rating-observation-v1'),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedRevisionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null()]),
        value: t.Union([t.Integer({ minimum: 1, maximum: 10 }), t.Null()]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: ratingObservationWriteResult, 201: ratingObservationWriteResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await setAdmittedStandingRating(work.environment,
          work.account, work.access, request, { context: body.context, work: body.work,
            mainVersion: body.mainVersion, expectedRevisionHead: body.expectedRevisionHead,
            value: body.value, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ observation: receipt.observation,
          observationRevision: receipt.revision, predecessor: receipt.predecessor,
          context: receipt.context, work: receipt.work, mainVersion: receipt.mainVersion,
          value: receipt.value, availability: receipt.availability,
          profile: 'realm-standing-rating-observation-v1',
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/rating-observations/:observation/revisions/:revision', {
      params: t.Object({ observation: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) }),
      response: { 200: ratingObservationReadResult, ...authorizedReadProblems },
    }, async ({ params, query, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['rating:read']);
        if (!await work.access.canReadStandingRating(principal, query.actingSubject, query.context)) {
          return problem(403, 'authority_denied', 'Authority is not admitted');
        }
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Authority is not admitted');
        const observation = `https://rezics.com/id/${params.observation}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const slot = standingRatingSlotIri(principalId, query.context, query.mainVersion);
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?manifest ?work ?realm ?availability ?value ?predecessor
            ?evaluatedAt ?submittedAt ?originalSubmissionAt ?revisedAt WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
              ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:ratingContext ${iri(query.context)} .
              ${iri(query.context)} a rv:RatingContext ; rv:contextState rv:Active ;
                rv:realm ?realm ; rv:targetGrain rv:MainVersion ;
                rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
                rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
                rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
                rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
              ${iri(observation)} a rv:RatingObservation ; rv:ratingSlot ${iri(slot)} ;
                rv:ratingContext ${iri(query.context)} ;
                rv:targetMainVersion ${iri(query.mainVersion)} .
              ?work a <https://schema.org/CreativeWork> ;
                rv:mainVersion ${iri(query.mainVersion)} .
              ${iri(query.mainVersion)} a rv:MainVersion ; rv:work ?work .
            }
            GRAPH <urn:rezics:graph:revisions> { ${iri(revision)}
              a rv:RatingObservationRevision, rv:RevisionAnchor ;
              rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
              rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
              rv:manifest ?manifest ; rv:ratingAvailability ?availability ;
              rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
              rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt .
              OPTIONAL { ${iri(revision)} rv:ratingValue ?value }
              OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.manifest || !rows[0]?.work
          || !rows[0].realm || !rows[0].availability || !rows[0].evaluatedAt
          || !rows[0].submittedAt || !rows[0].originalSubmissionAt || !rows[0].revisedAt) {
          return problem(404, 'rating_revision_unavailable', 'Rating revision is unavailable');
        }
        const state = readComponentState(work.environment.objectDirectory,
          rows[0].manifest.value, observation, STANDING_RATING_OBSERVATION_PROFILE);
        if (state.observation !== observation || state.revision !== revision
          || state.slot !== slot || state.context !== query.context
          || state.realm !== rows[0].realm.value
          || state.mainVersion !== query.mainVersion || state.work !== rows[0].work.value
          || !['available', 'withdrawn'].includes(String(state.availability))
          || rows[0].availability.value !== `https://rezics.com/vocab/${
            state.availability === 'available' ? 'Available' : 'Withdrawn'}`
          || state.predecessor !== (rows[0].predecessor?.value ?? null)
          || !sameRatingInstant(state.evaluatedAt, rows[0].evaluatedAt.value)
          || !sameRatingInstant(state.submittedAt, rows[0].submittedAt.value)
          || !sameRatingInstant(state.originalSubmissionAt,
            rows[0].originalSubmissionAt.value)
          || !sameRatingInstant(state.revisedAt, rows[0].revisedAt.value)
          || (state.availability === 'available' && (!Number.isInteger(state.value)
            || Number(state.value) < 1 || Number(state.value) > 10
            || Number(rows[0].value?.value) !== state.value))
          || (state.availability === 'withdrawn' && (state.value !== null
            || rows[0].value))) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return Response.json({ observation, observationRevision: revision,
          context: state.context, work: state.work, mainVersion: state.mainVersion,
          predecessor: state.predecessor, availability: state.availability,
          value: state.value, evaluatedAt: state.evaluatedAt,
          submittedAt: state.submittedAt, originalSubmissionAt: state.originalSubmissionAt,
          revisedAt: state.revisedAt, profile: 'realm-standing-rating-observation-v1' },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/rating-contexts', {
      body: t.Object({ profile: t.Literal('realm-standing-rating-context-v1'),
        realm: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        question: t.String({ minLength: 3, maxLength: 120 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: ratingContextWriteResult, 201: ratingContextWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedRatingContext(work.environment,
          work.account, work.access, request, { realm: body.realm,
            question: body.question, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ context: receipt.context, realm: receipt.realm,
          question: body.question, contextRevision: receipt.revision,
          targetGrain: 'mainVersion', scale: { min: 1, max: 10, step: 1 },
          cadence: 'standing', population: 'account-principal',
          aggregation: 'latest-per-rater-mean',
          profile: 'realm-standing-rating-context-v1',
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/rating-contexts/:id', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: ratingContextReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const context = `https://rezics.com/id/${params.id}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?realm ?question ?revision ?manifest WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
              ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:ratingContext ${iri(context)} .
              ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ;
                rv:realm ?realm ; rv:question ?question ; rv:targetGrain rv:MainVersion ;
                rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
                rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
                rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
                rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
                rv:head ?revision .
            }
            GRAPH <urn:rezics:graph:revisions> { ?revision a rv:RevisionAnchor ;
              rv:component ${iri(context)} ;
              rv:modelRevision ${iri(REALM_STANDING_RATING_CONTEXT_PROFILE)} ;
              rv:manifest ?manifest . }
            FILTER(LANG(?question) = "en")
          }`);
        const rows = result.results?.bindings ?? [];
        const row = rows[0];
        if (rows.length !== 1 || !row?.realm || !row.question
          || row.question['xml:lang'] !== 'en' || !row.revision || !row.manifest) {
          return problem(404, 'rating_context_unavailable', 'Rating context is unavailable');
        }
        const state = readComponentState(work.environment.objectDirectory,
          row.manifest.value, context, REALM_STANDING_RATING_CONTEXT_PROFILE);
        if (state.context !== context || state.realm !== row.realm.value
          || state.question !== row.question.value || state.targetGrain !== 'MainVersion'
          || state.scaleMin !== 1 || state.scaleMax !== 10
          || state.cadence !== RATING_STANDING_CADENCE
          || state.populationPolicy !== RATING_ACCOUNT_POPULATION
          || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return Response.json({ context, realm: row.realm.value, question: row.question.value,
          contextRevision: row.revision.value, targetGrain: 'mainVersion',
          scale: { min: 1, max: 10, step: 1 }, cadence: 'standing',
          population: 'account-principal', aggregation: 'latest-per-rater-mean',
          profile: 'realm-standing-rating-context-v1' },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-resolutions', {
      body: t.Object({ profile: t.Literal('classification-resolution-v1'),
        context: t.Union([
          t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm-classification'),
            id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          }, { additionalProperties: false }),
        ]),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationResolutionResult, ...readProblems },
    }, async ({ body }) => {
      try {
        const result = await resolveClassification(work.environment,
          { context: body.context, work: body.work,
            mainVersion: body.mainVersion, sense: body.sense });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-decisions', {
      body: t.Object({ profile: t.Literal('classification-direct-decision-v1'),
        context: t.Union([
          t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm-classification'),
            id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          }, { additionalProperties: false }),
        ]),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedDecisionHead: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        outcome: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationDecisionWriteResult,
        201: classificationDecisionWriteResult, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await setAdmittedClassificationDecision(work.environment,
          work.account, work.access, request, { context: body.context,
            work: body.work, mainVersion: body.mainVersion, sense: body.sense,
            expectedDecisionHead: body.expectedDecisionHead, outcome: body.outcome,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ application: receipt.application, decision: receipt.decision,
          decisionOutcome: receipt.decisionOutcome, context: receipt.context,
          realm: receipt.realm ?? null, contextRevision: receipt.contextRevision ?? null,
          work: receipt.work, mainVersion: receipt.mainVersion, sense: receipt.sense,
          expectedDecisionHead: receipt.expectedHead, profile: 'classification-direct-decision-v1',
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-propositions', {
      body: t.Object({ profile: t.Literal('classification-proposition-v1'),
        label: t.String({ minLength: 1, maxLength: 120 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationPropositionWriteResult,
        201: classificationPropositionWriteResult, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedClassificationProposition(work.environment,
          work.account, work.access, request, { label: body.label,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ ...receipt.definitions, definitionRevision: receipt.revision,
          profile: 'classification-proposition-v1',
          interpretationScope: GLOBAL_CLASSIFICATION_CONTEXT,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/classification-propositions/:sense', {
      params: t.Object({ sense: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: classificationPropositionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const sense = `https://rezics.com/id/${params.sense}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          SELECT ?scheme ?concept ?path ?expression ?label ?revision ?manifest WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
                rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
                rv:path ?path ; rv:expression ?expression ; rv:head ?revision .
              ?expression a rv:ClassificationExpression ; rv:path ?path ;
                rv:assertedConcept ?concept ; rv:propositionKind rv:ConceptAssertion ;
                rv:expressionState rv:Active .
              ?path a rv:ConceptPath ; rv:pathKind rv:SingleConcept ;
                rv:pathLength 1 ; rv:terminalConcept ?concept ; rv:pathState rv:Active .
              ?concept a skos:Concept ; skos:inScheme ?scheme ; skos:prefLabel ?label ;
                rv:conceptState rv:Active .
              ?scheme a skos:ConceptScheme ; rv:schemeState rv:Active .
            }
            GRAPH <urn:rezics:graph:revisions> { ?revision a rv:RevisionAnchor ;
              rv:component ${iri(sense)} ;
              rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
              rv:manifest ?manifest . }
            FILTER(LANG(?label) = "en")
          }`);
        const rows = result.results?.bindings ?? [];
        const row = rows[0];
        if (rows.length !== 1 || !row?.scheme || !row.concept || !row.path
          || !row.expression || !row.label || row.label['xml:lang'] !== 'en'
          || !row.revision || !row.manifest) {
          return problem(404, 'classification_proposition_unavailable',
            'Classification proposition is unavailable');
        }
        const definitions = { scheme: row.scheme.value, concept: row.concept.value,
          path: row.path.value, expression: row.expression.value, sense };
        const state = readComponentState(work.environment.objectDirectory,
          row.manifest.value, sense, CLASSIFICATION_PROPOSITION_PROFILE);
        if (Object.entries(definitions).some(([key, id]) => state[key] !== id)
          || state.label !== row.label.value || state.language !== 'en'
          || state.scope !== GLOBAL_CLASSIFICATION_CONTEXT) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return Response.json({ ...definitions, label: row.label.value, language: 'en',
          definitionRevision: row.revision.value, profile: 'classification-proposition-v1',
          interpretationScope: GLOBAL_CLASSIFICATION_CONTEXT },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-contexts', {
      body: t.Object({ profile: t.Literal('classification-context-v1'),
        realm: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationContextWriteResult, 201: classificationContextWriteResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedClassificationContext(work.environment,
          work.account, work.access, request, { realm: body.realm,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ realm: receipt.realm, context: receipt.context,
          contextRevision: receipt.revision, role: 'realm-classification',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
          inheritancePolicy: CLASSIFICATION_INHERIT_POLICY,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/realms/:realm/classification-context', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: classificationContextReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?context ?revision ?fallback ?policy WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
              ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:classificationContext ?context .
              ?context a rv:ClassificationContext ; rv:realm ${iri(realm)} ;
                rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
                rv:fallbackContext ?fallback ; rv:inheritancePolicy ?policy ; rv:head ?revision .
              ?fallback a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ;
                rv:contextState rv:Active ;
                rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
              FILTER NOT EXISTS { ?fallback rv:fallbackContext ?other }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.context || !rows[0]?.revision
          || rows[0].fallback?.value !== GLOBAL_CLASSIFICATION_CONTEXT
          || rows[0].policy?.value !== CLASSIFICATION_INHERIT_POLICY) {
          return problem(404, 'classification_context_unavailable',
            'Realm classification context is unavailable');
        }
        return Response.json({ realm, context: rows[0].context.value,
          contextRevision: rows[0].revision.value, role: 'realm-classification',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
          inheritancePolicy: CLASSIFICATION_INHERIT_POLICY },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/spaces', {
      body: t.Object({ profile: t.Literal('space-realm-v1'),
        name: t.String({ minLength: 1, maxLength: 120,
          pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        capabilities: t.Tuple([t.Literal('realm')]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: spaceWriteResult, 201: spaceWriteResult, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedRealmSpace(work.environment, work.account, work.access,
          request, { name: body.name, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ space: receipt.space, realm: receipt.realm,
          spaceRevision: receipt.spaceRevision, realmRevision: receipt.realmRevision,
          owner: receipt.owner, capabilities: ['realm'],
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/spaces/:space', {
      params: t.Object({ space: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: spaceReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const space = `https://rezics.com/id/${params.space}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?realm ?owner ?name ?spaceRevision ?realmRevision
            ?selectionPolicy ?membershipPolicy ?reviewPolicy WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(space)} a rv:Space ; rv:disclosure rv:Public ; rv:realmCapability ?realm ;
                rv:owner ?owner ; rdfs:label ?name ; rv:head ?spaceRevision .
              ?realm a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
                rv:head ?realmRevision ; rv:selectionPolicy ?selectionPolicy ;
                rv:membershipPolicy ?membershipPolicy ; rv:reviewPolicy ?reviewPolicy .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.realm || !rows[0]?.owner || !rows[0]?.name
          || !rows[0]?.spaceRevision || !rows[0]?.realmRevision || !rows[0]?.selectionPolicy
          || !rows[0]?.membershipPolicy || !rows[0]?.reviewPolicy) {
          return problem(404, 'space_unavailable', 'Space is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ space, realm: row.realm!.value, owner: row.owner!.value,
          name: row.name!.value, capabilities: ['realm'], state: 'active',
          spaceRevision: row.spaceRevision!.value, realmRevision: row.realmRevision!.value,
          selectionPolicy: row.selectionPolicy!.value,
          membershipPolicy: row.membershipPolicy!.value,
          reviewPolicy: row.reviewPolicy!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/queries', {
      body: t.Union([t.Object({ profile: t.Literal('public-content-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]) }, { additionalProperties: false }), t.Object({ profile: t.Literal('public-main-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-main-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-rated-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        ratingContext: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        minimumMeanTimes10: t.Integer({ minimum: 10, maximum: 100 }),
      }, { additionalProperties: false })]),
      response: { 200: publicQueryResult, 400: problemResult(400),
        404: problemResult(404), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        if (body.profile === 'public-content-phrase-v1' && !work.contentProjection) {
          return problem(503, 'content_projection_unavailable', 'Public Content projection is unavailable');
        }
        const result = await withStableSearchSnapshot(fuseki, async () => body.profile === 'public-content-phrase-v1'
          ? queryPublicContentPhrase(work.environment, work.contentProjection!.content,
            work.contentProjection!.cursor, work.contentProjection!.consumer, body)
          : body.profile === 'public-realm-classified-rated-phrase-v1'
          ? await queryPublicRealmClassifiedRatedPhrase(work.environment, body)
          : body.profile === 'public-realm-phrase-v1'
          ? await queryPublicRealmPhrase(work.environment, body)
          : body.profile === 'public-main-phrase-v1'
            ? await queryPublicMainPhrase(work.environment, body)
            : body.profile === 'public-realm-classified-phrase-v1'
              ? await queryPublicRealmClassifiedPhrase(work.environment, body)
              : await queryPublicMainClassifiedPhrase(work.environment, body), undefined, diagnostics);
        return Response.json(result, {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    })
    .post('/v1/queries/page', {
      body: publicPhrasePageRequest,
      response: { 200: publicPhrasePageResult, 400: problemResult(400),
        404: problemResult(404), 409: problemResult(409), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        const page = await withStableSearchSnapshot(fuseki, async () => {
          if (body.profile === 'public-content-phrase-page-v1') {
            if (!work.contentProjection) {
              throw new ContentProjectionUnavailable('Public Content projection is unavailable');
            }
            const relation = await queryPublicContentPhrase(work.environment,
              work.contentProjection.content, work.contentProjection.cursor,
              work.contentProjection.consumer, body);
            return pageCompleteContentRelation(body, relation);
          }
          if (body.profile === 'public-main-phrase-page-v1') {
            const relation = await queryPublicMainPhrase(work.environment, body);
            return pageCompletePublicRelation(body, relation);
          }
          if (body.profile === 'public-realm-phrase-page-v1') {
            const relation = await queryPublicRealmPhrase(work.environment, body);
            return pageCompletePublicRelation(body, relation);
          }
          if (body.profile === 'public-main-classified-phrase-page-v1') {
            const relation = await queryPublicMainClassifiedPhrase(work.environment, body);
            return { ...pageCompletePublicRelation(body, relation),
              classificationSense: relation.classificationSense };
          }
          if (body.profile === 'public-realm-classified-phrase-page-v1') {
            const relation = await queryPublicRealmClassifiedPhrase(work.environment, body);
            return { ...pageCompletePublicRelation(body, relation),
              classificationSense: relation.classificationSense };
          }
          const relation = await queryPublicRealmClassifiedRatedPhrase(work.environment, body);
          return { ...pageCompletePublicRelation(body, relation),
            classificationSense: relation.classificationSense,
            ratingCriterion: relation.ratingCriterion,
            ratingPopulation: relation.ratingPopulation };
        }, undefined, diagnostics);
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof SearchContinuationRestart) {
          return problem(409, 'search_restart_required', 'Public search changed; restart at page one');
        }
        if (error instanceof InvalidSearchContinuation) {
          return problem(422, 'invalid_search_continuation', 'Public search continuation is invalid');
        }
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    })
    .post('/v1/publication-selections', {
      body: t.Union([t.Object({
        profile: t.Literal('main-default-selection-v1'),
        context: t.Object({ kind: t.Literal('main-version-default'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        publicationDecision: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        selectionBasis: t.Literal('main-maintainer'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('realm-local-selection-v1'),
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        publicationDecision: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        selectionBasis: t.Literal('realm-manager-review'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false })]),
      response: { 200: publicationSelectionWriteResult, 201: publicationSelectionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (body.profile === 'realm-local-selection-v1') {
          const receipt = await selectAdmittedRealmLocal(work.environment, work.account,
            work.access, request, { context: body.context, work: body.work,
              mainVersion: body.mainVersion, contribution: body.contribution,
              publicationDecision: body.publicationDecision,
              expectedSelectionHead: body.expectedSelectionHead,
              selectionBasis: body.selectionBasis, actingSubject: body.actingSubject,
              idempotencyKey });
          return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
            realm: receipt.realm, slot: receipt.slot,
            contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
            selectedDraft: receipt.selectedDraft, selection: receipt.selection,
            matchUnit: receipt.matchUnit, predecessor: receipt.expectedHead,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
              sequence: receipt.sequence }, replayed: receipt.replayed }, {
            status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
          });
        }
        const receipt = await selectAdmittedMainDefault(work.environment, work.account,
          work.access, request, { context: body.context, work: body.work,
            contribution: body.contribution, publicationDecision: body.publicationDecision,
            expectedSelectionHead: body.expectedSelectionHead,
            selectionBasis: body.selectionBasis, actingSubject: body.actingSubject,
            idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          mainRevision: receipt.mainRevision,
          contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, selection: receipt.selection,
          matchUnit: receipt.matchUnit, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/publication-rejections', {
      body: t.Object({
        profile: t.Literal('realm-local-rejection-v1'),
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        decisionBasis: t.Literal('realm-manager-review'),
        reasonCode: t.Literal('not-approved'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: publicationRejectionWriteResult, 201: publicationRejectionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await rejectAdmittedRealmLocal(work.environment, work.account,
          work.access, request, { context: body.context, work: body.work,
            mainVersion: body.mainVersion, expectedSelectionHead: body.expectedSelectionHead,
            decisionBasis: body.decisionBasis, reasonCode: body.reasonCode,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          realm: receipt.realm, slot: receipt.slot, rejection: receipt.rejection,
          reasonCode: receipt.reasonCode, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/realms/:realm/main-versions/:mainVersion/selection', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: realmSelectionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const slot = realmSelectionSlotIri(realm, main);
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?selection ?contribution ?draft ?language ?body ?reason
            ?effectiveContext ?suppressed WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
              ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
              ${iri(main)} a rv:MainVersion ; rv:work ?work .
              OPTIONAL { ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
                rv:mainVersion ${iri(main)} ; rv:selectionHead ?local }
              OPTIONAL { ${iri(main)} rv:selectionHead ?fallback }
            }
            BIND(COALESCE(?local, ?fallback) AS ?selection)
            BIND(IF(BOUND(?local), ${iri(realm)}, ${iri(main)}) AS ?effectiveContext)
            BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
            OPTIONAL {
              GRAPH <urn:rezics:graph:revisions> {
                ?selection a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} ;
                  rv:work ?work ; rv:mainVersion ${iri(main)} ;
                  rv:reasonCode rv:NotApproved .
              }
              BIND(true AS ?suppressed)
            }
            OPTIONAL {
              FILTER(!BOUND(?suppressed))
              GRAPH <urn:rezics:graph:revisions> {
                ?selection a rv:PublicationSelection ; rv:work ?work ;
                  rv:mainVersion ${iri(main)} ; rv:contribution ?contribution ;
                  rv:selectedDraft ?draft ; rv:matchUnit ?unit .
              }
              GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
                ?unit a rv:MatchUnit ; rv:selection ?selection ;
                  rv:mainVersion ${iri(main)} ; rv:context ?effectiveContext ;
                  rv:disclosure rv:Public ; rv:language ?language ; rv:searchBody ?body .
              }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.selection) {
          return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
        }
        const row = rows[0]!;
        if (row.suppressed?.value === 'true') {
          return Response.json({ status: 'suppressed', reason: 'realm-rejection',
            work: row.work!.value, mainVersion: main, realm,
            effectiveContext: realm, rejection: row.selection!.value,
            reasonCode: 'not-approved' }, { headers: { 'cache-control': 'no-store' } });
        }
        if (!row.contribution || !row.draft || !row.language
          || !row.body || !row.reason || !row.effectiveContext) {
          return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
        }
        return Response.json({ work: row.work!.value, mainVersion: main, realm,
          effectiveContext: row.effectiveContext!.value, reason: row.reason!.value,
          selection: row.selection!.value, contribution: row.contribution!.value,
          selectedDraft: row.draft!.value, language: row.language!.value,
          body: row.body!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/native-variants', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ language: t.Optional(t.String({ minLength: 2, maxLength: 35 })) },
        { additionalProperties: false }),
      response: { 200: t.Object({ work: t.String(), mainVersion: t.String(),
        complete: t.Literal(true), variants: t.Array(nativeVariantRef) }),
      ...readProblems, 422: problemResult(422) },
    }, async ({ params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const result = await listEligibleNativeVariants(work.environment, mainVersion, query.language);
        return Response.json({ work: result.work, mainVersion,
          complete: true, variants: result.variants }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/me/main-versions/:mainVersion/variant-preference', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('reader-native-variant-preference-v1'),
        contribution: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ mainVersion: t.String(), preference: readerPreferenceRef,
        replayed: t.Boolean() }), 201: t.Object({ mainVersion: t.String(),
        preference: readerPreferenceRef, replayed: t.Boolean() }),
      ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ params, body, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences) {
          return problem(503, 'dependency_unavailable', 'Reader preference owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const input = { mainVersion, contribution: body.contribution,
          expectedRevision: body.expectedRevision, idempotencyKey: key };
        const replay = await work.readerPreferences.replay(principalId, input);
        if (replay) return Response.json({ mainVersion, ...replay },
          { headers: { 'cache-control': 'no-store' } });
        if (body.contribution) {
          const candidate = await readEligibleNativeVariant(work.environment,
            mainVersion, body.contribution);
          if (!candidate) return problem(404, 'variant_unavailable', 'Native variant is unavailable');
        } else {
          await readNativeMainWork(work.environment, mainVersion);
        }
        const result = await work.readerPreferences.set(principalId, input);
        return Response.json({ mainVersion, ...result }, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/main-versions/:mainVersion/selection', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: nativeVariantSelection, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ params, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences) {
          return problem(503, 'dependency_unavailable', 'Reader preference owner is unavailable');
        }
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const preference = await work.readerPreferences.read(principalId, mainVersion);
        if (preference) {
          const preferred = await readEligibleNativeVariant(work.environment,
            mainVersion, preference.contribution);
          if (preferred) {
            return Response.json({ profile: 'reader-native-variant-selection-v1',
              work: preferred.work, mainVersion, mainSelection: null,
              reason: 'personal-preference', preference,
              chosen: { ...preferred.variant, body: preferred.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        const fallback = await readMainDefaultVariant(work.environment, mainVersion);
        return Response.json({ profile: 'reader-native-variant-selection-v1',
          work: fallback.work, mainVersion, mainSelection: fallback.selection,
          reason: preference ? 'preferred-ineligible' : 'main-default', preference,
          chosen: { ...fallback.variant, body: fallback.body } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/realms/:realm/main-versions/:mainVersion/variant-recommendation', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('realm-native-variant-recommendation-v1'),
        contribution: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ realm: t.String(), mainVersion: t.String(),
        recommendation: realmRecommendationRef, replayed: t.Boolean() }),
      201: t.Object({ realm: t.String(), mainVersion: t.String(),
        recommendation: realmRecommendationRef, replayed: t.Boolean() }),
      ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ params, body, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.realmRecommendations) {
          return problem(503, 'dependency_unavailable', 'Realm recommendation owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['realm:adopt']);
        const realm = `https://rezics.com/id/${params.realm}`;
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const input = { realm, mainVersion, contribution: body.contribution,
          expectedRevision: body.expectedRevision, actingSubject: body.actingSubject,
          idempotencyKey: key };
        await readRealmVariantDecision(work.environment, realm, mainVersion);
        const eligible = async () => {
          const decision = await readRealmVariantDecision(work.environment, realm, mainVersion);
          if (decision.kind !== 'none') return false;
          if (body.contribution === null) return true;
          const [fallback, candidate] = await Promise.all([
            readMainDefaultVariant(work.environment, mainVersion),
            readEligibleNativeVariant(work.environment, mainVersion, body.contribution),
          ]);
          return !!candidate && candidate.work === decision.work
            && candidate.variant.language === fallback.variant.language;
        };
        const result = await work.realmRecommendations.set(principal, input, eligible);
        return Response.json({ realm, mainVersion, ...result }, {
          status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/realms/:realm/main-versions/:mainVersion/selection', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: realmNativeVariantSelection, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ params, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences || !work.realmRecommendations) {
          return problem(503, 'dependency_unavailable', 'Reader selection owner is unavailable');
        }
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const realm = `https://rezics.com/id/${params.realm}`;
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const decision = await readRealmVariantDecision(work.environment, realm, mainVersion);
        const profile = 'reader-realm-native-variant-selection-v1';
        const ensureNoRealmDecision = async () => {
          const current = await readRealmVariantDecision(work.environment, realm, mainVersion);
          if (current.kind !== 'none' || current.work !== decision.work) {
            throw new NativeVariantUnavailable('Realm decision changed during reader selection');
          }
        };
        if (decision.kind === 'rejected') {
          return Response.json({ profile, status: 'suppressed', work: decision.work,
            mainVersion, realm, rejection: decision.selection },
          { headers: { 'cache-control': 'no-store' } });
        }
        const [preference, recommendation] = await Promise.all([
          work.readerPreferences.read(principalId, mainVersion),
          work.realmRecommendations.read(realm, mainVersion),
        ]);
        if (decision.kind === 'adopted') {
          const chosen = await readRealmAdoptedVariant(work.environment, realm, mainVersion,
            decision.work, decision.selection!);
          return Response.json({ profile, status: 'selected', work: decision.work,
            mainVersion, realm, mainSelection: null, realmSelection: decision.selection,
            reason: 'realm-adoption', preference, recommendation, chosen },
          { headers: { 'cache-control': 'no-store' } });
        }
        if (preference) {
          const preferred = await readEligibleNativeVariant(work.environment,
            mainVersion, preference.contribution);
          if (preferred) {
            await ensureNoRealmDecision();
            return Response.json({ profile, status: 'selected', work: preferred.work,
              mainVersion, realm, mainSelection: null, realmSelection: null,
              reason: 'personal-preference', preference, recommendation,
              chosen: { ...preferred.variant, body: preferred.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        const fallback = await readMainDefaultVariant(work.environment, mainVersion);
        if (recommendation) {
          const recommended = await readEligibleNativeVariant(work.environment,
            mainVersion, recommendation.contribution);
          if (recommended && recommended.variant.language === fallback.variant.language) {
            await ensureNoRealmDecision();
            return Response.json({ profile, status: 'selected', work: recommended.work,
              mainVersion, realm, mainSelection: null, realmSelection: null,
              reason: 'realm-recommendation', preference, recommendation,
              chosen: { ...recommended.variant, body: recommended.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        await ensureNoRealmDecision();
        return Response.json({ profile, status: 'selected', work: fallback.work,
          mainVersion, realm, mainSelection: fallback.selection, realmSelection: null,
          reason: preference && recommendation ? 'preferred-and-recommended-ineligible'
            : preference ? 'preferred-ineligible'
            : recommendation ? 'recommended-ineligible' : 'main-default',
          preference, recommendation, chosen: { ...fallback.variant, body: fallback.body } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/selection', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: mainSelectionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?selection ?contribution ?draft ?language ?body WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(main)} a rv:MainVersion ; rv:work ?work ; rv:selectionHead ?selection .
            }
            GRAPH <urn:rezics:graph:revisions> {
              ?selection a rv:PublicationSelection ; rv:component ${iri(main)} ;
                rv:contribution ?contribution ; rv:selectedDraft ?draft ; rv:matchUnit ?unit .
            }
            GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
              ?unit a rv:MatchUnit ; rv:selection ?selection ;
                rv:mainVersion ${iri(main)} ; rv:disclosure rv:Public ;
                rv:language ?language ; rv:searchBody ?body .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.selection
          || !rows[0]?.contribution || !rows[0]?.draft || !rows[0]?.language
          || !rows[0]?.body) {
          return problem(404, 'selection_unavailable', 'Main Version selection is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ work: row.work!.value, mainVersion: main,
          selection: row.selection!.value, contribution: row.contribution!.value,
          selectedDraft: row.draft!.value, language: row.language!.value,
          body: row.body!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/contribution-publications', {
      body: t.Object({
        profile: t.Literal('text-publication-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedDraftHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedPublicationHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        rightsBasis: t.Literal('original-contribution'),
        disclosure: t.Literal('public'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contributionPublicationWriteResult,
        201: contributionPublicationWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await publishAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution,
            expectedDraftHead: body.expectedDraftHead,
            expectedPublicationHead: body.expectedPublicationHead,
            rightsBasis: body.rightsBasis, disclosure: body.disclosure,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/contribution-edits', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contributionEditWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution, expectedHead: body.expectedHead,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/contributions', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        language: t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contributionWriteResult, 201: contributionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedTextContribution(work.environment, work.account,
          work.access, request, { work: body.work, language: body.language,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, work: receipt.work,
          language: receipt.language, author: receipt.author,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/contributions/:contribution/drafts/:revision', {
      params: t.Object({ contribution: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: contributionDraftReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const contribution = `https://rezics.com/id/${params.contribution}`;
        const revision = await readExactContributionDraft(work.environment, contribution,
          `https://rezics.com/id/${params.revision}`, async target => {
            if (!await work.access.canReadContributionDraft(
              principal, query.actingSubject, target)) return false;
            const current = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
              PREFIX schema: <https://schema.org/> ASK {
                GRAPH <urn:rezics:graph:current> {
                  ${iri(target)} a rv:TextContribution ; rv:work ?work .
                  ?work a schema:CreativeWork .
                }
              }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        authorityPath: t.Optional(t.Union([
          t.Literal('represented-agent'), t.Literal('direct-principal')])),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: workResult, 201: workResult, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401),
        403: problemResult(403), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { title: body.title, actingSubject: body.actingSubject,
            authorityPath: body.authorityPath, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          workRevision: receipt.workRevision, mainRevision: receipt.mainRevision,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    })
    .post('/v1/translation-links', {
      body: t.Object({ profile: t.Literal('translation-link-v1'),
        targetWork: t.String(), targetMainVersion: t.String(), targetMainRevision: t.String(),
        sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.Nullable(t.String()),
        status: t.Union([t.Literal('official'), t.Literal('third-party')]),
        contentLanguage: t.String(), translator: t.String(), publisher: t.String(),
        evidence: t.String(), actingSubject: t.String(),
      }, { additionalProperties: false }),
      response: { 200: translationLinkWrite, 201: translationLinkWrite, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const input = { targetWork: body.targetWork, targetMainVersion: body.targetMainVersion,
          targetMainRevision: body.targetMainRevision, sourceWork: body.sourceWork,
          sourceMainVersion: body.sourceMainVersion, sourceMainRevision: body.sourceMainRevision,
          status: body.status, contentLanguage: body.contentLanguage,
          translator: body.translator, publisher: body.publisher, evidence: body.evidence,
          actingSubject: body.actingSubject, idempotencyKey };
        validateTranslationLink(input);
        const receipt = await createAdmittedTranslationLink(work.environment, work.account,
          work.access, request, input);
        const links = await readTranslationLinks(work.environment,
          input.targetMainVersion, input.targetMainRevision);
        const linked = links.find(item => item.link === receipt.link);
        if (!linked) return problem(503, 'dependency_unavailable', 'Committed translation link is unavailable');
        return Response.json({ profile: 'translation-link-v1', ...linked,
          receipt: receipt.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, replayed: receipt.replayed },
        { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/translation-links', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: { 200: t.Object({ profile: t.Literal('translation-links-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        links: t.Array(translationLinkRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
      503: problemResult(503) },
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const links = await readTranslationLinks(work.environment, mainVersion, revision);
        return Response.json({ profile: 'translation-links-v1', mainVersion, revision,
          complete: true, links }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/work-derivations', {
      body: t.Object({ profile: t.Literal('work-derivation-v1'),
        targetWork: t.String(), targetMainVersion: t.String(), expectedTargetHead: t.String(),
        sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.String(),
        kind: t.Union([t.Literal('adaptation'), t.Literal('new-recording'),
          t.Literal('software-fork')]), evidence: t.String(), actingSubject: t.String(),
      }, { additionalProperties: false }),
      response: { 200: workDerivationWrite, 201: workDerivationWrite, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const input = { targetWork: body.targetWork, targetMainVersion: body.targetMainVersion,
          expectedTargetHead: body.expectedTargetHead, sourceWork: body.sourceWork,
          sourceMainVersion: body.sourceMainVersion, sourceMainRevision: body.sourceMainRevision,
          kind: body.kind, evidence: body.evidence, actingSubject: body.actingSubject,
          idempotencyKey };
        validateWorkDerivation(input);
        const receipt = await createAdmittedWorkDerivation(work.environment, work.account,
          work.access, request, input);
        const relations = await readWorkDerivations(work.environment,
          input.targetMainVersion, input.expectedTargetHead);
        const relation = relations.find(item => item.derivation === receipt.derivation);
        if (!relation) return problem(503, 'dependency_unavailable', 'Committed derivation is unavailable');
        return Response.json({ profile: 'work-derivation-v1', ...relation,
          receipt: receipt.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, replayed: receipt.replayed },
        { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/work-derivations', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: { 200: t.Object({ profile: t.Literal('work-derivations-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        derivations: t.Array(workDerivationRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409),
      500: problemResult(500), 503: problemResult(503) },
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const derivations = await readWorkDerivations(work.environment, mainVersion, revision);
        return Response.json({ profile: 'work-derivations-v1', mainVersion, revision,
          complete: true, derivations }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-edits', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentEditWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { work: body.work, expectedHead: body.expectedHead, title: body.title,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, revision: receipt.revision,
          predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    })
    .get('/v1/content-revisions/:revision', {
      params: t.Object({ revision: t.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: exactContentRevision, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.content) return problem(503, 'dependency_unavailable', 'Content owner is unavailable');
        const resourceId = await work.content.owningResourceForRevision(params.revision);
        if (!resourceId || !await work.access.canReadWork(principal, query.actingSubject, resourceId)) {
          return problem(404, 'revision_unavailable', 'Revision is unavailable');
        }
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> { ${iri(resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        const exact = (await work.content.readExactBatch([params.revision],
          async ids => new Set(ids)))[0];
        if (exact?.status === 'available') {
          return Response.json({ reference: exact.reference, serializedJson: exact.serializedJson,
            body: exact.body }, { headers: { 'cache-control': 'no-store' } });
        }
        if (exact?.status === 'corrupt' || exact?.status === 'unavailable') {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return problem(404, 'revision_unavailable', 'Revision is unavailable');
      } catch (error) {
        return commandError(error);
      }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision', {
      params: t.Object({
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }),
      }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: exactMainRevision, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const exact = await readExactMainRevision(work.environment,
          `https://rezics.com/id/${params.mainVersion}`,
          `https://rezics.com/id/${params.revision}`,
          workId => work.access.canReadWork(principal, query.actingSubject, workId));
        return Response.json(exact, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/revisions/:revision', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: exactWorkRevision, 400: problemResult(400),
        401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 500: problemResult(500),
        503: problemResult(503) },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const revision = await readExactWorkRevision(work.environment,
          `https://rezics.com/id/${params.revision}`, async workId => {
            if (!await work.access.canReadWork(principal, query.actingSubject, workId)) return false;
            const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
              ASK { GRAPH <urn:rezics:graph:current> { ${iri(workId)} a schema:CreativeWork } }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return commandError(error);
      }
    });
  }
  return app;
}

/** Inferred product route contract consumed by first-party Eden clients. */
export type MainApp = Extract<ReturnType<typeof createMainApp>,
  { '~Routes': { v1: unknown } }>;
