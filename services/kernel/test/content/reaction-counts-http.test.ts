import { fromPlainText } from '@rezics/document';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workerTestEnv } from '../support/worker-env.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

if (process.argv.includes('--reaction-count-worker')) {
  const { readWorkerConfig, startWorker } = await import('../../src/worker.ts');
  await startWorker(readWorkerConfig(process.env));
  console.log('reaction-count-worker-ready');
} else {
  const { afterAll, beforeAll, expect, test } = await import('bun:test');
  const { createAuthHost } = await import('@rezics/auth');
  const { exportJWK, generateKeyPair } = await import('jose');
  const { Pool } = await import('pg');
  const { migrate: migrateAuth } = await import('../../../auth/scripts/database.ts');
  const { createAuthBindings } = await import('../../src/access/auth-bindings.ts');
  const { createAccess } = await import('../../src/access/index.ts');
  const { createRegistrationPorts } = await import('../support/registration-ports.ts');
  const { createRegistrationProofBindings } = await import('../../src/access/registration-proof.ts');
  const { createWriteRateLimiter } = await import('../../src/access/write-rate.ts');
  const { createKernel } = await import('../../src/http/kernel.ts');
  const { actionCatalogue, IDEMPOTENCY_HEADER } = await import('../../src/http/request.ts');
  const { newId, partitionOf, routeOf } = await import('../../src/route/route.ts');
  const { checkGrowth, openGrowthDatabase, seed } = await import('../support/growth.ts');
  const { observeSql } = await import('./support/sql-observer.ts');
  const { dropTestDatabase } = await import('../support/drop-test-database.ts');

  const issuer = 'https://reaction-counts-http.auth.test';
  const audience = 'https://reaction-counts-http.api.test';
  const password = 'reaction counts http registration password with enough entropy';
  const routeKey = new Uint8Array(32).fill(94);
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(95)]]) };
  const contentRoute = 0x4341;
  const boardRoute = 0x5341;
  const kinds = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;

  type Person = { accountId: string; bearer: string };
  type ThreadFixture = { thread: string; posts: string[] };
  type Call = { bearer?: string; body?: unknown; key?: string };
  type StoredRow = { kind: string; count: number; epoch: number; position: string };
  type Counts = Record<string, number>;
  type Freshness = { epoch: number; position: string } | null;
  type CountedThread = { thread: { reactions: Counts; authorId: string }; reactionsAsOf: Freshness };
  type CountedPage = { posts: { id: string; reactions: Counts }[]; reactionsAsOf: Freshness };

  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let authPool: InstanceType<typeof Pool>;
  let authDatabaseName = '';
  let host: Awaited<ReturnType<typeof createAuthHost>>;
  let service: Awaited<ReturnType<typeof createAuthHost>>['service'];
  let kernel: ReturnType<typeof createKernel>;
  let author: Person;
  let member: Person;
  let other: Person;
  const workers: Array<{ kill: () => void; stop: () => Promise<void> }> = [];

  async function issue(email: string, scope: string[]) {
    const signed = await service.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, client_id: 'reaction-counts-http-client', scope }),
      }),
    );
    expect(signed.status).toBe(200);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const response = await service.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: '{}',
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { access_token: string }).access_token;
  }

  async function person(name: string, scope: string[]): Promise<Person> {
    const result = await host.workflows.register({
      key: name,
      handle: name,
      email: `${name}@reaction-counts-http.test`,
      password,
    });
    return { accountId: result.accountId, bearer: await issue(`${name}@reaction-counts-http.test`, scope) };
  }

  async function call(method: string, path: string, options: Call = {}) {
    const headers = new Headers();
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    return { response, text, value: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function insertThread(visibility: 'published' | 'draft', count: number, title: string): Promise<ThreadFixture> {
    const board = newId(boardRoute);
    const thread = newId(contentRoute);
    const posts: string[] = [];
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,'published',1,$2)`,
        [boardRoute, board, author.accountId, title],
      );
      const first = newId(contentRoute);
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$2,$7)`,
        [contentRoute, thread, author.accountId, board, title, visibility, first],
      );
      for (let index = 0; index < count; index++) {
        const post = index === 0 ? first : newId(contentRoute);
        const revision = newId(contentRoute);
        const text = `${title} ${index}`;
        const body = Buffer.from(JSON.stringify(fromPlainText(text)));
        const at = new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString();
        await client.query(
          `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
           VALUES ($1,$2,$3,$4,$5,'published',1,$3,$6)`,
          [contentRoute, thread, post, author.accountId, revision, at],
        );
        await client.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
           VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}',$7,'available',$4)`,
          [contentRoute, thread, post, revision, body, text, board],
        );
        posts.push(post);
      }
      if (visibility === 'published') {
        for (const subjectId of [member.accountId, other.accountId]) {
          for (const resourceId of [thread, ...posts]) {
            await client.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
               VALUES ($1,$2,$3,'reaction:set','(,)',$4)`,
              [routeOf(resourceId), resourceId, subjectId, newId(routeOf(resourceId)!)],
            );
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { thread, posts };
  }

  async function stored(targetId: string): Promise<StoredRow[]> {
    const result = await db.admin.query<{ kind: string; count: number; source_epoch: number; source_position: string }>(
      `SELECT kind, count, source_epoch, source_position::text AS source_position
       FROM content.reaction_total WHERE target_id = $1::uuid`,
      [targetId],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      count: row.count,
      epoch: row.source_epoch,
      position: BigInt(row.source_position).toString(),
    }));
  }

  function totals(rows: readonly StoredRow[]): Counts {
    const sums = new Map<string, number>();
    for (const row of rows) sums.set(row.kind, (sums.get(row.kind) ?? 0) + row.count);
    const value: Counts = {};
    for (const kind of kinds) {
      const count = sums.get(kind) ?? 0;
      if (count > 0) value[kind] = count;
    }
    return value;
  }

  function oldest(rows: readonly StoredRow[]): Freshness {
    let best: { epoch: number; position: string } | null = null;
    for (const row of rows) {
      if (
        best === null ||
        row.epoch < best.epoch ||
        (row.epoch === best.epoch && BigInt(row.position) < BigInt(best.position))
      ) {
        best = { epoch: row.epoch, position: row.position };
      }
    }
    return best;
  }

  async function untilCounts(targetId: string, expected: Counts): Promise<StoredRow[]> {
    const deadline = Date.now() + 20_000;
    let rows: StoredRow[] = [];
    while (Date.now() < deadline) {
      rows = await stored(targetId);
      if (JSON.stringify(totals(rows)) === JSON.stringify(expected)) return rows;
      await Bun.sleep(50);
    }
    throw new Error(
      `Timed out waiting for ${targetId} counts ${JSON.stringify(expected)}, saw ${JSON.stringify(totals(rows))}`,
    );
  }

  async function react(actor: Person, path: string, kind: string) {
    const response = await call('PUT', path, { bearer: actor.bearer, key: crypto.randomUUID(), body: { kind } });
    expect(response.response.status).toBe(200);
    expect(response.value).toEqual({ kind });
  }

  function parameterIds(value: unknown): Set<string> | null {
    const items = Array.isArray(value)
      ? value
      : typeof value === 'string' && value.startsWith('{')
        ? value
            .slice(1, -1)
            .split(',')
            .filter((item) => item.length > 0)
        : null;
    if (!items || items.some((item) => typeof item !== 'string' || !/^[0-9a-f-]{36}$/i.test(item))) return null;
    return new Set(items);
  }

  function spawnWorker() {
    const workerRouteKey = Buffer.alloc(32, 8).toString('base64url');
    const sessionKey = Buffer.alloc(32, 9).toString('base64url');
    const env = workerTestEnv({
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_EXECUTOR_ID: `reaction-counts-${process.pid}`,
      KERNEL_WORKER_POOL_SIZE: '10',
      KERNEL_ROUTE_KEY: workerRouteKey,
      KERNEL_SESSION_KEYS: `1:${sessionKey}`,
      AUTH_ISSUER: 'https://reaction-counts-worker.auth.test',
      AUTH_AUDIENCE: 'https://api.rezics.test',
      AUTH_JWKS_URL: 'https://reaction-counts-worker.auth.test/.well-known/jwks.json',
      CONTENT_R2_ENDPOINT: `https://${'ab'.repeat(16)}.r2.cloudflarestorage.com`,
      CONTENT_R2_BUCKET: 'content-media',
      CONTENT_R2_ACCESS_KEY_ID: 'fixture-access',
      CONTENT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
      CONTENT_SOURCE_HOSTS: 'images.example.org',
      KERNEL_AUTH_CONSENT_URL: 'https://consent.example.test/internal/v1/consents:read',
      CF_ACCESS_CLIENT_ID: 'fixture.access',
      CF_ACCESS_CLIENT_SECRET: 'fixture-secret-token',
    });
    for (const name of [
      'OPENSEARCH_URL',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRETS',
      'STRIPE_MANAGED_PAYMENTS',
      'STRIPE_API_HOST',
      'CHECKOUT_SUCCESS_URL',
      'CHECKOUT_CANCEL_URL',
      'KERNEL_WRITE_RATE_EXPIRY_PARTITION',
      'KERNEL_WRITE_RATE_EXPIRY_NODE',
    ])
      delete env[name];
    const child = Bun.spawn([process.execPath, import.meta.path, '--reaction-count-worker'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    let output = '';
    let errors = '';
    const readOut = (async () => {
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
    })();
    const readErr = (async () => {
      for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
    })();
    const handle = {
      kill() {
        child.kill('SIGKILL');
      },
      async stop() {
        child.kill('SIGTERM');
        const deadline = Date.now() + 15_000;
        while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await Promise.all([readOut, readErr]);
      },
      output: () => output,
      errors: () => errors,
    };
    workers.push(handle);
    return { child, handle, readOut, readErr };
  }

  async function startCountWorker() {
    const running = spawnWorker();
    try {
      const deadline = Date.now() + 20_000;
      while (!running.handle.output().includes('reaction-count-worker-ready')) {
        if (running.child.exitCode !== null) {
          await Promise.all([running.readOut, running.readErr]);
          throw new Error(`Worker exited early\n${running.handle.output()}\n${running.handle.errors()}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for kernel worker\n${running.handle.output()}\n${running.handle.errors()}`,
          );
        }
        await Bun.sleep(20);
      }
    } catch (error) {
      running.handle.kill();
      await running.child.exited;
      throw error;
    }
  }

  beforeAll(async () => {
    db = await openGrowthDatabase();
    db.pool.options.max = 4;
    authDatabaseName = `reaction_counts_http_auth_${process.pid}`;
    await db.admin.query(`CREATE DATABASE ${authDatabaseName}`);
    const authUrl = new URL(db.url);
    authUrl.pathname = `/${authDatabaseName}`;
    migrateAuth(authUrl.href);
    authPool = new Pool({ connectionString: authUrl.href });
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'reaction-counts-http',
    };
    kernel = createKernel({
      pool: db.pool,
      routeKey,
      tokens,
      access: (config) =>
        createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
          },
        }),
      writeRate: createWriteRateLimiter({ secret: 'reaction-counts-http-write-rate-secret-32b' }),
    });
    const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
    const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
    const { ports: registrationPorts } = createRegistrationPorts({
      pool: db.pool,
      authPool,
      routeKey,
      referenceKeys: tokens,
    });
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: 'reaction-counts-http-auth-persistent-secret',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: createAuthBindings({
        pool: db.pool,
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      access: registrationPorts,
      stagingKey: new Uint8Array(32).fill(96),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: 'reaction-counts-http-executor',
    });
    service = host.service;
    await service.internal.registerClient({ clientId: 'reaction-counts-http-client', firstParty: true, scopes });
    await host.start();
    author = await person('reaction_counts_author', scopes);
    member = await person('reaction_counts_member', scopes);
    other = await person('reaction_counts_other', scopes);
    await startCountWorker();
  }, 60_000);

  afterAll(async () => {
    const running = workers.splice(0);
    for (const worker of running) await worker.stop();
    await host?.stop();
    if (authPool && !authPool.ending) await authPool.end();
    if (authDatabaseName) await dropTestDatabase(db!.admin, authDatabaseName);
    await db?.close();
  });

  test.serial(
    'the thread view and each post page item carry per-kind reaction counts and their freshness once the worker relay has run',
    async () => {
      const fixture = await insertThread('published', 4, 'Counted thread');
      const threadPath = `/v1/threads/${fixture.thread}/reaction`;
      await react(member, threadPath, 'like');
      await react(other, threadPath, 'love');
      await react(member, `/v1/posts/${fixture.posts[0]}/reaction`, 'upvote');
      await react(other, `/v1/posts/${fixture.posts[0]}/reaction`, 'upvote');
      await react(member, `/v1/posts/${fixture.posts[2]}/reaction`, 'laugh');
      const threadRows = await untilCounts(fixture.thread, { like: 1, love: 1 });
      await untilCounts(fixture.posts[0]!, { upvote: 2 });
      await untilCounts(fixture.posts[2]!, { laugh: 1 });

      const memberThread = await call('GET', `/v1/threads/${fixture.thread}`, { bearer: member.bearer });
      expect(memberThread.response.status).toBe(200);
      const memberThreadBody = memberThread.value as CountedThread;
      expect(memberThreadBody.thread.reactions).toEqual({ like: 1, love: 1 });
      expect(Object.keys(memberThreadBody.thread.reactions)).toEqual(['like', 'love']);
      expect(memberThreadBody.reactionsAsOf).toEqual(oldest(threadRows));
      expect(memberThreadBody.reactionsAsOf?.position).toMatch(/^[1-9][0-9]*$/);

      const memberPage = await call('GET', `/v1/threads/${fixture.thread}/posts?limit=100`, { bearer: member.bearer });
      expect(memberPage.response.status).toBe(200);
      const memberPosts = memberPage.value as CountedPage;
      expect(memberPosts.posts).toHaveLength(fixture.posts.length);
      const memberById = new Map(memberPosts.posts.map((post) => [post.id, post.reactions]));
      expect(memberById.get(fixture.posts[0]!)).toEqual({ upvote: 2 });
      expect(Object.keys(memberById.get(fixture.posts[0]!)!)).toEqual(['upvote']);
      expect(memberById.get(fixture.posts[1]!)).toEqual({});
      expect(memberById.get(fixture.posts[2]!)).toEqual({ laugh: 1 });
      expect(Object.keys(memberById.get(fixture.posts[2]!)!)).toEqual(['laugh']);
      expect(memberById.get(fixture.posts[3]!)).toEqual({});
      const pageRows = (await Promise.all(fixture.posts.map((id) => stored(id)))).flat();
      expect(memberPosts.reactionsAsOf).toEqual(oldest(pageRows));

      const anonymousThread = await call('GET', `/v1/threads/${fixture.thread}`);
      expect(anonymousThread.response.status).toBe(200);
      const anonymousThreadBody = anonymousThread.value as CountedThread;
      expect(anonymousThreadBody.thread.reactions).toEqual({ like: 1, love: 1 });
      expect(anonymousThreadBody.reactionsAsOf).toEqual(oldest(await stored(fixture.thread)));
      const anonymousPage = await call('GET', `/v1/threads/${fixture.thread}/posts?limit=100`);
      expect(anonymousPage.response.status).toBe(200);
      const anonymousPosts = anonymousPage.value as CountedPage;
      expect(anonymousPosts.posts.map((post) => post.reactions)).toEqual([{ upvote: 2 }, {}, { laugh: 1 }, {}]);
      expect(anonymousPosts.reactionsAsOf).toEqual(
        oldest((await Promise.all(fixture.posts.map((id) => stored(id)))).flat()),
      );

      await react(member, threadPath, 'love');
      const lovedRows = await untilCounts(fixture.thread, { love: 2 });
      const loved = await call('GET', `/v1/threads/${fixture.thread}`, { bearer: member.bearer });
      expect(loved.response.status).toBe(200);
      const lovedBody = loved.value as CountedThread;
      expect(lovedBody.thread.reactions).toEqual({ love: 2 });
      expect(Object.keys(lovedBody.thread.reactions)).toEqual(['love']);
      expect(lovedBody.reactionsAsOf).toEqual(oldest(lovedRows));

      const cleared = await call('DELETE', `/v1/posts/${fixture.posts[2]}/reaction`, {
        bearer: member.bearer,
        key: crypto.randomUUID(),
      });
      expect(cleared.response.status).toBe(204);
      await untilCounts(fixture.posts[2]!, {});
      const afterClear = await call('GET', `/v1/threads/${fixture.thread}/posts?limit=100`, { bearer: other.bearer });
      expect(afterClear.response.status).toBe(200);
      const clearedPage = afterClear.value as CountedPage;
      const clearedById = new Map(clearedPage.posts.map((post) => [post.id, post.reactions]));
      expect(clearedById.get(fixture.posts[2]!)).toEqual({});
      expect(clearedById.get(fixture.posts[0]!)).toEqual({ upvote: 2 });
      const clearedRows = (await Promise.all(fixture.posts.map((id) => stored(id)))).flat();
      expect(clearedRows.length).toBeGreaterThan(0);
      expect(clearedPage.reactionsAsOf).toEqual(oldest(clearedRows));
      expect(clearedPage.reactionsAsOf).not.toBeNull();

      const openapi = JSON.parse(
        readFileSync(new URL('../../../../contracts/openapi.json', import.meta.url), 'utf8'),
      ) as { paths: Record<string, { get?: { responses?: Record<string, unknown> } }> };
      expect(JSON.stringify(openapi.paths['/v1/threads/{id}']?.get?.responses?.['200'])).toContain('reactionsAsOf');
      expect(JSON.stringify(openapi.paths['/v1/threads/{id}/posts']?.get?.responses?.['200'])).toContain(
        'reactionsAsOf',
      );
      const client = readFileSync(
        new URL('../../../../packages/client/src/kernel/http/kernel.d.ts', import.meta.url),
        'utf8',
      );
      expect(client).toContain('reactionsAsOf');
    },
  );

  test.serial('counts never reveal who reacted, and an unreadable target shows nothing', async () => {
    const hidden = await insertThread('draft', 2, 'Unread counts');
    await db.admin.query(
      `INSERT INTO content.reaction_total(route,target_id,kind,count,source_epoch,source_position)
       VALUES ($1,$2,'love',4,1,1)`,
      [routeOf(hidden.thread), hidden.thread],
    );
    const trace = observeSql(db.pool);
    try {
      for (const path of [`/v1/threads/${hidden.thread}`, `/v1/threads/${hidden.thread}/posts?limit=100`]) {
        for (const bearer of [member.bearer, undefined]) {
          const denied = await call('GET', path, bearer ? { bearer } : {});
          expect(denied.response.status).toBe(404);
          expect(denied.text).not.toContain('reactions');
          expect(denied.text).not.toContain(member.accountId);
          expect(denied.text).not.toContain(other.accountId);
          expect(denied.text).not.toContain('"love"');
        }
      }
      expect(trace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement))).toHaveLength(0);
    } finally {
      await trace.close();
    }

    const fixture = await insertThread('published', 2, 'Private counts');
    await react(member, `/v1/threads/${fixture.thread}/reaction`, 'like');
    await react(other, `/v1/posts/${fixture.posts[0]}/reaction`, 'love');
    await untilCounts(fixture.thread, { like: 1 });
    await untilCounts(fixture.posts[0]!, { love: 1 });
    const thread = await call('GET', `/v1/threads/${fixture.thread}`, { bearer: member.bearer });
    const page = await call('GET', `/v1/threads/${fixture.thread}/posts?limit=100`, { bearer: other.bearer });
    expect(thread.response.status).toBe(200);
    expect(page.response.status).toBe(200);
    for (const body of [thread.text, page.text]) {
      expect(body).not.toContain('"actorId"');
      expect(body).not.toContain(member.accountId);
      expect(body).not.toContain(other.accountId);
    }
    const shown = thread.value as CountedThread;
    expect(shown.thread.authorId).toBe(author.accountId);
    expect(shown.thread.reactions).toEqual({ like: 1 });
    expect(Object.values(shown.thread.reactions).every((count) => typeof count === 'number')).toBe(true);
    const posts = (page.value as CountedPage).posts;
    expect(posts.find((post) => post.id === fixture.posts[0]!)?.reactions).toEqual({ love: 1 });
    expect(posts.every((post) => Object.values(post.reactions).every((count) => typeof count === 'number'))).toBe(true);
  });

  test.serial(
    "a post page's counts cost one statement per page, not per post, as posts and reactions grow",
    async () => {
      const fixture = await insertThread('published', 4, 'Counted page cost');
      const population = {
        name: `reaction-counts-${crypto.randomUUID()}`,
        hotPartition: partitionOf(contentRoute),
        hotShare: 1,
        // Sixteen targets per ordinal keep the smallest scale at thousands of rows, so the planner reads them by index.
        rows: ({ route }: { route: number }) => ({
          'content.reaction_total': Array.from({ length: 16 }, () => ({
            route,
            target_id: newId(route),
            kind: 'like',
            count: 1,
            source_epoch: 1,
            source_position: 1,
          })),
        }),
      };
      // The page also reads boards, threads, posts and revisions: seed them to thousands of rows once, so the planner
      // reads them by index at every scale instead of scanning small relations.
      const body = Buffer.from(JSON.stringify(fromPlainText('Filler post')));
      const bodyHash = createHash('sha256').update(body).digest();
      const filler = {
        name: `reaction-counts-filler-${crypto.randomUUID()}`,
        hotPartition: partitionOf(contentRoute),
        hotShare: 1,
        rows: () => {
          const board = newId(boardRoute);
          const thread = newId(contentRoute);
          const post = newId(contentRoute);
          const revision = newId(contentRoute);
          return {
            'content.board': [
              {
                route: boardRoute,
                board_id: board,
                subject_id: author.accountId,
                title: 'Filler board',
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: board,
              },
            ],
            'content.thread': [
              {
                route: contentRoute,
                thread_id: thread,
                author_account_id: author.accountId,
                board_id: board,
                title: 'Filler thread',
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: thread,
                first_post_id: post,
              },
            ],
            'content.post': [
              {
                route: contentRoute,
                thread_id: thread,
                post_id: post,
                author_account_id: author.accountId,
                head_revision_id: revision,
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: post,
              },
            ],
            'content.revision': [
              {
                route: contentRoute,
                thread_id: thread,
                post_id: post,
                revision_id: revision,
                body,
                body_sha256: bodyHash,
                search_text: 'Filler post',
                licence: 'MIT',
                subject_ids: [],
                board_id: board,
                availability: 'available',
                recorded_transaction_id: revision,
              },
            ],
          };
        },
      };
      const report = await checkGrowth(db, {
        name: 'Post page reaction counts',
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 1,
        async grow(database, scale, previous) {
          if (previous === 0) await seed(database, filler, { from: 0, to: 2048 });
          await seed(database, population, { from: previous, to: scale });
        },
        async operation() {
          const trace = observeSql(db.pool);
          try {
            const page = await call('GET', `/v1/threads/${fixture.thread}/posts?limit=100`);
            expect(page.response.status).toBe(200);
            const body = page.value as CountedPage;
            expect(body.posts.length).toBeGreaterThan(1);
            expect(body.posts).toHaveLength(fixture.posts.length);
            expect(body.posts.every((post) => JSON.stringify(post.reactions) === '{}')).toBe(true);
            expect(body.reactionsAsOf).toBeNull();
            const counts = trace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement));
            expect(counts).toHaveLength(1);
            expect(counts[0]!.statement).not.toContain('actor_account_id');
            const idSets = counts[0]!.parameters.map(parameterIds).filter((ids): ids is Set<string> => ids !== null);
            expect(
              idSets.some((ids) => ids.size === fixture.posts.length && fixture.posts.every((id) => ids.has(id))),
            ).toBe(true);
          } finally {
            await trace.close();
          }
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      for (const sample of report.samples) {
        const reaction = sample.cost.relations?.['content.reaction_total'];
        expect(reaction).toBeDefined();
        expect(reaction?.sequentialScans).toBe(0);
        expect(sample.cost.statements).toBe(report.samples[0]!.cost.statements);
        expect(sample.cost.rows).toBe(report.samples[0]!.cost.rows);
      }
    },
    180_000,
  );
}
