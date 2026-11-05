import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const accountId = newId(route);
const avatar = newId(route);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const handle = 'growth_profile';
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({ pool: db.pool, routeKey: new Uint8Array(32).fill(31) });
});
afterAll(async () => db?.close());

test('public profile by handle stays bounded as accounts and handle claims grow', async () => {
  const report = await checkGrowth(db, {
    name: 'public profile by handle',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) {
        await db.admin.query(
          `INSERT INTO access.account(route, account_id, kind, state, handle, biography, transaction_id)
    VALUES ($1, $2, 'actor', 'active', $3, 'Profile biography', $2)`,
          [route, accountId, handle],
        );
        await db.admin.query(
          `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
    VALUES ($1, $2, $3, 'active', $3)`,
          [createHash('sha256').update(handle).digest().readUInt16BE(0), handle, accountId],
        );
        await database.admin.query(
          "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,'account:update','(,)',$2)",
          [route, accountId],
        );
      }

      const count = (scale - previous) * 16;
      for (let offset = 0; offset < count; offset += 4096) {
        const ids = Array.from({ length: Math.min(4096, count - offset) }, () => newId(route));
        const handles = ids.map((id) => `grow_${id}`);
        const routes = handles.map((value) => createHash('sha256').update(value).digest().readUInt16BE(0));
        await database.admin.query(
          `INSERT INTO access.account(route, account_id, kind, state, handle, transaction_id)
          SELECT $1, id, 'actor', 'active', handle, id FROM unnest($2::uuid[], $3::text[]) AS seed(id, handle)`,
          [route, ids, handles],
        );
        await database.admin.query(
          `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
          SELECT route, handle, id, 'active', id FROM unnest($1::integer[], $2::text[], $3::uuid[]) AS seed(route, handle, id)`,
          [routes, handles, ids],
        );
      }
      const mediaIds = Array.from({ length: (scale - previous) * 16 }, () => newId(route));
      if (previous === 0) mediaIds.push(avatar);
      await database.admin.query(
        `INSERT INTO content.media
        (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
         actual_byte_count,sha256,state,key,transaction_id,width,height,thumbhash,average_color)
        SELECT $1,id,$3,$3,id::text,'avatar','image/png',256,256,repeat('a',64),'available',
          'm/'||id||'/original',id,64,64,decode('010203','hex'),'#123456'
        FROM unnest($2::uuid[]) seed(id)`,
        [route, mediaIds, accountId],
      );
      const actor = await authenticateAccount(
        access,
        { pool: database.pool, deadline: Date.now() + 30000 },
        {
          accountId,
          clientId: 'profile-growth',
          scopes: [...LIFECYCLE_ACTIONS.keys()],
        },
      );
      await createLifecycleCommands({ pool: database.pool, access }).updateAccount(
        { actor, deadline: Date.now() + 30000 },
        {
          accountId,
          key: `avatar-${scale}`,
          patch: { avatar, publicViews: { posts: true } },
        },
      );
      await database.admin.query('VACUUM (ANALYZE) access.account');
      await database.admin.query('VACUUM (ANALYZE) access.handle_claim');
    },
    async operation() {
      const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?handle=${handle}`));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        accounts: [
          {
            id: accountId,
            bio: 'Profile biography',
            links: [],
            avatar: { media: avatar, credit: null },
            publicViews: { posts: true, reviews: true, collections: true },
            subject: null,
          },
        ],
        next: null,
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(3);
    expect(sample.cost.relations?.['content.media']?.rows).toBe(1);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
    expect(sample.cost.relations?.['access.handle_claim']?.rows).toBe(1);
  }
}, 60_000);
