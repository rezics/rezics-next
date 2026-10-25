import { afterAll, beforeAll, expect, test } from 'bun:test';
import { organizationFixture } from './organization-creation.test.ts';
import { checkGrowth } from '../support/growth.ts';
import { newId } from '../../src/route/route.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';

let h: Awaited<ReturnType<typeof organizationFixture>>;
let creator: Awaited<ReturnType<typeof h.human>>;
beforeAll(async () => {
  h = await organizationFixture();
  const governor = await h.human();
  creator = await h.human();
  await h.governance(governor.accountId);
}, 60000);
afterAll(async () => h?.close());

test('real organization creation stays bounded as unrelated accounts, organizations and Global grants grow', async () => {
  const report = await checkGrowth(h.db, {
    name: 'organization creation',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    // Three actual creations keep the same creator, with K bounded by three.
    repetitions: 1,
    warmups: 0,
    async grow(db, scale, previous) {
      const ids = Array.from({ length: (scale - previous) * 64 }, () => newId(0x5678));
      await db.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,membership_inverse_complete,transaction_id)
        SELECT 22136,id,CASE WHEN n%2=0 THEN 'organization' ELSE 'actor' END,'active',true,id
        FROM unnest($1::uuid[]) WITH ORDINALITY a(id,n)`,
        [ids],
      );
      await db.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
        SELECT 0,$1,id,'organization:create','(,)',id FROM unnest($2::uuid[]) id`,
        [PLATFORM_RESOURCE.id, ids],
      );
      for (const table of [
        'access.account',
        'access.resource_grant',
        'access.resource_role_grant',
        'access.membership_inverse',
        'access.organization_member',
        'core.receipt',
      ])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    async operation() {
      const f = await h.approve(creator.token);
      expect(await h.create(f)).toEqual({ accountId: f.accountId });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
}, 60000);
