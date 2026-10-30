import { afterAll, beforeAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import {
  createAtomicityKernel,
  createReply,
  createThreadAtomicityWorld,
  call,
  reserveAvailableImage,
} from './thread-transaction-atomicity-fixture.ts';
import type { ContentItem, ThreadAtomicityWorld } from './thread-transaction-atomicity-fixture.ts';
import { createMediaStorage } from './support/storage.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';

type RevisionResponse = { readonly post: ContentItem };
type Problem = { readonly code: string; readonly status: number };
type RevisionTemplate = {
  readonly body: Buffer;
  readonly bodySha256: Buffer;
  readonly licence: string;
  readonly subjectIds: readonly string[];
  readonly boardId: string;
};
type MediaTemplate = {
  readonly mediaType: string;
  readonly byteCount: string;
  readonly declaredSha256: string | null;
  readonly actualByteCount: string;
  readonly sha256: string;
};

let world: ThreadAtomicityWorld;
let growthDb: GrowthDatabase;

beforeAll(async () => {
  world = await createThreadAtomicityWorld(`thread-transaction-growth-${randomUUID().replaceAll('-', '')}`);
  growthDb = await openGrowthDatabase(world.system.database.pool.options.connectionString);
}, 120_000);

afterAll(async () => {
  await growthDb?.close();
  await world?.system.close();
});

test('The distinct joined native outcomes and three-scale bounded growth retain the existing owner contracts.', async () => {
  const { system, kernel, conceptId, thread } = world;
  const growthTarget = await createReply(system, kernel, system.actors.author, thread, {
    body: fromPlainText('Existing edit target for joined growth.'),
    licence: 'MIT',
    subjectIds: [conceptId],
    parentId: thread.firstPost.id,
  });
  const unrelatedPost = await createReply(system, kernel, system.actors.author, thread, {
    body: fromPlainText('Unrelated post whose revision history grows.'),
    licence: 'MIT',
    subjectIds: [conceptId],
    parentId: thread.firstPost.id,
  });
  const storage = createMediaStorage();
  try {
    const mediaTemplate = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      thread.id,
      storage,
    );
    const template = await templates(growthDb.admin, unrelatedPost.id, unrelatedPost.revisionId, mediaTemplate.id);
    const partition = partitionOf(thread.route);
    const start = await growthDb.admin.query<{ position: string; epoch: number }>(
      'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
      [partition],
    );
    const positionBase = Number(start.rows[0]?.position ?? 0);
    const epoch = start.rows[0]?.epoch ?? 1;
    const tag = `joined-atomicity-growth-${randomUUID()}`;
    const seedName = `joined-atomicity-growth-${randomUUID()}`;
    const population = growthPopulation({
      name: seedName,
      tag,
      route: thread.route,
      partition,
      threadId: thread.id,
      boardId: thread.boardId,
      postId: unrelatedPost.id,
      actorId: system.actors.author.actor.accountId,
      positionBase,
      epoch,
      template,
    });
    const countsAtScale = new Map<
      number,
      { revisions: number; media: number; receipts: number; outbox: number; bases: number }
    >();
    const measuredKernel = createAtomicityKernel(system, growthDb.pool);
    const missingMediaId = newId(thread.route);
    const validBody = fromPlainText('A fixed joined growth edit: 東京と雪。');
    const invalidBody = fromPlainText('A fixed joined growth rejection: 限定。');
    let expectedRevisionId = growthTarget.revisionId;
    let repetition = 0;

    const report = await checkGrowth(growthDb, {
      name: 'Content revision edit, replay and media rejection with unrelated same-anchor growth',
      rule: 'series',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (database, scale, previous) => {
        await seed(database, population, { from: previous, to: scale });
        countsAtScale.set(scale, await fixtureCounts(database, tag, thread.route, unrelatedPost.id, partition, scale));
      },
      async operation(database, _scale, run) {
        const key = `${seedName}-operation-${repetition++}-${run}`;
        const body = {
          body: validBody,
          licence: 'CC-BY-4.0',
          subjectIds: [conceptId],
        };
        const previous = expectedRevisionId;
        const edited = await call<RevisionResponse | Problem>(
          measuredKernel,
          system.actors.author,
          'POST',
          `/v1/posts/${growthTarget.id}/revisions`,
          body,
          key,
          { 'if-match': JSON.stringify(previous) },
        );
        expect(edited.response.status).toBe(200);
        const revisionId = (edited.body as RevisionResponse).post.revisionId;
        expect(revisionId).not.toBe(previous);
        expectedRevisionId = revisionId;

        const replay = await call<RevisionResponse | Problem>(
          measuredKernel,
          system.actors.author,
          'POST',
          `/v1/posts/${growthTarget.id}/revisions`,
          body,
          key,
          { 'if-match': JSON.stringify(previous) },
        );
        expect(replay.response.status).toBe(200);
        expect((replay.body as RevisionResponse).post.revisionId).toBe(revisionId);
        expect(replay.response.headers.get(SESSION_HEADER)).toBe(edited.response.headers.get(SESSION_HEADER));

        const rejectedKey = `${key}-media-rejection`;
        const rejected = await call<RevisionResponse | Problem>(
          measuredKernel,
          system.actors.author,
          'POST',
          `/v1/posts/${growthTarget.id}/revisions`,
          {
            body: invalidBody,
            licence: 'CC-BY-4.0',
            subjectIds: [conceptId],
            mediaIds: [missingMediaId],
          },
          rejectedKey,
          { 'if-match': JSON.stringify(revisionId) },
        );
        expect(rejected.response.status).toBe(409);
        expect((rejected.body as Problem).code).toBe('media_unavailable');
        const head = await databaseHead(database.admin, growthTarget.id);
        expect(head).toBe(revisionId);
        expect(
          await commandReceipt(database.admin, partition, system.actors.author.actor.accountId, rejectedKey),
        ).toBeNull();
      },
    });

    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      expect(countsAtScale.get(sample.scale)).toEqual({
        revisions: sample.scale,
        media: sample.scale,
        receipts: sample.scale,
        outbox: sample.scale,
        bases: sample.scale,
      });
      expect(sample.repetitions).toHaveLength(5);
      expect(sample.statementRepetitions).toHaveLength(sample.repetitions.length);
      expect(sample.occurrenceRepetitions).toHaveLength(sample.repetitions.length);
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.blocks).toBeGreaterThan(0);
      expect(sample.cost.statements).toBeGreaterThan(0);
      for (const [index, raw] of sample.repetitions.entries()) {
        expect(raw.rows).toBeGreaterThan(0);
        expect(raw.blocks).toBeGreaterThan(0);
        expect(raw.statements).toBeGreaterThan(0);
        expect(sample.statementRepetitions[index]!.length).toBeGreaterThan(0);
        expect(sample.occurrenceRepetitions[index]!.statements.length).toBeGreaterThan(0);
      }
    }
    assertGrowthAccessPaths(report.name, report.samples, [
      'content.thread',
      'content.post',
      'content.revision',
      'content.media',
      'core.partition',
      'core.receipt',
      'core.outbox',
      'editorial.write_basis',
      'access.resource_grant',
      'access.resource_role_grant',
      'access.resource_denial',
    ]);

    const head = await databaseHead(growthDb.admin, growthTarget.id);
    expect(head).toBe(expectedRevisionId);
    const measuredRevision = await growthDb.admin.query<{ body: Buffer; digest: Buffer; media_ids: string[] }>(
      `SELECT body,body_sha256 AS digest,media_ids FROM content.revision
       WHERE route=$1 AND post_id=$2 AND revision_id=$3`,
      [thread.route, growthTarget.id, head],
    );
    expect(measuredRevision.rows).toHaveLength(1);
    const canonical = canonicalize(validBody);
    if (canonical === undefined) throw new TypeError('Growth document cannot be canonicalized');
    const bytes = Buffer.from(canonical, 'utf8');
    expect(measuredRevision.rows[0]!.body.equals(bytes)).toBe(true);
    expect(measuredRevision.rows[0]!.digest.equals(createHash('sha256').update(bytes).digest())).toBe(true);
    expect(measuredRevision.rows[0]!.media_ids).toEqual([]);
  } finally {
    storage.close();
  }
}, 300_000);

function growthPopulation(input: {
  readonly name: string;
  readonly tag: string;
  readonly route: number;
  readonly partition: number;
  readonly threadId: string;
  readonly boardId: string;
  readonly postId: string;
  readonly actorId: string;
  readonly positionBase: number;
  readonly epoch: number;
  readonly template: { readonly revision: RevisionTemplate; readonly media: MediaTemplate };
}): Population {
  const { route, partition, threadId, boardId, postId, actorId, positionBase, epoch, template, tag } = input;
  return {
    name: input.name,
    hotPartition: partition,
    hotShare: 1,
    rows({ ordinal }) {
      const revisionId = newId(route);
      const mediaId = newId(route);
      const transactionId = randomUUID();
      const outboxId = randomUUID();
      const position = positionBase + (ordinal + 1) * 1000;
      const payload = {
        threadId,
        itemId: postId,
        revisionId,
        actorId,
        placeId: GLOBAL_CONTEXT,
        kind: 'discussion',
        subjectIds: [...template.revision.subjectIds],
        activityAt: '2030-01-02T00:00:00.000Z',
      };
      const response = { threadId, itemId: postId, revisionId };
      const data: Record<string, readonly Record<string, unknown>[]> = {
        'content.revision': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body: template.revision.body,
            body_sha256: template.revision.bodySha256,
            search_text: tag,
            licence: template.revision.licence,
            subject_ids: [...template.revision.subjectIds],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            media_ids: [],
          },
        ],
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: threadId,
            uploader_id: actorId,
            reservation_request_id: `${tag}-${ordinal}`,
            purpose: 'post-image',
            media_type: template.media.mediaType,
            byte_count: template.media.byteCount,
            declared_sha256: template.media.declaredSha256,
            actual_byte_count: template.media.actualByteCount,
            sha256: template.media.sha256,
            state: 'available',
            key: `m/${mediaId}/original`,
            transaction_id: randomUUID(),
          },
        ],
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: actorId,
            command_kind: 'content.post.revise',
            idempotency_key: `${tag}-${ordinal}`,
            request_digest: Buffer.from(createHash('sha256').update(`${tag}-${ordinal}`).digest()),
            epoch,
            position,
            transaction_id: transactionId,
            response,
          },
        ],
        'core.outbox': [
          {
            partition_no: partition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch,
            id: outboxId,
            type: 'com.rezics.content.revision.created.v1',
            subject: postId,
            data: payload,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partition,
            transaction_id: transactionId,
            epoch,
            position,
            principal_kind: 'account',
            principal_id: actorId,
            client_id: tag,
            requested_by: null,
          },
        ],
      };
      return data;
    },
    finish: async (admin, range) => {
      if (range.to === range.from) return;
      await admin.query('UPDATE core.partition SET position=GREATEST(position,$2) WHERE partition_no=$1', [
        partition,
        positionBase + range.to * 1000,
      ]);
    },
  };
}

async function templates(
  pool: Pool,
  postId: string,
  revisionId: string,
  mediaId: string,
): Promise<{ readonly revision: RevisionTemplate; readonly media: MediaTemplate }> {
  const [revision, media] = await Promise.all([
    pool.query<{
      body: Buffer;
      body_sha256: Buffer;
      licence: string;
      subject_ids: string[];
      board_id: string;
    }>(
      `SELECT body,body_sha256,licence,subject_ids,board_id
       FROM content.revision WHERE route=$1 AND post_id=$2 AND revision_id=$3`,
      [routeOf(postId), postId, revisionId],
    ),
    pool.query<MediaTemplate>(
      `SELECT media_type AS "mediaType",byte_count::text AS "byteCount",declared_sha256 AS "declaredSha256",
              actual_byte_count::text AS "actualByteCount",sha256
       FROM content.media WHERE route=$1 AND media_id=$2`,
      [routeOf(mediaId), mediaId],
    ),
  ]);
  if (!revision.rows[0] || !media.rows[0])
    throw new Error('Growth templates must come from real committed content and media');
  const row = revision.rows[0];
  return {
    revision: {
      body: row.body,
      bodySha256: row.body_sha256,
      licence: row.licence,
      subjectIds: row.subject_ids,
      boardId: row.board_id,
    },
    media: media.rows[0],
  };
}

async function fixtureCounts(
  database: GrowthDatabase,
  tag: string,
  route: number,
  postId: string,
  partition: number,
  scale: number,
) {
  const [revisions, media, receipts, outbox, bases] = await Promise.all([
    database.admin.query<{ total: number; hot: number }>(
      'SELECT count(*)::integer AS total,count(*) FILTER (WHERE route=$2)::integer AS hot FROM content.revision WHERE search_text=$1',
      [tag, route],
    ),
    database.admin.query<{ total: number; hot: number }>(
      'SELECT count(*)::integer AS total,count(*) FILTER (WHERE route=$2)::integer AS hot FROM content.media WHERE reservation_request_id LIKE $1',
      [`${tag}-%`, route],
    ),
    database.admin.query<{ total: number; hot: number }>(
      'SELECT count(*)::integer AS total,count(*) FILTER (WHERE partition_no=$2)::integer AS hot FROM core.receipt WHERE idempotency_key LIKE $1',
      [`${tag}-%`, partition],
    ),
    database.admin.query<{ total: number; hot: number }>(
      `SELECT count(*)::integer AS total,count(*) FILTER (WHERE partition_no=$2)::integer AS hot
       FROM core.outbox WHERE subject=$1 AND type='com.rezics.content.revision.created.v1'
         AND partition_no=$2`,
      [postId, partition],
    ),
    database.admin.query<{ total: number; hot: number }>(
      `SELECT count(*)::integer AS total,count(*) FILTER (WHERE partition_no=$2)::integer AS hot
       FROM editorial.write_basis WHERE client_id=$1`,
      [tag, partition],
    ),
  ]);
  const pairs = [revisions.rows[0]!, media.rows[0]!, receipts.rows[0]!, outbox.rows[0]!, bases.rows[0]!];
  for (const pair of pairs) {
    expect(pair.total).toBe(scale);
    expect(pair.hot).toBe(scale);
  }
  return {
    revisions: revisions.rows[0]!.total,
    media: media.rows[0]!.total,
    receipts: receipts.rows[0]!.total,
    outbox: outbox.rows[0]!.total,
    bases: bases.rows[0]!.total,
  };
}

async function databaseHead(pool: Pool, postId: string): Promise<string | null> {
  const result = await pool.query<{ head: string }>(
    'SELECT head_revision_id::text AS head FROM content.post WHERE route=$1 AND post_id=$2',
    [routeOf(postId), postId],
  );
  return result.rows[0]?.head ?? null;
}

async function commandReceipt(
  pool: Pool,
  partition: number,
  authorId: string,
  key: string,
): Promise<{ readonly position: string } | null> {
  const result = await pool.query<{ position: string }>(
    `SELECT position::text FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
     AND principal_id=$2 AND command_kind='content.post.revise' AND idempotency_key=$3`,
    [partition, authorId, key],
  );
  return result.rows[0] ?? null;
}
