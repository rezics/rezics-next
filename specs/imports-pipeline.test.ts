import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MISSING_PIPELINE_DRIVER,
  type CreateImportPipelineDriver,
  type Exchange,
  type PipelineDriver,
  type PipelineOptions,
  type PipelineRecord,
  type PipelineReport,
} from './imports-pipeline-driver.ts';

const records = (count: number, cover = false): PipelineRecord[] =>
  Array.from({ length: count }, (_, i) => ({ key: String(i + 1), revision: 1, cover }));
const keys = (rows: PipelineRecord[]) => rows.map((r) => r.key).sort();
async function scenario(options: PipelineOptions, check: (d: PipelineDriver) => Promise<void>) {
  const module = process.env.IMPORT_PIPELINE_DRIVER;
  if (!module) throw new Error(MISSING_PIPELINE_DRIVER);
  const { createImportPipelineDriver } = (await import(module)) as {
    createImportPipelineDriver: CreateImportPipelineDriver;
  };
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(resolve('.temp/import-pipeline-'));
  let driver: PipelineDriver | undefined;
  try {
    driver = await createImportPipelineDriver({ ...options, directory });
    await check(driver);
  } finally {
    try {
      await driver?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
function bounded(run: PipelineReport, k: number) {
  expect(run.peakRecords).toBeLessThanOrEqual(k);
  for (const peak of Object.values(run.peakByPhase)) expect(peak).toBeLessThanOrEqual(k);
  expect(run.activeRequestsAtEnd).toBe(0);
  // Reconstruct distinct active record identities from actual request intervals.
  const events = run.exchanges
    .filter((e) => e.ended > e.started)
    .flatMap((e) => [
      { at: e.started, delta: 1, key: e.recordKey },
      { at: e.ended, delta: -1, key: e.recordKey },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  const active = new Map<string, number>();
  let peak = 0;
  for (const e of events) {
    const count = (active.get(e.key) ?? 0) + e.delta;
    if (count) active.set(e.key, count);
    else active.delete(e.key);
    peak = Math.max(peak, active.size);
  }
  expect(peak).toBeLessThanOrEqual(k);
}
function complete(run: PipelineReport, rows: PipelineRecord[]) {
  expect(run.result.status).toBe('committed');
  expect(run.records.map((r) => r.recordKey).sort()).toEqual(keys(rows));
  expect(run.records.every((r) => r.acknowledged)).toBe(true);
}
const bulk = (run: PipelineReport, key: string) =>
  run.exchanges.filter((e) => e.recordKey === key && e.kind === 'bulk');
const cover = (e: Exchange) =>
  e.request?.commands.filter((c) => c.op === 'propose' && c.source.field_group === 'cover') ?? [];
const metadata = (run: PipelineReport, key: string) => {
  const found = bulk(run, key).find((e) => e.metadata);
  expect(found).toBeDefined();
  return found!;
};
// Compare raw per-record writes, including media POST bytes and all idempotency keys.
const writes = (run: PipelineReport) =>
  keys(run.records.map((r) => ({ key: r.recordKey, revision: 1 }))).map((key) => ({
    key,
    writes: run.exchanges
      .filter((e) => e.recordKey === key && ['bulk', 'media-post'].includes(e.kind))
      .map((e) => ({ kind: e.kind, bytes: e.bytes, keys: e.keys })),
  }));
const content = (run: PipelineReport) => ({ result: run.result, observed: run.observed, conversions: run.conversions });

// recordConcurrency is an importer option, not a test scheduler limit.
test('default sixteen and explicit one through sixty four bound staged records', async () => {
  for (const k of [undefined, 1, 4, 64])
    await scenario({ ...(k === undefined ? {} : { recordConcurrency: k }), latencyMs: 5 }, async (d) => {
      const run = await d.run(records(80));
      complete(run, records(80));
      bounded(run, k ?? 16);
      expect(run.peakByPhase.staged).toBe(k ?? 16);
      expect(run.result.new).toEqual(keys(records(80)));
      if (k === 1) {
        const first = run.exchanges.filter((e) => e.phase === 'staged' && e.recordKey === '1');
        const second = run.exchanges.filter((e) => e.phase === 'staged' && e.recordKey === '10');
        expect(Math.max(...first.map((e) => e.ended))).toBeLessThanOrEqual(Math.min(...second.map((e) => e.started)));
      }
    });
});
test('invalid concurrency rejects before any remote effects', async () => {
  if (!process.env.IMPORT_PIPELINE_DRIVER) throw new Error(MISSING_PIPELINE_DRIVER);
  for (const k of [0, -1, 65, 1.5, NaN, Infinity]) {
    // Validation may occur when constructing the real importer or invoking it.
    await expect(
      scenario({ recordConcurrency: k }, async (d) => {
        try {
          await d.run(records(2));
        } finally {
          expect(await d.effects()).toEqual({ subjects: 0, proposals: 0, retractions: 0, duplicateEffects: 0 });
        }
      }),
    ).rejects.toBeInstanceOf(TypeError);
  }
});
test('vanished reconciliation and resumed durable drain use the same concurrency bound', async () => {
  for (const k of [1, 4, 16])
    await scenario({ recordConcurrency: k, latencyMs: 5 }, async (d) => {
      complete(await d.run(records(40)), records(40));
      const remaining = records(20);
      // Exactly half vanish: below the explicit fixture's permitted disappearance threshold.
      const vanished = await d.run(remaining, { disappearanceThreshold: 1 });
      expect(vanished.result.status).toBe('committed');
      expect(vanished.result.vanished).toEqual(keys(records(40).slice(20)));
      bounded(vanished, k);
      expect(vanished.peakByPhase.vanished).toBe(k);
      const changed = remaining.map((r) => ({ ...r, revision: 2 }));
      const stopped = await d.run(changed, { interruptAfterSuccess: '1' });
      expect(stopped.result.status).toBe('interrupted');
      await d.reopen();
      const resumed = await d.run(changed);
      complete(resumed, changed);
      bounded(resumed, k);
      expect(resumed.peakByPhase.resumed).toBe(k);
      const uncertain = metadata(stopped, '1');
      const replay = bulk(resumed, '1').find((e) => e.keys.some((key) => uncertain.keys.includes(key)));
      expect(replay).toBeDefined();
      expect(replay!.keys).toEqual(uncertain.keys);
      expect(replay!.bytes).toBe(uncertain.bytes);
      expect((await d.effects()).duplicateEffects).toBe(0);
    });
});
test('completion order and concurrency preserve ordered outcomes conversions counts and exact writes', async () => {
  for (const media of ['cached', 'pending'] as const) {
    let reference: { content: ReturnType<typeof content>; writes: ReturnType<typeof writes> } | undefined;
    for (const k of [1, 4, 16])
      for (const completionOrder of ['forward', 'reverse'] as const) {
        await scenario({ recordConcurrency: k, completionOrder, latencyMs: 5, media }, async (d) => {
          const release = {
            onExchange(e: Exchange) {
              if (e.metadata) d.setMedia(e.recordKey, 'available');
            },
          };
          await d.run(records(24, true), release);
          const input = [
            ...records(20, true).map((r) => ({ ...r, revision: r.key === '1' ? 2 : 1 })),
            { key: '25', revision: 1, cover: true },
          ];
          const run = await d.run(input, { disappearanceThreshold: 1, ...release });
          expect(run.result.status).toBe('committed');
          expect(run.result.counts).toEqual({ new: 1, changed: 1, unchanged: 19, vanished: 4 });
          expect(run.result.new).toEqual(['25']);
          expect(run.result.changed).toEqual(['1']);
          expect(run.result.unchanged).toEqual(keys(records(20).slice(1)));
          expect(run.result.vanished).toEqual(['21', '22', '23', '24']);
          expect(run.conversions.length).toBeGreaterThan(0);
          const conversionKeys = run.conversions.map((c) => c.recordKey);
          expect(conversionKeys).toEqual([...conversionKeys].sort());
          const actual = { content: content(run), writes: writes(run) };
          if (reference) expect(actual).toEqual(reference);
          else reference = actual;
          bounded(run, k);
        });
      }
  }
});
test('journal available cover shares its record metadata batch without POST or polling', () =>
  scenario({ media: 'cached' }, async (d) => {
    const run = await d.run(records(1, true));
    complete(run, records(1, true));
    expect(cover(metadata(run, '1'))).toHaveLength(1);
    expect(run.exchanges.filter((e) => e.kind.startsWith('media-'))).toEqual([]);
    expect(bulk(run, '1').filter((e) => cover(e).length)).toHaveLength(1);
  }));
test('pending cover sends metadata first then a separate cover batch after a fresh fence without record sleeps', () =>
  scenario({ recordConcurrency: 4, latencyMs: 5, media: 'pending' }, async (d) => {
    const run = await d.run(records(8, true), {
      onExchange(e) {
        if (e.metadata) d.setMedia(e.recordKey, 'available');
      },
    });
    complete(run, records(8, true));
    bounded(run, 4);
    expect(run.sleeps.filter((s) => s.phase !== 'media')).toEqual([]);
    expect(run.peakByPhase.media).toBeGreaterThan(0);
    const polls = run.exchanges.filter((e) => e.kind === 'media-status');
    expect(polls.length).toBeGreaterThan(0);
    const metadataFinished = Math.max(...run.exchanges.filter((e) => e.metadata).map((e) => e.ended));
    expect(polls.every((e) => e.phase === 'media' && e.started >= metadataFinished)).toBe(true);
    for (const key of keys(records(8))) {
      const initial = metadata(run, key);
      expect(cover(initial)).toEqual([]);
      const late = bulk(run, key).filter((e) => cover(e).length);
      expect(late).toHaveLength(1);
      expect(late[0]!.request!.commands.every((c) => c.source.field_group === 'cover')).toBe(true);
      expect(late[0]!.started).toBeGreaterThanOrEqual(initial.ended);
      expect(
        run.exchanges.some(
          (e) =>
            e.recordKey === key &&
            e.kind === 'fence' &&
            e.fieldGroup === 'cover' &&
            e.started >= initial.ended &&
            e.ended <= late[0]!.started,
        ),
      ).toBe(true);
      expect(run.acknowledgements.find((a) => a.recordKey === key)!.at).toBeGreaterThanOrEqual(late[0]!.ended);
      expect(run.exchanges.filter((e) => e.recordKey === key && e.kind === 'media-post')).toHaveLength(1);
    }
  }));
test('deferring a cover adds exactly one batch and preserves every command and operation key', async () => {
  let combined: { commands: NonNullable<Exchange['request']>['commands']; batches: number } | undefined;
  for (const media of ['cached', 'pending'] as const)
    await scenario({ media }, async (d) => {
      const run = await d.run(records(1, true), {
        onExchange(e) {
          if (e.metadata) d.setMedia(e.recordKey, 'available');
        },
      });
      complete(run, records(1, true));
      const batches = bulk(run, '1');
      const commands = batches.flatMap((e) => e.request!.commands).sort((a, b) => a.key.localeCompare(b.key));
      expect(commands.length).toBeGreaterThan(1);
      if (combined) {
        expect(commands).toEqual(combined.commands);
        expect(batches.length).toBe(combined.batches + 1);
      } else combined = { commands, batches: batches.length };
    });
});
test('deadline leaves only pending records unresolved and reopen resumes accepted media without another POST', async () => {
  for (const deadline of [undefined, 200])
    await scenario(
      { media: 'pending', ...(deadline === undefined ? {} : { mediaDeadlineMs: deadline }), latencyMs: 5 },
      async (d) => {
        const rows = records(4, true);
        const run = await d.run(rows, {
          onExchange(e) {
            if (e.metadata && e.recordKey !== '1') d.setMedia(e.recordKey, 'available');
          },
        });
        expect(run.result.status).toBe('bulk-failed');
        expect(run.elapsedMs).toBeGreaterThanOrEqual(deadline ?? 600000);
        expect(run.elapsedMs).toBeLessThanOrEqual((deadline ?? 600000) + 200);
        expect(run.records.find((r) => r.recordKey === '1')).toMatchObject({ acknowledged: false, cover: 'pending' });
        expect(run.records.filter((r) => r.recordKey !== '1').every((r) => r.acknowledged)).toBe(true);
        expect(run.acknowledgements.some((a) => a.recordKey === '1')).toBe(false);
        const oldMetadata = metadata(run, '1');
        await d.reopen();
        d.setMedia('1', 'available');
        const resumed = await d.run(rows);
        complete(resumed, rows);
        expect(resumed.exchanges.some((e) => e.kind === 'media-post')).toBe(false);
        expect(bulk(resumed, '1').some((e) => e.bytes === oldMetadata.bytes)).toBe(false);
        expect(bulk(resumed, '1').flatMap(cover)).toHaveLength(1);
        expect((await d.effects()).duplicateEffects).toBe(0);
      },
    );
});
test('fence installed during pending media wins and resolves the cover omission', () =>
  scenario({ media: 'pending' }, async (d) => {
    const run = await d.run(records(4, true), {
      onExchange(e) {
        if (e.metadata) {
          d.setCoverFence(e.recordKey);
          d.setMedia(e.recordKey, 'available');
        }
      },
    });
    complete(run, records(4, true));
    expect(run.exchanges.flatMap(cover)).toEqual([]);
    expect(run.records.every((r) => r.cover === 'fenced')).toBe(true);
    expect(run.exchanges.filter((e) => e.metadata)).toHaveLength(4);
  }));
test('rejected media resolves cover without undoing other proposals or interrupting peers', () =>
  scenario({ media: 'pending' }, async (d) => {
    const run = await d.run(records(4, true), {
      onExchange(e) {
        if (e.metadata) d.setMedia(e.recordKey, 'rejected');
      },
    });
    complete(run, records(4, true));
    expect(run.records.every((r) => r.cover === 'rejected')).toBe(true);
    expect(run.exchanges.flatMap(cover)).toEqual([]);
    expect(run.exchanges.filter((e) => e.metadata)).toHaveLength(4);
    expect((await d.effects()).proposals).toBeGreaterThanOrEqual(4);
  }));
test('bulk errors and invalid responses isolate one record while all peers finish', async () => {
  for (const response of ['bulk-error', 'invalid-response'] as const)
    await scenario(
      {
        recordConcurrency: 4,
        latencyMs: 5,
        fault: { recordKey: '1', response },
      },
      async (d) => {
        const run = await d.run(records(16));
        expect(run.result.status).toBe('bulk-failed');
        expect(run.records.find((r) => r.recordKey === '1')!.acknowledged).toBe(false);
        expect(run.records.filter((r) => r.recordKey !== '1')).toHaveLength(15);
        expect(run.records.filter((r) => r.recordKey !== '1').every((r) => r.acknowledged)).toBe(true);
        bounded(run, 4);
      },
    );
});
test('abort starts no further requests and durable replay preserves keys bytes and single effects', () =>
  scenario({ recordConcurrency: 4, latencyMs: 5 }, async (d) => {
    const controller = new AbortController();
    let abortedAt = -1;
    let abortOrder = -1;
    const run = await d.run(records(16), {
      signal: controller.signal,
      onExchange(e) {
        if (abortedAt < 0 && e.metadata) {
          abortedAt = e.ended;
          abortOrder = e.endOrder;
          controller.abort();
        }
      },
    });
    expect(abortedAt).toBeGreaterThanOrEqual(0);
    expect(run.result.status).toBe('interrupted');
    expect(run.exchanges.every((e) => e.startOrder < abortOrder)).toBe(true);
    bounded(run, 4);
    expect(run.exchanges.filter((e) => e.ended > abortedAt).every((e) => e.cancelled)).toBe(true);
    await d.reopen();
    const resumed = await d.run(records(16));
    complete(resumed, records(16));
    for (const e of run.exchanges.filter((e) => e.kind === 'bulk')) {
      for (const replay of resumed.exchanges.filter(
        (r) => r.kind === 'bulk' && r.keys.some((key) => e.keys.includes(key)),
      )) {
        expect(replay.keys).toEqual(e.keys);
        expect(replay.bytes).toBe(e.bytes);
      }
    }
    expect((await d.effects()).subjects).toBe(16);
    expect((await d.effects()).duplicateEffects).toBe(0);
    const effects = await d.effects();
    complete(await d.run(records(16)), records(16));
    expect(await d.effects()).toEqual(effects);
  }));
test('already aborted signal sends no requests', () =>
  scenario({}, async (d) => {
    const run = await d.run(records(8, true), { signal: AbortSignal.abort() });
    expect(run.result.status).toBe('interrupted');
    expect(run.exchanges).toEqual([]);
    expect(run.activeRequestsAtEnd).toBe(0);
  }));
test('virtual throughput at sixty four two hundred fifty six and one thousand twenty four keeps bounded live state', async () => {
  // Conservative serial request path: 32 latency slots (all fences, bootstrap,
  // media submission/status and both batches). Tail slack is exactly 4L, not N.
  const L = 5,
    M = 1000,
    K = 16,
    PATH = 32,
    SLACK = 4 * L;
  for (const n of [64, 256, 1024])
    await scenario({ recordConcurrency: K, latencyMs: L, media: { after: M } }, async (d) => {
      const run = await d.run(records(n, true), { collect: false });
      expect(run.result.status).toBe('committed');
      expect(run.result.counts.new).toBe(n);
      expect(run.elapsedMs).toBeGreaterThanOrEqual(M);
      expect(run.elapsedMs).toBeLessThanOrEqual(Math.ceil(n / K) * PATH * L + M + SLACK);
      bounded(run, K);
      expect(run.peakRecords).toBe(K);
      expect(run.memory.stagedPageRecords).toBeLessThanOrEqual(100);
      expect(run.memory.liveRecords).toBeLessThanOrEqual(100 + 4 * K);
      expect(run.memory.liveBytes).toBeGreaterThan(0);
      expect(run.memory.liveBytes).toBeLessThanOrEqual((100 + 4 * K) * 65536);
      expect(run.exchanges.filter((e) => e.kind === 'media-post')).toHaveLength(n);
      expect(run.exchanges.filter((e) => e.metadata)).toHaveLength(n);
      expect(run.exchanges.filter((e) => cover(e).length)).toHaveLength(n);
      expect(run.sleeps.filter((s) => s.phase !== 'media')).toEqual([]);
      for (const e of run.exchanges.filter((e) => !e.cancelled)) expect(e.ended - e.started).toBe(L);
    });
});
