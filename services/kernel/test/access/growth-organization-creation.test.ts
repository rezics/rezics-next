import { afterAll, beforeAll, expect, test } from 'bun:test';
import { organizationFixture } from './organization-creation.test.ts';
import { checkGrowth } from '../support/growth.ts';
import { newId } from '../../src/route/route.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';

let h: Awaited<ReturnType<typeof organizationFixture>>;
let creator: Awaited<ReturnType<typeof h.human>>;
let spareCreator: Awaited<ReturnType<typeof h.human>>;
beforeAll(async () => {
  h = await organizationFixture();
  const governor = await h.human();
  creator = await h.human();
  spareCreator = await h.human();
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
      const organizations = ids.filter((_, index) => index % 2 === 1);
      const owners = ids.filter((_, index) => index % 2 === 0);
      for (const statement of [
        `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
        SELECT 22136,id,owner,'owner','(,)',id FROM unnest($1::uuid[],$2::uuid[]) a(id,owner)`,
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
        SELECT 22136,owner,'organization',id,id,id FROM unnest($1::uuid[],$2::uuid[]) a(id,owner)`,
        `INSERT INTO access.lifecycle_membership_slot(route,organization_id,member_account_id,reservation_id,transaction_id)
        SELECT 22136,id,owner,id,id FROM unnest($1::uuid[],$2::uuid[]) a(id,owner)`,
        `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
        SELECT 22136,owner,id,id,'membership',id FROM unnest($1::uuid[],$2::uuid[]) a(id,owner)`,
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        SELECT 22136,id,id,'owner',action,'(,)',id FROM unnest($1::uuid[],$2::uuid[]) a(id,owner)
        CROSS JOIN unnest(ARRAY['account:update','account:delete','organization:membership','account:manage','access:grant']) action`,
      ])
        await db.admin.query(statement, [organizations, owners]);
      await db.admin.query(
        `INSERT INTO access.workflow_approval
          (route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id)
        SELECT 22136,id,id,'growth-organization','{organization:create}',1,id::text,'{"kind":"organization"}',repeat('0',64),
          '2000-01-01'::timestamptz,'2000-01-01 00:05:00'::timestamptz,'2000-01-01 00:05:00'::timestamptz,id
        FROM unnest($1::uuid[]) id`,
        [owners],
      );
      for (const statement of [
        `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id,reservation_id)
        SELECT get_byte(sha256(convert_to(handle,'UTF8')),0)*256+get_byte(sha256(convert_to(handle,'UTF8')),1),
          handle,id,'active',id,id FROM (SELECT id,'growth_'||replace(id::text,'-','_') AS handle FROM unnest($1::uuid[]) id) a`,
        `INSERT INTO access.lifecycle_handle_operation(route,account_id,operation_id,handle,reservation_id,state,transaction_id)
        SELECT 22136,id,id::text,'growth_'||replace(id::text,'-','_'),id,'completed',id FROM unnest($1::uuid[]) id`,
        `INSERT INTO access.lifecycle_handle_effect(route,normalized_handle,account_id,reservation_id,operation_id,effect,transaction_id)
        SELECT get_byte(sha256(convert_to(handle,'UTF8')),0)*256+get_byte(sha256(convert_to(handle,'UTF8')),1),
          handle,id,id,id::text,'active',id
        FROM (SELECT id,'growth_'||replace(id::text,'-','_') AS handle FROM unnest($1::uuid[]) id) a`,
      ])
        await db.admin.query(statement, [organizations]);
      // Advance the unrelated partition before adding its command history.
      const partition = 0x5678 >>> 4;
      const end = (
        await db.admin.query<{ position: string }>(
          'UPDATE core.partition SET position=position+$2 WHERE partition_no=$1 RETURNING position::text',
          [partition, ids.length],
        )
      ).rows[0]!.position;
      for (const statement of [
        `INSERT INTO core.receipt
          (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',id,'access.organization-created',id::text,decode(repeat('0',64),'hex'),1,$3::bigint-$4+n,id,'{}'
        FROM unnest($2::uuid[]) WITH ORDINALITY a(id,n)`,
        `INSERT INTO editorial.write_basis(partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id)
        SELECT $1,id,1,$3::bigint-$4+n,'account',id,'internal-access'
        FROM unnest($2::uuid[]) WITH ORDINALITY a(id,n)`,
        `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
        SELECT $1,$3::bigint-$4+n,0,1,1,id,'com.rezics.access.organization-created.v1',id::text,'{}'
        FROM unnest($2::uuid[]) WITH ORDINALITY a(id,n)`,
      ])
        await db.admin.query(statement, [partition, ids, end, ids.length]);
      for (const table of [
        'access.account',
        'access.resource_grant',
        'access.resource_role_grant',
        'access.membership_inverse',
        'access.organization_member',
        'access.lifecycle_membership_slot',
        'access.lifecycle_coordination',
        'access.workflow_approval',
        'access.handle_claim',
        'access.lifecycle_handle_operation',
        'access.lifecycle_handle_effect',
        'core.receipt',
        'core.outbox',
        'editorial.write_basis',
      ])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    async warmup() {
      const f = await h.approve(spareCreator.token);
      expect(await h.create(f)).toEqual({ accountId: f.accountId });
    },
    async operation() {
      const f = await h.approve(creator.token);
      expect(await h.create(f)).toEqual({ accountId: f.accountId });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
}, 60000);
