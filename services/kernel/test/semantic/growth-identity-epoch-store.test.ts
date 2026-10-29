import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { runCommand } from '../../src/command/command.ts';
import { home, digest, seedLegacyGroup } from './support/identity-epoch.ts';
import { checkGrowth, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

let db: GrowthDatabase;
let access: Access;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
let actor: AccountActor;
const route = 0x5d10;
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const release = { digest: bundledDigest, release: bundledRelease };

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { editor: newId(route) }, [
    'subject:create',
    'subject:read',
    'subject:merge',
  ]);
  access = real.access({
    actions: new Map([
      ['subject:create', { anonymous: false }],
      ['subject:read', { anonymous: true }],
      ['subject:merge', { anonymous: false }],
    ]),
  });
  actor = await access.authenticate(real.bearer('editor'), { pool: db.pool, deadline: Date.now() + 5000 });
  await real.grant(globalResource, 'editor', 'subject:create');
  await real.grant(globalResource, 'editor', 'subject:merge');
});

afterAll(async () => {
  await db?.close();
});

test('native current mapping remains bounded as unrelated subject history grows', async () => {
  const key = randomUUID();
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    'subject:create',
    globalResource,
    { pool: db.pool, deadline: Date.now() + 5000 },
    () => new Error('Fixture denied subject:create'),
  );
  const created = await createSubject(db.pool, {
    actor,
    target: { route, id: newId(route) },
    idempotencyKey: key,
    digest: new Uint8Array(32).fill(4),
    item: { type: 'schema:Person', labels: { en: 'Identity growth anchor' } },
    release,
    authorization,
  });
  const anchor = created.subject.id;
  await settle(db, { analyze: true });
  const report = await checkGrowth(db, {
    name: 'native identity mapping across unrelated subjects',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      const entries = JSON.stringify(
        Array.from({ length: scale - previous }, () => ({ id: newId(route), tx: randomUUID() })),
      );
      await database.admin.query(
        `WITH input AS (
           SELECT id::uuid,tx::uuid FROM jsonb_to_recordset($1::jsonb) AS x(id text,tx text)
         ), subjects AS (
           INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
           SELECT $2,id,'schema:Person',tx,0,$3 FROM input RETURNING route,subject_id,recorded_transaction_id
         )
         INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
         SELECT route,subject_id,1,'create',$3,recorded_transaction_id FROM subjects`,
        [entries, route, bundledDigest],
      );
    },
    async operation(database) {
      const mapping = await identityEpochStore.readMapping(database.pool, anchor);
      expect(mapping).toMatchObject({ state: 'mapped', original: anchor, terminal: anchor });
      return mapping;
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples)
    for (const cost of sample.repetitions) expect(cost.statements + cost.controlStatements).toBeLessThanOrEqual(8);
}, 600_000);

async function createNative(targetRoute: number) {
  const key = randomUUID();
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    'subject:create',
    globalResource,
    { pool: db.pool, deadline: Date.now() + 5000 },
    () => new Error('Fixture denied subject:create'),
  );
  return (
    await createSubject(db.pool, {
      actor,
      target: { route: targetRoute, id: newId(targetRoute) },
      idempotencyKey: key,
      digest: digest(key),
      item: { type: 'schema:Person', labels: { en: 'Native growth input' } },
      release,
      authorization,
    })
  ).subject.id;
}

async function growHistory(database: GrowthDatabase, scale: number, previous: number) {
  const entries = JSON.stringify(
    Array.from({ length: scale - previous }, () => ({ id: newId(route), tx: randomUUID() })),
  );
  await database.admin.query(
    `WITH input AS (
    SELECT id::uuid,tx::uuid FROM jsonb_to_recordset($1::jsonb) AS x(id text,tx text)
  ), subjects AS (
    INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
    SELECT $2,id,'schema:Person',tx,0,$3 FROM input RETURNING route,subject_id,recorded_transaction_id
  ) INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    SELECT route,subject_id,1,'create',$3,recorded_transaction_id FROM subjects`,
    [entries, route, bundledDigest],
  );
}

test('a native mapping page shares five data statements as unrelated history grows', async () => {
  const originals: string[] = [];
  for (let i = 0; i < 100; i++) originals.push(await createNative(0x6d10));
  await settle(db, { analyze: true });
  const report = await checkGrowth(db, {
    name: 'native identity page across unrelated history',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: growHistory,
    async operation(database) {
      const mappings = await identityEpochStore.readMappings(database.pool, originals);
      expect(mappings).toHaveLength(100);
      expect(mappings.every((mapping, i) => mapping.state === 'mapped' && mapping.terminal === originals[i])).toBe(
        true,
      );
      return mappings;
    },
  });
  for (const sample of report.samples)
    for (const cost of sample.repetitions) expect(cost.statements + cost.controlStatements).toBeLessThanOrEqual(8);
}, 600_000);

test('retained native bootstrap includes source export, receiving custody and source ACK as history grows', async () => {
  let original = '';
  const prepare = async (_database: GrowthDatabase, _scale: number, repetition: number) => {
    original = await createNative(0x7000 + repetition * 16);
    await seedLegacyGroup({ admin: db.admin }, original, 1);
    await settle(db, { analyze: true });
  };
  const operation = async (database: GrowthDatabase) => {
    const progress = await stepIdentityEpochBootstrap(database.pool, home(original));
    expect(progress.work.rows).toBe(2);
    expect(progress.native.position).toBeGreaterThan(0n);
    expect(progress.native.transactionId).toBeString();
    return progress;
  };
  await checkGrowth(db, {
    name: 'native identity retained bootstrap across unrelated history',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: growHistory,
    prepare,
    operation,
    async warmup(database, scale, repetition) {
      await prepare(database, scale, repetition);
      return operation(database);
    },
  });
}, 600_000);

test('native capped admission includes current authorization, immutable inputs and pending observation as history grows', async () => {
  let survivor = '';
  let redirected = '';
  let key = '';
  let authorization: Awaited<ReturnType<typeof accessCommandAuthorization>>;
  const prepare = async (_database: GrowthDatabase, _scale: number, repetition: number) => {
    survivor = await createNative(0x7400 + repetition * 16);
    redirected = await createNative(0x7400 + repetition * 16);
    key = randomUUID();
    authorization = await accessCommandAuthorization(
      access,
      actor,
      'subject:merge',
      globalResource,
      { pool: db.pool, deadline: Date.now() + 5000 },
      () => new Error('Fixture denied subject:merge'),
    );
    await settle(db, { analyze: true });
  };
  const operation = async (database: GrowthDatabase) => {
    const admitted = await runCommand(
      database.pool,
      {
        partition: home(survivor),
        authorization,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      },
      (tx) =>
        identityEpochStore.admit(tx, {
          intent: { kind: 'merge', survivor, redirected, release: release.digest },
          receipt: {
            kind: 'subject.merge',
            command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
          },
        }),
    );
    expect(await identityEpochStore.readMapping(database.pool, redirected)).toEqual({
      state: 'pending',
      original: redirected,
      job: admitted.value,
    });
    return admitted.value;
  };
  await checkGrowth(db, {
    name: 'native identity admit across unrelated history',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: growHistory,
    prepare,
    operation,
    async warmup(database, scale, repetition) {
      await prepare(database, scale, repetition);
      return operation(database);
    },
  });
}, 600_000);
