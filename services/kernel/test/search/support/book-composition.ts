import assert from 'node:assert/strict';
import { BOOK_CATALOGUE_TYPES } from '@rezics/definitions/contract';
import { planReads, platformRegistry } from '@rezics/composition';
import type { Subject } from '../../../../../specs/semantic-driver.ts';
import { withBoundedReadConnection } from '../../../src/database/pool.ts';
import { readSubjectIndexUuid, subjectAlias, subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../../src/search/opensearch.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../../support/released-discovery.ts';
import {
  composedLimitDocument,
  publishTypeLists,
  requireStatus,
  type TypeListRead,
} from '../../performance/support/composed-discovery-fixtures.ts';
import { readPublicationJobs } from './outcome-worker.ts';

const route = '/book-catalogue-cost';
const lists: TypeListRead[] = BOOK_CATALOGUE_TYPES.flatMap((type, i) =>
  [6, 7, 8, 9, 10].map((limit) => ({ id: `books-${i}-${limit}`, types: [type], limit })),
);
lists.push({ id: 'all-grains', types: BOOK_CATALOGUE_TYPES, limit: 8 });
const document = composedLimitDocument(lists);
const plan = planReads(platformRegistry, document, { subject: null });
type Anchor = { id: string; type: string };
type Original = Anchor & { label: string };
const marker = 'cataloguepublication';

export async function createBookComposition(setupDeadline: number) {
  let database: GrowthDatabase | undefined;
  let owner: ReleasedDiscoveryFixture | undefined;
  try {
    const fixture = await createReleasedDiscoveryFixture({
      version: 1,
      search: 'native',
      async kernelPool(url) {
        // The installed worker has its own checkout. Include it in the same native capture.
        if (database) {
          assert.equal(database.url, url);
          return database.openPool(database.pool.options);
        }
        database = await openGrowthDatabase(url);
        const { pool, admin } = database;
        const end = pool.end.bind(pool);
        // The fixture drops its database immediately after closing the application pool.
        pool.end = async () => {
          try {
            await admin.end();
          } finally {
            await end();
          }
        };
        return pool;
      },
    });
    owner = fixture;
    assert(database && fixture.search);
    const { pool } = database;
    const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
    const prefix = fixture.search.indexPrefix;
    const index = subjectAlias(prefix);
    const publicationJobs = (deadline: number) =>
      withBoundedReadConnection(pool, deadline, (connection) => readPublicationJobs(connection, prefix));

    async function waitForPublication(ids: readonly string[], until: number, originals?: readonly Original[]) {
      async function count(target: string, signal?: AbortSignal) {
        const { body } = await engine.request<{ count: number; _shards: { failed: number } }>(
          'POST',
          `/${target}/_count`,
          { query: { ids: { values: ids } } },
          signal ? { signal } : undefined,
        );
        assert.equal(body._shards.failed, 0);
        return body.count;
      }

      async function observeGenerations(deadline: number) {
        try {
          const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
          const { active, generations } = await subjectGenerations(engine, prefix, undefined, signal);
          const [physical, jobs] = await Promise.all([
            Promise.all(
              generations.map(async (generation) => ({
                generation,
                matched: await count(subjectIndexName(prefix, generation), signal).catch(String),
              })),
            ),
            publicationJobs(deadline).then(
              (jobs) => jobs.map(({ consumer: _consumer, ...job }) => job),
              String,
            ),
          ]);
          return { active, physical, jobs };
        } catch (error) {
          return { inventoryError: String(error) };
        }
      }

      const signal = AbortSignal.timeout(Math.max(1, until - Date.now()));
      let alias: number | 'HTTP 404' | undefined;
      let lastPublicRead: { status: number; missing?: string[]; code?: unknown } | undefined;
      let observed: Awaited<ReturnType<typeof observeGenerations>> | undefined;
      while (Date.now() < until) {
        let disclosed = originals === undefined;
        if (originals) {
          const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
            text: marker,
            languages: ['en'],
          });
          if (Date.now() >= until) break;
          if (response.status === 200) {
            const subjects = response.body.subjects;
            assert(Array.isArray(subjects));
            const missing = originals
              .filter(({ id, type, label }) =>
                !subjects.some((entry) => entry.id === id && entry.type === type && entry.labels.en === label),
              )
              .map(({ id }) => id);
            lastPublicRead = { status: response.status, missing };
            disclosed = missing.length === 0;
          } else {
            lastPublicRead = { status: response.status, code: response.body.code };
            assert(
              response.status === 503 && ['index_not_ready', 'semantic_not_ready'].includes(String(response.body.code)),
              JSON.stringify(lastPublicRead),
            );
          }
        }
        try {
          alias = await count(index, signal);
        } catch (error) {
          if (signal.aborted) break;
          if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
          alias = 'HTTP 404';
        }
        if (disclosed && alias === ids.length) {
          const { active } = await subjectGenerations(engine, prefix, undefined, signal);
          assert(active === 1, 'The isolated Subject alias must resolve to its first native generation');
          const uuid = await readSubjectIndexUuid(engine, prefix, active);
          const target = subjectIndexName(prefix, active);
          const publication = (await publicationJobs(until)).find(
            (job) =>
              job.family === 'subjects' &&
              job.generation === String(active) &&
              job.physical_target === target &&
              job.native_incarnation === uuid &&
              job.meaning_digest === fixture.release.digest &&
              job.phase === 'active' &&
              job.fenced_pass &&
              !job.fenced &&
              job.source_sealed &&
              job.source_ack_after === 4096,
          );
          if (publication && Date.now() < until) return { generation: active, uuid, job: publication.job };
        }
        const remaining = until - Date.now();
        if (remaining <= 0) break;
        // Capture the physical projection and the owner frontier while the wait still has time.
        if (remaining <= 5_000 && !observed) observed = await observeGenerations(Math.min(until, Date.now() + 2_000));
        await Bun.sleep(Math.min(250, Math.max(0, until - Date.now())));
      }
      throw new Error(
        `Search publication did not settle for ${ids.length} originals before the deadline ` +
          `(alias: ${alias ?? 'unobserved'}, public Search: ${JSON.stringify(lastPublicRead ?? null)}, ` +
          `generation snapshot: ${JSON.stringify(observed ?? null)})`,
      );
    }
    const originals: Original[] = [];
    async function createAnchor(type: string, name: string, readBack: boolean) {
      assert(Date.now() < setupDeadline, 'Book catalogue setup expired before Subject creation');
      const created = await fixture.createSubject(type, readBack ? `${name} ${marker}` : name);
      const anchor = { id: created.id, type };
      if (readBack) {
        const response = requireStatus(await fixture.read(created), 200, 'Read the original public Subject');
        const subject = response.body.subject as Subject;
        assert.equal(subject.id, created.id);
        assert.equal(subject.type, type);
        const label = subject.labels.en;
        assert(typeof label === 'string' && label.startsWith(`${name} ${marker}`));
        originals.push({ ...anchor, label });
      }
      return anchor;
    }

    // Use the same three authored grains as the Book journey for initial publication.
    // The installed worker owns Source repair and activation while the anonymous read waits.
    for (const [grain, type] of BOOK_CATALOGUE_TYPES.entries()) await createAnchor(type, `AAA ${grain} 00`, true);
    const published = await waitForPublication(originals.map(({ id }) => id), setupDeadline, originals);

    const anchors: Anchor[] = [];
    for (const [grain, type] of BOOK_CATALOGUE_TYPES.entries()) {
      anchors.push(originals[grain]!);
      for (let ordinal = 1; ordinal < 11; ordinal++) {
        anchors.push(await createAnchor(type, `AAA ${grain} ${String(ordinal).padStart(2, '0')}`, false));
      }
    }
    const hidden = await createAnchor('schema:Book', 'AAA 0 00 concealed', true);
    assert.deepEqual(
      await waitForPublication([...anchors, hidden].map(({ id }) => id), setupDeadline, originals),
      published,
    );
    await fixture.grant('editor', ['moderation:hide'], hidden.id);
    requireStatus(
      await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${hidden.id}:hide`,
        { reason: 'Withhold the catalogue entry' },
        discoveryKey(),
      ),
      200,
      'Hide the indexed Book',
    );
    await publishTypeLists(fixture, [{ route, document }]);
    assert(Date.now() < setupDeadline, 'Book catalogue setup expired while publishing TypeLists');
    const request = (who: 'alice' | 'anonymous' | 'suspended') =>
      fixture.request(who, 'POST', '/v1/pages:read', { target: { route }, languages: ['en'] });
    async function read(who: 'alice' | 'anonymous', warm = false) {
      const until = Date.now() + 120_000;
      for (;;) {
        const response = await request(who);
        const reads = response.body.reads as
          | Record<string, { status: number; body: Record<string, unknown> }>
          | undefined;
        const pending = response.status === 200 ? Object.values(reads ?? {}) : [response];
        if (warm && pending.some(({ status }) => status === 503)) {
          for (const entry of pending.filter(({ status }) => status !== 200))
            assert(
              entry.status === 503 && ['index_not_ready', 'semantic_not_ready'].includes(String(entry.body.code)),
              JSON.stringify(entry),
            );
          assert(Date.now() < until, 'Released TypeLists did not become ready');
          await Bun.sleep(100);
          continue;
        }
        requireStatus(response, 200, 'Read the published catalogue composition');
        assert.deepEqual(response.body.document, document);
        assert(reads);
        assert.deepEqual(Object.keys(reads).sort(), Object.keys(plan.reads).sort());
        assert(!JSON.stringify(response.body).includes(hidden.id));
        let outputSlots = 0;
        for (const list of lists) {
          const result = reads[plan.nodes[list.id]!]!;
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const subjects = result.body.subjects;
          assert(Array.isArray(subjects));
          outputSlots += subjects.length;
          assert.deepEqual(
            subjects.map(({ id, type }) => ({ id, type })),
            anchors.filter(({ type }) => list.types.includes(type)).slice(0, list.limit),
          );
          assert(typeof result.body.next === 'string' && result.body.next.length > 0);
          for (const field of ['total', 'count', 'relation', 'indexed_estimate'])
            assert(!Object.hasOwn(result.body, field));
        }
        return outputSlots;
      }
    }
    const population = new Set<string>();
    return {
      database,
      read,
      async denied() {
        const response = requireStatus(await request('suspended'), 401, 'Read with revoked credentials');
        assert.equal(response.body.code, 'invalid_credentials');
        assert(!Object.hasOwn(response.body, 'reads'));
      },
      async grow(from: number, to: number) {
        assert.equal(population.size, from);
        for (let ordinal = from; ordinal < to; ordinal++) {
          const subject = await fixture.createSubject(
            BOOK_CATALOGUE_TYPES[ordinal % BOOK_CATALOGUE_TYPES.length]!,
            `ZZZ catalogue ${ordinal}`,
          );
          population.add(subject.id);
        }
        assert.equal(population.size, to);
        assert.deepEqual(await waitForPublication([...population], Date.now() + 120_000), published);
      },
      close: () => fixture.close(),
    };
  } catch (error) {
    try {
      await owner?.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Book catalogue setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
