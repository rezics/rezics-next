/**
 * The contract entry: the single public surface for this module.
 */
export {
  ACCOUNT_ROLES,
  ACCOUNT_ROLE_BITS,
  ALL_ACCOUNT_ROLES,
  EVENT_CLASSIFICATIONS,
  HISTORY_ARTIFACTS,
  ZONE_HISTORY_EVENT_TYPES,
  ZONE_HISTORY_RECEIPT_KINDS,
  assertEventClassifications,
  classifyEvent,
  decodeRoles,
  encodeRoles,
  historyArtifact,
  validateRoleMask,
} from './contracts.ts';
export type {
  AccountRole,
  EventClassification,
  HistoryArtifactType,
  HistoryReceivingDiscriminant,
  ZoneHistoryCleanupBinding,
  ZoneHistoryEventType,
  ZoneHistoryReceiptKind,
} from './contracts.ts';
export { HistorySealedError, IdentityHistoryWorkUnavailable, OperationalWorkUnavailable } from './errors.ts';
export {
  AGENT_IDENTITY_SDK_RETIREMENT,
  AGENT_IDENTITY_WORK_OWNER,
  IDENTITY_FX_EFFECT,
  IDENTITY_HISTORY_HANDOFF_UNAVAILABLE,
  IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE,
  IDENTITY_SOURCE_PREPAID_MAINTENANCE_UNAVAILABLE,
  MAX_AGENT_IDENTITY_SOURCE_KEYS,
  inventoryProof,
  recoveryInventoryProof,
} from './identity-types.ts';
export type {
  AgentIdentityApprovalCopy,
  AgentIdentityCopyCursor,
  AgentIdentityCopyPage,
  AgentIdentityHistoryAuthority,
  AgentIdentityHistoryReadiness,
  AgentIdentityHistoryUnit,
  AgentIdentityInventoryProof,
  AgentIdentityInventoryRead,
  AgentIdentityInventoryVerification,
  AgentIdentityLockedHistory,
  AgentIdentityNativeInventory,
  AgentIdentityOriginal,
  AgentIdentityReceipt,
  AgentIdentityReceivingLookup,
  AgentIdentityReceivingPage,
  AgentIdentityRecoveryArtifactInspection,
  AgentIdentityRecoveryArtifactReadiness,
  AgentIdentityRecoveryInventory,
  AgentIdentityRecoveryInventoryProof,
  AgentIdentityRecoveryInventoryVerification,
  AgentIdentityRetirementResult,
  AgentIdentityRetirementStage,
  AgentIdentitySDKFenceObservation,
  AgentIdentitySDKReceivingBinding,
  AgentIdentitySDKReceivingObservation,
  AgentIdentitySDKRetirementObservation,
  AgentIdentitySDKRetirementReceipt,
  AgentIdentitySDKWriterObservation,
  AgentIdentitySourceHandoff,
  AgentIdentityWorkAdmission,
  AgentIdentityWorkSource,
  HistoryConsumerReference,
  HistoryWriterState,
  IdentityHistoryAccountsLocalWork,
  NativeStepWork,
  Pending,
} from './identity-types.ts';
export {
  agentIdentityAccounts,
  agentIdentitySourceKey,
  agentIdentityWorkLocator,
  agentIdentityWorkSourceKey,
} from './identity-vocabulary.ts';
export type { AgentIdentitySourceKey } from './identity-vocabulary.ts';
export {
  MAX_LOCATOR_BYTES,
  MAX_SCOPE_ACCOUNTS,
  decodeLocator,
  encodeLocator,
  validateLocator,
  validateScope,
} from './locator.ts';
export type { AccountReference, HistoryLocator, HistoryScope } from './locator.ts';
export type {
  CommittedOperationalWork,
  OperationalEpisode,
  OperationalMembersBinding,
  OperationalWorkDomain,
  OperationalWorkPhase,
  OperationalWorkRegistration,
  OperationalWorkStamp,
  OperationalWorkTransfer,
  SelectedEpisode,
  SelectedLocator,
  SelectedOutcome,
} from './operational-types.ts';
export type { HistoryComposition, HistoryExecutionPort, HistoryWorkModule } from './ports.ts';
export type {
  HistoryOwnerCoverage,
  HistoryOwnerCoverageResult,
  HistoryReceivingContext,
  HistoryReceivingDependencies,
  HistoryReceivingReceipt,
  ZoneHistoryConsumerObservation,
} from './receiving-types.ts';
export type { RecordHistoryPurgeResult, SharedHistoryResult } from './record-types.ts';
export {
  COMMAND_HISTORY_KINDS,
  preferenceSubjectScope,
  recordHistorySourceKey,
  unionHistoryScope,
} from './record-vocabulary.ts';
export type { CommandHistoryKind, CommandHistoryScopes, RecordHistorySourceReference } from './record-vocabulary.ts';
export { HISTORY_PRODUCER_FAMILIES, HistoryRegistry, nativeHistoryProducerFamily } from './registry.ts';
export type {
  HistoryArtifact,
  HistoryBarrier,
  HistoryFamilyDefinition,
  HistoryFamilySource,
  HistoryOwner,
  HistoryProducerFamily,
  HistoryReadiness,
} from './registry.ts';
export type {
  HistoryCallback,
  HistoryHandle,
  HistoryPool,
  HistoryTransaction,
  HistoryWorkClient,
  HistoryWorkContext,
} from './transaction.ts';
