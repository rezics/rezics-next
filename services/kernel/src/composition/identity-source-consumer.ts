import {
  ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION,
  ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION,
  acceptAccountIdentityTechnicalSource,
  readAccountIdentityReversalSettlement,
  readAccountIdentitySource,
  verifyAccountIdentityTechnicalSource,
} from '../access/agent-verification-identity.ts';
import { declareLibraryIdentityCustodyOperation } from '../library/identity-original-work.ts';
import { IDENTITY_SOURCE_BINDING_CONSUMER_DECLARATION } from '../semantic/identity-adapters/identity-epoch-binding.ts';
import { bindIdentitySourceConsumerRuntime } from '../semantic/identity-source-consumer-ports.ts';

/** Bind Access reader/reversal, Library hold and Semantic binding declarations to Source. */
export function installIdentitySourceConsumerRuntime(): void {
  bindIdentitySourceConsumerRuntime(
    Object.freeze({
      readAccountIdentitySource,
      originalSourceDeclaration: ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION,
      reversalSettlementDeclaration: ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION,
      readAccountIdentityReversalSettlement,
      acceptAccountIdentityTechnicalSource,
      verifyAccountIdentityTechnicalSource,
      bindingConsumerDeclaration: IDENTITY_SOURCE_BINDING_CONSUMER_DECLARATION,
      declareLibraryIdentityCustodyOperation: (operation: 'revalidateHold') =>
        declareLibraryIdentityCustodyOperation(operation),
    }),
  );
}
