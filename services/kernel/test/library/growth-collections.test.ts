import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { respacedKeys } from '../../src/library/ordinal.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, costOf, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x5c31;
const otherRoute = 0x6c31;
const scopes = ['collection:read', 'collection:update', 'collection:delete'];
const time = '2026-01-01T00:00:00.000Z';
type Operation = 'delete' | 'note' | 'remove' | 'read';
let database: GrowthDatabase;
let access: ReturnType<typeof createAccess>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let observedPlans: unknown[] | undefined;

beforeAll(async () => {
  database = await openGrowthDatabase();
  // Observe the harness's plans as well, so scan assertions cover every run, not just its scale's median.
  const observed = new WeakSet<PoolClient>();
  database.pool.on('acquire', (client) => {
    if (observed.has(client)) return;
    observed.add(client);
    client.on('notice', (notice) => {
      const message = notice.message;
      const marker = 'plan:\n';
      if (observedPlans && message?.startsWith('duration:') && message.includes(marker))
        observedPlans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
    });
  });
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'library-growth', alg: 'ES256' };
  access = createAccess({
    actions: new Map(scopes.map((action) => [action, { anonymous: action === 'collection:read' }])),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
});

afterAll(async () => {
  if (database) await database.close();
});

async function prepare() {
  // This test file owns its disposable database; each check starts with the same population size.
  await database.admin.query(`TRUNCATE library.collection_member, library.collection,
    access.resource_initialization, access.resource_role_grant, access.resource_grant, access.resource_denial,
    access.membership_inverse, access.principal_assignment, access.account,
    core.receipt, core.outbox, editorial.write_basis CASCADE`);
  const accountId = newId(route);
  await database.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, true)`,
    [route, accountId],
  );
  const token = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'library-growth', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const actor = await access.authenticate(token, { pool: database.pool, deadline: Date.now() + 290_000 });
  return {
    actor,
    commands: createCollectionCommands({ pool: database.pool, access }),
    reads: createCollectionReads({
      pool: database.pool,
      access,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) },
    }),
  };
}

// IDs encode their route exactly as production IDs do. Each ordinal has a home and another-account placement.
const source = `WITH source AS (
  SELECT n, r AS route, r >> 4 AS partition_no,
    ('10000000-0000-7000-8000-' || lpad(to_hex(r),4,'0') || lpad(to_hex(n),8,'0'))::uuid AS collection_id,
    ('20000000-0000-7000-8000-' || lpad(to_hex(r),4,'0') || lpad(to_hex(n),8,'0'))::uuid AS member_id,
    ('30000000-0000-7000-8000-' || lpad(to_hex(r),4,'0') || lpad(to_hex(n),8,'0'))::uuid AS account_id
  FROM generate_series($1::int + 1, $2::int) n CROSS JOIN unnest(ARRAY[$3::int,$4::int]) r
)`;

async function grow(scale: number, previous: number, actor: AccountActor, probes: readonly string[], kind: string) {
  const range = [500 * previous, 500 * scale, route, otherRoute];
  const home = actor.accountId;
  await database.admin.query(
    `${source}
    INSERT INTO access.account (route,account_id,kind,state,transaction_id,membership_inverse_complete)
    SELECT route,account_id,'actor','active',account_id,true FROM source`,
    range,
  );
  await database.admin.query(
    `${source}
    INSERT INTO access.membership_inverse (route,account_id,kind,group_id,reservation_id,transaction_id)
    SELECT route,account_id,'organization',collection_id,member_id,member_id FROM source`,
    range,
  );
  await database.admin.query(
    `${source}
    INSERT INTO access.principal_assignment
      (route,principal_id,request_id,assigned_actor_id,valid,issued_valid,creator_principal_id,transaction_id)
    SELECT route,account_id,member_id,account_id,'(,)','(,)',account_id,member_id FROM source`,
    range,
  );
  await database.admin.query(
    `${source}, collections AS (
      SELECT route,collection_id,CASE WHEN route=$3 THEN $5::uuid ELSE account_id END AS curator,1 AS members
      FROM source
      UNION ALL SELECT $3,id,$5,250*$7::int FROM unnest($6::uuid[]) id
    )
    INSERT INTO library.collection
      (route,collection_id,curator_account_id,title,description,visibility,state,revision,member_count,
       order_epoch,created_at,updated_at,transaction_id)
    SELECT route,collection_id,curator,'Growth Collection',NULL,'public','active',1,members,
      0,$8::timestamptz,$8::timestamptz,collection_id FROM collections`,
    [...range, home, probes, scale, time],
  );
  await database.admin.query(
    `${source}, members AS (
      SELECT route,collection_id,member_id,account_id AS subject_id,'a0' AS ordinal_key FROM source
      UNION ALL
      SELECT $3,id,
        ('40000000-0000-7000-8000-' || lpad(to_hex($3::int),4,'0') ||
          lpad(to_hex($7::int*100000+p::int*5000+n),8,'0'))::uuid,
        $5::uuid,($8::text[])[n]
      FROM unnest($6::uuid[]) WITH ORDINALITY probe(id,p)
      CROSS JOIN generate_series(1,250*$7::int) n
    )
    INSERT INTO library.collection_member
      (route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id)
    SELECT route,collection_id,member_id,subject_id,NULL,ordinal_key,$9::timestamptz,member_id FROM members`,
    [...range, home, probes, scale, respacedKeys(250 * scale), time],
  );
  // Every Collection, including each probe, has the same owner role as a production create.
  const resources = `${source}, resources AS (
    SELECT route,collection_id,CASE WHEN route=$3 THEN $5::uuid ELSE account_id END AS curator FROM source
    UNION ALL SELECT $3,id,$5 FROM unnest($6::uuid[]) id
  )`;
  await database.admin.query(
    `${resources}
    INSERT INTO access.resource_initialization (route,resource_id,resource_type,creator_id,initialized_at)
    SELECT route,collection_id,'library.collection',curator,$7::timestamptz FROM resources`,
    [...range, home, probes, time],
  );
  await database.admin.query(
    `${resources}
    INSERT INTO access.resource_role_grant
      (route,resource_id,subject_id,grant_role,valid,transaction_id)
    SELECT route,collection_id,curator,'library.collection.owner','(,)',collection_id FROM resources`,
    [...range, home, probes],
  );
  await database.admin.query(
    `${source}
    INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
    SELECT route,collection_id,CASE WHEN route=$3 THEN $5::uuid ELSE account_id END,$6,'(,)',member_id
    FROM source`,
    [
      ...range,
      home,
      kind === 'library.collection.delete'
        ? 'collection:delete'
        : kind === 'library.collection.read'
          ? 'collection:read'
          : 'collection:update',
    ],
  );
  await database.admin.query(
    `${source}
    INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
    SELECT route,collection_id,account_id,$5,'resource','(,)',member_id FROM source`,
    [
      ...range,
      kind === 'library.collection.delete'
        ? 'collection:delete'
        : kind === 'library.collection.read'
          ? 'collection:read'
          : 'collection:update',
    ],
  );
  await database.admin.query(
    `${source}
    INSERT INTO core.receipt
      (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,
       position,transaction_id,response)
    SELECT partition_no,'account',CASE WHEN route=$3 THEN $5::uuid ELSE account_id END,$6,
      'seed-'||n,decode(repeat('00',32),'hex'),1,n*100,member_id,'{}'::jsonb FROM source`,
    [...range, home, kind],
  );
  await database.admin.query(
    `${source}
    INSERT INTO editorial.write_basis
      (partition_no,principal_kind,principal_id,client_id,epoch,position,transaction_id)
    SELECT partition_no,'account',CASE WHEN route=$3 THEN $5::uuid ELSE account_id END,'web',1,n*100,member_id
    FROM source`,
    [...range, home],
  );
  await database.admin.query(
    `${source}
    INSERT INTO core.outbox
      (partition_no,position,event_seq,event_count,epoch,id,type,subject,data,recorded_at)
    SELECT partition_no,n*100,0,1,1,member_id,'com.rezics.library.collection.updated.v1',collection_id::text,
      '{}'::jsonb,$5::timestamptz FROM source`,
    [...range, time],
  );
  await database.admin.query(
    `UPDATE core.partition SET position=GREATEST(position,$1) WHERE partition_no=ANY($2::int[])`,
    [500 * scale * 100, [partitionOf(route), partitionOf(otherRoute)]],
  );
}

async function runCheck(name: string, operation: Operation) {
  const { actor, commands, reads } = await prepare();
  const kind = {
    delete: 'library.collection.delete',
    note: 'library.collection.member.note',
    remove: 'library.collection.member.remove',
    read: 'library.collection.read',
  }[operation];
  let probes: string[] = [];
  let probe = 0;
  let measuredRuns = 0;
  const diagnostics: { scale: number; plans: unknown[] }[] = [];
  const invoke = async (_database: GrowthDatabase, scale: number) => {
    const id = probes[probe++]!;
    const key = randomUUID();
    const memberId = `40000000-0000-7000-8000-${route.toString(16)}${(scale * 100000 + probe * 5000 + 1).toString(16).padStart(8, '0')}`;
    const plans: unknown[] = [];
    observedPlans = plans;
    try {
      if (operation === 'delete') {
        const result = await commands.deleteCollection(actor, id, 1, key);
        expect(result.value).toMatchObject({ id, state: 'deleted', memberCount: 250 * scale });
      } else if (operation === 'note') {
        const result = await commands.updateMemberNote(actor, id, memberId, { note: 'Kept' }, key);
        expect(result.value).toMatchObject({ id: memberId, note: 'Kept' });
      } else if (operation === 'remove') {
        const result = await commands.removeMember(actor, id, memberId, key);
        expect(result.value.id).toBe(memberId);
      } else {
        expect(await reads.readCollection(actor, id)).toMatchObject({ id, revision: 1, memberCount: 250 * scale });
      }
      // Warm-ups have no auto_explain plans; measured runs must each use library indexes.
      if (plans.length) {
        measuredRuns++;
        const cost = costOf({ statements: [], plans });
        expect(cost.relations['library.collection']?.nodes).toBeGreaterThan(0);
        for (const [relation, value] of Object.entries(cost.relations))
          if (relation.startsWith('library.')) expect(value.sequentialScans, `${name}: ${relation}`).toBe(0);
        if (!diagnostics.some((sample) => sample.scale === scale)) diagnostics.push({ scale, plans });
      }
    } finally {
      observedPlans = undefined;
    }
  };
  try {
    const report = await checkGrowth(database, {
      name,
      scales: [1, 4, 16],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        // One spare for the default warm-up and five identical probes for the default measured repetitions.
        probes = Array.from({ length: 6 }, () => newId(route));
        probe = 0;
        await grow(scale, previous, actor, probes, kind);
      },
      operation: invoke,
      warmup: invoke,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 4, 16]);
    expect(measuredRuns).toBe(15);
    console.log(
      JSON.stringify({
        check: name,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      }),
    );
  } catch (error) {
    if (error instanceof GrowthBoundError)
      console.error(JSON.stringify({ message: error.message, samples: error.samples, diagnostics }));
    throw error;
  }
}

test('Delete Collection has constant rows and statements as collections and its members grow', async () => {
  await runCheck('Delete Collection', 'delete');
}, 120_000);

test("Note member has constant rows and statements as collections and its Collection's members grow", async () => {
  await runCheck('Note member', 'note');
}, 120_000);

test("Remove member has constant rows and statements as collections and its Collection's members grow", async () => {
  await runCheck('Remove member', 'remove');
}, 120_000);

test('Collection read has constant rows and statements as collections and its members grow', async () => {
  await runCheck('Collection read', 'read');
}, 120_000);
