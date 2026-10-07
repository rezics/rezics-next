import { describe, expect, test } from 'bun:test';
import type { RecordResult } from './types.ts';
import { resetRecordLanes, submitRecord, writeNewest, type WriteRound } from './write.ts';

interface Held { dueAt: string; version: number }

describe('loan write lane', () => {
  test('a stale write in flight yields to the newest due', async () => {
    resetRecordLanes();
    let held: Held = { dueAt: '2026-09-01T00:00:00.000Z', version: 3 };
    const written: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const apply = (choice: string, round: WriteRound): Promise<RecordResult<Held>> => writeNewest(round, held.version,
      async expected => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return { ok: false, failure: 'moved' };
        }
        written.push(choice);
        held = { dueAt: choice, version: expected + 1 };
        return { ok: true, data: held };
      },
      async () => ({ ok: true, data: held }),
      current => current.dueAt === choice,
      current => current.version);

    const first = submitRecord('loan-stale', '2026-09-10T00:00:00.000Z', apply);
    const second = submitRecord('loan-stale', '2026-10-01T00:00:00.000Z', apply);
    release();
    const [older, newer] = await Promise.all([first, second]);
    expect(written).toEqual(['2026-10-01T00:00:00.000Z']);
    expect(older).toEqual({ ok: true, data: { dueAt: '2026-10-01T00:00:00.000Z', version: 4 } });
    expect(newer).toEqual(older);
  });

  test('a 409 whose record already holds the newest intent does not write again', async () => {
    resetRecordLanes();
    const dueAt = '2026-10-01T00:00:00.000Z';
    let writes = 0;
    const result = await submitRecord('loan-held', dueAt, (choice, round) => writeNewest(round, 4,
      async () => {
        writes += 1;
        return { ok: false, failure: 'moved' };
      },
      async () => ({ ok: true, data: { dueAt, version: 5 } }),
      current => current.dueAt === choice,
      current => current.version));
    expect(writes).toBe(1);
    expect(result).toEqual({ ok: true, data: { dueAt, version: 5 } });
  });

  test('a 409 that is still the newest intent retries once at the fresh version', async () => {
    resetRecordLanes();
    let held: Held = { dueAt: '2026-09-01T00:00:00.000Z', version: 2 };
    const versions: number[] = [];
    const result = await submitRecord('loan-retry', '2026-11-01T00:00:00.000Z', (choice, round) => writeNewest(round, 1,
      async expected => {
        versions.push(expected);
        if (versions.length === 1) return { ok: false, failure: 'moved' };
        held = { dueAt: choice, version: expected + 1 };
        return { ok: true, data: held };
      },
      async () => ({ ok: true, data: held }),
      current => current.dueAt === choice,
      current => current.version));
    expect(versions).toEqual([1, 2]);
    expect(result).toEqual({ ok: true, data: { dueAt: '2026-11-01T00:00:00.000Z', version: 3 } });
  });

  test('an unchanged intent keeps its key and a changed one receives a new key', async () => {
    resetRecordLanes();
    const keys: string[] = [];
    const apply = (choice: string, round: WriteRound) => {
      keys.push(round.key);
      return Promise.resolve({ ok: true as const, data: choice });
    };
    await submitRecord('intent-key', 'same', apply);
    await submitRecord('intent-key', 'same', apply);
    await submitRecord('intent-key', 'edited', apply);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
