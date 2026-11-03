import { expect, test } from 'bun:test';
import { feed, openCaptureComparisonCli, records } from './cli-capture-comparison.ts';

test('an operator compares two retained complete CLI captures without extra transport', async () => {
  const f = await openCaptureComparisonCli();
  try {
    const initial = await f.invoke(feed());
    expect(initial.code, JSON.stringify(initial)).toBe(0);
    const before = await f.inspectGeneration();
    expect(before.generation.status).toBe('complete');
    const beforeId = before.generation.id;

    const successor = records.map((row, index) =>
      index === 0 ? { ...row, name: 'Revised capture catalogue' } : row,
    );
    const secondDump = feed([...successor.slice(0, 4), { id: 930099, type: 2, name: 'New capture catalogue' }]);
    const imported = await f.invoke(secondDump);
    expect(imported.code, JSON.stringify(imported)).toBe(0);
    const after = await f.inspectGeneration();
    expect(after.generation.status).toBe('complete');
    const afterId = after.generation.id;
    expect(afterId).not.toBe(beforeId);

    const transportBefore = imported.exchanges.length;
    const counted = await f.captureCompare(beforeId, afterId, ['--counts', '--page', 'changed']);
    expect(counted.code, counted.stdout + counted.stderr).toBe(0);
    expect(counted.network).toEqual([]);
    expect(counted.openHandles).toBe(0);
    const document = JSON.parse(counted.stdout) as {
      counts: { state: string; new: number; changed: number; vanished: number; unchanged: number };
      page: { kind: string; rows: { recordKey: string; category: string }[] };
      authority: { transport: string; nativePublication: string };
    };
    expect(document.counts.state).toBe('complete');
    expect(document.counts.new).toBeGreaterThanOrEqual(1);
    expect(document.counts.changed).toBeGreaterThanOrEqual(1);
    expect(document.counts.vanished).toBeGreaterThanOrEqual(1);
    expect(document.page.kind).toBe('changed');
    expect(document.authority.transport).toBe('none');
    expect(imported.exchanges.length).toBe(transportBefore);

    const exact = await f.captureCompare(beforeId, afterId, ['--record', String(records[0]!.id)]);
    expect(exact.code, exact.stdout + exact.stderr).toBe(0);
    expect(exact.network).toEqual([]);
    const record = JSON.parse(exact.stdout) as { record: { category: string; nativePublication: string } };
    expect(record.record.category).toBe('changed');
    expect(record.record.nativePublication).toBe('independent-of-local-capture');

    const current = f.inspect();
    expect(current.source.count).toBe(5);
    expect(current.records[0]!.claim?.state).toBe('bound');
    const unchanged = await f.invoke(secondDump);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toContain('unchanged=');
  } finally {
    await f.close();
  }
}, 1_800_000);
