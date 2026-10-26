import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';

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
const threadAt = '2026-10-24T00:00:00.000Z';
const postTimes = ['2026-10-24T00:00:00.000Z', '2026-10-24T00:01:00.000Z', '2026-10-24T00:02:00.000Z'] as const;
const boardTitle = 'Stories of the little prince';
const threadTitle = 'Letters from B-612';
const searchPrefix = 'webrec';
const matchingQuery = 'Prince';
const emptyQuery = 'zzzznotasubject';
let container = '';
let searchContainer = '';
let kernel: ReturnType<typeof spawn> | undefined;
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
  if (!kernel?.pid) return;
  kernel.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => kernel!.once('exit', () => resolve())), Bun.sleep(10_000)]);
  if (kernel.exitCode === null) kernel.kill('SIGKILL');
  kernel = undefined;
}

type JsonObject = Record<string, unknown>;

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
  kernel = spawn('bun', [id], {
    cwd: resolve(root, 'services/kernel'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_HOSTNAME: '127.0.0.1',
      KERNEL_PORT: String(kernelPort),
      KERNEL_ROUTE_KEY: kernelRouteKey,
      KERNEL_SESSION_KEYS: `1:${sessionKey}`,
      KERNEL_WRITE_RATE_SECRET: randomBytes(32).toString('base64url'),
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `${issuer}/jwks`,
      STRIPE_SECRET_KEY: 'sk_test_recorder',
      STRIPE_WEBHOOK_SECRETS: 'whsec_recorder',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://example.test/success/{ORDER_ID}',
      CHECKOUT_CANCEL_URL: 'https://example.test/cancel/{ORDER_ID}',
      NODE_ENV: 'development',
    },
  });
  await waitForKernel(origin, kernel);
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
  const labels = {
    en: 'The Little Prince',
    'zh-Hant': '小王子',
    'zh-Hans': '小王子',
    ja: '星の王子さま',
    ko: '어린 왕자',
    de: 'Der kleine Prinz',
    fr: 'Le Petit Prince',
    es: 'El Principito',
  };
  const created = await fetch(`${origin}/v1/subjects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
    },
    body: JSON.stringify({ type: 'schema:Book', labels }),
  });
  const creation = (await created.json()) as { subject?: { id?: string } };
  const subjectId = creation.subject?.id;
  if (created.status !== 201 || !subjectId)
    throw new Error(`Creating the recording subject returned ${created.status}: ${JSON.stringify(creation)}`);
  if (!pool) throw new Error('Database pool is not open.');
  const database = pool;
  const { newId, partitionOf } = await import(`${kernelBase}/src/route/route.ts`);
  const { runCommand } = await import(`${kernelBase}/src/command/command.ts`);
  const { applyBoardCandidate } = await import(`${kernelBase}/src/content/board-projection.ts`);
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
  const threadId = newId(threadRoute);
  const posts = postTimes.map(() => ({ post: newId(threadRoute), revision: newId(threadRoute) }));
  const opening = posts[0];
  if (!opening) throw new Error('The recording thread needs an opening post.');
  await runCommand(
    database,
    { partition: partitionOf(threadRoute) },
    async (tx: { query: (sql: string, values: readonly unknown[]) => Promise<unknown> }) => {
      await tx.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$2,$6,$7)`,
        [threadRoute, threadId, accountId, boardId, threadTitle, opening.post, threadAt],
      );
      for (const [index, post] of posts.entries()) {
        const document = documents[index];
        const at = postTimes[index];
        if (!document || !at) throw new Error(`Recording post ${index} is missing its document.`);
        await tx.query(
          `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'published',1,$3,$7)`,
          [
            threadRoute,
            threadId,
            post.post,
            index === posts.length - 1 ? opening.post : null,
            accountId,
            post.revision,
            at,
          ],
        );
        await tx.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}'::uuid[],$7,'available',$4)`,
          [
            threadRoute,
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
            data: { threadId, itemId: opening.post, revisionId: opening.revision, actorId: accountId },
          },
        ],
      };
    },
  );
  await applyBoardCandidate(database, { id: threadId, boardId, createdAt: threadAt, epoch: 1, position: 1n });

  const recorded = new Map<string, JsonObject>();
  const save = async (name: string, path: string) => {
    const response = await fetch(new URL(path, origin));
    const body = objectBody(await response.json(), `${name} ${path}`);
    recorded.set(name, { ...body, status: response.status });
    return response.status;
  };
  const expectStatus = async (name: string, path: string, status: number) => {
    const actual = await save(name, path);
    if (actual !== status) throw new Error(`${name} returned ${actual}: ${JSON.stringify(recorded.get(name))}`);
  };
  await expectStatus('subject', `/v1/subjects/${subjectId}`, 200);
  await expectStatus('missing-subject', '/v1/subjects/00000000-0000-4000-8000-000000000000', 404);
  const missingSubjectId = '00000000-0000-4000-8000-000000000000';
  const savePost = async (name: string, payload: unknown) => {
    const response = await fetch(new URL('/v1/pages:read', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = objectBody(await response.json(), name);
    recorded.set(name, { ...body, status: response.status });
    return response.status;
  };
  if ((await savePost('subject-page', { target: { subject: subjectId } })) !== 200)
    throw new Error(`subject-page returned ${JSON.stringify(recorded.get('subject-page'))}`);
  if ((await savePost('home-page', { target: { route: '/' } })) !== 200)
    throw new Error(`home-page returned ${JSON.stringify(recorded.get('home-page'))}`);
  const homePage = objectBody(recorded.get('home-page'), 'home-page');
  const homeTemplate = objectBody(homePage.template, 'home-page template');
  if (
    typeof homePage.profile !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(homePage.profile) ||
    homeTemplate.scope !== 'route' ||
    homeTemplate.key !== '/'
  )
    throw new Error(`home-page is not a page for the home route: ${JSON.stringify(homePage)}`);
  const subjectPage = objectBody(recorded.get('subject-page'), 'subject-page');
  const template = objectBody(subjectPage.template, 'subject-page template');
  if (
    subjectPage.subject !== subjectId ||
    typeof subjectPage.profile !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(subjectPage.profile) ||
    typeof template.scope !== 'string'
  )
    throw new Error(`subject-page is not a page for the recorded subject: ${JSON.stringify(subjectPage)}`);
  if ((await savePost('missing-subject-page', { target: { subject: missingSubjectId } })) !== 404)
    throw new Error(`missing-subject-page returned ${JSON.stringify(recorded.get('missing-subject-page'))}`);
  if (recorded.get('missing-subject-page')?.code !== 'not_found')
    throw new Error(`missing-subject-page is not not_found: ${JSON.stringify(recorded.get('missing-subject-page'))}`);
  await expectStatus('board', `/v1/boards/${boardId}`, 200);
  await expectStatus('board-threads', `/v1/boards/${boardId}/threads`, 200);
  await expectStatus('thread', `/v1/threads/${threadId}`, 200);
  await expectStatus('thread-posts', `/v1/threads/${threadId}/posts`, 200);

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
  const reply = pagePosts.find((post) => objectBody(post, 'post').parentId === opening.post);
  if (!reply) throw new Error('The third post should reply to the opening post.');

  const searchUrl = `http://127.0.0.1:${publishedPort(searchContainer, '9200/tcp')}`;
  await waitForSearch(searchUrl, searchContainer);
  const { createOpenSearch } = await import(`${kernelBase}/src/search/opensearch.ts`);
  const { bulkLines, documentActions } = await import(`${kernelBase}/src/search/document.ts`);
  const { createSubjectIndex, subjectAlias, subjectIndexName } = await import(`${kernelBase}/src/search/indices.ts`);
  const { createSearchService } = await import(`${kernelBase}/src/search/service.ts`);
  const { subjectPartition } = await import(`${kernelBase}/src/search/source.ts`);
  const { createKernel } = await import(`${kernelBase}/src/http/kernel.ts`);
  const subject = objectBody(objectBody(recorded.get('subject'), 'subject').subject, 'subject record');
  const subjectLabels = objectBody(subject.labels, 'subject labels');
  const indexed = {
    id: subjectId,
    type: subject.type,
    visibility: 'visible' as const,
    redirect: null,
    securityRevision: 1,
    labels: Object.entries(subjectLabels).flatMap(([language, value]) =>
      typeof value === 'string' ? [{ language, value }] : [],
    ),
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const source = {
    async read(partition: number, ids: readonly string[]) {
      return {
        partition,
        position: 1n,
        subjects: ids.includes(subjectId) && subjectPartition(subjectId) === partition ? [indexed] : [],
      };
    },
    async count(partition: number) {
      return subjectPartition(subjectId) === partition ? { position: 1n, count: 1 } : { position: 0n, count: 0 };
    },
  };
  const opensearch = createOpenSearch(searchUrl);
  await createSubjectIndex(opensearch, searchPrefix, 1);
  const index = subjectIndexName(searchPrefix, 1);
  const partition = subjectPartition(subjectId);
  const snapshot = await source.read(partition, [subjectId]);
  await opensearch.bulk(bulkLines(index, documentActions(snapshot, [subjectId])), { query: { refresh: 'wait_for' } });
  await opensearch.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(searchPrefix) } }] });
  const cursors = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const search = createSearchService({ pool: database, client: opensearch, prefix: searchPrefix, source, cursors });
  // The spawned kernel server does not mount search, so these reads use the same database through an in-process kernel.
  await search.search('anonymous', { text: matchingQuery, limit: 100 });
  await search.search('anonymous', { text: emptyQuery, limit: 100 });
  const appHandle = createKernel({
    pool: database,
    routeKey: Buffer.from(kernelRouteKey, 'base64url'),
    search,
  });
  const searchFor = async (name: string, text: string) => {
    const response = await appHandle.handle(
      new Request('http://kernel.test/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, limit: 100 }),
      }),
    );
    const body = objectBody(await response.json(), name);
    if (response.status !== 200) throw new Error(`${name} returned ${response.status}: ${JSON.stringify(body)}`);
    recorded.set(name, { ...body, status: response.status, query: text });
    return body;
  };
  const matched = await searchFor('search', matchingQuery);
  const unmatched = await searchFor('search-empty', emptyQuery);
  const hits = matched.subjects;
  if (!Array.isArray(hits) || !hits.some((hit) => objectBody(hit, 'search hit').id === subjectId))
    throw new Error(`Search for ${matchingQuery} did not return the recorded subject: ${JSON.stringify(matched)}`);
  if (!Array.isArray(unmatched.subjects) || unmatched.subjects.length !== 0)
    throw new Error(`Empty search returned hits: ${JSON.stringify(unmatched)}`);

  const output = join(app, 'src/kernel/recorded');
  await mkdir(output, { recursive: true });
  for (const [name, body] of recorded) await writeFile(join(output, `${name}.json`), JSON.stringify(body));
  // The repository formatter owns the committed shape. A raw stringify fails apps/web's format test.
  const formatted = Bun.spawnSync([join(root, 'node_modules/.bin/oxfmt'), '--write', output], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (formatted.exitCode !== 0)
    throw new Error(`Formatting the recordings failed: ${formatted.stderr.toString() || formatted.stdout.toString()}`);
}

try {
  await main();
} finally {
  await stopKernel();
  await pool?.end();
  jwks?.stop(true);
  const failures: unknown[] = [];
  for (const id of [searchContainer, container]) {
    if (!id) continue;
    try {
      docker(['rm', '-f', id]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
