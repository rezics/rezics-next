import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';

test('deleted-account consent waits for token expiry, erases in a bounded batch, and lets reductions converge', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  const erasedOwners = new Set(['deleted-owner', 'reduction-owner']);
  const accessAccount = async (accountId: string) => ({
    accountId,
    kind: 'actor' as const,
    state: erasedOwners.has(accountId) ? ('deleted' as const) : ('active' as const),
    automated: false,
    fenced: true,
    authnEpoch: 2,
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'consent-erasure-test',
    alg: 'ES256',
  };
  try {
    const auth = await createAuthService({
      database: pool,
      issuer: 'https://consent-erasure.auth.test',
      audience: 'https://api.consent-erasure.test',
      secret: 'consent-erasure-test-secret-with-at-least-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        readAccount: accessAccount,
        readFencedAccount: async (accountId) => (accountId === 'reduction-owner' ? null : accessAccount(accountId)),
        authorizeProvisioning: async () => {
          throw new Error('Not used');
        },
      }),
    });

    await auth.internal.registerClient({
      clientId: 'consent-erasure-test-client',
      firstParty: false,
      scopes: ['read'],
    });
    await auth.internal.registerClient({
      clientId: 'consent-erasure-reduction-client',
      firstParty: false,
      scopes: ['read', 'write'],
    });
    await pool.query(
      `INSERT INTO "user" (id,name,"emailVerified") VALUES
       ('deleted-owner','',false),('live-owner','',false),('reduction-owner','',false)`,
    );
    await pool.query(
      `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES
       ('deleted-owner','consent-erasure-test-client',ARRAY['read']),
       ('live-owner','consent-erasure-test-client',ARRAY['read']),
       ('reduction-owner','consent-erasure-reduction-client',ARRAY['read','write'])`,
    );

    const beforeErasure = (await pool.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
    await auth.internal.eraseAccount('deleted-owner');
    const scheduled = (
      await pool.query<{ due_at: Date }>('SELECT due_at FROM auth_consent_erasure WHERE account_id=$1', [
        'deleted-owner',
      ])
    ).rows[0]!;
    expect(scheduled.due_at.getTime()).toBeGreaterThanOrEqual(beforeErasure.getTime() + 310_000);
    await auth.internal.eraseAccount('deleted-owner');
    expect(
      (
        await pool.query<{ due_at: Date }>('SELECT due_at FROM auth_consent_erasure WHERE account_id=$1', [
          'deleted-owner',
        ])
      ).rows[0]!.due_at.getTime(),
    ).toBe(scheduled.due_at.getTime());
    expect(await auth.internal.hasDueConsentErasure()).toBe(false);
    expect(await auth.internal.eraseDueConsents(100)).toBe(0);
    expect(
      (await pool.query('SELECT account_id FROM auth_consent WHERE account_id=$1', ['deleted-owner'])).rowCount,
    ).toBe(1);

    // A stale schedule is not authority to erase a live account's consent.
    await pool.query(
      `INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ('live-owner',statement_timestamp())`,
    );
    await pool.query('UPDATE auth_consent_erasure SET due_at=statement_timestamp() WHERE account_id=$1', [
      'deleted-owner',
    ]);
    expect(await auth.internal.hasDueConsentErasure()).toBe(true);
    expect(await auth.internal.eraseDueConsents(100)).toBe(2);
    expect(
      (await pool.query('SELECT account_id FROM auth_consent WHERE account_id=$1', ['deleted-owner'])).rowCount,
    ).toBe(0);
    expect((await pool.query('SELECT account_id FROM auth_consent WHERE account_id=$1', ['live-owner'])).rowCount).toBe(
      1,
    );
    expect((await pool.query('SELECT account_id FROM auth_consent_erasure')).rowCount).toBe(0);
    expect(await auth.internal.eraseDueConsents(100)).toBe(0);

    // The owner page is the reduction's first step. Erasure runs before its owner step.
    await auth.internal.beginClientReduction({
      clientId: 'consent-erasure-reduction-client',
      operationId: 'consent-erasure-reduction',
      scopes: ['read'],
      firstParty: false,
    });
    expect(
      await auth.internal.clientReductionPage({
        clientId: 'consent-erasure-reduction-client',
        operationId: 'consent-erasure-reduction',
        after: '',
        limit: 8,
      }),
    ).toEqual({ items: ['reduction-owner'], next: null });
    await auth.internal.eraseAccount('reduction-owner');
    await pool.query('UPDATE auth_consent_erasure SET due_at=statement_timestamp() WHERE account_id=$1', [
      'reduction-owner',
    ]);
    expect(await auth.internal.eraseDueConsents(100)).toBe(1);
    expect(
      (await pool.query('SELECT account_id FROM auth_consent WHERE account_id=$1', ['reduction-owner'])).rowCount,
    ).toBe(0);

    // Access no longer returns the owner and the due marker has been cleared; the absent consent is terminal.
    await auth.internal.completeClientReductionOwner({
      clientId: 'consent-erasure-reduction-client',
      operationId: 'consent-erasure-reduction',
      accountId: 'reduction-owner',
      barrier: { receiptId: '', accountId: 'wrong-owner', minimumAuthnEpoch: 0 },
    });
    await auth.internal.finishClientReduction({
      clientId: 'consent-erasure-reduction-client',
      operationId: 'consent-erasure-reduction',
      scopes: ['read'],
      firstParty: false,
    });
    expect(
      (
        await pool.query<{ scopes: string[] }>('SELECT scopes FROM auth_client WHERE client_id=$1', [
          'consent-erasure-reduction-client',
        ])
      ).rows[0]!.scopes,
    ).toEqual(['read']);
    expect(await auth.internal.eraseDueConsents(100)).toBe(0);
  } finally {
    await pool.end();
    fixture.close();
  }
});
