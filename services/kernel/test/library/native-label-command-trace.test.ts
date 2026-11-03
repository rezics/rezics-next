import { expect, test } from 'bun:test';
import { NativeLabelCommandTrace } from './support/native-label-command-trace.ts';

const receipt = [
  'SELECT request_digest, response FROM core.receipt WHERE partition_no=$1 AND command_kind=$2 LIMIT 1',
  [7, 'library_label.create'],
] as const;

test('completion precedes the observed lookup and preserves the callback response and key', async () => {
  const trace = new NativeLabelCommandTrace();
  const response = Response.json({ label: { id: 'private' } }, { status: 201 });
  const value = { response, key: 'original-key' };
  const result = await trace.trace(async () => {
    expect(await trace.authorize('library_entry:update', async () => true)).toBe(true);
    trace.query(receipt);
    return value;
  });
  expect(result.value).toBe(value);
  expect(result.events).toEqual([
    { sequence: 1, phase: 'admission_complete', action: 'library_entry:update', authorized: true },
    { sequence: 2, phase: 'receipt_read', action: 'library_label.create' },
  ]);
});

test('a returned refusal is observed; a thrown failure never manufactures a denial', async () => {
  const trace = new NativeLabelCommandTrace();
  const result = await trace.trace(async () => {
    expect(await trace.authorize('subject:read', async () => false)).toBe(false);
    await expect(trace.authorize('subject:read', async () => { throw new Error('storage failure'); }))
      .rejects.toThrow('storage failure');
    trace.query(['SELECT * FROM core.receipt ORDER BY command_kind']);
    trace.query(['INSERT INTO core.receipt(command_kind) VALUES ($1)', ['library_label.create']]);
  });
  expect(result.events).toEqual([
    { sequence: 1, phase: 'admission_complete', action: 'subject:read', authorized: false },
  ]);
});

test('delayed completion emits nothing early or after scope exit, error or close', async () => {
  const trace = new NativeLabelCommandTrace();
  for (const ending of ['success', 'error', 'close']) {
    const gate = Promise.withResolvers<boolean>();
    let pending!: Promise<boolean>;
    let events: unknown[] = [];
    const operation = trace.trace(async () => {
      pending = trace.authorize('library_entry:update', () => gate.promise);
      if (ending === 'close') trace.close();
      if (ending === 'error') throw new Error('callback failure');
    });
    if (ending === 'error') await expect(operation).rejects.toThrow('callback failure');
    else events = (await operation).events;
    expect(events).toEqual([]);
    gate.resolve(true);
    await pending;
    trace.query(receipt);
    expect(events).toEqual([]);
    expect((await trace.trace(async () => undefined)).events).toEqual([]);
  }
});

test('concurrent callbacks and worlds retain separate sequences and SQL parameters', async () => {
  const first = new NativeLabelCommandTrace(), second = new NativeLabelCommandTrace();
  const run = (trace: NativeLabelCommandTrace, action: string) => trace.trace(async () => {
    await trace.authorize(action, async () => true);
    trace.query([{ text: receipt[0], values: [7, action] }]);
  });
  const results = await Promise.all([run(first, 'a'), run(first, 'b'), run(second, 'c')]);
  for (const [index, action] of ['a', 'b', 'c'].entries())
    expect(results[index]!.events).toEqual([
      { sequence: 1, phase: 'admission_complete', action, authorized: true },
      { sequence: 2, phase: 'receipt_read', action },
    ]);
});
