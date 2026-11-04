import { expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import readSummaries from '../../src/semantic/summaries-read.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createReleasedDiscoveryFixture, discoveryKey } from '../support/released-discovery.ts';
import { createReleasedLibraryPopulation } from './support/released-library-population.ts';
import { continuePageSchema } from '../../src/library/transport-contract.ts';

type ContinuePage = Static<typeof continuePageSchema>;

function queryText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string')
    return value.text;
  return null;
}

function observePool(connectionString: string, statements: string[]): Pool {
  const pool = new Pool({ connectionString });
  const observeClient = (client: PoolClient) =>
    new Proxy(client, {
      get(target, property) {
        if (property === 'query')
          return (...args: unknown[]) => {
            const text = queryText(args[0]);
            if (text !== null) statements.push(text);
            return (target.query as (...queryArgs: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return (...args: unknown[]) => {
          const text = queryText(args[0]);
          if (text !== null) statements.push(text);
          return (target.query as (...queryArgs: unknown[]) => unknown).apply(target, args);
        };
      if (property === 'connect')
        return (...args: unknown[]) =>
          (target.connect as (...connectArgs: unknown[]) => Promise<PoolClient>)
            .apply(target, args)
            .then(observeClient);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
}

function status(response: HttpResponse, expected: number, code?: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  if (code !== undefined) expect((response.body as Record<string, unknown>).code).toBe(code);
}
function page(response: HttpResponse): ContinuePage {
  expect(Value.Check(continuePageSchema, response.body)).toBe(true);
  return response.body as ContinuePage;
}

test('Continue FULL preserves the unavailable result when the current native Source is absent', async () => {
  const world = await createReleasedLibraryPopulation();
  try {
    await world.state();
    await world.sessions();
    const everything = builtinCollectionId(world.base.personas.alice.accountId, { kind: 'everything' });
    await world.base.inspect('DELETE FROM library.canonical_source_head WHERE collection_id=$1', [everything]);

    const response = await world.request('alice', 'GET', '/v1/libraryContinue?view=FULL');
    expect(response.status).toBe(503);
    expect(['dependency_unavailable', 'semantic_not_ready']).toContain(
      String((response.body as Record<string, unknown>).code),
    );
    expect(response.body).not.toHaveProperty('subjects');
    expect(response.body).not.toHaveProperty('next');
  } finally {
    await world.close();
  }
}, 180_000);

test('Continue FULL adds current bounded subject summaries while BASIC and view-independent cursors stay unchanged', async () => {
  const statements: string[] = [];
  const f = await createReleasedDiscoveryFixture({
    version: 1,
    kernelPool: (url) => observePool(url, statements),
  });
  try {
    const type = 'schema:Book';
    const profileId = f.release.definition.types[type]!.library!.profileId;
    const active = f.release.definition.libraryProfiles![profileId]!.entryStateSet!.states.find(
      (candidate) => candidate.role === 'active',
    )!.id;
    for (const name of ['Continue FULL first', 'Continue FULL second']) {
      const subject = await f.createSubject(type, name);
      const saved = await f.request(
        'alice',
        'PUT',
        `/v1/libraryEntries/${subject.id}`,
        { state: active },
        discoveryKey(),
      );
      status(saved, 201);
    }

    const request = (suffix = '', headers: Record<string, string> = {}) =>
      f.request('alice', 'GET', `/v1/libraryContinue?limit=1${suffix}`, undefined, headers);
    const basic = await request();
    status(basic, 200);
    const basicPage = page(basic);
    expect(Object.keys(basic.body).sort()).toEqual(['next', 'subjects']);
    expect(Object.keys(basicPage.subjects[0]!).sort()).toEqual([
      'activeProgressSession',
      'lastActivityAt',
      'state',
      'subjectId',
    ]);
    expect(basic.headers.get('cache-control')).toContain('private');
    expect(basic.headers.get('cache-control')).toContain('no-store');

    const explicitlyBasic = await request('&view=BASIC');
    status(explicitlyBasic, 200);
    const explicitlyBasicPage = page(explicitlyBasic);
    expect(explicitlyBasicPage.subjects).toEqual(basicPage.subjects);
    expect(explicitlyBasicPage.subjects[0]).not.toHaveProperty('subject');

    statements.length = 0;
    const full = await request('&view=FULL', { 'accept-language': 'en' });
    status(full, 200);
    const fullPage = page(full);
    const first = fullPage.subjects[0]!;
    const firstSummary = first.subject!;
    expect(firstSummary.id).toBe(first.subjectId);
    expect(firstSummary.type).toBe(type);
    expect(firstSummary.label?.value).toContain('Continue FULL');
    expect(Object.keys(firstSummary).sort()).toEqual(['cover', 'creativeWork', 'id', 'label', 'type', 'types']);
    expect(full.headers.get('cache-control')).toContain('private');
    expect(full.headers.get('cache-control')).toContain('no-store');
    expect(statements.filter((statement) => statement === readSummaries.sql)).toHaveLength(
      new Set([partitionOf(routeOf(first.subjectId)!)]).size,
    );

    const next = basicPage.next;
    if (typeof next !== 'string') throw new Error('Two active subjects require a next cursor at limit 1');
    statements.length = 0;
    const secondPage = await request(`&view=FULL&cursor=${encodeURIComponent(next)}`);
    status(secondPage, 200);
    const resumed = page(secondPage);
    expect(resumed.subjects).toHaveLength(1);
    expect(resumed.subjects[0]!.subject!.id).toBe(resumed.subjects[0]!.subjectId);
    expect(resumed.subjects[0]!.subjectId).not.toBe(first.subjectId);

    const secondHomes = new Set(resumed.subjects.map((row) => partitionOf(routeOf(row.subjectId)!)));
    expect(statements.filter((statement) => statement === readSummaries.sql)).toHaveLength(secondHomes.size);

    for (const suffix of ['&view=COMPACT', '&accountId=anything', '&orderBy=subject']) {
      const invalid = await request(suffix);
      status(invalid, 400, 'invalid_request');
    }
    const invalidCursor = await request('&view=FULL&cursor=not-a-cursor');
    status(invalidCursor, 400, 'invalid_cursor');
  } finally {
    await f.close();
  }
}, 180_000);
