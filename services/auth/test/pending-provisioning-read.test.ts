import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AccessAccount,
  type AuthServiceOptions,
  type TrustedAccessPorts,
} from '../src/index.ts';

let fixture: ReturnType<typeof testDatabase> | undefined;
let pool: Pool;
let options: Omit<AuthServiceOptions, 'trustedAccess'>;
let sequence = 0;
const pending = (automated = false) => ({
  accountId: `pending-reader-${process.pid}-${++sequence}`,
  kind: 'actor' as const,
  state: 'pending' as const,
  automated,
  fenced: false,
  authnEpoch: 1,
  registrationId: 'private-registration',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  const key = await generateKeyPair('ES256', { extractable: true });
  const privateKey = { ...(await exportJWK(key.privateKey)), kid: 'pending-reader-key', alg: 'ES256' };
  options = {
    database: pool,
    issuer: 'https://pending.auth.test',
    audience: 'https://pending.api.test',
    secret: 'pending-reader-test-secret-at-least-32-bytes',
    signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
  };
});
afterAll(async () => {
  await pool?.end();
  fixture?.close();
});
async function provision(ports: TrustedAccessPorts, automated: boolean) {
  const service = await createAuthService({ ...options, trustedAccess: ports });
  return automated
    ? service.internal.provisionCredentialless({ authorization: 'approved-command' })
    : service.internal.provisionPassword({
        authorization: 'approved-command',
        email: `${++sequence}@pending.test`,
        password: 'correct horse battery staple',
      });
}

test('both operations authorize first and use the dedicated reader exclusively', async () => {
  for (const automated of [false, true]) {
    const account = pending(automated);
    const calls: string[] = [];
    expect(
      await provision(
        trustedAccessPorts({
          async readFencedAccount(id) {
            return this.readAccount(id);
          },
          authorizeProvisioning: async (command) => {
            expect(command).toBe('approved-command');
            calls.push('authorize');
            return { accountId: account.accountId };
          },
          readAccount: async () => {
            throw new Error('ordinary reader must not be used');
          },
          readProvisioningAccount: async (id, command) => {
            expect(calls).toEqual(['authorize']);
            expect(id).toBe(account.accountId);
            expect(command).toBe('approved-command');
            calls.push('read');
            return account;
          },
        }),
        automated,
      ),
    ).toEqual({ accountId: account.accountId });
    expect(calls).toEqual(['authorize', 'read']);
    expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [account.accountId])).rows).toEqual([
      { id: account.accountId },
    ]);
  }
});

test('present reader denial and invalid pending fields never fall back or create an Auth identity', async () => {
  for (const automated of [false, true]) {
    const approved = pending(automated);
    for (const patch of [
      null,
      { accountId: 'wrong-account' },
      { kind: 'organization' },
      { state: 'active' },
      { fenced: true },
      { authnEpoch: 9007199254740992 },
      { authnEpoch: -1 },
      { authnEpoch: 0 },
      { registrationId: '' },
      { registrationId: undefined },
      { expiresAt: undefined },
      { expiresAt: 'invalid' },
      { expiresAt: '2000-01-01' },
      ...(automated ? [{ automated: false }] : []),
    ]) {
      let ordinaryReads = 0;
      await expect(
        provision(
          trustedAccessPorts({
            async readFencedAccount(id) {
              return this.readAccount(id);
            },
            authorizeProvisioning: async () => ({ accountId: approved.accountId }),
            readAccount: async () => {
              ordinaryReads++;
              return approved;
            },
            readProvisioningAccount: async () =>
              patch === null ? null : ({ ...approved, ...patch } as typeof approved),
          }),
          automated,
        ),
      ).rejects.toThrow();
      expect(ordinaryReads).toBe(0);
    }
    expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [approved.accountId])).rows).toHaveLength(0);
    await expect(
      provision(
        trustedAccessPorts({
          async readFencedAccount(id) {
            return this.readAccount(id);
          },
          authorizeProvisioning: async () => {
            throw new Error('unapproved');
          },
          readAccount: async () => {
            throw new Error('no ordinary read');
          },
          readProvisioningAccount: async () => {
            throw new Error('no read before approval');
          },
        }),
        automated,
      ),
    ).rejects.toThrow('unapproved');
  }
});

test('absent optional reader retains strict pending compatibility for isolated trusted fixtures', async () => {
  for (const automated of [false, true]) {
    const { registrationId, expiresAt, ...account }: AccessAccount & { registrationId: string; expiresAt: string } =
      pending(automated);
    const ports: TrustedAccessPorts = trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      authorizeProvisioning: async () => ({ accountId: account.accountId }),
      readAccount: async () => account,
    });
    expect(await provision(ports, automated)).toEqual({ accountId: account.accountId });
    for (const bad of [
      { ...account, accountId: 'different' },
      { ...account, state: 'active' as const },
      { ...account, registrationId: '' },
      { ...account, expiresAt: '2000-01-01' },
    ])
      await expect(provision({ ...ports, readAccount: async () => bad }, automated)).rejects.toThrow();
  }
});
