import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { bundledRelease, bundledDigest } from '@rezics/definitions/bundled';
import { mintReadTime, principalCommandIdentity } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import {
  preparationHeaderCommitment,
  type PreparationHeaderCommitment,
} from '../../src/library/preparation-bindings.ts';
import { readPreparationNativeHeader } from '../../src/library/preparation-native-reader.ts';
import { createShelfTypeSource } from '../../src/library/shelf-type-source.ts';
import { accessCheck } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
let header: PreparationHeaderCommitment;
const route = 0x6a10,
  accountId = newId(route),
  preparationId = newId(route);
const request = { route, accountId, preparationId };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (client: Pick<PoolClient, 'query'> = db.admin, h = header) => readPreparationNativeHeader(client, h);
async function insert(client: Pick<PoolClient, 'query'>, h: PreparationHeaderCommitment, commitment: string) {
  const row = Object.fromEntries(
    Object.entries(h)
      .filter(([key]) => key !== 'version')
      .map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]),
  );
  row.binding_digest = hash(canonicalize(h.binding)!);
  row.input_digest = `\\x${h.inputDigest}`;
  row.creation_commitment = commitment;
  await client.query(
    `INSERT INTO library.type_preparation_header
    SELECT (jsonb_populate_record(NULL::library.type_preparation_header, $1)).*`,
    [JSON.stringify(row)],
  );
}
async function rollback(body: (client: PoolClient) => Promise<void>) {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  const actions = ['subject:create', 'subject:read', 'library_entry:update'];
  const real = await createRealAccess(db.admin, { owner: accountId }, actions);
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  const context = { route: 0, id: GLOBAL_CONTEXT };
  await real.grant(context, 'owner', 'subject:create');
  const actor = await access.authenticate(real.bearer('owner'), { pool: db.pool, deadline: deadlineFor(60_000) });
  await bootstrapRelease(db.pool, bundledRelease);
  const check = await accessCheck(access, actor, 'subject:create', context, {
    pool: db.pool,
    deadline: deadlineFor(5_000),
  });
  const subjectId = newId(0x7b20),
    key = randomUUID();
  await createSubject(db.pool, {
    actor,
    target: { route: 0x7b20, id: subjectId },
    item: { type: 'schema:Book', labels: { en: 'Native preparation provenance' } },
    release: { release: bundledRelease, digest: bundledDigest },
    idempotencyKey: key,
    digest: Buffer.from(hash(key), 'hex'),
    authorize: check,
  });
  await real.grant({ route: 0x7b20, id: subjectId }, 'owner', 'subject:read');
  const subjectCheck = await accessCheck(
    access,
    actor,
    'subject:read',
    { route: 0x7b20, id: subjectId },
    { pool: db.pool, deadline: deadlineFor(5_000) },
  );
  const source = createShelfTypeSource();
  // This fixture exercises the provenance seam, not a product preparation producer.
  const observation = await withReadTransaction(db.pool, async (client) => {
    if (!(await subjectCheck(client, await mintReadTime(client)))) throw new Error('Source unavailable');
    const stamp = (await source.readPartition(client, partitionOf(0x7b20)))!;
    const type = (await source.readItemTypes(client, [subjectId])).get(subjectId)!;
    const redirect = await source.readSurvivor(client, subjectId);
    const revision = (
      await client.query(
        `SELECT revision, recorded_transaction_id AS "transactionId"
      FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND kind IN ('create','identity')
      ORDER BY revision DESC LIMIT 1`,
        [0x7b20, subjectId],
      )
    ).rows[0]!;
    return {
      stamp,
      type,
      identity: {
        sourceId: subjectId,
        partition: stamp.partitionNo,
        epoch: stamp.epoch,
        revision: revision.revision as number,
        transactionId: revision.transactionId as string,
        redirect,
      },
    };
  });
  const principalNamespace = principalCommandIdentity(actor);
  const kind = 'library.type-preparation.create',
    receiptKey = `type-preparation:${preparationId}:create`;
  const input = { preparationId, subjectId };
  const digest = hash(canonicalize([principalNamespace, kind, input])!);
  await createLibraryCommandRunner({ pool: db.pool }).ownAccount(
    actor,
    { action: 'library_entry:update', kind, requestKey: receiptKey, input },
    async (client, command) => {
      header = {
        version: 1,
        ...request,
        binding: {
          accountId,
          subjectId,
          requestKey: key,
          sourceId: subjectId,
          sourcePartition: observation.stamp.partitionNo,
          sourceEpoch: observation.stamp.epoch,
          sourcePosition: observation.stamp.position.toString(),
          ownerEpoch: '0',
        },
        origin: {
          sourceId: subjectId,
          partition: observation.stamp.partitionNo,
          epoch: observation.stamp.epoch,
          position: observation.stamp.position.toString(),
          survivorId: null,
        },
        sourceIdentity: observation.identity,
        originIdentity: observation.identity,
        principalNamespace,
        reservationId: null,
        inputByteLength: Buffer.byteLength(observation.type).toString(),
        inputDigest: hash(observation.type),
        creationTransactionId: command.transactionId,
        creationReceipt: {
          partition: partitionOf(route),
          principalKind: 'account',
          principalId: accountId,
          commandKind: kind,
          key: receiptKey,
          digest,
        },
        createdAt: '2026-10-28T01:02:03.123456Z',
      };
      const metadataCommitment = preparationHeaderCommitment(header);
      await insert(client, header, metadataCommitment);
      return {
        value: { preparationId, metadataCommitment },
        events: [{ type: 'com.rezics.library.subject.listed.v1', subject: accountId, data: { subjectId } }],
      };
    },
  );
  expect(real.checks.some((c) => c.action === 'subject:create')).toBe(true);
  expect(real.readChecks.some((c) => c.action === 'subject:read')).toBe(true);
});
afterAll(async () => {
  await db?.close();
});
function leaves(value: object, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' ? leaves(value, [...prefix, key]) : [[...prefix, key]],
  );
}
function changed(value: unknown): unknown {
  if (value === null) return newId(route);
  if (typeof value === 'number') return value + 1;
  if (typeof value !== 'string') throw new Error('Unexpected leaf');
  if (routeOf(value) !== null) return newId(routeOf(value)!);
  if (/^[0-9a-f]{64}$/.test(value)) return 'f'.repeat(64);
  if (/^\d+$/.test(value)) return (BigInt(value) + 1n).toString();
  if (value.endsWith('Z')) return value.replace('123456', '123457');
  return `${value}-changed`;
}
test('native preparation creator proof binds every immutable header field', async () => {
  const commitment = preparationHeaderCommitment(header);
  expect(await read()).toEqual({ ...header, creationCommitment: commitment });
  for (const path of leaves(header).filter((path) => path[0] !== 'version'))
    await rollback(async (client) => {
      const h = structuredClone(header);
      let parent = h as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      parent[path.at(-1)!] = changed(parent[path.at(-1)!]);
      if (path[0] === 'route') {
        Object.assign(h, { accountId: newId(h.route), preparationId: newId(h.route) });
      }
      await client.query(
        'DELETE FROM library.type_preparation_header WHERE route=$1 AND account_id=$2 AND preparation_id=$3',
        [route, accountId, preparationId],
      );
      // Even an attacker able to recompute a valid local hash cannot replace the actual creator proof.
      let forgedCommitment = commitment;
      try {
        forgedCommitment = preparationHeaderCommitment(h);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      await insert(client, h, forgedCommitment);
      expect(await read(client, h), path.join('.')).toBeNull();
    });
  for (const assignment of [
    "creation_commitment=repeat('f',64)",
    'binding=binding || \'{"extra":true}\'::jsonb',
    "source_identity='{}'::jsonb",
    "principal_namespace='{}'::jsonb",
  ])
    await rollback(async (client) => {
      await client.query(
        'ALTER TABLE library.type_preparation_header DISABLE TRIGGER type_preparation_header_immutable',
      );
      await client.query(`UPDATE library.type_preparation_header SET ${assignment}`);
      expect(await read(client)).toBeNull();
    });
  await rollback(async (client) => {
    await client.query(
      'ALTER TABLE library.type_preparation_header DROP CONSTRAINT type_preparation_header_identity_check',
    );
    await client.query('ALTER TABLE library.type_preparation_header DISABLE TRIGGER type_preparation_header_immutable');
    await client.query('UPDATE library.type_preparation_header SET source_identity=NULL, origin_identity=NULL');
    expect(await read(client)).toBeNull();
  });
  for (const assignment of [
    "request_digest=decode(repeat('f',64),'hex')",
    `transaction_id='${newId(route)}'`,
    "response='{}'::jsonb",
    `response=jsonb_set(response,'{preparationId}','\"${newId(route)}\"')`,
    "response=jsonb_set(response,'{metadataCommitment}','\"wrong\"')",
    "response='null'::jsonb",
    "command_kind='wrong'",
    "idempotency_key='copied'",
    `partition_no=${partitionOf(route) + 1}`,
    `principal_id='${newId(route)}'`,
    `principal_kind='anonymous',principal_id='00000000-0000-0000-0000-000000000000',idempotency_key='${randomUUID()}'`,
  ])
    await rollback(async (client) => {
      await client.query(`UPDATE core.receipt SET ${assignment} WHERE command_kind='library.type-preparation.create'`);
      expect(await read(client), assignment).toBeNull();
    });
  await rollback(async (client) => {
    await client.query("DELETE FROM core.receipt WHERE command_kind='library.type-preparation.create'");
    expect(await read(client)).toBeNull();
  });
  for (const table of ['library.type_preparation_header', 'core.receipt'])
    await rollback(async (client) => {
      await client.query(`ALTER TABLE ${table} RENAME TO unavailable_proof`);
      await expect(read(client)).rejects.toThrow();
    });
  let queries = 0;
  const unavailable = {
    async query() {
      queries++;
      throw new Error('SQL unavailable');
    },
  } as Pick<PoolClient, 'query'>;
  for (const invalid of [
    { ...request, route: -1 },
    { ...request, accountId: newId(0x7b20) },
    { ...request, preparationId: 'bad' },
  ])
    await expect(readPreparationNativeHeader(unavailable, invalid)).rejects.toThrow();
  expect(queries).toBe(0);
});
test('preparation creator verification stays bounded behind metadata history', async () => {
  const report = await checkGrowth(db, {
    name: 'native preparation creator proof',
    scales: [256, 1024, 4096],
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      await db.admin.query(
        `WITH headers AS (
          INSERT INTO library.type_preparation_header
          SELECT route,account_id,('10000000-0000-7000-8000-6a10'||lpad(to_hex(n),8,'0'))::uuid,
            lpad(to_hex(n),64,'0'),binding,origin,principal_namespace,reservation_id,input_byte_length,input_digest,
            creation_transaction_id,creation_receipt,creation_commitment,created_at,source_identity,origin_identity
          FROM library.type_preparation_header, generate_series($1::int+1,$2::int) n
          WHERE route=$3 AND account_id=$4 AND preparation_id=$5 RETURNING route,account_id,binding_digest,preparation_id
        ), slots AS (
          INSERT INTO library.type_preparation_slot SELECT * FROM headers
        ), reservations AS (
          INSERT INTO library.shelf_type_reservation
          SELECT route,account_id,preparation_id,repeat('noise',8192),decode(repeat('f',64),'hex'),
            preparation_id,preparation_id,0,preparation_id,preparation_id FROM headers
        ), receipts AS (
          INSERT INTO core.receipt (partition_no,principal_kind,principal_id,command_kind,idempotency_key,
            request_digest,epoch,position,transaction_id,response)
          SELECT partition_no,principal_kind,principal_id,command_kind,'noise-'||n,
            request_digest,epoch,position,transaction_id,response FROM core.receipt,
            generate_series($1::int+1,$2::int) n WHERE partition_no=$6 AND principal_kind='account'
            AND principal_id=$4 AND command_kind='library.type-preparation.create' AND idempotency_key=$7
        ) INSERT INTO semantic.revision (route,subject_id,revision,kind,release,recorded_transaction_id)
          SELECT route,subject_id,n+1,'adopt',release,recorded_transaction_id FROM semantic.revision,
            generate_series($1::int+1,$2::int) n WHERE route=$8 AND subject_id=$9 AND revision=1`,
        [
          previous,
          scale,
          route,
          accountId,
          preparationId,
          partitionOf(route),
          header.creationReceipt.key,
          routeOf(header.binding.sourceId),
          header.binding.sourceId,
        ],
      );
    },
    async operation() {
      expect(await read(db.pool)).toEqual({ ...header, creationCommitment: preparationHeaderCommitment(header) });
    },
  });
  expect(Object.values(report.shadow).every(({ outcome }) => outcome === 'compatible')).toBe(true);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(2);
    expect(cost.rows).toBe(2);
    expect(Object.keys(cost.relations).sort()).toEqual(['core.receipt', 'library.type_preparation_header']);
  }
}, 300_000);
