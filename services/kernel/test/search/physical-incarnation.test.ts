import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import {
  createSubjectIndex,
  readSubjectSortFormat,
  subjectAlias,
  subjectGenerations,
  subjectIndexDefinition,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { createSearchService, type SearchRequest } from '../../src/search/service.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';

type Native = {
  timed_out: boolean;
  _shards: { total: number; successful: number; failed: number };
  hits: { total: { value: number; relation: string }; hits: { _id: string; _index: string }[] };
};
type Boundary = 'after priming' | 'before native execution' | 'after native observation';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This slice exercises incarnation admission only. There is no privacy-log/PIT runtime here to simulate or ACK.
// Empty native results below are query observations, never evidence that a replacement has replayed Source.
async function scenario(boundary: Boundary, zero: boolean, continuation = false) {
  const identities = createImportIdentityDriver();
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
  let runner: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  try {
    const identity = await identities.open({ clock: () => new Date() });
    await setupSemantic(identity.database.pool, bundledRelease);
    const source = subjectSource(identity.database.pool, identity.routeKey);
    let armed = false;
    let replaced = false;
    const calls: { method: string; path: string }[] = [];
    const observations: { target: string; uuid: string; body: Native; hash: string }[] = [];

    async function physical() {
      const [settings, mapping, generations] = await Promise.all([
        engine.request<Record<string, { settings: { index: { uuid: string } } }>>('GET', `/${index}/_settings`),
        engine.request<Record<string, { mappings: Record<string, unknown> }>>('GET', `/${index}/_mapping`),
        subjectGenerations(engine, prefix),
      ]);
      const uuid = settings.body[index]!.settings.index.uuid;
      expect(uuid).toBeString();
      expect(uuid.length).toBeGreaterThan(0);
      expect(generations).toEqual({ generations: [1], active: 1 });
      return { uuid, mappings: mapping.body[index]!.mappings, generations };
    }

    async function recreate() {
      expect(replaced).toBe(false);
      await engine.request('DELETE', `/${index}`);
      if (boundary === 'after priming') {
        // A supported-format cache for the old UUID must not authorize this unmarked physical index.
        const definition = structuredClone(subjectIndexDefinition()) as { mappings: { _meta?: unknown } };
        delete definition.mappings._meta;
        await engine.request('PUT', `/${index}`, definition);
      } else {
        // Identical mapping/name/generation, different native UUID: re-reading only the format is insufficient.
        await createSubjectIndex(engine, prefix, 1);
      }
      await engine.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
      replaced = true;
    }

    const intercepted: OpenSearch = {
      bulk: (...args) => engine.bulk(...args),
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        calls.push({ method: args[0], path: args[1] });
        const gated = armed && args[0] === 'POST' && args[1].endsWith('/_search/template');
        if (!gated) return engine.request<T>(...args);
        // Pause exactly one real query at dispatch or delivery; never replace its target, body or response metadata.
        armed = false;
        if (boundary === 'before native execution') await recreate();
        const selected = await physical();
        const response = await engine.request<T>(...args);
        const body = response.body as Native;
        const hash = digest(body);
        observations.push({ target: args[1], uuid: selected.uuid, body, hash });
        if (boundary === 'after native observation') await recreate();
        expect(digest(response.body)).toBe(hash);
        return response;
      },
    };
    const service = createSearchService({
      pool: identity.database.pool,
      client: intercepted,
      prefix,
      source,
      cursors: identity.tokenKeys,
    });
    const application = createKernel({
      pool: identity.database.pool,
      access: identity.access,
      routeKey: identity.routeKey,
      tokens: identity.tokenKeys,
      writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() }),
      search: service,
    });
    async function request(body: SearchRequest) {
      return application.handle(
        new Request('https://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }
    const ids: string[] = [];
    for (const suffix of ['Alpha', 'Zeta']) {
      const created = await application.handle(
        new Request('https://kernel.test/v1/subjects', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${identity.ordinary.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify({ type: 'schema:Book', labels: { en: `Incarnationprobe ${suffix}` }, statements: {} }),
        }),
      );
      expect(created.status).toBe(201);
      ids.push((await created.json()).subject.id);
    }
    runner = await startSearchIndexing({
      pool: identity.database.pool,
      search: engine,
      prefix,
      source,
      listing: subjectListingSource(identity.database.pool),
      intervalMs: 20,
      discoverMs: 60_000,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const native = (await engine.request<Native>('POST', `/${index}/_search`, { size: 10 })).body;
      if (native.hits.hits.length === ids.length) {
        expect(native.hits.hits.map(({ _id }) => _id).sort()).toEqual([...ids].sort());
        break;
      }
      if (Date.now() >= deadline) throw new Error('Native incarnation fixture did not finish real Source indexing');
      await Bun.sleep(50);
    }
    await runner.pause();
    for (const id of ids) {
      const snapshot = await source.read(subjectPartition(id), [id]);
      expect(snapshot.subjects.map((subject) => subject.id)).toEqual([id]);
      expect(snapshot.position).toBeGreaterThan(0n);
    }
    const original = await physical();
    expect(await readSubjectSortFormat(engine, prefix, 1)).toBe(1);
    expect(original.mappings._meta).toMatchObject({ name_sort_format: 1 });
    const base: SearchRequest = { text: 'Incarnationprobe', sort: 'name', limit: 1 };
    const first = await request(base);
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.subjects).toHaveLength(1);
    expect(ids).toContain(page.subjects[0].id);
    expect(page.next).toBeString();
    const next = await request({ ...base, cursor: page.next });
    expect(next.status).toBe(200);
    const second = await next.json();
    expect(second.subjects).toHaveLength(1);
    expect(new Set([page.subjects[0].id, second.subjects[0].id])).toEqual(new Set(ids));
    expect(second.next).toBeNull();
    const emptyRequest: SearchRequest = { text: 'Absentincarnationprobe', sort: 'name', limit: 1 };
    const empty = await request(emptyRequest);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ subjects: [], next: null });
    // Prime one service with actual successful populated/empty reads and a supported native mapping, without sleeps.
    expect(await physical()).toEqual(original);
    calls.length = 0;
    if (boundary === 'after priming') await recreate();
    armed = true;
    const response = await request(continuation ? { ...base, cursor: page.next } : zero ? emptyRequest : base);
    const body = await response.json();
    const final = await physical();
    expect(replaced).toBe(true);
    expect(final.uuid).not.toBe(original.uuid);
    expect(final.generations).toEqual(original.generations);
    expect(final.mappings).toEqual(
      boundary === 'after priming'
        ? Object.fromEntries(Object.entries(original.mappings).filter(([key]) => key !== '_meta'))
        : original.mappings,
    );
    expect(await readSubjectSortFormat(engine, prefix, 1)).toBe(boundary === 'after priming' ? null : 1);
    const replacement = (await engine.request<Native>('POST', `/${index}/_search`, { size: 10 })).body;
    expect(replacement.hits.hits).toEqual([]);
    expect(replacement.hits.total.value).toBe(0);
    // This is real Source data still eligible for projection; zero replacement documents cannot certify readiness.
    for (const id of ids) expect((await source.read(subjectPartition(id), [id])).subjects).toHaveLength(1);
    expect(calls.filter(({ method }) => method === 'PUT' || method === 'DELETE')).toEqual([]);
    for (const observation of observations) {
      expect(digest(observation.body)).toBe(observation.hash);
      expect(observation.body.timed_out).toBe(false);
      expect(observation.body._shards.failed).toBe(0);
      expect(observation.body._shards.successful).toBe(observation.body._shards.total);
      expect(observation.uuid).toBe(boundary === 'after native observation' ? original.uuid : final.uuid);
      expect(observation.body.hits.hits.every((hit) => hit._index === index)).toBe(true);
      expect(observation.body.hits.hits).toHaveLength(
        boundary === 'after native observation' && !zero ? (continuation ? 1 : 2) : 0,
      );
    }
    console.info(
      JSON.stringify({
        boundary,
        zero,
        continuation,
        index,
        originalUUID: original.uuid,
        finalUUID: final.uuid,
        native: observations,
        status: response.status,
        problem: body,
      }),
    );
    // A changed incarnation invalidates admission, even when a fresh live mapping happens to look supported.
    // Readiness or restart is truthful; success, automatic retry/repin, and stamping a new epoch are not.
    if (boundary === 'after priming') expect(response.status).toBe(503);
    else expect([503, 409]).toContain(response.status);
    expect(body.code).toBe(response.status === 409 ? 'search_restart_required' : 'index_not_ready');
    if (response.status === 503) {
      expect(response.headers.get('retry-after')).toBe('1');
      expect(body.retryable).toBe(true);
    }
    for (const key of ['subjects', 'next', 'total', 'as_of', 'generation', 'epoch']) expect(body[key]).toBeUndefined();
    const queries = calls.filter(({ path }) => path.endsWith('/_search/template'));
    if (boundary !== 'after priming') {
      expect(observations).toHaveLength(1);
      expect(queries).toEqual([{ method: 'POST', path: `/${index}/_search/template` }]);
    } else expect(queries.length).toBeLessThanOrEqual(1);
  } finally {
    // Only this scenario's resources; cleanup remains required after substantive assertion failures.
    try {
      await runner?.stop();
    } finally {
      try {
        const state = await subjectGenerations(engine, prefix);
        for (const generation of state.generations)
          await engine.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
          await engine.request('DELETE', `/_scripts/${prefix}${template}`);
      } finally {
        await identities.close();
      }
    }
  }
}

for (const boundary of ['after priming', 'before native execution', 'after native observation'] as const) {
  for (const zero of [false, true]) {
    test(`readiness never authorizes a recreated physical index or an older immutable query observation: ${boundary}, ${zero ? 'zero hits' : 'matching subjects'}`, async () => {
      await scenario(boundary, zero);
    }, 180_000);
  }
}
for (const boundary of ['before native execution', 'after native observation'] as const) {
  test(`readiness never authorizes a recreated physical index or an older immutable query observation: ${boundary}, original cursor`, async () => {
    await scenario(boundary, false, true);
  }, 180_000);
}
