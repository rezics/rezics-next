import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-production');
afterAll(async () => { if (started) await (await started).stop(); });

test('VIEW08/SEARCH15: a media receipt advances the Content cursor without text projection', async () => {
  const { member, content, contentPool, env, fuseki } = await stack();
  const owner = await member('relay');
  const cursor = new ContentProjectionCursor(contentPool);
  const consumer = `media-relay-${randomUUID()}`;
  const baseline = await content.ownerPosition();
  await cursor.initialize(consumer);
  // Other files in this selected QA tier may already have advanced Content.
  await contentPool.query('UPDATE content.projection_checkpoint SET sequence = $2, scan_sequence = $2 WHERE consumer = $1',
    [consumer, baseline.sequence]);
  const bytes = png(24, 24);
  const reserved = await owner.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png',
    byteLength: bytes.length, sha256: sha(bytes), disclosure: 'private', actingSubject: owner.actor,
  });
  expect(reserved.status).toBe(201);
  const position = (await reserved.json() as { position: { sequence: string; dataEpoch: string } }).position;
  expect(BigInt(position.sequence)).toBe(BigInt(baseline.sequence) + 1n);
  const graphQueries = fuseki.queries;
  const settled = await relayContentProjectionOnce(env, content, cursor, consumer);
  expect(settled).toMatchObject({ sourceEpoch: position.dataEpoch,
    sourceSequence: position.sequence, disposition: 'ignored' });
  expect(await cursor.read(consumer)).toMatchObject(position);
  expect(fuseki.queries).toBe(graphQueries);
  expect((await contentPool.query(`SELECT recipe FROM content.outbox
    WHERE data_epoch = $1 AND sequence = $2`, [position.dataEpoch, position.sequence])).rows[0])
    .toEqual({ recipe: 'media-v1' });
});
