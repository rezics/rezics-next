export { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from './account-agents.ts';
export {
  AccountAgentLabelEditError,
  AccountAgentScopeGrowthError,
  AccountAgentVerificationError,
  AccountAgentWriteDeniedError,
  accountAgentId,
} from './agents.ts';
export type { AgentSelfSource } from './subject.ts';
export { readSemanticLifecycle } from './lifecycle-state.ts';
export { readListPresentationFacts } from './list-presentation.ts';

export { semanticRetention } from './retention.ts';
export type { RetentionPage, RetentionInput } from './retention.ts';
export { prepareRecordPurgeAuthority, readRecordPurgeAuthoritySource, lockRecordPurgeAuthoritySource } from './record-purge-authority.ts';
export type { RecordPurgeReference, RecordPurgeAuthority, RecordPurgeSource } from './record-purge-authority.ts';
export type {
  FacetPopulationRequest, FacetPopulationPage, ReadFacetPopulationPage,
  FacetPopulationSource, FacetPopulationSourceFactory,
} from './facet-population-contract.ts';
export { createFacetPopulationSource } from './facet-population.ts';

export { createIdentitySourceSupportReader } from './identity-source-support.ts';
export type {
  IdentitySourceSupportRequest,
  IdentitySourceSupportRecord,
  IdentitySourceSupportPage,
  IdentitySourceSupportReader,
  IdentitySourceSupportReaderFactory,
} from './identity-source-support-contract.ts';
