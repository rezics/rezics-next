import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { standingFixture } from './standing-fixture.ts';
import { createResourceCreationManifest } from '../../src/access/creation-manifest.ts';
import { parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import type { Access } from '../../src/request/access.ts';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof standingFixture>>;
let actor: Awaited<ReturnType<typeof f.context>>['actor'];
let access: Access;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  // reaction:set is a mounted standing action; without it the thread and post templates drop.
  f = await standingFixture(['reaction:set']);
  await f.reset();
  await f.grant(f.actor, 'subject:create');
  actor = (await f.context()).actor;
  let account = await readAccount(db.admin, routeOf(f.actor)!, f.actor);
  access = createAccess({
    actions: new Map(
      f.actions.map((action) => [
        action,
        action === 'subject:create'
          ? { anonymous: false as const, 'x-resource-types': ['content.thread', 'content.post'] as const }
          : { anonymous: false as const },
      ]),
    ),
    accountEvidence: () => account,
  });
  const prepare = access.prepare!.bind(access);
  access.prepare = async (...args) => {
    account = await readAccount(db.pool, routeOf(f.actor)!, f.actor);
    return prepare(...args);
  };
}, 30000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});
async function createAndReplay(k: number) {
  const route = f.otherResource.route;
  const parent = await f.parent();
  const declared = Array.from({ length: k }, (_, i) => ({
    resource: { route, id: newId(route) },
    type: i === 0 ? 'content.thread' : 'content.post',
    creator: f.actor,
    creation: {
      async validate(tx: Parameters<typeof initializeResourceGrants>[0], child: { route: number; id: string }) {
        return (
          (
            await tx.query(
              'SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()',
              [child.route, child.id],
            )
          ).rowCount === 1
        );
      },
    },
  }));
  const deadline = Date.now() + 10000;
  const authorization = parentCreationAuthorization({
    access,
    actor,
    action: 'subject:create',
    parent,
    context: {
      pool: db.pool,
      deadline,
      resource: declared[0]!.resource,
      creation: declared[0]!.creation,
      manifest: createResourceCreationManifest(declared),
    },
  });
  const options = {
    partition: partitionOf(route),
    deadline,
    authorization,
    basis: { actorAccountId: f.actor, clientId: actor.clientId, requestedBy: actor.requestedBy },
    receipt: {
      actorAccountId: f.actor,
      kind: 'fixture.manifest.growth',
      key: Bun.randomUUIDv7(),
      digest: Buffer.alloc(32),
    },
  };
  let bodies = 0;
  const body = async (tx: Parameters<typeof initializeResourceGrants>[0]) => {
    bodies++;
    for (const entry of declared) {
      await tx.query('INSERT INTO public.standing_resource(route,id) VALUES ($1,$2)', [route, entry.resource.id]);
      await initializeResourceGrants(tx, entry);
    }
    return { value: k, events: [{ type: 'com.rezics.fixture.manifest-growth.v1', data: {} }] };
  };
  await runCommand(db.pool, options, body);
  expect((await runCommand(db.pool, options, body)).replayed).toBe(true);
  expect(bodies).toBe(1);
}
async function grow(scale: number, previous: number) {
  // Both authority and child partitions grow; the actor's matched principal set stays fixed.
  for (const route of [f.resource.route, f.otherResource.route]) {
    const ids = Array.from({ length: (scale - previous) * 256 }, () => newId(route));
    await db.admin.query('INSERT INTO public.standing_resource(route,id) SELECT $1,id FROM unnest($2::uuid[]) id', [
      route,
      ids,
    ]);
    await db.admin.query(
      `INSERT INTO access.resource_initialization(route,resource_id,resource_type,creator_id,initialized_at)
      SELECT $1,id,'content.post',$3,now() FROM unnest($2::uuid[]) id`,
      [route, ids, f.actor],
    );
    await db.admin.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,grant_role,valid,transaction_id)
      SELECT $1,id,'identity',$3,'content.post.owner','(,)',$3 FROM unnest($2::uuid[]) id`,
      [route, ids, f.actor],
    );
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      SELECT $1::integer,id,id,'subject:create','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
      UNION ALL SELECT $4::integer,$5::uuid,id,'subject:create','(,)',$3 FROM unnest($2::uuid[]) id`,
      [route, ids, f.actor, f.resource.route, f.resource.id],
    );
    await db.admin.query(
      `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
      SELECT $1,'account',$2,'fixture.manifest.growth',id::text,$3,1,1,$2,'{}' FROM unnest($4::uuid[]) id`,
      [partitionOf(route), f.actor, Buffer.alloc(32), ids],
    );
  }
  await db.admin.query('VACUUM (ANALYZE)');
}
test('native creation, provenance, grant writes and replay stay bounded as unrelated and same partition history grows', async () => {
  const report = await checkGrowth(db, {
    name: 'manifest background',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    grow: async (_, scale, previous) => grow(scale, previous),
    operation: async () => createAndReplay(2),
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
  expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
  for (const sample of report.samples) {
    expect(sample.cost.relations!['public.standing_resource']!.blocks).toBeGreaterThan(0);
    expect(sample.cost.relations!['access.resource_initialization']!.blocks).toBeGreaterThan(0);
    expect(sample.cost.relations!['access.resource_role_grant']!.blocks).toBeGreaterThan(0);
  }
}, 120000);
test('manifest changed resources add at most linear native work including initialization and replay', async () => {
  const report = await checkGrowth(db, {
    name: 'manifest changed resources',
    rule: 'series',
    scales: [1, 4, 16],
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    repetitions: 3,
    async grow(_, scale, previous) {
      if (previous === 0) await grow(8, 0);
      await db.admin.query('VACUUM (ANALYZE)');
    },
    async operation(_, scale) {
      await createAndReplay(scale);
    },
  });
  const [first, four, sixteen] = report.samples;
  for (const metric of ['rows', 'statements', 'blocks'] as const) {
    // Per-entry marginal work cannot grow with manifest length. Buffer splits get
    // a fixed four-block allowance; no allowance is needed for rows or statements.
    const allowance = metric === 'blocks' ? 4 : 0;
    expect((sixteen!.cost[metric] - four!.cost[metric]) / 12).toBeLessThanOrEqual(
      (four!.cost[metric] - first!.cost[metric]) / 3 + allowance,
    );
  }
}, 120000);
