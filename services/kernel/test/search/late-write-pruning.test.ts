import { expect, test } from 'bun:test';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import type { Access } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import type { SubjectDocument } from '../../src/search/document.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { SubjectSnapshot, SubjectSource } from '../../src/search/source.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the migrated check database and native node');

type Metadata = { _index: string; _id: string; version: number; version_type: string };
type Item = { _id: string; _index: string; _version: number; status: number; error?: { type: string } };
type Bulk = { errors: boolean; items: { index?: Item; delete?: Item }[] };
type Schedule = 'pruned tombstone' | 'checkpoint loss before dispatch' | 'checkpoint loss after applied response';

function barrier() {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { held: held.promise, enter: held.resolve, wait: release.promise, release: release.resolve };
}
async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), 5_000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only disposable engine instrumentation uses invented IDs/versions. Public subjects always
// use native commands, snapshots and createSubjectIndexer -> projectBatch -> external writes.
async function pruneDeletes(search: OpenSearch, index: string) {
  const probe = (op: 'index' | 'delete', version: number) => ({
    [op]: { _index: index, _id: 'retention-probe', version, version_type: 'external' },
  });
  const apply = (lines: unknown[]) => search.bulk<Bulk>(lines, { query: { refresh: true } });
  expect((await apply([probe('index', 1), {}])).items[0]!.index!.status).toBe(201);
  expect((await apply([probe('delete', 2)])).items[0]!.delete!.status).toBe(200);
  const retained = (await apply([probe('index', 1), {}])).items[0]!.index!;
  expect(retained.status).toBe(409);
  expect(retained.error?.type).toBe('version_conflict_engine_exception');

  // Native InternalEngine.flush prunes deleted tombstones using the processed checkpoint
  // and gc_deletes cutoff (OpenSearch 3.9.0 InternalEngine.java:1719-1723,1753-1778).
  // One primary, no replicas: the subject deletion precedes the probe deletion on this
  // same engine. Force a flush after expiry; observe 409 -> 201, never infer GC from sleep.
  await search.request('PUT', `/${index}/_settings`, { index: { gc_deletes: '0ms' } });
  await Bun.sleep(10);
  await search.request('POST', `/${index}/_flush`, undefined, { query: { force: true, wait_if_ongoing: true } });
  const pruned = (await apply([probe('index', 1), {}])).items[0]!.index!;
  expect(pruned.status).toBe(201);
  return { retained, pruned };
}

async function scenario(mode: 'hide' | 'takedown', schedule: Schedule, partition: number) {
  const pool = createPool(databaseUrl!);
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const search = createOpenSearch(searchUrl!);
  const prefix = `late-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const consumer = subjectConsumer(prefix, 1);
  const winnerConsumer = schedule === 'pruned tombstone' ? `${consumer}_b` : consumer;
  const seedConsumer = `${consumer}_s`;
  const gate = barrier();
  const owned: Promise<unknown>[] = [];
  let createdIndex = false;
  let failed = false;
  try {
    const route = partition * 16;
    const id = newId(route);
    const routeKey = new Uint8Array(32).fill(74);
    const native = subjectSource(pool, routeKey);
    const listing = subjectListingSource(pool);
    const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
    const actions = ['subject:create', 'moderation:hide', 'moderation:takedown'];
    const real = await createRealAccess(admin, { editor: newId(0) }, actions);
    let access!: Access;
    const kernel = createKernel({
      pool,
      routeKey,
      tokens,
      access(config) {
        return (access = real.access(config));
      },
      writeRate: real.writeRate,
      search: createSearchService({ pool, client: search, prefix, source: native, cursors: tokens }),
    });
    await bootstrapRelease(pool, bundledRelease);
    for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    await kernel.handle(new Request(`http://kernel.test/v1/definitions/releases/${bundledDigest}`));
    const deadline = deadlineFor(5000);
    const actor = await access.authenticate(real.bearer('editor'), { pool, deadline });
    if (actor.kind !== 'account') throw new Error('Expected authenticated native editor');
    const created = await createSubject(pool, {
      actor,
      target: { route, id },
      idempotencyKey: crypto.randomUUID(),
      digest: new Uint8Array(32).fill(7),
      item: { type: 'schema:Book', labels: { en: 'Late native subject' } },
      release: { digest: bundledDigest, release: bundledRelease },
      deadline,
      authorization: resourceAuthorization({
        access,
        actor,
        action: 'subject:create',
        anchor: globalContextAnchor,
        context: { pool, deadline, partition },
      }),
    });
    expect(created.subject.id).toBe(id);
    expect(created.component.partition).toBe(partition);

    await createSubjectIndex(search, prefix, 1);
    createdIndex = true;
    await search.request('PUT', `/${index}/_settings`, { index: { gc_deletes: '1h' } });
    await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    async function identity() {
      const result = await search.request<
        Record<string, { settings: { index: { uuid: string; number_of_shards: string; number_of_replicas: string } } }>
      >('GET', `/${index}/_settings`);
      const settings = result.body[index]!.settings.index;
      expect(settings.number_of_shards).toBe('1');
      expect(settings.number_of_replicas).toBe('0');
      expect(settings.uuid).toBeString();
      return settings.uuid;
    }
    const uuid = await identity();
    async function checkpoint(name: string) {
      return (
        (
          await admin.query<{ position: string }>(
            'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
            [name, partition],
          )
        ).rows[0]?.position ?? null
      );
    }
    async function publicIds() {
      const response = await kernel.handle(
        new Request('http://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'Late native subject', limit: 10 }),
        }),
      );
      const body = (await response.json()) as { subjects: { id: string }[] };
      expect([response.status, body]).toEqual([200, expect.objectContaining({ subjects: expect.any(Array) })]);
      return body.subjects.map((subject) => subject.id);
    }
    async function physical() {
      return (
        await search.request<{ hits: { hits: { _id: string; _version: number; _source: SubjectDocument }[] } }>(
          'POST',
          `/${index}/_search`,
          { version: true, query: { ids: { values: [id] } } },
        )
      ).body.hits.hits;
    }
    const relay = (transport: OpenSearch, source: SubjectSource, name: string) =>
      createSubjectIndexer({
        pool,
        search: transport,
        source,
        listing,
        index,
        consumer: name,
      });
    // Pre-dispatch cases start with a genuinely indexed public document. For the
    // post-response schedule the held request itself supplies the positive native write.
    if (schedule !== 'checkpoint loss after applied response') {
      expect((await relay(search, native, seedConsumer).run(partition)).status).toBe('read');
      expect(await publicIds()).toEqual([id]);
    }
    const snapshots: SubjectSnapshot[] = [];
    const source: SubjectSource = {
      ...native,
      async read(home, ids) {
        expect(home).toBe(partition);
        expect(ids).toEqual([id]);
        expect(ids.length).toBeLessThanOrEqual(256);
        const snapshot = await native.read(home, ids);
        snapshots.push(snapshot);
        return snapshot;
      },
    };
    let oldLines: readonly unknown[] = [];
    let oldResponse: Bulk | undefined;
    let calls = 0;
    const transport: OpenSearch = {
      request: search.request,
      async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]): Promise<T> {
        expect(++calls).toBe(1);
        oldLines = lines;
        if (schedule !== 'checkpoint loss after applied response') {
          gate.enter();
          await gate.wait;
        }
        const response = await search.bulk<Bulk>(lines, options);
        oldResponse = response;
        if (schedule === 'checkpoint loss after applied response') {
          gate.enter();
          await gate.wait;
        }
        return response as T;
      },
    };
    const oldRun = relay(transport, source, consumer).run(partition);
    // Attach rejection handling immediately; teardown releases and drains the real operation.
    const oldOutcome = oldRun.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    owned.push(oldOutcome);
    await within(
      Promise.race([
        gate.held,
        oldRun.then(() => {
          throw new Error('Old writer never reached bulk barrier');
        }),
      ]),
      'Old native writer did not reach bulk barrier',
    );
    expect(snapshots).toHaveLength(1);
    const old = snapshots[0]!;
    expect(old.subjects[0]!.visibility).toBe('visible');
    expect(oldLines).toHaveLength(2);
    expect((oldLines[0] as { index: Metadata }).index).toEqual({
      _index: index,
      _id: id,
      version: Number(old.position),
      version_type: 'external',
    });
    expect(await checkpoint(consumer)).toBe('0');
    if (schedule === 'checkpoint loss after applied response') {
      expect(oldResponse!.items[0]!.index!.status).toBe(201);
      expect((await physical())[0]!._version).toBe(Number(old.position));
      expect(await publicIds()).toEqual([id]);
    }

    const hiddenResponse = await kernel.handle(
      new Request(`http://kernel.test/v1/subjects/${id}:${mode}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${crypto.randomUUID()}"`,
        },
        body: JSON.stringify(
          mode === 'hide'
            ? { reason: 'spam' }
            : {
                notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
              },
        ),
      }),
    );
    expect([hiddenResponse.status, await hiddenResponse.json()]).toEqual([200, expect.anything()]);
    expect(real.checks.some((check) => check.action === `moderation:${mode}`)).toBe(true);
    const hidden = await native.read(partition, [id]);
    expect(hidden.position).toBeGreaterThan(old.position);
    expect(hidden.subjects[0]!.visibility).toBe(mode === 'hide' ? 'hidden' : 'taken_down');
    expect(hidden.subjects[0]!.securityRevision).toBeGreaterThan(old.subjects[0]!.securityRevision);
    expect(await publicIds()).toEqual([]);

    let removal: Bulk | undefined;
    let removalLines: readonly unknown[] = [];
    const winner: OpenSearch = {
      request: search.request,
      async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]): Promise<T> {
        removalLines = lines;
        removal = await search.bulk<Bulk>(lines, options);
        return removal as T;
      },
    };
    const newer = await relay(winner, native, winnerConsumer).run(partition);
    expect(newer.status).toBe('read');
    expect(removalLines).toEqual([
      {
        delete: {
          _index: index,
          _id: id,
          version: Number(hidden.position),
          version_type: 'external',
        },
      },
    ]);
    expect(removal!.errors).toBe(false);
    expect(removal!.items[0]!.delete!.status).toBe(200);
    expect(removal!.items[0]!.delete!._version).toBe(Number(hidden.position));
    const winningCheckpoint = await checkpoint(winnerConsumer);
    expect(winningCheckpoint).toBe(String(hidden.position));
    expect(await physical()).toEqual([]);
    expect(await publicIds()).toEqual([]);

    const pruning = await pruneDeletes(search, index);
    expect(await physical()).toEqual([]);
    expect(await identity()).toBe(uuid); // No recreation, alias replacement or implicit auto-creation.
    gate.release();
    const outcome = await oldOutcome;
    expect(await identity()).toBe(uuid);
    const current = await native.read(partition, [id]);
    expect(current.position).toBe(hidden.position);
    expect(current.subjects).toEqual(hidden.subjects);
    expect(await checkpoint(winnerConsumer)).toBe(winningCheckpoint);
    // Observe both surfaces before asserting, so the red receipt distinguishes physical
    // resurrection from the current disclosure layer's successful suppression.
    if (schedule !== 'pruned tombstone' && 'value' in outcome) expect(outcome.value.status).toBe('busy');
    const publicAfter = await publicIds();
    const physicalAfter = await physical();
    console.log(
      JSON.stringify(
        {
          mode,
          schedule,
          id,
          uuid,
          oldVersion: String(old.position),
          removalVersion: String(hidden.position),
          removal,
          pruning,
          oldResponse,
          outcome,
          winningCheckpoint,
          publicAfter,
          physicalAfter,
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
      ),
    );
    expect(publicAfter).toEqual([]);
    expect(physicalAfter).toEqual([]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    gate.release();
    await Promise.allSettled(owned);
    const cleanupErrors: unknown[] = [];
    async function clean(operation: () => Promise<unknown>, absentAllowed = false) {
      try {
        await operation();
      } catch (error) {
        if (!(absentAllowed && error instanceof OpenSearchError && error.status === 404)) cleanupErrors.push(error);
      }
    }
    if (createdIndex) await clean(() => search.request('DELETE', `/${index}`));
    for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
      await clean(() => search.request('DELETE', `/_scripts/${prefix}${template}`), true);
    await clean(() =>
      admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1::text[]) AND partition_no=$2', [
        [consumer, winnerConsumer, seedConsumer],
        partition,
      ]),
    );
    await clean(() => pool.end());
    await clean(() => admin.end());
    if (cleanupErrors.length) {
      if (failed) console.error('Native cleanup failed after scenario failure', cleanupErrors);
      else throw new AggregateError(cleanupErrors, 'Native cleanup failed');
    }
  }
}

for (const [modeIndex, mode] of (['hide', 'takedown'] as const).entries())
  for (const [scheduleIndex, schedule] of (
    ['pruned tombstone', 'checkpoint loss before dispatch', 'checkpoint loss after applied response'] as const
  ).entries())
    test(
      `a delayed old native write cannot resurrect a ${mode === 'hide' ? 'hidden' : 'taken-down'} subject after ${schedule}`,
      () => scenario(mode, schedule, 280 + modeIndex * 3 + scheduleIndex),
      30_000,
    );
