import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import type { AccessAccount, BarrierReceipt } from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

test('an unconfirmed consent barrier leaves consent, sessions and applied receipts unchanged', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url });
  try {
    const issuer = 'https://confirmation.auth.test';
    const account: AccessAccount = {
      accountId: 'human',
      kind: 'actor',
      state: 'pending',
      authnEpoch: 1,
      automated: false,
    };
    const confirmations: BarrierReceipt[] = [];
    const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'k' };
    const service = await createAuthService({
      database,
      issuer,
      audience: 'https://confirmation.api.test',
      secret: 'confirmation-test-secret-at-least-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        readAccount: async (id) => (id === account.accountId ? account : null),
        authorizeProvisioning: async (accountId) => ({ accountId }),
        async invalidateAccount(input) {
          account.authnEpoch++;
          return { accountId: input.accountId, receiptId: 'unconfirmed', minimumAuthnEpoch: account.authnEpoch };
        },
        async confirmBarrier(input) {
          confirmations.push(input);
          return false;
        },
      }),
    });
    await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read', 'write'] });
    await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
    const password = 'correct horse battery staple';
    await service.internal.provisionPassword({
      authorization: account.accountId,
      email: 'human@example.test',
      password,
    });
    account.state = 'active';
    const request = (path: string, body: unknown, cookie = '') =>
      service.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
    const signin = await request('/signin', {
      account_id: account.accountId,
      password,
      client_id: 'web',
      scope: ['read'],
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] }, cookie)).status).toBe(200);
    const snapshot = async () => ({
      consent: (await database.query('SELECT scopes,revision FROM auth_consent')).rows,
      sessions: (await database.query('SELECT id FROM session ORDER BY id')).rows,
      effects: (await database.query('SELECT * FROM auth_effect_receipt')).rows,
    });
    const before = await snapshot();
    const response = await request('/consent', { client_id: 'external', scope: ['read'] }, cookie);
    expect(response.status).toBe(401);
    expect(confirmations).toEqual([
      {
        accountId: account.accountId,
        purpose: 'consent-reduction',
        operationKey: expect.any(String),
        receiptId: 'unconfirmed',
        minimumAuthnEpoch: 2,
      },
    ]);
    expect(await snapshot()).toEqual(before);
    expect((await database.query('SELECT applied_at FROM auth_barrier_proof')).rows).toEqual([{ applied_at: null }]);
  } finally {
    await database.end();
    fixture.close();
  }
});

test('an unavailable consent barrier confirmation leaves consent, sessions and applied receipts unchanged', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url });
  try {
    const issuer = 'https://confirmation.auth.test';
    const account: AccessAccount = {
      accountId: 'human',
      kind: 'actor',
      state: 'pending',
      authnEpoch: 1,
      automated: false,
    };
    const confirmations: BarrierReceipt[] = [];
    const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'k' };
    const service = await createAuthService({
      database,
      issuer,
      audience: 'https://confirmation.api.test',
      secret: 'confirmation-test-secret-at-least-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        readAccount: async (id) => (id === account.accountId ? account : null),
        authorizeProvisioning: async (accountId) => ({ accountId }),
        async invalidateAccount(input) {
          account.authnEpoch++;
          return { accountId: input.accountId, receiptId: 'unconfirmed', minimumAuthnEpoch: account.authnEpoch };
        },
        async confirmBarrier(input) {
          confirmations.push(input);
          throw new Error('Access unavailable');
        },
      }),
    });
    await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read', 'write'] });
    await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
    const password = 'correct horse battery staple';
    await service.internal.provisionPassword({
      authorization: account.accountId,
      email: 'human@example.test',
      password,
    });
    account.state = 'active';
    const request = (path: string, body: unknown, cookie = '') =>
      service.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
    const signin = await request('/signin', {
      account_id: account.accountId,
      password,
      client_id: 'web',
      scope: ['read'],
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect((await request('/consent', { client_id: 'external', scope: ['read', 'write'] }, cookie)).status).toBe(200);
    const snapshot = async () => ({
      consent: (await database.query('SELECT scopes,revision FROM auth_consent')).rows,
      sessions: (await database.query('SELECT id FROM session ORDER BY id')).rows,
      effects: (await database.query('SELECT * FROM auth_effect_receipt')).rows,
    });
    const before = await snapshot();
    const response = await request('/consent', { client_id: 'external', scope: ['read'] }, cookie);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(confirmations).toEqual([
      {
        accountId: account.accountId,
        purpose: 'consent-reduction',
        operationKey: expect.any(String),
        receiptId: 'unconfirmed',
        minimumAuthnEpoch: 2,
      },
    ]);
    expect(await snapshot()).toEqual(before);
    expect((await database.query('SELECT applied_at FROM auth_barrier_proof')).rows).toEqual([{ applied_at: null }]);
  } finally {
    await database.end();
    fixture.close();
  }
});
