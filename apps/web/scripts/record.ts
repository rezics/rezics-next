import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { facetProperties } from '@rezics/filter';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { stackRun } from '../../../scripts/stack-run.ts';
import { storySubjects } from '../src/kernel/story-subjects';

// Names on the command line select the recordings to write; with none, every recording is written.
const only = Bun.argv.slice(2).filter((argument) => argument !== '--');
const writes = (...prefixes: string[]) =>
  only.length === 0 || only.some((name) => prefixes.some((prefix) => name.startsWith(prefix)));
const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const accountId = Bun.randomUUIDv7();
const kernelRouteKey = randomBytes(32).toString('base64url');
const sessionKey = randomBytes(32).toString('base64url');
const issuer = `http://127.0.0.1:${await freePort()}`;
const audience = 'https://api.rezics.test';
const signing = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: 'web-recorder', alg: 'ES256', use: 'sig' };
const privateJwk = { ...(await exportJWK(signing.privateKey)), kid: 'web-recorder', alg: 'ES256' };
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const ownedThreadRoute = 0x2345;
const threadAt = '2026-10-24T00:00:00.000Z';
const postTimes = ['2026-10-24T00:00:00.000Z', '2026-10-24T00:01:00.000Z', '2026-10-24T00:02:00.000Z'] as const;
const boardTitle = 'Stories of the little prince';
const threadTitle = 'Letters from B-612';
const ownedThreadTitle = 'Baobab seedlings: a watering schedule';
const searchPrefix = 'webrec';
const pagePrefix = 'webrecpage';
const matchingQuery = 'The';
const typedQuery = 'Prince';
const emptyQuery = 'zzzznotasubject';
// Two subjects per vertical list of the home. They exist only in the search index and its in-process source.
const subjectSeeds = storySubjects.map(({ id, type, labels }) => ({ id, type, labels }));
let container = '';
let searchContainer = '';
let kernel: ReturnType<typeof spawn> | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let jwks: ReturnType<typeof Bun.serve> | undefined;
let pool: Pool | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function publishedPort(containerId: string, port: string): number {
  const output = docker(['port', containerId, port]);
  const value = Number(output.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Could not find port ${port}: ${output}`);
  return value;
}

function startSearchContainer(image: string): string {
  return docker([
    'run',
    '-d',
    '--label',
    'rezics.web.record.search=1',
    '-p',
    '127.0.0.1::9200',
    '--tmpfs',
    '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    image,
  ]);
}

async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
    try {
      await probe.query('SELECT 1');
      return;
    } catch {
      await Bun.sleep(500);
    } finally {
      await probe.end();
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

async function waitForKernel(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 90_000;
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-5000)));
  child.stderr?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-5000)));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kernel exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(`${origin}/v1/subjects/00000000-0000-4000-8000-000000000000`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 404) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`Kernel did not become ready:\n${output}`);
}

async function stopKernel(): Promise<void> {
  if (worker?.pid && worker.exitCode === null) {
    const child = worker;
    child.kill('SIGTERM');
    await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  worker = undefined;
  if (!kernel?.pid) return;
  kernel.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => kernel!.once('exit', () => resolve())), Bun.sleep(10_000)]);
  if (kernel.exitCode === null) kernel.kill('SIGKILL');
  kernel = undefined;
}

type JsonObject = Record<string, unknown>;
type ReleaseDefinitions = Parameters<typeof facetProperties>[0] & {
  properties: Record<string, { datatype: string; value?: { pattern?: string } }>;
};

function objectBody(body: unknown, description: string): JsonObject {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`${description} returned a non-object JSON response.`);
  return body as JsonObject;
}

function blocks(content: unknown[]) {
  return {
    body: { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content } },
    licence: 'MIT',
    subjectIds: [],
  };
}

function text(value: string, marks?: { type: string; attrs?: { href: string } }[]) {
  return { type: 'text', text: value, ...(marks ? { marks } : {}) };
}

function paragraph(id: string, content: unknown[]) {
  return { type: 'paragraph', attrs: { id }, content };
}

/** Repeats a request the kernel refused as overloaded; a write keeps its idempotency key, so a repeat is safe. */
async function retryOverloaded(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 503 || attempt === 20) return response;
    await Bun.sleep(1000);
  }
}

const libraryScopes = [
  'account:read',
  'account:update',
  'subject:create',
  'subject:read',
  'exposure:open',
  'library_entry:update',
  'library_entry:list',
  'library_entry:read',
  'collection:create',
  'collection:update',
  'collection:read',
  'follow:create',
  'follow:list',
  'follow:read',
  'copy:create',
  'copy:list',
  'copy:read',
  'progress_session:create',
  'progress_session:update',
  'progress_session:list',
  'progress_session:read',
  'published_log:create',
  'published_log:read',
].join(' ');

async function libraryToken(account: string, scope = libraryScopes): Promise<string> {
  return new SignJWT({
    client_id: 'web-recorder',
    scope,
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'web-recorder', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(account)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateJwk);
}

const librarySubjectSeeds = [
  {
    key: 'kokoro',
    id: '01a17a3b-6b89-748f-a486-33c354ef3c9a',
  },
  {
    key: 'norwegian-wood',
    id: '01a17a3b-6bab-705b-935e-d6dc0cacd82d',
  },
  {
    key: 'genji',
    id: '01a17a3b-6bc3-764f-8727-7872d197bd93',
  },
  {
    key: 'cat',
    id: '01a17a3b-6bd9-706f-b395-987536454933',
  },
  {
    key: 'snow-country',
    id: '01a17a3b-6c01-77c8-94fd-810a3ae73369',
  },
].map(({ key, id }) => {
  const subject = storySubjects.find((entry) => entry.id === id);
  if (!subject) throw new Error(`Library story subject ${id} is missing from story-subjects.ts.`);
  return { key, labels: subject.labels };
});

type ValidatedDocument = { canonicalBytes: Uint8Array; searchText: string; subjectIds: readonly string[] };

/**
 * Writes one published thread with its posts straight into the content tables. The last post replies to the opening
 * post; the others are top level. The posts belong to `accountId`.
 */
async function seedThread(
  database: Pool,
  input: {
    route: number;
    accountId: string;
    boardId: string;
    title: string;
    at: string;
    times: readonly string[];
    documents: readonly ValidatedDocument[];
  },
): Promise<{ threadId: string; openingPostId: string }> {
  const kernelBase = '../../../services/kernel';
  const { newId, partitionOf } = await import(`${kernelBase}/src/route/route.ts`);
  const { runCommand } = await import(`${kernelBase}/src/command/command.ts`);
  const { applyBoardCandidate } = await import(`${kernelBase}/src/content/board-projection.ts`);
  const { GLOBAL_CONTEXT } = await import(`${kernelBase}/src/semantic/definitions.ts`);
  const { route, boardId, title, at, times, documents } = input;
  const threadId = newId(route);
  const posts = times.map(() => ({ post: newId(route), revision: newId(route) }));
  const opening = posts[0];
  if (!opening) throw new Error('The recording thread needs an opening post.');
  await runCommand(
    database,
    { partition: partitionOf(route) },
    async (tx: { query: (sql: string, values: readonly unknown[]) => Promise<unknown> }) => {
      await tx.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$2,$6,$7)`,
        [route, threadId, input.accountId, boardId, title, opening.post, at],
      );
      for (const [index, post] of posts.entries()) {
        const document = documents[index];
        const postedAt = times[index];
        if (!document || !postedAt) throw new Error(`Recording post ${index} is missing its document.`);
        await tx.query(
          `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'published',1,$3,$7)`,
          [
            route,
            threadId,
            post.post,
            index === posts.length - 1 ? opening.post : null,
            input.accountId,
            post.revision,
            postedAt,
          ],
        );
        await tx.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}'::uuid[],$7,'available',$4)`,
          [
            route,
            threadId,
            post.post,
            post.revision,
            Buffer.from(document.canonicalBytes),
            document.searchText,
            boardId,
          ],
        );
      }
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.content.thread.created.v1',
            subject: threadId,
            data: {
              threadId,
              itemId: opening.post,
              revisionId: opening.revision,
              actorId: input.accountId,
              placeId: GLOBAL_CONTEXT,
              kind: 'discussion',
              subjectIds: documents[0]!.subjectIds,
              activityAt: at,
            },
          },
        ],
      };
    },
  );
  await applyBoardCandidate(database, { id: threadId, boardId, createdAt: at, epoch: 1, position: 1n });
  return { threadId, openingPostId: opening.post };
}

const realmThreadRoute = 0x4567;

/**
 * Seeds a Realm through the kernel's public API, with one board and one thread inserted like the other recorded
 * ones, and records the reads that name the Realm on a thread page and a board page: the board, the Realm, the board's
 * threads, and the thread with its posts. The recording account holds the platform's governance, so it grants itself
 * the actions that create the Realm.
 */
async function recordBoardRealm(input: {
  origin: string;
  pool: Pool;
  accountId: string;
  conceptId: string;
  newId: (route: number) => string;
  documents: readonly ValidatedDocument[];
}): Promise<Map<string, JsonObject>> {
  const { origin, accountId } = input;
  const token = await libraryToken(
    accountId,
    'access:grant context:create context:read space:create space:manage realm:create',
  );
  const send = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<JsonObject> => {
    const key = JSON.stringify(Bun.randomUUIDv7());
    const response = await retryOverloaded(() =>
      fetch(new URL(path, origin), {
        method,
        headers: {
          ...(method === 'GET' ? {} : { authorization: `Bearer ${token}`, 'idempotency-key': key }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const parsed = objectBody(await response.json(), `${method} ${path}`);
    if (response.status !== (method === 'GET' ? 200 : 201))
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(parsed)}`);
    return { ...parsed, status: response.status };
  };
  await send('POST', '/v1/grants', {
    resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
    subject: { kind: 'account', id: accountId },
    actions: ['context:create', 'space:create', 'realm:create'],
    valid: '(,)',
  });
  const created = async (path: string, body: unknown, field: string, idField: string): Promise<string> => {
    const value = objectBody(objectBody(await send('POST', path, body), path)[field], field)[idField];
    if (typeof value !== 'string') throw new Error(`${path} returned no ${idField}.`);
    return value;
  };
  const contextId = await created('/v1/contexts', { labels: { en: 'Reading circles' } }, 'context', 'id');
  const spaceId = await created(
    '/v1/spaces',
    { title: 'Little Prince Readers', summary: 'Readers of one short book.' },
    'space',
    'spaceId',
  );
  const realmId = await created(
    '/v1/realms',
    { spaceId, title: 'Little Prince Readers', summary: 'Readers of one short book.', visibility: 'public', contextId },
    'realm',
    'realmId',
  );
  // The board is inserted like the other recorded boards, in the route of its Realm. The route of an id is its
  // eleventh and twelfth bytes.
  const route = Number.parseInt(realmId.slice(24, 28), 16);
  const boardId = input.newId(route);
  await input.pool.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,'published',1,$2)`,
    [route, boardId, realmId, input.conceptId, 'Reading room'],
  );
  const { threadId } = await seedThread(input.pool, {
    route: realmThreadRoute,
    accountId,
    boardId,
    title: 'Which edition should I start with?',
    at: threadAt,
    times: postTimes.slice(0, 2),
    documents: input.documents,
  });
  const recorded = new Map<string, JsonObject>();
  for (const [name, path] of [
    ['board-realm', `/v1/boards/${boardId}`],
    ['board-realm-realm', `/v1/realms/${realmId}`],
    ['board-realm-threads', `/v1/boards/${boardId}/threads`],
    ['board-realm-thread', `/v1/threads/${threadId}`],
    ['board-realm-thread-posts', `/v1/threads/${threadId}/posts`],
  ] as const)
    recorded.set(name, await send('GET', path));
  const board = objectBody(recorded.get('board-realm')?.board, 'board-realm board');
  if (board.realmId !== realmId) throw new Error(`The recorded board names ${String(board.realmId)}, not ${realmId}.`);
  return recorded;
}

/**
 * Seeds a used-looking library through the kernel's public API and records the Library reads the pages make.
 * The recorded account keeps the library; a second account keeps a public collection that the first one follows.
 */
async function recordLibrary(input: {
  origin: string;
  pool: Pool;
  accountId: string;
  subjectId: string;
}): Promise<Map<string, JsonObject>> {
  const { origin, pool: database, accountId: me, subjectId: princeId } = input;
  const { routeOf } = await import('../../../services/kernel/src/route/route.ts');
  const other = Bun.randomUUIDv7();
  const otherRoute = routeOf(other);
  if (otherRoute === null) throw new Error('The second recording account id is not routable.');
  await database.query(
    `INSERT INTO access.account (route, account_id, kind, state, content_preferences, minimum_authn_epoch, transaction_id)
     VALUES ($1, $2, 'actor', 'active', '{}', 1, $2)`,
    [otherRoute, other],
  );
  // Handles and display names have no public write API yet; the pages show them next to a curator or author.
  const profiles: [string, string, string][] = [
    [me, 'mira', 'Mira Okabe'],
    [other, 'shelfkeeper', 'Daniel Reyes'],
  ];
  for (const [account, handle, displayName] of profiles)
    await database.query(`UPDATE access.account SET handle = $2, display_name = $3 WHERE account_id = $1`, [
      account,
      handle,
      displayName,
    ]);
  const tokens = { me: await libraryToken(me), other: await libraryToken(other) };

  const call = async (
    name: string,
    token: string | null,
    method: string,
    path: string,
    status: number,
    body?: unknown,
    acceptLanguage?: string,
  ): Promise<JsonObject> => {
    const key = `"${Bun.randomUUIDv7()}"`;
    const response = await retryOverloaded(() =>
      fetch(new URL(path, origin), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
          ...(method === 'GET' ? {} : { 'idempotency-key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    const parsed = text ? objectBody(JSON.parse(text), name) : {};
    if (response.status !== status) throw new Error(`${name} returned ${response.status}: ${text}`);
    return parsed;
  };
  const idOf = (body: JsonObject, key: string): string => {
    const id = objectBody(body[key], key).id;
    if (typeof id !== 'string') throw new Error(`${key} has no id: ${JSON.stringify(body)}`);
    return id;
  };

  // The gates that guard these pages are open in the recording, as they will be once the pages are reviewed.
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await call(`open ${group}`, tokens.me, 'POST', `/v1/platform/exposure/${group}:open`, 200);

  const subjects: Record<string, string> = { prince: princeId };
  for (const subject of librarySubjectSeeds)
    subjects[subject.key] = idOf(
      await call(`subject ${subject.key}`, tokens.me, 'POST', '/v1/subjects', 201, {
        type: 'schema:Book',
        labels: subject.labels,
      }),
      'subject',
    );
  const subject = (key: string): string => subjects[key] ?? '';

  const states: [string, string][] = [
    ['prince', 'completed'],
    ['kokoro', 'in_progress'],
    ['norwegian-wood', 'planned'],
    ['genji', 'paused'],
    ['cat', 'dropped'],
  ];
  for (const [key, state] of states)
    await call(`entry ${key}`, tokens.me, 'PUT', `/v1/libraryEntries/${subject(key)}`, 201, { state });
  // A second write moves one entry on, so the revisions differ.
  await call('entry kokoro update', tokens.me, 'PUT', `/v1/libraryEntries/${subject('kokoro')}`, 200, {
    state: 'in_progress',
    revision: 1,
  });

  const shelf = idOf(
    await call('public collection', tokens.me, 'POST', '/v1/collections', 201, {
      title: 'Books I come back to',
      description: 'Short novels I reread every few years, in the order I would hand them to a friend.',
      visibility: 'public',
    }),
    'collection',
  );
  const members: Record<string, string> = {};
  const noted: Record<string, string> = {
    prince: 'Read it first as a child, and again whenever I need to be reminded what matters.',
    kokoro: 'The letter in the third part is the reason this one stays on the shelf.',
  };
  for (const key of ['genji', 'prince', 'kokoro', 'snow-country'])
    members[key] = idOf(
      await call(`member ${key}`, tokens.me, 'POST', `/v1/collections/${shelf}/members`, 201, {
        subjectId: subject(key),
        ...(noted[key] ? { note: noted[key] } : {}),
      }),
      'member',
    );
  // Added last, moved to the front: the order is chosen, not the order of adding.
  await call(
    'move member',
    tokens.me,
    'POST',
    `/v1/collections/${shelf}/members/${members['snow-country']}:move`,
    200,
    {
      after: null,
    },
  );
  await call('private collection', tokens.me, 'POST', '/v1/collections', 201, {
    title: 'To read this winter',
    description: null,
    visibility: 'private',
  }).then(async (created) => {
    const id = idOf(created, 'collection');
    for (const key of ['norwegian-wood', 'cat'])
      await call(`private member ${key}`, tokens.me, 'POST', `/v1/collections/${id}/members`, 201, {
        subjectId: subject(key),
      });
  });

  await call('physical copy', tokens.me, 'POST', '/v1/copies', 201, {
    subjectId: subject('prince'),
    status: 'owned',
    location: 'Hallway shelf, second row',
    source: 'Kinokuniya Shinjuku',
    acquiredOn: '2024-03-16',
    note: 'Paperback with the original watercolours.',
  });
  await call('digital copy', tokens.me, 'POST', '/v1/copies', 201, {
    subjectId: subject('kokoro'),
    status: 'owned',
    location: 'Kobo library, e-book',
    source: 'Kobo',
    acquiredOn: '2025-11-02',
    note: 'EPUB, Meredith McKinney translation.',
  });

  const session = objectBody(
    (
      await call('progress session', tokens.me, 'POST', '/v1/progressSessions', 201, {
        subjectId: subject('kokoro'),
        mode: 'cursor_position',
        unit: 'chapter',
      })
    ).progressSession,
    'progress session',
  );
  const sessionId = session.id;
  if (typeof sessionId !== 'string' || typeof session.revision !== 'number')
    throw new Error(`Progress session is malformed: ${JSON.stringify(session)}`);
  await call('progress record', tokens.me, 'POST', `/v1/progressSessions/${sessionId}:record`, 200, {
    revision: session.revision,
    locator: 'Part 2, chapter 14',
    position: '42',
  });
  const log = idOf(
    await call('published log', tokens.me, 'POST', '/v1/publishedLogs', 201, {
      sessionId,
      note: 'Halfway through. The summer chapters are slow and exact; I am reading them on the train.',
    }),
    'publishedLog',
  );

  const neighbour = idOf(
    await call('second collection', tokens.other, 'POST', '/v1/collections', 201, {
      title: 'Quiet novels for long evenings',
      description: 'Books that reward a slow read.',
      visibility: 'public',
    }),
    'collection',
  );
  await call('second member', tokens.other, 'POST', `/v1/collections/${neighbour}/members`, 201, {
    subjectId: subject('snow-country'),
  });
  await call('follow collection', tokens.me, 'PUT', `/v1/follows/${neighbour}`, 200);
  // The worker projects the listing of the collections that hold a subject; wait until the read names the shelf.
  const listingDeadline = Date.now() + 60_000;
  for (;;) {
    const listed = await retryOverloaded(() =>
      fetch(new URL(`/v1/subjects/${princeId}/collections?view=FULL&limit=100`, origin), {
        headers: { authorization: `Bearer ${tokens.me}` },
      }),
    );
    const collections = listed.status === 200 ? objectBody(await listed.json(), 'subject collections').collections : [];
    if (Array.isArray(collections) && collections.length > 0) break;
    if (Date.now() > listingDeadline)
      throw new Error(`The subject listing did not name a collection: ${listed.status}`);
    await Bun.sleep(500);
  }
  // The collections that hold the subject are seeded; the other recordings read the rest of the library.
  if (!writes('library-', 'settings-')) return new Map();

  const recordedLibrary = new Map<string, JsonObject>();
  const localizedNames = new Set([
    'library-entries',
    'library-collections',
    'library-collection',
    'library-collection-members',
    'library-continue-entries',
  ]);
  const read = async (name: string, token: string | null, path: string) => {
    if (localizedNames.has(name)) {
      let english: JsonObject | undefined;
      for (const locale of ['en', 'zh-Hans']) {
        const body = await call(`${name}-${locale}`, token, 'GET', path, 200, undefined, locale);
        recordedLibrary.set(locale === 'en' ? name : `${name}-${locale}`, { ...body, status: 200 });
        if (locale === 'en') english = body;
      }
      return english!;
    }
    const body = await call(name, token, 'GET', path, 200);
    recordedLibrary.set(name, { ...body, status: 200 });
    return body;
  };
  const page = 'view=FULL&limit=100';
  // One change from the defaults, so the settings page shows a level other than the default and a version above zero.
  await call('set preferences', tokens.me, 'PATCH', `/v1/accounts/${me}/preferences`, 200, {
    expectedVersion: 0,
    spoilerLevel: 1,
  });
  await read('settings-preferences', tokens.me, `/v1/accounts/${me}/preferences`);
  await read('library-entries', tokens.me, `/v1/libraryEntries?${page}`);
  await read('library-collections', tokens.me, `/v1/collections?${page}&curatorAccountId=${me}`);
  await read('library-collection', null, `/v1/collections/${shelf}?view=FULL`);
  await read('library-collection-members', null, `/v1/collections/${shelf}/members?${page}`);
  await read('library-copies', tokens.me, `/v1/copies?${page}`);
  await read('library-follows', tokens.me, `/v1/follows?${page}`);
  await read('library-progress-sessions', tokens.me, `/v1/progressSessions?${page}&subjectId=${subject('kokoro')}`);
  await read('library-progress-session', tokens.me, `/v1/progressSessions/${sessionId}?view=FULL`);
  await read('library-progress-changes', tokens.me, `/v1/progressSessions/${sessionId}/changes?${page}`);
  await read('library-progress-units', tokens.me, `/v1/progressSessions/${sessionId}/completedUnits?${page}`);
  await read('library-published-log', null, `/v1/publishedLogs/${log}?view=FULL`);
  await read('library-published-logs', tokens.me, `/v1/publishedLogs?${page}&accountId=${me}`);

  if (writes('library-continue-entries', 'library-continue-progress-sessions')) {
    const continueSessions = [
      {
        key: 'genji',
        mode: 'scalar_amount',
        unit: 'episode',
        total: '12',
        record: { amount: '3' },
      },
      {
        key: 'cat',
        mode: 'scalar_amount',
        unit: 'page',
        record: { amount: '118' },
      },
      {
        key: 'norwegian-wood',
        mode: 'scalar_amount',
        unit: 'percent',
        record: { amount: '64' },
      },
      {
        key: 'prince',
        mode: 'completed_units',
        unit: 'chapter',
        record: { add: ['chapter-1', 'chapter-2', 'chapter-3', 'chapter-4', 'chapter-5'] },
      },
    ] as const;
    for (const item of continueSessions) {
      const created = objectBody(
        (
          await call(`progress session ${item.key}`, tokens.me, 'POST', '/v1/progressSessions', 201, {
            subjectId: subject(item.key),
            mode: item.mode,
            unit: item.unit,
            ...('total' in item ? { total: item.total } : {}),
          })
        ).progressSession,
        `progress session ${item.key}`,
      );
      const continuedId = created.id;
      if (typeof continuedId !== 'string' || typeof created.revision !== 'number')
        throw new Error(`Progress session ${item.key} is malformed: ${JSON.stringify(created)}`);
      await call(`progress record ${item.key}`, tokens.me, 'POST', `/v1/progressSessions/${continuedId}:record`, 200, {
        revision: created.revision,
        ...item.record,
      });
    }
  }

  if (writes('library-continue-entries')) {
    const currentEntries = recordedLibrary.get('library-entries')?.libraryEntries;
    if (!Array.isArray(currentEntries)) throw new Error('The library entries recording is malformed.');
    for (const value of currentEntries) {
      const entry = objectBody(value, 'library entry');
      if (typeof entry.subjectId !== 'string' || typeof entry.revision !== 'number')
        throw new Error(`The library entry is malformed: ${JSON.stringify(entry)}`);
      await call(`continue entry ${entry.subjectId}`, tokens.me, 'PUT', `/v1/libraryEntries/${entry.subjectId}`, 200, {
        state: 'in_progress',
        revision: entry.revision,
      });
    }
    await read('library-continue-entries', tokens.me, `/v1/libraryEntries?${page}&state=in_progress`);
  }
  if (writes('library-continue-progress-sessions')) {
    const continueEntries =
      recordedLibrary.get('library-continue-entries')?.libraryEntries ??
      recordedLibrary.get('library-entries')?.libraryEntries;
    if (!Array.isArray(continueEntries)) throw new Error('The Continue entries recording is malformed.');
    const progressSessions: unknown[] = [];
    for (const value of continueEntries) {
      const entry = objectBody(value, 'Continue entry');
      if (typeof entry.subjectId !== 'string')
        throw new Error(`The Continue entry is malformed: ${JSON.stringify(entry)}`);
      const response = await call(
        'Continue progress sessions',
        tokens.me,
        'GET',
        `/v1/progressSessions?${page}&subjectId=${encodeURIComponent(entry.subjectId)}`,
        200,
      );
      if (!Array.isArray(response.progressSessions))
        throw new Error(`The Continue progress sessions are malformed: ${JSON.stringify(response)}`);
      progressSessions.push(...response.progressSessions);
    }
    recordedLibrary.set('library-continue-progress-sessions', { status: 200, progressSessions, next: null });
  }

  const entries = recordedLibrary.get('library-entries')?.libraryEntries;
  const shelfMembers = recordedLibrary.get('library-collection-members')?.members;
  const shelfSubjects = Array.isArray(shelfMembers)
    ? shelfMembers.map((member) => objectBody(member, 'member').subjectId)
    : [];
  if (!Array.isArray(entries) || entries.length !== 5)
    throw new Error(`The library should hold five entries: ${JSON.stringify(entries)}`);
  const expectedSubjects = [subject('snow-country'), subject('genji'), princeId, subject('kokoro')];
  if (shelfSubjects.join('|') !== expectedSubjects.join('|'))
    throw new Error(`The public collection is not in the chosen order: ${shelfSubjects.join('|')}`);
  const follows = recordedLibrary.get('library-follows')?.follows;
  if (!Array.isArray(follows) || !follows.some((follow) => objectBody(follow, 'follow').targetId === neighbour))
    throw new Error(`The followed collection is missing: ${JSON.stringify(follows)}`);
  return recordedLibrary;
}

/** Keep story content and identities stable while adding newly recorded response fields. */
function stableRecording(value: unknown, previous: unknown): unknown {
  if (previous === undefined) return value;
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  if (typeof value === 'string' && typeof previous === 'string') return previous;
  if (Array.isArray(value) && Array.isArray(previous))
    return previous.map((item, index) => stableRecording(value[index], item));
  if (!value || typeof value !== 'object' || !previous || typeof previous !== 'object') return previous;
  const current = value as Record<string, unknown>;
  const before = previous as Record<string, unknown>;
  const oldIds = Object.keys(before).filter((key) => key.match(uuid));
  const newIds = Object.keys(current).filter((key) => key.match(uuid));
  return Object.fromEntries([
    ...Object.entries(current).filter(([name]) => !Object.hasOwn(before, name) && !newIds.includes(name)),
    ...Object.entries(before).flatMap(([name, item]) => {
      if (['cover', 'label', 'labels'].includes(name) && !Object.hasOwn(current, name)) return [];
      const recordedName = oldIds.includes(name) ? (newIds[oldIds.indexOf(name)] ?? name) : name;
      return [
        [
          name,
          ['cover', 'label', 'labels'].includes(name)
            ? current[recordedName]
            : stableRecording(current[recordedName], item),
        ],
      ];
    }),
  ]);
}

/** Recorded story rows use the shared subject entry's cover, including its explicit placeholder choice. */
function applyStorySubjectCovers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(applyStorySubjectCovers);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, applyStorySubjectCovers(child)]),
  ) as Record<string, unknown>;
  const subject =
    typeof result.id === 'string' && typeof result.type === 'string' && (result.labels || result.label)
      ? storySubjects.find((entry) => entry.id === result.id)
      : undefined;
  if (subject) result.cover = subject.cover ?? null;
  return result;
}

/**
 * Records the checkout reads: offers and the buyer's orders. The kernel runs in this process over the same database
 * with a local Stripe fixture, so the orders reach the settlements the pages show: paid, still pending and failed.
 */
async function recordCommerce(input: {
  pool: Pool;
  accountId: string;
  subjectId: string;
}): Promise<Map<string, JsonObject>> {
  const { pool: database, accountId: governor, subjectId } = input;
  const kernelBase = '../../../services/kernel';
  const { createKernel } = await import(`${kernelBase}/src/http/kernel.ts`);
  const { createAccess } = await import(`${kernelBase}/src/access/index.ts`);
  const { createCommerceCommands } = await import(`${kernelBase}/src/commerce/commands.ts`);
  const { createStripePort } = await import(`${kernelBase}/src/commerce/stripe.ts`);
  const { routeOf } = await import(`${kernelBase}/src/route/route.ts`);
  const { GLOBAL_CONTEXT } = await import(`${kernelBase}/src/semantic/definitions.ts`);
  const { startFakeStripe } = await import(`${kernelBase}/test/commerce/support/fake-stripe.ts`);
  const stripeFixture = startFakeStripe();
  try {
    const stripe = createStripePort({
      apiKey: 'sk_test_recorder',
      managedPayments: false,
      host: '127.0.0.1',
      port: stripeFixture.port,
      protocol: 'http',
      maxNetworkRetries: 0,
      timeoutMs: 5000,
      clock: () => new Date(),
    });
    // The seller holds only an explicit grant: a governor's reach over the platform is a separate path.
    const [seller, buyer] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    for (const account of [seller, buyer]) {
      const route = routeOf(account);
      if (route === null) throw new Error('A commerce recording account id is not routable.');
      await database.query(
        `INSERT INTO access.account (route, account_id, kind, state, content_preferences, minimum_authn_epoch, transaction_id)
         VALUES ($1, $2, 'actor', 'active', '{}', 1, $2)`,
        [route, account],
      );
    }
    await database.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,'offer:create','(,)',$2)`,
      [GLOBAL_CONTEXT, seller],
    );
    let access: unknown;
    const kernel = createKernel({
      pool: database,
      routeKey: Buffer.from(kernelRouteKey, 'base64url'),
      tokens: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
      access: (config: object) =>
        (access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/jwks`,
            fetch: async () => Response.json({ keys: [publicJwk] }),
          },
        })),
      commerce: {
        stripe,
        successUrl: 'https://example.test/orders/{ORDER_ID}?checkout=success',
        cancelUrl: 'https://example.test/orders/{ORDER_ID}?checkout=canceled',
        webhookSecrets: [stripeFixture.webhookSecret],
        work: { async enqueueStripeEvent() {} },
      },
    });
    const tokens = {
      governor: await libraryToken(governor, 'exposure:open'),
      seller: await libraryToken(seller, 'offer:create offer:manage offer:read'),
      buyer: await libraryToken(buyer, 'offer:read order:create order:read'),
    };
    const call = async (
      name: string,
      token: string | null,
      method: string,
      path: string,
      status: number,
      body?: unknown,
    ): Promise<JsonObject> => {
      const key = JSON.stringify(Bun.randomUUIDv7());
      const response = await retryOverloaded(() =>
        kernel.handle(
          new Request(`http://kernel.test${path}`, {
            method,
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(method === 'GET' ? {} : { 'idempotency-key': key }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      );
      const raw = await response.text();
      const parsed = raw ? objectBody(JSON.parse(raw), name) : {};
      if (response.status !== status) throw new Error(`${name} returned ${response.status}: ${raw}`);
      return parsed;
    };
    const idOf = (body: JsonObject, key: string): string => {
      const id = objectBody(body[key], key).id;
      if (typeof id !== 'string') throw new Error(`${key} has no id: ${JSON.stringify(body)}`);
      return id;
    };
    for (const group of ['purchases', 'selling'])
      await call(`open ${group}`, tokens.governor, 'POST', `/v1/platform/exposure/${group}:open`, 200);

    const taxCode = 'txcd_10302000';
    const offerBody = (title: string, currency: string, unitAmountMinor: number) => ({
      targetSubjectId: subjectId,
      title,
      currency,
      unitAmountMinor,
      taxCode,
    });
    const offers = {
      offer: idOf(
        await call(
          'offer',
          tokens.seller,
          'POST',
          '/v1/offers',
          201,
          offerBody('The Little Prince: annotated e-book edition', 'usd', 1299),
        ),
        'offer',
      ),
      'offer-cjk': idOf(
        await call(
          'offer cjk',
          tokens.seller,
          'POST',
          '/v1/offers',
          201,
          offerBody('小王子（全新註解・雙語對照・電子書典藏版）——附作者手繪水彩插圖、譯者導讀與版本考證', 'jpy', 1800),
        ),
        'offer',
      ),
      'offer-delisted': idOf(
        await call(
          'offer delisted',
          tokens.seller,
          'POST',
          '/v1/offers',
          201,
          offerBody('The Little Prince: first printing facsimile', 'eur', 2450),
        ),
        'offer',
      ),
    };
    await call('delist', tokens.seller, 'POST', `/v1/offers/${offers['offer-delisted']}:delist`, 200);

    const order = (offerId: string) => call('order', tokens.buyer, 'POST', '/v1/orders', 201, { offerId });
    const pending = idOf(await order(offers.offer), 'order');
    const toPay = idOf(await order(offers.offer), 'order');
    const sessionOf = async (orderId: string) => {
      const row = await database.query(`SELECT checkout_session_id FROM commerce.purchase_order WHERE order_id = $1`, [
        orderId,
      ]);
      const session = row.rows[0]?.checkout_session_id;
      if (typeof session !== 'string') throw new Error(`Order ${orderId} has no checkout session.`);
      return session;
    };
    const session = await sessionOf(toPay);
    stripeFixture.pay(session);
    await createCommerceCommands({ pool: database, access }).applyCheckoutSnapshot(
      await stripe.readCheckout(session),
      Bun.randomUUIDv7(),
    );
    stripeFixture.nextCreateFault = 'rejected';
    const failed = idOf(await order(offers.offer), 'order');

    const recordedCommerce = new Map<string, JsonObject>();
    for (const [name, id] of Object.entries(offers))
      recordedCommerce.set(name, { ...(await call(name, null, 'GET', `/v1/offers/${id}`, 200)), status: 200 });
    for (const [name, id] of [
      ['order-paid', toPay],
      ['order-pending', pending],
      ['order-failed', failed],
    ] as const)
      recordedCommerce.set(name, { ...(await call(name, tokens.buyer, 'GET', `/v1/orders/${id}`, 200)), status: 200 });
    const settled = (name: string) => objectBody(recordedCommerce.get(name)?.order, name).settlement;
    if (
      settled('order-paid') !== 'paid' ||
      settled('order-pending') !== 'pending' ||
      settled('order-failed') !== 'failed'
    )
      throw new Error(`The orders did not reach their settlements: ${JSON.stringify([...recordedCommerce])}`);
    return recordedCommerce;
  } finally {
    stripeFixture.stop();
  }
}

async function main(): Promise<void> {
  const kernelBase = '../../../services/kernel';
  const { startPostgresContainer } = await import(`${kernelBase}/scripts/check.ts`);
  const { buildSearchImage, waitForSearch } = await import(`${kernelBase}/scripts/search.ts`);
  const { migrate } = await import(`${kernelBase}/scripts/database.ts`);
  const id = fileURLToPath(new URL('../../../services/kernel/src/server.ts', import.meta.url));
  searchContainer = startSearchContainer(buildSearchImage());
  const containerId = startPostgresContainer();
  container = containerId;
  const port = publishedPort(containerId, '5432/tcp');
  const databaseUrl = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
  await waitForDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  migrate(databaseUrl);
  pool = new Pool({ connectionString: databaseUrl });
  await import(new URL('../../../services/kernel/node_modules/reylo/src/register.js', import.meta.url).href);
  const { setupSemantic } = await import(`${kernelBase}/src/semantic/setup.ts`);
  const { bundledRelease } = await import('@rezics/definitions/bundled');
  await setupSemantic(pool, bundledRelease);
  const { routeOf } = await import(`${kernelBase}/src/route/route.ts`);
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) throw new Error('The recording account id is not routable.');
  await pool.query(
    `INSERT INTO access.account (route, account_id, kind, state, content_preferences, minimum_authn_epoch, transaction_id)
     VALUES ($1, $2, 'actor', 'active', '{}', 1, $2)`,
    [accountRoute, accountId],
  );
  // The inserted account needs the self grants normally installed at account creation.
  await pool.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $2, 'account:update', '(,)', $2),
            ($1, $2, $2, 'account:read', '(,)', $2)`,
    [accountRoute, accountId],
  );
  const { bootstrapGovernance } = await import(`${kernelBase}/src/access/bootstrap-governance.ts`);
  await bootstrapGovernance(pool, accountId);

  jwks = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(new URL(issuer).port),
    fetch(request) {
      if (new URL(request.url).pathname !== '/jwks') return new Response(null, { status: 404 });
      return Response.json({ keys: [publicJwk] }, { headers: { 'cache-control': 'public, max-age=300' } });
    },
  });
  const kernelPort = await freePort();
  const origin = `http://127.0.0.1:${kernelPort}`;
  const kernelEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    // Concurrent checks can delay connections to the disposable PostgreSQL instance during startup.
    KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '10000',
    KERNEL_HOSTNAME: '127.0.0.1',
    KERNEL_PORT: String(kernelPort),
    KERNEL_ROUTE_KEY: kernelRouteKey,
    KERNEL_SESSION_KEYS: `1:${sessionKey}`,
    KERNEL_WRITE_RATE_SECRET: randomBytes(32).toString('base64url'),
    // Seeding a used library writes more than a new account's minute budget; the budget is a startup override.
    KERNEL_WRITE_RATE_OVERRIDES: JSON.stringify(
      Object.fromEntries(
        ['new-account', 'member', 'trusted'].map((rateClass) => [rateClass, { write: { maximum: 6000, seconds: 60 } }]),
      ),
    ),
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/jwks`,
    STRIPE_SECRET_KEY: 'sk_test_recorder',
    STRIPE_WEBHOOK_SECRETS: 'whsec_recorder',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://example.test/success/{ORDER_ID}',
    CHECKOUT_CANCEL_URL: 'https://example.test/cancel/{ORDER_ID}',
    NODE_ENV: 'development',
  };
  kernel = spawn('bun', [id], {
    cwd: resolve(root, 'services/kernel'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: kernelEnvironment,
  });
  await waitForKernel(origin, kernel);
  // The subject page reads collections; the route is guarded by the collections exposure group.
  const exposureToken = await libraryToken(accountId, 'exposure:open');
  const opening = await retryOverloaded(() =>
    fetch(`${origin}/v1/platform/exposure/collections:open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${exposureToken}`, 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) },
    }),
  );
  if (opening.status !== 200)
    throw new Error(`Opening collections returned ${opening.status}: ${await opening.text()}`);
  // Reverse links are projected asynchronously by the kernel worker.
  worker = spawn('bun', [resolve(root, 'services/kernel/src/worker.ts')], {
    cwd: resolve(root, 'services/kernel'),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...kernelEnvironment, KERNEL_RATING_COUNTER_SECRET: randomBytes(32).toString('base64url') },
  });
  const token = await new SignJWT({
    client_id: 'web-recorder',
    scope: 'subject:create subject:read',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'web-recorder', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateJwk);
  const labels = storySubjects.find(({ labels }) => labels.en === 'The Little Prince')!.labels;
  const create = async (body: JsonObject, description: string): Promise<string> => {
    const key = JSON.stringify(Bun.randomUUIDv7());
    const created = await retryOverloaded(() =>
      fetch(`${origin}/v1/subjects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      }),
    );
    const creation = (await created.json()) as { subject?: { id?: string } };
    const id = creation.subject?.id;
    if (created.status !== 201 || !id)
      throw new Error(`Creating ${description} returned ${created.status}: ${JSON.stringify(creation)}`);
    return id;
  };
  const item = (property: string, id: string) => ({
    property: { id: property },
    value: { type: 'value', content: id },
  });
  const code = (property: string, content: string) => ({
    property: { id: property },
    value: { type: 'value', content },
  });
  const date = (time: string, precision: 9 | 11) => ({
    property: { id: 'schema:datePublished' },
    value: {
      type: 'value',
      content: { time, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    },
  });
  const saintExupery = await create(
    {
      type: 'schema:Person',
      labels: {
        en: 'Antoine de Saint-Exupéry',
        'zh-Hant': '安東尼·聖修伯里',
        'zh-Hans': '安托万·德·圣埃克苏佩里',
        ja: 'アントワーヌ・ド・サン＝テグジュペリ',
        ko: '앙투안 드 생텍쥐페리',
        de: 'Antoine de Saint-Exupéry',
        fr: 'Antoine de Saint-Exupéry',
        es: 'Antoine de Saint-Exupéry',
      },
    },
    'the author',
  );
  const woods = await create(
    {
      type: 'schema:Person',
      labels: {
        en: 'Katherine Woods',
        'zh-Hant': '凱瑟琳·伍茲',
        'zh-Hans': '凯瑟琳·伍兹',
        ja: 'キャサリン・ウッズ',
        ko: '캐서린 우즈',
        de: 'Katherine Woods',
        fr: 'Katherine Woods',
        es: 'Katherine Woods',
      },
    },
    'the translator',
  );
  const reynal = await create({ type: 'schema:Organization', labels: { en: 'Reynal & Hitchcock' } }, 'a publisher');
  const gallimard = await create({ type: 'schema:Organization', labels: { en: 'Gallimard' } }, 'a publisher');
  const fable = await create(
    {
      type: 'skos:Concept',
      labels: {
        en: 'Fable',
        'zh-Hant': '寓言',
        'zh-Hans': '寓言',
        ja: '寓話',
        ko: '우화',
        de: 'Fabel',
        fr: 'Fable',
        es: 'Fábula',
      },
    },
    'the genre',
  );
  const subjectId = await create(
    {
      type: 'schema:Book',
      labels,
      descriptions: {
        en: 'A poetic novella in which a pilot stranded in the Sahara meets a young prince from a tiny asteroid and learns what is essential.',
        ja: '砂漠に不時着した飛行士が、小さな星から来た王子さまと出会い、大切なものは目に見えないと教わる詩的な物語。',
        fr: "Conte poétique d'un aviateur tombé en panne dans le Sahara, qui rencontre un petit prince venu d'un minuscule astéroïde.",
        'zh-Hant': '迫降撒哈拉沙漠的飛行員，遇見來自小行星的小王子，並學會什麼才是重要的事。',
      },
      aliases: { en: ['Le Petit Prince'], ja: ['星の王子様'] },
      statements: {
        'schema:author': [item('schema:author', saintExupery)],
        'schema:datePublished': [date('+1943-04-06T00:00:00Z', 11)],
        'schema:inLanguage': [code('schema:inLanguage', 'fr')],
        'schema:genre': [item('schema:genre', fable)],
      },
    },
    'the recording subject',
  );
  // The release gives publisher and translator to editions, not to the work.
  const editionIds = [
    await create(
      {
        type: 'bf:Instance',
        labels: { en: 'The Little Prince (Reynal & Hitchcock, 1943)' },
        statements: {
          'schema:exampleOfWork': [item('schema:exampleOfWork', subjectId)],
          'schema:author': [item('schema:author', saintExupery)],
          'schema:translator': [item('schema:translator', woods)],
          'schema:publisher': [item('schema:publisher', reynal)],
          'schema:datePublished': [date('+1943-04-06T00:00:00Z', 11)],
          'schema:inLanguage': [code('schema:inLanguage', 'en')],
        },
      },
      'the first edition',
    ),
    await create(
      {
        type: 'bf:Instance',
        labels: { en: 'Le Petit Prince (Gallimard, 1946)', fr: 'Le Petit Prince (Gallimard, 1946)' },
        statements: {
          'schema:exampleOfWork': [item('schema:exampleOfWork', subjectId)],
          'schema:author': [item('schema:author', saintExupery)],
          'schema:publisher': [item('schema:publisher', gallimard)],
          'schema:datePublished': [date('+1946-00-00T00:00:00Z', 9)],
          'schema:inLanguage': [code('schema:inLanguage', 'fr')],
        },
      },
      'the second edition',
    ),
  ];
  if (!pool) throw new Error('Database pool is not open.');
  const database = pool;
  const { newId } = await import(`${kernelBase}/src/route/route.ts`);
  const { validateContentDocument } = await import(`${kernelBase}/src/content/document.ts`);
  const documents = [
    blocks([
      {
        type: 'heading',
        attrs: { id: 'flight-notes', level: 2 },
        content: [text('Flight notes')],
      },
      {
        type: 'bulletList',
        attrs: { id: 'watch-list' },
        content: [
          {
            type: 'listItem',
            attrs: { id: 'baobabs' },
            content: [paragraph('baobabs-text', [text('Watch the baobabs')])],
          },
        ],
      },
    ]),
    blocks([
      paragraph('asteroid', [text('The asteroid', [{ type: 'link', attrs: { href: 'https://example.com/b612' } }])]),
    ]),
    blocks([paragraph('rose', [text('The rose was unique', [{ type: 'spoiler' }])])]),
  ].map((input) => validateContentDocument(input));
  const boardId = newId(boardRoute);
  await database.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'published',1,$2)`,
    [boardRoute, boardId, subjectId, boardTitle],
  );
  const { threadId, openingPostId } = await seedThread(database, {
    route: threadRoute,
    accountId,
    boardId,
    title: threadTitle,
    at: threadAt,
    times: postTimes,
    documents,
  });

  const searchUrl = `http://127.0.0.1:${publishedPort(searchContainer, '9200/tcp')}`;
  await waitForSearch(searchUrl, searchContainer);
  const { createOpenSearch } = await import(`${kernelBase}/src/search/opensearch.ts`);
  const { bulkLines, documentActions } = await import(`${kernelBase}/src/search/document.ts`);
  const { createSubjectIndex, subjectAlias, subjectIndexName } = await import(`${kernelBase}/src/search/indices.ts`);
  const { createSearchService } = await import(`${kernelBase}/src/search/service.ts`);
  const { subjectPartition } = await import(`${kernelBase}/src/search/source.ts`);
  const { createKernel } = await import(`${kernelBase}/src/http/kernel.ts`);
  const { subjectSource } = await import(`${kernelBase}/src/semantic/search-source.ts`);
  const opensearch = createOpenSearch(searchUrl);
  const cursors = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  // The editions list of the subject page is a search read, and the spawned kernel does not mount search. A second
  // in-process kernel over the same database answers the page read, with the editions indexed from the real source.
  await createSubjectIndex(opensearch, pagePrefix, 1);
  const pageIndex = subjectIndexName(pagePrefix, 1);
  const realSource = subjectSource(database);
  for (const id of editionIds) {
    const partition = subjectPartition(id);
    const snapshot = await realSource.read(partition, [id]);
    await opensearch.bulk(bulkLines(pageIndex, documentActions(snapshot, [id])), { query: { refresh: 'wait_for' } });
  }
  await opensearch.request('POST', '/_aliases', {
    actions: [{ add: { index: pageIndex, alias: subjectAlias(pagePrefix) } }],
  });
  const pageKernel = createKernel({
    pool: database,
    routeKey: Buffer.from(kernelRouteKey, 'base64url'),
    search: createSearchService({
      pool: database,
      client: opensearch,
      prefix: pagePrefix,
      source: realSource,
      cursors,
    }),
  });

  const recorded = new Map<string, JsonObject>();
  const save = async (name: string, path: string) => {
    const response = await retryOverloaded(() => fetch(new URL(path, origin)));
    const body = objectBody(await response.json(), `${name} ${path}`);
    recorded.set(name, { ...body, status: response.status });
    return response.status;
  };
  const expectStatus = async (name: string, path: string, status: number) => {
    const actual = await save(name, path);
    if (actual !== status) throw new Error(`${name} returned ${actual}: ${JSON.stringify(recorded.get(name))}`);
  };
  await expectStatus('subject', `/v1/subjects/${subjectId}`, 200);
  if (writes('subject-ratings', 'subject-source-statistics')) {
    const aggregatePath = `/v1/subjects/${subjectId}/ratings?question=00000000-0000-7000-8000-000000000001&population=00000000-0000-8000-8000-000000000000`;
    let aggregateRecording: JsonObject | undefined;
    let sourceRecording: unknown;
    try {
      const response = await retryOverloaded(() => fetch(new URL(aggregatePath, origin)));
      if (response.status === 200) {
        const body = objectBody(await response.json(), `subject-ratings ${aggregatePath}`);
        aggregateRecording = { ...body, status: response.status };
      }
    } catch {
      // Ratings may not be mounted in this recording stack. Only a successful kernel response becomes a fixture.
    }
    const sourcePath = `/v1/subjects/${subjectId}/source-statistics`;
    try {
      const response = await retryOverloaded(() => fetch(new URL(sourcePath, origin)));
      if (response.status === 200) {
        const body: unknown = await response.json();
        if (Array.isArray(body)) sourceRecording = body;
      }
    } catch {
      // Source statistics are optional for the same reason as the aggregate above.
    }
    if (aggregateRecording !== undefined && sourceRecording !== undefined) {
      recorded.set('subject-ratings', aggregateRecording);
      recorded.set('subject-source-statistics', sourceRecording as JsonObject);
    }
  }
  // The Realm's published subjects and the uncovered story predate this recorder. Seed their
  // existing labels, read them through the kernel, and retain their stable fixture identities.
  const readFixtureSubject = async (fixture: JsonObject): Promise<JsonObject> => {
    const old = objectBody(fixture.subject, 'fixture subject');
    const id = await create({ type: old.type, labels: old.labels }, 'fixture subject');
    const response = await retryOverloaded(() => fetch(`${origin}/v1/subjects/${id}`));
    const body = objectBody(await response.json(), 'fixture subject read');
    if (response.status !== 200)
      throw new Error(`Fixture subject read returned ${response.status}: ${JSON.stringify(body)}`);
    return JSON.parse(JSON.stringify(body).replaceAll(id, String(old.id))) as JsonObject;
  };
  const uncovered = objectBody(
    await Bun.file(join(app, 'src/kernel/recorded/subject-uncovered.json')).json(),
    'uncovered',
  );
  recorded.set('subject-uncovered', { ...(await readFixtureSubject(uncovered)), status: 200 });
  const realmFixtures = objectBody(
    objectBody(await Bun.file(join(app, 'src/kernel/recorded/realm-subjects.json')).json(), 'realm subjects').subjects,
    'realm subject entries',
  );
  const realmSubjects: JsonObject = {};
  for (const [id, fixture] of Object.entries(realmFixtures))
    realmSubjects[id] = await readFixtureSubject(objectBody(fixture, 'realm subject'));
  recorded.set('realm-subjects', { status: 200, subjects: realmSubjects });
  await expectStatus('missing-subject', '/v1/subjects/00000000-0000-4000-8000-000000000000', 404);
  const missingSubjectId = '00000000-0000-4000-8000-000000000000';
  const savePost = async (name: string, payload: unknown) => {
    const response = await retryOverloaded(() =>
      pageKernel.handle(
        new Request('http://kernel.test/v1/pages:read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      ),
    );
    const body = objectBody(await response.json(), name);
    recorded.set(name, { ...body, status: response.status });
    return response.status;
  };
  const deadline = Date.now() + 60_000;
  while (true) {
    if ((await savePost('subject-page', { target: { subject: subjectId } })) !== 200)
      throw new Error(`subject-page returned ${JSON.stringify(recorded.get('subject-page'))}`);
    const reads = Object.values(objectBody(objectBody(recorded.get('subject-page'), 'subject-page').reads, 'reads'));
    const editions = reads
      .map((read) => objectBody(objectBody(read, 'read').body, 'read body'))
      .find(
        (body) =>
          Array.isArray(body.links) &&
          body.links.some((link: unknown) => objectBody(link, 'link').property === 'schema:exampleOfWork'),
      );
    if (Array.isArray(editions?.links) && editions.links.length === editionIds.length) break;
    if (worker.exitCode !== null) throw new Error(`Kernel worker exited with ${worker.exitCode}`);
    if (Date.now() >= deadline)
      throw new Error(`The recorded page should list ${editionIds.length} editions: ${JSON.stringify(reads)}`);
    await Bun.sleep(500);
  }
  const subjectPage = objectBody(recorded.get('subject-page'), 'subject-page');
  const template = objectBody(subjectPage.template, 'subject-page template');
  if (
    subjectPage.subject !== subjectId ||
    typeof subjectPage.profile !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(subjectPage.profile) ||
    typeof template.scope !== 'string'
  )
    throw new Error(`subject-page is not a page for the recorded subject: ${JSON.stringify(subjectPage)}`);
  const subjectRecord = objectBody(objectBody(recorded.get('subject'), 'subject').subject, 'subject record');
  const described = Object.keys(objectBody(subjectRecord.descriptions, 'subject descriptions'));
  const aliased = Object.values(objectBody(subjectRecord.aliases, 'subject aliases')).flat();
  if (!['en', 'ja'].every((language) => described.includes(language)) || aliased.length < 2)
    throw new Error(
      `The recorded subject needs descriptions in en and ja and two aliases: ${JSON.stringify(subjectRecord)}`,
    );
  if ((await savePost('missing-subject-page', { target: { subject: missingSubjectId } })) !== 404)
    throw new Error(`missing-subject-page returned ${JSON.stringify(recorded.get('missing-subject-page'))}`);
  if (recorded.get('missing-subject-page')?.code !== 'not_found')
    throw new Error(`missing-subject-page is not not_found: ${JSON.stringify(recorded.get('missing-subject-page'))}`);
  await expectStatus('board', `/v1/boards/${boardId}`, 200);
  await expectStatus('board-threads', `/v1/boards/${boardId}/threads`, 200);
  await expectStatus('thread', `/v1/threads/${threadId}`, 200);
  await expectStatus('thread-posts', `/v1/threads/${threadId}/posts`, 200);

  // A thread the recording account wrote and may edit; the story visitor stands in for the recording account.
  const ownedDocuments = [
    blocks([
      { type: 'heading', attrs: { id: 'watering-plan', level: 2 }, content: [text('Watering plan')] },
      paragraph('watering-intro', [
        text('Pull the baobab seedlings '),
        text('every morning', [{ type: 'bold' }]),
        text(', before breakfast, while they are still small enough to tell from the rosebushes.'),
      ]),
    ]),
    blocks([
      paragraph('screen-question', [
        text('Does anyone know how the rose copes with wind? I still need to build a screen.'),
      ]),
    ]),
  ].map((input) => validateContentDocument(input));
  const owned = await seedThread(database, {
    route: ownedThreadRoute,
    accountId,
    boardId,
    title: ownedThreadTitle,
    at: threadAt,
    times: postTimes.slice(0, 2),
    documents: ownedDocuments,
  });
  await expectStatus('thread-owned', `/v1/threads/${owned.threadId}`, 200);
  await expectStatus('thread-owned-posts', `/v1/threads/${owned.threadId}/posts`, 200);
  const ownedPosts = recorded.get('thread-owned-posts')?.posts;
  if (!Array.isArray(ownedPosts) || ownedPosts.length !== 2)
    throw new Error(`The owned thread should hold two posts: ${JSON.stringify(ownedPosts)}`);

  if (writes('board-realm')) {
    const realmDocuments = [
      blocks([
        paragraph('edition-question', [text('I have never read it. Is there an edition you would start with?')]),
      ]),
      blocks([paragraph('edition-answer', [text('Start with the one you can find; they all have the fox.')])]),
    ].map((input) => validateContentDocument(input));
    for (const [name, body] of await recordBoardRealm({
      origin,
      pool: database,
      accountId,
      conceptId: fable,
      newId,
      documents: realmDocuments,
    }))
      recorded.set(name, body);
  }

  const threadPage = recorded.get('board-threads');
  const postPage = recorded.get('thread-posts');
  const threads = threadPage?.threads;
  const pagePosts = postPage?.posts;
  if (!Array.isArray(threads) || threads.length !== 1 || threadPage?.next !== null)
    throw new Error(`Board thread page should contain one thread and no cursor: ${JSON.stringify(threadPage)}`);
  if (!Array.isArray(pagePosts) || pagePosts.length !== 3 || postPage?.next !== null)
    throw new Error(`Thread post page should contain three posts and no cursor: ${JSON.stringify(postPage)}`);
  const serializedPosts = JSON.stringify(pagePosts);
  for (const snippet of [
    'Flight notes',
    'Watch the baobabs',
    'The asteroid',
    'https://example.com/b612',
    'spoiler',
    'The rose was unique',
  ])
    if (!serializedPosts.includes(snippet)) throw new Error(`Post page is missing ${snippet}.`);
  const reply = pagePosts.find((post) => objectBody(post, 'post').parentId === openingPostId);
  if (!reply) throw new Error('The third post should reply to the opening post.');

  const subject = objectBody(objectBody(recorded.get('subject'), 'subject').subject, 'subject record');
  await expectStatus('definitions-active', '/v1/definitions/active', 200);
  const digest = objectBody(recorded.get('definitions-active'), 'definitions-active').digest;
  if (typeof digest !== 'string') throw new Error('The active definitions release has no digest.');
  await expectStatus('definitions-release', `/v1/definitions/releases/${encodeURIComponent(digest)}`, 200);
  const definitions = objectBody(recorded.get('definitions-release'), 'definitions-release');
  if (definitions.digest !== digest)
    throw new Error(`The release read names ${String(definitions.digest)}, not the active ${digest}.`);
  const release = objectBody(definitions.release, 'definitions release') as unknown as ReleaseDefinitions;
  const subjectType = subject.type;
  if (typeof subjectType !== 'string') throw new Error('The recorded subject has no type.');
  // What the search page asks for on a search filtered to one type: the first two facets it can show.
  const properties = facetProperties(release, [subjectType])
    .filter((property) => {
      const definition = release.properties[property];
      if (!definition) return false;
      return (
        ['wikibase-item', 'time', 'quantity'].includes(definition.datatype) ||
        (definition.datatype === 'string' && !!definition.value?.pattern)
      );
    })
    .slice(0, 2);
  if (properties.length === 0) throw new Error(`The release has no facet to show for ${subjectType}.`);
  const missing = properties.filter((property) => !(property in objectBody(subject.statements, 'subject statements')));
  if (missing.length > 0) throw new Error(`The recorded subject has no statement of ${missing.join(', ')}.`);
  const subjectLabels = objectBody(subject.labels, 'subject labels');
  const indexedSubject = (id: string, type: unknown, labels: Record<string, unknown>) => ({
    id,
    type: String(type),
    visibility: 'visible' as const,
    redirect: null,
    securityRevision: 1,
    labels: Object.entries(labels).flatMap(([language, value]) =>
      typeof value === 'string' ? [{ language, value }] : [],
    ),
    aliases: [],
    descriptions: [],
    statements: [{ property: 'schema:inLanguage', value: 'ja' }],
  });
  // The recorded subject is indexed and answered from the real source, with its descriptions and statements. The home
  // subjects exist only here, with labels alone.
  const homeIndexed = subjectSeeds.map(({ id, type, labels }) => indexedSubject(id, type, labels));
  const source = {
    async read(partition: number, ids: readonly string[]) {
      const real = await realSource.read(partition, ids);
      return {
        ...real,
        subjects: [
          ...real.subjects,
          ...homeIndexed.filter((hit) => ids.includes(hit.id) && subjectPartition(hit.id) === partition),
        ],
      };
    },
    async count(partition: number) {
      const real = await realSource.count(partition);
      const count = real.count + homeIndexed.filter((hit) => subjectPartition(hit.id) === partition).length;
      return count ? { position: real.position > 0n ? real.position : 1n, count } : { position: 0n, count: 0 };
    },
  };
  await createSubjectIndex(opensearch, searchPrefix, 1);
  const index = subjectIndexName(searchPrefix, 1);
  for (const id of [subjectId, ...homeIndexed.map((hit) => hit.id)]) {
    const snapshot = await source.read(subjectPartition(id), [id]);
    await opensearch.bulk(bulkLines(index, documentActions(snapshot, [id])), { query: { refresh: 'wait_for' } });
  }
  await opensearch.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(searchPrefix) } }] });
  const search = createSearchService({
    pool: database,
    client: opensearch,
    prefix: searchPrefix,
    source,
    cursors,
  });
  // The spawned kernel server does not mount search, so these reads use the same database through an in-process kernel.
  const appHandle = createKernel({
    pool: database,
    routeKey: Buffer.from(kernelRouteKey, 'base64url'),
    search,
  });
  const facetsResponse = await retryOverloaded(() =>
    appHandle.handle(
      new Request('http://kernel.test/v1/subjects:facets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: matchingQuery, facets: [{ property: 'type', size: 20 }] }),
      }),
    ),
  );
  const facets = objectBody(await facetsResponse.json(), 'search-facets');
  if (facetsResponse.status !== 200)
    throw new Error(`search-facets returned ${facetsResponse.status}: ${JSON.stringify(facets)}`);
  recorded.set('search-facets', { ...facets, status: facetsResponse.status, query: matchingQuery });
  // Keep full label maps in recordings; replay projects them to the language list requested by each story.
  const searchFor = async (name: string, text: string, extra: JsonObject = {}, request: JsonObject = {}) => {
    let english: JsonObject | undefined;
    for (const locale of ['en', 'zh-Hans']) {
      const response = await retryOverloaded(async () =>
        appHandle.handle(
          new Request('http://kernel.test/v1/subjects:search', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'accept-language': locale },
            body: JSON.stringify({ text, limit: 100, descriptions: true, ...extra }),
          }),
        ),
      );
      const body = objectBody(await response.json(), name);
      if (response.status !== 200) throw new Error(`${name} returned ${response.status}: ${JSON.stringify(body)}`);
      recorded.set(`${name}-${locale}`, { ...body, status: response.status, query: text, ...request });
      if (locale === 'en') english = body;
    }
    if (name !== 'search-empty' && english) recorded.set(name, { ...english, query: text, ...request });
    return english!;
  };
  const matched = await searchFor('search', matchingQuery);
  const unmatched = await searchFor('search-empty', emptyQuery);
  const typed = await searchFor(
    'search-typed',
    typedQuery,
    { filter: { and: [{ type: { in: [subjectType] } }] }, properties },
    { filterType: subjectType },
  );
  const hits = matched.subjects;
  if (!Array.isArray(hits) || !hits.some((hit) => objectBody(hit, 'search hit').id === subjectId))
    throw new Error(`Search for ${matchingQuery} did not return the recorded subject: ${JSON.stringify(matched)}`);
  const typedHit = Array.isArray(typed.subjects)
    ? typed.subjects.map((hit) => objectBody(hit, 'typed search hit')).find((hit) => hit.id === subjectId)
    : undefined;
  if (!typedHit || Object.keys(objectBody(typedHit.facts, 'typed search facts')).length === 0)
    throw new Error(
      `The typed search for ${typedQuery} did not return facts for the recorded subject: ${JSON.stringify(typed)}`,
    );
  if (
    !hits.some(
      (hit) =>
        objectBody(hit, 'search hit').id === subjectId &&
        Object.keys(objectBody(objectBody(hit, 'search hit').descriptions, 'search descriptions')).length > 0,
    )
  )
    throw new Error(`The search hit has no descriptions: ${JSON.stringify(matched)}`);
  if (!Array.isArray(unmatched.subjects) || unmatched.subjects.length !== 0)
    throw new Error(`Empty search returned hits: ${JSON.stringify(unmatched)}`);

  // The home lists are searches, so the home is read through the kernel that mounts search over the index above.
  for (const locale of ['en', 'zh-Hans']) {
    const homeResponse = await retryOverloaded(async () =>
      appHandle.handle(
        new Request('http://kernel.test/v1/pages:read', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept-language': locale },
          body: JSON.stringify({ target: { route: '/' } }),
        }),
      ),
    );
    const name = locale === 'en' ? 'home-page' : `home-page-${locale}`;
    recorded.set(name, {
      ...objectBody(await homeResponse.json(), 'home-page'),
      status: homeResponse.status,
    });
    if (homeResponse.status !== 200) throw new Error(`home-page returned ${JSON.stringify(recorded.get(name))}`);
  }
  const homePage = objectBody(recorded.get('home-page'), 'home-page');
  const homeTemplate = objectBody(homePage.template, 'home-page template');
  if (
    typeof homePage.profile !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(homePage.profile) ||
    homeTemplate.scope !== 'route' ||
    homeTemplate.key !== '/'
  )
    throw new Error(`home-page is not a page for the home route: ${JSON.stringify(homePage)}`);
  const homeReads = Object.values(objectBody(homePage.reads, 'home-page reads')).map((read) =>
    objectBody(read, 'home-page read'),
  );
  for (const read of homeReads) {
    const listed = objectBody(read.body, 'home-page read body').subjects;
    if (read.status !== 200 || !Array.isArray(listed) || listed.length < 2)
      throw new Error(`Every home list needs status 200 and two subjects: ${JSON.stringify(homePage.reads)}`);
  }

  for (const [name, body] of await recordLibrary({ origin, pool: database, accountId, subjectId }))
    recorded.set(name, body);
  await expectStatus('accounts', `/v1/accounts?ids=${accountId}`, 200);
  if (writes('offer', 'order-'))
    for (const [name, body] of await recordCommerce({ pool: database, accountId, subjectId })) recorded.set(name, body);

  // The library recording opened the collections gate and put the subject on a shelf; the shelf's listing catches up
  // in the background, so the page is read again until it names a collection.
  const finalDeadline = Date.now() + 60_000;
  for (const locale of ['en', 'zh-Hans']) {
    for (;;) {
      const finalPage = await retryOverloaded(() =>
        fetch(new URL('/v1/pages:read', origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept-language': locale },
          body: JSON.stringify({ target: { subject: subjectId } }),
        }),
      );
      const finalBody = objectBody(await finalPage.json(), 'subject-page');
      const finalReads = Object.values(objectBody(finalBody.reads ?? {}, 'subject-page reads')).map((read) =>
        objectBody(read, 'subject-page read'),
      );
      const collected = finalReads.some((read) => {
        const collections = objectBody(read.body, 'subject-page read body').collections;
        return Array.isArray(collections) && collections.length > 0;
      });
      if (finalPage.status === 200 && collected && finalReads.every((read) => read.status === 200)) {
        recorded.set(locale === 'en' ? 'subject-page' : `subject-page-${locale}`, {
          ...finalBody,
          status: finalPage.status,
        });
        break;
      }
      if (Date.now() > finalDeadline)
        throw new Error(`subject-page has failed or empty reads: ${JSON.stringify(finalBody)}`);
      await Bun.sleep(1000);
    }
  }

  const output = process.env.WEB_RECORD_OUTPUT ?? join(app, 'src/kernel/recorded');
  await mkdir(output, { recursive: true });
  const optionalRecordings = new Set(['subject-ratings', 'subject-source-statistics']);
  const unknown = only.filter((name) => !recorded.has(name) && !optionalRecordings.has(name));
  if (unknown.length)
    throw new Error(`Unknown recordings: ${unknown.join(', ')}. Recorded: ${[...recorded.keys()].join(', ')}`);
  const written: string[] = [];
  for (const [name, body] of recorded) {
    if (only.length && !only.includes(name)) continue;
    const file = join(output, `${name}.json`);
    written.push(file);
    // Definitions are generated snapshots; retaining old strings would preserve stale digests and ratios.
    const generated = name === 'definitions-active' || name === 'definitions-release';
    const previous = !generated && (await Bun.file(file).exists()) ? await Bun.file(file).json() : undefined;
    await writeFile(file, JSON.stringify(applyStorySubjectCovers(stableRecording(body, previous))));
  }
  // The repository formatter owns the committed shape. A raw stringify fails apps/web's format test.
  if (written.length) {
    const formatted = Bun.spawnSync([join(root, 'node_modules/.bin/oxfmt'), '--write', ...written], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (formatted.exitCode !== 0)
      throw new Error(
        `Formatting the recordings failed: ${formatted.stderr.toString() || formatted.stdout.toString()}`,
      );
  }
}

async function executeRecord(): Promise<number> {
  try {
    await main();
    return 0;
  } finally {
    await stopKernel();
    await pool?.end();
    jwks?.stop(true);
    const failures: unknown[] = [];
    for (const id of [searchContainer, container]) {
      if (!id) continue;
      try {
        docker(['rm', '-f', '-v', id]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
}

/** Hands the recording to a check host and copies the recorded pages back, including when the recording fails. */
export async function runRecord(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const names = argv.filter((argument) => argument !== '--');
  return stackRun(
    {
      label: 'web record',
      root,
      cwd: app,
      command: ['bun', 'scripts/record.ts', ...names],
      returns: ['apps/web/src/kernel/recorded'],
    },
    () => executeRecord(),
  );
}

if (import.meta.main) {
  runRecord().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
