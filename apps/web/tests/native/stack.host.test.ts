import { Pool } from 'pg';
import { afterEach, describe, expect, test } from 'bun:test';
import { startNativeWebStack } from './stack.ts';

const stacks: Awaited<ReturnType<typeof startNativeWebStack>>[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.stop();
});

async function semanticDatabases(databaseUrl: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'semantic\\_%' ORDER BY datname",
    );
    return result.rows.map(({ datname }) => datname);
  } finally {
    await pool.end();
  }
}

describe('native web stack', () => {
  test('isolates lifecycle and serves native kernel reads through the production Worker', async () => {
    const databaseUrlBefore = process.env.DATABASE_URL;
    const databasesBefore = databaseUrlBefore ? await semanticDatabases(databaseUrlBefore) : undefined;
    const start = performance.now();
    const stack = await startNativeWebStack();
    stacks.push(stack);
    const stackDatabaseUrl = process.env.DATABASE_URL!;
    const startedInMs = Math.round(performance.now() - start);

    const active = await stack.kernel('/v1/definitions/active');
    expect(active.status).toBe(200);
    const createdResponse = await stack.kernel('/v1/subjects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Native stack subject' } }),
    }, 'editor');
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };
    const canonicalUrl = `${stack.web}/en/subjects/${created.id}_native-stack-subject`;

    const pageStart = stack.kernelRequests().length;
    const page = await stack.request(canonicalUrl);
    const pageStatus = page.status;
    const pageHeaders = [...page.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
    const pageBody = await page.text();
    expect(pageStatus).toBe(200);
    expect(pageHeaders.find(([name]) => name === 'content-type')?.[1]).toContain('text/html');
    expect(pageBody).toContain('<title>Native stack subject');
    const subjectPageRequests = stack.kernelRequests().slice(pageStart);
    expect(subjectPageRequests.length).toBeGreaterThan(0);
    expect(subjectPageRequests.every((request) => request.url.startsWith('/v1/'))).toBe(true);
    const peakMemoryBytes = stack.peakMemoryBytes();
    expect(peakMemoryBytes).toBeGreaterThan(0);

    const stale = await stack.request(`${stack.web}/en/subjects/${created.id}_old-title`);
    expect(stale.status).toBe(308);
    expect(stale.headers.get('location')).toContain(`${created.id}_native-stack-subject`);

    const credentials = await stack.credentials('editor');
    expect(credentials.authorization).toMatch(/^Bearer [^ ]+$/);
    const personalStart = stack.kernelRequests().length;
    const personalPage = await stack.request(`${stack.web}/en/library`, 'editor');
    expect(personalPage.status).toBe(200);
    const personalReads = stack.kernelRequests().slice(personalStart).filter(({ url }) => url.startsWith('/v1/libraryEntries'));
    expect(personalReads.length).toBeGreaterThan(0);
    expect(personalReads.every(({ authorization }) => authorization === credentials.authorization)).toBe(true);

    const anonymousStart = stack.kernelRequests().length;
    const anonymousLibrary = await stack.request(`${stack.web}/en/library`);
    expect(anonymousLibrary.status).toBe(200);
    const anonymousReads = stack.kernelRequests().slice(anonymousStart).filter(({ url }) => url.startsWith('/v1/libraryEntries'));
    expect(anonymousReads).toHaveLength(0);

    await stack.restartWeb({ publicOrigin: 'https://second.example.test' });
    const restarted = await stack.request(`https://second.example.test/en/subjects/${created.id}_native-stack-subject`);
    expect(restarted.status).toBe(200);
    expect(await restarted.text()).toContain('Native stack subject');
    expect(stack.kernelRequests().every(({ url }) => url.startsWith('/v1/'))).toBe(true);

    const stoppedAt = performance.now();
    await stack.stop();
    const stoppedInMs = Math.round(performance.now() - stoppedAt);
    stacks.splice(stacks.indexOf(stack), 1);
    if (databaseUrlBefore) expect(await semanticDatabases(stackDatabaseUrl)).toEqual(databasesBefore);
    expect(process.env.DATABASE_URL).toBe(databaseUrlBefore);
    await expect(fetch(canonicalUrl, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    await expect(fetch(stack.kernelOrigin, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    console.info(
      `native-web-growth: start=${startedInMs}ms stop=${stoppedInMs}ms peak-memory=${peakMemoryBytes}bytes subject-page-kernel-requests=${subjectPageRequests.length} owned-databases-after-stop=0`,
    );
  }, 300_000);

  test('cleans up the database and listeners when the production web Worker fails to start', async () => {
    const databaseUrlBefore = process.env.DATABASE_URL;
    const databasesBefore = databaseUrlBefore ? await semanticDatabases(databaseUrlBefore) : undefined;
    const priorInspectorPort = process.env.WORKER_INSPECTOR_PORT;
    process.env.WORKER_INSPECTOR_PORT = 'not-a-port';
    try {
      await expect(startNativeWebStack()).rejects.toThrow(/WORKER_INSPECTOR_PORT/);
    } finally {
      if (priorInspectorPort === undefined) delete process.env.WORKER_INSPECTOR_PORT;
      else process.env.WORKER_INSPECTOR_PORT = priorInspectorPort;
    }
    expect(process.env.DATABASE_URL).toBe(databaseUrlBefore);
    if (databaseUrlBefore) expect(await semanticDatabases(databaseUrlBefore)).toEqual(databasesBefore);
  }, 300_000);
});

// Observe the transport boundary while still using native fetch and the served Worker.
// The returned object must be that exact HTTP Response, with its body still unread.
test('returns the original HTTP response and confines absolute URLs, credentials and redirects to the stack', async () => {
  const stack = await startNativeWebStack();
  stacks.push(stack);
  let escaped = 0;
  const canary = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      escaped++;
      return new Response('escaped');
    },
  });
  const nativeFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit; response: Response }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await nativeFetch(input, init);
    calls.push({ url: String(input), init, response });
    return response;
  }) as typeof fetch;
  try {
    const path = '/en/subjects/00000000-0000-4000-8000-000000000000?transport=kept';
    const response = await stack.request(`${canary.url.origin}${path}`, 'anonymous', { 'accept-language': 'zh-Hans' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${stack.web}${path}`);
    expect(calls[0]!.init?.redirect).toBe('manual');
    const sent = new Headers(calls[0]!.init?.headers);
    expect(sent.get('accept-language')).toBe('zh-Hans');
    expect(sent.has('authorization')).toBe(false);
    expect(response).toBe(calls[0]!.response);
    expect(response.status).toBe(404);
    expect(response.bodyUsed).toBe(false);
    expect(response.redirected).toBe(false);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<html');
    await expect(stack.kernel(canary.url.href)).rejects.toThrow('owned listener');
    await expect(stack.kernel(`${stack.kernelOrigin}@127.0.0.1:${canary.port}/`)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(escaped).toBe(0);
  } finally {
    globalThis.fetch = nativeFetch;
    await canary.stop(true);
  }
}, 300_000);
