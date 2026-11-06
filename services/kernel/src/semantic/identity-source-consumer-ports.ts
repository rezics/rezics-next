import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import type {
  AccountIdentityReversalSettlement,
  AccountIdentitySource,
} from '../access/agent-verification-identity.ts';
import type { IdentityIntent, IdentityNativeReceipt, IdentityReceipt } from './identity-epoch-contract.ts';
import type {
  IdentitySourceConsumerContext,
  IdentitySourceConsumerReference,
} from './identity-source-consumer-custody.ts';

export type IdentitySourceWorkDeclaration = Readonly<{
  work: WorkDimensions;
  engineRequests: 0;
}>;

type AccountReceipt = Exclude<IdentityReceipt, { kind: 'subject.merge' }>;

/** Composition installs the Access, Library and binding bodies. Source never value-imports those owners. */
export type IdentitySourceConsumerRuntime = Readonly<{
  readAccountIdentitySource(
    tx: CommandTransaction,
    receipt: AccountReceipt,
    intent?: IdentityIntent,
    undoOnly?: boolean,
  ): Promise<AccountIdentitySource>;
  originalSourceDeclaration(): IdentitySourceWorkDeclaration;
  reversalSettlementDeclaration(): IdentitySourceWorkDeclaration;
  readAccountIdentityReversalSettlement(
    pool: Pool,
    reference: IdentitySourceConsumerReference,
    context: IdentitySourceConsumerContext,
  ): Promise<AccountIdentityReversalSettlement | null>;
  acceptAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
  ): Promise<IdentityNativeReceipt | null>;
  verifyAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    receiving: IdentityNativeReceipt,
  ): Promise<boolean>;
  bindingConsumerDeclaration(): IdentitySourceWorkDeclaration;
  declareLibraryIdentityCustodyOperation(operation: 'revalidateHold'): IdentitySourceWorkDeclaration;
}>;

let installed: IdentitySourceConsumerRuntime | undefined;

export function bindIdentitySourceConsumerRuntime(runtime: IdentitySourceConsumerRuntime): void {
  installed = runtime;
}

export function identitySourceConsumerRuntime(): IdentitySourceConsumerRuntime {
  if (!installed) throw new TypeError('Identity Source consumer runtime is not installed');
  return installed;
}
