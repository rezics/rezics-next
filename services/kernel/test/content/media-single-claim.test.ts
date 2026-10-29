import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { ContentMediaDriver } from '../../../../specs/content-media-driver.ts';
import { newId } from '../../src/route/route.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { createContentMediaDriver, currentMediaScenario } from './media-driver.ts';

let driver: ContentMediaDriver;
beforeEach(async () => {
  driver = await createContentMediaDriver();
});
afterEach(async () => {
  await driver?.close();
});

async function send(method: string, path: string, body?: object, revisionId?: string) {
  const { system } = currentMediaScenario();
  const { response } = await system.transport.capture(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        ...(revisionId ? { 'if-match': JSON.stringify(revisionId) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return response;
}

async function upload() {
  const source = await driver.source('tiny');
  const requestId = crypto.randomUUID();
  const containerId = driver.containers.thread.id;
  const reserved = await driver.reserve('author', {
    requestId,
    containerId,
    purpose: 'post-image',
    type: source.type,
    length: source.bytes.length,
    sha256: source.sha256,
  });
  if (reserved.outcome !== 'permitted') throw new Error('Image reservation refused');
  await driver.placeOriginal(reserved.media.id, source.bytes);
  expect(
    await driver.complete('worker', {
      requestId: crypto.randomUUID(),
      reservationRequestId: requestId,
      containerId,
      byteCount: source.bytes.length,
      sha256: source.sha256,
    }),
  ).toBe('permitted');
  expect(await driver.process('job', reserved.media.id)).toBe('permitted');
  return reserved.media.id;
}

function reference(mediaIds: string[]) {
  return { body: fromPlainText('An image post'), licence: 'MIT', mediaIds };
}

async function post(mediaIds: string[]) {
  const response = await send('POST', `/v1/threads/${driver.containers.thread.id}/posts`, reference(mediaIds));
  expect(response.status).toBe(201);
  return (await response.json()).post as { id: string; revisionId: string };
}

async function row(id: string) {
  const { system } = currentMediaScenario();
  return (
    await system.database.pool.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [
      driver.containers.thread.route,
      id,
    ])
  ).rows[0]!;
}

// Historical fixtures use INSERT because retained revisions are immutable.
async function historicalReference(
  client: Pick<import('pg').Pool, 'query'> | Pick<import('pg').PoolClient, 'query'>,
  sourceRevision: string,
  mediaIds: string[],
  at: string,
) {
  const route = driver.containers.thread.route;
  const id = newId(route);
  await client.query(
    `INSERT INTO content.revision
       (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
        subject_ids, board_id, availability, recorded_transaction_id, recorded_at, media_ids)
     SELECT route, thread_id, post_id, $3, body, body_sha256, search_text, licence,
            subject_ids, board_id, availability, recorded_transaction_id, $4, $5
     FROM content.revision WHERE route=$1 AND revision_id=$2`,
    [route, sourceRevision, id, at, mediaIds],
  );
  return id;
}

test("a post image stays claimed by its first post: that post's revisions may reference it again and any other post's reference answers 409 media_unavailable", async () => {
  const image = await upload();
  const first = await post([image]);
  const before = await row(image);
  const revised = await send('POST', `/v1/posts/${first.id}/revisions`, reference([image]), first.revisionId);
  expect(revised.status).toBe(200);
  expect(await row(image)).toEqual(before);

  const path = `/v1/threads/${driver.containers.thread.id}/posts`;
  const unknown = await send('POST', path, reference([newId(driver.containers.thread.route)]));
  expect(unknown.status).toBe(409);
  const problem = await unknown.json();
  delete problem.request_id;
  expect(problem.code).toBe('media_unavailable');
  const second = await send('POST', path, reference([image]));
  expect(second.status).toBe(409);
  const secondProblem = await second.json();
  delete secondProblem.request_id;
  expect(JSON.stringify(secondProblem)).toBe(JSON.stringify(problem));
  expect(await row(image)).toEqual(before);

  const { system } = currentMediaScenario();
  const { rows } = await system.database.pool.query(
    'SELECT board_id FROM content.thread WHERE route=$1 AND thread_id=$2',
    [driver.containers.thread.route, driver.containers.thread.id],
  );
  const thread = await send('POST', '/v1/threads', {
    ...reference([image]),
    title: 'Another thread',
    subjectIds: [],
    boardId: rows[0]!.board_id,
    visibility: 'published',
  });
  expect(thread.status).toBe(409);
  const threadProblem = await thread.json();
  delete threadProblem.request_id;
  expect(JSON.stringify(threadProblem)).toBe(JSON.stringify(problem));
  expect(await row(image)).toEqual(before);
  expect(before.claimed_item_id).toBe(first.id);
});

test('erasing a post erases only the media that post claimed', async () => {
  const firstImage = await upload();
  const secondImage = await upload();
  const first = await post([firstImage]);
  const second = await post([secondImage]);
  const { system } = currentMediaScenario();
  // A retained reference from before single ownership must not grant erasure authority.
  await historicalReference(system.database.pool, first.revisionId, [firstImage, secondImage], '2025-01-01');
  const before = await row(secondImage);
  expect((await send('DELETE', `/v1/posts/${first.id}`)).status).toBe(204);
  // Drain the same native cleanup and storage capability called by the post-erased worker.
  const drain = () =>
    clearErasedPostRevisions(
      system.database.pool,
      { postId: first.id },
      Date.now() + 10_000,
      currentMediaScenario().erasureJob,
    );
  const derivative = (await driver.derivatives(firstImage))[0]!;
  await driver.failNextStorageDelete(derivative.key);
  await expect(drain()).rejects.toThrow('Storage deletion failed');
  expect((await row(firstImage)).erased).toBe(true);
  await drain();
  expect(await driver.download('author', firstImage, 'derivative')).toEqual({ outcome: 'denied' });
  expect((await driver.inspect()).storage.filter(({ key }) => key.startsWith(`m/${firstImage}/`))).toEqual([]);
  expect(await row(secondImage)).toEqual(before);
  expect((await driver.download('author', secondImage, 'derivative')).outcome).toBe('permitted');
  expect(before.claimed_item_id).toBe(second.id);
});

test('the migration backfill gives each claimed post image to the post of its earliest referencing revision', async () => {
  const firstImage = await upload();
  const secondImage = await upload();
  const orphan = await upload();
  const unclaimed = await upload();
  const first = await post([firstImage]);
  const second = await post([secondImage]);
  const files = Array.from(
    new Bun.Glob('*_media_claimed_item.sql').scanSync({
      cwd: new URL('../../db/content/migrations/', import.meta.url).pathname,
    }),
  );
  expect(files).toHaveLength(1);
  const migration = await Bun.file(new URL(`../../db/content/migrations/${files[0]}`, import.meta.url)).text();
  const backfill = migration.split('-- Backfill start')[1]?.split('-- Backfill end')[0];
  expect(backfill).toBeDefined();
  const { system } = currentMediaScenario();
  const client = await system.database.pool.connect();
  const route = driver.containers.thread.route;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE content.media SET claimed_item_id=NULL WHERE route=$1 AND media_id=ANY($2::uuid[])', [
      route,
      [firstImage, secondImage],
    ]);
    await client.query('UPDATE content.media SET claimed_at=statement_timestamp() WHERE route=$1 AND media_id=$2', [
      route,
      orphan,
    ]);
    // Both images occur in both posts; timestamp beats UUID, and UUID breaks a timestamp tie.
    const firstRef = await historicalReference(
      client,
      first.revisionId,
      [firstImage, secondImage, unclaimed],
      '2025-01-01',
    );
    const secondRef = await historicalReference(
      client,
      second.revisionId,
      [firstImage, secondImage, unclaimed],
      '2025-01-01',
    );
    await client.query(backfill!);
    const owners = () =>
      client.query(
        'SELECT media_id, claimed_item_id FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id',
        [route, [firstImage, secondImage]],
      );
    const tieOwner = firstRef < secondRef ? first.id : second.id;
    expect((await owners()).rows.map((media) => media.claimed_item_id)).toEqual([tieOwner, tieOwner]);
    await historicalReference(client, second.revisionId, [firstImage, secondImage], '2024-01-01');
    await client.query('UPDATE content.media SET claimed_item_id=NULL WHERE route=$1 AND media_id=ANY($2::uuid[])', [
      route,
      [firstImage, secondImage],
    ]);
    await client.query(backfill!);
    expect((await owners()).rows.map((media) => media.claimed_item_id)).toEqual([second.id, second.id]);
    const untouched = await client.query(
      'SELECT claimed_item_id FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])',
      [route, [orphan, unclaimed]],
    );
    expect(untouched.rows.map((media) => media.claimed_item_id)).toEqual([null, null]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect((await row(firstImage)).claimed_item_id).toBe(first.id);
  expect((await row(secondImage)).claimed_item_id).toBe(second.id);
});
