import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { FilterRelease } from '@rezics/filter';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch, type SearchQuery } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type SubjectSource } from '../../src/search/source.ts';
import type { AccountActor } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');

const hotPartition = 2048;
const prefix = `facets-growth-${randomUUID().slice(0, 8)}`;
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(31)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000054',
  clientId: 'growth',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const release: FilterRelease = {
  types: { 'schema:Book': { bases: [], facets: ['schema:author'] }, 'schema:Person': { bases: [], facets: [] } },
  properties: {
    'schema:author': { datatype: 'wikibase-item', qualifiers: [] },
    'schema:inLanguage': { datatype: 'string' },
  },
};
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const digest = (value: string) => createHash('sha256').update(value).digest();

type Probe = { aggregations: number; reads: { partition: number; ids: string[] }[] };
let db: GrowthDatabase | undefined;
let engine: OpenSearch | undefined;
let observedEngine: OpenSearch | undefined;
let source: SubjectSource | undefined;
let service: ReturnType<typeof createSearchService> | undefined;
let kernel: ReturnType<typeof createKernel> | undefined;
let probe: Probe | undefined;
let authorIds: string[] = [];

async function addSubject(route: number, item: unknown): Promise<string> {
  if (!db) throw new Error('Growth database is not open');
  const target = { route, id: newId(route) };
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: digest(target.id),
    item,
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return target.id;
}

async function appendExpandedAuthor(subjectId: string, valueId: string): Promise<void> {
  if (!db) throw new Error('Growth database is not open');
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Expected a routed author');
  const slot = newId(route);
  const candidate = newId(route);
  const transactionId = randomUUID();
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO semantic.fact
         (route, subject_id, slot_id, log_seq, operation, kind, language, property, statement_id, body,
          recorded_transaction_id, release)
       VALUES ($1, $2, $3, 33, 'expand', 'statement', NULL, 'schema:author', NULL, '{}'::jsonb, $4, NULL)`,
      [route, subjectId, slot, transactionId],
    );
    await client.query(
      `INSERT INTO semantic.candidate
         (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin, view_order)
       VALUES ($1, $2, $3, $4, 'schema:author', 'normal', $5::jsonb, $6, 1, 'proposal', 0)`,
      [
        route,
        subjectId,
        candidate,
        slot,
        JSON.stringify({ value: { type: 'value', content: valueId }, qualifiers: [], references: [] }),
        bundledDigest,
      ],
    );
    await client.query(
      `INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
       VALUES ($1, $2, $3, $4, 1, 'replace', $5::jsonb, 1)`,
      [route, subjectId, slot, GLOBAL_CONTEXT, JSON.stringify([{ candidate, rank: 'normal' }])],
    );
    await client.query(
      'UPDATE semantic.subject SET current_facts = current_facts + 1 WHERE route = $1 AND subject_id = $2',
      [route, subjectId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function unrelatedPopulation(name: string): Population {
  let current: Population;
  current = {
    name,
    hotPartition,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const slot = newId(route);
      const candidate = newId(route);
      const concealed = newId(route);
      const transactionId = randomUUID();
      const releaseDigest = `sha256:${createHash('sha256').update(`facet-release-${ordinal}`).digest('hex')}`;
      const term = itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } })[0]!;
      const body = { value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] };
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 2,
            current_release: bundledDigest,
          },
        ],
        'semantic.fact': [
          { ...term, route, subject_id: id, recorded_transaction_id: transactionId, release: null },
          {
            route,
            subject_id: id,
            slot_id: slot,
            log_seq: 1,
            operation: 'assert',
            kind: 'statement',
            language: null,
            property: 'schema:inLanguage',
            statement_id: candidate,
            body: { ...body, rank: 'normal' },
            recorded_transaction_id: transactionId,
            release: bundledDigest,
          },
        ],
        'semantic.redirect': [
          {
            route,
            subject_id: id,
            sequence: 1,
            target: '00000000-0000-0000-0000-000000000000',
            recorded_transaction_id: transactionId,
          },
          {
            route,
            subject_id: id,
            sequence: 2,
            target: '00000000-0000-0000-0000-000000000000',
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: id,
            candidate_id: candidate,
            slot_id: slot,
            property: 'schema:inLanguage',
            rank: 'normal',
            statement: body,
            release: bundledDigest,
            revision: 1,
            origin: 'proposal',
            view_order: 0,
          },
        ],
        'semantic.adoption': [
          {
            route,
            subject_id: id,
            slot_id: slot,
            context_id: GLOBAL_CONTEXT,
            head: 1,
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            revision: 1,
          },
          {
            route,
            subject_id: id,
            slot_id: slot,
            context_id: GLOBAL_CONTEXT,
            head: 2,
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            revision: 2,
          },
        ],
        'semantic.hidden_candidate': [
          { route, subject_id: id, candidate_id: concealed, visibility: 'hidden', security_revision: 1 },
        ],
        'semantic.definition_release': [
          {
            route: 0,
            digest: releaseDigest,
            body: { types: {}, properties: {} },
            recorded_transaction_id: transactionId,
          },
        ],
      };
    },
    finish: async (admin, range) => {
      const counts = new Map<number, number>();
      for (let ordinal = range.from; ordinal < range.to; ordinal++) {
        const partition = placement(current, ordinal).partition;
        counts.set(partition, (counts.get(partition) ?? 0) + 1);
      }
      for (const [partition, visible] of counts) {
        await admin.query(
          `INSERT INTO semantic.partition_subjects (partition_no, visible) VALUES ($1, $2)
           ON CONFLICT (partition_no) DO UPDATE SET visible = semantic.partition_subjects.visible + EXCLUDED.visible`,
          [partition, visible],
        );
      }
    },
  };
  return current;
}

async function growPopulation(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await seed({ pool: database.pool, admin: database.admin }, unrelatedPopulation('facet-counts-growth'), {
    from: previous * 1_000,
    to: scale * 1_000,
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl!);
  engine = createOpenSearch(searchUrl!);
  const productionSource = subjectSource(db.pool);
  source = {
    async read(partition, ids) {
      probe?.reads.push({ partition, ids: [...ids] });
      return productionSource.read(partition, ids);
    },
    count: (partition) => productionSource.count(partition),
  };
  observedEngine = {
    request<T = unknown>(
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      path: string,
      body?: unknown,
      options?: { query?: SearchQuery; timeoutMs?: number },
    ) {
      if (
        probe &&
        method === 'POST' &&
        path.endsWith('/_search/template') &&
        typeof body === 'object' &&
        body !== null &&
        'id' in body &&
        body.id === `${prefix}${FACET_TEMPLATE}`
      )
        probe.aggregations++;
      return engine!.request<T>(method, path, body, options);
    },
    bulk: (lines, options) => engine!.bulk(lines, options),
  };
  await bootstrapRelease(db.pool, bundledRelease);

  const route = hotPartition * 16;
  const authorA = await addSubject(route + 1, { type: 'schema:Person', labels: { en: 'Author A' } });
  const authorB = await addSubject(route + 2, { type: 'schema:Person', labels: { en: 'Author B' } });
  authorIds = [authorA, authorB];
  await appendExpandedAuthor(authorA, authorB);
  await appendExpandedAuthor(authorB, authorA);

  const books = [
    await addSubject(route + 3, {
      type: 'schema:Book',
      labels: { en: 'Book one' },
      statements: { 'schema:author': [statement('schema:author', authorA)] },
    }),
    await addSubject(route + 4, {
      type: 'schema:Book',
      labels: { en: 'Book two' },
      statements: {
        'schema:author': [statement('schema:author', authorA), statement('schema:author', authorB)],
      },
    }),
    await addSubject(route + 5, {
      type: 'schema:Book',
      labels: { en: 'Book three' },
      statements: { 'schema:author': [statement('schema:author', authorA)] },
    }),
    await addSubject(route + 6, {
      type: 'schema:Book',
      labels: { en: 'Book four' },
      statements: { 'schema:author': [statement('schema:author', authorB)] },
    }),
  ];

  await createSubjectIndex(engine, prefix, 1);
  const byPartition = new Map<number, string[]>();
  for (const id of [...authorIds, ...books]) {
    const partition = subjectPartition(id);
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), id]);
  }
  for (const [partition, ids] of byPartition) {
    const snapshot = await productionSource.read(partition, ids);
    await engine.bulk(bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, ids)), {
      query: { refresh: 'wait_for' },
    });
  }
  await engine.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });

  service = createSearchService({
    pool: db.pool,
    client: observedEngine,
    prefix,
    source,
    cursors,
    release: async () => release,
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(32),
    search: service,
    access: {
      async authenticate() {
        throw new Error('The anonymous facets request must not authenticate');
      },
      async authorize() {
        return true;
      },
    },
  });
});

afterAll(async () => {
  if (engine) {
    const { generations } = await subjectGenerations(engine, prefix).catch(() => ({ generations: [] }));
    for (const generation of generations) await engine.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
  await db?.close();
});

test('Facet counts stays within its bound as N grows', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  const selectedPartitions = new Set(authorIds.map(subjectPartition));
  const report = await checkGrowth(db, {
    name: 'Facet counts stays within its bound as N grows',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: growPopulation,
    operation: async () => {
      probe = { aggregations: 0, reads: [] };
      try {
        const response = await kernel!.handle(
          new Request('http://kernel.test/v1/subjects:facets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              filter: { type: { in: ['schema:Book'] } },
              facets: [{ property: 'schema:author' }],
            }),
          }),
        );
        expect(response.status).toBe(200);
        const answer = (await response.json()) as {
          total: { value: number; relation: string };
          facets: { property: string; values: { value: string; count: number; labels: Record<string, string> }[] }[];
        };
        expect(answer.total).toEqual({ value: 4, relation: 'exact' });
        expect(answer.facets).toEqual([
          {
            property: 'schema:author',
            relation: 'exact',
            values: [
              { value: authorIds[0]!, count: 3, labels: { en: 'Author A' } },
              { value: authorIds[1]!, count: 2, labels: { en: 'Author B' } },
            ],
          },
        ]);
        expect(probe.aggregations).toBe(1);
        expect(probe.reads.map(({ partition }) => partition).sort((a, b) => a - b)).toEqual(
          [...selectedPartitions].sort((a, b) => a - b),
        );
        const ids = probe.reads.flatMap(({ ids: readIds }) => readIds);
        expect(new Set(ids).size).toBeLessThanOrEqual(320);
        expect(new Set(ids)).toEqual(new Set(authorIds));
      } finally {
        probe = undefined;
      }
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    const scans = Object.entries(sample.cost.relations ?? {}).filter(
      ([relation, cost]) => relation.startsWith('semantic.') && (cost.sequentialScans ?? 0) > 0,
    );
    expect(scans).toEqual([]);
  }
}, 90_000);
