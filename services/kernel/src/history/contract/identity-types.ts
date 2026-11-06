import type { AccountReference } from './locator.ts';
import type { AgentIdentitySourceKey } from './identity-vocabulary.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import type { HistoryHandle, HistoryWorkClient } from './transaction.ts';
import type { HistoryReceivingContext, HistoryReceivingReceipt } from './receiving-types.ts';

export type AgentIdentityCopyCursor = Readonly<{
  artifactType: 'command-receipt/v1' | 'outbox-event/v1';
  locator: Uint8Array;
}>;

export type AgentIdentityCopyPage = Readonly<{
  /** Sealed means a current native producer cut exists for every key, independently of this page. */
  state: 'pending' | 'sealed';
  gap: 'agent-identity-original-inventory-unsealed' | null;
  artifact: HistoryArtifact | null;
  cursor: AgentIdentityCopyCursor | null;
}>;

export type AgentIdentityReceipt = Readonly<{
  kind: 'account-agent.verify' | 'account-agent.unverify';
  account: string;
  receipt: string;
}>;

/** Technical native metadata only; neither an accepted Semantic input nor a closure proof. */
export type AgentIdentityWorkSource = Readonly<{
  key: string;
  partition: number;
  epoch: number;
  position: string;
  transactionId: string;
  digest: string;
  release: string;
  workflowId: string;
  accounts: readonly AccountReference[];
}>;

export type AgentIdentitySourceHandoff = Readonly<{
  custodyId: string;
  source: AgentIdentityWorkSource;
  generation: string;
}>;

export type AgentIdentityReceivingLookup =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'associated'; artifact: HistoryArtifact }>;

export const inventoryProof: unique symbol = Symbol('Agent identity native inventory');

export const recoveryInventoryProof: unique symbol = Symbol('Agent identity recovery native inventory');

export type AgentIdentityOriginal = Readonly<{
  key: AgentIdentitySourceKey;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  digest: string;
}>;

/** A portable snapshot of durable native custody. Verification always re-reads its native fences and receipts. */
export type AgentIdentityInventoryProof = Readonly<{
  original: AgentIdentityOriginal;
  generation: string;
  domainGeneration: string;
  receiverEpoch: number;
  cutDigest: string;
  artifacts: readonly HistoryArtifact[];
  readonly [inventoryProof]: true;
}>;

export type AgentIdentityNativeInventory =
  | Readonly<{
      state: 'pending';
      gap: 'agent-identity-original-inventory-unsealed';
      proof: null;
    }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      proof: AgentIdentityInventoryProof;
    }>;

export type AgentIdentityInventoryVerification =
  | Readonly<{
      state: 'pending';
      native: 'pending' | 'verified';
      gap: string;
    }>
  | Readonly<{ state: 'verified'; native: 'verified'; gap: null }>;

export type AgentIdentityRecoveryInventoryProof = Readonly<{
  key: AgentIdentitySourceKey;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  digest: string;
  generation: string;
  domainGeneration: string;
  receiverEpoch: number;
  cutDigest: string;
  artifacts: readonly HistoryArtifact[];
  readonly [recoveryInventoryProof]: true;
}>;

export type AgentIdentityRecoveryInventory =
  | Readonly<{
      state: 'absent';
      gap: null;
      native: 'absent';
      proof: null;
      receipts: readonly [];
    }>
  | Readonly<{
      state: 'pending';
      gap: string;
      native: 'pending' | 'sealed';
      proof: null;
      receipts: readonly [];
    }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      native: 'sealed';
      proof: AgentIdentityRecoveryInventoryProof;
      receipts: readonly HistoryReceivingReceipt[];
    }>;

export type AgentIdentityRecoveryInventoryVerification =
  | Readonly<{ state: 'pending'; native: 'pending' | 'verified'; gap: string }>
  | Readonly<{ state: 'verified'; native: 'verified'; gap: null }>;

export type AgentIdentityRecoveryArtifactInspection =
  | Readonly<{ state: 'absent'; gap: null; proof: null }>
  | Readonly<{ state: 'pending'; gap: string; proof: null }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      proof: AgentIdentityRecoveryInventoryProof;
      artifact: HistoryArtifact;
      recoveryEvent: HistoryArtifact;
    }>;

/** Released foreign staging is not cleanup authority. The receiving owner must verify
 * the original source and its native terminal transfer before settling its obligation. */
export type AgentIdentityRetirementStage = Readonly<{
  handoff: Readonly<{ custodyId: string; source: AgentIdentityWorkSource; generation: string }>;
  reference: HistoryConsumerReference;
  consumer: HistoryHandle | null;
}>;

export type AgentIdentityRetirementResult =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'verified'; gap: null; custodyId: string; workflowId: string }>;

export type AgentIdentitySDKRetirementObservation =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'received'; gap: null; receipt: AgentIdentitySDKRetirementReceipt }>;

export type Pending = Readonly<{ state: 'pending'; gap: string }>;

/** Exact receiving request binding. This is metadata, never cleanup permission. */
export type AgentIdentitySDKReceivingBinding = Readonly<{
  kind: 'access.agent-identity.sdk-retirement/v1';
  custodyId: string;
  workflowId: string;
  requestDigest: string;
  source: AgentIdentityWorkSource;
  receiver: Readonly<{ partition: 0; epoch: number; generation: string; writerVersion: 1 }>;
  barrier: HistoryBarrier;
}>;

export type AgentIdentitySDKReceivingObservation =
  | Pending
  | Readonly<{ state: 'observed'; binding: AgentIdentitySDKReceivingBinding }>;

export type AgentIdentitySDKWriterObservation = Pending | Readonly<{ state: 'observed'; writer: HistoryWriterState }>;

/** First supported consumer receipt binding for Source and original-row minimization.
 * `fence` is the UNMODIFIED SDK receipt. The surrounding binding is Kernel metadata;
 * it supplies no Semantic terminal/undo locator and confers no cleanup authority. */
export type AgentIdentitySDKRetirementReceipt = Readonly<{
  binding: AgentIdentitySDKReceivingBinding;
  sourceGeneration: string;
  fence: HistoryHandle;
}>;

export type AgentIdentitySDKFenceObservation =
  | Pending
  | Readonly<{ state: 'observed'; receipt: AgentIdentitySDKRetirementReceipt }>;

/** Native expected address returned by the original Source producer. It is persisted
 * only after that producer has reconstructed and locked it, and re-resolved by the
 * original native function on every later History transition. */
export type AgentIdentityHistoryAuthority = HistoryHandle;

export type AgentIdentityHistoryReadiness = Readonly<{
  binding: AgentIdentitySDKReceivingBinding;
  writer: HistoryWriterState;
}>;

export type AgentIdentityApprovalCopy = Readonly<{
  requestId: string;
  accountId: string;
  requester: string;
  decider: string;
  catalogueId: string;
  accountKind: string;
  epoch: number;
  position: string;
  transactionId: string;
  receiptKey: string;
  receiptDigest: string;
}>;

export type AgentIdentityWorkAdmission = 'admitted' | 'retired';

export type AgentIdentityRecoveryArtifactReadiness =
  | Readonly<{ state: 'not-recovery' }>
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'ready' }>;

export const IDENTITY_FX_EFFECT = 'agent_verification_reversal';

export const AGENT_IDENTITY_WORK_OWNER = 'access.agent-identity';

/** Semantic terminal custody and the SDK writer fence are separate prerequisites to
 * retiring the retained receiving work. */
export const AGENT_IDENTITY_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.5.3-preview',
  futureWriters: 'native-sdk-fence-requires-source-transfer',
  gap: 'identity-source-terminal-transfer-unavailable',
} as const);

export const IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE = 'identity-source-maintenance-funding-unavailable';

export const IDENTITY_SOURCE_PREPAID_MAINTENANCE_UNAVAILABLE = 'identity-source-prepaid-maintenance-not-installed';

export const MAX_AGENT_IDENTITY_SOURCE_KEYS = 8;

/** A released check or copied SDK receipt cannot authorize native History readiness. */
export const IDENTITY_HISTORY_HANDOFF_UNAVAILABLE = 'identity-source-history-durable-handoff-unavailable';

/** Semantic's consumer reference as History reads it: the receipt, source digest, barrier and native source. */
export type HistoryConsumerReference = Readonly<{
  receipt: AgentIdentityReceipt;
  job: HistoryHandle;
  source: Readonly<{ partition: number; epoch: number; position: bigint; transactionId: string }>;
  sourceDigest: string;
  barrier: HistoryBarrier;
  erasedRole: 'subject' | 'requester' | 'decider';
}>;

/** The SDK writer fields History reads; Work owns the full writer state. */
export type HistoryWriterState = Readonly<{
  workflowID: string;
  generation: string;
  restoreGeneration: string;
  closureID: string | null;
  closedAt: number | null;
}>;

/** A copy page with its verified receiving receipt, as the Accounts receiving owner consumes it. */
export type AgentIdentityReceivingPage = AgentIdentityCopyPage & Readonly<{ receipt: HistoryReceivingReceipt | null }>;

/** The active identity unit a composed History exposes to its owning Access workflow. */
export type AgentIdentityHistoryUnit = Readonly<{
  context: HistoryReceivingContext;
  stage?: AgentIdentityRetirementStage;
  client?: HistoryWorkClient;
  active: boolean;
  prepaid?: HistoryHandle;
}>;

/** The recorded-history lock result: pending, or guarded with the observed SDK writer and retirement receipt. */
export type AgentIdentityLockedHistory =
  | Pending
  | Readonly<{ state: 'guarded'; receipt: AgentIdentitySDKRetirementReceipt; writer: HistoryWriterState }>;

/** Native step work: the bounded row, point, statement and byte amount one Accounts step declares. */
export type NativeStepWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;

/** The accounts-work amounts the native identity owner declares, keyed by step. */
export type IdentityHistoryAccountsLocalWork = Readonly<{
  command: NativeStepWork;
  snapshot: NativeStepWork;
  physicalInspection: NativeStepWork;
  mapping: NativeStepWork;
  receivingBinding: NativeStepWork;
  readiness: NativeStepWork;
  sdkReceiving: NativeStepWork;
  nativeWorkRead: NativeStepWork;
  nativeWrite: NativeStepWork;
  nativePairWrite: NativeStepWork;
  nativeAuthoritySeal: NativeStepWork;
  nativeLocatorWrite: NativeStepWork;
  nativeGuardProbe: NativeStepWork;
  durableReceiving: NativeStepWork;
  releasedDurableReceiving: NativeStepWork;
  receivingInsert: NativeStepWork;
  roleScope: NativeStepWork;
  selectedJob: NativeStepWork;
  selectedBarrier: NativeStepWork;
  selectedProgress: NativeStepWork;
  sdkWriterObservation: NativeStepWork;
  sdkFenceObservation: NativeStepWork;
  sdkWriterLock: NativeStepWork;
  nativeInventory: NativeStepWork;
  recoveryInventory: NativeStepWork;
  recoveryAssociation: NativeStepWork;
  recoveryReceiving: NativeStepWork;
  seal: NativeStepWork;
  nativeGuardLocal: NativeStepWork;
  nativeAbsence: NativeStepWork;
  recordedAuthority: NativeStepWork;
  previousReadiness: NativeStepWork;
  durableReadiness: NativeStepWork;
  sourceMappingSnapshot: NativeStepWork;
  retirementSnapshot: NativeStepWork;
  inventoryReceivingCopy: NativeStepWork;
  sdkObligation: NativeStepWork;
  familyTouch: NativeStepWork;
  workInvalidation: NativeStepWork;
  workWake: NativeStepWork;
  locatorInvalidation: NativeStepWork;
  receivingInvalidation: NativeStepWork;
}>;

/** Eight-axis Accounts History body. Candidate, identity-metadata and witness axes stay zero. */
export type IdentityHistoryWorkDimensions = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  identityMetadataRows: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  bytes: number;
  emptySeeks: number;
}>;

export type IdentityHistoryCommandDispatchPrice = Readonly<{
  work: IdentityHistoryWorkDimensions;
  engineRequests: 0;
}>;

/** Installed Accounts subdeclaration. Reached multiplicities are finite counts, not prose. */
export type IdentityHistoryAccountsDeclaration = Readonly<{
  version: 1;
  interface: 'withPrepaidAgentIdentityHistoryUnit';
  sourceReceiver: 'withPrepaidIdentitySourceConsumerMaintenance';
  axes: readonly [
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
  ];
  engineRequests: 0;
  selectedCommand: Readonly<{
    profile: 'single-no-effect';
    effect: IdentityHistoryCommandDispatchPrice;
    cleanup: IdentityHistoryCommandDispatchPrice;
    total: IdentityHistoryCommandDispatchPrice;
    components: Readonly<Record<string, IdentityHistoryCommandDispatchPrice>>;
  }>;
  selectedCommandCalls: Readonly<{
    retirement: number;
    physicalMinimization: number;
    physicalFenceReceiving: number;
    selectedContinuation: number;
  }>;
  local: Readonly<Record<string, IdentityHistoryWorkDimensions>>;
  sdk: Readonly<Record<string, IdentityHistoryWorkDimensions>>;
  multiplicities: Readonly<Record<string, number>>;
  missingTerms: readonly string[];
}>;

/** The inventory read as the native owner returns it: the sealed snapshot, or its receiving verdict. */
export type AgentIdentityInventoryRead =
  | AgentIdentityNativeInventory
  | Readonly<{ state: 'received'; native: 'verified'; gap: null; proof: AgentIdentityInventoryProof }>
  | Readonly<{ state: 'pending'; native: 'sealed'; gap: string; proof: AgentIdentityInventoryProof }>;
