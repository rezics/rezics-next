import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Row,
} from '../../kernel/test/support/growth.ts';

// Other suites can remove an exited fixture between the shared helper's list and inspect.
// Retry only that cleanup race; database creation, migration and operation failures still fail.
function isolatedDatabase(): ReturnType<typeof testDatabase> {
  for (let attempt = 0; ; attempt++) {
    try {
      return testDatabase();
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof Error) ||
        !/^docker (?:inspect -f|rm -f) /.test(error.message) ||
        !/(?:no such object:|removal of container .* is already in progress)/.test(error.message)
      )
        throw error;
    }
  }
}

const base = 1024;
const fixedFanout = 2;
const repetitions = 3;
const instant = new Date('2026-01-01T00:00:00Z');
const expiry = new Date('2099-01-01T00:00:00Z');
const publicJwk = { kty: 'EC', crv: 'P-256', alg: 'ES256', x: 'fixture-x', y: 'fixture-y' };
const references = [
  ['user', 'id'],
  ['account', 'userId'],
  ['session', 'userId'],
  ['auth_consent', 'account_id'],
  ['auth_public_key', 'account_id'],
  ['auth_key_assertion', 'account_id'],
  ['auth_recovery', 'account_id'],
  ['auth_session_opening', 'subject_account_id'],
] as const;

// One native seed for unrelated owners, measured owners and the separate own-fanout experiment.
// Each owner has a credential, retained consent, and five cascading reference kinds.
function nativeRows(owner: string, fanout: number): Record<string, readonly Row[]> {
  const each = (row: (index: number) => Row) => Array.from({ length: fanout }, (_, index) => row(index));
  return {
    'public.user': [
      {
        id: owner,
        name: '',
        email: `${owner}@example.test`,
        emailVerified: false,
        createdAt: instant,
        updatedAt: instant,
      },
    ],
    'public.auth_client': [{ client_id: owner, first_party: true, scopes: ['read'] }],
    'public.account': [
      {
        id: owner,
        accountId: owner,
        providerId: 'credential',
        userId: owner,
        password: 'native-erasure-fixture-hash',
        createdAt: instant,
        updatedAt: instant,
      },
    ],
    'public.session': each((i) => ({
      id: `${owner}-${i}`,
      token: `${owner}-${i}`,
      userId: owner,
      expiresAt: expiry,
      createdAt: instant,
      updatedAt: instant,
      clientId: owner,
      grantedScope: 'read',
      authnEpoch: 1,
      authTime: 1,
      authMethods: 'pwd',
    })),
    'public.auth_consent': [{ account_id: owner, client_id: owner, scopes: ['read'] }],
    'public.auth_public_key': each((i) => ({ account_id: owner, kid: `key-${i}`, public_jwk: publicJwk })),
    'public.auth_key_assertion': each((i) => ({ account_id: owner, jti: `assertion-${i}`, expires_at: expiry })),
    'public.auth_recovery': each((i) => ({
      proof_hash: `${owner}-${i}`,
      account_id: owner,
      authn_epoch: 1,
      expires_at: expiry,
    })),
    'public.auth_session_opening': each((i) => ({
      session_id: `${owner}-${i}`,
      subject_account_id: owner,
      acting_human_id: 'retained-operator',
      operator_account_id: 'retained-operator',
      receipt_id: `${owner}-${i}`,
      opened_at: instant,
    })),
  };
}

async function retainedRows(db: GrowthDatabase) {
  const tables = [...references, ['auth_client', 'client_id']] as const;
  return Promise.all(
    tables.map(async ([table, column]) => ({
      table,
      // Complete row contents and multiplicity, ordered independently of heap placement.
      ...(
        await db.admin.query(
          `SELECT count(*)::integer AS count, md5(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text)) AS digest FROM "${table}" t WHERE "${column}" LIKE 'other-%'`,
        )
      ).rows[0],
    })),
  );
}

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: PlanNode[];
};
type PlanDocument = { Plan: PlanNode; 'Query Text': string };
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('checkGrowth measures native eraseAccount cascades at 1x/8x/64x with fixed owner references', async () => {
  const fixture = isolatedDatabase();
  let db: GrowthDatabase | undefined;
  try {
    db = await openGrowthDatabase(fixture.url);
    const database = db;
    const key = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(key.privateKey)), kid: 'growth-erasure-signing', alg: 'ES256' };
    const accessReads: string[] = [];
    const service = await createAuthService({
      database: db.pool,
      issuer: 'https://erasure-growth.auth.test',
      audience: 'https://erasure-growth.api.test',
      secret: 'native-erasure-growth-secret-at-least-32-bytes',
      signing: { activeKid: jwk.kid, privateKeys: [jwk] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return this.readAccount(id);
        },
        async readAccount(id) {
          accessReads.push(id);
          return { accountId: id, kind: 'actor', state: 'deleted', fenced: true, automated: false, authnEpoch: 2 };
        },
        async authorizeProvisioning() {
          throw new Error('Not a provisioning experiment');
        },
      }),
    });
    const population = {
      name: 'native-erasure-references',
      hotPartition: 0,
      rows: ({ ordinal }: { ordinal: number }) => nativeRows(`other-${ordinal}`, fixedFanout),
    };
    let retained: Awaited<ReturnType<typeof retainedRows>>;
    const report = await checkGrowth(db, {
      name: 'native account erasure with unrelated owners growing',
      repetitions,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        await seed(current, population, { from: base * previous, to: base * scale });
        await seed(
          current,
          {
            name: 'measured-erasure-owners',
            hotPartition: 0,
            rows: ({ ordinal }) => nativeRows(`measured-${ordinal}`, fixedFanout),
          },
          { from: accessReads.length, to: accessReads.length + repetitions + 1 },
        );
        retained = await retainedRows(current);
        expect(retained.map(({ count }) => count)).toEqual([
          base * scale,
          base * scale,
          base * scale * fixedFanout,
          base * scale,
          base * scale * fixedFanout,
          base * scale * fixedFanout,
          base * scale * fixedFanout,
          base * scale * fixedFanout,
          base * scale,
        ]);
      },
      async operation(current, _scale, repetition) {
        const owner = `measured-${repetition}`;
        const before = accessReads.length;
        await service.internal.eraseAccount(owner);
        expect(accessReads.slice(before)).toEqual([owner]);
        for (const [table, column] of references) {
          expect(
            (
              await current.admin.query(`SELECT count(*)::integer AS count FROM "${table}" WHERE "${column}"=$1`, [
                owner,
              ])
            ).rows,
          ).toEqual([{ count: table === 'auth_consent' ? 1 : 0 }]);
        }
        // Assertions use the plain admin pool and do not enter the measured statement stream.
        expect(await retainedRows(current)).toEqual(retained);
      },
    });
    // Consent has no account foreign key, so the DELETE does not examine it.
    const examined = 2 + 5 * fixedFanout; // owner, credential; sessions/keys/assertions/recovery/openings
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(2);
      expect(cost.controlStatements).toBe(2);
      expect(cost.rows).toBe(examined);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.relations?.['public.auth_consent']).toBeUndefined();
      for (const [table] of references) {
        if (table === 'auth_consent') continue;
        expect(cost.relations?.[`public.${table}`]?.rows).toBe(
          table === 'user' || table === 'account' ? 1 : fixedFanout,
        );
        expect(cost.relations?.[`public.${table}`]?.blocks).toBeGreaterThan(0);
      }
    }
    console.info('Native account erasure, unrelated growth:', JSON.stringify(report.samples));

    // Inspect plans emitted by the actual deletion, including nested RI cascade statements.
    // EXPLAIN of just the top-level DELETE would hide the expensive cascade scans.
    await seed(
      database,
      { name: 'erasure-plan-owner', hotPartition: 0, rows: () => nativeRows('plan-owner', fixedFanout) },
      { from: 0, to: 1 },
    );
    const { capture: raw } = await capture(database, () => service.internal.eraseAccount('plan-owner'));
    expect(raw.statements).toEqual([
      'BEGIN',
      'DELETE FROM "user" WHERE id=$1',
      `INSERT INTO auth_consent_erasure (account_id,due_at)
             VALUES ($1,clock_timestamp()+interval '5 minutes 10 seconds')
             ON CONFLICT (account_id) DO NOTHING`,
      'COMMIT',
    ]);
    const documents = raw.plans as PlanDocument[];
    const schedulePlans = documents.filter((entry) => entry.Plan['Relation Name'] === 'auth_consent_erasure');
    expect(schedulePlans).toHaveLength(1);
    // Owner DELETE plus its FK cascade plans; consent is not one of them.
    expect(documents.filter((entry) => !schedulePlans.includes(entry))).toHaveLength(13);
    for (const [table, column, index] of [
      ['auth_recovery', 'account_id', 'auth_recovery_account_id_idx'],
      ['auth_session_opening', 'subject_account_id', 'auth_session_opening_subject_account_id_idx'],
    ]) {
      const document = documents.find((entry) => entry.Plan['Relation Name'] === table)!;
      expect(document['Query Text']).toContain('DELETE FROM');
      expect(document['Query Text']).toContain(column!);
      const scans = nodes(document.Plan).filter(
        (node) => node['Relation Name'] === table && node['Node Type'] !== 'ModifyTable',
      );
      expect(scans).toHaveLength(1);
      expect(scans[0]!['Node Type']).toMatch(/^(Index Scan|Bitmap Heap Scan)$/);
      expect(nodes(document.Plan).some((node) => node['Index Name'] === index)).toBe(true);
      expect(
        scans.reduce(
          (sum, node) =>
            sum +
            (node['Actual Rows'] +
              (node['Rows Removed by Filter'] ?? 0) +
              (node['Rows Removed by Index Recheck'] ?? 0)) *
              node['Actual Loops'],
          0,
        ),
      ).toBe(fixedFanout);
      expect(scans[0]!['Shared Hit Blocks'] + scans[0]!['Shared Read Blocks']).toBeGreaterThan(0);
    }
    expect(costOf(raw).rows).toBe(examined);

    // Own-account fanout is uncapped. Report its real work separately; index presence
    // does not make cascading thousands of this owner's references constant cost.
    const fanoutCosts = [];
    for (const fanout of [1, 8, 64]) {
      const owner = `fanout-${fanout}`;
      await seed(
        database,
        { name: 'own-erasure-fanout', hotPartition: 0, rows: () => nativeRows(owner, fanout) },
        { from: 0, to: 1 },
      );
      const { capture: fanoutCapture } = await capture(database, () => service.internal.eraseAccount(owner));
      const cost = costOf(fanoutCapture);
      expect(cost.statements).toBe(2);
      expect(cost.controlStatements).toBe(2);
      expect(cost.rows).toBe(2 + 5 * fanout);
      expect(cost.relations['public.auth_consent']).toBeUndefined();
      expect(cost.relations['public.auth_recovery']?.rows).toBe(fanout);
      expect(cost.relations['public.auth_session_opening']?.rows).toBe(fanout);
      fanoutCosts.push({
        fanout,
        references: 1 + 5 * fanout,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      });
    }
    console.info('Native account erasure, own fanout:', JSON.stringify(fanoutCosts));
    expect(await retainedRows(database)).toEqual(retained!);
  } finally {
    await db?.close();
    fixture.close();
  }
}, 240_000);
