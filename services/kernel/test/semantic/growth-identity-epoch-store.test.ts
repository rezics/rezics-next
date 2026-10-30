import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import type { Access } from '../../src/request/access.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, writeSubject } from '../../src/semantic/subject.ts';
import { newId } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  stepIdentityEpochAdmission,
  cancelIdentityEpochAdmission,
  acquireIdentityEpochAdmissionHome,
} from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { runCommand } from '../../src/command/command.ts';
import { home, digest, seedLegacyGroup } from './support/identity-epoch.ts';
import { checkGrowth, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

let db: GrowthDatabase;
let access: Access;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
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
  await real.grant(globalResource, 'editor', 'subject:create');
  await real.grant(globalResource, 'editor', 'subject:merge');
  await seedNativeHistory();
}, 600_000);

afterAll(async () => {
  await db?.close();
});

test('native current mapping remains bounded as unrelated subject history grows', async () => {
  const key = randomUUID();
  const { actor, authorization } = await authorize('subject:create');
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

async function authorize(action: 'subject:create' | 'subject:merge') {
  const context = { pool: db.pool, deadline: Date.now() + 5000 };
  // Each measured request gets its own authenticated snapshot and unchanged deadline.
  const actor = await access.authenticate(real.bearer('editor'), context);
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    action,
    globalResource,
    context,
    () => new Error(`Fixture denied ${action}`),
  );
  return { actor, authorization };
}

/** Populate the relations used by native plans through their real writers, including receipt custody.
 * A tiny job/receipt relation otherwise changes sequential-scan size merely as consumable trials run.
 */
async function seedNativeHistory() {
  const route = 0x6e00;
  const originals = Array.from({ length: 2048 }, () => newId(route));
  for (let offset = 0; offset < originals.length; offset += 32) {
    const { actor, authorization } = await authorize('subject:create');
    await runCommand(
      db.pool,
      {
        partition: home(originals[offset]!),
        authorization,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      },
      async (tx, { transactionId }) => {
        const events = [];
        for (const id of originals.slice(offset, offset + 32)) {
          const result = await writeSubject(tx, transactionId, {
            target: { route, id },
            item: { type: 'schema:Person', labels: { en: 'Native retained history' } },
            release,
          });
          events.push(...result.events);
        }
        return { value: null, events };
      },
    );
  }
  for (let offset = 0; offset < originals.length; offset += 2) {
    const { actor, authorization } = await authorize('subject:merge');
    const key = randomUUID();
    const job = await identityEpochStore.prepareAdmission(
      db.pool,
      {
        authorization,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      },
      {
        intent: {
          kind: 'merge',
          survivor: originals[offset]!,
          redirected: originals[offset + 1]!,
          release: release.digest,
        },
        receipt: {
          kind: 'subject.merge',
          command: {
            actorAccountId: actor.accountId,
            kind: 'subject.merge',
            key,
            digest: digest(key),
          },
        },
      },
    );
    await cancelIdentityEpochAdmission(db.pool, job);
    await stepIdentityEpochAdmission(db.pool, job);
    expect((await stepIdentityEpochAdmission(db.pool, job)).state).toBe('cancelled');
  }
  // Retain actual source exports and receiving custody at independent homes. The
  // bootstrap trials must start with indexed metadata and redirect history too,
  // rather than measuring a growing tiny-table sequential scan between trials.
  for (let partition = 0x100; partition < 0x500; partition++) {
    const original = await createNative(partition * 16);
    await seedLegacyGroup({ admin: db.admin }, original, 1);
    const progress = await stepIdentityEpochBootstrap(db.pool, partition);
    expect(progress.work.rows).toBe(2);
    expect(progress.native.transactionId).toBeString();
  }
  await settle(db, { analyze: true });
}

async function createNative(targetRoute: number) {
  const key = randomUUID();
  const { actor, authorization } = await authorize('subject:create');
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
  const prepare = async (_database: GrowthDatabase, _scale: number, repetition: number) => {
    survivor = await createNative(0x7400 + repetition * 16);
    redirected = await createNative(0x7400 + repetition * 16);
    key = randomUUID();
    await settle(db, { analyze: true });
  };
  const operation = async (database: GrowthDatabase) => {
    const { actor, authorization } = await authorize('subject:merge');
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

test('coherent admission and ordered cancellation stay indexed', async () => {
  let survivor = '';
  let redirected = '';
  let key = '';
  const prepare = async (_database: GrowthDatabase, _scale: number, repetition: number) => {
    redirected = await createNative(0x7800 + repetition * 32);
    survivor = await createNative(0x7810 + repetition * 32);
    key = randomUUID();
    await settle(db, { analyze: true });
  };
  const operation = async (database: GrowthDatabase) => {
    const { actor, authorization } = await authorize('subject:merge');
    const job = await identityEpochStore.prepareAdmission(
      database.pool,
      {
        authorization,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      },
      {
        intent: { kind: 'merge', survivor, redirected, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: {
            actorAccountId: actor.accountId,
            kind: 'subject.merge',
            key,
            digest: digest(key),
          },
        },
      },
    );
    await stepIdentityEpochAdmission(database.pool, job);
    // A committed receiving effect without job-home custody is an actual uncertain delivery.
    await acquireIdentityEpochAdmissionHome(database.pool, job, home(survivor));
    await cancelIdentityEpochAdmission(database.pool, job);
    for (let i = 0; i < 3; i++) {
      const progress = await stepIdentityEpochAdmission(database.pool, job);
      expect(progress.work.rows).toBeLessThanOrEqual(100);
      expect(progress.work.statements).toBeGreaterThan(0);
      expect(progress.work.bytes).toBeGreaterThan(0);
      if (i === 2) expect(progress.state).toBe('cancelled');
    }
    expect(await identityEpochStore.readMapping(database.pool, redirected)).toMatchObject({
      state: 'mapped',
      terminal: redirected,
    });
    return job;
  };
  await checkGrowth(db, {
    name: 'coherent admission and ordered cancellation stay indexed',
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
