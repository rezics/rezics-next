/**
 * The native adapter barrel: the only adapter entry the process composition imports.
 */
export {
  identityHistoryCommand,
  reserveIdentityHistoryWork,
  nativeWork,
  addNativeWork,
  IDENTITY_HISTORY_COMMAND_CONTROL,
  identityHistoryConnection,
  unpricedIdentityHistoryWork,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
} from './agent-identity-inventory-work.ts';
export {
  readAgentIdentityInventory,
  verifyAgentIdentityInventory,
  readAgentIdentityRecoveryInventory,
  readAgentIdentityRecoveryInventoryInTransaction,
  readAgentIdentityRecoveryArtifactInTransaction,
  verifyAgentIdentityRecoveryInventory,
  declareAgentIdentityInventory,
  captureAgentIdentityInventory,
  finalizeAgentIdentityInventory,
  releaseAgentIdentityInventory,
  readAgentIdentityInventoryInTransaction,
  readAgentIdentityNativeInventory,
} from './agent-identity-inventory.ts';
export { verifyAgentIdentityRecoveryArtifactReadiness } from './agent-identity-recovery-receiving.ts';
export {
  currentAgentIdentityHistoryUnit,
  withAgentIdentityHistoryUnit,
  readAgentIdentityRetirementStage,
  verifyAgentIdentityRetirementStage,
  agentIdentityRetirementReadiness,
  readAgentIdentitySDKRetirementGap,
  readAgentIdentitySDKRetirement,
  withPrepaidAgentIdentityHistoryUnit,
  advanceAgentIdentityConsumerMaintenance,
  assertAgentIdentityHistoryUnit,
} from './agent-identity-retirement.ts';
export {
  readAgentIdentityReceivingArtifact,
  readAgentIdentitySDKReceivingBinding,
  readAgentIdentitySDKFence,
  retireAgentIdentitySDKWork,
  readAgentIdentitySDKWriterState,
  lockAgentIdentityReceivingArtifact,
  AGENT_IDENTITY_HISTORY_GUARD_COST,
  AGENT_IDENTITY_HISTORY_ABSENCE_COST,
  lockRecordedAgentIdentityHistory,
} from './agent-identity-sdk-fence.ts';
export {
  declareAgentIdentitySource,
  commandAgentIdentitySource,
  beginAgentIdentitySerialization,
  releaseAgentIdentitySource,
  recordAgentIdentityWorkSource,
  lookupAgentIdentityReceivingCopies,
  readAgentIdentityCopyReceiving,
  readAgentIdentitySourceHandoff,
  assertAgentIdentitySourceHandoff,
} from './agent-identity-source.ts';
export {
  enqueueAgentIdentityVerification,
  enqueueAgentIdentityReversal,
  associateAgentIdentityWorkSource,
  verifyAgentIdentityWorkReplay,
  resolveAgentIdentitySDKWork,
} from './agent-identity-work.ts';
export { guardHistoryAccounts } from './gates.ts';
export {
  bindIdentityOriginalEffect,
  isIdentityOriginalEffect,
  requireIdentityFxOriginalDispatch,
  associateIdentityFxOriginal,
} from './identity-original-association.ts';
export { receiveOperationalWorkDestination } from './operational-work-receiving.ts';
export { associateSelectedEpisode, finishSelectedEpisode } from './operational-work-selected.ts';
export {
  historyExecutionPort,
  registerPositionedOperationalHistoryWork,
  reserveOperationalWorkTransfer,
} from './operational-work.ts';
export {
  readHistoryOwnerCoverage,
  verifyHistoryReceivingReceipt,
  recordHistoryReceivingProof,
  historyDeadline,
  lockHistoryBarrier,
  historyReceivingGap,
  readHistoryReceivingReceipt,
  verifyCurrentHistoryReceiving,
} from './receiving.ts';
export { prepareRecordHistoryPurge, minimizeRecordHistoryPurge } from './record-purge.ts';
export {
  hasCommandRecordSourceSet,
  finalizeCommandRecordSourceSet,
  releaseCommandRecordSourceSet,
  recordCommandRecordSourceSetCopy,
} from './record-source-set.ts';
export {
  beginRecordHistorySerialization,
  commandRecordSources,
  declareCommandRecordSources,
  declareCommandRecordSourceSet,
  finalizeCommandRecordSources,
  releaseCommandRecordSources,
  recordRecordHistoryCopy,
} from './record-source.ts';
export {
  declareCommandHistory,
  bindCommandHistoryEvidence,
  commandHistoryIdentityAccounts,
  validateCommandHistory,
  validateCommandHistoryScope,
  recordCommandHistory,
  releaseCommandHistory,
  recordDurableWorkLocator,
  commandHistoryKind,
} from './record.ts';
export { sharedHistoryWorkModule as localSharedHistoryWorkModule } from './shared-history-work.ts';
export { admitSharedHistory, advanceSharedHistory, redriveSharedHistory } from './shared-history.ts';
export { sharedHistoryWorkModule, advanceSelectedHistoryOriginal, advanceOutstandingRecordHistory } from './work.ts';
