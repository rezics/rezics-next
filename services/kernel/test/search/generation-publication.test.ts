import { matchSparseSubjectKeys } from '../../src/search/generation-publication-sparse.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, activeRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { createPublicPreparation, type PublicPreparationOptions } from '../../src/search/public-preparation.ts';
import { createPublicPreparationStore, type PopulationFrontier } from '../../src/search/public-preparation-store.ts';
import type { DefaultPublicFilterRuntime } from '../../src/search/public-runtime.ts';
import { afterAll, expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import type { CustodyDefinition } from '../../src/search/public-filter-custody-contract.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { createSearchWriterGuard, unavailableSearchWriterPublication } from '../../src/search/writer-guard.ts';
import type { SubjectSource } from '../../src/search/source.ts';
import { prepareBoundedSortKeys } from '../../src/search/bounded-sort-keys.ts';
import { newId } from '../../src/route/route.ts';
import {
  assertNativeGenerationActionsVisible,
  GenerationReconciliationMismatch,
  observedWrite,
} from '../../src/search/generations.ts';
import { documentActions, type IndexAction, type SubjectDocument } from '../../src/search/document.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import type { SearchPublicFilterSourceBinding } from '../../src/search/semantic-source-port.ts';
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
async function fixture(keyPages?: SubjectSourceKeyPages, writerSource?: SubjectSource) {
  const prefix = `publication-${crypto.randomUUID().slice(0, 8)}-`;
  for (const generation of [1, 2]) {
    await createSubjectIndex(search, prefix, generation);
    indices.push(subjectIndexName(prefix, generation));
  }
  await search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  const definition: CustodyDefinition = {
    source: { id: crypto.randomUUID(), partition: 0, epoch: 1, configuration: 'boundary' },
    readDefinition: crypto.randomUUID(),
    meaning: { digest: releaseDigest(bundledRelease), release: bundledRelease },
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
  const binding: SearchPublicFilterSourceBinding = {
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
    sourceKeys: keyPages ?? sourceKeys,
    binding,
    readPublicationCompletion: async () => ({ status: 'unready', reason: 'source_missing', cost: zero }),
    clock: () => new Date(),
    meaning: definition.meaning,
    writerGuard: writerSource
      ? createSearchWriterGuard({
          pool,
          search,
          index: subjectIndexName(prefix, 2),
          consumer: 'publication_test',
          source: writerSource,
          listing: { read: async () => new Map() },
        })
      : writerGuard,
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

test('drains sparse writer homes in one funded checkpoint and stops before a dispatched writer', async () => {
  const f = await fixture();
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const target = f.registered.consumer.physicalTarget;
    const guard = createSearchWriterGuard({
      pool,
      search,
      index: target,
      consumer: 'publication_test',
      source: {
        async read() {
          throw new Error('Drain must use the native writer');
        },
        async count() {
          throw new Error('Drain must use the native writer');
        },
      },
      listing: { read: async () => new Map() },
    });
    const homes = [11, 39, 103, 239, 789, 2013];
    // Preserve dispatched uncertainty in the middle of a page of settled homes.
    await pool.query(
      `INSERT INTO search.identity_writer
       (partition_no,physical_target,original_id,incarnation,owner_epoch,writer_token,writer_transaction_id,writer_position,dispatch_state)
       SELECT home,$1,gen_random_uuid(),$2,p.epoch,
         CASE WHEN home=239 THEN gen_random_uuid() END,gen_random_uuid(),1,
         CASE WHEN home=239 THEN 'dispatched' ELSE 'settled' END
       FROM unnest($3::integer[]) home JOIN core.partition p ON p.partition_no=home`,
      [target, f.registered.consumer.incarnation, homes],
    );
    const installed = await guard.fencePublication(prepared.job, context());
    if (installed.status !== 'fenced') throw new Error(installed.reason);
    const frontier = async () =>
      (
        await pool.query<{ home: number; revision: number }>(
          'SELECT publication_home AS home,publication_revision::integer AS revision FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1',
          [target],
        )
      ).rows[0]!;
    const start = await frontier();
    expect(await guard.drainPublication(installed.fence, context(), 34)).toMatchObject({
      status: 'draining',
      advanced: false,
    });
    expect(await frontier()).toEqual(start);
    const batch = await guard.drainPublication(installed.fence, context(), 1000);
    expect(batch).toMatchObject({ status: 'draining', advanced: true, cost: { frontierWrites: 1 } });
    expect(await frontier()).toEqual({ home: 239, revision: start.revision + 1 });
    expect(await guard.drainPublication(installed.fence, context(), 1000)).toMatchObject({
      status: 'draining',
      advanced: false,
    });
    expect(await frontier()).toEqual({ home: 239, revision: start.revision + 1 });
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
  const pages: number[] = [];
  expect(await matchSparseSubjectKeys(search, index, new Set([id]), (size) => pages.push(size))).toBe(true);
  expect(pages).toEqual([1, 0]);
  expect(await matchSparseSubjectKeys(search, index, new Set(), () => {})).toBe(false);
  await expect(
    assertNativeGenerationActionsVisible(search, index, [{ op: 'delete', id, version: 3n }]),
  ).rejects.toBeInstanceOf(GenerationReconciliationMismatch);
  await writeIndexActions(search, index, [{ op: 'delete', id, version: 3n }]);
  expect(await assertNativeGenerationActionsVisible(search, index, [{ op: 'delete', id, version: 3n }])).toBe(0);
  expect(await matchSparseSubjectKeys(search, index, new Set([id]), () => {})).toBe(false);
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

test('native complete pages retain their cursor and empty filtered pages advance the same interrupted job', async () => {
  const after = { route: 0, id: '00000000-0000-7000-8000-000000000001' };
  const cursors: unknown[] = [];
  const f = await fixture({
    async read(request) {
      cursors.push(request.after);
      const {
        rows: [home],
      } = await pool.query<{ epoch: number; position: string }>(
        'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [request.partition],
      );
      return {
        status: 'eligible',
        partition: request.partition,
        epoch: home!.epoch,
        position: BigInt(home!.position),
        ids: [],
        after,
        complete: request.after !== null,
        cost: zero,
      };
    },
  });
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    expect(await f.operations.step(prepared.job, context())).toMatchObject({ status: 'progress' });
    // Re-adoption is the persisted native job, not a replacement frontier from a caller.
    const resumed = await f.operations.prepare(f.registered.consumer, context());
    expect(resumed).toMatchObject({ status: 'preparing', job: prepared.job });
    expect(await f.operations.step(prepared.job, context())).toMatchObject({ status: 'progress' });
    expect(cursors).toEqual([null, after]);
    expect(
      (
        await pool.query(
          'SELECT phase,home,after_id FROM search.generation_publication WHERE partition_no=0 AND job=$1',
          [prepared.job.job],
        )
      ).rows[0],
    ).toEqual({ phase: 'subject', home: 1, after_id: null });
    expect((await subjectGenerations(search, f.prefix)).active).toBe(1);
  } finally {
    await f.operations.close();
  }
});

test('Subject validation replays one changed occupied home before a fresh engine pass', async () => {
  const changed = 31;
  const earlier = 12;
  const occupied = [earlier, changed, 32];
  const after = { route: 0, id: '00000000-0000-7000-8000-000000000001' };
  const reads: unknown[] = [];
  const f = await fixture({
    async read(request) {
      reads.push([request.partition, request.after]);
      const {
        rows: [home],
      } = await pool.query<{ epoch: number; position: string }>(
        'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [request.partition],
      );
      return {
        status: 'eligible',
        partition: request.partition,
        epoch: home!.epoch,
        position: BigInt(home!.position),
        ids: [],
        after: request.after === null ? after : null,
        complete: request.after !== null,
        cost: zero,
      };
    },
  });
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const job = prepared.job.job;
    const step = () => f.operations.step(prepared.job, context());
    const state = async () =>
      (
        await pool.query(
          'SELECT phase,home,pit,engine_after FROM search.generation_publication WHERE partition_no=0 AND job=$1',
          [job],
        )
      ).rows[0];
    const advanceHead = (home: number) =>
      pool.query('UPDATE core.partition SET position=position+1 WHERE partition_no=$1', [home]);
    await pool.query('UPDATE semantic.partition_subjects SET visible=1 WHERE partition_no=ANY($1)', [occupied]);
    await pool.query(
      `INSERT INTO search.generation_publication_home (partition_no,job,pass,epoch,position)
       SELECT partition_no,$1,1,epoch,position FROM core.partition`,
      [job],
    );
    await pool.query(
      "UPDATE search.generation_publication SET phase='validate',home=16 WHERE partition_no=0 AND job=$1",
      [job],
    );
    await advanceHead(changed);
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    // An older worker can continue the Subject scan and open a PIT without a composite cursor.
    expect(await state()).toEqual({ phase: 'subject', home: changed, pit: null, engine_after: null });
    expect(await step()).toMatchObject({ status: 'progress' });
    expect(await state()).toEqual({ phase: 'subject', home: changed, pit: null, engine_after: null });
    expect(await step()).toMatchObject({ status: 'progress' });
    expect(reads).toEqual([
      [changed, null],
      [changed, after],
    ]);
    expect(await state()).toEqual({ phase: 'engine', home: 0, pit: null, engine_after: null });
    expect(await step()).toMatchObject({ status: 'progress' });
    expect(await state()).toMatchObject({ phase: 'engine', pit: expect.any(String), engine_after: null });
    expect(await step()).toMatchObject({ status: 'progress' });
    expect(await state()).toEqual({ phase: 'validate', home: 0, pit: null, engine_after: null });
    await advanceHead(earlier);
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(await state()).toMatchObject({ phase: 'subject', home: earlier });
  } finally {
    await f.operations.close();
    await pool.query('UPDATE semantic.partition_subjects SET visible=0 WHERE partition_no=ANY($1)', [occupied]);
  }
});

test('Subject validation keeps its PIT coverage for a generic advance only with an exact settled home proof', async () => {
  const home = 71;
  const id = newId(home * 16);
  const head = async () =>
    (
      await pool.query<{ epoch: number; position: string }>(
        'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [home],
      )
    ).rows[0]!;
  const read = async () => ({
    partition: home,
    position: BigInt((await head()).position),
    subjects: [
      {
        id,
        type: 'schema:Book',
        visibility: 'visible' as const,
        redirect: null,
        securityRevision: 1,
        labels: [{ language: 'en', value: 'Retained Subject' }],
        aliases: [],
        descriptions: [],
        statements: [],
      },
    ],
  });
  const f = await fixture(
    {
      async read({ partition }) {
        const { epoch, position } = await head();
        return {
          status: 'eligible',
          partition,
          epoch,
          position: BigInt(position),
          ids: [id],
          after: null,
          complete: true,
          cost: zero,
        };
      },
    },
    { read, readForIndex: read, count: async () => ({ position: (await read()).position, count: 1 }) },
  );
  const index = subjectIndexName(f.prefix, 2);
  try {
    const prepared = await f.operations.prepare(f.registered.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const job = prepared.job.job;
    const step = () => f.operations.step(prepared.job, context());
    const state = async () =>
      (await pool.query('SELECT phase,home FROM search.generation_publication WHERE partition_no=0 AND job=$1', [job]))
        .rows[0];
    const validate = () =>
      pool.query("UPDATE search.generation_publication SET phase='validate',home=64 WHERE partition_no=0 AND job=$1", [
        job,
      ]);
    const advance = () => pool.query('UPDATE core.partition SET position=position+1 WHERE partition_no=$1', [home]);
    await pool.query('UPDATE core.partition SET position=position+3 WHERE partition_no=$1', [home]);
    await pool.query('UPDATE semantic.partition_subjects SET visible=1 WHERE partition_no=$1', [home]);
    await pool.query(
      `INSERT INTO search.identity_writer
       (partition_no,physical_target,original_id,incarnation,owner_epoch,dispatch_state,writer_transaction_id,
        writer_position,source_position,visible_transaction_id,visible_position,settled_transaction_id,settled_position)
       SELECT partition_no,$2,$3,$4,epoch,'settled',$5,position-2,position-2,$6,position,$6,position
       FROM core.partition WHERE partition_no=$1`,
      [home, index, id, f.registered.consumer.incarnation, crypto.randomUUID(), crypto.randomUUID()],
    );
    const snapshot = await read();
    const actions = await prepareBoundedSortKeys(
      search,
      index,
      documentActions({ ...snapshot, position: snapshot.position - 2n }, [id], new Map()),
    );
    await writeIndexActions(search, index, actions);
    await pool.query(
      `INSERT INTO search.generation_publication_home (partition_no,job,pass,epoch,position)
       SELECT partition_no,$1,1,epoch,position FROM core.partition`,
      [job],
    );
    await validate();
    await advance();
    expect(await step()).toMatchObject({ status: 'progress' });
    expect(await state()).toEqual({ phase: 'validate', home: 320 });
    expect(
      (
        await pool.query(
          'SELECT position::text FROM search.generation_publication_home WHERE partition_no=$1 AND job=$2',
          [home, job],
        )
      ).rows[0],
    ).toEqual({ position: (await head()).position });

    // A native extra in this home must still send validation through a fresh PIT.
    const extra = newId(home * 16);
    const extraSubject = { ...snapshot.subjects[0]!, id: extra };
    await writeIndexActions(
      search,
      index,
      await prepareBoundedSortKeys(
        search,
        index,
        documentActions({ ...snapshot, subjects: [extraSubject] }, [extra], new Map()),
      ),
    );
    await validate();
    await advance();
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(await state()).toEqual({ phase: 'subject', home });

    await writeIndexActions(search, index, [{ op: 'delete', id: extra, version: snapshot.position + 1n }]);
    await validate();
    await advance();
    await pool.query(
      `UPDATE search.identity_writer SET visible_position=$4,settled_position=$4
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
      [home, index, id, (await head()).position],
    );
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(await state()).toEqual({ phase: 'subject', home });
  } finally {
    await f.operations.close();
    await pool.query('UPDATE semantic.partition_subjects SET visible=0 WHERE partition_no=$1', [home]);
  }
});

test('scheduled preparation resumes its stored publication and advances four metered native turns', async () => {
  await bootstrapRelease(pool, bundledRelease);
  const f = await fixture({
    async read({ partition }) {
      const {
        rows: [home],
      } = await pool.query<{ epoch: number; position: string }>(
        'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [partition],
      );
      return {
        status: 'eligible',
        partition,
        epoch: home!.epoch,
        position: BigInt(home!.position),
        ids: [],
        after: null,
        complete: true,
        cost: zero,
      };
    },
  });
  const work = await createWorkClient(databaseUrl!);
  await work.registerQueue('maintenance', WORK_QUEUES.maintenance);
  const store = createPublicPreparationStore(pool, work, f.prefix);
  let prepares = 0;
  const runtime = {
    async preparePublication() {
      prepares++;
      return f.operations.prepare(f.registered.consumer, context());
    },
    publication: f.operations,
  } as unknown as DefaultPublicFilterRuntime;
  const mappingRequests: string[] = [];
  const schedulerSearch: typeof search = {
    ...search,
    request(method, path, ...args) {
      if (path.endsWith('/_mapping')) mappingRequests.push(method);
      return search.request(method, path, ...args);
    },
  };
  const start = (selected = runtime) =>
    createPublicPreparation({
      pool,
      work,
      prefix: f.prefix,
      search: schedulerSearch,
      source: {} as PublicPreparationOptions['source'],
      listing: {} as PublicPreparationOptions['listing'],
      runtime: selected,
    });
  const state: PopulationFrontier = {
    kind: 'population',
    key: '2',
    generation: 2,
    uuid: f.registered.consumer.incarnation,
    meaning: (await activeRelease(pool))!.digest,
    publication: null,
    partition: 0,
    epoch: null,
    through: null,
    after: null,
    phase: 'scan',
    pending: null,
  };
  const id = await store.retain(state, Date.now() + 60_000);
  const read = async () =>
    (
      await pool.query<{ revision: string; locator: PopulationFrontier }>(
        'SELECT revision::text,locator FROM search.public_preparation WHERE partition_no=0 AND id=$1',
        [id],
      )
    ).rows[0]!;
  let maintenance = start();
  try {
    // Simulate interruption after native prepare committed but before the scheduler saved its ID.
    const original = await f.operations.prepare(f.registered.consumer, context());
    if (original.status !== 'preparing') throw new Error(original.reason);
    await maintenance.run(id, (await read()).revision);
    const retained = (await read()).locator.publication;
    if (retained === null) throw new Error('The original publication was not retained');
    expect(retained).toBe(original.job.job);
    await maintenance.stop();
    maintenance = start();
    const readHome = async () =>
      (
        await pool.query<{ home: number }>(
          'SELECT home FROM search.generation_publication WHERE partition_no=0 AND job=$1',
          [retained],
        )
      ).rows[0]!.home;
    const before = await read();
    const previousHome = await readHome();
    await maintenance.run(id, before.revision);
    expect(prepares).toBe(0);
    const next = await read();
    expect(next.locator).toMatchObject({ publication: retained, phase: 'native' });
    expect(BigInt(next.revision)).toBe(BigInt(before.revision) + 8n);
    const continuation = await pool.query('SELECT status,queue_name FROM dbos.workflow_status WHERE workflow_uuid=$1', [
      `search.publicPreparation:${id}:${next.revision}:population`,
    ]);
    expect(continuation.rows).toEqual([{ status: 'ENQUEUED', queue_name: 'workflows' }]);
    expect(await readHome()).toBeGreaterThan(previousHome);
    expect((await subjectGenerations(search, f.prefix)).active).toBe(1);

    await maintenance.stop();
    const claimed = await store.claim(id, next.revision, Date.now() + 30_000);
    if (!claimed) throw new Error('The original publication successor was not ready');
    await store.retain(state, Date.now() + 60_000);
    await store.due();
    const leased = await pool.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [
      `search.publicPreparation:${id}:${claimed.revision}:population`,
    ]);
    expect(leased.rows).toEqual([]);
    const activation = await store.advance(claimed, { ...next.locator, phase: 'activate' });
    if (!activation) throw new Error('The original publication activation could not be retained');
    const repaired: string[] = [];
    maintenance = start({
      ...runtime,
      publication: {
        ...f.operations,
        async activate(job) {
          repaired.push(job.job);
          return { status: 'preparing', job, next: 'activate', advanced: true, cost: zero };
        },
      },
    });
    await maintenance.run(id, activation);
    expect(repaired).toEqual(Array.from({ length: 4 }, () => retained));
    expect(mappingRequests).toEqual([]);
    const pending = await read();
    expect(BigInt(pending.revision)).toBe(BigInt(activation) + 8n);
    expect(pending.locator).toMatchObject({ phase: 'activate', publication: retained });
    const ready = await pool.query('SELECT status,queue_name FROM dbos.workflow_status WHERE workflow_uuid=$1', [
      `search.publicPreparation:${id}:${pending.revision}:population`,
    ]);
    expect(ready.rows).toEqual([{ status: 'ENQUEUED', queue_name: 'workflows' }]);
  } finally {
    await maintenance.stop();
    await pool.query('DELETE FROM search.public_preparation WHERE partition_no=0 AND id=$1', [id]);
    const workflows = (
      await pool.query<{ workflow_uuid: string }>(
        'SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid LIKE $1',
        [`search.publicPreparation:${id}:%`],
      )
    ).rows.map((row) => row.workflow_uuid);
    if (workflows.length) await work.deleteWorkflows(workflows, false);
    await work.close();
    await f.operations.close();
  }
});
