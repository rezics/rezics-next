import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { readErasureStatus, resolveRetention } from '../../src/access/erasure.ts';
import { createAccountErasureEffect } from '../../src/content/account-erasure.ts';
import { purgeAccountStatementsPage } from '../../src/content/account-erasure-moderation.ts';
import { readLikedVersion } from '../../src/content/liked-read.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from './support/disclosure-fixtures.ts';

setDefaultTimeout(360_000);
type Person = { accountId: string; bearer: string; websiteBearer?: string };
type Thread = { id: string; firstPost: { id: string; revisionId: string } };
type FakeStore = {
  endpoint: string;
  objects: Map<string, Buffer>;
  failingMedia: Set<string>;
  failedDeletes: number;
  close(): Promise<void>;
};
type OutboxRow = {
  partition_no: number;
  position: string;
  event_seq: number;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
  data: unknown;
  recorded_at: Date;
};

let system: NativeContentSystem;
let worker: ChildProcessWithoutNullStreams;
let workerOutput = '';
let boardId: string;
let boardSubjectId: string;
let png: Buffer;
let fake: FakeStore;
const staff = (): Person => ({ accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer });
const workerExecutable = process.execPath;
const idempotency = () => JSON.stringify(crypto.randomUUID());

function fakeObjectServer(): Promise<FakeStore> {
  const objects = new Map<string, Buffer>();
  const failingMedia = new Set<string>();
  let failedDeletes = 0;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const encodedKey = url.pathname.split('/').slice(2).join('/');
    const key = encodedKey ? encodedKey.split('/').map(decodeURIComponent).join('/') : '';
    if (request.method === 'GET' && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
      const contents = keys
        .map(
          (candidate) =>
            `<Contents><Key>${encodeURIComponent(candidate)}</Key><Size>${objects.get(candidate)!.length}</Size></Contents>`,
        )
        .join('');
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      const value = objects.get(key);
      if (!value) {
        response.writeHead(404, { 'content-type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'content-length': String(value.length) });
      response.end(value);
      return;
    }
    if (request.method === 'DELETE') {
      if ([...failingMedia].some((mediaId) => key.startsWith(`m/${mediaId}/`))) {
        failedDeletes++;
        response.writeHead(500);
        response.end();
        return;
      }
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fake storage did not bind a TCP port'));
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        objects,
        failingMedia,
        get failedDeletes() {
          return failedDeletes;
        },
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function call<T>(person: Person, method: string, path: string, body?: unknown, head?: string): Promise<T> {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': idempotency() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function createPerson(): Promise<Person> {
  return (await accountDeletionRuntime(system).person()) as Person;
}

async function grant(person: Person, resourceId: string, actions: string[]) {
  const route = routeOf(resourceId)!;
  await seedGovernanceAuthority(system.database.pool, route, resourceId, person.accountId, actions);
}

async function createThread(person: Person, title: string, visibility: 'published' | 'draft' = 'published') {
  if (person.accountId !== staff().accountId) await grant(person, boardId, ['thread:create', 'board:read']);
  return (
    await call<{ thread: Thread }>(person, 'POST', '/v1/threads', {
      boardId,
      title,
      visibility,
      body: fromPlainText(`${title} body`),
      licence: 'CC0-1.0',
      subjectIds: [],
    })
  ).thread;
}

async function createOtherThread(title: string) {
  return createThread(staff(), title);
}

async function upload(person: Person, containerId: string, purpose: 'avatar' | 'post-image' = 'post-image') {
  const uploader = { ...person, bearer: person.websiteBearer! };
  const digest = createHash('sha256').update(png).digest('hex');
  const reservation = await call<{ media: { id: string; reservationRequestId: string } }>(
    uploader,
    'POST',
    '/v1/media',
    {
      containerId,
      purpose,
      mediaType: 'image/png',
      byteCount: png.length,
      sha256: digest,
    },
  );
  const id = reservation.media.id;
  fake.objects.set(`m/${id}/original`, png);
  await call(uploader, 'POST', `/v1/media/${id}:complete`, {
    containerId,
    reservationRequestId: reservation.media.reservationRequestId,
    byteCount: png.length,
    sha256: digest,
  });
  return id;
}

async function grantMediaCreate(person: Person, resourceId = person.accountId) {
  if (resourceId !== person.accountId) {
    await grant(person, resourceId, ['media:create']);
    return;
  }
  const route = routeOf(resourceId)!;
  await system.database.pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'media:create','(,)'::tstzrange,$4) ON CONFLICT DO NOTHING`,
    [route, resourceId, person.accountId, crypto.randomUUID()],
  );
}

beforeEach(async () => {
  await system.clock.setCommandTime(new Date().toISOString());
});

async function waitUntil(predicate: () => Promise<boolean>, label: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}: ${workerOutput}`);
}

async function waitMediaReady(id: string) {
  await waitUntil(async () => {
    const { rows } = await system.database.pool.query<{
      state: string;
      collection_pending: boolean;
      erased: boolean;
      taken_down: boolean;
    }>('SELECT state, collection_pending, erased, taken_down FROM content.media WHERE route=$1 AND media_id=$2', [
      routeOf(id),
      id,
    ]);
    return rows[0]?.state === 'available' && !rows[0].collection_pending && !rows[0].erased && !rows[0].taken_down;
  }, `media ${id} processing`);
}

async function erase(person: Person) {
  const runtime = accountDeletionRuntime(system);
  const result = await deletePersona({ version: 1, pool: system.database.pool, auth: runtime.auth }, person);
  await drainEffects(system.database.pool, partitionOf(routeOf(person.accountId)!), { deadlineMs: 120_000 });
  return result;
}

async function waitParticipant(person: Person, participant: 'content' | 'delivery', outcome: 'erased' | 'none') {
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.participants[participant]?.outcome === outcome;
  }, `the ${participant} acknowledgement for ${person.accountId}`);
}

async function drainRelays() {
  const { rows } = await system.database.pool.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position>0',
  );
  for (const row of rows) await drainEffects(system.database.pool, row.partition_no, { deadlineMs: 120_000 });
}

async function eventFor(accountId: string): Promise<CloudEvent> {
  const { rows } = await system.database.pool.query<OutboxRow>(
    `SELECT partition_no,position::text,event_seq,epoch,id::text,type,subject,data,recorded_at
     FROM core.outbox WHERE type='com.rezics.access.account-tombstoned.v1' AND data->>'accountId'=$1
     ORDER BY position DESC,event_seq LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new Error('Committed tombstone event is missing');
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject ? { subject: row.subject } : {}),
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}

async function resumeParticipant(person: Person) {
  const url = system.database.pool.options.connectionString;
  if (!url) throw new Error('Native database URL is missing');
  const client = await createWorkClient(url);
  try {
    let step: string | undefined;
    await waitUntil(async () => {
      const { rows } = await system.database.pool.query<{ step: string }>(
        'SELECT step::text FROM content.account_erasure_progress WHERE route=$1 AND account_id=$2',
        [routeOf(person.accountId), person.accountId],
      );
      step = rows[0]?.step;
      return step !== undefined;
    }, `content erasure progress for ${person.accountId}`);
    await client.enqueue(
      {
        workflowName: 'content.account-erasure.step',
        queueName: 'governance',
        workflowID: `test-content-account-erasure-resume:${person.accountId}:${step}`,
        workflowIDReusePolicy: 'return-existing',
      },
      person.accountId,
      Number(step),
    );
  } finally {
    await client.close();
  }
}

async function startTestWorker() {
  const url = system.database.pool.options.connectionString;
  if (!url) throw new Error('Native database URL is missing');
  worker = spawn(
    workerExecutable,
    ['run', new URL('./support/disclosure-fixtures.ts', import.meta.url).pathname, '--disclosure-worker'],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        CONTENT_TEST_STORAGE: fake.endpoint,
        CONTENT_TEST_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
        CONTENT_TEST_DISABLE_ERASURE_PARTICIPANT: 'false',
      },
      stdio: 'pipe',
    },
  );
  worker.stderr.on('data', (chunk) => {
    workerOutput += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout });
    lines.on('line', (line) => {
      workerOutput += `${line}\n`;
      if (line === 'ready') resolve();
    });
    worker.once('exit', (code) => reject(new Error(`Content worker exited ${code}: ${workerOutput}`)));
  });
  await ready;
}

async function stopTestWorker() {
  if (worker && worker.exitCode === null) {
    const exited = once(worker, 'exit');
    worker.stdin.end('stop\n');
    await exited;
  }
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  fake = await fakeObjectServer();
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#234567' } })
    .png()
    .toBuffer();
  const { space } = await call<{ space: { spaceId: string } }>(staff(), 'POST', '/v1/spaces', {
    title: 'Account erasure space',
    summary: '',
  });
  const { realm } = await call<{ realm: { realmId: string; headRevisionId: string } }>(staff(), 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Account erasure realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await call<{ subject: { id: string } }>(staff(), 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Account erasure scheme' },
  });
  const { subject: concept } = await call<{ subject: { id: string } }>(staff(), 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Account erasure board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  const assigned = await call<{ realm: { headRevisionId: string } }>(
    staff(),
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    realm.headRevisionId,
  );
  const { board } = await call<{ board: { id: string } }>(staff(), 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Account erasure board',
    visibility: 'published',
  });
  void assigned;
  boardId = board.id;
  boardSubjectId = concept.id;
  await startTestWorker();
  await drainRelays();
});

afterAll(async () => {
  try {
    await stopTestWorker();
  } finally {
    await fake?.close();
    await system?.close();
  }
});

test('deleting an account with content in every role leaves only its retained public contributions and acknowledges content erased', async () => {
  const person = await createPerson();
  await seedGovernanceAuthority(system.database.pool, routeOf(GLOBAL_CONTEXT)!, GLOBAL_CONTEXT, person.accountId, [
    'subject:create',
    'statement:propose',
    'reaction:set',
  ]);
  await grantMediaCreate(person);
  const published = await createThread(person, 'Retained authored contribution');
  await grantMediaCreate(person, published.id);
  const mediaAvatar = await upload(person, person.accountId, 'avatar');
  const standalone = await upload(person, published.id);
  const retainedMedia = await upload(person, published.id);
  await waitMediaReady(mediaAvatar);
  await waitMediaReady(standalone);
  await waitMediaReady(retainedMedia);
  await grant(person, published.id, ['post:create', 'thread:read']);
  await call(person, 'POST', `/v1/threads/${published.id}/posts`, {
    body: fromPlainText('Retained reply with image'),
    mediaIds: [retainedMedia],
    licence: 'CC0-1.0',
    subjectIds: [],
    parentId: published.firstPost.id,
  });
  const draft = await createThread(person, 'Draft contribution', 'draft');
  const otherThread = await createOtherThread('Other account target');
  const targetPost = otherThread.firstPost.id;
  await grant(person, targetPost, ['report:create']);
  await call(person, 'PUT', `/v1/posts/${targetPost}/reaction`, { kind: 'like' });
  await call(person, 'POST', '/v1/reports', {
    target: { kind: 'post', id: targetPost },
    reason: 'other',
    evidence: `Private report evidence ${person.accountId}`,
  });
  await call(person, 'PUT', `/v1/subjects/${boardSubjectId}/reaction`, { kind: 'like' });

  const field = await call<{ subject: { id: string; statements: Record<string, { id: string }[]> } }>(
    person,
    'POST',
    '/v1/subjects',
    {
      type: 'schema:Recipe',
      labels: { en: 'Erased authored field' },
      statements: {
        'schema:abstract': [
          {
            property: { id: 'schema:abstract' },
            value: {
              type: 'value',
              content: {
                document: fromPlainText('Authored field that is deleted before account erasure'),
                licence: 'CC-BY-4.0',
                language: 'en',
              },
            },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/field' } },
                ],
              },
            ],
          },
        ],
      },
    },
  );
  const fieldRow = (
    await system.database.pool.query<{ id: string; candidate: string }>(
      'SELECT id::text,candidate::text FROM content.authored_field WHERE route=$1 AND subject=$2',
      [routeOf(field.subject.id), field.subject.id],
    )
  ).rows[0]!;
  const abstractCandidate = field.subject.statements['schema:abstract']?.[0];
  if (!abstractCandidate) throw new Error('Native authored field is missing its abstract candidate');
  await seedGovernanceAuthority(system.database.pool, routeOf(GLOBAL_CONTEXT)!, GLOBAL_CONTEXT, staff().accountId, [
    'moderation:hide',
  ]);
  await call(staff(), 'POST', `/v1/subjects/${field.subject.id}/candidates/${abstractCandidate.id}:hide`, {
    reason: 'Private authored field',
  });

  await seedGovernanceAuthority(system.database.pool, routeOf(GLOBAL_CONTEXT)!, GLOBAL_CONTEXT, staff().accountId, [
    'reaction:set',
  ]);
  const otherVersion = await readLikedVersion(system.database.pool, { actorAccountId: staff().accountId });
  await call(staff(), 'PUT', `/v1/subjects/${boardSubjectId}/reaction`, { kind: 'love' });
  const otherVersionAfterLike = await readLikedVersion(system.database.pool, { actorAccountId: staff().accountId });
  expect(otherVersionAfterLike).toBeGreaterThan(otherVersion);
  const version = await readLikedVersion(system.database.pool, { actorAccountId: person.accountId });
  expect(version).toBeGreaterThan(0n);

  await drainRelays();
  const erased = await erase(person);
  await waitParticipant(person, 'content', 'erased');
  await waitParticipant(person, 'delivery', 'erased');
  await drainRelays();

  const tombstone = await eventFor(person.accountId);
  const workClient = await createWorkClient(system.database.pool.options.connectionString!);
  try {
    await createAccountErasureEffect({ client: workClient }).run(tombstone);
  } finally {
    await workClient.close();
  }
  await drainRelays();

  const retainedRead = await call<{ post: { authorId: string; revisionId: string } }>(
    staff(),
    'GET',
    `/v1/posts/${published.firstPost.id}`,
  );
  expect(retainedRead.post).toMatchObject({ authorId: person.accountId, revisionId: published.firstPost.revisionId });
  expect(
    (
      await system.database.pool.query('SELECT availability,author_erased FROM content.post WHERE post_id=$1', [
        published.firstPost.id,
      ])
    ).rows[0],
  ).toEqual({ availability: 'available', author_erased: true });
  expect(
    (await system.database.pool.query('SELECT availability,title FROM content.thread WHERE thread_id=$1', [draft.id]))
      .rows[0],
  ).toEqual({ availability: 'available', title: null });
  expect(
    (await system.database.pool.query('SELECT availability FROM content.post WHERE post_id=$1', [draft.firstPost.id]))
      .rows[0].availability,
  ).toBe('erased');
  expect(
    (await system.database.pool.query('SELECT body FROM content.authored_field WHERE id=$1', [fieldRow.id])).rows[0]
      .body,
  ).toBeNull();
  const fieldRead = await system.kernel.handle(
    new Request(`https://content.test/v1/documents/${fieldRow.id}`, {
      headers: { authorization: `Bearer ${staff().bearer}` },
    }),
  );
  expect(fieldRead.status).toBe(404);
  expect(
    (
      await system.database.pool.query(
        'SELECT evidence,reporter_account_id FROM content.report WHERE reporter_account_id IS NULL AND target_id=$1',
        [targetPost],
      )
    ).rows,
  ).toEqual(expect.arrayContaining([{ evidence: null, reporter_account_id: null }]));
  expect(
    (
      await system.database.pool.query('SELECT 1 FROM content.reaction WHERE route=$1 AND actor_account_id=$2', [
        routeOf(person.accountId),
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await system.database.pool.query(
        'SELECT 1 FROM content.reaction_liked_version WHERE route=$1 AND actor_account_id=$2',
        [routeOf(person.accountId), person.accountId],
      )
    ).rows,
  ).toEqual([]);
  expect(await readLikedVersion(system.database.pool, { actorAccountId: person.accountId })).toBe(0n);
  expect(
    (
      await system.database.pool.query('SELECT 1 FROM content.reaction WHERE route=$1 AND actor_account_id=$2', [
        routeOf(person.accountId),
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
  expect(await readLikedVersion(system.database.pool, { actorAccountId: staff().accountId })).toBe(
    otherVersionAfterLike,
  );
  expect(fake.objects.has(`m/${retainedMedia}/original`)).toBe(true);
  for (const id of [mediaAvatar, standalone])
    expect([...fake.objects.keys()].some((object) => object.startsWith(`m/${id}/`))).toBe(false);
  expect(new Date(erased.at).getTime()).toBeGreaterThan(0);
});

test('deleting an account with no content acknowledges content none', async () => {
  const person = await createPerson();
  await erase(person);
  await waitParticipant(person, 'content', 'none');
  await waitParticipant(person, 'delivery', 'none');
});

test('a replayed tombstone event neither repeats work nor acknowledges twice, and pending Collection media delays the acknowledgement', async () => {
  const person = await createPerson();
  await grantMediaCreate(person);
  const dayAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  await system.clock.setCommandTime(dayAgo);
  const digest = createHash('sha256').update(png).digest('hex');
  const reservation = await call<{ media: { id: string } }>(
    { ...person, bearer: person.websiteBearer! },
    'POST',
    '/v1/media',
    {
      containerId: person.accountId,
      purpose: 'avatar',
      mediaType: 'image/png',
      byteCount: png.length,
      sha256: digest,
    },
  );
  const mediaId = reservation.media.id;
  fake.objects.set(`m/${mediaId}/original`, png);
  await drainRelays();

  const collectionStorage = {
    async get(key: string) {
      return fake.objects.get(key) ?? null;
    },
    async put(key: string, bytes: Uint8Array) {
      fake.objects.set(key, Buffer.from(bytes));
    },
    async deletePrefix() {
      throw new Error('collection storage is temporarily unavailable');
    },
  };
  const { createCollectionJob } = await import('../../src/content/collection-job.ts');
  const partition = partitionOf(routeOf(mediaId)!);
  await expect(
    createCollectionJob(system.database.pool, collectionStorage).collectPartition(partition, 10),
  ).rejects.toThrow();
  expect(
    (await system.database.pool.query('SELECT collection_pending FROM content.media WHERE media_id=$1', [mediaId]))
      .rows[0].collection_pending,
  ).toBe(true);

  await system.clock.setCommandTime(new Date().toISOString());
  await drainRelays();
  await erase(person);
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.participants.content?.outcome === 'pending' && status.participants.delivery?.outcome === 'pending';
  }, 'pending collection media to keep both participants unacknowledged');
  const tombstone = await eventFor(person.accountId);
  const url = system.database.pool.options.connectionString!;
  const client = await createWorkClient(url);
  try {
    await createAccountErasureEffect({ client }).run(tombstone);
  } finally {
    await client.close();
  }

  const completeCollectionStorage = {
    async get(key: string) {
      return fake.objects.get(key) ?? null;
    },
    async put(key: string, bytes: Uint8Array) {
      fake.objects.set(key, Buffer.from(bytes));
    },
    async deletePrefix(prefix: string) {
      for (const key of fake.objects.keys()) if (key.startsWith(prefix)) fake.objects.delete(key);
    },
  };
  await createCollectionJob(system.database.pool, completeCollectionStorage).collectPartition(partition, 10);
  await resumeParticipant(person);
  await waitParticipant(person, 'content', 'erased');
  await waitParticipant(person, 'delivery', 'erased');
  const final = await readErasureStatus(system.database.pool, person.accountId);
  expect(final?.participants.content?.outcome).toBe('erased');
  expect(final?.participants.delivery?.outcome).toBe('erased');
});

test("a moderator's recent statements are acknowledged as one retention exception and resolved after the expiry purge", async () => {
  const person = await createPerson();
  const targets = [
    await createOtherThread('First moderated public contribution'),
    await createOtherThread('Second moderated public contribution'),
  ];
  for (const target of targets) await grant(person, target.firstPost.id, ['moderation:takedown']);
  const now = Date.now();
  const firstAt = new Date(now - 40 * 86400000);
  const secondAt = new Date(now - 10 * 86400000);
  const decisions: { id: string; decidedAt: Date }[] = [];
  for (const [index, at] of [firstAt, secondAt].entries()) {
    await system.clock.setCommandTime(at.toISOString());
    await call(person, 'POST', `/v1/posts/${targets[index]!.firstPost.id}:takeDown`, {
      reason: 'Complaint statement retained',
    });
    const { rows } = await system.database.pool.query<{ decision_id: string; decided_at: Date }>(
      'SELECT decision_id::text,decided_at FROM content.moderation_decision WHERE target_id=$1 ORDER BY decided_at',
      [targets[index]!.firstPost.id],
    );
    decisions.push(...rows.map((row) => ({ id: row.decision_id, decidedAt: row.decided_at })));
  }
  await system.clock.setCommandTime(new Date().toISOString());
  await drainRelays();
  await erase(person);
  await waitParticipant(person, 'content', 'erased');

  const status = await readErasureStatus(system.database.pool, person.accountId);
  const retained = status?.participants.content?.retained ?? [];
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    store: 'content.moderation_decision',
    fields: ['statement'],
    purpose: 'Statements of reasons kept for complaints by the affected person, open six months after each decision',
    resolvedAt: null,
  });
  expect(status?.state).toBe('retention-outstanding');
  const dueAt = decisions
    .map(({ decidedAt }) => new Date(decidedAt.getTime() + 183 * 86400000))
    .sort((a, b) => a.getTime() - b.getTime());
  expect(new Date(retained[0]!.expiresAt).getTime()).toBe(dueAt[1]!.getTime());

  const firstPurge = await purgeAccountStatementsPage({ pool: system.database.pool }, person.accountId, {
    asOf: new Date(dueAt[0]!.getTime() + 1),
    after: null,
  });
  expect(firstPurge.found).toBe(1);
  expect(firstPurge.nextDueAt?.getTime()).toBe(dueAt[1]!.getTime());
  expect(
    (
      await system.database.pool.query(
        'SELECT statement FROM content.moderation_decision WHERE target_id = ANY($1::uuid[]) ORDER BY decided_at',
        [targets.map((target) => target.firstPost.id)],
      )
    ).rows.map((row) => row.statement),
  ).toEqual(['', 'Complaint statement retained']);
  expect((await readErasureStatus(system.database.pool, person.accountId))?.state).toBe('retention-outstanding');

  const secondPurge = await purgeAccountStatementsPage({ pool: system.database.pool }, person.accountId, {
    asOf: new Date(dueAt[1]!.getTime() + 1),
    after: null,
  });
  expect(secondPurge.found).toBe(1);
  expect(secondPurge.nextDueAt).toBeNull();
  await resolveRetention(
    { pool: system.database.pool },
    {
      accountId: person.accountId,
      participant: 'content',
      store: 'content.moderation_decision',
    },
  );
  expect((await readErasureStatus(system.database.pool, person.accountId))?.state).toBe('complete');
  expect(
    (
      await system.database.pool.query(
        'SELECT statement FROM content.moderation_decision WHERE target_id = ANY($1::uuid[]) ORDER BY decided_at',
        [targets.map((target) => target.firstPost.id)],
      )
    ).rows,
  ).toEqual([{ statement: '' }, { statement: '' }]);
});
