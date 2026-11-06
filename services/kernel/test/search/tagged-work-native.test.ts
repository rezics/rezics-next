import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createReleasedDiscoveryFixture,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import type { HttpResponse, Part, StatementInput } from '../../../../specs/semantic-driver.ts';

const marker = `taggednative${randomUUID().replaceAll('-', '')}`;

function quantity(property: string, amount: number): StatementInput {
  return discoveryStatement(property, { amount: `+${amount}`, unit: '1' });
}

function qualifier(property: string, content: StatementInput['value']['content']): Part {
  return { property: { id: property }, value: { type: 'value', content } };
}

function genre(concept: string, weight: number, metric = 'vndbTagsRating', spoiler = 0): StatementInput {
  return {
    ...discoveryStatement('schema:genre', concept),
    qualifiers: [
      qualifier('rezics:sourceTagWeight', { amount: `+${weight}`, unit: '1' }),
      qualifier('rezics:sourceTagWeightMetric', metric),
      qualifier('rezics:spoilerLevel', { amount: `+${spoiler}`, unit: '1' }),
    ],
  };
}

async function createBook(
  fixture: ReleasedDiscoveryFixture,
  name: string,
  concept: string,
  weight: number,
  options: { metric?: string; spoiler?: number; pages?: number } = {},
): Promise<CreatedSubject> {
  return fixture.createSubject('schema:Book', name, {
    'schema:genre': [genre(concept, weight, options.metric, options.spoiler)],
    'schema:wordCount': [quantity('schema:wordCount', 1_200_001)],
    'schema:numberOfPages': [quantity('schema:numberOfPages', options.pages ?? 120)],
  });
}

function ids(response: HttpResponse): string[] {
  if (!Array.isArray(response.body.hits))
    throw new Error(`Mixed Search omitted hits: ${JSON.stringify(response.body)}`);
  return (response.body.hits as { key: { id: string } }[]).map(({ key }) => key.id);
}

async function usefulPage(fixture: ReleasedDiscoveryFixture, body: Record<string, unknown>): Promise<HttpResponse> {
  const deadline = Date.now() + 180_000;
  let last: HttpResponse | undefined;
  do {
    last = await fixture.request('anonymous', 'POST', '/v1/subjects:search', body);
    if (last.status === 200) return last;
    expect(last.status, JSON.stringify(last.body)).toBe(503);
    expect(['index_not_ready', 'semantic_not_ready']).toContain(String(last.body.code));
    expect(last.headers.get('retry-after')).toBeTruthy();
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`Tagged native preparation did not finish: ${JSON.stringify(last?.body)}`);
}

test('released tagged discovery agrees across native direct and resumed prepared traversal, then retires the old generation', async () => {
  const fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  try {
    if (!fixture.search) throw new Error('The released discovery fixture must own its native Search runtime');
    await fixture.setup.openFeatures(['search', 'search_advanced']);
    const scheme = await fixture.createSubject('skos:ConceptScheme', `${marker} scheme`);
    const tagA = await fixture.createSubject('skos:Concept', `${marker} tag A`);
    const tagB = await fixture.createSubject('skos:Concept', `${marker} tag B`);
    const child = await fixture.createSubject('skos:Concept', `${marker} child`);
    await fixture.adopt(tagA, discoveryStatement('skos:inScheme', scheme.id));
    await fixture.adopt(tagB, discoveryStatement('skos:inScheme', scheme.id));
    await fixture.adopt(child, discoveryStatement('skos:inScheme', scheme.id));
    await fixture.adopt(child, discoveryStatement('skos:broader', tagA.id));

    // UUIDv7 IDs follow creation order. These broad native candidates fail only the
    // same-statement weight/metric/spoiler proof, so id order exhausts its direct budget.
    const decoys: CreatedSubject[] = [];
    for (let index = 0; index < 105; index++) {
      decoys.push(await createBook(fixture, `${marker} z-decoy-${String(index).padStart(2, '0')}`, tagA.id, 1));
    }
    const exactA = await createBook(fixture, `${marker} a-exact`, tagA.id, 3);
    const exactB = await createBook(fixture, `${marker} b-alternative`, tagB.id, 3, { spoiler: 1 });
    const excluded = await createBook(fixture, `${marker} c-excluded`, tagA.id, 3, { pages: 600 });
    const wrongSpoiler = await createBook(fixture, `${marker} d-spoiler`, tagA.id, 3, { spoiler: 2 });
    const descendant = await createBook(fixture, `${marker} e-descendant`, child.id, 3);
    await fixture.catchUp([scheme, tagA, tagB, child, ...decoys, exactA, exactB, excluded, wrongSpoiler, descendant]);

    const sameStatement = {
      property: 'schema:genre',
      in: [tagA.id],
      concept: { scheme: scheme.id },
      qualifiers: [
        { property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } },
        { property: 'rezics:sourceTagWeightMetric', in: ['vndbTagsRating'] },
        { property: 'rezics:spoilerLevel', range: { lte: 1, unit: '1' } },
      ],
    };
    const alternatives = {
      and: [
        { kind: { in: ['schema:Book'] } },
        {
          or: [
            sameStatement,
            {
              ...sameStatement,
              in: [tagB.id],
            },
          ],
        },
        { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' } } },
        { not: { statement: { property: 'schema:numberOfPages', range: { gte: 500, unit: '1' } } } },
      ],
    };
    const idRequest = {
      representation: 'discovery-v1',
      text: marker,
      filter: alternatives,
      kindCountLeaf: 0,
      sort: 'id',
      limit: 1,
    };

    const firstDirect = await fixture.request('anonymous', 'POST', '/v1/subjects:search', idRequest);
    expect(firstDirect.status).toBe(503);
    expect(firstDirect.body.code).toBe('index_not_ready');
    expect(firstDirect.headers.get('retry-after')).toBeTruthy();
    const targetPattern = `${fixture.search.indexPrefix}discovery-g%`;
    const progress = await fixture.inspect<{ consumer_work: string }>(
      `SELECT consumer_work FROM search.public_filter_registration
       WHERE physical_target LIKE $1 AND consumer_work IS NOT NULL LIMIT 1`,
      [targetPattern],
    );
    expect(progress.rows).toHaveLength(1);
    expect(progress.rows[0]!.consumer_work).toContain(decoys[99]!.id);
    const preparedFirst = await usefulPage(fixture, idRequest);
    expect(ids(preparedFirst)).toHaveLength(1);
    expect(preparedFirst.body.next).toEqual(expect.any(String));
    expect(preparedFirst.body).not.toHaveProperty('total');
    expect(preparedFirst.body).not.toHaveProperty('facets');
    expect(ids(preparedFirst)).not.toContain(decoys[0]!.id);
    const preparedSecond = await usefulPage(fixture, { ...idRequest, cursor: preparedFirst.body.next });
    const preparedIds = [...ids(preparedFirst), ...ids(preparedSecond)];
    expect(preparedIds).toEqual([exactA.id, exactB.id].sort());
    expect(preparedSecond.body.next).toBeNull();
    expect(preparedIds).not.toContain(excluded.id);
    expect(preparedIds).not.toContain(wrongSpoiler.id);
    const retained = await fixture.inspect<{ rows: string; state: string }>(
      `SELECT p.rows,p.state FROM search.public_filter_prepared p
       JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(p.partition_no,p.registration)
       WHERE r.physical_target LIKE $1 AND p.rows LIKE '%' || $2 || '%' LIMIT 1`,
      [targetPattern, exactA.id],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]!.state).toBe('active');
    expect(decoys.filter(({ id }) => retained.rows[0]!.rows.includes(id)).length).toBeGreaterThanOrEqual(100);

    const nameRequest = { ...idRequest, sort: 'name' };
    const directFirst = await usefulPage(fixture, nameRequest);
    expect(ids(directFirst)).toEqual([exactA.id]);
    expect(directFirst.body.next).toEqual(expect.any(String));
    const directSecond = await usefulPage(fixture, { ...nameRequest, cursor: directFirst.body.next });
    expect([...ids(directFirst), ...ids(directSecond)]).toEqual([exactA.id, exactB.id]);
    expect(directSecond.body.next).toBeNull();

    const descendantRequest = {
      ...nameRequest,
      filter: {
        and: [
          { kind: { in: ['schema:Book'] } },
          {
            statement: {
              ...sameStatement,
              in: [tagA.id],
              concept: { scheme: scheme.id, includeChildren: true },
            },
          },
        ],
      },
    };
    const descendantPage = await usefulPage(fixture, { ...descendantRequest, limit: 10 });
    expect(ids(descendantPage).sort()).toEqual([exactA.id, excluded.id, descendant.id].sort());
    expect(descendantPage.body.next).toBeNull();
    expect(ids(descendantPage)).not.toContain(exactB.id);
    expect(ids(descendantPage)).not.toContain(wrongSpoiler.id);

    await fixture.search.rebuild();
    const retired = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
      ...idRequest,
      cursor: preparedFirst.body.next,
    });
    expect(retired.status).toBe(409);
    expect(retired.body.code).toBe('search_restart_required');
    const fresh = await usefulPage(fixture, idRequest);
    const recovered = ids(fresh);
    const recoveredId = recovered[0];
    if (recovered.length !== 1 || recoveredId === undefined)
      throw new Error(`Recovered tagged-work page omitted its hit: ${JSON.stringify(fresh.body)}`);
    expect([exactA.id, exactB.id]).toContain(recoveredId);
  } finally {
    await fixture.close();
  }
}, 900_000);
