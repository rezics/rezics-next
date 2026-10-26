import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../../kernel/test/support/growth.ts';

// Both dimensions use this single deterministic seed, with distinct client IDs.
const population = (name: string, client: string, affected: boolean): Population => ({
  name,
  hotPartition: 0,
  rows: ({ ordinal }) => {
    const id = `${name}-${String(ordinal).padStart(8, '0')}`;
    return {
      'public.user': [
        {
          id,
          name: '',
          email: `${id}@example.test`,
          emailVerified: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      'public.auth_consent': [
        { account_id: id, client_id: affected ? client : 'unrelated', scopes: ['read', 'write'] },
      ],
    };
  },
});

test('checkGrowth measures actual path at three scales for unrelated A, affected C, and the complete DBOS workflow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  let workflows: ReturnType<typeof createAccountWorkflows> | undefined;
  let system: Pool | undefined;
  try {
    await db.admin.query('CREATE DATABASE growth_reduction_system');
    const systemUrl = new URL(fixture.url);
    systemUrl.pathname = '/growth_reduction_system';
    system = new Pool({ connectionString: systemUrl.href });
    await db.admin.query(
      'CREATE TABLE growth_floor (key text PRIMARY KEY, account_id text NOT NULL, epoch integer NOT NULL)',
    );
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'growth',
    };
    const auth = await createAuthService({
      database: db.pool,
      issuer: 'https://growth.auth.test',
      audience: 'https://api.growth.test',
      secret: 'growth-reduction-secret-with-at-least-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return this.readAccount(id);
        },
        readAccount: async (accountId) => ({
          accountId,
          kind: 'actor',
          state: 'active',
          automated: false,
          fenced: true,
          authnEpoch: 2,
        }),
        authorizeProvisioning: async () => {
          throw new Error('Unused');
        },
      }),
    });
    for (const clientId of [
      'unrelated',
      'page-a',
      'page-c',
      'total-1',
      'total-8',
      'total-64',
      'warmup-total-1',
      'warmup-total-8',
      'warmup-total-64',
    ])
      await auth.internal.registerClient({ clientId, firstParty: false, scopes: ['read', 'write'] });
    const denied = async (): Promise<never> => {
      throw new Error('Unused');
    };
    const access: AccountWorkflowPorts = {
      registrationTarget: (key) => key,
      reserveHandle: denied,
      createPending: denied,
      claimHandle: denied,
      activate: denied,
      expireRegistration: denied,
      releaseExpiredRegistrationHandle: denied,
      provisioningReference: denied,
      provisioningEvidence: denied,
      authorizeOperation: async () => ({ actor: { accountId: 'admin' } }),
      readAccount: async (accountId) => ({
        accountId,
        handle: null,
        operatorAccountId: null,
        state: 'active',
        fenced: true,
      }),
      async raiseFence({ accountId, key }) {
        const row = (
          await db.pool.query(
            'INSERT INTO growth_floor VALUES ($1,$2,2) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING epoch',
            [key, accountId],
          )
        ).rows[0]!;
        return {
          value: {
            accountId,
            receiptId: `receipt:${key}`,
            minimumAuthnEpoch: String(row.epoch),
            kind: 'fence',
            priorOperatorAccountId: null,
          },
        };
      },
    };
    workflows = createAccountWorkflows({
      database: db.pool,
      systemDatabaseUrl: systemUrl.href,
      stagingKey: randomBytes(32),
      auth,
      access,
    });
    await workflows.start();
    const fixed = population('fixed', 'page-a', true);
    await seed(db, fixed, { from: 0, to: 16 });
    await auth.internal.beginClientReduction({
      clientId: 'page-a',
      operationId: 'page-a-operation',
      scopes: ['read'],
      firstParty: false,
    });
    const a = await checkGrowth(db, {
      name: 'unrelated accounts do not enter an admitted owner page',
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_, scale, previous) => {
        await seed(db, population('accounts', 'unrelated', false), { from: previous * 128, to: scale * 128 });
      },
      operation: async () => {
        const result = await auth.internal.clientReductionPage({
          clientId: 'page-a',
          operationId: 'page-a-operation',
          after: '',
          limit: 8,
        });
        expect(result.items).toHaveLength(8);
        expect(result.items.every((id) => id.startsWith('fixed-'))).toBe(true);
      },
    });
    const c = await checkGrowth(db, {
      name: 'affected consents do not enlarge an admitted owner page',
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_, scale, previous) => {
        // Deployment fixture only: production admission refuses consent additions behind its barrier.
        await seed(db, population('consents', 'page-c', true), { from: previous * 16, to: scale * 16 });
        if (!previous)
          await auth.internal.beginClientReduction({
            clientId: 'page-c',
            operationId: 'page-c-operation',
            scopes: ['read'],
            firstParty: false,
          });
      },
      operation: async () => {
        expect(
          (
            await auth.internal.clientReductionPage({
              clientId: 'page-c',
              operationId: 'page-c-operation',
              after: '',
              limit: 8,
            })
          ).items,
        ).toHaveLength(8);
      },
    });
    const total = await checkGrowth(db, {
      name: 'complete native DBOS fanout is linear in actual affected owners',
      repetitions: 1,
      bounds: { rows: 'linear', blocks: 'linear', statements: 'linear' },
      grow: async (_, scale) => {
        await seed(db, population(`total-${scale}`, `total-${scale}`, true), { from: 0, to: scale * 8 });
        await seed(db, population(`warmup-total-${scale}`, `warmup-total-${scale}`, true), {
          from: 0,
          to: scale * 8,
        });
      },
      operation: async (_, scale) => {
        await workflows!.reduceClientScopes({
          key: `total-${scale}`,
          authorization: 'approved',
          clientId: `total-${scale}`,
          firstParty: false,
          scopes: ['read'],
        });
      },
      async warmup(_, scale) {
        await workflows!.reduceClientScopes({
          key: `warmup-total-${scale}`,
          authorization: 'approved',
          clientId: `warmup-total-${scale}`,
          firstParty: false,
          scopes: ['read'],
        });
      },
    });
    for (const report of [a, c, total]) {
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      expect(
        report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.rows > 0 && sample.cost.blocks > 0),
      ).toBe(true);
    }
    for (const report of [a, c])
      for (const { cost } of report.samples) {
        expect(cost.relations?.['public.user']?.rows ?? cost.relations?.['user']?.rows ?? 0).toBe(0);
        expect(cost.rows).toBeLessThanOrEqual(20);
      }
    expect((await db.admin.query('SELECT count(*)::integer AS n FROM growth_floor')).rows[0].n).toBe(
      2 * (8 + 64 + 512),
    );
    // Each continuation has at most one bounded page of native durable steps.
    const history = (
      await system.query(`SELECT workflow_uuid,count(*)::integer AS n FROM dbos.operation_outputs
      GROUP BY workflow_uuid`)
    ).rows;
    expect(history.length).toBeGreaterThan(3);
    expect(history.every((row) => row.n <= 210)).toBe(true);
    console.info('Client reduction growth:', JSON.stringify([a, c, total]));
  } finally {
    await workflows?.close();
    await system?.end();
    await db.close();
    fixture.close();
  }
}, 180000);
