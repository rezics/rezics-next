import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { ReadRankingProjection, rankingBuckets }
  from '../../../services/main/src/modules/rankings/projection.ts';
import { progressRoutes } from '../../../services/main/src/routes/progress.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('G-320: composition and chapter commands drain in ordinal order; progress reaches rankings', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-relay-${randomUUID()}`));
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: typeof objects }).structureObjects = objects;
    const progress = new StructureProgressStore(f.pool);
    const progressApp = new Elysia().use(progressRoutes(f.env.fuseki, {
      environment: f.env, account: f.account.verifier, access: f.access,
      structureObjects: objects, progress }));
    const consumer = `structure-relay:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);

    const book = await f.json<{ work: string; mainVersion: string }>(await f.call('POST',
      '/v1/works', { profile: 'metadata-only-v1', language: 'en', title: 'Relay chapter book',
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }), 201);
    await f.grant(`work:edit:${book.work}`, 'work.edit');
    await f.grant(`work:read:${book.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string; sourcePosition: {
      sequence: string } }>(await f.call('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion,
      actingSubject: f.actor }), 201);
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const changed = await f.json<{ revision: string; sourcePosition: { sequence: string } }>(
      await f.call('POST', `${path}/changes`, { profile: 'book-composition',
        expectedHead: created.revision, actingSubject: f.actor,
        operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'group' }] }), 200);
    const chapter = await f.json<{ occurrence: string; work: string;
      sourcePosition: { sequence: string } }>(await f.call('POST',
      `/v1/works/${shortId(book.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: 'Relay chapter', language: 'en', direction: 'ltr', parent: created.structure,
        position: 'last', expectedCompositionHead: changed.revision,
        actingSubject: f.actor }), 200);

    let last = '0';
    for (let index = 0; index < 20 && BigInt(last) < BigInt(chapter.sourcePosition.sequence); index++) {
      const batch = await relayMainOutboxOnce(f.env.fuseki, relay, consumer);
      expect(batch).not.toBeNull();
      last = batch!.sequence;
    }
    expect(last).toBe(chapter.sourcePosition.sequence);
    const delivered = await relay.query<{ ordinal: number; type: string; work: string | null }>(
      `SELECT (envelope->'data'->>'ordinal')::int AS ordinal, envelope->>'type' AS type,
        envelope->'data'->'receipt'->>'chapterWork' AS work
       FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2 ORDER BY ordinal`,
      [f.env.lineage.dataEpoch, last]);
    expect(delivered.rows).toEqual([
      { ordinal: 0, type: 'com.rezics.structure.command.v1', work: chapter.work },
      { ordinal: 1, type: 'com.rezics.studio.chapter-created.v1', work: null },
    ]);
    const composition = await relay.query<{ type: string }>(
      `SELECT envelope->>'type' AS type FROM relay.delivered_event
       WHERE data_epoch = $1 AND sequence IN ($2, $3) ORDER BY sequence`,
      [f.env.lineage.dataEpoch, created.sourcePosition.sequence, changed.sourcePosition.sequence]);
    expect(composition.rows).toEqual([
      { type: 'com.rezics.structure.command.v1' },
      { type: 'com.rezics.structure.command.v1' },
    ]);

    await f.grant(`work:read:${chapter.work}`, 'work.read');
    const progressResponse = await progressApp.handle(new Request(
      `http://main.local${path}/occurrences/${shortId(chapter.occurrence)}/progress`, {
        method: 'PUT', headers: { authorization: `Bearer ${f.account.tokenA}`,
          'content-type': 'application/json', 'idempotency-key': `progress-${randomUUID()}` },
        body: JSON.stringify({ actingSubject: f.actor, expectedVersion: 0,
          completed: true, position: 'paragraph:1' }),
      }));
    expect(progressResponse.status).toBe(200);
    expect(await progressResponse.json()).toMatchObject({ completed: true, version: 1 });
    const content = new ContentCore(f.pool);
    const cursor = new ContentProjectionCursor(f.pool);
    const contentConsumer = `structure-relay-${randomUUID()}`;
    await cursor.initialize(contentConsumer);
    const contentHead = await content.ownerPosition();
    let contentSequence = '0';
    for (let index = 0; index < 20 && BigInt(contentSequence) < BigInt(contentHead.sequence); index++) {
      const result = await relayContentProjectionOnce(f.env, content, cursor, contentConsumer);
      expect(result).not.toBeNull();
      expect(result?.disposition).toBe('ignored');
      contentSequence = result!.sourceSequence;
    }
    expect(contentSequence).toBe(contentHead.sequence);
    const projection = new ReadRankingProjection(f.accessPool, content, f.pool, f.env);
    for (let index = 0; index < 20 && await projection.tick() > 0; index++) { /* drain */ }
    const checkpoint = await projection.current();
    expect(checkpoint.contentSequence).toBe((await content.ownerPosition()).sequence);
    const scores = await f.accessPool.query<{ metric: string; score: string }>(
      `SELECT metric, score::text FROM access.read_ranking_score
       WHERE generation = $1 AND interval = 'day' AND bucket = $2 AND work = $3
       ORDER BY metric`,
      [checkpoint.generation, rankingBuckets(new Date(), 'day').current, book.work]);
    expect(scores.rows).toEqual([
      { metric: 'finished-chapters', score: '1' }, { metric: 'reads', score: '1' },
    ]);
  } finally { await Promise.allSettled([relay.end(), f.close()]); }
}, 180_000);
