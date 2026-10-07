import { describe, expect, test } from 'bun:test';
import { ImportError, type ApplyProgress } from '../import-api.ts';
import { pollLibraryApply } from './apply.ts';

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
    expect(waits).toEqual(Array<number>(7).fill(1000));
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
});
