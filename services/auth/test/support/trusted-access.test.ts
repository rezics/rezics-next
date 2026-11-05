import { expect, expectTypeOf, test } from 'bun:test';
import type { AccessAccount, BarrierReceipt, TrustedAccessPorts } from '@rezics/auth-contract';
import { trustedAccessPorts } from './trusted-access.ts';

const account: AccessAccount = { accountId: 'human', kind: 'actor', state: 'active', authnEpoch: 3, automated: false };
const receipt: BarrierReceipt = {
  accountId: account.accountId,
  purpose: 'recovery',
  operationKey: 'recover-human',
  receiptId: 'committed-receipt',
  minimumAuthnEpoch: 3,
};

test('barrier confirmation is a required shared port with an exact receipt input', () => {
  expectTypeOf<TrustedAccessPorts['confirmBarrier']>().toEqualTypeOf<(input: BarrierReceipt) => Promise<boolean>>();
  expectTypeOf<{}>().not.toExtend<Pick<TrustedAccessPorts, 'confirmBarrier'>>();
});

test('a stub supplies all required ports and reads its own account fixture', async () => {
  const reads: string[] = [];
  const ports = trustedAccessPorts({
    async readAccount(id) {
      reads.push(id);
      return id === account.accountId ? account : null;
    },
    authorizeProvisioning: async (accountId) => ({ accountId }),
  });
  expect(await ports.readFencedAccount(account.accountId)).toBe(account);
  expect(await ports.readFencedAccount('absent')).toBeNull();
  expect(reads).toEqual([account.accountId, 'absent']);
  expect(await ports.confirmBarrier(receipt)).toBe(true);
  expect(await ports.authorizeProvisioning('pending')).toEqual({ accountId: 'pending' });
});

test('a stub preserves fenced reads, denied confirmations and optional overrides', async () => {
  const fenced = { ...account, fenced: true };
  const confirmed: BarrierReceipt[] = [];
  const ports = trustedAccessPorts({
    readAccount: async () => account,
    readFencedAccount: async () => fenced,
    authorizeProvisioning: async (accountId) => ({ accountId }),
    async confirmBarrier(input) {
      confirmed.push(input);
      return false;
    },
    invalidateAccount: async () => {
      throw new Error('unavailable');
    },
  });
  expect(await ports.readAccount(account.accountId)).toBe(account);
  expect(await ports.readFencedAccount(account.accountId)).toBe(fenced);
  expect(await ports.confirmBarrier(receipt)).toBe(false);
  expect(confirmed).toEqual([receipt]);
  await expect(
    ports.invalidateAccount!({ accountId: account.accountId, previousEpoch: 2, reason: 'logout' }),
  ).rejects.toThrow('unavailable');
});

test('a passkey fixture retains its required consumer', async () => {
  const consumePasskeyAuthorization = async () => {
    throw new Error('native consumer');
  };
  const ports = trustedAccessPorts({
    passkeys: true,
    consumePasskeyAuthorization,
    readAccount: async () => account,
    authorizeProvisioning: async (accountId) => ({ accountId }),
  });
  expect(ports.passkeys).toBe(true);
  expect(ports.consumePasskeyAuthorization).toBe(consumePasskeyAuthorization);
  expect(await ports.confirmBarrier(receipt)).toBe(true);
});
