import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { principalCommandIdentity } from '../../src/command/command.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readLikedMembership, readLikedSubjectPage, readLikedVersion } from '../../src/content/liked-read.ts';
import likedPage from '../../src/content/liked-page.sql';
import likedVersion from '../../src/content/liked-version.sql';
import { measure } from '../support/growth.ts';
import { reactionFixture, request } from './reactions.test.ts';

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');

beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
  await bootstrapRelease(f.db.pool, bundledRelease);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function subject(route: number, label: string): Promise<string> {
  const id = newId(route);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  await f.grant(id, ['reaction:set']);
  return id;
}

async function react(
  targetKind: 'subject' | 'thread' | 'post',
  targetId: string,
  kind: Parameters<typeof commands.setReaction>[2]['kind'],
): Promise<void> {
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(),
    { targetKind, targetId, kind },
    request(),
  );
}

async function withClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await f.db.pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

// Compare every stored column except generated keys and timestamps. The first seeded
// pair reuses the command targets, so event payloads and request digests also compare exactly.
async function distractorShape(targetId: string, transactionId: string): Promise<unknown> {
  const result = await f.db.admin.query<{ shape: unknown }>(
    `SELECT jsonb_build_object(
       'reaction', to_jsonb(r) - ARRAY['target_id', 'updated_at'],
       'outbox', to_jsonb(o) - ARRAY['position', 'id', 'recorded_at'],
       'receipt', to_jsonb(c) - ARRAY['idempotency_key', 'position', 'transaction_id', 'created_at'],
       'basis', to_jsonb(b) - ARRAY['transaction_id', 'position', 'recorded_at'],
       'partition', to_jsonb(p) - 'position'
     ) AS shape
     FROM content.reaction r
     JOIN core.receipt c ON c.partition_no=$1 AND c.transaction_id=$4
     JOIN core.outbox o ON o.partition_no=c.partition_no AND o.position=c.position
     JOIN editorial.write_basis b ON b.partition_no=c.partition_no AND b.transaction_id=c.transaction_id
     JOIN core.partition p ON p.partition_no=c.partition_no
     WHERE r.route=$2 AND r.actor_account_id=$3 AND r.target_id=$5`,
    [partitionOf(f.home), f.home, f.accountId, transactionId, targetId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.shape;
}

async function distractorTemplates() {
  const targets = await f.target();
  const actor = await f.verified();
  const templates = [];
  for (const [targetKind, kind] of [
    ['thread', 'like'],
    ['post', 'love'],
  ] as const) {
    const targetId = targets[targetKind];
    const result = await commands.setReaction(
      { pool: f.db.pool, access: f.access },
      actor,
      { targetKind, targetId, kind },
      request(),
    );
    if (!result) throw new Error('Expected a new distractor reaction');
    templates.push({
      targetId,
      targetKind,
      kind,
      transactionId: result.transactionId,
      identity: principalCommandIdentity(actor),
      shape: await distractorShape(targetId, result.transactionId),
    });
    await commands.clearReaction({ pool: f.db.pool, access: f.access }, actor, { targetKind, targetId }, request());
  }
  return templates;
}

async function addThreadAndPostReactions(
  count: number,
  templates: Awaited<ReturnType<typeof distractorTemplates>>,
  reuseTargets: boolean,
): Promise<void> {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, index) =>
    templates.map((template) => {
      const targetId = reuseTargets && index === 0 ? template.targetId : newId(f.targetRoute);
      const body = { targetKind: template.targetKind, targetId, kind: template.kind };
      return {
        ...body,
        templateTransactionId: template.transactionId,
        transactionId: Bun.randomUUIDv7(),
        eventId: Bun.randomUUIDv7(),
        key: crypto.randomUUID(),
        digest: createHash('sha256')
          .update(canonicalize([template.identity, 'content.reaction.set', body])!)
          .digest('hex'),
      };
    }),
  ).flat();
  const seed = await f.db.admin.connect();
  try {
    await seed.query('BEGIN');
    // Match the command fence, reserving one position for each reaction command.
    const fence = await seed.query<{ start: string }>(
      `UPDATE core.partition SET position=position+$2
       WHERE partition_no=$1 AND write_state='active'
       RETURNING (position-$2)::text AS start`,
      [partitionOf(f.home), rows.length],
    );
    expect(fence.rows).toHaveLength(1);
    const parameters = [JSON.stringify(rows), fence.rows[0]!.start, rows.length, f.home, f.accountId, f.targetRoute];
    const seeds = `WITH seeds AS (
      SELECT $1::jsonb -> i AS data, $2::bigint + i + 1 AS position
      FROM generate_series(0, $3::integer - 1) AS i
    )`;
    // Only the raw actor-partition rows are read here; the distractors need no target hydration.
    expect(
      (
        await seed.query(
          `${seeds}
       INSERT INTO content.reaction(route, actor_account_id, target_kind, target_route, target_id, kind, updated_at)
       SELECT $4, $5, data->>'targetKind', $6, (data->>'targetId')::uuid, data->>'kind', statement_timestamp()
       FROM seeds`,
          parameters,
        )
      ).rowCount,
    ).toBe(rows.length);
    expect(
      (
        await seed.query(
          `${seeds}
       INSERT INTO core.outbox(partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       SELECT o.partition_no, s.position, o.event_seq, o.event_count, o.epoch,
         (s.data->>'eventId')::uuid, o.type, s.data->>'targetId',
         jsonb_set(o.data, '{targetId}', s.data->'targetId')
       FROM seeds s
       JOIN core.receipt c ON c.partition_no=($4::integer >> 4)
         AND c.transaction_id=(s.data->>'templateTransactionId')::uuid
       JOIN core.outbox o ON o.partition_no=c.partition_no AND o.position=c.position`,
          parameters.slice(0, 4),
        )
      ).rowCount,
    ).toBe(rows.length);
    expect(
      (
        await seed.query(
          `${seeds}
       INSERT INTO editorial.write_basis(partition_no, transaction_id, epoch, position,
         principal_kind, principal_id, client_id, requested_by)
       SELECT b.partition_no, (s.data->>'transactionId')::uuid, b.epoch, s.position,
         b.principal_kind, b.principal_id, b.client_id, b.requested_by
       FROM seeds s
       JOIN editorial.write_basis b ON b.partition_no=($4::integer >> 4)
         AND b.transaction_id=(s.data->>'templateTransactionId')::uuid`,
          parameters.slice(0, 4),
        )
      ).rowCount,
    ).toBe(rows.length);
    expect(
      (
        await seed.query(
          `${seeds}
       INSERT INTO core.receipt(partition_no, principal_kind, principal_id, command_kind,
         idempotency_key, request_digest, epoch, position, transaction_id, response)
       SELECT c.partition_no, c.principal_kind, c.principal_id, c.command_kind,
         s.data->>'key', decode(s.data->>'digest', 'hex'), c.epoch, s.position,
         (s.data->>'transactionId')::uuid, jsonb_set(c.response, '{targetId}', s.data->'targetId')
       FROM seeds s
       JOIN core.receipt c ON c.partition_no=($4::integer >> 4)
         AND c.transaction_id=(s.data->>'templateTransactionId')::uuid`,
          parameters.slice(0, 4),
        )
      ).rowCount,
    ).toBe(rows.length);
    await seed.query('COMMIT');
  } catch (error) {
    await seed.query('ROLLBACK');
    throw error;
  } finally {
    seed.release();
  }
  if (reuseTargets) {
    for (const [index, template] of templates.entries()) {
      const row = rows[index]!;
      expect(await distractorShape(row.targetId, row.transactionId)).toEqual(template.shape);
    }
  }
}

async function likedPageSharedHitBlocks(after?: string): Promise<number> {
  const route = routeOf(f.accountId);
  if (route === null) throw new Error('Invalid fixture account id');
  const parameters = {
    route,
    actor_id: f.accountId,
    after: after ?? '00000000-0000-7000-8000-000000000000',
    limit: 3,
  };
  const plan = await f.db.admin.query<{ 'QUERY PLAN': Array<{ Plan: { 'Shared Hit Blocks': number } }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${likedPage.sql}`,
    likedPage.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const blocks = plan.rows[0]?.['QUERY PLAN'][0]?.Plan['Shared Hit Blocks'];
  if (blocks === undefined) throw new Error('The liked page plan did not report shared hit blocks');
  return blocks;
}

test('the liked page reads current like and love subject reactions in subject id order with a keyset cursor', async () => {
  const subjects = await Promise.all([
    subject(0x4231, 'Liked A'),
    subject(0x4531, 'Liked B'),
    subject(0x4831, 'Liked C'),
    subject(0x4a31, 'Liked D'),
    subject(0x4b31, 'Liked E'),
  ]);
  const kinds = ['like', 'love', 'like', 'love', 'love'] as const;
  for (const [index, id] of subjects.entries()) await react('subject', id, kinds[index]!);
  await react('subject', subjects[1]!, 'laugh');
  await commands.clearReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(),
    { targetKind: 'subject', targetId: subjects[3]! },
    request(),
  );

  const expected = [subjects[0]!, subjects[2]!, subjects[4]!].sort();
  const { value: first, cost: firstCost } = await measure(f.db, () =>
    withClient((client) => readLikedSubjectPage(client, { actorAccountId: f.accountId, limit: 2 })),
  );
  expect(firstCost.statements).toBe(1);
  expect(first.subjects.map(({ subjectId }) => subjectId)).toEqual(expected.slice(0, 2));
  expect(first.subjects.map(({ kind }) => kind)).toEqual(['like', 'like']);
  expect(first.next).toBe(expected[1]);
  if (!first.next) throw new Error('Expected the first liked page to have a continuation');
  const { value: second, cost: secondCost } = await measure(f.db, () =>
    withClient((client) => readLikedSubjectPage(client, { actorAccountId: f.accountId, after: first.next!, limit: 2 })),
  );
  expect(secondCost.statements).toBe(1);
  expect(second.subjects.map(({ subjectId }) => subjectId)).toEqual(expected.slice(2));
  expect(second.subjects.map(({ kind }) => kind)).toEqual(['love']);
  expect(second.next).toBeUndefined();
  const pageBlockSamples: number[][] = [];
  const distractors = await distractorTemplates();
  const versionSamples: Array<{ rows: number; blocks: number }> = [];
  let previous = 0;
  for (const scale of [0, 1_000, 10_000]) {
    // Each fixture pair contributes one thread reaction and one post reaction.
    await addThreadAndPostReactions((scale - previous) / 2, distractors, previous === 0);
    previous = scale;
    const blocks: number[] = [];
    for (const after of [undefined, first.next]) {
      const { value: page, cost } = await measure(f.db, () =>
        withClient((client) =>
          readLikedSubjectPage(client, {
            actorAccountId: f.accountId,
            ...(after === undefined ? {} : { after }),
            limit: 2,
          }),
        ),
      );
      expect(cost.statements).toBe(1);
      expect(page).toEqual(after === undefined ? first : second);
      blocks.push(await likedPageSharedHitBlocks(after));
    }
    pageBlockSamples.push(blocks);
    const { value: version, cost: versionCost } = await measure(f.db, () =>
      withClient((client) => readLikedVersion(client, { actorAccountId: f.accountId })),
    );
    expect(version).toBe(first.version);
    expect(versionCost.statements).toBe(1);
    const parameters = { route: f.home, actor_id: f.accountId };
    const plan = await f.db.admin.query<{ 'QUERY PLAN': Array<{ Plan: { 'Shared Hit Blocks': number } }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${likedVersion.sql}`,
      likedVersion.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const versionBlocks = plan.rows[0]!['QUERY PLAN'][0]!.Plan['Shared Hit Blocks'];
    versionSamples.push({ rows: versionCost.rows, blocks: versionBlocks });
    expect(versionCost.rows).toBe(versionSamples[0]!.rows);
    expect(versionBlocks).toBeLessThanOrEqual(4);
    expect(versionBlocks - versionSamples[0]!.blocks).toBeLessThanOrEqual(0);
    console.info(
      `Liked version raw primitive growth: ${scale} other reactions; rows: ${versionCost.rows}; statements: 1; shared hit blocks: ${versionBlocks}`,
    );
    console.info(
      `Liked page raw primitive growth: ${scale} other reactions; statements per page: 1; shared hit blocks: ${blocks}`,
    );
    for (const [index, hits] of blocks.entries()) {
      expect(hits).toBeLessThanOrEqual(16);
      expect(hits - pageBlockSamples[0]![index]!).toBeLessThanOrEqual(4);
    }
  }
  await expect(
    withClient((client) => readLikedSubjectPage(client, { actorAccountId: f.accountId, limit: 257 })),
  ).rejects.toBeInstanceOf(TypeError);
}, 1_200_000);

test('the liked page never returns other reaction kinds, thread or post targets, or another account reactions', async () => {
  const unlike = await subject(0x4231, 'Not liked');
  const otherKinds: string[] = [];
  for (const kind of ['laugh', 'insightful', 'sad'] as const) {
    const id = await subject(0x4531, `Other kind ${kind}`);
    otherKinds.push(id);
    await react('subject', id, kind);
  }
  await react('subject', unlike, 'like');
  await react('subject', unlike, 'laugh');
  const targets = await f.target();
  await react('thread', targets.thread, 'like');
  await react('post', targets.post, 'love');
  await commands.setReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(f.managerId),
    { targetKind: 'subject', targetId: unlike, kind: 'love' },
    request(),
  );
  const page = await withClient((client) => readLikedSubjectPage(client, { actorAccountId: f.accountId, limit: 20 }));
  const returnedIds = page.subjects.map(({ subjectId }) => subjectId);
  expect(returnedIds).not.toContain(unlike);
  for (const id of otherKinds) expect(returnedIds).not.toContain(id);
});

test('liked membership answers which of up to 256 subjects the account currently likes or loves', async () => {
  const liked = await subject(0x4231, 'Membership liked');
  const loved = await subject(0x4531, 'Membership loved');
  const laughed = await subject(0x4831, 'Membership laughed');
  const empty = await subject(0x4a31, 'Membership empty');
  await react('subject', liked, 'like');
  await react('subject', loved, 'love');
  await react('subject', laughed, 'laugh');
  const result = await withClient((client) =>
    readLikedMembership(client, { actorAccountId: f.accountId, subjectIds: [liked, loved, laughed, empty, liked] }),
  );
  expect(result.subjects).toEqual(new Set([liked, loved]));
  expect(result.version).toBe(await withClient((client) => readLikedVersion(client, { actorAccountId: f.accountId })));
  await expect(
    withClient((client) =>
      readLikedMembership(client, { actorAccountId: f.accountId, subjectIds: Array(257).fill(liked) }),
    ),
  ).rejects.toBeInstanceOf(TypeError);
});

test('liked membership issues exactly one statement for 256 ids', async () => {
  const id = await subject(0x4231, 'Batch liked');
  await react('subject', id, 'like');
  const batch = Array.from({ length: 256 }, () => newId(0x4231));
  batch[0] = id;
  const { value, cost } = await measure(f.db, () =>
    withClient((client) => readLikedMembership(client, { actorAccountId: f.accountId, subjectIds: batch })),
  );
  expect(value.subjects).toEqual(new Set([id]));
  expect(cost.statements).toBe(1);
});
