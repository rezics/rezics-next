import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createImportTransport, ImportTransportError } from '../src/import-client.ts';
import { createImportPipelineDriver, type WriteSimulation } from './pipeline-driver.ts';

async function fixture(
  writes: WriteSimulation,
  count: number,
  recordConcurrency?: number,
  options?: { signal: AbortSignal; onExchange(exchange: { kind: string; started: number }): void },
) {
  const temporary = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'write-width-'));
  const driver = await createImportPipelineDriver({
    directory,
    writes,
    ...(recordConcurrency === undefined ? {} : { recordConcurrency }),
    media: 'available',
  });
  try {
    const report = await driver.run(
      Array.from({ length: count }, (_, index) => ({
        key: String(index + 1),
        revision: 1,
        cover: true,
      })),
      options,
    );
    return { report, effects: await driver.effects() };
  } finally {
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const simulation = (limit: number): WriteSimulation => ({ limit, attempts: [], accepted: new Map() });

test('contention answered with retryable 503 narrows the write width and every record lands once', async () => {
  const writes = simulation(3);
  const { report, effects } = await fixture(writes, 128);
  expect(report.result.status).toBe('committed');
  expect(report.result.counts.new).toBe(128);
  expect(report.records.every((record) => record.acknowledged && record.cover === 'proposed')).toBe(true);
  expect(report.acknowledgements).toHaveLength(128);
  // Retrying a later write never repeats the already completed media step.
  const posts = report.exchanges.filter((exchange) => exchange.kind === 'media-post');
  expect(posts).toHaveLength(128);
  expect(new Set(posts.map((exchange) => exchange.recordKey)).size).toBe(128);
  const bytesByKey = new Map<string, string>();
  for (const exchange of report.exchanges.filter((exchange) => exchange.kind === 'bulk')) {
    for (const command of exchange.request!.commands) {
      const bytes = JSON.stringify(command);
      expect(bytesByKey.get(command.key) ?? bytes).toBe(bytes);
      bytesByKey.set(command.key, bytes);
    }
  }
  expect(effects.subjects).toBe(128);
  expect(effects.duplicateEffects).toBe(0);
  const requestedKeys = new Set(writes.attempts.flatMap((attempt) => attempt.keys));
  expect([...writes.accepted.keys()].sort()).toEqual([...requestedKeys].sort());
  expect([...writes.accepted.values()].every((count) => count === 1)).toBe(true);
  const firstOverload = writes.attempts.findIndex((attempt) => attempt.overloaded);
  expect(firstOverload).toBeGreaterThanOrEqual(0);
  expect(writes.attempts.slice(firstOverload + 1).some((attempt) => attempt.inFlight <= 3)).toBe(true);
  expect(report.peakRecords).toBeLessThanOrEqual(16);
  expect(report.activeRequestsAtEnd).toBe(0);
}, 30_000);

test('a single writer that still gets retryable 503 fails the run as before', async () => {
  const writes = simulation(0);
  const { report, effects } = await fixture(writes, 1, 1);
  expect(report.result.status).toBe('bulk-failed');
  expect(writes.attempts).toHaveLength(3);
  expect(report.sleeps.map((sleep) => sleep.ms)).toEqual([1000, 2000]);
  expect(report.elapsedMs).toBeLessThanOrEqual(3100);
  expect(effects.subjects).toBe(0);
  expect(report.activeRequestsAtEnd).toBe(0);
});

test('width grows back to the configured concurrency after successful writes', async () => {
  const writes = { ...simulation(3), until: 5000 };
  const { report } = await fixture(writes, 256, 12);
  expect(report.result.status).toBe('committed');
  expect(writes.attempts.some((attempt) => attempt.overloaded)).toBe(true);
  expect(writes.attempts.some((attempt) => attempt.at >= 5000 && attempt.inFlight === 12)).toBe(true);
  expect(report.peakRecords).toBeLessThanOrEqual(12);
}, 30_000);

test('persistent overload at the default width drains to a bounded failure', async () => {
  const writes = simulation(0);
  const { report } = await fixture(writes, 32);
  expect(report.result.status).toBe('bulk-failed');
  expect(writes.attempts.length).toBeLessThanOrEqual(3 * (32 + 16));
  expect(report.elapsedMs).toBeLessThanOrEqual(120_000);
  expect(report.activeRequestsAtEnd).toBe(0);
});

test('429 overload narrows without a retryable problem flag', async () => {
  const writes = { ...simulation(3), status: 429, retryable: false };
  const { report } = await fixture(writes, 128);
  expect(report.result.status).toBe('committed');
  expect(writes.attempts.some((attempt) => attempt.overloaded)).toBe(true);
}, 30_000);

for (const [status, retryable] of [
  [503, false],
  [500, true],
  [403, true],
] as const) {
  test(`${status} with retryable ${retryable} retains the existing failure behaviour`, async () => {
    const writes = { ...simulation(0), status, retryable };
    const { report } = await fixture(writes, 1, 16);
    expect(report.result.status).toBe('bulk-failed');
    expect(writes.attempts).toHaveLength(status >= 500 ? 3 : 1);
  });
}

test('the final HTTP error exposes bounded status, code and retryability', async () => {
  const client = createImportTransport({
    origin: 'https://api.example.test',
    tokenProvider: async () => 'fixture',
    maxAttempts: 1,
    now: () => 0,
    schedule: () => () => {},
    fetch: (async (_input: RequestInfo | URL) =>
      Response.json(
        {
          type: 'https://rezics.com/problems/transaction_retry_exhausted',
          code: 'transaction_retry_exhausted',
          retryable: true,
          detail: 'private remote diagnostic',
        },
        { status: 503 },
      )) as typeof fetch,
  });
  const error = await client
    .fence({ source: 'bangumi', externalId: '1', fieldGroup: 'facts' })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ImportTransportError);
  const failure = error as ImportTransportError;
  expect(failure.status).toBe(503);
  expect(failure.code).toBe('transaction_retry_exhausted');
  expect(failure.retryable).toBe(true);
  expect(JSON.stringify(failure)).not.toContain('private remote diagnostic');
});

test('interruption releases records queued after overload', async () => {
  const writes = simulation(0);
  const controller = new AbortController();
  let exhausted = 0;
  const { report } = await fixture(writes, 32, 16, {
    signal: controller.signal,
    onExchange(exchange) {
      if (exchange.kind === 'bulk' && exchange.started >= 3000 && ++exhausted === 2) controller.abort();
    },
  });
  expect(exhausted).toBeGreaterThanOrEqual(2);
  expect(report.result.status).toBe('interrupted');
  expect(report.activeRequestsAtEnd).toBe(0);
  expect(writes.attempts).toHaveLength(3 * 16);
});
