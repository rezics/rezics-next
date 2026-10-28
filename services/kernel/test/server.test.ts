import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomBytes } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { developmentEnv } from '../scripts/database.ts';
import { newId, partitionOf, routeOf } from '../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../src/semantic/definitions.ts';
import { contentWorkWorkflowId } from '../src/content/work-contract.ts';
import { ConfigError, readConfig, startServer } from '../src/server.ts';
import { createContentSystem } from './content/support/system.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const key = (bytes = 32) => randomBytes(bytes).toString('base64url');
const routeKey = key();
const current = key();
const previous = key(48);
const env = {
  DATABASE_URL: databaseUrl,
  KERNEL_ROUTE_KEY: routeKey,
  KERNEL_SESSION_KEYS: `7:${current},3:${previous}`,
  KERNEL_WRITE_RATE_SECRET: 'server-test-write-rate-secret-with-at-least-32-bytes',
};
const parse = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );

function refusal(variable: string, value: string | undefined) {
  const changed = { ...env, [variable]: value };
  if (value === undefined) delete changed[variable as keyof typeof env];
  let error: unknown;
  try {
    readConfig(changed);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(variable);
  if (value) expect((error as Error).message).not.toContain(value);
}

test('the server reads its configuration from the environment and names, never echoes, what is wrong', () => {
  const config = readConfig(env);
  expect(config).toMatchObject({ databaseUrl, hostname: '127.0.0.1', port: 4100 });
  expect(Buffer.from(config.routeKey).toString('base64url')).toBe(routeKey);
  expect(config.tokens.current).toBe(7);
  expect([...config.tokens.keys.keys()]).toEqual([7, 3]);
  expect(Buffer.from(config.tokens.keys.get(3)!).toString('base64url')).toBe(previous);
  expect(readConfig({ ...env, KERNEL_HOSTNAME: '0.0.0.0', KERNEL_PORT: '0' })).toMatchObject({
    hostname: '0.0.0.0',
    port: 0,
  });

  refusal('DATABASE_URL', undefined);
  refusal('KERNEL_ROUTE_KEY', undefined);
  refusal('KERNEL_ROUTE_KEY', key(31));
  refusal('KERNEL_ROUTE_KEY', `${routeKey}=`);
  refusal('KERNEL_SESSION_KEYS', undefined);
  refusal('KERNEL_SESSION_KEYS', `1:${key(31)}`);
  refusal('KERNEL_SESSION_KEYS', `1:${current},1:${previous}`);
  refusal('KERNEL_SESSION_KEYS', `256:${current}`);
  refusal('KERNEL_SESSION_KEYS', `one:${current}`);
  refusal('KERNEL_SESSION_KEYS', `1:${current},`);
  refusal('KERNEL_PORT', '65536');
  refusal('KERNEL_PORT', '80a');
});

test('a started server answers health and the subject routes over HTTP, then stops', async () => {
  const server = await startServer(readConfig({ ...env, KERNEL_PORT: '0' }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    expect(server.url.hostname).toBe('127.0.0.1');
    expect(DBOS.isInitialized()).toBe(false);
    const health = await fetch(`${origin}/health`);
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    const missing = await fetch(`${origin}/v1/subjects/${newId(0x0042)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    const anonymous = await fetch(`${origin}/v1/subjects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '"k-1"' },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Kokoro' } }),
    });
    expect(anonymous.status).toBe(401);
  } finally {
    await server.stop();
  }
  await expect(fetch(`${origin}/health`)).rejects.toThrow();
});

test('a server with a missing Turnstile secret serves public reads while reports fail closed', async () => {
  const server = await startServer(readConfig({ ...env, KERNEL_PORT: '0' }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    const publicRead = await fetch(`${origin}/v1/subjects/${newId(0x0042)}`);
    expect(publicRead.status).toBe(404);
    const report = await fetch(`${origin}/v1/reports`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({
        target: { kind: 'board', id: newId(0x0042) },
        reason: 'spam',
        botToken: 'cannot-pass-without-a-provider-secret',
      }),
    });
    expect(report.status).toBe(404);
  } finally {
    await server.stop();
  }
});

test('a failed server startup closes its listener and pool without initializing DBOS', async () => {
  const initialized = DBOS.isInitialized();
  const server = startServer(
    readConfig({
      ...env,
      DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:1/unavailable',
      KERNEL_PORT: '0',
    }),
  );
  const origin = server.url.href.replace(/\/$/, '');
  await expect(server).rejects.toThrow();
  await server.stop();
  await expect(fetch(`${origin}/health`)).rejects.toThrow();
  expect(DBOS.isInitialized()).toBe(initialized);
});

test('the production API admits trusted content and leaves effects to the native worker', async () => {
  const system = await createContentSystem({ databaseUrl });
  const originalFetch = globalThis.fetch;
  const authNames = ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'] as const;
  const oldAuth = Object.fromEntries(authNames.map((name) => [name, process.env[name]]));
  const turnstileSecret = 'production-content-turnstile-test-secret';
  const providerCalls: string[] = [];
  const caller = system.actors.worker;
  const tokenClaims = JSON.parse(Buffer.from(caller.bearer.split('.')[1]!, 'base64url').toString()) as {
    iss: string;
    aud: string;
  };
  const issuer = tokenClaims.iss;
  const audience = tokenClaims.aud;
  const jwksResult = await system.database.authPool.query<{ public_jwk: Record<string, string> }>(`
    SELECT private_jwk - 'd' AS public_jwk
    FROM auth_signing_key
    WHERE kid IN (
      SELECT current_kid FROM auth_signing_generation WHERE singleton = true
      UNION
      SELECT retiring_kid FROM auth_signing_generation WHERE singleton = true
    )`);
  const jwks = { keys: jwksResult.rows.map((row) => row.public_jwk) };
  expect(jwks.keys.length).toBeGreaterThan(0);

  const appName = await system.database.pool.query<{ name: string }>('SELECT current_database() AS name');
  const apiDatabaseUrl = new URL(databaseUrl);
  apiDatabaseUrl.pathname = `/${appName.rows[0]!.name}`;
  const runtimeEnv = {
    ...env,
    DATABASE_URL: apiDatabaseUrl.href,
    KERNEL_PORT: '0',
    KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: [...system.tokenKeys.keys.entries()]
      .map(([id, value]) => `${id}:${Buffer.from(value).toString('base64url')}`)
      .join(','),
    CONTENT_SOURCE_HOSTS: 'images.example.test',
  };
  const remoteAuth = {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
  };
  for (const [name, value] of Object.entries(remoteAuth)) process.env[name] = value;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === remoteAuth.AUTH_JWKS_URL) return Response.json(jwks);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const proof = form.get('response') ?? '';
      providerCalls.push(proof);
      expect(form.get('secret')).toBe(turnstileSecret);
      return Response.json(
        proof === 'valid-one-use-proof'
          ? { success: true, hostname: 'reports.content.example.test', action: 'report' }
          : { success: false, hostname: 'reports.content.example.test', action: 'report' },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  let api: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: Awaited<ReturnType<typeof nativeWorker>> | undefined;
  const origin = () => api!.url.href.replace(/\/$/, '');
  const call = async (
    path: string,
    options: { method?: string; bearer?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(`${origin()}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.method === 'GET' || options.method === undefined
          ? {}
          : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  const eventually = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Native worker did not settle production content work');
      await Bun.sleep(25);
    }
  };
  const prepare = async (path: string, method: string, body: unknown, headers: Record<string, string> = {}) => {
    const { response } = await system.transport.capture(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${caller.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    const value = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (!response.ok) throw new Error(`Native fixture ${path} failed (${response.status}): ${JSON.stringify(value)}`);
    return { response, value };
  };
  const dbosBeforeApi = DBOS.isInitialized();

  try {
    api = await startServer(readConfig(runtimeEnv));
    expect(DBOS.isInitialized()).toBe(dbosBeforeApi);

    const spaceResponse = await prepare('/v1/spaces', 'POST', {
      title: 'Production API space',
      summary: 'Content composition fixture',
    });
    const realmResponse = await prepare('/v1/realms', 'POST', {
      spaceId: spaceResponse.value.space.spaceId,
      title: 'Production API realm',
      summary: 'Content composition fixture',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    });
    const schemeResponse = await prepare('/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Production API scheme' },
    });
    const conceptResponse = await prepare('/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Production API concept' },
      statements: {
        'skos:inScheme': [
          { property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeResponse.value.subject.id } },
        ],
      },
    });
    const schemeRevision = realmResponse.value.realm.headRevisionId;
    await prepare(
      `/v1/realms/${realmResponse.value.realm.realmId}/boardScheme`,
      'PUT',
      { schemeId: schemeResponse.value.subject.id },
      { 'if-match': JSON.stringify(schemeRevision) },
    );
    const boardResponse = await prepare(`/v1/realms/${realmResponse.value.realm.realmId}/boards`, 'POST', {
      conceptId: conceptResponse.value.subject.id,
      title: 'Production API board',
      visibility: 'published',
    });
    const board = boardResponse.value.board as { id: string };
    const threadResponse = await call('/v1/threads', {
      method: 'POST',
      bearer: caller.bearer,
      body: {
        boardId: board.id,
        subjectIds: [conceptResponse.value.subject.id],
        title: 'Production API thread',
        licence: 'CC-BY-SA-4.0',
        visibility: 'published',
        body: fromPlainText('Created over the production HTTP server'),
      },
    });
    expect(threadResponse.response.status).toBe(201);
    const thread = threadResponse.value.thread as {
      id: string;
      firstPost: { id: string; revisionId: string };
    };

    const threadEvent = await system.database.pool.query<{
      partition_no: number;
      epoch: number;
      position: string;
    }>(
      `SELECT partition_no, epoch, position::text
       FROM core.outbox
       WHERE type='com.rezics.content.thread.created.v1' AND data->>'threadId'=$1
       ORDER BY position DESC LIMIT 1`,
      [thread.id],
    );
    expect(threadEvent.rows).toHaveLength(1);
    expect(threadEvent.rows[0]!.partition_no).toBe(partitionOf(routeOf(thread.id)!));
    const eventPosition = BigInt(threadEvent.rows[0]!.position);
    const effectsCheckpoint = await system.database.pool.query<{ position: string }>(
      'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
      ['effects', threadEvent.rows[0]!.partition_no],
    );
    expect(effectsCheckpoint.rows.length === 0 || BigInt(effectsCheckpoint.rows[0]!.position) < eventPosition).toBe(
      true,
    );
    const threadRead = await call(`/v1/threads/${thread.id}`);
    expect(threadRead.response.status).toBe(200);
    const anonymousReportUnavailable = await call('/v1/reports', {
      method: 'POST',
      body: { target: { kind: 'thread', id: thread.id }, reason: 'spam', botToken: 'without-provider-secret' },
    });
    expect(anonymousReportUnavailable.response.status).toBe(404);
    const authenticatedReport = await call('/v1/reports', {
      method: 'POST',
      bearer: system.actors.other.bearer,
      body: { target: { kind: 'thread', id: thread.id }, reason: 'spam' },
    });
    expect(authenticatedReport.response.status).toBe(201);

    const noSecretServer = api;
    await noSecretServer.stop();
    await noSecretServer.stop();
    expect(DBOS.isInitialized()).toBe(dbosBeforeApi);

    api = await startServer(
      readConfig({
        ...runtimeEnv,
        CONTENT_TURNSTILE_SECRET: turnstileSecret,
        CONTENT_TURNSTILE_HOSTNAME: 'reports.content.example.test',
      }),
    );
    expect(DBOS.isInitialized()).toBe(dbosBeforeApi);
    worker = await nativeWorker(apiDatabaseUrl.href);

    const reportCounts = await system.database.pool.query<{ reports: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM content.report) AS reports,
             (SELECT count(*)::text FROM core.receipt) AS receipts`);
    const invalidProof = await call('/v1/reports', {
      method: 'POST',
      body: { target: { kind: 'thread', id: thread.id }, reason: 'spam', botToken: 'invalid-one-use-proof' },
    });
    expect(invalidProof.response.status).toBe(403);
    const afterInvalid = await system.database.pool.query<{ reports: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM content.report) AS reports,
             (SELECT count(*)::text FROM core.receipt) AS receipts`);
    expect(afterInvalid.rows[0]).toEqual(reportCounts.rows[0]);

    const validProof = await call('/v1/reports', {
      method: 'POST',
      body: { target: { kind: 'thread', id: thread.id }, reason: 'spam', botToken: 'valid-one-use-proof' },
    });
    expect(validProof.response.status).toBe(201);
    expect(providerCalls).toEqual(['invalid-one-use-proof', 'valid-one-use-proof']);
    await eventually(async () => {
      const projection = await system.database.pool.query(
        'SELECT 1 FROM content.report_target WHERE route=$1 AND report_id=$2 AND target_id=$3',
        [routeOf(thread.id), validProof.value.reportId, thread.id],
      );
      return projection.rows.length === 1;
    });

    await eventually(async () => {
      const link = await system.database.pool.query(
        `SELECT 1 FROM semantic.inbound_link
         WHERE route=$1 AND subject_id=$2 AND property='skos:inScheme' AND source_subject_id=$3 AND present`,
        [routeOf(schemeResponse.value.subject.id), schemeResponse.value.subject.id, conceptResponse.value.subject.id],
      );
      return link.rows.length === 1;
    });
    const boardThreads = await call(`/v1/boards/${board.id}/threads`);
    expect(boardThreads.response.status).toBe(200);
    expect((boardThreads.value.threads as Array<{ id: string }>).some((item) => item.id === thread.id)).toBe(true);

    const digest = 'a'.repeat(64);
    const reservation = await call('/v1/media', {
      method: 'POST',
      bearer: caller.bearer,
      body: {
        containerId: thread.firstPost.id,
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: 256,
        sha256: digest,
      },
    });
    expect(reservation.response.status).toBe(201);
    const media = reservation.value.media as { id: string; reservationRequestId: string };
    const completion = await call(`/v1/media/${media.id}:complete`, {
      method: 'POST',
      bearer: caller.bearer,
      body: {
        containerId: thread.firstPost.id,
        reservationRequestId: media.reservationRequestId,
        byteCount: 256,
        sha256: digest,
      },
    });
    expect(completion.response.status).toBe(200);

    const uploadedEvent = await system.database.pool.query<{
      partition_no: number;
      epoch: number;
      position: string;
      event_seq: number;
    }>(
      `SELECT partition_no, epoch, position::text, event_seq
       FROM core.outbox
       WHERE type='com.rezics.content.media.uploaded.v1' AND subject=$1
       ORDER BY position DESC LIMIT 1`,
      [media.id],
    );
    expect(uploadedEvent.rows).toHaveLength(1);
    const source = uploadedEvent.rows[0]!;
    const workflowId = contentWorkWorkflowId(
      { partition: source.partition_no, epoch: source.epoch, position: BigInt(source.position) },
      source.event_seq,
      'image',
    );
    await eventually(async () => {
      const durable = await system.database.pool.query<{ name: string; queue_name: string }>(
        'SELECT name, queue_name FROM dbos.workflow_status WHERE workflow_uuid=$1',
        [workflowId],
      );
      return durable.rows.length === 1;
    });
    const durableWork = await system.database.pool.query<{ name: string; queue_name: string }>(
      'SELECT name, queue_name FROM dbos.workflow_status WHERE workflow_uuid=$1',
      [workflowId],
    );
    expect(durableWork.rows[0]).toMatchObject({ name: 'content.image', queue_name: 'effects' });
    const stoppedWorker = worker;
    await stoppedWorker.stop();
    worker = undefined;
    const lastCheckpoint = await system.database.pool.query<{ position: string }>(
      'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
      ['effects', source.partition_no],
    );
    await api.stop();
    await api.stop();
    await Bun.sleep(150);
    const finalCheckpoint = await system.database.pool.query<{ position: string }>(
      'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
      ['effects', source.partition_no],
    );
    expect(finalCheckpoint.rows).toEqual(lastCheckpoint.rows);
    expect(DBOS.isInitialized()).toBe(dbosBeforeApi);
  } finally {
    if (worker) await worker.stop();
    if (api) await api.stop();
    globalThis.fetch = originalFetch;
    for (const name of authNames) {
      const value = oldAuth[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await system.close();
  }
}, 180_000);

async function nativeWorker(databaseUrl: string) {
  const workerEntry = new URL('../src/worker.ts', import.meta.url).href;
  const relayEntry = new URL('../src/content/relays.ts', import.meta.url).href;
  const source = `
    import { startWorker } from ${JSON.stringify(workerEntry)};
    import { contentEffects } from ${JSON.stringify(relayEntry)};
    console.log('starting');
    const worker = await startWorker(
      { databaseUrl: process.env.DATABASE_URL, executorId: 'server-content-test', poolSize: 5 },
      [{ name: 'content-effects', register(context) { context.addEffects(contentEffects(context.pool, context.client)); } }],
    );
    console.log('ready');
    for await (const line of console) {
      if (line === 'stop') { await worker.stop(); console.log('stopped'); break; }
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const stdout = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const stderr = new Response(child.stderr).text();
  const waitReady = async () => {
    const deadline = Date.now() + 60_000;
    while (!output.includes('ready')) {
      if (child.exitCode !== null) throw new Error(`Native worker failed to start: ${await stderr}`);
      if (Date.now() >= deadline) throw new Error(`Native worker startup timed out: ${output}`);
      await Bun.sleep(20);
    }
  };
  try {
    await waitReady();
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    await stdout;
    throw new Error(`${String(error)}\n${await stderr}`);
  }
  return {
    async stop() {
      child.stdin.write('stop\n');
      child.stdin.end();
      const deadline = Date.now() + 20_000;
      while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
        await stdout;
        throw new Error(`Native worker did not stop: ${await stderr}`);
      }
      expect(await child.exited).toBe(0);
      await stdout;
      expect(output).toContain('stopped');
      expect(await stderr).not.toContain('AssertionError');
    },
  };
}

test('db up writes development secrets once and keeps them across restarts', () => {
  const first = developmentEnv('', 'postgres://rezics:rezics@127.0.0.1:54329/rezics');
  const values = parse(first);
  expect(Object.keys(values).sort()).toEqual([
    'DATABASE_URL',
    'KERNEL_RATING_COUNTER_SECRET',
    'KERNEL_ROUTE_KEY',
    'KERNEL_SESSION_KEYS',
  ]);
  expect(values.KERNEL_RATING_COUNTER_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const fresh = parse(developmentEnv('', 'postgres://rezics:rezics@127.0.0.1:54329/rezics'));
  expect(fresh.KERNEL_RATING_COUNTER_SECRET).not.toBe(values.KERNEL_RATING_COUNTER_SECRET);
  expect(readConfig(values).databaseUrl).toBe('postgres://rezics:rezics@127.0.0.1:54329/rezics');
  expect(developmentEnv('', values.DATABASE_URL!)).not.toBe(first);

  const edited = `${first}KERNEL_PORT=4200\n`;
  const again = parse(developmentEnv(edited, 'postgres://rezics:rezics@127.0.0.1:54330/rezics'));
  expect(again).toEqual({
    ...values,
    DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:54330/rezics',
    KERNEL_PORT: '4200',
  });
});
