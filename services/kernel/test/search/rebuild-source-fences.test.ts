import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Source } from '@rezics/definitions/bulk';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';
import { identitySupport } from '../imports/identity-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const search = createOpenSearch(searchUrl);
const kernelDirectory = new URL('../..', import.meta.url).pathname;
const freshPrefix = () => `test-${randomUUID().slice(0, 8)}-`;

async function removeIndices(prefix: string) {
  for (const generation of (await subjectGenerations(search, prefix)).generations)
    await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
}

async function cli(url: string, prefix: string, routeKey: string | undefined, timeoutMs = 45_000) {
  // Keep unrelated server credentials out of the rebuild environment.
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    DATABASE_URL: url,
    OPENSEARCH_URL: searchUrl!,
    KERNEL_SEARCH_PREFIX: prefix,
  };
  if (routeKey !== undefined) env.KERNEL_ROUTE_KEY = routeKey;
  const child = Bun.spawn([process.execPath, 'scripts/search.ts', 'rebuild'], {
    cwd: kernelDirectory,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Search runner did not catch up');
    await Bun.sleep(50);
  }
}

test('the real rebuild command uses the configured route key for current imported-source fences', async () => {
  const driver = createImportIdentityDriver();
  const prefix = freshPrefix();
  let running: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  try {
    const identity = await driver.open({ clock: () => new Date() });
    const { pool, url } = identity.database;
    await setupSemantic(pool, bundledRelease);
    const support = identitySupport(identity);
    const scopes = ['subject:read', 'context:accept', 'context:adopt', 'source_fence:takedown'];
    const clientId = `rebuild-observer-${randomUUID()}`;
    await identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
    const signed = await support.request('/signin', {
      email: 'governance@identity.test',
      password: 'private native identity fixture password',
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const issued = await support.request(
      '/token',
      {},
      new Headers({
        cookie: signed.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      }),
    );
    expect(issued.status).toBe(200);
    const observer = ((await issued.json()) as { access_token: string }).access_token;
    const importer = await support.issue(identity.bulk.accountId, identity.client.scopes);
    const app = createKernel({
      pool,
      access: identity.access,
      routeKey: identity.routeKey,
      tokens: identity.tokenKeys,
      writeRate: createWriteRateLimiter({ secret: randomUUID() }),
    });
    async function post(path: string, body: unknown, bearer = observer, status = 200) {
      const response = await app.handle(
        new Request(`https://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
          },
          body: JSON.stringify(body),
        }),
      );
      const result = (await response.json()) as Record<string, any>;
      if (response.status !== status) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    const externalId = `rebuild-${randomUUID()}`;
    const provenance = (external: string): Source => ({
      source: 'openlibrary',
      external_id: external,
      record_revision: 'unversioned',
      digest: 'c'.repeat(64),
      converter_revision: 'openlibrary@1',
      field_group: 'facts',
    });
    const name = `Imported fence book ${randomUUID()}`;
    const created = await post(
      '/v1/subjects:batchWrite',
      {
        commands: [
          {
            op: 'create',
            key: 'create',
            source: provenance(externalId),
            subject: { type: 'schema:Book', labels: { en: name } },
          },
        ],
      },
      importer.bearer,
    );
    expect(created.results[0].status).toBe(201);
    const id = created.results[0].value.id as string;
    const proposed = await post(
      '/v1/subjects:batchWrite',
      {
        commands: [
          [externalId, 'ja'],
          [`${externalId}-control`, 'en'],
        ].map(([external, language], index) => ({
          op: 'propose',
          key: `language-${index}`,
          source: provenance(external!),
          subject: id,
          statement: {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: language },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: {
                      type: 'value',
                      content: `https://openlibrary.org/works/${external}`,
                    },
                  },
                ],
              },
            ],
          },
        })),
      },
      importer.bearer,
    );
    const candidates: string[] = proposed.results.map((result: Record<string, any>) => {
      expect(result.status).toBe(201);
      return result.value.candidate;
    });
    for (const candidate of candidates)
      await post(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context: GLOBAL_CONTEXT, expected_head: null });
    await post(`/v1/subjects/${id}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:inLanguage',
      mode: 'replace',
      selection: candidates.map((candidate) => ({ candidate, rank: 'normal' })),
      expected_head: null,
    });

    // This fixture owns a real runner, not the separate default-worker composition proof.
    running = await startSearchIndexing({
      pool,
      search,
      prefix,
      source: subjectSource(pool, identity.routeKey),
      listing: subjectListingSource(pool),
      discoverMs: 50,
      intervalMs: 20,
      concurrency: 2,
    });
    async function document(index = subjectAlias(prefix)) {
      const answer = await search.request<{ hits: { hits: { _index: string; _source: Record<string, any> }[] } }>(
        'POST',
        `/${index}/_search`,
        { query: { ids: { values: [id] } } },
      );
      return answer.body.hits.hits[0];
    }
    await eventually(async () => (await document())?._source.statements.includes('schema:inLanguage=ja') === true);
    await running.pause();
    await post('/v1/sourceFences:takedown', {
      source: 'openlibrary',
      externalId,
      fieldGroup: 'facts',
      reason: 'Imported descriptive field complaint',
    });
    const stale = await document();
    expect(stale?._source.statements).toEqual(['schema:inLanguage=ja', 'schema:inLanguage=en']);
    running.resume();
    const result = await cli(url, prefix, Buffer.from(identity.routeKey).toString('base64url'));
    if (result.timedOut || result.exitCode !== 0) throw new Error(`CLI rebuild: ${JSON.stringify(result)}`);
    expect(JSON.parse(result.stdout)).toEqual({ generation: 2, previous: 1 });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 2 });
    const replacement = await document();
    expect(replacement?._index).toBe(subjectIndexName(prefix, 2));
    expect(structuredClone(replacement?._source)).toMatchObject({ id, names: [name], name_sort: name });
    expect(replacement?._source.statements).toEqual(['schema:inLanguage=en']);
    expect(replacement?._source.facts).toEqual([{ property: 'schema:inLanguage', value: 'en', qualifiers: [] }]);
    const count = await search.request<{ count: number }>('GET', `/${subjectAlias(prefix)}/_count`);
    expect(count.body.count).toBe(1);
  } finally {
    try {
      await running?.stop();
    } finally {
      try {
        await removeIndices(prefix);
      } finally {
        await driver.close();
      }
    }
  }
}, 120_000);

test('rebuild refuses missing or malformed route keys without creating a replacement generation', async () => {
  const canonical = Buffer.alloc(32).toString('base64url');
  const invalid = [
    undefined,
    '',
    ' ',
    '!',
    'A',
    `${canonical}=`,
    `${canonical.slice(0, -1)}B`,
    Buffer.alloc(32, 255).toString('base64'),
    Buffer.alloc(31).toString('base64url'),
    Buffer.alloc(33).toString('base64url'),
  ];
  const prefix = freshPrefix();
  try {
    const before = await subjectGenerations(search, prefix);
    for (const key of invalid) {
      const result = await cli(databaseUrl!, prefix, key, 10_000);
      expect(await subjectGenerations(search, prefix)).toEqual(before);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('ConfigError: Invalid or missing KERNEL_ROUTE_KEY');
      if (key && key.length > 1) expect(result.stderr).not.toContain(key);
    }
    // Invalid configuration must win even when a pool could not connect.
    const unreachable = await cli('postgres://invalid:invalid@127.0.0.1:1/invalid', prefix, 'invalid');
    expect(unreachable.stderr).toContain('ConfigError: Invalid or missing KERNEL_ROUTE_KEY');
    expect(unreachable.exitCode).toBe(1);
    expect(await subjectGenerations(search, prefix)).toEqual(before);
  } finally {
    await removeIndices(prefix);
  }
}, 120_000);
