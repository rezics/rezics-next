import { afterAll, expect, test } from 'bun:test';
import { RELEASE_FORMAT, releaseDigest } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import type { CustodyDefinition } from '../../src/search/public-filter-custody-contract.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { unavailableSearchWriterPublication } from '../../src/search/writer-guard.ts';
import {
  assertNativeGenerationActionsVisible,
  GenerationReconciliationMismatch,
  observedWrite,
} from '../../src/search/generations.ts';
import { documentActions, type IndexAction, type SubjectDocument } from '../../src/search/document.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import type { SubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';

const databaseUrl = process.env.DATABASE_URL,
  searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl),
  search = createOpenSearch(searchUrl),
  custody = createPublicFilterCustody(pool);
const indices: string[] = [];
const context = () => ({ deadline: Date.now() + 30_000 });
const zero = {
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
afterAll(async () => {
  await custody.close();
  for (const index of indices) await search.request('DELETE', `/${index}`);
  await pool.end();
});
async function fixture() {
  const prefix = `publication-${crypto.randomUUID().slice(0, 8)}-`;
  for (const generation of [1, 2]) {
    await createSubjectIndex(search, prefix, generation);
    indices.push(subjectIndexName(prefix, generation));
  }
  await search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  const release: CustodyDefinition['meaning']['release'] = {
    format: RELEASE_FORMAT,
    catalogue: { id: 'publication-boundary', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: {},
    types: {},
    properties: {},
  };
  const definition: CustodyDefinition = {
    source: { id: crypto.randomUUID(), partition: 0, epoch: 1, configuration: 'boundary' },
    readDefinition: crypto.randomUUID(),
    meaning: { digest: releaseDigest(release), release, type: 'boundary' },
    capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 20 },
    dependencyKeys: [{ kind: 'order', order: 'id' }],
  };
  // Source is deliberately unavailable. Boundary fixtures never issue a successful privacy observation or fake barrier.
  const source: PublicFilterSource = {
    async readPublicFilterProjectionPage() {
      return { status: 'unready', reason: 'owner_pending', cost: zero };
    },
    async readPrivacyReductionHeads() {
      return { status: 'unready', reason: 'owner_pending', cost: zero };
    },
    async readPrivacyReductionPage() {
      return { status: 'unready', reason: 'owner_pending', cost: zero };
    },
  };
  const binding: PublicFilterSourceBinding = {
    async resolve() {
      return { status: 'resolved', definition, cost: zero };
    },
    async join() {
      return { status: 'unready', reason: 'owner_unavailable', cost: zero };
    },
  };
  const sourceKeys: SubjectSourceKeyPages = {
    async read() {
      return { status: 'identity_pending', partition: 0, epoch: 1, position: 0n, after: null, cost: zero };
    },
  };
  const writerGuard = {
    ...unavailableSearchWriterPublication,
    async write() {
      throw new Error('Pending native Source must not dispatch writes');
    },
  };
  const operations = createSearchGenerationPublication({
    pool,
    search,
    source,
    sourceKeys,
    binding,
    clock: () => new Date(),
    meaning: definition.meaning,
    writerGuard,
  });
  const register = () =>
    custody.register(
      {
        definition,
        physicalTarget: subjectIndexName(prefix, 2),
        consumerGeneration: 'native-2',
        projectionGeneration: 'projection-2',
      },
      search,
      context(),
    );
  const registered = await register();
  if (registered.status !== 'registered') throw new Error(registered.reason);
  return { prefix, operations, registered, register };
}

test('only a completely reconciled native physical generation with actual writer and retained-copy barriers becomes the default read alias', async () => {
  const f = await fixture();
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    expect(prepared.status).toBe('preparing');
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const caller = { ...prepared.job, complete: true, frontier: 4096 };
    expect((await f.operations.activate(caller, context())).status).toBe('preparing');
    expect(await f.operations.step(caller, context())).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(await unavailableSearchWriterPublication.fencePublication(prepared.job, context())).toMatchObject({
      status: 'unready',
    });
    expect((await subjectGenerations(search, f.prefix)).active).toBe(1);
    const row = (
      await pool.query(
        'SELECT phase,home,after_id FROM search.generation_publication WHERE partition_no=0 AND job=$1',
        [prepared.job.job],
      )
    ).rows[0];
    expect(row).toEqual({ phase: 'subject', home: 0, after_id: null });
  } finally {
    await f.operations.close();
  }
});

test('physical recreation invalidates the original job and the replacement adopts its own native incarnation', async () => {
  const f = await fixture();
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    await search.request('DELETE', `/${subjectIndexName(f.prefix, 2)}`);
    await createSubjectIndex(search, f.prefix, 2);
    expect(await f.operations.step(prepared.job, context())).toMatchObject({
      status: 'unready',
      reason: 'incarnation_changed',
    });
    const current = await f.register();
    if (current.status !== 'registered') throw new Error(current.reason);
    expect(current.consumer.incarnation).not.toBe(f.registered.consumer.incarnation);
    const replacement = await f.operations.prepare(current.consumer, context());
    expect(replacement.status).toBe('preparing');
    if (replacement.status === 'preparing') expect(replacement.job.job).not.toBe(prepared.job.job);
    expect((await subjectGenerations(search, f.prefix)).active).toBe(1);
  } finally {
    await f.operations.close();
  }
});

test('native keyed visibility rejects omissions, engine extras and stale external versions', async () => {
  const prefix = `publication-${crypto.randomUUID().slice(0, 8)}-`,
    index = subjectIndexName(prefix, 1);
  await createSubjectIndex(search, prefix, 1);
  indices.push(index);
  const id = '018f0000-0000-7000-8000-000000000001';
  const actions = documentActions(
    {
      partition: 0,
      position: 2n,
      subjects: [
        {
          id,
          type: 'schema:Book',
          visibility: 'visible',
          redirect: null,
          securityRevision: 1,
          labels: [{ language: 'en', value: 'Native publication' }],
          aliases: [],
          descriptions: [],
          statements: [],
        },
      ],
    },
    [id],
  );
  const expected = actions as IndexAction<SubjectDocument>[];
  await expect(assertNativeGenerationActionsVisible(search, index, expected)).rejects.toBeInstanceOf(
    GenerationReconciliationMismatch,
  );
  await writeIndexActions(
    search,
    index,
    expected.map((action) => ({ ...action, version: 1n })),
  );
  await expect(assertNativeGenerationActionsVisible(search, index, expected)).rejects.toBeInstanceOf(
    GenerationReconciliationMismatch,
  );
  await writeIndexActions(search, index, expected);
  expect(await assertNativeGenerationActionsVisible(search, index, expected)).toBe(1);
  await expect(
    assertNativeGenerationActionsVisible(search, index, [{ op: 'delete', id, version: 3n }]),
  ).rejects.toBeInstanceOf(GenerationReconciliationMismatch);
  await writeIndexActions(search, index, [{ op: 'delete', id, version: 3n }]);
  expect(await assertNativeGenerationActionsVisible(search, index, [{ op: 'delete', id, version: 3n }])).toBe(0);
});

test('a lost native alias response is settled by exact alias readback without repeating the write', async () => {
  const prefix = `publication-${crypto.randomUUID().slice(0, 8)}-`,
    index = subjectIndexName(prefix, 1),
    alias = subjectAlias(prefix);
  await createSubjectIndex(search, prefix, 1);
  indices.push(index);
  let writes = 0;
  await observedWrite(
    async () => {
      writes++;
      await search.request('POST', '/_aliases', { actions: [{ add: { index, alias } }] });
      throw new Error('Lost native alias response after apply');
    },
    async () => {
      const response = await search.request<Record<string, unknown>>('GET', `/_alias/${alias}`);
      return response.status === 200 && Object.keys(response.body).length === 1 && Object.hasOwn(response.body, index);
    },
    'Alias response was not recovered',
  );
  expect(writes).toBe(1);
  expect((await subjectGenerations(search, prefix)).active).toBe(1);
});
