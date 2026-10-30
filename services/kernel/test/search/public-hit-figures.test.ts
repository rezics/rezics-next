import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { routeOf } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { capture } from '../support/growth-capture.ts';
import { withoutCatalogStatements } from '../support/growth.ts';
import { createFigureFixture } from '../rating/support/figure-fixture.ts';

test('public Search hit figures equal the native subject figure and exclude private Realm populations and individual votes', async () => {
  if (!process.env.OPENSEARCH_URL) throw new Error('OPENSEARCH_URL must name the check node');
  const fixture = await createFigureFixture({ subjects: 4, partitions: 3, deferMembership: true });
  const client = createOpenSearch(process.env.OPENSEARCH_URL);
  const prefix = `test-hit-figure-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  let indexed = false;
  try {
    const { system } = communityFixtureRuntime();
    const source = subjectSource(fixture.database.pool, system.routeKey);
    await createSubjectIndex(client, prefix, 1);
    indexed = true;
    const partitions = new Map<number, string[]>();
    for (const id of fixture.subjectIds) {
      const partition = subjectPartition(id);
      partitions.set(partition, [...(partitions.get(partition) ?? []), id]);
    }
    expect(partitions.size).toBe(3);
    for (const [partition, ids] of partitions) {
      const snapshot = await source.read(partition, ids);
      await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
    }
    await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    const app = createKernel({
      pool: fixture.database.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      access: system.access,
      search: createSearchService({
        pool: fixture.database.pool,
        client,
        prefix,
        source,
        cursors: system.tokenKeys,
      }),
    });
    const search = async (sort: 'name' | 'id' | 'relevance') => {
      const { value: response } = await capture(
        fixture.database,
        () =>
          app.handle(
            new Request('https://content.test/v1/subjects:search', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'Figure subject', sort, limit: 100 }),
            }),
          ),
        { includeBackends: true },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { subjects: { id: string; figure?: unknown }[] };
      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('indexed_estimate');
      expect(body.subjects.map((hit) => hit.id).sort()).toEqual([...fixture.subjectIds].sort());
      for (const hit of body.subjects) expect(hit.figure).toEqual((await fixture.figure(hit.id)).figure);
      return body;
    };

    // Missing published rows must use the owner's insufficient-data view, rather than omit the field.
    await search('name');
    const target = fixture.subjectIds[0]!;
    const subjectBefore = await fixture.request(`/v1/subjects/${target}`);
    expect(subjectBefore.status).toBe(200);
    const subjectBody = await subjectBefore.json();
    for (const voter of fixture.realmMembers) await fixture.vote(target, voter, 20);
    for (const voter of fixture.globalVoters) await fixture.vote(target, voter, 0);
    await fixture.published(target, 10);
    const baseline = (await fixture.figure(target)).figure;
    expect(baseline).toMatchObject({ state: 'ready', count: 10, mean: 5 });
    await fixture.joinMembers();
    for (const voter of fixture.realmMembers) await fixture.vote(target, voter, 0);
    for (const voter of fixture.globalVoters) await fixture.vote(target, voter, 20);
    expect((await fixture.published(target, 5, fixture.realmId)).mean).toBe(0);
    await fixture.published(target, 10);
    expect((await fixture.request(`/v1/realms/${fixture.realmId}`)).status).toBe(404);
    for (const sort of ['name', 'id', 'relevance'] as const) {
      const body = await search(sort);
      expect(body.subjects.find((hit) => hit.id === target)?.figure).toMatchObject({ count: 10, mean: 5 });
      const text = JSON.stringify(body);
      for (const secret of [
        fixture.realmId,
        ...fixture.realmMembers.map((voter) => voter.id),
        ...fixture.globalVoters.map((voter) => voter.id),
        'voterId',
        'units',
        'histogram',
        'vote',
      ])
        expect(text).not.toContain(secret);
    }
    const subjectAfter = await fixture.request(`/v1/subjects/${target}`);
    expect(subjectAfter.headers.get('etag')).toBe(subjectBefore.headers.get('etag'));
    expect(await subjectAfter.json()).toEqual(subjectBody);
  } finally {
    try {
      if (indexed) await client.request('DELETE', `/${index}`);
      for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
        await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
    } finally {
      await fixture.close();
    }
  }
}, 240_000);

test('kept Search pages batch native missing, below-threshold, prior-ready and pending figures across homes', async () => {
  const fixture = await createFigureFixture({ subjects: 7, partitions: 3, deferMembership: true });
  const { system } = communityFixtureRuntime();
  const source = subjectSource(fixture.database.pool, system.routeKey);
  const client = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `test-hit-batch-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const batches: string[][] = [];
  let held = 0;
  let indexed = false;
  const projectionBackends = new Set<number>();
  // Observe the actual owner SQL on the service's owned connection, without replacing its reader or state rules.
  const pool = Object.create(system.database.pool) as Pool;
  pool.query = fixture.database.pool.query.bind(fixture.database.pool);
  pool.connect = (async () => {
    const connection = await fixture.database.pool.connect();
    const backend = (connection as PoolClient & { readonly processID?: number }).processID;
    if (backend !== undefined) projectionBackends.add(backend);
    const observed = Object.create(connection) as PoolClient;
    held++;
    observed.query = ((query: string | QueryConfig, values?: unknown[]) => {
      const text = typeof query === 'string' ? query : query.text;
      if (text.includes('FROM rating.public_figure')) {
        const parameters = typeof query === 'string' ? values : query.values;
        const keys = parameters?.find((value) => typeof value === 'string' && value.startsWith('[{'));
        batches.push((JSON.parse(keys as string) as { subject_id: string }[]).map((key) => key.subject_id));
      }
      return connection.query(query, values);
    }) as PoolClient['query'];
    observed.release = (error) => {
      held--;
      connection.release(error);
    };
    return observed;
  }) as Pool['connect'];
  const engine = {
    ...client,
    request: ((...args: Parameters<typeof client.request>) => {
      expect(held).toBe(0);
      return client.request(...args);
    }) as typeof client.request,
  };
  try {
    await createSubjectIndex(client, prefix, 1);
    indexed = true;
    const partitions = new Map<number, string[]>();
    for (const id of fixture.subjectIds)
      partitions.set(subjectPartition(id), [...(partitions.get(subjectPartition(id)) ?? []), id]);
    expect(partitions.size).toBe(3);
    expect([...partitions.values()].some((ids) => ids.length > 1)).toBe(true);
    for (const [partition, ids] of partitions)
      await client.bulk(bulkLines(index, documentActions(await source.read(partition, ids), ids)), {
        query: { refresh: 'wait_for' },
      });
    await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    const app = createKernel({
      pool: fixture.database.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      access: system.access,
      search: createSearchService({
        pool,
        client: engine,
        prefix,
        source,
        ratings: createPublicRatingSource(fixture.database.pool),
        cursors: system.tokenKeys,
      }),
    });
    const search = async (limit: number, sort: 'id' | 'collections' | 'rating' = 'id') => {
      batches.length = 0;
      projectionBackends.clear();
      const { value: response, capture: raw } = await capture(
        fixture.database,
        () =>
          app.handle(
            new Request('https://content.test/v1/subjects:search', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'Figure subject', sort, limit }),
            }),
          ),
        { includeBackends: true },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(['as_of', 'next', 'subjects']);
      expect(body.subjects).toHaveLength(limit);
      expect(batches).toEqual([body.subjects.map((hit: { id: string }) => hit.id)]);
      expect(projectionBackends.size).toBe(1);
      const projectionBackend = [...projectionBackends][0]!;
      const backendIndexes = raw.statementBackends!.flatMap((backend, index) =>
        backend === projectionBackend ? [index] : [],
      );
      const beginPosition = backendIndexes.findIndex(
        (index) => raw.statements[index] === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      expect(beginPosition).toBeGreaterThanOrEqual(0);
      const commitPosition = backendIndexes.findIndex(
        (index, position) => position > beginPosition && raw.statements[index] === 'COMMIT',
      );
      expect(commitPosition).toBeGreaterThan(beginPosition);
      const statementIndexes = backendIndexes.slice(beginPosition, commitPosition + 1);
      const selectedStatements = new Set(statementIndexes);
      const planIndexes = raw.planStatements!.flatMap((statement, index) =>
        statement !== undefined && selectedStatements.has(statement) ? [index] : [],
      );
      const projection = withoutCatalogStatements('Search public figure projection', {
        statements: statementIndexes.map((index) => raw.statements[index]!),
        requestBytes: statementIndexes.map((index) => raw.requestBytes![index]!),
        responseBytes: statementIndexes.map((index) => raw.responseBytes![index]!),
        statementErrors: statementIndexes.map((index) => raw.statementErrors![index]!),
        statementErrorMessages: statementIndexes.map((index) => raw.statementErrorMessages![index]!),
        statementBackends: statementIndexes.map(() => projectionBackend),
        plans: planIndexes.map((index) => raw.plans[index]!),
        planStatements: planIndexes.map((index) => {
          const statementIndex = raw.planStatements![index];
          return statementIndex === undefined ? undefined : statementIndexes.indexOf(statementIndex);
        }),
        planBackends: planIndexes.map(() => projectionBackend),
      });
      if (projection.statements.length !== 5)
        throw new Error(`Search public figure projection exceeded five statements: ${JSON.stringify(projection)}`);
      expect(projection.statements).toHaveLength(5); // BEGIN, timeout, question, keyed figures/pending, COMMIT.
      expect(projection.statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      expect(projection.statements.at(-1)).toBe('COMMIT');
      expect(projection.statements.filter((text) => text.includes('FROM rating.question'))).toHaveLength(1);
      expect(projection.statements.filter((text) => text.includes('FROM rating.public_figure'))).toHaveLength(1);
      expect(held).toBe(0);
      for (const hit of body.subjects) expect(hit.figure).toEqual((await fixture.figure(hit.id)).figure);
      return body;
    };
    for (const limit of [1, 2, 7]) await search(limit);
    await search(7, 'collections');
    await search(7, 'rating');
    const voters = [...fixture.realmMembers, ...fixture.globalVoters];
    // Fifty real votes establish the owner's Global prior, without writing figure or prior rows.
    for (const id of fixture.subjectIds.slice(0, 5)) {
      for (const voter of voters) await fixture.vote(id, voter, 10);
      await fixture.published(id, 10);
    }
    const ready = fixture.subjectIds[0]!;
    const below = fixture.subjectIds[5]!;
    const missing = fixture.subjectIds[6]!;
    await fixture.vote(below, voters[0]!, 10);
    await fixture.published(below, 1);
    const before = (await fixture.figure(ready)).figure;
    expect(before).toMatchObject({ state: 'ready', count: 10, mean: 5 });
    expect(before.score).not.toBeNull();
    expect((await fixture.figure(below)).figure).toMatchObject({
      state: 'insufficient_data',
      count: 1,
      mean: null,
      score: null,
    });
    expect((await fixture.figure(missing)).figure).toMatchObject({
      state: 'insufficient_data',
      count: 0,
      mean: null,
      score: null,
    });
    await search(7);
    // Block only publication; native aggregate applies still commit their pending marks.
    await fixture.database.admin
      .query(`CREATE FUNCTION public.hold_search_figure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtext(NEW.subject_id::text), 81); RETURN NEW; END $$;
      CREATE TRIGGER hold_search_figure BEFORE UPDATE ON rating.public_figure
      FOR EACH ROW WHEN (OLD.pending_position IS NOT NULL AND NEW.pending_position IS NULL)
      EXECUTE FUNCTION public.hold_search_figure()`);
    const lock = await fixture.database.admin.connect();
    await lock.query('BEGIN');
    try {
      for (const id of [ready, below]) await lock.query('SELECT pg_advisory_xact_lock(hashtext($1), 81)', [id]);
      await fixture.vote(ready, voters[0]!, 0);
      await fixture.vote(below, voters[1]!, 20);
      const deadline = Date.now() + 60_000;
      for (;;) {
        const pending = await fixture.database.admin.query(
          `SELECT subject_id FROM rating.public_figure WHERE (route, subject_id) IN (($1, $2), ($3, $4))
           AND question_id = $5 AND population_id = $6 AND pending_position IS NOT NULL`,
          [routeOf(ready), ready, routeOf(below), below, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
        );
        if (pending.rowCount === 2) break;
        if (Date.now() >= deadline) throw new Error('Native Search figures did not become pending');
        await Bun.sleep(20);
      }
      expect((await fixture.figure(ready)).figure).toEqual(before);
      expect((await fixture.figure(below)).figure).toMatchObject({
        state: 'updating',
        count: 1,
        mean: null,
        score: null,
      });
      await search(7);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    await fixture.published(below, 2);
    const schema =
      openApiDocument(app).paths['/v1/subjects:search']?.post?.responses?.['200']?.content?.['application/json']
        ?.schema;
    expect(schema).toMatchObject({
      properties: {
        subjects: {
          items: {
            properties: { figure: { $ref: '#/components/schemas/PublicFigure' } },
            required: expect.arrayContaining(['figure']),
          },
        },
      },
    });
  } finally {
    try {
      if (indexed) await client.request('DELETE', `/${index}`);
      for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
        await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
    } finally {
      await fixture.close();
    }
  }
}, 300_000);
