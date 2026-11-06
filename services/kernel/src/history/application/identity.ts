import { historyComposition } from './composition.ts';
import { type HistoryComposition } from '../contract/index.ts';
/** Agent identity source, inventories, retirement, SDK fence, work admission, Work accounting and identity effects. Each facade delegates to the installed native composition; adapters implement them. */

export const declareAgentIdentitySource: HistoryComposition['declareAgentIdentitySource'] = (...args) =>
  historyComposition().declareAgentIdentitySource(...args);

export const commandAgentIdentitySource: HistoryComposition['commandAgentIdentitySource'] = (...args) =>
  historyComposition().commandAgentIdentitySource(...args);

export const beginAgentIdentitySerialization: HistoryComposition['beginAgentIdentitySerialization'] = (...args) =>
  historyComposition().beginAgentIdentitySerialization(...args);

export const releaseAgentIdentitySource: HistoryComposition['releaseAgentIdentitySource'] = (...args) =>
  historyComposition().releaseAgentIdentitySource(...args);

export const recordAgentIdentityWorkSource: HistoryComposition['recordAgentIdentityWorkSource'] = (...args) =>
  historyComposition().recordAgentIdentityWorkSource(...args);

export const lookupAgentIdentityReceivingCopies: HistoryComposition['lookupAgentIdentityReceivingCopies'] = (...args) =>
  historyComposition().lookupAgentIdentityReceivingCopies(...args);

export const readAgentIdentityCopyReceiving: HistoryComposition['readAgentIdentityCopyReceiving'] = (...args) =>
  historyComposition().readAgentIdentityCopyReceiving(...args);

export const readAgentIdentityReceivingArtifact: HistoryComposition['readAgentIdentityReceivingArtifact'] = (...args) =>
  historyComposition().readAgentIdentityReceivingArtifact(...args);

export const readAgentIdentityInventory: HistoryComposition['readAgentIdentityInventory'] = (...args) =>
  historyComposition().readAgentIdentityInventory(...args);

export const verifyAgentIdentityInventory: HistoryComposition['verifyAgentIdentityInventory'] = (...args) =>
  historyComposition().verifyAgentIdentityInventory(...args);

export const readAgentIdentityRecoveryInventory: HistoryComposition['readAgentIdentityRecoveryInventory'] = (...args) =>
  historyComposition().readAgentIdentityRecoveryInventory(...args);

export const readAgentIdentityRecoveryInventoryInTransaction: HistoryComposition['readAgentIdentityRecoveryInventoryInTransaction'] =
  (...args) => historyComposition().readAgentIdentityRecoveryInventoryInTransaction(...args);

export const readAgentIdentityRecoveryArtifactInTransaction: HistoryComposition['readAgentIdentityRecoveryArtifactInTransaction'] =
  (...args) => historyComposition().readAgentIdentityRecoveryArtifactInTransaction(...args);

export const verifyAgentIdentityRecoveryInventory: HistoryComposition['verifyAgentIdentityRecoveryInventory'] = (
  ...args
) => historyComposition().verifyAgentIdentityRecoveryInventory(...args);

export const verifyAgentIdentityRecoveryArtifactReadiness: HistoryComposition['verifyAgentIdentityRecoveryArtifactReadiness'] =
  (...args) => historyComposition().verifyAgentIdentityRecoveryArtifactReadiness(...args);

export const declareAgentIdentityInventory: HistoryComposition['declareAgentIdentityInventory'] = (...args) =>
  historyComposition().declareAgentIdentityInventory(...args);

export const captureAgentIdentityInventory: HistoryComposition['captureAgentIdentityInventory'] = (...args) =>
  historyComposition().captureAgentIdentityInventory(...args);

export const finalizeAgentIdentityInventory: HistoryComposition['finalizeAgentIdentityInventory'] = (...args) =>
  historyComposition().finalizeAgentIdentityInventory(...args);

export const releaseAgentIdentityInventory: HistoryComposition['releaseAgentIdentityInventory'] = (...args) =>
  historyComposition().releaseAgentIdentityInventory(...args);

export const readAgentIdentityInventoryInTransaction: HistoryComposition['readAgentIdentityInventoryInTransaction'] = (
  ...args
) => historyComposition().readAgentIdentityInventoryInTransaction(...args);

export const readAgentIdentityNativeInventory: HistoryComposition['readAgentIdentityNativeInventory'] = (...args) =>
  historyComposition().readAgentIdentityNativeInventory(...args);

export const currentAgentIdentityHistoryUnit: HistoryComposition['currentAgentIdentityHistoryUnit'] = (...args) =>
  historyComposition().currentAgentIdentityHistoryUnit(...args);

export const withAgentIdentityHistoryUnit: HistoryComposition['withAgentIdentityHistoryUnit'] = (...args) =>
  historyComposition().withAgentIdentityHistoryUnit(...args);

export const readAgentIdentityRetirementStage: HistoryComposition['readAgentIdentityRetirementStage'] = (...args) =>
  historyComposition().readAgentIdentityRetirementStage(...args);

export const verifyAgentIdentityRetirementStage: HistoryComposition['verifyAgentIdentityRetirementStage'] = (...args) =>
  historyComposition().verifyAgentIdentityRetirementStage(...args);

export const agentIdentityRetirementReadiness: HistoryComposition['agentIdentityRetirementReadiness'] = (...args) =>
  historyComposition().agentIdentityRetirementReadiness(...args);

export const readAgentIdentitySDKRetirementGap: HistoryComposition['readAgentIdentitySDKRetirementGap'] = (...args) =>
  historyComposition().readAgentIdentitySDKRetirementGap(...args);

export const readAgentIdentitySDKRetirement: HistoryComposition['readAgentIdentitySDKRetirement'] = (...args) =>
  historyComposition().readAgentIdentitySDKRetirement(...args);

export const readAgentIdentitySDKReceivingBinding: HistoryComposition['readAgentIdentitySDKReceivingBinding'] = (
  ...args
) => historyComposition().readAgentIdentitySDKReceivingBinding(...args);

export const readAgentIdentitySDKFence: HistoryComposition['readAgentIdentitySDKFence'] = (...args) =>
  historyComposition().readAgentIdentitySDKFence(...args);

export const retireAgentIdentitySDKWork: HistoryComposition['retireAgentIdentitySDKWork'] = (...args) =>
  historyComposition().retireAgentIdentitySDKWork(...args);

export const readAgentIdentitySDKWriterState: HistoryComposition['readAgentIdentitySDKWriterState'] = (...args) =>
  historyComposition().readAgentIdentitySDKWriterState(...args);

export const lockAgentIdentityReceivingArtifact: HistoryComposition['lockAgentIdentityReceivingArtifact'] = (...args) =>
  historyComposition().lockAgentIdentityReceivingArtifact(...args);

export const enqueueAgentIdentityVerification: HistoryComposition['enqueueAgentIdentityVerification'] = (...args) =>
  historyComposition().enqueueAgentIdentityVerification(...args);

export const enqueueAgentIdentityReversal: HistoryComposition['enqueueAgentIdentityReversal'] = (...args) =>
  historyComposition().enqueueAgentIdentityReversal(...args);

export const associateAgentIdentityWorkSource: HistoryComposition['associateAgentIdentityWorkSource'] = (...args) =>
  historyComposition().associateAgentIdentityWorkSource(...args);

export const verifyAgentIdentityWorkReplay: HistoryComposition['verifyAgentIdentityWorkReplay'] = (...args) =>
  historyComposition().verifyAgentIdentityWorkReplay(...args);

export const readAgentIdentitySourceHandoff: HistoryComposition['readAgentIdentitySourceHandoff'] = (...args) =>
  historyComposition().readAgentIdentitySourceHandoff(...args);

export const bindIdentityOriginalEffect: HistoryComposition['bindIdentityOriginalEffect'] = (...args) =>
  historyComposition().bindIdentityOriginalEffect(...args);

export const isIdentityOriginalEffect: HistoryComposition['isIdentityOriginalEffect'] = (...args) =>
  historyComposition().isIdentityOriginalEffect(...args);

export const requireIdentityFxOriginalDispatch: HistoryComposition['requireIdentityFxOriginalDispatch'] = (...args) =>
  historyComposition().requireIdentityFxOriginalDispatch(...args);

export const associateIdentityFxOriginal: HistoryComposition['associateIdentityFxOriginal'] = (...args) =>
  historyComposition().associateIdentityFxOriginal(...args);

export const identityHistoryCommand: HistoryComposition['identityHistoryCommand'] = (...args) =>
  historyComposition().identityHistoryCommand(...args);

export const reserveIdentityHistoryWork: HistoryComposition['reserveIdentityHistoryWork'] = (...args) =>
  historyComposition().reserveIdentityHistoryWork(...args);

export const nativeWork: HistoryComposition['nativeWork'] = (...args) => historyComposition().nativeWork(...args);

export const addNativeWork: HistoryComposition['addNativeWork'] = (...args) =>
  historyComposition().addNativeWork(...args);

/** Shared accounting marker for the Accounts identity command body, owned by the native adapter. */
export function identityHistoryCommandControl(): HistoryComposition['identityHistoryCommandControl'] {
  return historyComposition().identityHistoryCommandControl;
}

export const withPrepaidAgentIdentityHistoryUnit: HistoryComposition['withPrepaidAgentIdentityHistoryUnit'] = (
  ...args
) => historyComposition().withPrepaidAgentIdentityHistoryUnit(...args);

export const advanceAgentIdentityConsumerMaintenance: HistoryComposition['advanceAgentIdentityConsumerMaintenance'] = (
  ...args
) => historyComposition().advanceAgentIdentityConsumerMaintenance(...args);

export const AGENT_IDENTITY_HISTORY_GUARD_COST: HistoryComposition['AGENT_IDENTITY_HISTORY_GUARD_COST'] = (...args) =>
  historyComposition().AGENT_IDENTITY_HISTORY_GUARD_COST(...args);

export const AGENT_IDENTITY_HISTORY_ABSENCE_COST: HistoryComposition['AGENT_IDENTITY_HISTORY_ABSENCE_COST'] = (
  ...args
) => historyComposition().AGENT_IDENTITY_HISTORY_ABSENCE_COST(...args);

export const lockRecordedAgentIdentityHistory: HistoryComposition['lockRecordedAgentIdentityHistory'] = (...args) =>
  historyComposition().lockRecordedAgentIdentityHistory(...args);

export const identityHistoryConnection: HistoryComposition['identityHistoryConnection'] = (...args) =>
  historyComposition().identityHistoryConnection(...args);

export const unpricedIdentityHistoryWork: HistoryComposition['unpricedIdentityHistoryWork'] = (...args) =>
  historyComposition().unpricedIdentityHistoryWork(...args);

export const identityHistoryAccountsLocalWork: HistoryComposition['identityHistoryAccountsLocalWork'] = (...args) =>
  historyComposition().identityHistoryAccountsLocalWork(...args);

export const resolveAgentIdentitySDKWork: HistoryComposition['resolveAgentIdentitySDKWork'] = (...args) =>
  historyComposition().resolveAgentIdentitySDKWork(...args);

export const assertAgentIdentityHistoryUnit: HistoryComposition['assertAgentIdentityHistoryUnit'] = (...args) =>
  historyComposition().assertAgentIdentityHistoryUnit(...args);

export const assertAgentIdentitySourceHandoff: HistoryComposition['assertAgentIdentitySourceHandoff'] = (...args) =>
  historyComposition().assertAgentIdentitySourceHandoff(...args);
