import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccessPlatformAdministrators, platformAdministratorProof } from '../src/modules/access/platform-administrator.ts';
import { uploadDigest } from '../src/modules/media/commands.ts';
import { assetIri, DEFAULT_MEDIA_CONTEXT, MediaStore } from '../src/modules/media/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { mediaRoutes, openApiOperations } from '../src/routes/media.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const template = 'platform_administrator_hold_template';
let cluster: PostgresCluster | undefined;
let admin: Pool;
let baseline: Awaited<ReturnType<typeof prepare>>;

async function prepare(pool: Pool) {
  const principalId = randomUUID(), actor = assetIri(randomUUID());
  const identity = { issuer: 'https://account.platform-hold.test', subject: randomUUID(), emailVerified: true };
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, identity.issuer, identity.subject]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await grantFixtureAuthority(pool, { scope: `agent:control:${actor}`, requireDispatch: true,
    representations: [{ principalId, actor, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor, action: 'agent.control', lifetime: 'infinity' } });
  await grantFixtureAuthority(pool, { scope: `media:owner:${actor}`, requireDispatch: true,
    representations: [{ principalId, actor, action: 'media.upload', lifetime: 'infinity' }],
    grant: { actor, action: 'media.upload', lifetime: 'infinity' } });
  await new AccessPlatformAdministrators(pool).designateFirst(identity.issuer, identity.subject, () => undefined);
  const store = new MediaStore(pool, new ContentCore(pool));
  const bytes = Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
  const input = { asset: null, mediaType: 'image/gif' as const, byteLength: bytes.length,
    sha256: digest(bytes), disclosure: 'public' as const };
  const admission = { admissionId: randomUUID(), principalId, actingSubject: actor,
    authorityEpoch: '0', requestDigest: uploadDigest(input) };
  const reserved = await store.reserveUpload(admission, input);
  const settled = await store.settleUpload(reserved.upload, { status: 'activated', sha256: input.sha256,
    byteLength: bytes.length, mediaType: 'image/gif', width: 1, height: 1 }, async () => input.sha256);
  await store.recordAssetRevision(reserved.upload);
  const representation = settled.representation!;
  const document = await store.presentation.createDocumentUse({ ...admission, admissionId: randomUUID(),
    requestDigest: digest('document-image') }, { representation, target: assetIri(randomUUID()),
    occurrence: randomUUID(), context: DEFAULT_MEDIA_CONTEXT, conceal: false });
  for (const target of [representation, document.use])
    await ensureFixtureScopeGate(pool, `media:protect:${assetIri(target)}`);
  return { principalId, actor, identity, representation, use: document.use };
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = boundedPool(cluster.connection);
  await admin.query(`CREATE DATABASE ${template}`);
  const pool = boundedPool({ ...cluster.connection, database: template, max: 4 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'access'))
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    baseline = await prepare(pool);
  } finally { await pool.end(); }
}, 60_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

async function isolated(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const database = `platform_hold_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ${template}`);
  const pool = boundedPool({ ...cluster!.connection, database, max: 4 });
  try { await run(fixture(pool)); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${database}`); }
}

function fixture(pool: Pool) {
  const access = new AccessAdmissionRegistry(pool);
  const content = new ContentCore(pool), store = new MediaStore(pool, content);
  const graph = new FusekiClient('http://graph.platform-hold.test');
  // Only graph lineage is synthetic; administrator admission and Media effects
  // run against migrated owner stores and their real transaction locks.
  graph.query = async () => ({ boolean: true });
  const principal = { ...baseline.identity, currentAssertion: async () => baseline.identity };
  const environment = { fuseki: graph, objectDirectory: '.temp/platform-administrator-hold',
    lineage: { dataEpoch: 'platform-hold', routingEpoch: '1' } };
  let registered: RegisteredAdmission | undefined;
  let beforeClaim: (() => Promise<void>) | undefined;
  let beforeSeal: (() => Promise<void>) | undefined;
  const dependencies = { environment, account: { verify: async () => principal },
    access: {
      register: async (...args: Parameters<typeof access.register>) => {
        registered = await access.register(...args);
        return registered;
      },
      claim: async (...args: Parameters<typeof access.claim>) => {
        await beforeClaim?.();
        return access.claim(...args);
      },
      recordGraphOutcome: async (...args: Parameters<typeof access.recordGraphOutcome>) => {
        await beforeSeal?.();
        return access.recordGraphOutcome(...args);
      },
    }, media: { store, content, objects: () => { throw new Error('field control needs no bytes'); } },
  } as unknown as MainWorkDependencies;
  const app = mediaRoutes(graph, dependencies);
  const gate = async (open: boolean, dispatchOpen: boolean) => {
    await pool.query("UPDATE access.scope_gate SET open=$1,dispatch_open=$2 WHERE id='platform:access'",
      [open, dispatchOpen]);
  };
  const call = (field: 'labels' | 'conceal', key = randomUUID()) => {
    const path = field === 'labels'
      ? `/v1/media/representations/${baseline.representation}/labels`
      : `/v1/media/uses/${baseline.use}/conceal`;
    return app.handle(new Request(`http://main.test${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer administrator', 'idempotency-key': key },
      body: JSON.stringify({ actingSubject: baseline.actor, authority: 'platform', mode: 'lock',
        expectedValueHead: null, basis: { head: null, epoch: '0', protection: null },
        ...(field === 'labels' ? { field: 'nsfw', value: 'sfw' } : { value: true }) }),
    }));
  };
  return { ...baseline, pool, access, store, gate, call,
    registered: () => registered!,
    beforeClaim: (callback: () => Promise<void>) => { beforeClaim = callback; },
    beforeSeal: (callback: () => Promise<void>) => { beforeSeal = callback; },
    revisions: async () => (await pool.query('SELECT id FROM media.field_revision ORDER BY id')).rows,
  };
}

const holds = [
  { name: 'admission', open: false, dispatchOpen: true },
  { name: 'dispatch', open: false, dispatchOpen: false },
];

for (const hold of holds) {
  for (const field of ['labels', 'conceal'] as const) {
    test(`public media ${field} protection refuses a fresh request under the ${hold.name} platform hold`, () => isolated(async f => {
      expect(openApiOperations[field === 'labels'
        ? '/v1/media/representations/{representation}/labels' : '/v1/media/uses/{use}/conceal'].post.exposure).toBe('public');
      await f.gate(hold.open, hold.dispatchOpen);
      const response = await f.call(field);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'authority_denied' });
      expect(await f.revisions()).toEqual([]);
      expect((await f.pool.query('SELECT id FROM access.admission')).rows).toEqual([]);
      // Opening the platform gate restores fresh authority without replacing grants.
      await f.gate(true, true);
      expect((await f.call(field)).status).toBe(201);
    }), 60_000);

    test(`public media ${field} protection registered before the ${hold.name} hold cannot claim afterward`, () => isolated(async f => {
      f.beforeClaim(() => f.gate(hold.open, hold.dispatchOpen));
      const response = await f.call(field);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'authority_denied' });
      expect(f.registered().dispatchEligible).toBe(true);
      expect((await f.pool.query('SELECT admission_id FROM access.platform_administrator_admission')).rows)
        .toEqual([{ admission_id: f.registered().id }]);
      expect(await f.store.readOutcome(`media-field:${f.registered().id}`)).toBeNull();
      expect(await f.revisions()).toEqual([]);
    }), 60_000);
  }

  test(`the unlocked administrator read proof also refuses the ${hold.name} platform hold`, () => isolated(async f => {
    expect(await platformAdministratorProof(f.pool, f.principalId, f.actor, false)).not.toBeNull();
    await f.gate(hold.open, hold.dispatchOpen);
    expect(await platformAdministratorProof(f.pool, f.principalId, f.actor, false)).toBeNull();
  }), 60_000);
}

for (const field of ['labels', 'conceal'] as const) {
  for (const sealed of [true, false]) {
    test(`a committed ${field} protection result replays during a platform hold with Access ${sealed ? 'sealed' : 'awaiting reconciliation'}`, () => isolated(async f => {
      if (!sealed) f.beforeSeal(async () => { throw new Error('lost acknowledgement after owner commit'); });
      const key = randomUUID();
      const first = await f.call(field, key);
      expect(first.status).toBe(sealed ? 201 : 503);
      const firstBody = await first.json();
      const outcome = await f.store.readOutcome(`media-field:${f.registered().id}`);
      expect(outcome?.outcome).toBe('succeeded');
      const revisions = await f.revisions();
      expect(revisions).toHaveLength(1);
      await f.gate(false, false);
      f.beforeSeal(async () => undefined);
      const replay = await f.call(field, key);
      expect(replay.status).toBe(200);
      const result = await replay.json();
      expect(result).toMatchObject({ admission: f.registered().id, revision: assetIri(revisions[0]!.id), replayed: true });
      if (sealed) expect(result).toEqual({ ...firstBody, replayed: true });
      expect(await f.revisions()).toEqual(revisions);
      expect(await f.store.readOutcome(`media-field:${f.registered().id}`)).toEqual(outcome);
    }), 60_000);
  }
}

test('the shared administrator proof holds the platform gate until its transaction ends', () => isolated(async f => {
  const closerPool = boundedPool({ ...cluster!.connection, database: f.pool.options.database, max: 1 });
  const proofClient = await f.pool.connect(), closer = await closerPool.connect();
  try {
    await proofClient.query('BEGIN');
    expect(await platformAdministratorProof(proofClient, f.principalId, f.actor)).not.toBeNull();
    await closer.query("BEGIN; SET LOCAL lock_timeout = '100ms'");
    await expect(closer.query("UPDATE access.scope_gate SET open=false,dispatch_open=false WHERE id='platform:access'"))
      .rejects.toMatchObject({ code: '55P03' });
    await closer.query('ROLLBACK');
    await proofClient.query('COMMIT');
    await proofClient.query("UPDATE access.scope_gate SET open=false,dispatch_open=false WHERE id='platform:access'");
    expect(await platformAdministratorProof(proofClient, f.principalId, f.actor)).toBeNull();
  } finally {
    await proofClient.query('ROLLBACK'); await closer.query('ROLLBACK');
    proofClient.release(); closer.release(); await closerPool.end();
  }
}), 60_000);

test('a missing platform gate cannot supply an administrator proof', async () => {
  const query = async (sql: string, values?: unknown[]) => ({ rows:
    sql.includes('scope_gate') ? [] : sql.includes('read_platform_permissions')
      ? [{ id: randomUUID(), action: 'platform:use:platform-admin', scope_id: 'platform:access',
        generation: '1', valid_until: null, witness: 'retained grant' }]
      : [{ receipt: values?.[2], representation_id: randomUUID(), representation_generation: '1',
        subject_generation: '1', principal_epoch: '0' }],
  });
  for (const lock of [true, false])
    expect(await platformAdministratorProof({ query } as unknown as Pool, randomUUID(), assetIri(randomUUID()), lock)).toBeNull();
});
