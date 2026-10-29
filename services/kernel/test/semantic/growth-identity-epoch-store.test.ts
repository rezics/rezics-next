import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
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
  real = await createRealAccess(db.admin, { editor: newId(route) }, ['subject:create', 'subject:read']);
  access = real.access({ actions: new Map([['subject:create', { anonymous: false }], ['subject:read', { anonymous: true }]]) });
  actor = await access.authenticate(real.bearer('editor'), { pool: db.pool, deadline: Date.now() + 5000 });
  await real.grant(globalResource, 'editor', 'subject:create');
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
}, 600_000);
