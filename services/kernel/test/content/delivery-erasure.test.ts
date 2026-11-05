import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from './support/disclosure-fixtures.ts';

setDefaultTimeout(360_000);
type Person = { accountId: string; bearer: string; websiteBearer?: string };
type Thread = { id: string; firstPost: { id: string } };
type FakeStore = {
  endpoint: string;
  objects: Map<string, Buffer>;
  failingMedia: Set<string>;
  failedDeletes: number;
  close(): Promise<void>;
};
let system: NativeContentSystem;
let worker: ChildProcessWithoutNullStreams | undefined;
let workerOutput = '';
let boardId: string;
let png: Buffer;
let fake: FakeStore;
let monitoredLateMedia: string | null = null;
let monitoredLateAccount: string | null = null;
let lateDeleteHadOpenItem: boolean[] = [];
const workerExecutable = process.execPath;
const staff = (): Person => ({ accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer });
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
      if (monitoredLateMedia && monitoredLateAccount && key.startsWith(`m/${monitoredLateMedia}/`)) {
        const status = await readErasureStatus(system.database.pool, monitoredLateAccount);
        lateDeleteHadOpenItem.push(status?.outstanding.lateItems === true);
      }
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

async function grant(person: Person, resourceId: string, actions: string[]) {
  const route = routeOf(resourceId)!;
  await seedGovernanceAuthority(system.database.pool, route, resourceId, staff().accountId, [
    'access:grant',
    ...actions,
  ]);
  await call(staff(), 'POST', '/v1/grants', {
    resource: { route, id: resourceId },
    subject: { kind: 'account', id: person.accountId },
    actions,
    valid: '(,)',
  });
}

async function createThread(person: Person, title: string): Promise<Thread> {
  if (person.accountId !== staff().accountId) await grant(person, boardId, ['thread:create', 'board:read']);
  return (
    await call<{ thread: Thread }>(person, 'POST', '/v1/threads', {
      boardId,
      title,
      visibility: 'published',
      body: fromPlainText(`${title} body`),
      licence: 'CC0-1.0',
      subjectIds: [],
    })
  ).thread;
}

async function createPerson(): Promise<Person> {
  return (await accountDeletionRuntime(system).person()) as Person;
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

async function waitDelivery(person: Person, outcome: 'erased' | 'none') {
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.participants.delivery?.outcome === outcome;
  }, `delivery ${outcome} for ${person.accountId}`);
}

async function drainRelays() {
  const { rows } = await system.database.pool.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position>0',
  );
  for (const row of rows) await drainEffects(system.database.pool, row.partition_no, { deadlineMs: 120_000 });
}

async function startWorker(options: { holdAccountUploadIndex?: boolean } = {}) {
  if (worker && worker.exitCode === null) return;
  const url = system.database.pool.options.connectionString;
  if (!url) throw new Error('Native database URL is missing');
  worker = spawn(
    workerExecutable,
    [
      'run',
      new URL('./support/disclosure-fixtures.ts', import.meta.url).pathname,
      '--disclosure-worker',
      ...(options.holdAccountUploadIndex ? ['--hold-account-upload-index'] : []),
    ],
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
    const lines = createInterface({ input: worker!.stdout });
    lines.on('line', (line) => {
      workerOutput += `${line}\n`;
      if (line === 'ready') resolve();
    });
    worker!.once('exit', (code) => reject(new Error(`Content worker exited ${code}: ${workerOutput}`)));
  });
  await ready;
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const exiting = once(worker, 'exit');
  worker.stdin.write('release-account-upload-index\n');
  worker.stdin.end('stop\n');
  await exiting;
}

function releaseHeldAccountUploadIndex() {
  if (!worker || worker.exitCode !== null) throw new Error('Disclosure worker is not running');
  worker.stdin.write('release-account-upload-index\n');
}

async function deleteAccount(person: Person) {
  const runtime = accountDeletionRuntime(system);
  return deletePersona({ version: 1, pool: system.database.pool, auth: runtime.auth }, person);
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
    title: 'Delivery erasure space',
    summary: '',
  });
  const { realm } = await call<{ realm: { realmId: string; headRevisionId: string } }>(staff(), 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Delivery erasure realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await call<{ subject: { id: string } }>(staff(), 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Delivery erasure scheme' },
  });
  const { subject: concept } = await call<{ subject: { id: string } }>(staff(), 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Delivery erasure board' },
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
    title: 'Delivery erasure board',
    visibility: 'published',
  });
  void assigned;
  boardId = board.id;
  await startWorker();
  await drainRelays();
});

afterAll(async () => {
  try {
    await stopWorker();
  } finally {
    await fake?.close();
    await system?.close();
  }
});

test("deleting an account acknowledges delivery erased only after every stored object of its erased media is deleted, and keeps retained media's objects", async () => {
  const person = await createPerson();
  await grantMediaCreate(person);
  const thread = await createThread(person, 'Retained media contribution');
  await grantMediaCreate(person, thread.id);
  const avatar = await upload(person, person.accountId, 'avatar');
  const standalone = await upload(person, thread.id);
  const retained = await upload(person, thread.id);
  await Promise.all([waitMediaReady(avatar), waitMediaReady(standalone), waitMediaReady(retained)]);
  await grant(person, thread.id, ['post:create', 'thread:read']);
  await call(person, 'POST', `/v1/threads/${thread.id}/posts`, {
    body: fromPlainText('Retained image'),
    mediaIds: [retained],
    licence: 'CC0-1.0',
    subjectIds: [],
    parentId: thread.firstPost.id,
  });
  await drainRelays();

  fake.failingMedia.add(avatar);
  await deleteAccount(person);
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.participants.delivery?.outcome === 'pending' && fake.failedDeletes > 0;
  }, 'a failed object deletion to keep delivery pending');
  expect(fake.objects.has(`m/${avatar}/original`)).toBe(true);
  expect(fake.objects.has(`m/${retained}/original`)).toBe(true);

  fake.failingMedia.delete(avatar);
  await waitDelivery(person, 'erased');
  for (const id of [avatar, standalone])
    expect([...fake.objects.keys()].some((key) => key.startsWith(`m/${id}/`))).toBe(false);
  expect([...fake.objects.keys()].some((key) => key.startsWith(`m/${retained}/`))).toBe(true);
});

test('deleting an account that never uploaded acknowledges delivery none', async () => {
  const person = await createPerson();
  await deleteAccount(person);
  await waitDelivery(person, 'none');
});

test('an upload whose locator effect runs after the erasure fence closes has its objects deleted before its late item resolves', async () => {
  await stopWorker();
  const person = await createPerson();
  await grantMediaCreate(person);
  const mediaId = await upload(person, person.accountId, 'avatar');
  monitoredLateMedia = mediaId;
  monitoredLateAccount = person.accountId;
  lateDeleteHadOpenItem = [];
  fake.failingMedia.add(mediaId);
  await deleteAccount(person);
  await startWorker({ holdAccountUploadIndex: true });
  await waitUntil(
    async () => workerOutput.includes('account-upload-index-held'),
    'the registered upload locator effect to pause',
  );
  await waitUntil(async () => {
    const { rows } = await system.database.pool.query<{ closed_at: string | null }>(
      'SELECT closed_at::text FROM content.erasure_fence WHERE route=$1 AND account_id=$2',
      [routeOf(person.accountId), person.accountId],
    );
    return rows[0]?.closed_at !== null && rows[0]?.closed_at !== undefined;
  }, 'the normal content participant to close the account locator fence');

  releaseHeldAccountUploadIndex();
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.outstanding.lateItems === true && fake.failedDeletes > 0;
  }, 'a late upload locator item to stay open while object deletion fails');
  expect(fake.objects.has(`m/${mediaId}/original`)).toBe(true);
  expect((await readErasureStatus(system.database.pool, person.accountId))?.outstanding.lateItems).toBe(true);
  fake.failingMedia.delete(mediaId);
  await waitUntil(async () => {
    const status = await readErasureStatus(system.database.pool, person.accountId);
    return status?.outstanding.lateItems === false && !fake.objects.has(`m/${mediaId}/original`);
  }, 'the registered upload locator effect to delete its object and resolve the late item');
  expect(lateDeleteHadOpenItem.length).toBeGreaterThan(0);
  expect(lateDeleteHadOpenItem.every(Boolean)).toBe(true);
  expect(fake.objects.has(`m/${mediaId}/original`)).toBe(false);
  expect((await readErasureStatus(system.database.pool, person.accountId))?.outstanding.lateItems).toBe(false);
  monitoredLateMedia = null;
  monitoredLateAccount = null;
});
