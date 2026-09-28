import { InvalidRatingCalendar } from '../modules/rating/calendar.ts';
import { ContentConflict, ContentLimitExceeded, ContentUnavailable }
  from '../../../content/src/core.ts';
import { ContentEmbedInvalid } from '../../../content/src/embed.ts';
import { ContentCommentCursorStale, ContentCommentInvalid, ContentCommentMissing }
  from '../../../content/src/comments.ts';
import { CommandRejected, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded }
  from '../infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable }
  from '../modules/access/admission.ts';
import { GroupConflict, GroupDenied, GroupStale, GroupUnavailable }
  from '../modules/access/groups.ts';
import { GrantConflict, GrantDenied, GrantStale, GrantUnavailable }
  from '../modules/access/grants.ts';
import { MembershipConflict, MembershipDenied, MembershipStale, MembershipUnavailable }
  from '../modules/access/memberships.ts';
import { OrgRealmConflict, OrgRealmDenied, OrgRealmStale, OrgRealmUnavailable }
  from '../modules/access/org-realm-authority.ts';
import { ManagedOrgConflict, ManagedOrgDenied, ManagedOrgStale, ManagedOrgUnavailable }
  from '../modules/access/managed-org-authority.ts';
import { PrivateRecipientConflict, PrivateRecipientDenied, PrivateRecipientStale,
  PrivateRecipientUnavailable } from '../modules/access/private-recipients.ts';
import { RepresentationConflict, RepresentationDenied, RepresentationStale,
  RepresentationUnavailable } from '../modules/access/representations.ts';
import { RoleConflict, RoleDenied, RoleStale, RoleUnavailable } from '../modules/access/roles.ts';
import { SourceIntakeConflict, SourceIntakeInvalid, SourceIntakeUnavailable,
  SourceProviderRateLimited } from '../modules/source/intake.ts';
import { OpenLibraryAcquisitionInvalid, OpenLibraryAcquisitionMissing,
  OpenLibraryAcquisitionUnavailable } from '../modules/source/open-library.ts';
import { SourceConversionInvalid, SourceConversionUnavailable }
  from '../modules/source/open-library-conversion.ts';
import { SourceChildCorrespondenceInvalid, SourceChildCorrespondenceConflict,
  SourceChildCorrespondenceUnavailable } from '../modules/source/record-child-correspondence.ts';
import { GoResolutionInvalid, GoResolutionConflict, GoResolutionUnavailable }
  from '../modules/package/go-mvs.ts';
import { CargoResolutionInvalid, CargoResolutionConflict, CargoResolutionUnavailable }
  from '../modules/package/cargo-resolution.ts';
import { NpmResolutionInvalid, NpmResolutionConflict, NpmResolutionUnavailable }
  from '../modules/package/npm-resolution.ts';
import { GoProxyCaptureInvalid, GoProxyCaptureConflict, GoProxyCaptureMissing,
  GoProxyCaptureUnavailable } from '../modules/package/go-proxy-capture.ts';
import { GoSumdbTrustInvalid, GoSumdbTrustConflict, GoSumdbTrustUnavailable }
  from '../modules/package/go-sumdb-trust.ts';
import { SourceGraphUnavailable } from '../modules/source/graph-projection.ts';
import { SourceProposalInvalid, SourceProposalMissingGraph, SourceProposalUnavailable }
  from '../modules/source/native-work-proposal.ts';
import { SourceAdoptionInvalid, SourceAdoptionConflict, SourceAdoptionUnavailable,
  SourceSupportConflict } from '../modules/source/native-work-adoption.ts';
import { AuthorCreditInvalid, AuthorCreditConflict, AuthorCreditUnavailable }
  from '../modules/work/author-credit.ts';
import { AddressClaimConflict, AddressClaimUnavailable, InvalidAddressClaim }
  from '../modules/address/claim.ts';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale, ActingContextUnavailable }
  from '../modules/access/contexts.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable }
  from '../modules/account/verify-assertion.ts';
import { PendingAdmittedWork } from '../modules/work/create-admitted.ts';
import { InvalidTranslationLink, TranslationLinkConflict, TranslationSourceUnavailable,
  TranslationTargetUnavailable } from '../modules/work/translation-links.ts';
import { InvalidWorkDerivation, WorkDerivationConflict, WorkDerivationStale,
  WorkDerivationUnavailable } from '../modules/work/derivations.ts';
import { FixedReleaseStale, FixedReleaseUnavailable, InvalidFixedRelease }
  from '../modules/work/fixed-release.ts';
import { StaleWorkHead, WorkEditUnavailable } from '../modules/work/edit.ts';
import { TitleControlConflict, TitleControlInvalid, TitleControlUnavailable }
  from '../modules/work/title-control.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionUnavailable } from '../modules/work/history.ts';
import { InvalidWorkScalarValue } from '../modules/work/scalar-value.ts';
import { RecoveryHold } from '../modules/work/restore-lineage.ts';
import { AuthorAgentUnavailable, CancelledActivation, IdempotencyConflict } from '../modules/work/activate.ts';
import { ContributionWorkUnavailable, InvalidContributionInput }
  from '../modules/contribution/draft.ts';
import { ContributionEditUnavailable, StaleContributionDraftHead }
  from '../modules/contribution/edit.ts';
import { InvalidPublicationInput, PublicationUnavailable, StalePublicationHead }
  from '../modules/contribution/publish.ts';
import { InvalidRealmRejectionInput, RealmRejectionUnavailable, StaleRealmRejection }
  from '../modules/work/reject-realm.ts';
import { InvalidRealmSelectionInput, RealmSelectionUnavailable, StaleRealmSelection }
  from '../modules/work/select-realm.ts';
import { InvalidSpaceInput } from '../modules/space/create.ts';
import { InvalidMainSelectionInput, MainSelectionUnavailable, StaleMainSelection }
  from '../modules/work/select-main.ts';
import { InvalidNativeVariant, NativeVariantLimit, NativeVariantUnavailable,
  ReaderVariantIdempotencyConflict, StaleReaderVariantPreference }
  from '../modules/work/native-variants.ts';
import { RealmVariantRecommendationConflict, StaleRealmVariantRecommendation }
  from '../modules/work/realm-variant-recommendation.ts';
import { InvalidPublicQuery, PublicQueryBudgetExceeded, PublicQueryUnavailable,
  PublicRealmUnavailable } from '../modules/work/search-public.ts';
import { SearchIndexBudgetExceeded, SearchIndexUnavailable }
  from '../modules/work/search-readiness.ts';
import { ContentProjectionGap, ContentProjectionProfileUnavailable, ContentProjectionUnavailable }
  from '../modules/content-publication/relay.ts';
import { ContentSearchBudgetExceeded, InvalidContentPhrase }
  from '../modules/content-publication/search.ts';
import { ContentDraftDenied, ContentDraftStale, ContentDraftUnavailable }
  from '../modules/content-publication/draft.ts';
import { ContentCommentDenied, ContentCommentWorkUnavailable }
  from '../modules/content-publication/comment.ts';
import { ContentPublicationConflict, ContentPublicationProfileUnavailable,
  InvalidContentPublication, StaleContentOwnerEpoch }
  from '../modules/content-publication/publish.ts';
import { ContentEmbedDenied, ContentEmbedUnavailable }
  from '../modules/content-publication/embed-closure.ts';
import { ContentEligibilityConflict, ContentEligibilityDenied, ContentEligibilityPending,
  ContentEligibilityProfileUnavailable, ContentEligibilityStale, ContentEligibilityUnavailable,
  InvalidContentEligibility } from '../modules/content-publication/eligibility.ts';
import { ClassificationRealmUnavailable, InvalidClassificationContextInput }
  from '../modules/classification/context.ts';
import { InvalidClassificationPropositionInput } from '../modules/classification/proposition.ts';
import { ClassificationDecisionUnavailable, InvalidClassificationDecisionInput,
  StaleClassificationDecision } from '../modules/classification/decision.ts';
import { InvalidClassificationResolution, ClassificationResolutionUnavailable,
  ClassificationTargetUnavailable } from '../modules/classification/resolve.ts';
import { InvalidRatingPolicyInput, RatingPolicyUnavailable, StaleRatingPolicy }
  from '../modules/rating/policy.ts';
import { RatingInventoryConflict } from '../modules/access/rating-aggregate-inventory.ts';
import { InvalidRatingContextInput, RatingRealmUnavailable } from '../modules/rating/context.ts';
import { InvalidRatingObservationInput, RatingObservationUnavailable, StaleRatingObservation }
  from '../modules/rating/observation.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded, RatingAggregateUnavailable }
  from '../modules/rating/aggregate.ts';

export function problem(status: number, code: string, title: string, headers?: HeadersInit): Response {
  return Response.json({ type: `https://rezics.com/problems/${code}`, title, status, code }, {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });
}

export function commandError(error: unknown): Response {
  if (error instanceof SourceIntakeInvalid) {
    return problem(400, 'invalid_source_intake', 'Source intake does not match its profile');
  }
  if (error instanceof SourceIntakeConflict) {
    return problem(409, 'idempotency_conflict', 'Source intake key conflicts with an earlier request');
  }
  if (error instanceof SourceIntakeUnavailable) {
    return problem(503, 'source_intake_unavailable', 'Source intake evidence is unavailable');
  }
  if (error instanceof OpenLibraryAcquisitionInvalid) {
    return problem(400, 'invalid_source_identity', 'Open Library Work identity is invalid');
  }
  if (error instanceof OpenLibraryAcquisitionMissing) {
    return problem(404, 'source_record_unavailable', 'Open Library Work is unavailable');
  }
  if (error instanceof OpenLibraryAcquisitionUnavailable) {
    return problem(503, 'source_acquisition_unavailable', 'Open Library acquisition is unavailable');
  }
  if (error instanceof SourceProviderRateLimited) {
    return problem(429, 'source_rate_limited', 'Open Library request budget is full',
      { 'retry-after': '1' });
  }
  if (error instanceof SourceConversionInvalid) {
    return problem(422, 'source_mapping_unsupported', 'Source observation cannot use this mapping');
  }
  if (error instanceof SourceConversionUnavailable) {
    return problem(503, 'source_conversion_unavailable', 'Source conversion is unavailable');
  }
  if (error instanceof SourceChildCorrespondenceInvalid) {
    return problem(400, 'invalid_source_correspondence', 'Source child correspondence is invalid');
  }
  if (error instanceof SourceChildCorrespondenceConflict) {
    return problem(409, 'source_correspondence_conflict', 'Source child correspondence conflicts');
  }
  if (error instanceof SourceChildCorrespondenceUnavailable) {
    return problem(503, 'source_correspondence_unavailable',
      'Source child correspondence evidence is unavailable');
  }
  if (error instanceof GoResolutionInvalid) {
    const codes = { invalid: 'go_resolution_unsupported',
      malformed: 'go_resolution_malformed',
      'changed-digest': 'go_local_digest_mismatch',
      duplicate: 'go_resolution_duplicate',
      'unsafe-source': 'go_local_source_unsafe' } as const;
    return problem(422, codes[error.kind], error.message);
  }
  if (error instanceof GoResolutionConflict) {
    return problem(409, 'go_resolution_conflict', 'Go resolution key binds another snapshot');
  }
  if (error instanceof GoResolutionUnavailable) {
    return problem(503, 'go_resolution_unavailable', 'Go resolution evidence is unavailable');
  }
  if (error instanceof CargoResolutionInvalid) {
    return problem(422, 'cargo_resolution_invalid', error.message);
  }
  if (error instanceof NpmResolutionInvalid) {
    return problem(422, 'npm_resolution_invalid', error.message);
  }
  if (error instanceof NpmResolutionConflict) {
    return problem(409, 'npm_resolution_conflict', 'npm resolution key binds another snapshot');
  }
  if (error instanceof NpmResolutionUnavailable) {
    return problem(503, 'npm_resolution_unavailable', 'npm resolution evidence is unavailable');
  }
  if (error instanceof CargoResolutionConflict) {
    return problem(409, 'cargo_resolution_conflict', 'Cargo resolution key binds another snapshot');
  }
  if (error instanceof CargoResolutionUnavailable) {
    return problem(503, 'cargo_resolution_unavailable', 'Cargo resolution evidence is unavailable');
  }
  if (error instanceof GoProxyCaptureInvalid) {
    return problem(422, 'go_capture_invalid', 'Go proxy capture request is invalid');
  }
  if (error instanceof GoProxyCaptureConflict) {
    return problem(409, 'go_capture_conflict', 'Go capture key binds another request');
  }
  if (error instanceof GoProxyCaptureMissing) {
    return problem(404, 'go_capture_missing', 'Go module metadata was not found');
  }
  if (error instanceof GoProxyCaptureUnavailable) {
    return problem(503, 'go_capture_unavailable', 'Go proxy capture is unavailable');
  }
  if (error instanceof GoSumdbTrustInvalid) {
    return problem(422, 'go_sumdb_verification_invalid',
      'Go checksum verification request is invalid');
  }
  if (error instanceof GoSumdbTrustConflict) {
    return problem(409, 'go_sumdb_verification_conflict',
      'Go checksum verification key binds another capture');
  }
  if (error instanceof GoSumdbTrustUnavailable) {
    return problem(503, 'go_sumdb_verification_unavailable',
      'Go checksum evidence or trust timeline is unavailable');
  }
  if (error instanceof SourceGraphUnavailable) {
    return problem(503, 'source_graph_unavailable', 'Source graph projection is unavailable');
  }
  if (error instanceof SourceProposalInvalid) {
    return problem(422, 'source_proposal_unsupported', 'Source title cannot be proposed as a Work');
  }
  if (error instanceof SourceProposalMissingGraph) {
    return problem(409, 'source_graph_required', 'Project the source graph before proposing a Work');
  }
  if (error instanceof SourceProposalUnavailable) {
    return problem(503, 'source_proposal_unavailable', 'Source proposal evidence is unavailable');
  }
  if (error instanceof SourceAdoptionInvalid) {
    return problem(400, 'invalid_source_adoption', 'Source adoption request is invalid');
  }
  if (error instanceof AuthorCreditInvalid) return problem(400, 'invalid_author_credit', 'Author credit request is invalid');
  if (error instanceof AuthorCreditConflict) return problem(409, 'author_credit_conflict', 'Author credit intent or evidence conflicts');
  if (error instanceof AuthorCreditUnavailable) return problem(503, 'author_credit_unavailable', 'Author credit evidence is unavailable');
  if (error instanceof SourceSupportConflict) {
    return problem(409, error.code, 'Source support disposition conflicts');
  }
  if (error instanceof SourceAdoptionConflict) {
    return problem(409, 'source_adoption_conflict', 'Source adoption intent conflicts');
  }
  if (error instanceof SourceAdoptionUnavailable) {
    return problem(503, 'source_adoption_unavailable', 'Source adoption evidence is unavailable');
  }
  if (error instanceof InvalidAddressClaim) return problem(400, 'invalid_address_claim', 'Address claim is invalid');
  if (error instanceof AddressClaimConflict) return problem(409, 'address_claim_conflict', 'Address claim conflicts');
  if (error instanceof AddressClaimUnavailable) return problem(503, 'address_unavailable', 'Address owner is unavailable');
  if (error instanceof PendingAdmittedWork) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.phase,
      result: null, retry: { allowed: true, afterMs: 1000 } }, {
      status: 202, headers: { 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
  if (error instanceof AuthorAgentUnavailable) {
    return problem(409, 'author_agent_unavailable', 'Author Agent has no active graph record');
  }
  if (error instanceof AccountAssertionDenied) {
    return problem(401, 'account_assertion_denied', 'Account assertion is invalid or inactive',
      { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof GroupDenied) return problem(403, 'group_denied', 'Group change is not admitted');
  if (error instanceof GroupConflict) return problem(409, 'group_key_conflict', 'Group change key binds another intent');
  if (error instanceof GroupStale) return problem(409, 'group_stale', 'Group generation changed');
  if (error instanceof GroupUnavailable) return problem(503, 'group_unavailable', 'Group change is unavailable');
  if (error instanceof GrantDenied) return problem(403, 'grant_denied', 'Grant change is not admitted');
  if (error instanceof GrantConflict) return problem(409, 'grant_key_conflict', 'Grant change key binds another intent');
  if (error instanceof GrantStale) return problem(409, 'grant_stale', 'Grant authority changed');
  if (error instanceof GrantUnavailable) return problem(503, 'grant_unavailable', 'Grant owner is unavailable');
  if (error instanceof OrgRealmDenied) return problem(403, 'org_realm_denied', 'Organization participation is not admitted');
  if (error instanceof OrgRealmConflict) return problem(409, 'org_realm_key_conflict', 'Participation key binds another intent');
  if (error instanceof OrgRealmStale) return problem(409, 'org_realm_stale', 'Participation or policy basis changed');
  if (error instanceof OrgRealmUnavailable) return problem(503, 'org_realm_unavailable', 'Participation owner is unavailable');
  if (error instanceof ManagedOrgDenied) return problem(403, 'managed_org_denied', 'Organization management is not admitted');
  if (error instanceof ManagedOrgConflict) return problem(409, 'managed_org_key_conflict', 'Management key binds another intent');
  if (error instanceof ManagedOrgStale) return problem(409, 'managed_org_stale', 'Management authority or policy changed');
  if (error instanceof ManagedOrgUnavailable) return problem(503, 'managed_org_unavailable', 'Organization management is unavailable');
  if (error instanceof MembershipDenied) return problem(403, 'membership_denied', 'Membership change is not admitted');
  if (error instanceof MembershipConflict) return problem(409, 'membership_key_conflict', 'Membership key binds another intent');
  if (error instanceof MembershipStale) return problem(409, 'membership_stale', 'Membership or policy generation changed');
  if (error instanceof MembershipUnavailable) return problem(503, 'membership_unavailable', 'Membership owner is unavailable');
  if (error instanceof PrivateRecipientDenied) return problem(403, 'private_recipient_denied', 'Private recipient change is not admitted');
  if (error instanceof PrivateRecipientConflict) return problem(409, 'private_recipient_key_conflict', 'Private recipient key binds another intent');
  if (error instanceof PrivateRecipientStale) return problem(409, 'private_recipient_stale', 'Private recipient authority changed');
  if (error instanceof PrivateRecipientUnavailable) return problem(503, 'private_recipient_unavailable', 'Private recipient owner is unavailable');
  if (error instanceof RepresentationDenied) return problem(403, 'representation_denied', 'Representation is not admitted');
  if (error instanceof RepresentationConflict) return problem(409, 'representation_key_conflict', 'Representation key binds another intent');
  if (error instanceof RepresentationStale) return problem(409, 'representation_stale', 'Representation authority changed');
  if (error instanceof RepresentationUnavailable) return problem(503, 'representation_unavailable', 'Representation owner is unavailable');
  if (error instanceof RoleDenied) return problem(403, 'role_denied', 'Role change is not admitted');
  if (error instanceof RoleConflict) return problem(409, 'role_key_conflict', 'Role key binds another intent');
  if (error instanceof RoleStale) return problem(409, 'role_stale', 'Role generation changed');
  if (error instanceof RoleUnavailable) return problem(503, 'role_unavailable', 'Role owner is unavailable');
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
  if (error instanceof ContentEmbedInvalid) {
    return problem(400, 'invalid_content_embeds', 'Content embed set is invalid');
  }
  if (error instanceof ContentEmbedDenied) {
    return problem(403, 'embed_not_public', 'An embedded Content revision is not publicly disclosed');
  }
  if (error instanceof ContentEmbedUnavailable) {
    return problem(503, 'embed_unavailable', 'An embedded Content revision is unavailable');
  }
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
    || error instanceof InvalidRatingCalendar
    || error instanceof InvalidRatingContextInput
    || error instanceof InvalidRatingObservationInput
    || error instanceof InvalidRatingAggregateQuery) {
    return problem(400, 'invalid_request', 'Request fields are invalid');
  }
  if (error instanceof AdmissionConflict || error instanceof IdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof CancelledActivation) return problem(409, 'operation_cancelled', 'Work operation was cancelled');
  if (error instanceof TitleControlConflict) return problem(409, 'title_control_conflict', error.message);
  if (error instanceof TitleControlInvalid) return problem(400, 'invalid_title_control', error.message);
  if (error instanceof TitleControlUnavailable) return problem(503, 'title_control_unavailable', error.message);
  if (error instanceof StaleWorkHead) return problem(409, 'stale_head', 'Expected Work revision is stale');
  if (error instanceof InvalidWorkScalarValue) {
    return problem(400, 'invalid_scalar_value', 'Work scalar value is invalid');
  }
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
  if (error instanceof StaleRatingPolicy) {
    return problem(409, 'stale_head', 'Expected Rating policy head is stale');
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
  if (error instanceof InvalidFixedRelease) {
    return problem(400, 'invalid_request', 'Fixed release request is invalid');
  }
  if (error instanceof FixedReleaseUnavailable) {
    return problem(404, 'release_selection_unavailable', 'Eligible native selection is unavailable');
  }
  if (error instanceof FixedReleaseStale) {
    return problem(409, 'stale_release_selection', 'Main Version head or selection changed');
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
  if (error instanceof InvalidRatingPolicyInput) {
    return problem(400, 'invalid_request', 'Rating policy request is invalid');
  }
  if (error instanceof RatingObservationUnavailable) {
    return problem(409, 'rating_observation_unavailable', 'Rating observation is unavailable');
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
  if (error instanceof RatingPolicyUnavailable || error instanceof RatingInventoryConflict) {
    return problem(503, 'rating_policy_unavailable', 'Rating policy revision is unavailable');
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
