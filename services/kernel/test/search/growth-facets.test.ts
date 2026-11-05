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
import { measurePublicFilterIteratorSteps } from '../../src/search/public-filter-consumer.ts';
import { FACET_TEMPLATE, HIT_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
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
const unit = 500;
// The relations unrelatedPopulation seeds, in the order it inserts them.
const seededRelations = [
  'semantic.subject',
  'semantic.revision',
  'semantic.fact',
  'semantic.redirect',
  'semantic.candidate',
  'semantic.adoption',
  'semantic.hidden_candidate',
  'semantic.outbound_link',
  'semantic.definition_release',
  'semantic.definition_activation',
] as const;
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
  types: { 'schema:Book': { bases: [], facets: ['schema:genre'] }, 'skos:Concept': { bases: [], facets: [] } },
  properties: {
    'schema:genre': { datatype: 'wikibase-item', qualifiers: [] },
    'schema:inLanguage': { datatype: 'string' },
  },
};
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const digest = (value: string) => createHash('sha256').update(value).digest();

type Probe = {
  aggregations: number;
  reads: { partition: number; ids: string[] }[];
  iteratorSteps: number;
  engineRequests: number;
  candidateHits: number;
};
type SearchWork = {
  iteratorSteps: number;
  engineRequests: number;
  candidateHits: number;
  discardedCandidates: number;
  returnedRows: number;
};
let db: GrowthDatabase | undefined;
let engine: OpenSearch | undefined;
let observedEngine: OpenSearch | undefined;
let source: SubjectSource | undefined;
let service: ReturnType<typeof createSearchService> | undefined;
let kernel: ReturnType<typeof createKernel> | undefined;
let probe: Probe | undefined;
let authorIds: string[] = [];
let bookIds: string[] = [];
let matchedBookIds: string[] = [];
// semantic.partition_subjects holds one counter row per partition from its migration on, so it is reset, not emptied.
type Counts = Record<(typeof seededRelations)[number] | 'visible', number>;
const starts: Counts[] = [];
const fixtureRows: Counts[] = [];
const finishes: Counts[] = [];

async function seededCounts(database: GrowthDatabase): Promise<Counts> {
  const counts = {} as Counts;
  for (const relation of seededRelations) {
    const { rows } = await database.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation}`);
    counts[relation] = rows[0]!.n;
  }
  const { rows } = await database.admin.query<{ n: number }>(
    'SELECT coalesce(sum(visible), 0)::int AS n FROM semantic.partition_subjects',
  );
  counts.visible = rows[0]!.n;
  return counts;
}

// TRUNCATE ... CASCADE also empties the semantic tables that reference these. The engine's documents go with the rows.
async function resetSeeded(database: GrowthDatabase): Promise<void> {
  if (!engine) throw new Error('Growth engine is not open');
  // The immutability triggers on these relations also refuse TRUNCATE; the replica role skips them for this transaction.
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`TRUNCATE TABLE ${seededRelations.join(', ')} CASCADE`);
    await client.query('UPDATE semantic.partition_subjects SET visible = 0');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await engine.request(
    'POST',
    `/${subjectAlias(prefix)}/_delete_by_query`,
    { query: { match_all: {} } },
    { query: { refresh: true, conflicts: 'proceed' } },
  );
}

async function checkSeeded(database: GrowthDatabase, check: Parameters<typeof checkGrowth>[1]) {
  const report = await checkGrowth(database, {
    ...check,
    grow: async (target, scale, previous) => {
      if (previous === 0) {
        await resetSeeded(target);
        starts.push(await seededCounts(target));
        matchedBookIds = [];
        await buildFixtures();
        fixtureRows.push(await seededCounts(target));
      }
      await check.grow(target, scale, previous);
    },
  });
  finishes.push(await seededCounts(database));
  return report;
}

async function buildFixtures(): Promise<void> {
  if (!db || !engine) throw new Error('Growth fixtures are not open');
  await bootstrapRelease(db.pool, bundledRelease);

  const route = hotPartition * 16;
  const authorA = await addSubject(route + 1, { type: 'skos:Concept', labels: { en: 'Author A' } });
  const authorB = await addSubject(route + 2, { type: 'skos:Concept', labels: { en: 'Author B' } });
  authorIds = [authorA, authorB];
  await appendExpandedAuthor(authorA, authorB);
  await appendExpandedAuthor(authorB, authorA);

  const books = [
    await addSubject(route + 3, {
      type: 'schema:Book',
      labels: { en: 'Book one' },
      statements: { 'schema:genre': [statement('schema:genre', authorA)] },
    }),
    await addSubject(route + 4, {
      type: 'schema:Book',
      labels: { en: 'Book two' },
      statements: {
        'schema:genre': [statement('schema:genre', authorA), statement('schema:genre', authorB)],
      },
    }),
    await addSubject(route + 5, {
      type: 'schema:Book',
      labels: { en: 'Book three' },
      statements: { 'schema:genre': [statement('schema:genre', authorA)] },
    }),
    await addSubject(route + 6, {
      type: 'schema:Book',
      labels: { en: 'Book four' },
      statements: { 'schema:genre': [statement('schema:genre', authorB)] },
    }),
  ];

  bookIds = books;

  const byPartition = new Map<number, string[]>();
  for (const id of [...authorIds, ...books]) {
    const partition = subjectPartition(id);
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), id]);
  }
  for (const [partition, ids] of byPartition) {
    const snapshot = await subjectSource(db.pool).read(partition, ids);
    await engine.bulk(bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, ids)), {
      query: { refresh: 'wait_for' },
    });
  }
}

async function addSubject(route: number, item: unknown): Promise<string> {
  if (!db) throw new Error('Growth database is not open');
  return createSubjectAt(db.pool, route, item);
}

async function createSubjectAt(pool: GrowthDatabase['pool'], route: number, item: unknown): Promise<string> {
  const target = { route, id: newId(route) };
  await createSubject(pool, {
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
       VALUES ($1, $2, $3, 33, 'expand', 'statement', NULL, 'schema:genre', NULL, '{}'::jsonb, $4, NULL)`,
      [route, subjectId, slot, transactionId],
    );
    await client.query(
      `INSERT INTO semantic.candidate
         (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin, view_order)
       VALUES ($1, $2, $3, $4, 'schema:genre', 'normal', $5::jsonb, $6, 1, 'proposal', 0)`,
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
      const transactionId = randomUUID();
      const releaseDigest = `sha256:${createHash('sha256').update(`facet-release-${ordinal}-${id}`).digest('hex')}`;
      const activationDigest = ordinal % unit === unit - 1 || ordinal % 8 === 7 ? bundledDigest : releaseDigest;
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
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transactionId,
          },
          {
            route,
            subject_id: id,
            revision: 2,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: transactionId,
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
          { route, subject_id: id, candidate_id: candidate, visibility: 'hidden', security_revision: 1 },
        ],
        'semantic.outbound_link': [
          {
            route,
            subject_id: id,
            property: 'schema:genre',
            filter_value: '00000000-0000-0000-0000-000000000000',
            order_key: ordinal.toString().padStart(12, '0'),
            target_subject_id: id,
            statement_id: candidate,
            slot_id: slot,
            relation: true,
            source_type: 'schema:Book',
            source_order_key: '',
            outbound_order: 'name',
            source_revision: 2,
            source_security_revision: 0,
            target_revision: 0,
            target_type: 'schema:Book',
            external: null,
            value: 'value',
            present: true,
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.definition_release': [
          {
            route: 0,
            digest: releaseDigest,
            body: { types: {}, properties: {} },
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.definition_activation': [
          {
            route: 0,
            head: ordinal + 2,
            digest: activationDigest,
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
      await admin.query(
        `INSERT INTO semantic.partition_subjects (partition_no, visible)
         SELECT * FROM unnest($1::integer[], $2::bigint[])
         ON CONFLICT (partition_no) DO UPDATE SET visible = semantic.partition_subjects.visible + EXCLUDED.visible`,
        [[...counts.keys()], [...counts.values()]],
      );
    },
  };
  return current;
}

async function growUnrelatedEngineDocuments(from: number, to: number): Promise<void> {
  if (!engine) throw new Error('Growth engine is not open');
  const sample = unrelatedPopulation('facet-engine-unrelated');
  const index = subjectIndexName(prefix, 1);
  for (let start = from; start < to; start += 128) {
    const lines = Array.from({ length: Math.min(128, to - start) }, (_, offset) => {
      const ordinal = start + offset;
      const place = placement(sample, ordinal);
      const subject: IndexedSubject = {
        id: newId(place.route),
        type: 'schema:Recipe',
        visibility: 'visible',
        redirect: null,
        securityRevision: 1,
        labels: [{ language: 'en', value: `Unrelated recipe ${ordinal}` }],
        aliases: [],
        descriptions: [],
        statements: [],
      };
      return documentActions({ partition: place.partition, position: 1n, subjects: [subject] }, [subject.id]);
    }).flatMap((actions) => bulkLines(index, actions));
    const result = await engine.bulk<{ errors: boolean }>(lines);
    expect(result.errors).toBe(false);
  }
  await engine.request('POST', `/${index}/_refresh`);
}

async function growPopulation(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await seed({ pool: database.pool, admin: database.admin }, unrelatedPopulation('facet-counts-growth'), {
    from: previous * unit,
    to: scale * unit,
  });
}

async function growCatalogue(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await growPopulation(database, scale, previous);
  await growUnrelatedEngineDocuments(previous * unit, scale * unit);
}

function matchedCatalogue(): Population {
  return {
    name: 'facet-matched-catalogue',
    hotPartition,
    write: async (target, place) => {
      const id = await createSubjectAt(target.pool, place.route, {
        type: 'schema:Book',
        labels: { en: `Growth book ${place.ordinal.toString().padStart(4, '0')}` },
        statements: { 'schema:genre': [statement('schema:genre', authorIds[0]!)] },
      });
      matchedBookIds[place.ordinal] = id;
    },
  };
}

async function indexMatchedSubjects(ids: readonly string[]): Promise<void> {
  if (!db || !engine) throw new Error('Growth fixtures are not open');
  const byPartition = new Map<number, string[]>();
  for (const id of ids) {
    const partition = subjectPartition(id);
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), id]);
  }
  const productionSource = subjectSource(db.pool);
  for (const [partition, partitionIds] of byPartition) {
    for (let start = 0; start < partitionIds.length; start += 128) {
      const batch = partitionIds.slice(start, start + 128);
      const snapshot = await productionSource.read(partition, batch);
      const result = await engine.bulk<{ errors: boolean }>(
        bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, batch)),
      );
      if (result.errors) throw new Error('Matched catalogue documents failed to index');
    }
  }
  await engine.request('POST', `/${subjectIndexName(prefix, 1)}/_refresh`);
}

async function growMatchedCatalogue(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  if (bookIds.length === 0) throw new Error('Growth fixtures are not open');
  const from = Math.max(0, previous - bookIds.length);
  const to = Math.max(0, scale - bookIds.length);
  if (to <= from) return;
  const population = matchedCatalogue();
  await seed({ pool: database.pool, admin: database.admin }, population, { from, to });
  const ids = matchedBookIds.slice(from, to);
  if (ids.length !== to - from || ids.some((id) => typeof id !== 'string'))
    throw new Error('Matched catalogue fixture omitted a created subject');
  await indexMatchedSubjects(ids);
}

async function growHistory(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  if (bookIds.length === 0) throw new Error('Growth fixtures are not open');
  await seed(
    { pool: database.pool, admin: database.admin },
    {
      name: 'facet-history-growth',
      hotPartition,
      rows: ({ ordinal }) => {
        const subjectId = bookIds[ordinal % bookIds.length]!;
        const route = routeOf(subjectId);
        if (route === null) throw new TypeError('Expected a routed neighbourhood book');
        return {
          'semantic.revision': [
            {
              route,
              subject_id: subjectId,
              revision: 100 + ordinal,
              kind: 'adopt',
              release: bundledDigest,
              recorded_transaction_id: randomUUID(),
            },
          ],
        };
      },
    },
    { from: previous, to: scale },
  );
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
      const templateId =
        method === 'POST' &&
        path.endsWith('/_search/template') &&
        typeof body === 'object' &&
        body !== null &&
        'id' in body &&
        typeof body.id === 'string'
          ? body.id
          : undefined;
      if (probe && templateId === `${prefix}${FACET_TEMPLATE}`) probe.aggregations++;
      const profiled = templateId === `${prefix}${SEARCH_TEMPLATE}` || templateId === `${prefix}${HIT_TEMPLATE}`;
      const requestOptions = profiled ? { ...options, query: { ...options?.query, profile: true } } : options;
      const result = engine!.request<T>(method, path, body, requestOptions);
      if (!probe || !profiled) return result;
      const activeProbe = probe;
      return result.then((response) => {
        const body = response.body as { hits?: { hits?: unknown } };
        activeProbe.engineRequests++;
        if (Array.isArray(body.hits?.hits)) activeProbe.candidateHits += body.hits.hits.length;
        activeProbe.iteratorSteps += measurePublicFilterIteratorSteps(response.body);
        return response;
      });
    },
    bulk: (lines, options) => engine!.bulk(lines, options),
  };
  await createSubjectIndex(engine, prefix, 1);
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

function recordGrowthEvidence(
  name: string,
  report: Awaited<ReturnType<typeof checkGrowth>>,
  populationUnit = unit,
): void {
  for (const sample of report.samples) {
    console.info(
      JSON.stringify({
        evidence: name,
        scale: sample.scale,
        population: sample.scale * populationUnit,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        statements: sample.cost.statements,
        sharedHit: sample.cost.sharedHit,
        sharedRead: sample.cost.sharedRead,
        relations: sample.cost.relations,
        background: {
          statements: sample.cost.backgroundStatements ?? 0,
          rows: sample.cost.backgroundRows ?? 0,
          blocks: sample.cost.backgroundBlocks ?? 0,
          costs: sample.cost.backgroundCosts ?? {},
        },
        ...(sample.counted === undefined ? {} : { counted: sample.counted }),
      }),
    );
  }
}

function emptyProbe(): Probe {
  return { aggregations: 0, reads: [], iteratorSteps: 0, engineRequests: 0, candidateHits: 0 };
}

async function postSearch(body: Record<string, unknown>): Promise<Response> {
  return kernel!.handle(
    new Request('http://kernel.test/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const admittedSearch = {
  filter: { type: { in: ['schema:Book'] } },
  sort: 'name',
  properties: ['schema:genre'],
  languages: ['en'],
} as const;

const deepSearch = { filter: { type: { in: ['schema:Book'] } }, sort: 'name' } as const;
const deepPageLimit = 32;
const deepScales = [64, 512, 4096] as const;

async function measureSearchCase(operation: (sample: Probe) => Promise<number>): Promise<SearchWork> {
  const sample = emptyProbe();
  probe = sample;
  try {
    const returnedRows = await operation(sample);
    if (sample.candidateHits < returnedRows)
      throw new Error('Search returned more subjects than the native candidate hits observed');
    return {
      iteratorSteps: sample.iteratorSteps,
      engineRequests: sample.engineRequests,
      candidateHits: sample.candidateHits,
      discardedCandidates: sample.candidateHits - returnedRows,
      returnedRows,
    };
  } finally {
    probe = undefined;
  }
}

async function measureAdmittedSearchPositive(): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const selectedPartitions = new Set(authorIds.map(subjectPartition));
    const allowedIds = new Set([...bookIds, ...authorIds]);
    const authorsByBook = [[0], [0, 1], [0], [1]];
    const admitted = await postSearch(admittedSearch);
    expect(admitted.status).toBe(200);
    const answer = (await admitted.json()) as {
      subjects: { id: string; facts: Record<string, unknown[]> }[];
      next: string | null;
    };
    expect(answer).not.toHaveProperty('total');
    expect(answer.subjects.map(({ id }) => id)).toEqual([bookIds[3]!, bookIds[0]!, bookIds[2]!, bookIds[1]!]);
    expect(answer.next).toBeNull();
    for (const hit of answer.subjects) {
      const authors = authorsByBook[bookIds.indexOf(hit.id)]!;
      expect(hit.facts['schema:genre']).toEqual(
        authors.map((index) => ({
          kind: 'item',
          id: authorIds[index]!,
          labels: { en: index === 0 ? 'Author A' : 'Author B' },
        })),
      );
    }
    const authorReads = sample.reads.filter(({ ids }) => ids.some((id) => authorIds.includes(id)));
    expect(authorReads.map(({ partition }) => partition).sort((a, b) => a - b)).toEqual(
      [...selectedPartitions].sort((a, b) => a - b),
    );
    expect(authorReads.flatMap(({ ids }) => ids).sort()).toEqual([...authorIds].sort());
    for (const { ids } of sample.reads) for (const id of ids) expect(allowedIds.has(id)).toBe(true);
    expect(sample.iteratorSteps).toBeGreaterThan(0);
    expect(sample.engineRequests).toBeGreaterThan(0);
    return answer.subjects.length;
  });
}

async function measureExhaustedEmptySearch(): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const response = await postSearch({
      ...admittedSearch,
      filter: {
        type: { in: ['schema:Book'] },
        'schema:genre': { in: ['019a1b2c-3d4e-7f00-8a00-ed170e000099'] },
      },
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { subjects: unknown[]; next: string | null };
    expect(answer.subjects).toEqual([]);
    expect(answer.next).toBeNull();
    expect(sample.engineRequests).toBe(1);
    return answer.subjects.length;
  });
}

async function measureInvalidCursorSearch(): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const response = await postSearch({ ...admittedSearch, cursor: 'not-a-cursor' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(sample.engineRequests).toBe(0);
    expect(sample.candidateHits).toBe(0);
    expect(sample.iteratorSteps).toBe(0);
    return 0;
  });
}

async function measureFirstSearchPage(): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const response = await postSearch({ ...admittedSearch, limit: 1 });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { subjects: { id: string }[]; next: string | null };
    expect(page.subjects.map(({ id }) => id)).toEqual([bookIds[3]!]);
    expect(page.next).toBeString();
    expect(sample.candidateHits).toBeGreaterThan(page.subjects.length);
    return page.subjects.length;
  });
}

async function issueFirstSearchCursor(): Promise<string> {
  const response = await postSearch({ ...admittedSearch, limit: 1 });
  expect(response.status).toBe(200);
  const page = (await response.json()) as { subjects: { id: string }[]; next: string | null };
  expect(page.subjects.map(({ id }) => id)).toEqual([bookIds[3]!]);
  expect(page.next).toBeString();
  return page.next!;
}

async function measureSecondSearchPage(cursor: string): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const response = await postSearch({ ...admittedSearch, limit: 1, cursor });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { subjects: { id: string }[]; next: string | null };
    expect(page.subjects.map(({ id }) => id)).toEqual([bookIds[0]!]);
    expect(page.next).toBeString();
    expect(sample.candidateHits).toBeGreaterThan(page.subjects.length);
    return page.subjects.length;
  });
}

async function issueDeepSearchCursor(total: number): Promise<string> {
  const orderedIds = [bookIds[3]!, bookIds[0]!, bookIds[2]!, bookIds[1]!, ...matchedBookIds];
  expect(orderedIds).toHaveLength(total);
  let cursor: string | undefined;
  let consumed = 0;
  const depth = total - deepPageLimit;
  while (consumed < depth) {
    const response = await postSearch({
      ...deepSearch,
      limit: deepPageLimit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { subjects: { id: string }[]; next: string | null };
    expect(page.subjects.map(({ id }) => id)).toEqual(orderedIds.slice(consumed, consumed + deepPageLimit));
    expect(page.subjects).toHaveLength(deepPageLimit);
    expect(page.next).toBeString();
    cursor = page.next!;
    consumed += page.subjects.length;
  }
  expect(consumed).toBe(depth);
  if (!cursor) throw new Error('Public Search did not issue the deep continuation cursor');
  return cursor;
}

async function measureDeepSearchPage(cursor: string, total: number): Promise<SearchWork> {
  return measureSearchCase(async (sample) => {
    const response = await postSearch({ ...deepSearch, limit: deepPageLimit, cursor });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { subjects: { id: string }[]; next: string | null };
    expect(page.subjects.map(({ id }) => id)).toEqual(matchedBookIds.slice(-deepPageLimit));
    expect(page.subjects).toHaveLength(deepPageLimit);
    expect(page.next).toBeNull();
    expect(total % deepPageLimit).toBe(0);
    expect(sample.engineRequests).toBeGreaterThan(0);
    return page.subjects.length;
  });
}

function searchWorkCounted(limit: number) {
  const candidateLimit = Math.min(600, 6 * limit + 3);
  return {
    read(value: unknown) {
      return value as SearchWork;
    },
    limits: { engineRequests: 3, candidateHits: candidateLimit, discardedCandidates: candidateLimit },
    bounds: {
      iteratorSteps: 'logarithmic' as const,
      engineRequests: 'constant' as const,
      candidateHits: 'constant' as const,
      discardedCandidates: 'constant' as const,
    },
  };
}

function expectNoSemanticSearchScans(report: Awaited<ReturnType<typeof checkGrowth>>): void {
  for (const sample of report.samples) {
    const scans = Object.entries(sample.cost.relations ?? {}).filter(
      ([relation, cost]) => relation.startsWith('semantic.') && (cost.sequentialScans ?? 0) > 0,
    );
    expect(scans).toEqual([]);
  }
}

async function checkSearchGrowth(
  database: GrowthDatabase,
  options: {
    name: string;
    scales: readonly [number, number, number];
    grow: (database: GrowthDatabase, scale: number, previous: number) => Promise<void>;
    limit: number;
    populationUnit?: number;
    prepare?: (scale: number, repetition: number) => Promise<void>;
    operation: (scale: number) => Promise<SearchWork>;
  },
): Promise<Awaited<ReturnType<typeof checkGrowth>>> {
  const report = await checkSeeded(database, {
    name: options.name,
    scales: options.scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    counted: searchWorkCounted(options.limit),
    repetitions: 1,
    warmups: 1,
    warmup: async () => undefined,
    ...(options.prepare === undefined
      ? {}
      : {
          prepare: async (_database: GrowthDatabase, scale: number, repetition: number) =>
            options.prepare!(scale, repetition),
        }),
    grow: options.grow,
    operation: (_database, scale) => options.operation(scale),
  });
  recordGrowthEvidence(options.name, report, options.populationUnit);
  expect(report.samples).toHaveLength(3);
  expectNoSemanticSearchScans(report);
  return report;
}

test('Facet counts stays within its bound as N grows', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  const report = await checkSeeded(db, {
    name: 'Facet counts stays within its bound as N grows',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: growPopulation,
    operation: async () => {
      probe = emptyProbe();
      const selectedPartitions = new Set(authorIds.map(subjectPartition));
      try {
        const response = await kernel!.handle(
          new Request('http://kernel.test/v1/subjects:facets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              filter: { type: { in: ['schema:Book'] } },
              facets: [{ property: 'schema:genre' }],
            }),
          }),
        );
        expect(response.status).toBe(200);
        const answer = (await response.json()) as {
          facets: {
            property: string;
            values: { value: string; labels: Record<string, string> }[];
          }[];
        };
        expect(answer).not.toHaveProperty('total');
        expect(answer.facets).toEqual([
          {
            property: 'schema:genre',
            values: [
              { value: authorIds[0]!, labels: { en: 'Author A' } },
              { value: authorIds[1]!, labels: { en: 'Author B' } },
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
  recordGrowthEvidence('facet-counts', report);
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    const scans = Object.entries(sample.cost.relations ?? {}).filter(
      ([relation, cost]) => relation.startsWith('semantic.') && (cost.sequentialScans ?? 0) > 0,
    );
    expect(scans).toEqual([]);
  }
}, 90_000);

test('type facet stays within its bound as subjects grow', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  const report = await checkSeeded(db, {
    name: 'type facet stays within its bound as subjects grow',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: growPopulation,
    operation: async () => {
      probe = emptyProbe();
      try {
        const response = await kernel!.handle(
          new Request('http://kernel.test/v1/subjects:facets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ facets: [{ property: 'type' }] }),
          }),
        );
        expect(response.status).toBe(200);
        const answer = await response.json();
        expect(answer).not.toHaveProperty('total');
        expect(answer.facets).toEqual([
          {
            property: 'type',
            values: [
              { value: 'schema:Book', labels: {} },
              { value: 'skos:Concept', labels: {} },
            ],
          },
        ]);
        expect(probe.aggregations).toBe(1);
        expect(probe.reads).toEqual([]);
      } finally {
        probe = undefined;
      }
    },
  });
  recordGrowthEvidence('type-facet', report);
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    const subjectReads = Object.keys(sample.cost.relations ?? {}).filter((relation) =>
      relation.startsWith('semantic.'),
    );
    expect(subjectReads).toEqual([]);
  }
}, 90_000);

test('Search hit facts stay within their bound as N grows', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  await checkSearchGrowth(db, {
    name: 'Search hit facts',
    scales: [1, 4, 16],
    grow: growCatalogue,
    limit: 20,
    operation: () => measureAdmittedSearchPositive(),
  });
}, 90_000);

test('Search hit facts stay within their bound as neighbourhood history grows', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  await checkSearchGrowth(db, {
    name: 'Search hit facts history',
    scales: deepScales,
    grow: growHistory,
    limit: 20,
    populationUnit: 1,
    operation: () => measureAdmittedSearchPositive(),
  });
}, 90_000);

test('Search exhausted empty stays within its bound as history grows', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  await checkSearchGrowth(db, {
    name: 'Search exhausted empty history',
    scales: deepScales,
    grow: growHistory,
    limit: 20,
    populationUnit: 1,
    operation: () => measureExhaustedEmptySearch(),
  });
}, 90_000);

test('Search invalid cursor refusal has an independent zero-query report', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  await checkSearchGrowth(db, {
    name: 'Search invalid cursor',
    scales: [1, 4, 16],
    grow: growCatalogue,
    limit: 20,
    operation: () => measureInvalidCursorSearch(),
  });
}, 90_000);

test('Search first page has an independent bounded-candidate report', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  await checkSearchGrowth(db, {
    name: 'Search first page',
    scales: [1, 4, 16],
    grow: growCatalogue,
    limit: 1,
    operation: () => measureFirstSearchPage(),
  });
}, 90_000);

test('Search second page has an independent public-cursor report', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  let cursor: string | undefined;
  await checkSearchGrowth(db, {
    name: 'Search second page',
    scales: [1, 4, 16],
    grow: growCatalogue,
    limit: 1,
    prepare: async () => {
      cursor = await issueFirstSearchCursor();
    },
    operation: () => {
      if (!cursor) throw new Error('Search second page cursor was not issued');
      return measureSecondSearchPage(cursor);
    },
  });
}, 90_000);

test('Search deep page stays bounded as the matched catalogue and cursor depth grow', async () => {
  if (!db || !kernel) throw new Error('Growth fixtures are not ready');
  let cursor: string | undefined;
  await checkSearchGrowth(db, {
    name: 'Search deep page',
    scales: deepScales,
    grow: growMatchedCatalogue,
    limit: deepPageLimit,
    populationUnit: 1,
    prepare: async (scale) => {
      cursor = await issueDeepSearchCursor(scale);
    },
    operation: (scale) => {
      if (!cursor) throw new Error('Search deep page cursor was not issued');
      return measureDeepSearchPage(cursor, scale);
    },
  });
}, 300_000);

test('every growth-facets check starts empty and stays within the seeded maximum', async () => {
  expect(starts).toHaveLength(9);
  expect(fixtureRows).toHaveLength(9);
  expect(finishes).toHaveLength(9);
  const sample = unrelatedPopulation('facet-counts-bound');
  const written = Object.fromEntries([...seededRelations, 'visible'].map((relation) => [relation, 0])) as Counts;
  for (let ordinal = 0; ordinal < 16 * unit; ordinal++) {
    const place = placement(sample, ordinal);
    written.visible++;
    for (const [relation, rows] of Object.entries(sample.rows!(place)))
      written[relation as keyof Counts] += rows.length;
  }
  const empty = Object.fromEntries([...seededRelations, 'visible'].map((relation) => [relation, 0])) as Counts;
  for (const start of starts) expect(start).toEqual(empty);
  // The fixtures every check builds around the seeded rows are not part of the ordinals' units.
  // The 8,000-row ceiling also covers the 4,096 matched-catalogue and history scales.
  finishes.forEach((finish, check) => {
    for (const relation of [...seededRelations, 'visible'] as const)
      expect(finish[relation]).toBeLessThanOrEqual(written[relation] + fixtureRows[check]![relation]);
  });
}, 90_000);
