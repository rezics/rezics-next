import { describe, expect, test } from 'bun:test';
import { ImportError, type ApplyProgress } from '../import-api.ts';
import { goodreadsRows } from '../import-fixtures.ts';
import { canCommitApplyIntent, pollLibraryApply } from './apply.ts';

const intent = { context: 'reader', language: 'en' };
const pending: ApplyProgress = { total: 3, completed: 0, issues: 0, pending: true };
const complete: ApplyProgress = { total: 3, completed: 3, issues: 0, pending: false };

describe('library apply polling', () => {
  test('six unchanged accepted replies stay pending, then real progress completes the import', async () => {
    const replies = [...Array<ApplyProgress>(6).fill(pending), { ...pending, completed: 1 }, complete];
    const seen: ApplyProgress[] = [], waits: number[] = [], calls: unknown[] = [];
    const result = await pollLibraryApply({ apply: async (id, suppliedIntent) => {
      calls.push([id, suppliedIntent]);
      return replies[calls.length - 1]!;
    } }, 'file', intent, { active: () => true, onProgress: progress => { seen.push(progress); },
      wait: async milliseconds => { waits.push(milliseconds); } });
    expect(result).toEqual(complete);
    expect(seen).toEqual(replies);
    expect(calls).toEqual(Array.from({ length: 8 }, () => ['file', intent]));
    expect(waits).toEqual([1000, 2000, 4000, 5000, 5000, 5000, 5000]);
  });

  test('an actual refusal is propagated without manufacturing another pending reply', async () => {
    const refusal = new ImportError('unavailable');
    let calls = 0;
    const seen: ApplyProgress[] = [];
    await expect(pollLibraryApply({ apply: async () => {
      if (++calls === 1) return pending;
      throw refusal;
    } }, 'file', intent, { active: () => true, onProgress: progress => { seen.push(progress); },
      wait: async () => {} })).rejects.toBe(refusal);
    expect(calls).toBe(2);
    expect(seen).toEqual([pending]);
  });

  test('leaving during the wait cancels later requests without turning pending work into a failure', async () => {
    let active = true, calls = 0;
    const seen: ApplyProgress[] = [];
    const result = await pollLibraryApply({ apply: async () => { calls++; return pending; } }, 'file', intent,
      { active: () => active, onProgress: progress => { seen.push(progress); }, wait: async () => { active = false; } });
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(seen).toEqual([pending]);
  });

  test('leaving while a request is in flight ignores its answer', async () => {
    let active = true;
    const seen: ApplyProgress[] = [];
    const result = await pollLibraryApply({ apply: async () => { active = false; return complete; } }, 'file', intent,
      { active: () => active, onProgress: progress => { seen.push(progress); } });
    expect(result).toBeNull();
    expect(seen).toEqual([]);
  });

  test('a cancelled run sends no apply command', async () => {
    let calls = 0;
    expect(await pollLibraryApply({ apply: async () => { calls++; return complete; } }, 'file', intent,
      { active: () => false, onProgress: () => {} })).toBeNull();
    expect(calls).toBe(0);
  });
  test('permanent 202 has bounded backoff and returns truthful pending progress', async () => {
    let commands = 0, reads = 0;
    const waits: number[] = [];
    const result = await pollLibraryApply({ apply: async () => { commands++; return pending; },
      status: async () => { reads++; return pending; } }, 'file', intent, {
      active: () => true, onProgress: () => {}, wait: async delay => { waits.push(delay); },
    });
    expect(result).toEqual(pending);
    expect(commands).toBe(1);
    expect(reads).toBe(7);
    expect(waits).toEqual([1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(30_000);
  });

  test('checking an existing job reads status and never resubmits its write', async () => {
    let writes = 0, reads = 0;
    expect(await pollLibraryApply({ apply: async () => { writes++; return complete; },
      status: async () => { reads++; return complete; } }, 'file', intent, {
      active: () => true, onProgress: () => {}, checkOnly: true,
    })).toEqual(complete);
    expect(writes).toBe(0); expect(reads).toBe(1);
  });

  test('terminal stalled state retains the actual reason and stops reads', async () => {
    const stalled: ApplyProgress = { ...pending, pending: false, state: 'stalled', reason: 'lease-expired' };
    let reads = 0;
    expect(await pollLibraryApply({ apply: async () => pending, status: async () => { reads++; return stalled; } },
      'file', intent, { active: () => true, onProgress: () => {}, wait: async () => {} })).toEqual(stalled);
    expect(reads).toBe(1);
  });

  test('admission exhaustion while reading status preserves accepted pending work', async () => {
    expect(await pollLibraryApply({ apply: async () => pending,
      status: async () => { throw new ImportError('admission'); } }, 'file', intent,
    { active: () => true, onProgress: () => {}, wait: async () => {} })).toEqual(pending);
  });

  test('abort during an in-flight status read returns null and prevents later reads', async () => {
    const controller = new AbortController();
    let reads = 0;
    const result = pollLibraryApply({ apply: async () => pending, status: async (_id, options) => {
      reads++; controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      return new Promise(() => {});
    } }, 'file', intent, { signal: controller.signal, active: () => true, onProgress: () => {}, wait: async () => {} });
    expect(await result).toBeNull(); expect(reads).toBe(1);
  });

  test('exhausted first submission is an admission refusal, not a manufactured accepted job', async () => {
    await expect(pollLibraryApply({ apply: async () => { throw new ImportError('admission'); } }, 'file', intent,
      { active: () => true, onProgress: () => {} })).rejects.toEqual(new ImportError('admission'));
  });

  test('an apply intent is committed only after every ambiguous row has a choice', () => {
    const rows = goodreadsRows();
    expect(canCommitApplyIntent(rows, false)).toBe(false);
    expect(canCommitApplyIntent(rows, true)).toBe(true);
    const chosen = rows.map(row => row.match?.kind === 'ambiguous' ? { ...row, resolution: { choice: 'private' as const } } : row);
    // Not-found rows are kept private as apply starts; they do not block the intent.
    expect(canCommitApplyIntent(chosen, false)).toBe(true);
  });

});
