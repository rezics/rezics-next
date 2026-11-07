/** Community's cross-domain capabilities. Composition supplies the existing native values.
 * Type queries retain overloads, branded evidence and constructor identities without loading providers. */
export type CommunityDomainPorts = Readonly<{
  readNativeAccountStates: typeof import('../access/account-authority.ts').readNativeAccountStates;
  readPublicIdentities: typeof import('../access/account-data.ts').readPublicIdentities;
  readAccount: typeof import('../access/account-data.ts').readAccount;
  readOrganizationRole: typeof import('../access/account-data.ts').readOrganizationRole;
  deadlineClient: typeof import('../access/authenticate.ts').deadlineClient;
  within: typeof import('../access/authenticate.ts').within;
  PLATFORM_RESOURCE: typeof import('../access/bootstrap-governance.ts').PLATFORM_RESOURCE;
  accessCommandAttempt: typeof import('../access/command-admission.ts').accessCommandAttempt;
  commandAccessContext: typeof import('../access/command-admission.ts').commandAccessContext;
  captureDurableInitiator: typeof import('../access/durable-initiator-capture.ts').captureDurableInitiator;
  durableInitiatorCommitment: typeof import('../access/durable-initiator-capture.ts').durableInitiatorCommitment;
  DurableInitiatorUnavailableError: typeof import('../access/durable-initiator.ts').DurableInitiatorUnavailableError;
  readErasureStatus: typeof import('../access/erasure.ts').readErasureStatus;
  acknowledgeErasure: typeof import('../access/erasure.ts').acknowledgeErasure;
  resolveRetention: typeof import('../access/erasure.ts').resolveRetention;
  recordLateErasureItem: typeof import('../access/erasure.ts').recordLateErasureItem;
  resolveLateErasureItem: typeof import('../access/erasure.ts').resolveLateErasureItem;
  handleHolder: typeof import('../access/handle-holder.ts').handleHolder;
  resourceAuthorization: typeof import('../access/index.ts').resourceAuthorization;
  createResourcePublicEligibility: typeof import('../access/index.ts').createResourcePublicEligibility;
  initializeResourceGrants: typeof import('../access/index.ts').initializeResourceGrants;
  parentCreationAuthorization: typeof import('../access/index.ts').parentCreationAuthorization;
  approveRealmClaim: typeof import('../access/index.ts').approveRealmClaim;
  normalizeHandle: typeof import('../access/lifecycle.ts').normalizeHandle;
  MEMBERSHIP_LIMIT: typeof import('../access/membership-inverse.ts').MEMBERSHIP_LIMIT;
  MembershipInverseIncompleteError: typeof import('../access/membership-inverse.ts').MembershipInverseIncompleteError;
  requireMembershipInverseReady: typeof import('../access/membership-inverse.ts').requireMembershipInverseReady;
  enqueueMembership: typeof import('../access/membership-work.ts').enqueueMembership;
  permissionEvidenceDeadline: typeof import('../access/permission.ts').permissionEvidenceDeadline;
  first: typeof import('../access/realm-membership-transition.ts').first;
  isRealmTransitionOpen: typeof import('../access/realm-membership-transition.ts').isRealmTransitionOpen;
  transitionParameters: typeof import('../access/realm-membership-transition.ts').transitionParameters;
  createRealmOwnershipCommands: typeof import('../access/realm-ownership.ts').createRealmOwnershipCommands;
  assertRealmOwnerMayLeave: typeof import('../access/realm-ownership.ts').assertRealmOwnerMayLeave;
  lockRealmOwnership: typeof import('../access/realm-ownership.ts').lockRealmOwnership;
  REALM_OWNER_ROLE: typeof import('../access/realm-ownership.ts').REALM_OWNER_ROLE;
  readRealmOwnerLeaveObservation: typeof import('../access/realm-ownership.ts').readRealmOwnerLeaveObservation;
  readRealmOwnershipRoles: typeof import('../access/realm-ownership.ts').readRealmOwnershipRoles;
  readAppliedRealmErasureSuccession: typeof import('../access/realm-ownership.ts').readAppliedRealmErasureSuccession;
  authorizeResource: typeof import('../access/resource-authorization.ts').resourceAuthorization;
  endResourceDenial: typeof import('../access/resource-denials.ts').endResourceDenial;
  recordResourceDenial: typeof import('../access/resource-denials.ts').recordResourceDenial;
  requireResourceCommand: typeof import('../access/resource-denials.ts').requireResourceCommand;
  ResourceAccessWriteDeniedError: typeof import('../access/resource-denials.ts').ResourceAccessWriteDeniedError;
  grantGroupRole: typeof import('../access/resource-group-grant.ts').grantGroupRole;
  readViewerActions: typeof import('../access/viewer-actions.ts').readViewerActions;
  platformRootAnchor: typeof import('../commerce/catalogue.ts').platformRootAnchor;
  listRealmBoards: typeof import('../content/boards.ts').listRealmBoards;
  prepareRealmRulesSelection: typeof import('../content/community-presentation-rules.ts').prepareRealmRulesSelection;
  rulesKey: typeof import('../content/community-presentation-rules.ts').rulesKey;
  readCommunityPresentations: typeof import('../content/community-presentation.ts').readCommunityPresentations;
  readDiscoveryOperation: typeof import('../content/discovery-mutation.ts').readDiscoveryOperation;
  readDiscoveryOutcome: typeof import('../content/discovery-mutation.ts').readDiscoveryOutcome;
  readDiscoverySource: typeof import('../content/discovery.ts').readDiscoverySource;
  prepareDiscoverySourceApply: typeof import('../content/discovery.ts').prepareDiscoverySourceApply;
  MediaUnavailableError: typeof import('../content/media.ts').MediaUnavailableError;
  eraseAccountNoticesPage: typeof import('../content/notices.ts').eraseAccountNoticesPage;
  ContentNotFoundError: typeof import('../content/reads.ts').ContentNotFoundError;
  readExactPublishedRulesForAuthoring: typeof import('../content/reads.ts').readExactPublishedRulesForAuthoring;
  readBoardPageActionEvidence: typeof import('../content/reads.ts').readBoardPageActionEvidence;
  readExactPublishedRules: typeof import('../content/reads.ts').readExactPublishedRules;
  createRealmHomeBoardObservationReader: typeof import('../content/realm-board-home.ts').createRealmHomeBoardObservationReader;
  RealmHomeBoardPageSchema: typeof import('../content/realm-board-home.ts').RealmHomeBoardPageSchema;
  realmHomeBoardResponse: typeof import('../content/realm-board-home.ts').realmHomeBoardResponse;
  RealmHomeBoardQuerySchema: typeof import('../content/realm-board-home.ts').RealmHomeBoardQuerySchema;
  exactRealmPresentationImage: typeof import('../content/realm-media.ts').exactRealmPresentationImage;
  readRealmPresentationImages: typeof import('../content/realm-media.ts').readRealmPresentationImages;
  claimRealmPresentationMedia: typeof import('../content/realm-media.ts').claimRealmPresentationMedia;
  RealmMediaImageSchema: typeof import('../content/realm-media.ts').RealmPresentationImageSchema;
  SitemapQuerySchema: typeof import('../content/schemas.ts').SitemapQuerySchema;
  ContentIdSchema: typeof import('../content/schemas.ts').ContentIdSchema;
  ContentRealmImageSchema: typeof import('../content/schemas.ts').RealmPresentationImageSchema;
  sitemapPageSchema: typeof import('../content/schemas.ts').sitemapPageSchema;
  problemSchema: typeof import('../http/problem.ts').problemSchema;
  IDEMPOTENCY_HEADER: typeof import('../http/request.ts').IDEMPOTENCY_HEADER;
  idempotencyKeyOf: typeof import('../http/request.ts').idempotencyKeyOf;
  SESSION_HEADER: typeof import('../http/request.ts').SESSION_HEADER;
  createFollowCommands: typeof import('../library/follows.ts').createFollowCommands;
  accessCheck: typeof import('../request/access.ts').accessCheck;
  accessCommandAuthorization: typeof import('../request/access.ts').accessCommandAuthorization;
  AuthenticationError: typeof import('../request/access.ts').AuthenticationError;
  prepareReadDecisions: typeof import('../request/access.ts').prepareReadDecisions;
  subjectReadEligibility: typeof import('../semantic/eligibility.ts').subjectReadEligibility;
  SubjectRedirectError: typeof import('../semantic/merges.ts').SubjectRedirectError;
  withReadTransaction: typeof import('../semantic/read.ts').withReadTransaction;
  readSubjectReference: typeof import('../semantic/references.ts').readSubjectReference;
  readItemTypes: typeof import('../semantic/subject.ts').readItemTypes;
  readSubjectSummaryObservation: typeof import('../semantic/summaries.ts').readSubjectSummaryObservation;
}>;

export let readNativeAccountStates: CommunityDomainPorts['readNativeAccountStates'];
export let readPublicIdentities: CommunityDomainPorts['readPublicIdentities'];
export let readAccount: CommunityDomainPorts['readAccount'];
export let readOrganizationRole: CommunityDomainPorts['readOrganizationRole'];
export let deadlineClient: CommunityDomainPorts['deadlineClient'];
export let within: CommunityDomainPorts['within'];
export let PLATFORM_RESOURCE: CommunityDomainPorts['PLATFORM_RESOURCE'];
export let accessCommandAttempt: CommunityDomainPorts['accessCommandAttempt'];
export let commandAccessContext: CommunityDomainPorts['commandAccessContext'];
export let captureDurableInitiator: CommunityDomainPorts['captureDurableInitiator'];
export let durableInitiatorCommitment: CommunityDomainPorts['durableInitiatorCommitment'];
export let DurableInitiatorUnavailableError: CommunityDomainPorts['DurableInitiatorUnavailableError'];
export let readErasureStatus: CommunityDomainPorts['readErasureStatus'];
export let acknowledgeErasure: CommunityDomainPorts['acknowledgeErasure'];
export let resolveRetention: CommunityDomainPorts['resolveRetention'];
export let recordLateErasureItem: CommunityDomainPorts['recordLateErasureItem'];
export let resolveLateErasureItem: CommunityDomainPorts['resolveLateErasureItem'];
export let handleHolder: CommunityDomainPorts['handleHolder'];
export let resourceAuthorization: CommunityDomainPorts['resourceAuthorization'];
export let createResourcePublicEligibility: CommunityDomainPorts['createResourcePublicEligibility'];
export let initializeResourceGrants: CommunityDomainPorts['initializeResourceGrants'];
export let parentCreationAuthorization: CommunityDomainPorts['parentCreationAuthorization'];
export let approveRealmClaim: CommunityDomainPorts['approveRealmClaim'];
export let normalizeHandle: CommunityDomainPorts['normalizeHandle'];
export let MEMBERSHIP_LIMIT: CommunityDomainPorts['MEMBERSHIP_LIMIT'];
export let MembershipInverseIncompleteError: CommunityDomainPorts['MembershipInverseIncompleteError'];
export let requireMembershipInverseReady: CommunityDomainPorts['requireMembershipInverseReady'];
export let enqueueMembership: CommunityDomainPorts['enqueueMembership'];
export let permissionEvidenceDeadline: CommunityDomainPorts['permissionEvidenceDeadline'];
export let first: CommunityDomainPorts['first'];
export let isRealmTransitionOpen: CommunityDomainPorts['isRealmTransitionOpen'];
export let transitionParameters: CommunityDomainPorts['transitionParameters'];
export let createRealmOwnershipCommands: CommunityDomainPorts['createRealmOwnershipCommands'];
export let assertRealmOwnerMayLeave: CommunityDomainPorts['assertRealmOwnerMayLeave'];
export let lockRealmOwnership: CommunityDomainPorts['lockRealmOwnership'];
export let REALM_OWNER_ROLE: CommunityDomainPorts['REALM_OWNER_ROLE'];
export let readRealmOwnerLeaveObservation: CommunityDomainPorts['readRealmOwnerLeaveObservation'];
export let readRealmOwnershipRoles: CommunityDomainPorts['readRealmOwnershipRoles'];
export let readAppliedRealmErasureSuccession: CommunityDomainPorts['readAppliedRealmErasureSuccession'];
export let authorizeResource: CommunityDomainPorts['authorizeResource'];
export let endResourceDenial: CommunityDomainPorts['endResourceDenial'];
export let recordResourceDenial: CommunityDomainPorts['recordResourceDenial'];
export let requireResourceCommand: CommunityDomainPorts['requireResourceCommand'];
export let ResourceAccessWriteDeniedError: CommunityDomainPorts['ResourceAccessWriteDeniedError'];
export let grantGroupRole: CommunityDomainPorts['grantGroupRole'];
export let readViewerActions: CommunityDomainPorts['readViewerActions'];
export let platformRootAnchor: CommunityDomainPorts['platformRootAnchor'];
export let listRealmBoards: CommunityDomainPorts['listRealmBoards'];
export let prepareRealmRulesSelection: CommunityDomainPorts['prepareRealmRulesSelection'];
export let rulesKey: CommunityDomainPorts['rulesKey'];
export let readCommunityPresentations: CommunityDomainPorts['readCommunityPresentations'];
export let readDiscoveryOperation: CommunityDomainPorts['readDiscoveryOperation'];
export let readDiscoveryOutcome: CommunityDomainPorts['readDiscoveryOutcome'];
export let readDiscoverySource: CommunityDomainPorts['readDiscoverySource'];
export let prepareDiscoverySourceApply: CommunityDomainPorts['prepareDiscoverySourceApply'];
export let MediaUnavailableError: CommunityDomainPorts['MediaUnavailableError'];
export let eraseAccountNoticesPage: CommunityDomainPorts['eraseAccountNoticesPage'];
export let ContentNotFoundError: CommunityDomainPorts['ContentNotFoundError'];
export let readExactPublishedRulesForAuthoring: CommunityDomainPorts['readExactPublishedRulesForAuthoring'];
export let readBoardPageActionEvidence: CommunityDomainPorts['readBoardPageActionEvidence'];
export let readExactPublishedRules: CommunityDomainPorts['readExactPublishedRules'];
export let createRealmHomeBoardObservationReader: CommunityDomainPorts['createRealmHomeBoardObservationReader'];
export let RealmHomeBoardPageSchema: CommunityDomainPorts['RealmHomeBoardPageSchema'];
export let realmHomeBoardResponse: CommunityDomainPorts['realmHomeBoardResponse'];
export let RealmHomeBoardQuerySchema: CommunityDomainPorts['RealmHomeBoardQuerySchema'];
export let exactRealmPresentationImage: CommunityDomainPorts['exactRealmPresentationImage'];
export let readRealmPresentationImages: CommunityDomainPorts['readRealmPresentationImages'];
export let claimRealmPresentationMedia: CommunityDomainPorts['claimRealmPresentationMedia'];
export let RealmMediaImageSchema: CommunityDomainPorts['RealmMediaImageSchema'];
export let SitemapQuerySchema: CommunityDomainPorts['SitemapQuerySchema'];
export let ContentIdSchema: CommunityDomainPorts['ContentIdSchema'];
export let ContentRealmImageSchema: CommunityDomainPorts['ContentRealmImageSchema'];
export let sitemapPageSchema: CommunityDomainPorts['sitemapPageSchema'];
export let problemSchema: CommunityDomainPorts['problemSchema'];
export let IDEMPOTENCY_HEADER: CommunityDomainPorts['IDEMPOTENCY_HEADER'];
export let idempotencyKeyOf: CommunityDomainPorts['idempotencyKeyOf'];
export let SESSION_HEADER: CommunityDomainPorts['SESSION_HEADER'];
export let createFollowCommands: CommunityDomainPorts['createFollowCommands'];
export let accessCheck: CommunityDomainPorts['accessCheck'];
export let accessCommandAuthorization: CommunityDomainPorts['accessCommandAuthorization'];
export let AuthenticationError: CommunityDomainPorts['AuthenticationError'];
export let prepareReadDecisions: CommunityDomainPorts['prepareReadDecisions'];
export let subjectReadEligibility: CommunityDomainPorts['subjectReadEligibility'];
export let SubjectRedirectError: CommunityDomainPorts['SubjectRedirectError'];
export let withReadTransaction: CommunityDomainPorts['withReadTransaction'];
export let readSubjectReference: CommunityDomainPorts['readSubjectReference'];
export let readItemTypes: CommunityDomainPorts['readItemTypes'];
export let readSubjectSummaryObservation: CommunityDomainPorts['readSubjectSummaryObservation'];

/** Installed before HTTP handlers or workflows run; each binding is the owner's original value. */
export function bindCommunityDomainPorts(ports: CommunityDomainPorts): void {
  ({
    readNativeAccountStates,
    readPublicIdentities,
    readAccount,
    readOrganizationRole,
    deadlineClient,
    within,
    PLATFORM_RESOURCE,
    accessCommandAttempt,
    commandAccessContext,
    captureDurableInitiator,
    durableInitiatorCommitment,
    DurableInitiatorUnavailableError,
    readErasureStatus,
    acknowledgeErasure,
    resolveRetention,
    recordLateErasureItem,
    resolveLateErasureItem,
    handleHolder,
    resourceAuthorization,
    createResourcePublicEligibility,
    initializeResourceGrants,
    parentCreationAuthorization,
    approveRealmClaim,
    normalizeHandle,
    MEMBERSHIP_LIMIT,
    MembershipInverseIncompleteError,
    requireMembershipInverseReady,
    enqueueMembership,
    permissionEvidenceDeadline,
    first,
    isRealmTransitionOpen,
    transitionParameters,
    createRealmOwnershipCommands,
    assertRealmOwnerMayLeave,
    lockRealmOwnership,
    REALM_OWNER_ROLE,
    readRealmOwnerLeaveObservation,
    readRealmOwnershipRoles,
    readAppliedRealmErasureSuccession,
    authorizeResource,
    endResourceDenial,
    recordResourceDenial,
    requireResourceCommand,
    ResourceAccessWriteDeniedError,
    grantGroupRole,
    readViewerActions,
    platformRootAnchor,
    listRealmBoards,
    prepareRealmRulesSelection,
    rulesKey,
    readCommunityPresentations,
    readDiscoveryOperation,
    readDiscoveryOutcome,
    readDiscoverySource,
    prepareDiscoverySourceApply,
    MediaUnavailableError,
    eraseAccountNoticesPage,
    ContentNotFoundError,
    readExactPublishedRulesForAuthoring,
    readBoardPageActionEvidence,
    readExactPublishedRules,
    createRealmHomeBoardObservationReader,
    RealmHomeBoardPageSchema,
    realmHomeBoardResponse,
    RealmHomeBoardQuerySchema,
    exactRealmPresentationImage,
    readRealmPresentationImages,
    claimRealmPresentationMedia,
    RealmMediaImageSchema,
    SitemapQuerySchema,
    ContentIdSchema,
    ContentRealmImageSchema,
    sitemapPageSchema,
    problemSchema,
    IDEMPOTENCY_HEADER,
    idempotencyKeyOf,
    SESSION_HEADER,
    createFollowCommands,
    accessCheck,
    accessCommandAuthorization,
    AuthenticationError,
    prepareReadDecisions,
    subjectReadEligibility,
    SubjectRedirectError,
    withReadTransaction,
    readSubjectReference,
    readItemTypes,
    readSubjectSummaryObservation,
  } = ports);
}
