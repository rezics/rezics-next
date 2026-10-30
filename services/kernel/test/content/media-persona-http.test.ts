/**
 * ---
 * acceptance:
 *   - a well-formed claim of another uploader's media is refused in every media state and changes nothing
 *   - a moderator reserves and claims media on their own container like any author
 *   - an unrelated account cannot reserve on an existing container it cannot write
 *   - anonymous and suspended callers cannot reserve or claim media
 * ---
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { routeOf } from '../../src/route/route.ts';
import { createContentMediaDriver, currentMediaScenario } from './media-driver.ts';
import { digest } from './support/media-fixtures.ts';
import { contentGovernanceCredential, type ContentCredential } from './support/system.ts';

let driver: Awaited<ReturnType<typeof createContentMediaDriver>>;
beforeEach(async () => {
  driver = await createContentMediaDriver();
});
afterEach(async () => {
  await driver?.close();
});

async function call(actor: ContentCredential | null, method: string, path: string, body?: unknown) {
  return currentMediaScenario().system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function snapshot() {
  const client = await currentMediaScenario().system.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='content' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY name`,
    );
    const state: Record<string, unknown[]> = {};
    for (const table of [...tables.rows.map(({ name }) => name), 'core.receipt', 'core.outbox', 'core.partition'])
      state[table] = (await client.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function refused(response: Response, status: number, code: string, command = true) {
  expect(response.status).toBe(status);
  expect(response.headers.get(SESSION_HEADER)).toBeNull();
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const { request_id, ...problem } = await response.clone().json();
  expect(request_id).toBeString();
  const titles: Record<string, string> = {
    media_unavailable: 'Media Unavailable',
    forbidden: 'Forbidden',
    authentication_required: 'Authentication Required',
    invalid_credentials: 'Invalid Credentials',
    not_found: 'Not Found',
  };
  expect(problem).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title: titles[code],
    status,
    code,
    retryable: false,
    effect_status: command ? 'not_applied' : 'not_applicable',
  });
  if (code === 'invalid_credentials') expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  return problem;
}

const reference = (mediaId: string) => ({
  body: fromPlainText('A well-formed media claim'),
  licence: 'MIT',
  mediaIds: [mediaId],
});

async function reserve(kind: 'tiny' | 'malformed' = 'tiny') {
  const source = await driver.source(kind);
  const requestId = crypto.randomUUID();
  const containerId = driver.containers.thread.id;
  const result = await driver.reserve('author', {
    requestId,
    containerId,
    purpose: 'post-image',
    type: source.type,
    length: source.bytes.length,
    sha256: source.sha256,
  });
  if (result.outcome !== 'permitted') throw new Error('Native media reservation refused');
  return { id: result.media.id, requestId, containerId, source };
}

async function complete(media: Awaited<ReturnType<typeof reserve>>, process = true) {
  await driver.placeOriginal(media.id, media.source.bytes);
  expect(
    await driver.complete('worker', {
      requestId: crypto.randomUUID(),
      reservationRequestId: media.requestId,
      containerId: media.containerId,
      byteCount: media.source.bytes.length,
      sha256: media.source.sha256,
    }),
  ).toBe('permitted');
  if (process) expect(await driver.process('job', media.id)).toBe('permitted');
  return media;
}

async function boardId() {
  const { system } = currentMediaScenario();
  const result = await system.database.pool.query<{ board_id: string }>(
    'SELECT board_id FROM content.thread WHERE route=$1 AND thread_id=$2',
    [driver.containers.thread.route, driver.containers.thread.id],
  );
  return result.rows[0]!.board_id;
}

async function ownThread(actor: ContentCredential, visibility: 'published' | 'draft' = 'published') {
  const response = await call(actor, 'POST', '/v1/threads', {
    boardId: await boardId(),
    title: 'Persona media container',
    body: fromPlainText('Opening post'),
    licence: 'MIT',
    subjectIds: [],
    visibility,
  });
  expect(response.status).toBe(201);
  return (await response.json()).thread as { id: string; authorId: string };
}

test("a well-formed claim of another uploader's media is refused in every media state and changes nothing", async () => {
  const { system } = currentMediaScenario();
  const reserved = await reserve();
  const uploaded = await complete(await reserve(), false);
  const available = await complete(await reserve());
  const rejected = await complete(await reserve('malformed'));
  const claimed = await complete(await reserve());
  const claim = await call(
    system.actors.author,
    'POST',
    `/v1/threads/${claimed.containerId}/posts`,
    reference(claimed.id),
  );
  expect(claim.status).toBe(201);
  const claimedPost = (await claim.json()).post;
  const takenDown = await complete(await reserve());
  const governance = await contentGovernanceCredential(system);
  expect(
    (
      await call(governance, 'POST', '/v1/grants', {
        resource: { route: routeOf(takenDown.id), id: takenDown.id },
        subject: { kind: 'account', id: system.actors.moderator.actor.accountId },
        actions: ['moderation:takedown'],
        valid: '(,)',
      })
    ).status,
  ).toBe(201);
  expect(
    (await call(system.actors.moderator, 'POST', `/v1/media/${takenDown.id}:takeDown`, { reason: 'Persona takedown' }))
      .status,
  ).toBe(200);
  const erased = await complete(await reserve());
  await driver.erase(erased.id);
  const expected = [
    [reserved, 'reserved', false, false],
    [uploaded, 'uploaded', false, false],
    [available, 'available', false, false],
    [rejected, 'rejected', false, false],
    [claimed, 'available', false, false],
    [takenDown, 'available', false, true],
    [erased, 'available', true, false],
  ] as const;
  let uniformProblem: unknown;
  for (const [media, state, isErased, taken_down] of expected) {
    const stored = await system.database.pool.query(
      'SELECT state,erased,taken_down,claimed_item_id FROM content.media WHERE route=$1 AND media_id=$2',
      [routeOf(media.id), media.id],
    );
    expect(stored.rows[0]).toEqual({
      state,
      erased: isErased,
      taken_down,
      claimed_item_id: media.id === claimed.id ? claimedPost.id : null,
    });
    for (const actor of [system.actors.other, system.actors.moderator]) {
      const before = await snapshot();
      const response = await call(actor, 'POST', `/v1/threads/${media.containerId}/posts`, reference(media.id));
      const problem = await refused(response, 409, 'media_unavailable');
      uniformProblem ??= problem;
      expect(problem).toEqual(uniformProblem);
      expect(await snapshot()).toEqual(before);
    }
  }
  // The available object's rightful uploader remains a positive control after all refused claims.
  expect(
    (await call(system.actors.author, 'POST', `/v1/threads/${available.containerId}/posts`, reference(available.id)))
      .status,
  ).toBe(201);
});

test('a moderator reserves and claims media on their own container like any author', async () => {
  const { system } = currentMediaScenario();
  const moderator = system.actors.moderator;
  const thread = await ownThread(moderator);
  expect(thread.authorId).toBe(moderator.actor.accountId);
  const source = await driver.source('tiny');
  const requestId = crypto.randomUUID();
  const response = await system.kernel.handle(
    new Request('https://content.test/v1/media', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${moderator.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestId),
      },
      body: JSON.stringify({
        containerId: thread.id,
        purpose: 'post-image',
        mediaType: source.type,
        byteCount: source.bytes.length,
        sha256: source.sha256,
      }),
    }),
  );
  expect(response.status).toBe(201);
  const media = (await response.json()).media as { id: string; key: string };
  // Storage and image processing are the same real capabilities used by the driver.
  await driver.placeOriginal(media.id, source.bytes);
  const website = await system.auth.issue({
    accountId: moderator.actor.accountId,
    clientId: system.auth.websiteClient.id,
    scopes: [...system.actions.keys()],
  });
  expect(
    (
      await call(website, 'POST', `/v1/media/${media.id}:complete`, {
        containerId: thread.id,
        reservationRequestId: requestId,
        byteCount: source.bytes.length,
        sha256: source.sha256,
      })
    ).status,
  ).toBe(200);
  expect(await driver.process('job', media.id)).toBe('permitted');
  const claimed = await call(moderator, 'POST', `/v1/threads/${thread.id}/posts`, reference(media.id));
  expect(claimed.status).toBe(201);
  const post = (await claimed.json()).post;
  expect(post.authorId).toBe(moderator.actor.accountId);
  expect(post.mediaIds).toEqual([media.id]);
  const stored = await system.database.pool.query(
    'SELECT uploader_id,container_id,state,claimed_item_id,claimed_at FROM content.media WHERE route=$1 AND media_id=$2',
    [routeOf(media.id), media.id],
  );
  expect(stored.rows[0]).toMatchObject({
    uploader_id: moderator.actor.accountId,
    container_id: thread.id,
    state: 'available',
    claimed_item_id: post.id,
  });
  expect(stored.rows[0].claimed_at).toBeInstanceOf(Date);
  for (const actor of [null, moderator, system.actors.author])
    expect((await call(actor, 'GET', `/v1/media/${media.id}:authorizeDownload?variant=webp-127`)).status).toBe(200);
});

test('an unrelated account cannot reserve on an existing container it cannot write', async () => {
  const { system } = currentMediaScenario();
  const thread = await ownThread(system.actors.author, 'draft');
  const source = await driver.source('tiny');
  const before = await snapshot();
  await refused(
    await call(system.actors.other, 'POST', '/v1/media', {
      containerId: thread.id,
      purpose: 'post-image',
      mediaType: source.type,
      byteCount: source.bytes.length,
      sha256: source.sha256,
    }),
    403,
    'forbidden',
  );
  expect(await snapshot()).toEqual(before);
});

test('anonymous and suspended callers cannot reserve or claim media', async () => {
  const { system } = currentMediaScenario();
  const media = await complete(await reserve());
  for (const actor of [null, system.actors.suspended]) {
    for (const [path, body] of [
      [
        '/v1/media',
        {
          containerId: media.containerId,
          purpose: 'post-image',
          mediaType: media.source.type,
          byteCount: media.source.bytes.length,
          sha256: media.source.sha256,
        },
      ],
      [`/v1/threads/${media.containerId}/posts`, reference(media.id)],
    ] as const) {
      const before = await snapshot();
      await refused(
        await call(actor, 'POST', path, body),
        401,
        actor ? 'invalid_credentials' : 'authentication_required',
      );
      expect(await snapshot()).toEqual(before);
    }
  }
  expect(
    (await call(system.actors.author, 'POST', `/v1/threads/${media.containerId}/posts`, reference(media.id))).status,
  ).toBe(201);
});

test('claimed downloads recheck protected containers, takedown and erasure for every persona', async () => {
  const { system } = currentMediaScenario();
  const media = await complete(await reserve());
  expect(
    (await call(system.actors.author, 'POST', `/v1/threads/${media.containerId}/posts`, reference(media.id))).status,
  ).toBe(201);
  const native = await driver.derivatives(media.id);
  const variants = (
    await system.database.pool.query<{ format: string; width: number; key: string; sha256: string }>(
      'SELECT format,width,key,sha256 FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width',
      [routeOf(media.id), media.id],
    )
  ).rows;
  expect(variants).toHaveLength(2);
  const personas = [null, system.actors.author, system.actors.moderator, system.actors.suspended];
  async function downloads(allowed: (ContentCredential | null)[]) {
    const before = await snapshot();
    const storage = (await driver.inspect()).storage;
    for (const actor of personas) {
      for (const variant of variants) {
        const response = await call(
          actor,
          'GET',
          `/v1/media/${media.id}:authorizeDownload?variant=${variant.format}-${variant.width}`,
        );
        if (allowed.includes(actor)) {
          expect(response.status).toBe(200);
          const decision = await response.json();
          expect(decision).toMatchObject({ allowed: true, key: variant.key, sha256: variant.sha256 });
          expect(digest(native.find(({ key }) => key === decision.key)!.bytes)).toBe(decision.sha256);
        } else {
          const suspended = actor === system.actors.suspended;
          await refused(response, suspended ? 401 : 404, suspended ? 'invalid_credentials' : 'not_found', false);
        }
      }
    }
    expect(await snapshot()).toEqual(before);
    expect((await driver.inspect()).storage).toEqual(storage);
  }
  await downloads(personas.slice(0, 3));
  const governance = await contentGovernanceCredential(system);
  expect(
    (
      await call(governance, 'POST', '/v1/grants', {
        resource: { route: routeOf(media.containerId), id: media.containerId },
        subject: { kind: 'account', id: system.actors.moderator.actor.accountId },
        actions: ['moderation:takedown'],
        valid: '(,)',
      })
    ).status,
  ).toBe(201);
  // This is the existing driver's documented visibility fixture, with unchanged grants.
  await driver.setParentVisibility('private');
  await downloads([system.actors.author]);
  expect(
    (
      await call(system.actors.moderator, 'POST', `/v1/threads/${media.containerId}:takeDown`, {
        reason: 'A containing thread withdraws all claimed derivatives',
      })
    ).status,
  ).toBe(200);
  await downloads([]);
  await driver.erase(media.id);
  expect(
    (
      await system.database.pool.query('SELECT erased FROM content.media WHERE route=$1 AND media_id=$2', [
        routeOf(media.id),
        media.id,
      ])
    ).rows,
  ).toEqual([{ erased: true }]);
  expect((await driver.inspect()).storage.filter(({ key }) => key.startsWith(`m/${media.id}/`))).toEqual([]);
  await downloads([]);
});
