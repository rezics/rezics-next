import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { AccessAccount, BarrierReceipt } from '@rezics/auth-contract';
import { readAccount } from '../../src/access/account-data.ts';
import { routeOf } from '../../src/route/route.ts';
import { trustedAccessPorts } from './trusted-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const person = '00000000-0000-7000-8000-123400000011';
const fixture: AccessAccount = { accountId: person, kind: 'actor', state: 'active', authnEpoch: 3, automated: false };

beforeEach(async () => {
  await pool.query('DELETE FROM access.account');
  await pool.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(person), person],
  );
});
afterAll(() => pool.end());

test('a stub reads the fenced account from the same fixture as its other reads', async () => {
  const reads: string[] = [];
  const ports = trustedAccessPorts({
    async readAccount(id) {
      reads.push(id);
      return id === person ? fixture : null;
    },
    authorizeProvisioning: async (reference) => ({ accountId: reference }),
  });

  expect(await ports.readFencedAccount(person)).toEqual(fixture);
  expect(await ports.readFencedAccount('00000000-0000-7000-8000-123400000012')).toBeNull();
  expect(reads).toEqual([person, '00000000-0000-7000-8000-123400000012']);
});

test('a stub keeps its own overrides, including its own fenced read', async () => {
  const fenced: AccessAccount = { ...fixture, fenced: true };
  const ports = trustedAccessPorts({
    readAccount: async () => fixture,
    readFencedAccount: async () => fenced,
    authorizeProvisioning: async (reference) => ({ accountId: reference }),
    invalidateAccount: async () => {
      throw new Error('unavailable');
    },
  });

  expect(await ports.readFencedAccount(person)).toBe(fenced);
  expect(await ports.readAccount(person)).toBe(fixture);
  await expect(ports.invalidateAccount?.({ accountId: person, previousEpoch: 3, reason: 'logout' })).rejects.toThrow(
    'unavailable',
  );
});

test('the real binding reads only a fenced account through readFencedAccount', async () => {
  const ports = trustedAccessPorts({ pool });

  expect(await ports.readFencedAccount(person)).toBeNull();
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(person),
    person,
  ]);

  expect(await ports.readFencedAccount(person)).toMatchObject({ accountId: person, fenced: true });
  expect(await ports.readAccount(person)).toBeNull();
  expect(await readAccount(pool, routeOf(person)!, person)).toMatchObject({ fenced: true });
});

test('a stub supplies confirmation and preserves an explicit denial', async () => {
  const receipt = {
    accountId: person,
    purpose: 'recovery' as const,
    operationKey: 'recover-person',
    receiptId: 'receipt',
    minimumAuthnEpoch: 3,
  };
  const stub = {
    readAccount: async () => fixture,
    authorizeProvisioning: async (accountId: string) => ({ accountId }),
  };
  expect(await trustedAccessPorts(stub).confirmBarrier(receipt)).toBe(true);
  const confirmed: BarrierReceipt[] = [];
  const ports = trustedAccessPorts({
    ...stub,
    async confirmBarrier(input) {
      confirmed.push(input);
      return false;
    },
  });
  expect(await ports.confirmBarrier(receipt)).toBe(false);
  expect(confirmed).toEqual([receipt]);
});

test('the real binding forwards confirmation and refuses an uninstalled capability', async () => {
  const receipt: BarrierReceipt = {
    accountId: person,
    purpose: 'recovery',
    operationKey: 'recover-person',
    receiptId: 'receipt',
    minimumAuthnEpoch: 3,
  };
  const confirmed: BarrierReceipt[] = [];
  const ports = trustedAccessPorts({
    pool,
    async confirmBarrier(input) {
      confirmed.push(input);
      return false;
    },
  });
  expect(await ports.confirmBarrier(receipt)).toBe(false);
  expect(confirmed).toEqual([receipt]);
  await expect(trustedAccessPorts({ pool }).confirmBarrier(receipt)).rejects.toThrow(
    'Auth binding capability unavailable: confirmBarrier',
  );
});
