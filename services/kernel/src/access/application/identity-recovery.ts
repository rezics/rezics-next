import type {
  AccessApplicationPorts,
  AccessIdentityIntent,
  AccountIdentityOriginal,
  RecoverIdentityInput,
} from '../contract/index.ts';
import { identityReceiptKey, identityRecoveryApplies } from '../core/index.ts';

export class IdentityRecoveryUnavailableError extends Error {
  readonly code = 'identity_epoch_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'IdentityRecoveryUnavailableError';
  }
}

export const ORIGINAL_IDENTITY_SOURCE_REQUIRED =
  'Source identity recovery port#readOriginalAccountAgentIdentity(pool, ' +
  '{account, direction, receipt}): released native original accepted release, intent digest and consumer custody ' +
  '(including the original published undo locator for legacy reversal)';

export function createIdentityRecovery(ports: Pick<AccessApplicationPorts, 'identity' | 'identityStore'>) {
  return {
    async recoverIdentitySource(input: RecoverIdentityInput): Promise<boolean> {
      const { pool, receipt, error, deadline } = input;
      const key = identityReceiptKey(receipt);
      if (!identityRecoveryApplies(error, key)) return false;
      if (!Number.isFinite(deadline) || deadline <= 0) {
        throw new IdentityRecoveryUnavailableError(`identity recovery deadline missing for ${key}`);
      }
      if (ports.identity.activeIdentitySourceConsumerMaintenance?.(pool)) {
        throw new IdentityRecoveryUnavailableError(`identity-history-work-unavailable:${key}`);
      }
      const decision =
        receipt.kind === 'account-agent.verify'
          ? await ports.identityStore.readVerificationDecision(pool, receipt)
          : null;
      const source = (await ports.identity.readOriginalAccountAgentIdentity(pool, {
        account: receipt.account,
        direction: receipt.kind,
        receipt: receipt.receipt,
      })) as AccountIdentityOriginal | null;
      if (decision || source) {
        await ports.identityStore.recoverOriginalSource(pool, receipt, source, decision, deadline);
        return true;
      }
      const reversal = await ports.identityStore.readReversal(pool, receipt, deadline);
      const agentId = ports.identity.accountAgentId(receipt.account);
      if (reversal.response.accountId !== receipt.account || reversal.response.receiptId !== receipt.receipt) {
        throw new IdentityRecoveryUnavailableError(`original reversal custody changed ${key}`);
      }
      const intent: AccessIdentityIntent = {
        kind: 'unmerge',
        original: agentId,
        undoJob: { jobId: reversal.transaction_id, epoch: reversal.epoch },
        verificationReceipt: reversal.response.verificationReceiptId,
        release: reversal.response.catalogueSubjectId,
      };
      await ports.identityStore.writeRecovery(pool, {
        receipt,
        actorAccountId: reversal.principal_id,
        deadline,
        intent,
        intentDigest: `${reversal.epoch}:${reversal.position}:${key}`,
        reversal,
        undo: {
          job: { jobId: reversal.transaction_id, epoch: reversal.epoch },
          source: {
            digest: reversal.transaction_id,
            epoch: reversal.epoch,
            input: { intent },
          },
        },
      });
      return true;
    },
  };
}
