import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BatchResult } from '../../src/events/log.ts';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import { createSubjectProjectionCoordinator, type IndexIncarnation } from '../../src/search/coverage.ts';
import { documentActions } from '../../src/search/document.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';
import { populateControlledSubjects } from './support/controlled-population.ts';
import { createCoverageFixture } from './coverage-fixture.ts';
import type { ChildCommand, ChildMessage, Gate } from './coverage-worker-child.ts';

let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  // Shared fixture first proves genuine Access/command/source/engine operation, before any unavailable port.
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => f?.close(), 180_000);

async function until(predicate: () => boolean | Promise<boolean>, message: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

async function writer(incarnation: IndexIncarnation, gate: Gate | null = null) {
  const child = fork(fileURLToPath(new URL('./coverage-worker-child.ts', import.meta.url)), [], {
    execPath: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  let diagnostics = '';
  child.stdout!.on('data', (data) => (diagnostics = (diagnostics + String(data)).slice(-65_536)));
  child.stderr!.on('data', (data) => (diagnostics = (diagnostics + String(data)).slice(-65_536)));
  const events: ChildMessage[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  function failed(error: Error) {
    failure = error;
    for (const wait of pending.values()) wait.reject(error);
    pending.clear();
  }
  child.on('error', failed);
  child.on('disconnect', () => failed(new Error(`Writer disconnected: ${diagnostics}`)));
  const exit = new Promise<void>((resolve) =>
    child.once('close', () => {
      failed(new Error(`Writer exited (${child.exitCode}/${child.signalCode}): ${diagnostics}`));
      resolve();
    }),
  );
  child.on('message', (input: unknown) => {
    const message = input as ChildMessage;
    if (message.event) events.push(message);
    if (message.id === undefined) return;
    const wait = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) wait?.reject(new Error(message.error));
    else wait?.resolve(message.value);
  });
  function call(
    command:
      | Omit<Extract<ChildCommand, { op: 'run' }>, 'id'>
      | { op: 'release' | 'close' }
      | { op: 'open'; incarnation: IndexIncarnation; gate: Gate | null },
  ) {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Writer ${command.op} deadline: ${diagnostics}`));
      }, 180_000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send({ ...command, id }, (error) => {
        if (error) failed(error);
      });
    });
  }
  async function close() {
    try {
      if (child.connected && !failure) await call({ op: 'close' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
  }
  try {
    const opened = (await call({ op: 'open', incarnation, gate })) as { pid: number };
    expect(opened.pid).toBe(child.pid!);
    return {
      pid: opened.pid,
      events,
      close,
      run: (partition: number) => call({ op: 'run', partition }) as Promise<BatchResult>,
      release: () => call({ op: 'release' }),
      async held() {
        await until(() => {
          if (failure) throw failure;
          return events.some((event) => event.event === 'gate');
        }, 'No native transport boundary');
        return events.find((event) => event.event === 'gate')!.value as { data: unknown[] };
      },
      async crash() {
        child.kill('SIGKILL');
        await exit;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function checkpoint(i: IndexIncarnation, partition: number) {
  return (
    await f.admin.query(
      'SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
      [partition, i.consumer],
    )
  ).rows;
}
async function unavailable(i: IndexIncarnation) {
  const coordinator = createSubjectProjectionCoordinator(f.options(i.prefix));
  expect((await coordinator.certify(i, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
  expect((await f.read(i.prefix)).state).toBe('not_ready');
}
async function home(i: IndexIncarnation, partition: number) {
  const row = await createCoverageStore(f.pool).readHome(i, partition);
  expect(row).not.toBeNull();
  return row!;
}
async function hits(i: IndexIncarnation, ids: string[]) {
  const result = await f.search.request<{ hits: { hits: { _id: string; _version: number }[] } }>(
    'POST',
    `/${i.index}/_search`,
    {
      size: ids.length,
      version: true,
      query: { ids: { values: ids } },
    },
  );
  return result.body.hits.hits;
}
async function recovery(i: IndexIncarnation, original: string, survivor: string) {
  const next = await populateControlledSubjects(f.options(i.prefix), {
    generation: i.generation + 1,
    deadline: Date.now() + 90_000,
  });
  expect(next.incarnation.index).not.toBe(i.index);
  expect(next.incarnation.uuid).not.toBe(i.uuid);
  expect((await f.read(i.prefix)).state).toBe('ready');
  expect((await hits(next.incarnation, [original, survivor])).map((hit) => hit._id)).toEqual([survivor]);
  return next.incarnation;
}

// A disposable single-shard engine probe, never a public subject or a permanent tombstone.
// Same settings as the guarded target. Acceptance of version 1 after delete version 2 is
// observable pruning; elapsed time alone cannot satisfy this schedule.
async function pruneProbe() {
  const index = `coverage-writer-probe-${crypto.randomUUID()}`;
  await f.search.request('PUT', `/${index}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0, 'index.gc_deletes': '1h' },
  });
  try {
    const metadata = (op: 'index' | 'delete', id: string, version: number) => ({
      [op]: { _index: index, _id: id, version, version_type: 'external' },
    });
    const apply = (lines: unknown[]) =>
      f.search.bulk<{ items: Record<string, { status: number }>[] }>(lines, { query: { refresh: true } });
    await apply([metadata('index', 'retention-probe', 1), { probe: true }]);
    const deletion = await apply([metadata('delete', 'retention-probe', 2)]);
    expect(deletion.items[0]!.delete!.status).toBe(200);
    const retained = await apply([metadata('index', 'retention-probe', 1), { probe: true }]);
    expect(retained.items[0]!.index!.status).toBe(409);
    await f.search.request('PUT', `/${index}/_settings`, { index: { gc_deletes: '100ms' } });
    let pruned = false;
    await until(async () => {
      // Real writes drive InternalEngine.maybePruneDeletes; the low-version attempt observes its result.
      await apply([metadata('index', 'gc-driver', Date.now()), { probe: true }]);
      const response = await apply([metadata('index', 'retention-probe', 1), { probe: true }]);
      const status = response.items[0]!.index!.status;
      expect([201, 409]).toContain(status);
      pruned = status === 201;
      return pruned;
    }, 'Engine did not demonstrate actual delete-version pruning');
    expect(pruned).toBe(true);
  } finally {
    await f.search.request('DELETE', `/${index}`);
  }
}

async function sameHomeKey(partition: number) {
  for (let n = 0; n < 1_000_000; n++) {
    const key = crypto.randomUUID();
    if (subjectPartition(subjectTarget(new Uint8Array(32).fill(83), f.accountId, key).id) === partition) return key;
  }
  throw new Error('Could not select a native command receipt home');
}

test('two native Bun processes guard an old live anchor across merge and observable engine tombstone pruning', async () => {
  const p = await f.population();
  const [original, ...others] = await f.books(2);
  const survivor = others[0]!;
  const partition = subjectPartition(original);
  const old = await writer(p.incarnation, { phase: 'before-bulk', ordinal: 1 });
  const other = await writer(p.incarnation);
  expect(old.pid).not.toBe(other.pid);
  expect(old.pid).not.toBe(process.pid);
  let applying: Promise<BatchResult> | undefined;
  try {
    const before = await checkpoint(p.incarnation, partition);
    applying = old.run(partition);
    // Attach immediately: a failed process can never become an automatic safe retry.
    void applying.catch(() => {});
    const held = await old.held();
    expect(JSON.stringify(held.data)).toContain(original);
    expect(held.data.some((line) => (line as { id?: string }).id === original)).toBe(true);
    const slot = await home(p.incarnation, partition);
    expect(slot.attempt?.outcome).toBe('enrolled');
    await f.merge(original, survivor);
    await f.settleIdentity();
    await f.search.request('PUT', `/${p.incarnation.index}/_settings`, { index: { gc_deletes: '100ms' } });
    await pruneProbe();
    // A correct guard prevents the destructive schedule: newer delete/certificate must wait.
    // The independent real probe establishes that delete retention no longer protects old writes.
    expect((await other.run(partition)).status).toBe('busy');
    expect(other.events.filter((event) => event.event === 'source' || event.event === 'bulk')).toEqual([]);
    expect(await checkpoint(p.incarnation, partition)).toEqual(before);
    expect((await home(p.incarnation, partition)).attempt?.id).toBe(slot.attempt?.id);
    await unavailable(p.incarnation);
    await old.release();
    expect((await applying).status).toBe('read');
    await unavailable(p.incarnation);
    await f.consume(p.incarnation, [original, survivor]);
    const deleted = await hits(p.incarnation, [original, survivor]);
    expect(deleted.map((hit) => hit._id)).toEqual([survivor]);
    await pruneProbe();
    expect((await f.read(p.prefix)).state).toBe('ready');
    expect((await hits(p.incarnation, [original])).length).toBe(0);
    // No public tombstone document replaces the original after actual native deletion.
    await expect(f.search.request('GET', `/${p.incarnation.index}/_doc/${original}`)).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await Promise.allSettled([old.close(), other.close(), applying]);
  }
}, 240_000);

for (const failure of ['lost-response', 'process-exit'] as const) {
  test(`native applied bulk with ${failure} retains unknown completion and recovers only on a fresh incarnation`, async () => {
    const p = await f.population();
    const [original, ...others] = await f.books(2);
    const survivor = others[0]!;
    const partition = subjectPartition(original);
    const old = await writer(p.incarnation, { phase: 'after-bulk', ordinal: 1, lose: failure === 'lost-response' });
    const other = await writer(p.incarnation);
    let applying: Promise<BatchResult> | undefined;
    try {
      const before = await checkpoint(p.incarnation, partition);
      applying = old.run(partition);
      void applying.catch(() => {});
      await old.held();
      // Real refresh=wait_for has returned from the engine; the coordinator has not seen it.
      const applied = await hits(p.incarnation, [original]);
      expect(applied.map((hit) => hit._id)).toEqual([original]);
      expect(await checkpoint(p.incarnation, partition)).toEqual(before);
      const attempt = (await home(p.incarnation, partition)).attempt!;
      if (failure === 'process-exit') await old.crash();
      else await old.release();
      await expect(applying).rejects.toThrow();
      await f.merge(original, survivor);
      await f.settleIdentity();
      // Exceed the real client's default request timeout. Expiry and another process are not resolution.
      await Bun.sleep(11_000);
      expect((await other.run(partition)).status).toBe('busy');
      const unresolved = await home(p.incarnation, partition);
      expect(unresolved.attempt?.id).toBe(attempt.id);
      expect(['enrolled', 'ambiguous']).toContain(unresolved.attempt!.outcome);
      expect(await checkpoint(p.incarnation, partition)).toEqual(before);
      expect(await hits(p.incarnation, [original])).toEqual(applied);
      await unavailable(p.incarnation);
      const fresh = await recovery(p.incarnation, original, survivor);
      // Old external application survives checkpoint noncompletion; it cannot contaminate the fresh target.
      expect(await hits(p.incarnation, [original])).toEqual(applied);
      expect(await hits(fresh, [original])).toEqual([]);
      expect((await home(p.incarnation, partition)).attempt?.id).toBe(attempt.id);
    } finally {
      await Promise.allSettled([old.close(), other.close(), applying]);
    }
  }, 240_000);
}

test('real competing 409 waits for the independently applied winner and checked physical refresh before checkpoint completion', async () => {
  const p = await f.population();
  const [original, ...others] = await f.books(2);
  const survivor = others[0]!;
  const partition = subjectPartition(original);
  const changed = (
    await f.post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Conflict structural fence' },
      },
      await sameHomeKey(partition),
    )
  ).subject.id;
  await f.merge(changed, survivor);
  await f.settleIdentity();
  const selected = [original, changed, ...(subjectPartition(survivor) === partition ? [survivor] : [])];
  const snapshot = await f.source.read(partition, selected);
  const actions = documentActions(snapshot, selected, await f.listing.read(partition, selected));
  await f.search.request('PUT', `/${p.incarnation.index}/_settings`, { index: { refresh_interval: '-1' } });
  // Same production visibility contract as the coordinator, with exact native source-derived actions.
  const winning = writeIndexActions(
    {
      ...f.search,
      bulk<T>(lines: readonly unknown[], options?: Parameters<typeof f.search.bulk>[1]) {
        // This independently outstanding real request must outlive the guarded readiness observations.
        return f.search.bulk<T>(lines, { ...options, timeoutMs: 180_000 });
      },
    },
    p.incarnation.index,
    actions,
  );
  void winning.catch(() => {});
  const child = await writer(p.incarnation, { phase: 'before-refresh', ordinal: 1 });
  let applying: Promise<BatchResult> | undefined;
  try {
    await until(async () => {
      try {
        await f.search.request('GET', `/${p.incarnation.index}/_doc/${original}`);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return false;
        throw error;
      }
    }, 'Independent winning bulk was not applied');
    expect(await hits(p.incarnation, [original])).toEqual([]);
    const before = await checkpoint(p.incarnation, partition);
    applying = child.run(partition);
    void applying.catch(() => {});
    await child.held();
    const bulks = child.events
      .filter((event) => event.event === 'bulk')
      .map(
        (event) => event.value as { result: { items: Record<string, { status: number; error?: { type: string } }>[] } },
      );
    expect(
      bulks
        .flatMap((bulk) => bulk.result.items)
        .some((item) => item.index?.status === 409 && item.index.error?.type === 'version_conflict_engine_exception'),
    ).toBe(true);
    expect(await hits(p.incarnation, [original])).toEqual([]);
    expect(await checkpoint(p.incarnation, partition)).toEqual(before);
    expect((await home(p.incarnation, partition)).attempt?.outcome).not.toBe('completed');
    await unavailable(p.incarnation);
    await child.release();
    expect((await applying).status).toBe('read');
    await winning;
    expect((await hits(p.incarnation, [original])).map((hit) => hit._id)).toEqual([original]);
    expect((await home(p.incarnation, partition)).attempt?.outcome).toBe('completed');
    await f.search.request('PUT', `/${p.incarnation.index}/_settings`, { index: { refresh_interval: '1s' } });
    expect((await f.consume(p.incarnation, [original, changed, survivor])).state).toBe('ready');
    expect(await hits(p.incarnation, [changed])).toEqual([]);
  } finally {
    // Release only our index's refresh waiters before draining our child and promise.
    await f.search.request('POST', `/${p.incarnation.index}/_refresh`);
    await Promise.allSettled([child.close(), applying, winning]);
  }
}, 180_000);

test('more than 256 real command anchors use bounded native source chunks and every chunk is visible before completion', async () => {
  const p = await f.population();
  const partition = subjectPartition((await f.books(1))[0]);
  const ids: string[] = [];
  // Select receipt keys, not source bodies or routes injected into the DB. Every anchor is a real HTTP command.
  for (let n = 0; n < 257; n++)
    ids.push(
      (
        await f.post(
          '/v1/subjects',
          {
            type: 'schema:Book',
            labels: { en: `Native writer chunk ${n}` },
          },
          await sameHomeKey(partition),
        )
      ).subject.id,
    );
  expect(new Set(ids.map(subjectPartition))).toEqual(new Set([partition]));
  const child = await writer(p.incarnation, { phase: 'after-bulk', ordinal: 1 });
  let applying: Promise<BatchResult> | undefined;
  try {
    const before = await checkpoint(p.incarnation, partition);
    applying = child.run(partition);
    void applying.catch(() => {});
    await child.held();
    expect(await checkpoint(p.incarnation, partition)).toEqual(before);
    await child.release();
    let result = await applying;
    while (result.status === 'read' && result.envelopes > 0) {
      expect(result.envelopes).toBeLessThanOrEqual(64);
      // Every native successful run must already expose all of its actual chunk writes.
      for (const event of child.events.filter((event) => event.event === 'bulk')) {
        const { lines } = event.value as { lines: Record<string, { _id: string }>[] };
        const indexed = lines.flatMap((line) => (line.index ? [line.index._id] : [])).filter((id) => ids.includes(id));
        if (indexed.length)
          expect((await hits(p.incarnation, indexed)).map((hit) => hit._id).sort()).toEqual(indexed.sort());
      }
      result = await child.run(partition);
    }
    expect(result.status).toBe('read');
    const reads = child.events
      .filter((event) => event.event === 'source')
      .map((event) => event.value as { ids: string[] });
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((read) => read.ids.length > 0 && read.ids.length <= 256)).toBe(true);
    expect(new Set(reads.flatMap((read) => read.ids).filter((id) => ids.includes(id))).size).toBe(257);
    expect((await hits(p.incarnation, ids)).map((hit) => hit._id).sort()).toEqual(ids.sort());
    expect((await home(p.incarnation, partition)).attempt?.outcome).toBe('completed');
  } finally {
    await Promise.allSettled([child.close(), applying]);
  }
}, 300_000);
