import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { subjectGenerations, subjectIndexName, subjectAlias } from '../../src/search/indices.ts';
import { readConfig, startServer } from '../../src/server.ts';
import { searchWorkModule } from '../../src/search/work.ts';
import type { Source } from '@rezics/definitions/bulk';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import type { WorkContext } from '../../src/work/registry.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';
import { identitySupport } from '../imports/identity-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check services');
const search = createOpenSearch(searchUrl);
type SearchRunner = Awaited<ReturnType<typeof startSearchIndexing>>;

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Search runner did not catch up');
    await Bun.sleep(50);
  }
}

test('production Search API and default Search module use their real configured route key to withhold imported fenced facts', async () => {
  const driver = createImportIdentityDriver();
  const prefix = `fence-${randomUUID().slice(0, 8)}-`;
  let worker: SearchRunner | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let identity: Awaited<ReturnType<typeof driver.open>> | undefined;
  try {
    identity = await driver.open({ clock: () => new Date() });
    const { pool, url } = identity.database;
    await setupSemantic(pool, bundledRelease);
    const support = identitySupport(identity);
    const scopes = ['subject:read', 'context:accept', 'context:adopt', 'source_fence:takedown'];
    const clientId = `production-fence-${randomUUID()}`;
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
    const routeKey = Buffer.from(identity.routeKey).toString('base64url');
    const sessionKey = Buffer.alloc(32, 9).toString('base64url');
    const config = readConfig({
      DATABASE_URL: url,
      KERNEL_ROUTE_KEY: routeKey,
      KERNEL_SESSION_KEYS: `1:${sessionKey}`,
      KERNEL_PORT: '0',
      OPENSEARCH_URL: searchUrl,
      KERNEL_SEARCH_PREFIX: prefix,
    });
    server = startServer(config);

    const workServices: (() => SearchRunner | Promise<SearchRunner>)[] = [];
    await searchWorkModule.register({
      pool,
      env: { OPENSEARCH_URL: searchUrl, KERNEL_SEARCH_PREFIX: prefix, KERNEL_ROUTE_KEY: routeKey },
      addService(start: () => SearchRunner | Promise<SearchRunner>) {
        workServices.push(start);
      },
    } as unknown as WorkContext);
    expect(workServices).toHaveLength(1);
    worker = await workServices[0]!();
    await eventually(async () => (await subjectGenerations(search, prefix)).active === 1);

    async function post(path: string, body: unknown, bearer = observer) {
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
      if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    const externalId = `production-fence-${randomUUID()}`;
    const controlExternalId = `production-control-${randomUUID()}`;
    const provenance = (external: string): Source => ({
      source: 'openlibrary',
      external_id: external,
      record_revision: 'unversioned',
      digest: 'd'.repeat(64),
      converter_revision: 'openlibrary@1',
      field_group: 'facts',
    });
    const name = `Production fence subject ${randomUUID()}`;
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
        commands: [externalId, controlExternalId].map((external, index) => ({
          op: 'propose',
          key: `language-${index}`,
          source: provenance(external),
          subject: id,
          statement: {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: index === 0 ? 'ja' : 'en' },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: `https://openlibrary.org/works/${external}` },
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

    const origin = server.url.href.replace(/\/$/, '');
    async function readFacts() {
      const response = await fetch(`${origin}/v1/subjects:search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: name, properties: ['schema:inLanguage'] }),
      });
      if (response.status !== 200)
        throw new Error(`Search API returned HTTP ${response.status}: ${await response.text()}`);
      const payload = (await response.json()) as {
        subjects: { id: string; facts?: Record<string, { kind?: string; value?: string }[]> }[];
      };
      return payload.subjects.find((subject) => subject.id === id)?.facts?.['schema:inLanguage'] ?? [];
    }
    await eventually(async () => {
      const facts = await readFacts();
      return (
        facts.some((fact) => fact.kind === 'code' && fact.value === 'ja') &&
        facts.some((fact) => fact.kind === 'code' && fact.value === 'en')
      );
    });
    expect(await readFacts()).toEqual([
      { kind: 'code', value: 'ja' },
      { kind: 'code', value: 'en' },
    ]);

    await worker.pause();
    await post('/v1/sourceFences:takedown', {
      source: 'openlibrary',
      externalId,
      fieldGroup: 'facts',
      reason: 'Imported descriptive field complaint',
    });
    expect(await readFacts()).toEqual([{ kind: 'code', value: 'en' }]);

    // Source tuple fences do not currently enqueue the indexer's affected-anchor event.
    // A real ordinary subject-anchor mutation makes the paused default worker reread
    // this subject so this caller proof can observe the current keyed Source result.
    const anchor = await post(
      '/v1/subjects:batchWrite',
      {
        commands: [
          {
            op: 'propose',
            key: 'ordinary-anchor',
            source: provenance(`production-anchor-${randomUUID()}`),
            subject: id,
            statement: {
              property: { id: 'schema:inLanguage' },
              value: { type: 'value', content: 'fr' },
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value', content: 'https://openlibrary.org/works/ordinary-anchor' },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      importer.bearer,
    );
    expect(anchor.results[0].status).toBe(201);

    worker.resume();
    await eventually(async () => {
      const response = await search.request<{ hits: { hits: { _source: { id: string; statements: string[] } }[] } }>(
        'POST',
        `/${subjectAlias(prefix)}/_search`,
        { query: { ids: { values: [id] } } },
      );
      return (
        response.body.hits.hits[0]?._source.statements.includes('schema:inLanguage=en') === true &&
        !response.body.hits.hits[0]?._source.statements.includes('schema:inLanguage=ja')
      );
    });
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.stop();
      } finally {
        try {
          const generations = await subjectGenerations(search, prefix);
          for (const generation of generations.generations)
            await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
        } finally {
          if (identity) await driver.release(identity);
        }
      }
    }
  }
}, 120_000);
