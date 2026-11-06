/** Access-owned Semantic capabilities. Imported only through this public entry. */
export { accountAgentId } from './agents.ts';
export {
  readOriginalAccountAgentIdentity,
  verifyOriginalAccountAgentIdentity,
  type OriginalAccountAgentIdentity,
  type OriginalAccountAgentIdentitySelection,
} from './account-agent-identity-recovery.ts';
export { withReadTransaction } from './read.ts';
export { activeIdentitySourceConsumerMaintenance } from './identity-source-consumer-maintenance.ts';
export type { IdentitySourceConsumerMaintenanceContext } from './identity-source-consumer-maintenance.ts';
export { IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION } from './identity-source-consumer-custody.ts';
export { IdentityEpochStoreError } from './identity-adapters/index.ts';
