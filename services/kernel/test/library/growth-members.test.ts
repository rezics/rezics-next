import { afterAll, expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg, { type Pool } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { respacedKeys } from '../../src/library/ordinal.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [1, 4, 16] as const;
const runsPerScale = 6;
const membersPerScale = 250;
const relationRowsPerScale = 500;
const timestamp = '2026-10-26T12:00:00.000Z';
const curatorScopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'subject:read',
];
const routeKey = new Uint8Array(32).fill(92);
const databasePromise = openGrowthDatabase(databaseUrl);

let growth: GrowthDatabase | undefined;
let restoreCommandPool: (() => void) | undefined;
let commandPool: Pool | undefined;

afterAll(async () => {
  restoreCommandPool?.();
  if (growth) await growth.close();
});

function uuid(prefix: string, route: number, serial: number): string {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${serial.toString(16).padStart(8, '0')}`;
}

function sqlUuid(prefix: string, route: string, serial: string): string {
  return `('${prefix}-0000-7000-8000-' || lpad(to_hex(${route}::int), 4, '0') || lpad(to_hex(${serial}::bigint), 8, '0'))::uuid`;
}

function routeExpression(ordinal: string, hotPartition = '$1::int', ownCount = '$4::int'): string {
  return `CASE WHEN ${ordinal} <= ${ownCount} THEN ${hotPartition} * 16 + ((${ordinal} - 1) % 16)
    ELSE (((${hotPartition} + 1 + ((${ordinal} - ${ownCount} - 1) % 4095)) % 4096) * 16 + ((${ordinal} - 1) % 16)) END`;
}

function sourceCte(): string {
  const route = routeExpression('n');
  const serial = '$5::int + $2::int * 1000 + n::int';
  return `source AS (
    SELECT n, ${route} AS route, (${route}) >> 4 AS partition_no,
           ${serial} AS serial,
           ${sqlUuid('10000000', route, serial)} AS collection_id,
           ${sqlUuid('20000000', route, serial)} AS account_id,
           ${sqlUuid('30000000', route, `$5::bigint + 500000000 + $2::bigint * 1000 + n::bigint`)} AS member_id,
           ${sqlUuid('50000000', route, `$5::bigint + 1000000000 + $2::bigint * 1000 + n::bigint`)} AS group_id,
           ${sqlUuid('60000000', route, `$5::bigint + 2000000000 + $2::bigint * 1000 + n::bigint`)} AS reservation_id
    FROM generate_series(1, 1000 * ($3::int - $2::int)) AS n
  )`;
}

function installCommandPoolCapture(database: GrowthDatabase): () => void {
  // Collection commands create a private writer pool. Borrowing from this instrumented pool keeps the whole command
  // envelope in the growth capture while preserving the command implementation's separate checkout.
  const pgExports = pg as unknown as { Pool: typeof pg.Pool };
  const originalPool = pgExports.Pool;
  const originalConnect = originalPool.prototype.connect;
  const routed = new WeakSet<object>();
  let routeNextPool = true;
  const proxyPool = new Proxy(originalPool, {
    construct(target, args, newTarget) {
      const created = Reflect.construct(target, args, newTarget) as Pool;
      if (routeNextPool && (args[0] as pg.PoolConfig | undefined)?.connectionString === database.url) {
        routed.add(created);
        routeNextPool = false;
      }
      return created;
    },
  });
  (originalPool.prototype as unknown as { connect: typeof originalPool.prototype.connect }).connect = function (
    this: Pool,
    ...args: Parameters<Pool['connect']>
  ) {
    if (routed.has(this)) return commandPool!.connect(...args);
    return originalConnect.apply(this, args);
  } as Pool['connect'];
  pgExports.Pool = proxyPool;
  return () => {
    pgExports.Pool = originalPool;
    (originalPool.prototype as unknown as { connect: typeof originalPool.prototype.connect }).connect = originalConnect;
  };
}

async function insertAccount(target: Pool, accountId: string): Promise<void> {
  await target.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
    [routeOf(accountId), accountId],
  );
}

async function authenticate(
  access: ReturnType<typeof createAccess>,
  target: Pool,
  accountId: string,
): Promise<AccountActor> {
  const token = await new SignJWT({
    client_id: 'web',
    scope: curatorScopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'library', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing!.privateKey);
  return access.authenticate(token, { pool: target, deadline: Date.now() + 290_000 });
}

let signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined;

async function prepareGrowth(operation: 'add' | 'move'): Promise<{
  database: GrowthDatabase;
  actor: AccountActor;
  actorRoute: number;
  hotPartition: number;
  base: number;
  subjectId: string;
  collectionIds: string[];
  moveMemberIds: string[];
  collectionCommands: ReturnType<typeof createCollectionCommands>;
}> {
  growth ??= await databasePromise;
  const database = growth;
  if (!commandPool) {
    commandPool = database.openPool({ max: 4, connectionTimeoutMillis: 5_000 });
    restoreCommandPool = installCommandPoolCapture(database);
  }

  signing ??= await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'library', alg: 'ES256' };
  const access = createAccess({
    actions: new Map([
      ['collection:create', { anonymous: false, 'x-resource-types': ['library.collection'] }],
      ['collection:read', { anonymous: false }],
      ['collection:update', { anonymous: false }],
      ['collection:delete', { anonymous: false }],
      ['subject:read', { anonymous: true }],
    ]),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  const actorRoute = randomInt(1, 4095) * 16 + randomInt(0, 16);
  const actorAccountId = newId(actorRoute);
  await insertAccount(database.admin, actorAccountId);
  const actor = await authenticate(access, database.pool, actorAccountId);
  await bootstrapRelease(database.pool, bundledRelease);
  const subjectKey = `growth-members-subject-${randomUUID()}`;
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, subjectKey),
    idempotencyKey: subjectKey,
    digest: createHash('sha256').update(subjectKey).digest(),
    item: { type: 'schema:Book', labels: { en: 'Growth subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  const subjectId = subject.subject.id;
  const collectionCommands = createCollectionCommands({ pool: database.pool, access });
  const collectionIds: string[] = [];
  for (let probe = 0; probe < scales.length * runsPerScale; probe += 1) {
    const created = await collectionCommands.createCollection(
      actor,
      { title: `${operation} growth probe ${probe}`, visibility: 'private' },
      `growth-members-${operation}-${randomUUID()}`,
    );
    collectionIds.push(created.value.id);
  }
  const base = randomInt(0x01000000, 0x50000000);
  const hotPartition = partitionOf(actorRoute);
  const actorPartition = await database.admin.query<{ position: string }>(
    'SELECT position::text AS position FROM core.partition WHERE partition_no = $1',
    [hotPartition],
  );
  if (!actorPartition.rows[0]) throw new Error(`Missing core partition ${hotPartition}`);
  const startPosition = BigInt(actorPartition.rows[0].position);
  await database.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
    hotPartition,
    startPosition.toString(),
  ]);
  const moveMemberIds = collectionIds.map((_, probe) =>
    uuid('30000000', actorRoute, base + 400_000 + probe * 5_000 + membersPerScale * scales.at(-1)!),
  );
  return {
    database,
    actor,
    actorRoute,
    hotPartition,
    base,
    subjectId,
    collectionIds,
    moveMemberIds,
    collectionCommands,
  };
}

async function growLibraryRelations(
  database: GrowthDatabase,
  scale: number,
  previous: number,
  fixture: Awaited<ReturnType<typeof prepareGrowth>>,
): Promise<void> {
  const source = sourceCte();
  const shared = [fixture.hotPartition, previous, scale, relationRowsPerScale * (scale - previous), fixture.base];
  const time = timestamp;

  await database.admin.query(
    `WITH ${source}
     INSERT INTO library.collection
       (route, collection_id, curator_account_id, title, description, visibility, state, revision, member_count,
        order_epoch, created_at, updated_at, transaction_id)
     SELECT route, collection_id, account_id, 'Growth data', NULL, 'private', 'active', 1, 1, 0,
            $6::timestamptz, $6::timestamptz, collection_id
     FROM source`,
    [...shared, time],
  );

  await database.admin.query(
    `WITH ${source}
     INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch,
        membership_inverse_complete)
     SELECT route, account_id, 'actor', 'active', account_id, false, 1, true FROM source`,
    shared,
  );

  await database.admin.query(
    `WITH ${source}
     INSERT INTO access.membership_inverse
       (route, account_id, kind, group_id, reservation_id, transaction_id)
     SELECT route, account_id, 'organization', group_id, reservation_id, account_id FROM source`,
    shared,
  );

  await database.admin.query(
    `WITH ${source}
     INSERT INTO access.resource_grant
       (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     SELECT route, collection_id, $6::uuid, '', 'collection:update',
            tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), collection_id
     FROM source`,
    [...shared, fixture.actor.accountId],
  );

  await database.admin.query(
    `WITH ${source}
     INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     SELECT route, collection_id, 'identity', $6::uuid, '', 'library.collection.owner',
            tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), collection_id
     FROM source`,
    [...shared, fixture.actor.accountId],
  );

  await database.admin.query(
    `WITH ${source}
     INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     SELECT route, collection_id, $6::uuid, '', 'collection:update', 'resource',
            tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), collection_id
     FROM source`,
    [...shared, fixture.actor.accountId],
  );

  const group = Math.floor(scales.indexOf(scale as (typeof scales)[number]) * runsPerScale);
  const targetCollections = fixture.collectionIds.slice(group, group + runsPerScale);
  const targetProbeNumbers = Array.from({ length: runsPerScale }, (_, index) => group + index);
  const targetMemberCount = scale * membersPerScale;
  const ordinalKeys = respacedKeys(targetMemberCount);
  const probeSource = `probe AS (
    SELECT collection_id, probe_no
    FROM unnest($7::uuid[], $8::int[]) AS targets(collection_id, probe_no)
  ), probe_members AS (
    SELECT ${fixture.actorRoute}::int AS route, probe.collection_id,
           ${sqlUuid('30000000', `${fixture.actorRoute}`, `$9::bigint + 400000 + probe.probe_no * 5000 + member_no::int`)} AS member_id,
           $10::uuid AS subject_id, ordinal_keys.ordinal_key, probe.probe_no
    FROM probe CROSS JOIN generate_series(1, $11::int) AS generated(member_no)
    JOIN unnest($12::text[]) WITH ORDINALITY AS ordinal_keys(ordinal_key, key_no) ON ordinal_keys.key_no = member_no
  )`;
  await database.admin.query(
    `WITH ${source}, ${probeSource}
     INSERT INTO library.collection_member
       (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
     SELECT route, collection_id, member_id, $10::uuid, NULL, 'a0000', $6::timestamptz, member_id
     FROM source
     UNION ALL
     SELECT route, collection_id, member_id, subject_id, NULL, ordinal_key, $6::timestamptz, member_id
     FROM probe_members`,
    [
      ...shared,
      time,
      targetCollections,
      targetProbeNumbers,
      fixture.base,
      fixture.subjectId,
      targetMemberCount,
      ordinalKeys,
    ],
  );
  await database.admin.query(
    `UPDATE library.collection SET member_count = $2::int * $3::int
     WHERE collection_id = ANY($1::uuid[])`,
    [targetCollections, scale, membersPerScale],
  );
}

async function growCommandRelations(
  database: GrowthDatabase,
  scale: number,
  previous: number,
  fixture: Awaited<ReturnType<typeof prepareGrowth>>,
  commandKind: string,
): Promise<void> {
  const count = relationRowsPerScale * (scale - previous);
  const current = await database.admin.query<{ position: string; epoch: number }>(
    'SELECT position::text AS position, epoch FROM core.partition WHERE partition_no = $1',
    [fixture.hotPartition],
  );
  const state = current.rows[0];
  if (!state) throw new Error(`Missing core partition ${fixture.hotPartition}`);
  const firstPosition = BigInt(state.position);

  await database.admin.query(
    `INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT $1::int, $2::bigint + n, 0, 1, $3::int,
            ${sqlUuid('70000000', `${fixture.actorRoute}`, `$4::bigint + $2::bigint * 500 + n::bigint`)},
            'com.rezics.library.collection.member.changed.v1', $5::text,
            jsonb_build_object('collectionId', $5::text, 'memberId', $6::text, 'subjectId', $7::text)
     FROM generate_series(1, $8::int) AS n`,
    [
      fixture.hotPartition,
      firstPosition.toString(),
      state.epoch,
      fixture.base + 1_800_000_000,
      fixture.collectionIds[0],
      fixture.moveMemberIds[0],
      fixture.subjectId,
      count,
    ],
  );
  await database.admin.query(
    `INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by)
       SELECT $1::int, ${sqlUuid('80000000', `${fixture.actorRoute}`, `$2::bigint + $3::bigint * 500 + n::bigint`)},
            $4::int, $5::bigint + n, 'account', $6::uuid, $7::text, NULL
     FROM generate_series(1, $8::int) AS n`,
    [
      fixture.hotPartition,
      fixture.base + 2_500_000_000,
      previous,
      state.epoch,
      firstPosition.toString(),
      fixture.actor.accountId,
      fixture.actor.clientId,
      count,
    ],
  );
  await database.admin.query(
    `INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
        epoch, position, transaction_id, response)
     SELECT $1::int, 'account', $2::uuid, $3::text,
            'growth-members-seed-' || $4::text || '-' || ($5::int * 500 + n)::text,
            decode(repeat('07', 32), 'hex'), $6::int, $7::bigint + n,
            ${sqlUuid('80000000', `${fixture.actorRoute}`, `$8::bigint + $5::bigint * 500 + n::bigint`)},
            '{"ok":true}'::jsonb
     FROM generate_series(1, $9::int) AS n`,
    [
      fixture.hotPartition,
      fixture.actor.accountId,
      commandKind,
      fixture.base,
      previous,
      state.epoch,
      firstPosition.toString(),
      fixture.base + 2_500_000_000,
      count,
    ],
  );
  await database.admin.query('UPDATE core.partition SET position = $2::bigint + $3::int WHERE partition_no = $1', [
    fixture.hotPartition,
    firstPosition.toString(),
    count,
  ]);
}

async function grow(
  database: GrowthDatabase,
  scale: number,
  previous: number,
  fixture: Awaited<ReturnType<typeof prepareGrowth>>,
  commandKind: string,
): Promise<void> {
  await growLibraryRelations(database, scale, previous, fixture);
  await growCommandRelations(database, scale, previous, fixture, commandKind);
}

async function assertFittingPath(database: GrowthDatabase, collectionId: string): Promise<void> {
  const epoch = await database.admin.query<{ order_epoch: number }>(
    'SELECT order_epoch FROM library.collection WHERE collection_id = $1::uuid',
    [collectionId],
  );
  expect(epoch.rows[0]?.order_epoch).toBe(0);
}

function assertLibraryAccess(report: Awaited<ReturnType<typeof checkGrowth>>): void {
  for (const sample of report.samples) {
    const relationNames = Object.keys(sample.cost.relations ?? {});
    expect(relationNames, `${report.name} at scale ${sample.scale}`).toContain('library.collection');
    expect(relationNames, `${report.name} at scale ${sample.scale}`).toContain('library.collection_member');
    for (const [relation, cost] of Object.entries(sample.cost.relations ?? {})) {
      if (relation.startsWith('library.')) expect(cost.sequentialScans, `${relation} at ${sample.scale}`).toBe(0);
    }
  }
}

function reportSamples(report: Awaited<ReturnType<typeof checkGrowth>>): void {
  console.log(
    JSON.stringify({
      check: report.name,
      samples: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      })),
    }),
  );
}

test('Add member with a fitting key has constant rows and statements as its Collection and unrelated data grow', async () => {
  const fixture = await prepareGrowth('add');
  const report = await checkGrowth(fixture.database, {
    name: 'Add member with a fitting key',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, fixture, 'library.collection.member.add'),
    operation: async (_database, _scale, repetition) => {
      const collectionId = fixture.collectionIds[repetition]!;
      await fixture.collectionCommands.addMember(
        fixture.actor,
        collectionId,
        { subjectId: fixture.subjectId, after: null },
        `growth-members-add-${randomUUID()}`,
      );
      await assertFittingPath(fixture.database, collectionId);
    },
  });
  assertLibraryAccess(report);
  reportSamples(report);
}, 180_000);

test('Move member with a fitting key has constant rows and statements as its Collection and unrelated data grow', async () => {
  const fixture = await prepareGrowth('move');
  const report = await checkGrowth(fixture.database, {
    name: 'Move member with a fitting key',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => grow(database, scale, previous, fixture, 'library.collection.member.move'),
    operation: async (_database, scale, repetition) => {
      const collectionId = fixture.collectionIds[repetition]!;
      const memberId = uuid(
        '30000000',
        fixture.actorRoute,
        fixture.base + 400_000 + repetition * 5_000 + scale * membersPerScale,
      );
      await fixture.collectionCommands.moveMember(
        fixture.actor,
        collectionId,
        memberId,
        { after: null },
        `growth-members-move-${randomUUID()}`,
      );
      await assertFittingPath(fixture.database, collectionId);
    },
  });
  assertLibraryAccess(report);
  reportSamples(report);
}, 180_000);
