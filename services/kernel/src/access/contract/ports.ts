import type {
  AccessActor,
  AccessDeadline,
  AccessDecision,
  AccessIdentityIntent,
  AccessIdentityJobRef,
  AccessIdentityReceipt,
  AccessPool,
  AccessQueryClient,
} from './vocabulary.ts';
import type { AccessWorkDeclaration, AccessWorkDimensions } from './bounds.ts';
import type { CollectionListPolicyOutcome, CollectionPolicyPort } from './collection-policy.ts';

export type AvatarSummary = Readonly<{
  media: string;
  width: number;
  height: number;
  placeholder: Readonly<{ thumbhash: string; color: string }>;
  variants: readonly Readonly<{ format: 'avif' | 'webp'; width: number }>[];
  focalPoint: Readonly<{ x: number; y: number }> | null;
  credit: null;
}>;

export type AvatarMediaPort = {
  checkAvatarMedia(client: AccessQueryClient, mediaId: string, accountId: string): Promise<boolean>;
  readAvatarSummaries(
    client: AccessQueryClient,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, AvatarSummary | null>>;
};

export type LockedRealmClaim = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  orphanedAt: string;
  claimEligibleAt: string;
  requestedAt: string;
}>;

export type RealmClaimApprovalResult = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  state: 'owned';
  orphanedAt: string;
  approvedAt: string;
}>;

export type RealmCommandTransaction = AccessQueryClient & {
  readonly partition?: number;
};

export type RealmAdministrationPort = {
  lockClaimApprovalSource(
    tx: RealmCommandTransaction,
    input: Readonly<{ realmId: string; requestId: string }>,
  ): Promise<LockedRealmClaim | null>;
  applyClaimApproval(tx: RealmCommandTransaction, source: LockedRealmClaim): Promise<RealmClaimApprovalResult>;
  realmReadEligibility?(client: AccessQueryClient, input: Readonly<{ realmId: string; at: string }>): Promise<boolean>;
};

export type AccountIdentityOriginal = Readonly<{
  account: string;
  direction: AccessIdentityReceipt['kind'];
  receipt: string;
  intentDigest: string;
  consumerCustody: string;
  epoch: number;
  digest: string;
  job: AccessIdentityJobRef;
  release: string;
  survivor?: string;
  redirected?: string;
}>;

export type AccessAccountAgentLink = Readonly<{
  account: string;
  route: number;
  subject: string;
  agent_id: string;
  verified: boolean;
  receipt_id: string | null;
}>;

/** Native composition binds mapping from semantic/agents.ts, original recovery, read snapshots, Source custody and maintenance from those public entries. Public subject overlay uses semantic/public-subject-facts.ts; a missing method keeps presentation unavailable. */
export type IdentitySemanticPort = {
  accountAgentId(accountId: string): string;
  accountAgentsForSubjects(
    client: AccessQueryClient,
    subjects: readonly string[],
  ): Promise<ReadonlyMap<string, AccessAccountAgentLink>>;
  readOriginalAccountAgentIdentity(
    pool: AccessPool,
    input: Readonly<{ account: string; direction: AccessIdentityReceipt['kind']; receipt: string }>,
  ): Promise<unknown>;
  verifyOriginalAccountAgentIdentity?(tx: unknown, selection: unknown, result: unknown): Promise<boolean>;
  withReadTransaction<T>(pool: AccessPool, body: (client: AccessQueryClient) => Promise<T>): Promise<T>;
  activeIdentitySourceConsumerMaintenance?(pool: AccessPool): boolean;
  readPublicSubject?(
    client: AccessQueryClient,
    subjectId: string,
  ): Promise<{ id: string; label: string; type: string } | null>;
};

export type IdentityRecoveryStorePort = {
  readVerificationDecision(
    pool: AccessPool,
    receipt: AccessIdentityReceipt,
  ): Promise<{
    readonly request_id: string;
    readonly account_id: string;
    readonly account_kind: 'actor' | 'organization';
    readonly catalogue_subject_id: string;
    readonly requested_by: string;
    readonly transaction_id: string;
  } | null>;
  recoverOriginalSource(
    pool: AccessPool,
    receipt: AccessIdentityReceipt,
    source: AccountIdentityOriginal | null,
    decision: Awaited<ReturnType<IdentityRecoveryStorePort['readVerificationDecision']>>,
    deadline: number,
  ): Promise<void>;
  readReversal(
    pool: AccessPool,
    receipt: AccessIdentityReceipt,
    deadline: number,
  ): Promise<{
    principal_id: string;
    command_kind: string;
    idempotency_key: string;
    request_digest: Uint8Array;
    epoch: number;
    position: string;
    transaction_id: string;
    response: {
      accountId: string;
      receiptId: string;
      requestedBy: string;
      kind: 'released' | 'revoked';
      reason: string | null;
      catalogueSubjectId: string;
      verificationReceiptId: string;
    };
  }>;
  writeRecovery(
    pool: AccessPool,
    input: {
      receipt: AccessIdentityReceipt;
      actorAccountId: string;
      deadline: number;
      intent: AccessIdentityIntent;
      intentDigest: string;
      reversal: Awaited<ReturnType<IdentityRecoveryStorePort['readReversal']>>;
      undo: {
        job: AccessIdentityJobRef;
        source: { digest: string; epoch: number; input: { intent: AccessIdentityIntent } };
      };
    },
  ): Promise<void>;
};

export type IdentityRetentionPort = {
  acceptTechnicalSource(
    pool: AccessPool,
    input: Readonly<{ account: string; direction: AccessIdentityReceipt['kind']; receipt: string }>,
  ): Promise<boolean>;
  verifyTechnicalSource(
    pool: AccessPool,
    input: Readonly<{ account: string; direction: AccessIdentityReceipt['kind']; receipt: string }>,
  ): Promise<boolean>;
  readAccountIdentityTechnicalSource(
    pool: AccessPool,
    input: Readonly<{ account: string; direction: AccessIdentityReceipt['kind']; receipt: string }>,
  ): Promise<AccountIdentityOriginal | null>;
};

export type KindAudienceLocator = {
  readonly route: number;
  readonly collectionId: string;
  readonly preparationId: string;
};

export type KindAudienceLibraryPort = {
  collectionKindPreparationNativeWork?(input: unknown): unknown;
  collectionKindInputWork?(input?: unknown): unknown;
  resolveCollectionKindRawInput?(
    input: Readonly<{ locator: KindAudienceLocator; allowance: { remaining: AccessWorkDimensions } }>,
  ): Promise<{ status: 'resolved' | 'unavailable'; work: AccessWorkDimensions }>;
  resolveCollectionKindRawNative?(tx: unknown, locator: unknown, originId: string, native: unknown): Promise<unknown>;
};

export type OriginalWorkPort = {
  readHistoryOriginalSourceDeclaration(): Promise<AccessWorkDeclaration | null>;
  readHistoryOriginalLibraryDeclaration(): Promise<AccessWorkDeclaration | null>;
};

export type SearchErasurePort = {
  observeAccountErasureSearch?(
    pool: AccessPool,
    input: Readonly<{ accountId: string; at: string }>,
  ): Promise<Readonly<{ observed: boolean }>>;
};

/** Native Access cleanup has finished; the coordinator still tracks shared-history custody separately. */
export type NativeErasureCoordinatorPort = {
  acknowledgeCompletion(pool: AccessPool, accountId: string): Promise<unknown>;
};

export type ResourceAuthorizationFacts = {
  readonly actor: AccessActor;
  readonly action: string;
  readonly resource: { readonly route: number; readonly id: string; readonly eligibility?: unknown };
  readonly partition: number;
  readonly deadline: number;
  readonly attempt: {
    readonly partition: number;
    readonly time: unknown;
    readonly basis: {
      readonly actorAccountId: string | null;
      readonly clientId: string | null;
      readonly requestedBy: string | null;
      readonly principal?: { readonly kind: 'anonymous'; readonly id: string };
    } | null;
  };
};

export type ResourceAuthorizationPort = {
  prepare(
    actor: AccessActor,
    action: string,
    resource: ResourceAuthorizationFacts['resource'],
    deadline: number,
  ): Promise<{ evidence: unknown; expires: number } | null>;
  authorize(
    client: AccessQueryClient,
    actor: AccessActor,
    action: string,
    resource: ResourceAuthorizationFacts['resource'],
    evidence: unknown,
  ): Promise<boolean>;
  validateAnchor(client: AccessQueryClient, time: unknown): Promise<boolean>;
};

export type AccessApplicationPorts = {
  readonly avatar: AvatarMediaPort;
  readonly realm: RealmAdministrationPort;
  readonly identity: IdentitySemanticPort;
  readonly identityStore: IdentityRecoveryStorePort;
  readonly identityRetention: IdentityRetentionPort;
  readonly kindAudience: KindAudienceLibraryPort;
  readonly originalWork: OriginalWorkPort;
  readonly searchErasure?: SearchErasurePort;
  readonly nativeErasure: NativeErasureCoordinatorPort;
  readonly resourceAuthorization?: ResourceAuthorizationPort;
  readonly collectionPolicy?: CollectionPolicyPort;
  readonly clock?: () => Date;
};

export type QualifyAvatarInput = {
  readonly client: AccessQueryClient;
  readonly mediaId: string;
  readonly accountId: string;
};

export type ApproveRealmClaimApplicationInput = {
  readonly actor: AccessActor;
  readonly realmId: string;
  readonly requestId: string;
  readonly deadline: number;
  readonly idempotencyKey: string;
  readonly grantOwner: (
    tx: RealmCommandTransaction,
    realm: { route: number; id: string },
    claimantAccountId: string,
    transactionId: string,
  ) => Promise<void>;
  readonly runCommand: <T>(
    body: (tx: RealmCommandTransaction, command: { transactionId: string }) => Promise<T>,
  ) => Promise<T>;
};

export type RecoverIdentityInput = {
  readonly pool: AccessPool;
  readonly receipt: AccessIdentityReceipt;
  readonly error: unknown;
  readonly deadline: number;
  readonly requestId?: string;
};

export type RetainIdentityInput = {
  readonly pool: AccessPool;
  readonly receipt: AccessIdentityReceipt;
  readonly deadline: number;
};

export type AdmitOriginalWorkInput = {
  readonly local: AccessWorkDimensions;
  readonly transfer?: AccessWorkDimensions;
};

export type DecideAuthorizationInput = ResourceAuthorizationFacts;

export type KindAudiencePlan = {
  readonly shape: {
    readonly members: number;
    readonly groups: number;
    readonly roles: number;
    readonly assignment: boolean;
    readonly scope: boolean;
  };
  readonly overhead: AccessWorkDimensions;
  readonly source: unknown;
};

export type AccessApplication = {
  readonly ports: AccessApplicationPorts;
  qualifyAvatar(input: QualifyAvatarInput): Promise<boolean>;
  readAvatarSummaries(
    client: AccessQueryClient,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, AvatarSummary | null>>;
  approveRealmClaim(input: ApproveRealmClaimApplicationInput): Promise<RealmClaimApprovalResult>;
  recoverIdentitySource(input: RecoverIdentityInput): Promise<boolean>;
  retainIdentitySource(input: RetainIdentityInput): Promise<boolean>;
  planKindAudience(actor: AccessActor, statementBytes: number): KindAudiencePlan;
  resolveKindAudienceRawInput(
    locator: KindAudienceLocator,
    remaining?: AccessWorkDimensions,
  ): Promise<{ status: 'resolved' | 'unavailable'; work: AccessWorkDimensions }>;
  admitOriginalWork(input?: AdmitOriginalWorkInput): Promise<AccessWorkDimensions>;
  readonly originalWorkDeadlineMs: number;
  readonly originalWorkLocalAllowance: AccessWorkDimensions;
  decideAuthorization(facts: DecideAuthorizationInput): AccessDecision;
  authorizeResource(facts: DecideAuthorizationInput): Promise<AccessDecision>;
  specializeCollectionList(access: unknown, fullView: boolean): CollectionListPolicyOutcome;
  collectionAuthorizationPreparation(): AccessWorkDimensions;
};
