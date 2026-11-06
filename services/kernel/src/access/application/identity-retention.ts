import type { AccessApplicationPorts, RetainIdentityInput } from '../contract/index.ts';
import { identityReceiptKey } from '../core/index.ts';
import { IdentityRecoveryUnavailableError } from './identity-recovery.ts';

export function createIdentityRetention(ports: Pick<AccessApplicationPorts, 'identity' | 'identityRetention'>) {
  return {
    async retainIdentitySource(input: RetainIdentityInput): Promise<boolean> {
      const { pool, receipt, deadline } = input;
      const key = identityReceiptKey(receipt);
      if (!Number.isFinite(deadline) || deadline <= 0) {
        throw new IdentityRecoveryUnavailableError(`identity retention deadline missing for ${key}`);
      }
      const accepted = await ports.identityRetention.acceptTechnicalSource(pool, {
        account: receipt.account,
        direction: receipt.kind,
        receipt: receipt.receipt,
      });
      if (accepted) return true;
      const verified = await ports.identityRetention.verifyTechnicalSource(pool, {
        account: receipt.account,
        direction: receipt.kind,
        receipt: receipt.receipt,
      });
      if (!verified) return false;
      const original = await ports.identityRetention.readAccountIdentityTechnicalSource(pool, {
        account: receipt.account,
        direction: receipt.kind,
        receipt: receipt.receipt,
      });
      if (!original) return false;
      if (ports.identity.verifyOriginalAccountAgentIdentity) {
        const verified = await ports.identity.verifyOriginalAccountAgentIdentity(
          pool,
          { account: receipt.account, direction: receipt.kind, receipt: receipt.receipt },
          original,
        );
        if (!verified) return false;
      }
      return original.account === receipt.account && original.receipt === receipt.receipt;
    },
  };
}
