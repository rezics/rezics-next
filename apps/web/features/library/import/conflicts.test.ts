import { describe, expect, test } from 'bun:test';
import type { ImportApi, ImportRow } from '../import-api.ts';
import { goodreadsRows } from '../import-fixtures.ts';
import { reconcileConflictChoices } from './conflicts.ts';

function recorder() {
  const saved: Array<[number, unknown]> = [];
  const api: Pick<ImportApi, 'resolve'> = { resolve: async (_id, row, choice) => { saved.push([row.index, choice]); } };
  return { api, saved };
}
const replaced = (row: ImportRow): ImportRow => ({ ...row, resolution: { choice: 'apply', work: row.match!.work!, conflictChoice: 'replace' } });

describe('conflict policy reconciliation', () => {
  test('keeping the reader\'s values clears every replace an interrupted preparation saved', async () => {
    const rows = goodreadsRows().map(row => row.index < 2 ? replaced(row) : row);
    const { api, saved } = recorder();
    await reconcileConflictChoices(api, 'file', rows, false, new AbortController().signal);
    expect(saved.map(([index]) => index)).toEqual([0, 1]);
    expect(saved.every(([, choice]) => !('conflictChoice' in (choice as object)))).toBe(true);
  });

  test('using imported values saves replace only where it is not already saved', async () => {
    const rows = goodreadsRows().map(row => row.index === 0 ? replaced(row) : row);
    const { api, saved } = recorder();
    await reconcileConflictChoices(api, 'file', rows, true, new AbortController().signal);
    expect(saved.map(([index]) => index)).toEqual([1, 2, 3, 4, 5]);
    expect(saved.every(([, choice]) => (choice as { conflictChoice: string }).conflictChoice === 'replace')).toBe(true);
  });

  test('a private or unmatched row never carries a conflict choice', async () => {
    const rows = goodreadsRows().map(row => row.match?.kind === 'matched' ? { ...row, resolution: { choice: 'private' as const } } : row);
    const { api, saved } = recorder();
    await reconcileConflictChoices(api, 'file', rows, true, new AbortController().signal);
    expect(saved).toEqual([]);
  });

  test('a closed importer saves nothing more', async () => {
    const lease = new AbortController();
    const { api, saved } = recorder();
    lease.abort();
    await expect(reconcileConflictChoices(api, 'file', goodreadsRows(), true, lease.signal)).rejects.toBeDefined();
    expect(saved).toEqual([]);
  });
});
