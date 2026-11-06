import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';
import { createSearchService } from '../../src/search/service.ts';
import { readSearchIdentityMappings } from '../../src/search/canonical-keyset.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';
import type { FacetDiscoveryProvider } from '../../src/search/facet-discovery-native.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';
import {
  createMappedExecutedRequestSubject,
  deleteExecutedSearchPrefix,
  publishExecutedGeneration,
} from './support/executed-request-runtime.ts';
import { searchHttpFamilyFromStatus } from '../../src/search/http/search.ts';
import { searchNativeCursorPointer } from '../../src/search/http/native-recovery.ts';
import { executedRatingPair } from '../../src/search/canonical-keyset-admit.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { readExposure } from '../../src/access/gates/catalogue.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) };
const prefixes: string[] = [];
const opening = crypto.randomUUID();
let identity: EpochFixture | undefined;
const reader: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  clientId: 'reader',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const cost: PublicFilterCost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};
const release: FilterRelease = {
  types: { 'schema:Book': { bases: [], facets: ['schema:inLanguage'] } },
  properties: {
    'schema:inLanguage': {
      datatype: 'string',
      value: { pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' },
    },
  },
};

beforeAll(async () => {
  for (const group of ['search', 'search_advanced'])
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10_000)).open)
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         VALUES ($1, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2)`,
        [group, opening],
      );
  identity = await epochFixture();
});

afterAll(async () => {
  try {
    for (const prefix of prefixes) await deleteExecutedSearchPrefix(client, prefix);
  } finally {
    try {
      await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
    } finally {
      try {
        await pool.end();
      } finally {
        await identity?.close();
      }
    }
  }
});

const access: Access = {
  async authenticate(token) {
    if (token === 'reader') return reader;
    throw new AuthenticationError(401, 'Bearer error="invalid_token"');
  },
  async authorize() {
    return true;
  },
};

function facetProvider(generation: number, values: readonly string[]): () => Promise<FacetDiscoveryProvider> {
  const queried = {
    consumer: {
      physicalTarget: `subjects-g${generation}`,
      incarnation: String(generation),
      consumerGeneration: String(generation),
      projectionGeneration: String(generation),
      meaningDigest: 'a'.repeat(64),
      readDefinition: 'read',
    },
    snapshot: { kind: 'prepared' as const, observation: 'obs', build: 'build', generation: BigInt(generation) },
  };
  return async () => ({
    source: `subjects-g${generation}`,
    generation,
    meaning: { digest: 'a'.repeat(64), release, type: 'schema:Book' } as FacetDiscoveryProvider['meaning'],
    operations: {
      async captureFacet() {
        return { status: 'captured' as const, queried, repair: { consumer: queried.consumer, job: 'job' }, cost };
      },
      async pageFacets({ reads }) {
        return {
          status: 'ready' as const,
          facets: reads.map((read) => {
            const selected = values.filter((value) => read.after === null || value > read.after);
            const page = selected.slice(0, read.size);
            return {
              property: read.plan.property,
              values: page.map((value) => ({ value, labels: {} })),
              after: page.at(-1) ?? null,
              hasMore: selected.length > read.size,
            };
          }),
          asOf: '2026-11-06T00:00:00.000Z',
          cost,
          async finalize() {
            return { status: 'current' as const, cost };
          },
        };
      },
      async repairStep() {
        throw new Error('unused');
      },
    },
  });
}

async function deployment(
  subjects: readonly IndexedSubject[],
  options: {
    source?: (fake: ReturnType<typeof createFakeSource>) => SubjectSource;
    facetValues?: readonly string[];
  } = {},
) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const fake = createFakeSource();
  for (const entry of subjects) fake.put(entry);
  await publishExecutedGeneration(client, prefix, fake, subjects, 1);
  const source = options.source ? options.source(fake) : fake;
  const service = createSearchService({
    pool,
    client,
    prefix,
    source,
    cursors,
    release: async () => release,
    ...(options.facetValues ? { facetProvider: facetProvider(1, options.facetValues) } : {}),
  });
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(13),
    search: service,
    access,
    receiptKeys: testReceiptKeys(),
  });
  return { prefix, fake, service, kernel };
}

async function createdSubject(
  n: number,
  label: string,
  partition = 10,
  patch: Partial<IndexedSubject> = {},
): Promise<IndexedSubject> {
  if (!identity) throw new Error('Native identity fixture was not initialized');
  return createMappedExecutedRequestSubject(identity, n, label, partition, patch);
}

function json(method: string, path: string, body?: unknown, token?: string) {
  return new Request(`http://kernel.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function posted(kernel: ReturnType<typeof createKernel>, path: string, body: unknown, token?: string) {
  const response = await kernel.handle(json('POST', path, body, token));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('native HTTP search, facets and typeahead share one executed request through ties, duplicates and the terminal page', async () => {
  const alpha = await createdSubject(1, 'Lantern');
  const beta = await createdSubject(2, 'Lantern');
  const gamma = await createdSubject(3, 'Lantern Grove');
  const hidden = await createdSubject(4, 'Lantern Hidden', 10, { visibility: 'hidden', securityRevision: 2 });
  if (!identity) throw new Error('Native identity fixture was not initialized');
  expect(await readSearchIdentityMappings(identity.pool, [alpha.id])).toEqual([
    { state: 'mapped', original: alpha.id, terminal: alpha.id },
  ]);
  const { fake, kernel } = await deployment([alpha, beta, gamma, hidden], { facetValues: ['en', 'ja'] });
  fake.put(hidden);
  const request = { text: 'lantern', sort: 'name', limit: 2 };
  const first = await posted(kernel, '/v1/subjects:search', request);
  expect(searchHttpFamilyFromStatus(first.status)).toBe('ready');
  const firstIds = (first.body.subjects as { id: string }[]).map(({ id }) => id);
  expect(firstIds).toEqual([alpha.id, beta.id].sort());
  expect(first.body).not.toHaveProperty('total');
  expect(first.body.next).toBeString();

  const second = await posted(kernel, '/v1/subjects:search', { ...request, cursor: first.body.next });
  expect(searchHttpFamilyFromStatus(second.status)).toBe('ready');
  expect((second.body.subjects as { id: string }[]).map(({ id }) => id)).toEqual([gamma.id]);
  expect(second.body.next).toBeNull();

  const suggest = await kernel.handle(json('GET', '/v1/subjects:suggest?q=Lantern&limit=10'));
  expect(searchHttpFamilyFromStatus(suggest.status)).toBe('ready');
  const suggested = ((await suggest.json()) as { subjects: { id: string }[] }).subjects.map(({ id }) => id);
  expect(suggested.sort()).toEqual([alpha.id, beta.id, gamma.id].sort());

  const facets = await posted(kernel, '/v1/subjects:facets', {
    text: 'lantern',
    facets: [{ property: 'schema:inLanguage', size: 1 }],
  });
  expect(searchHttpFamilyFromStatus(facets.status)).toBe('ready');
  expect((facets.body.facets as { next: string | null }[])[0]!.next).toBeString();
});

test('lost generation restarts the same HTTP operands; a first-page retry of that request is ready', async () => {
  const books: IndexedSubject[] = [];
  for (const n of [1, 2, 3]) books.push(await createdSubject(n, `Ogai ${n}`));
  const { prefix, fake, kernel } = await deployment(books);
  const request = { text: 'ogai', sort: 'name', limit: 1 };
  const first = await posted(kernel, '/v1/subjects:search', request);
  expect(first.status).toBe(200);
  const cursor = first.body.next as string;
  await publishExecutedGeneration(client, prefix, fake, books, 2);
  const lost = await posted(kernel, '/v1/subjects:search', { ...request, cursor });
  expect(searchHttpFamilyFromStatus(lost.status, lost.body.code as string)).toBe('restart');
  expect(lost.body).toMatchObject({ code: 'search_restart_required' });
  expect(lost.body).not.toHaveProperty('subjects');
  const restarted = await posted(kernel, '/v1/subjects:search', request);
  expect(searchHttpFamilyFromStatus(restarted.status)).toBe('ready');
  expect((restarted.body.subjects as { id: string }[])[0]!.id).toBe(books[0]!.id);
});

test('temporary source failure keeps the executed request; a later observation of the same body is ready', async () => {
  const book = await createdSubject(1, 'Murasaki');
  let fail = true;
  const { kernel } = await deployment([book], {
    source: (fake) => ({
      ...fake,
      async read(...args: Parameters<typeof fake.read>) {
        if (fail) {
          fail = false;
          throw new SearchUnavailableError('temporary source');
        }
        return fake.read(...args);
      },
    }),
  });
  const request = { text: 'murasaki', sort: 'name' };
  const unavailable = await posted(kernel, '/v1/subjects:search', request);
  expect(searchHttpFamilyFromStatus(unavailable.status, unavailable.body.code as string)).toBe('index-not-ready');
  expect(unavailable.body).toMatchObject({ code: 'index_not_ready' });
  const retry = await posted(kernel, '/v1/subjects:search', request);
  expect(searchHttpFamilyFromStatus(retry.status)).toBe('ready');
  expect((retry.body.subjects as { id: string }[])[0]!.id).toBe(book.id);
});

test('invalid HTTP operands keep pointers, rating order travels with population, and a replaced reader cannot continue', async () => {
  const books: IndexedSubject[] = [];
  for (const n of [1, 2]) books.push(await createdSubject(n, `Soseki ${n}`));
  const { kernel } = await deployment(books);
  const invalid = await posted(kernel, '/v1/subjects:search', { text: '"unclosed' });
  expect(searchHttpFamilyFromStatus(invalid.status, invalid.body.code as string)).toBe('invalid');
  expect(invalid.body).toMatchObject({
    code: 'unsupported_query',
    errors: [{ pointer: '/text', code: 'unsupported' }],
  });
  const cursorInvalid = await posted(kernel, '/v1/subjects:search', { cursor: 'not-a-token' });
  expect(
    searchHttpFamilyFromStatus(
      cursorInvalid.status,
      cursorInvalid.body.code as string,
      searchNativeCursorPointer(cursorInvalid.body.errors as { pointer: string }[]),
    ),
  ).toBe('invalid-cursor');
  const limit = await kernel.handle(json('GET', '/v1/subjects:suggest?q=So&limit=11'));
  expect(limit.status).toBe(400);

  expect(executedRatingPair({ sort: 'rating', population: { realm: reader.accountId } })).toEqual({
    sort: 'rating',
    population: { realm: reader.accountId },
  });
  const unpaired = await posted(kernel, '/v1/subjects:search', {
    sort: 'name',
    population: { realm: '11111111-1111-7111-8111-111111111111' },
  });
  expect(searchHttpFamilyFromStatus(unpaired.status, unpaired.body.code as string)).toBe('invalid');
  expect(unpaired.body).toMatchObject({
    code: 'unsupported_query',
    errors: [{ pointer: '/population', code: 'unsupported' }],
  });

  const first = await posted(kernel, '/v1/subjects:search', { text: 'soseki', sort: 'name', limit: 1 });
  const replaced = await posted(
    kernel,
    '/v1/subjects:search',
    { text: 'soseki', sort: 'name', limit: 1, cursor: first.body.next },
    'reader',
  );
  expect(
    searchHttpFamilyFromStatus(
      replaced.status,
      replaced.body.code as string,
      searchNativeCursorPointer(replaced.body.errors as { pointer: string }[]),
    ),
  ).toBe('invalid-cursor');
});
