import { trustedAccessPorts } from './support/trusted-access.ts';
import { consumableGrowth } from './support/consumable-growth.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  createProvisioningEvidenceVerifier,
  type AccessAccount,
  type AuthService,
  type ProvisioningAuthorization,
  type ProvisioningEvidenceReference,
} from '../src/index.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../kernel/test/support/growth.ts';

let fixture: ReturnType<typeof testDatabase>;
let db: GrowthDatabase;
let service: AuthService;
let verifier: ReturnType<typeof createProvisioningEvidenceVerifier>;
let reference: ProvisioningEvidenceReference;
const accounts = new Map<string, AccessAccount>();
const approvals = new Map<string, ProvisioningAuthorization>();
const password = 'native provisioning growth password';
function pending(id: string, automated = false) {
  accounts.set(id, { accountId: id, kind: 'actor', state: 'pending', automated, authnEpoch: 23 });
  approvals.set(id, {
    accountId: id,
    receipt: {
      registrationId: 'hot-registration',
      reservationId: 'hot-reservation',
      authnEpoch: 23,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
}
function input(id: string) {
  return { authorization: id, email: `${id}@example.test`, password, idempotencyKey: `receipt-${id}` };
}
beforeAll(async () => {
  fixture = testDatabase();
  db = await openGrowthDatabase(fixture.url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'provisioning-growth', alg: 'ES256' };
  signingKeys = { activeKid: key.kid, privateKeys: [key] };
  service = await createAuthService({
    database: db.pool,
    issuer: 'https://growth.provisioning.test',
    audience: 'https://growth.api.test',
    secret: 'native-provisioning-growth-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      readAccount: async (id) => accounts.get(id) ?? null,
      async authorizeProvisioning(id) {
        const result = approvals.get(id);
        if (!result) throw new Error('No trusted pending authorization');
        return structuredClone(result);
      },
    }),
  });
  verifier = createProvisioningEvidenceVerifier({ database: db.pool });
  pending('hot');
  reference = (await service.internal.provisionPassword(input('hot'))).provisioningEvidence!;
}, 60000);
afterAll(async () => {
  await db?.close();
  fixture?.close();
}, 60000);

async function grow(database: GrowthDatabase, scale: number, previous: number) {
  // The native unique account indexes permit only one receipt/stage per account.
  // Grow stale same-registration/reservation decoys and unrelated owners instead
  // of weakening those constraints to manufacture impossible owner histories.
  await database.admin.query(
    `INSERT INTO "user" (id,name,email,"emailVerified")
    SELECT 'decoy-'||i,'','decoy-'||i||'@example.test',false FROM generate_series($1::int,$2::int) i`,
    [previous * 1024 + 1, scale * 1024],
  );
  await database.admin.query(
    `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt")
    SELECT 'decoy-'||i,'decoy-'||i,'credential','decoy-'||i,'native-hash',now() FROM generate_series($1::int,$2::int) i`,
    [previous * 1024 + 1, scale * 1024],
  );
  await database.admin.query(
    `INSERT INTO auth_provisioning_receipt
    (idempotency_key,account_id,digest,registration_id,reservation_id,authn_epoch,expires_at,owner_id,credential_id,provisioning_kind)
    SELECT 'decoy-'||i,'decoy-'||i,'digest'::bytea,'hot-registration','hot-reservation',22,
      timestamptz '2000-01-01','decoy-'||i,CASE WHEN i%2=0 THEN $3 ELSE 'decoy-'||i END,'password' FROM generate_series($1::int,$2::int) i`,
    [previous * 1024 + 1, scale * 1024, reference.credentialId],
  );
  await database.admin.query(
    `INSERT INTO auth_registration_stage
    (registration_id,request_key,handle,account_id,reservation_id,request_digest,ciphertext,expires_at)
    SELECT 'decoy-'||i,'decoy-'||i,'hot','decoy-'||i,'hot-reservation','digest'::bytea,'ciphertext'::bytea,
      timestamptz '2000-01-01' FROM generate_series($1::int,$2::int) i`,
    [previous * 1024 + 1, scale * 1024],
  );
  await database.admin.query('VACUUM (ANALYZE)');
}
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
}
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;

test('checkGrowth exact valid, absent and mismatched evidence ignores growing receipt/stage decoys', async () => {
  const report = await checkGrowth(db, {
    name: 'exact native provisioning evidence',
    grow,
    bounds,
    async operation() {
      expect(await verifier.resolve(reference)).toEqual({
        accountId: 'hot',
        registrationId: 'hot-registration',
        authIdentityId: 'hot',
        authnEpoch: 23,
      });
      expect(await verifier.resolve({ ...reference, receiptKey: 'absent' })).toBeNull();
      expect(await verifier.resolve({ ...reference, reservationId: 'wrong' })).toBeNull();
      expect(
        await verifier.resolve({
          ...reference,
          receiptKey: 'decoy-1',
          accountId: 'decoy-1',
          credentialId: 'decoy-1',
          authnEpoch: 22,
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      ).toBeNull();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(4);
    expect(cost.rows).toBeLessThanOrEqual(8);
    expect(cost.relations?.['public.auth_registration_stage']).toBeUndefined();
  }
  const actual = await capture(db, () => verifier.resolve(reference));
  const plan = nodes(actual.capture.plans);
  expect(plan.some((node) => node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Sort')).toBe(false);
  for (const indexes of [
    [
      'auth_provisioning_receipt_pkey',
      'auth_provisioning_receipt_account_id_key',
      'auth_provisioning_receipt_owner_idx',
    ],
    ['user_pkey'],
    ['account_pkey', 'credential_owner_unique'],
  ])
    expect(plan.some((node) => indexes.includes(String(node['Index Name'])))).toBe(true);
  console.info('Native provisioning evidence:', JSON.stringify(report.samples));
}, 120000);

test('checkGrowth native idempotent password and credentialless commits have constant rows/statements', async () => {
  for (const automated of [false, true]) {
    const targets = consumableGrowth({
      name: automated ? 'robot' : 'person',
      async setup(_database, _scale, id) { pending(id, automated); },
      async run(_database, _scale, id) {
        const commit = () =>
          automated
            ? service.internal.provisionCredentialless({ authorization: id })
            : service.internal.provisionPassword(input(id));
        const first = await commit();
        expect(first.provisioningEvidence).toBeDefined();
        expect(await commit()).toEqual(first);
        expect((await db.admin.query('SELECT id FROM account WHERE "userId"=$1', [id])).rows).toHaveLength(1);
      },
    });
    const report = await checkGrowth(db, {
      name: `native ${automated ? 'credentialless' : 'password'} commit and exact replay`,
      bounds,
      async grow(database, scale) {
        // Reuse the same fully populated native seed, selecting the 1x/8x/64x
        // live populations by deleting only decoys outside this experiment's scale.
        await database.admin.query('DELETE FROM "user" WHERE id LIKE $1 AND substring(id from 7)::int>$2', [
          'decoy-%',
          scale * 1024,
        ]);
        await database.admin.query(
          'DELETE FROM auth_registration_stage WHERE registration_id LIKE $1 AND substring(registration_id from 7)::int>$2',
          ['decoy-%', scale * 1024],
        );
        const count = Number(
          (await database.admin.query('SELECT count(*) FROM "user" WHERE id LIKE $1', ['decoy-%'])).rows[0].count,
        );
        if (count < scale * 1024) await grow(database, scale, count / 1024);
        else await database.admin.query('VACUUM (ANALYZE)');
      },
      ...targets.hooks,
    });
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(11); // 15 including four BEGIN/COMMIT statements
      expect(cost.rows).toBeLessThanOrEqual(14);
      expect(cost.relations?.['public.auth_registration_stage']).toBeUndefined();
    }
    console.info('Native provisioning/replay:', JSON.stringify(report.samples));
  }
}, 120000);

test('proof erasure uses referencing-key indexes as unrelated receipts grow', async () => {
  const statements = [
    'BEGIN',
    'DELETE FROM "user" WHERE id=$1',
    `INSERT INTO auth_consent_erasure (account_id,due_at)
             VALUES ($1,clock_timestamp()+interval '5 minutes 10 seconds')
             ON CONFLICT (account_id) DO NOTHING`,
    'COMMIT',
  ] as const;
  const relations = [
    'account',
    'auth_barrier_proof',
    'auth_client',
    'auth_consent_erasure',
    'auth_key_assertion',
    'auth_provisioning_receipt',
    'auth_provisioning_receipt',
    'auth_public_key',
    'auth_recovery',
    'auth_session_opening',
    'oauthAccessToken',
    'oauthRefreshToken',
    'passkey',
    'session',
    'user',
  ];
  type NativePlan = { Plan: { 'Relation Name': string }; 'Query Text': string };
  const targets = consumableGrowth({
    name: 'erase',
    async setup(_database, _scale, id) {
      pending(id, true);
      const isolated = await createAuthService({ ...erasureOptions(), database: db.admin });
      const proof = (await isolated.internal.provisionCredentialless({ authorization: id })).provisioningEvidence!;
      Object.assign(accounts.get(id)!, { state: 'deleted', fenced: true });
      return proof;
    },
    async run(_database, _scale, id, proof) {
      await service.internal.eraseAccount(id);
      expect(await createProvisioningEvidenceVerifier({ database: db.admin }).resolve(proof)).toBeNull();
      expect((await db.admin.query('SELECT id FROM "user" WHERE id=$1', [id])).rowCount).toBe(0);
      expect((await db.admin.query('SELECT id FROM account WHERE "userId"=$1', [id])).rowCount).toBe(0);
    },
  });
    const report = await checkGrowth(db, {
      name: 'native provisioning proof erasure',
      bounds,
      async grow(database, scale) {
        const count = Number(
          (await database.admin.query('SELECT count(*) FROM "user" WHERE id LIKE $1', ['decoy-%'])).rows[0].count,
        );
        if (count > scale * 1024) {
          await database.admin.query('DELETE FROM "user" WHERE id LIKE $1 AND substring(id from 7)::int>$2', [
            'decoy-%',
            scale * 1024,
          ]);
          await database.admin.query(
            'DELETE FROM auth_registration_stage WHERE registration_id LIKE $1 AND substring(registration_id from 7)::int>$2',
            ['decoy-%', scale * 1024],
          );
        } else if (count < scale * 1024) await grow(database, scale, count / 1024);
        await database.admin.query('VACUUM (ANALYZE)');
      },
      ...targets.hooks,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    for (const { cost, repetitions, occurrenceRepetitions } of report.samples) {
      // Only accepted measured captures enter the report. Native producer ownership
      // retains nested FK/cascade documents on their actual source occurrence.
      const runs = occurrenceRepetitions.map(({ statements: occurrences }) => {
        expect(occurrences.map(({ statement }) => statement)).toEqual([
          'BEGIN',
          'DELETE FROM "user" WHERE id=?',
          'INSERT INTO auth_consent_erasure (account_id,due_at) VALUES (?,clock_timestamp()+interval ?) ON CONFLICT (account_id) DO NOTHING',
          'COMMIT',
        ]);
        return occurrences.flatMap(({ planDocuments }) => planDocuments) as NativePlan[];
      });
      expect(runs).toHaveLength(repetitions.length);
      for (const documents of runs) {
        expect(documents.map(({ Plan }) => Plan['Relation Name']).sort()).toEqual(relations);
        expect(documents.find(({ Plan }) => Plan['Relation Name'] === 'user')!['Query Text']).toBe(statements[1]);
        expect(documents.find(({ Plan }) => Plan['Relation Name'] === 'auth_consent_erasure')!['Query Text']).toBe(
          statements[2],
        );
      }
      for (const measured of [cost, ...repetitions]) {
        expect(measured.statements).toBe(2);
        expect(measured.controlStatements).toBe(2);
        expect(measured.plans).toBe(relations.length);
        expect(measured.rows).toBeLessThanOrEqual(5);
        expect(measured.relations['public.auth_consent']).toBeUndefined();
        expect(measured.relations['public.auth_registration_stage']).toBeUndefined();
      }
    }
    pending('index-erasure', true);
    await service.internal.provisionCredentialless({ authorization: 'index-erasure' });
    Object.assign(accounts.get('index-erasure')!, { state: 'deleted', fenced: true });
    const actual = await capture(db, () => service.internal.eraseAccount('index-erasure'));
    const plan = nodes(actual.capture.plans);
    expect(
      plan.some((node) => node['Relation Name'] === 'auth_provisioning_receipt' && node['Node Type'] === 'Seq Scan'),
    ).toBe(false);
    for (const index of ['auth_provisioning_receipt_owner_idx', 'auth_provisioning_receipt_credential_idx'])
      expect(plan.some((node) => node['Index Name'] === index)).toBe(true);
    expect(actual.capture.statements).toEqual(statements);
    expect((actual.capture.plans as NativePlan[]).map(({ Plan }) => Plan['Relation Name']).sort()).toEqual(relations);
    expect(costOf(actual.capture).statements).toBe(2);
    expect(costOf(actual.capture).controlStatements).toBe(2);

}, 120000);

// A second native service uses the admin pool only for unmeasured erasure setup.
function erasureOptions() {
  return {
    issuer: 'https://growth.provisioning.test',
    audience: 'https://growth.api.test',
    secret: 'native-provisioning-growth-secret-at-least-32-bytes',
    signing: signingKeys,
    trustedAccess: trustedAccessPorts({
      readAccount: async (id: string) => accounts.get(id) ?? null,
      readFencedAccount: async (id: string) => accounts.get(id) ?? null,
      authorizeProvisioning: async (id: string) => approvals.get(id)!,
    }),
  };
}
let signingKeys: AuthServiceSigning;
type AuthServiceSigning = Parameters<typeof createAuthService>[0]['signing'];
