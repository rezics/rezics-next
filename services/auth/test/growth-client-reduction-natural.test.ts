import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService } from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Capture,
  type GrowthDatabase,
  type Population,
} from '../../kernel/test/support/growth.ts';

const P = 8;
const idAt = (prefix: string, ordinal: number) => `${prefix}-${String(ordinal).padStart(8, '0')}`;
const owners = (name: string, client: string, sessions = false): Population => ({
  name,
  hotPartition: 0,
  rows: ({ ordinal }) => {
    const id = idAt(name, ordinal);
    return {
      'public.user': [{ id, name: '', emailVerified: false }],
      'public.auth_consent': [{ account_id: id, client_id: client, scopes: ['read', 'write'] }],
      ...(sessions
        ? {
            'public.session': [
              {
                id,
                token: id,
                userId: id,
                clientId: client,
                grantedScope: 'read',
                authnEpoch: 1,
                authTime: 1,
                authMethods: 'pwd',
                expiresAt: new Date('2099-01-01'),
                updatedAt: new Date(0),
              },
            ],
          }
        : {}),
    };
  },
});

async function service(db: GrowthDatabase) {
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'natural',
  };
  return createAuthService({
    database: db.pool,
    issuer: 'https://natural.auth.test',
    audience: 'https://api.natural.test',
    secret: 'natural-reduction-secret-at-least-32-bytes',
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
}
const reduction = (clientId: string) => ({
  clientId,
  operationId: `operation:${clientId}`,
  firstParty: false,
  scopes: ['read'],
});
function natural(raw: Capture) {
  expect(raw.statements.some((sql) => /\b(?:SET|set_config)\b.*\benable_/is.test(sql))).toBe(false);
  expect(raw.statements.some((sql) => /^\s*EXPLAIN\b/i.test(sql))).toBe(false);
  expect(raw.plans.length).toBeGreaterThan(0);
}
async function page(auth: AuthService, clientId: string) {
  const input = reduction(clientId);
  const result = await auth.internal.clientReductionPage({ ...input, after: '', limit: P });
  expect(result.items).toEqual(Array.from({ length: P }, (_, n) => idAt(clientId, n)));
  for (const accountId of result.items) {
    const barrier = { accountId, receiptId: `floor:${accountId}`, minimumAuthnEpoch: 2 };
    await auth.internal.revokeSessions(accountId, { boundedCleanup: true, barrier });
    await auth.internal.completeClientReductionOwner({ ...input, accountId, barrier });
  }
  return result;
}

// Validate the cost of real native SQL on an empty heap. A zero-work Seq Scan is legal;
// rows removed by filters and all shared blocks still count in every populated fixture.
test('empty relations cost zero touched rows rather than failing on plan node name', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const auth = await service(db);
    await auth.internal.registerClient({ clientId: 'empty', firstParty: true, scopes: ['read', 'write'] });
    await db.admin.query('ANALYZE');
    const { capture: raw } = await capture(db, async () => {
      const input = reduction('empty');
      await auth.internal.beginClientReduction(input);
      expect(await auth.internal.clientReductionPage({ ...input, after: '', limit: P })).toEqual({
        items: [],
        next: null,
      });
      await auth.internal.revokeSessions('absent-owner', {
        boundedCleanup: true,
        barrier: { accountId: 'absent-owner', receiptId: 'empty-floor', minimumAuthnEpoch: 2 },
      });
      await auth.internal.finishClientReduction(input);
    });
    natural(raw);
    const session = costOf(raw).relations['public.session'];
    expect(session).toBeDefined();
    expect(session!.rows).toBe(0);
    expect(session!.blocks).toBe(0);
    expect(costOf(raw).relations['public.auth_consent']!.rows).toBe(0);
    expect(costOf(raw).relations['public.auth_consent']!.blocks).toBe(0);
  } finally {
    await db.close();
    fixture.close();
  }
}, 60000);

test('three scale native growth remains within derived affected-owner bound', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const auth = await service(db);
    await auth.internal.registerClient({ clientId: 'unrelated', firstParty: false, scopes: ['read', 'write'] });
    await seed(db, owners('history-owner', 'unrelated'), { from: 0, to: 1024 });
    // History has distinct clients/operations/receipts and owners; it never all belongs to the target.
    const history: Population = {
      name: 'history',
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = idAt('history', ordinal);
        const accountId = idAt('history-owner', ordinal % 1024);
        return {
          'public.auth_client': [{ client_id: id, first_party: false, scopes: ['read', 'write'] }],
          'public.auth_client_coverage': [{ client_id: id, ready: true }],
          'public.auth_client_reduction_progress': [
            {
              operation_id: id,
              client_id: id,
              scopes: ['read'],
              first_party: false,
              completed: true,
            },
          ],
          'public.auth_client_reduction': [
            {
              client_id: id,
              operation_id: id,
              scopes: ['read'],
              first_party: false,
            },
          ],
          'public.auth_effect_receipt': [
            {
              receipt_id: id,
              account_id: accountId,
              purpose: 'client-reduction',
              minimum_authn_epoch: 2,
            },
          ],
          'public.session': [
            {
              id,
              token: id,
              userId: accountId,
              clientId: id,
              grantedScope: 'read',
              authnEpoch: 1,
              authTime: 1,
              authMethods: 'pwd',
              expiresAt: new Date('2000-01-01'),
              updatedAt: new Date(0),
            },
          ],
        };
      },
    };
    // Start with a populated indexed neighborhood for all exact probes, then grow each dimension independently.
    await seed(db, history, { from: 0, to: 1024 });
    const unrelated = () =>
      db.admin
        .query(`
      SELECT relation, fingerprint FROM (
      SELECT 'consent' AS relation, md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY account_id),'')) AS fingerprint
      FROM auth_consent t WHERE client_id='unrelated'
      UNION ALL SELECT 'session', md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),''))
      FROM session t WHERE id ~ '^history-[0-9]{8}$'
      UNION ALL SELECT 'receipt', md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY receipt_id),''))
      FROM auth_effect_receipt t WHERE receipt_id LIKE 'history-%'
      UNION ALL SELECT 'progress', md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY operation_id),''))
      FROM auth_client_reduction_progress t WHERE operation_id LIKE 'history-%'
      ) fingerprints ORDER BY relation, fingerprint
    `)
        .then((result) => result.rows);
    let before: Awaited<ReturnType<typeof unrelated>>;
    for (const dimension of ['accounts', 'history', 'affected'] as const) {
      const report = await checkGrowth(db, {
        name: `natural reduction against ${dimension}`,
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          if (dimension === 'accounts')
            await seed(db, owners('unrelated-account', 'unrelated'), { from: previous * 128, to: scale * 128 });
          if (dimension === 'history')
            await seed(db, history, { from: Math.max(1024, previous * 1024), to: scale * 1024 });
          const clientId = `${dimension}-${scale}`;
          const warmupId = `warmup-${clientId}`;
          await auth.internal.registerClient({ clientId, firstParty: true, scopes: ['read', 'write'] });
          await auth.internal.registerClient({ clientId: warmupId, firstParty: true, scopes: ['read', 'write'] });
          await seed(db, owners(clientId, clientId, true), { from: 0, to: dimension === 'affected' ? scale * 16 : P });
          await seed(db, owners(warmupId, warmupId, true), { from: 0, to: dimension === 'affected' ? scale * 16 : P });
          // Ordinary ANALYZE at every scale, including newly inserted target rows. No statistics overrides.
          await db.admin.query('ANALYZE');
          before = await unrelated();
        },
        async operation(_, scale) {
          await reduce(`${dimension}-${scale}`);
        },
        async warmup(_, scale) {
          await reduce(`warmup-${dimension}-${scale}`);
        },
      });
      async function reduce(clientId: string) {
        const input = reduction(clientId);
        await auth.internal.beginClientReduction(input);
        const result = await page(auth, clientId);
        if (dimension === 'affected') {
          expect(result.next).toBe(
            (
              await db.admin.query('SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 AND account_id=$2', [
                clientId,
                idAt(clientId, P - 1),
              ])
            ).rows[0].traversal_ordinal,
          );
          await expect(auth.internal.finishClientReduction(input)).rejects.toThrow();
        } else {
          expect(result.next).toBeNull();
          await auth.internal.finishClientReduction(input);
          // Durable replay stays bounded and retains the committed terminal cursor.
          await auth.internal.finishClientReduction(input);
        }
        expect(
          (
            await db.admin.query(
              'SELECT count(*)::integer AS n FROM auth_effect_receipt WHERE receipt_id=ANY($1::text[])',
              [result.items.map((id) => `floor:${id}`)],
            )
          ).rows[0].n,
        ).toBe(P);
        expect(
          (
            await db.admin.query('SELECT count(*)::integer AS n FROM session WHERE "userId"=ANY($1::text[])', [
              result.items,
            ])
          ).rows[0].n,
        ).toBe(0);
        const saved = (
          await db.admin.query(
            'SELECT completed,after_ordinal FROM auth_client_reduction_progress WHERE operation_id=$1',
            [input.operationId],
          )
        ).rows[0];
        const ordinal = (
          await db.admin.query('SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 AND account_id=$2', [
            clientId,
            idAt(clientId, P - 1),
          ])
        ).rows[0].traversal_ordinal;
        expect(saved).toEqual({ completed: dimension !== 'affected', after_ordinal: ordinal });
        expect(await unrelated()).toEqual(before);
      }
      console.info('Natural dimension:', JSON.stringify(report));
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        // Begin/page/finish: fixed exact probes. Each of P owners adds one receipt,
        // one bounded session cleanup and one exact next-owner/cursor acknowledgement.
        expect(cost.rows).toBeLessThanOrEqual(24 + 16 * P);
        expect(cost.statements).toBeLessThanOrEqual(24 + 12 * P);
        expect(cost.relations?.['public.user']?.rows ?? 0).toBe(0);
        expect(cost.relations?.['public.session']?.rows).toBe(2 * P);
      }
    }
    // All unrelated account/consent, session, receipt and progress history survives byte for byte.
    expect(
      (await db.admin.query(`SELECT count(*)::integer AS n FROM auth_consent WHERE client_id='unrelated'`)).rows[0].n,
    ).toBe(1024 + 8192);
    expect(
      (await db.admin.query(`SELECT count(*)::integer AS n FROM session WHERE id LIKE 'history-%'`)).rows[0].n,
    ).toBe(65536);
    expect(
      (await db.admin.query(`SELECT count(*)::integer AS n FROM auth_effect_receipt WHERE receipt_id LIKE 'history-%'`))
        .rows[0].n,
    ).toBe(65536);
    expect(
      (
        await db.admin.query(
          `SELECT count(*)::integer AS n FROM auth_client_reduction_progress WHERE operation_id LIKE 'history-%' AND completed`,
        )
      ).rows[0].n,
    ).toBe(65536);
  } finally {
    await db.close();
    fixture.close();
  }
}, 180000);
