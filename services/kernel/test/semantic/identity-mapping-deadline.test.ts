import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createNativeIdentityCapabilities } from '../../src/semantic/identity-adapter-runtime.ts';
import type { NativeIdentityCapabilities } from '../../src/semantic/identity-adapter-port.ts';
import { createIdentityReaders } from '../../src/semantic/identity-adapters/identity-epoch-read.ts';
import owners from '../../src/semantic/identity-epoch-read-owners.sql';
import pending from '../../src/semantic/identity-epoch-read-pending.sql';
import sources from '../../src/semantic/identity-epoch-read-sources.sql';
import current from '../../src/semantic/identity-terminal-closure-current.sql';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

function fakeClient(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  release: (error?: Error | boolean) => void,
): PoolClient {
  return {
    query(statement: QueryConfig | string, values?: unknown[]) {
      return query(
        typeof statement === 'string' ? statement : (statement.text ?? ''),
        typeof statement === 'string' ? values : statement.values,
      );
    },
    release,
  } as unknown as PoolClient;
}

function readerHarness(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  releaseErrors: Array<Error | boolean | undefined>,
) {
  const native = createNativeIdentityCapabilities().read;
  const captured: number[] = [];
  const forwarded: number[] = [];
  const pool = fakePool(async () => fakeClient(query, (error) => releaseErrors.push(error)));
  const read = {
    requestDeadline() {
      const deadline = native.requestDeadline();
      captured.push(deadline);
      return deadline;
    },
    withReadTransaction(poolArg: Pool, callback: (client: PoolClient) => Promise<unknown>, deadline?: number) {
      forwarded.push(deadline!);
      return native.withReadTransaction(poolArg, callback, deadline);
    },
  };
  const readers = createIdentityReaders({ read } as unknown as NativeIdentityCapabilities);
  return { pool, readers, captured, forwarded };
}

test('mapping evidence passes share one fresh deadline and preserve the exact one-hop result', async () => {
  const original = newId(0x20);
  const terminal = newId(0x50);
  const sourceHome = partitionOf(routeOf(original)!);
  const controlHome = partitionOf(routeOf(terminal)!);
  const sourceKeys: string[] = [];
  const releaseErrors: Array<Error | boolean | undefined> = [];
  let activeSnapshots = 0;
  const harness = readerHarness(async (sql, values) => {
    if (sql === owners.sql) {
      const home = (values?.[0] as number[])[0]!;
      return { rows: [{ partition_no: home, epoch: home === sourceHome ? 3 : 4, write_state: 'active' }] };
    }
    if (sql === sources.sql) {
      sourceKeys.push((values?.[0] as string[])[0]!);
      return {
        rows: [
          {
            subject_id: original,
            original,
            control_partition: controlHome,
            control_group: terminal,
            epoch: '7',
            owner_epoch: 3,
            dirty_revision: '0',
            captured_revision: '0',
            terminal,
            closure_state: 'legacy',
            current_target: terminal,
          },
        ],
      };
    }
    if (sql === current.sql)
      return {
        rows: [
          {
            partition_no: controlHome,
            terminal,
            requested_original: original,
            redirected: false,
            owner_epoch: 4,
            closure_state: 'open',
            generation: 'generation',
            published_epoch: '11',
          },
        ],
      };
    return { rows: [] };
  }, releaseErrors);
  const connect = harness.pool.connect;
  harness.pool.connect = (async () => {
    expect(activeSnapshots).toBe(0);
    activeSnapshots++;
    const client = await connect();
    const release = client.release.bind(client);
    client.release = (error?: Error | boolean) => {
      activeSnapshots--;
      release(error);
    };
    return client;
  }) as Pool['connect'];

  await expect(harness.readers.readIdentityMappings(harness.pool, [original])).resolves.toEqual([
    { state: 'mapped', original, terminal, epoch: 11n },
  ]);
  expect(harness.captured).toHaveLength(1);
  expect(harness.forwarded).toEqual(Array(4).fill(harness.captured[0]));
  expect(sourceKeys).toEqual(Array(2).fill(original));
  expect(releaseErrors).toEqual(Array(4).fill(undefined));
  expect(activeSnapshots).toBe(0);
});

test('same-home originals observe their shared pending control in the source snapshot', async () => {
  const originals = [newId(0x20), newId(0x21)];
  const home = partitionOf(0x20);
  const terminal = originals[0]!;
  const job = { jobId: newId(0x50), epoch: 8n };
  const reads: string[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const harness = readerHarness(async (sql, values) => {
    if (sql === owners.sql) {
      reads.push('owner');
      return { rows: [{ partition_no: home, epoch: 3, write_state: 'active' }] };
    }
    if (sql === sources.sql) {
      reads.push('sources');
      return {
        rows: originals.map((original) => ({
          subject_id: original,
          original,
          control_partition: home,
          control_group: terminal,
          epoch: '7',
          owner_epoch: 3,
          dirty_revision: '0',
          captured_revision: '0',
          terminal,
          closure_state: 'legacy',
          current_target: original === terminal ? null : terminal,
        })),
      };
    }
    if (sql === pending.sql) {
      reads.push('claim');
      expect(values).toEqual([[home], [terminal]]);
      return { rows: [{ partition_no: home, terminal, pending_job: job.jobId, pending_epoch: '8' }] };
    }
    if (sql === current.sql) {
      reads.push('closure');
      return {
        rows: originals.map((original) => ({
          partition_no: home,
          terminal,
          requested_original: original,
          redirected: false,
          owner_epoch: 3,
          closure_state: 'open',
          published_epoch: '7',
        })),
      };
    }
    return { rows: [] };
  }, releases);
  await expect(harness.readers.readIdentityMappings(harness.pool, originals)).resolves.toEqual(
    originals.map((original) => ({ state: 'pending', original, job })),
  );
  expect(reads).toEqual(['owner', 'sources', 'claim', 'closure']);
  expect(releases).toEqual([undefined]);
});

test('a slow home expires the original ambient deadline and prevents the next home query', async () => {
  const ids: [string, string] = [newId(0x20), newId(0x30)];
  const originalDeadline = Date.now() + 250;
  const sourceKeys: string[] = [];
  const releaseErrors: Array<Error | boolean | undefined> = [];
  let slowQueryFinished!: () => void;
  const slowFinished = new Promise<void>((resolve) => (slowQueryFinished = resolve));
  const harness = readerHarness(async (sql, values) => {
    if (sql === owners.sql) {
      const home = (values?.[0] as number[])[0]!;
      return { rows: [{ partition_no: home, epoch: 3, write_state: 'active' }] };
    }
    if (sql === sources.sql) {
      sourceKeys.push((values?.[0] as string[])[0]!);
      if (sourceKeys.length === 3) {
        await Bun.sleep(350);
        slowQueryFinished();
      }
    }
    return { rows: [] };
  }, releaseErrors);

  await expect(
    withRequestDeadline(originalDeadline, () => harness.readers.readIdentityMappings(harness.pool, ids)),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  await slowFinished;
  expect(harness.captured).toEqual([originalDeadline]);
  expect(harness.forwarded).toEqual(Array(3).fill(originalDeadline));
  expect(sourceKeys).toEqual([ids[0], ids[1], ids[0]]);
  expect(releaseErrors.at(-1)).toBeInstanceOf(Error);
});
