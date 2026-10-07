import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../../discover/types.ts';
import { mainCopiesApi } from './api.ts';
import { changedCopyMatches, extendedLoanMatches, openedLoanMatches, removedCopyMatches, returnedLoanMatches,
  savedCopyMatches } from './intent.ts';
import { memoryCopiesApi } from './memory.ts';
import { recordOwnedCopy } from './record.ts';
import type { CopyChange, CopyDraft, CopyRecord, LoanDraft, LoanRecord, RecordResult } from './types.ts';
import { commandInstance, resetRecordLanes, submitRecord, writeNewest } from './write.ts';

const party = { kind: 'name' as const, name: 'City Library' };
const copy: CopyRecord = {
  id: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  release: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  format: 'Paperback', acquiredFrom: party, acquiredAt: '2024-02-01T00:00:00.000Z',
  ownedFrom: '2024-03-01T00:00:00.000Z', ownedThrough: null, removed: false, version: 1,
  changedAt: '2026-10-01T00:00:00.000Z',
};
const draft: CopyDraft = { release: copy.release, format: copy.format, acquiredFrom: party,
  acquiredAt: copy.acquiredAt, ownedFrom: copy.ownedFrom };
const loan: LoanRecord = {
  id: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004', copy: copy.id, direction: 'lent',
  counterparty: party, startedAt: '2026-09-01T00:00:00.000Z', dueAt: '2026-10-20T23:59:59.999Z', returnedAt: null,
  version: 2, changedAt: '2026-10-01T00:00:00.000Z', state: 'open',
};
const loanDraft: LoanDraft = { copy: loan.copy, direction: loan.direction, counterparty: party,
  startedAt: loan.startedAt, dueAt: loan.dueAt };

/**
 * The first call commits and loses its response. A retry with the same key
 * replays that receipt; a different key is a second record.
 */
function lostClient(body: CopyRecord | LoanRecord) {
  const keys: string[] = [];
  let committed: string | null = null;
  const take = (options?: { headers?: Record<string, string> }) => {
    const key = options?.headers?.['idempotency-key'] ?? '';
    keys.push(key);
    if (committed === null) {
      committed = key;
      throw new Error('lost response');
    }
    const data = committed === key ? body : { ...body, id: `${body.id}-again` };
    return Promise.resolve({ data, error: null });
  };
  const copies = Object.assign(
    (_params: { id: string }) => ({
      patch: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options),
      delete: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options),
    }),
    { post: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options) },
  );
  const loans = Object.assign(
    (_params: { id: string }) => ({
      extend: { post: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options) },
      return: { post: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options) },
    }),
    { post: (_request: unknown, options?: { headers?: Record<string, string> }) => take(options) },
  );
  const main = (() => ({ v1: { me: { 'library-copies': copies, 'library-loans': loans } } })) as unknown as
    () => MainClient;
  return { keys, api: mainCopiesApi('https://rezics.com/id/00000000-0000-4000-8000-0000000000aa', main) };
}

async function lost<T>(record: string, choice: T, body: CopyRecord | LoanRecord,
  write: (api: ReturnType<typeof lostClient>['api'], choice: T, key: string) => Promise<RecordResult<CopyRecord | LoanRecord>>) {
  resetRecordLanes();
  const client = lostClient(body);
  const result = await submitRecord(record, choice, (current, round) => writeNewest(round, 0,
    () => write(client.api, current, round.key),
    async () => ({ ok: true, data: null }), () => false, () => 1, false));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.data).toMatchObject({ id: body.id });
  expect(client.keys).toHaveLength(2);
  expect(client.keys[0]).toBe(client.keys[1]);
  expect(client.keys[0]).not.toBe('');
}

async function conflicted<T, R extends { version: number }>(record: string, choice: T, partial: R, whole: R,
  matches: (current: R, choice: T) => boolean) {
  resetRecordLanes();
  const once = (current: R) => submitRecord(`${record}:${current === partial ? 'part' : 'whole'}`, choice,
    (intent, round) => writeNewest(round, 1, async () => ({ ok: false, failure: 'conflict' as const }),
      async () => ({ ok: true, data: current }), held => matches(held, intent), item => item.version, false));
  expect(await once(partial)).toEqual({ ok: false, failure: 'conflict' });
  expect(await once(whole)).toEqual({ ok: true, data: whole });
}

describe('command identity', () => {
  test('two identical copies recorded in a row are two copies', async () => {
    resetRecordLanes();
    const work = copy.work;
    const api = memoryCopiesApi({ work });
    const command = commandInstance();
    const first = await recordOwnedCopy(api, command, work, draft);
    const second = await recordOwnedCopy(api, command, work, draft);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(api.state.copies).toHaveLength(2);
    if (first.ok && second.ok) expect(first.data.id).not.toBe(second.data.id);
  });

  test('save copy retries a lost response with the intent key', async () => {
    await lost('save-copy', draft, copy, (api, choice, key) => api.createCopy(choice, key));
  });

  test('save copy reports a conflict unless every saved field matches', async () => {
    await conflicted('save-copy-match', draft, { ...copy, acquiredAt: '2020-01-01T00:00:00.000Z' }, copy,
      savedCopyMatches);
  });

  test('edit copy retries a lost response with the intent key', async () => {
    const changes: CopyChange = { format: 'Paperback', ownedFrom: '2024-04-01T00:00:00.000Z' };
    const edited = { ...copy, ...changes, version: 2 };
    await lost('edit-copy', changes, edited, (api, choice, key) => api.changeCopy(copy.id, 1, choice, key));
  });

  test('edit copy reports a conflict when one changed field still differs', async () => {
    const changes: CopyChange = { format: 'Paperback', ownedFrom: '2024-04-01T00:00:00.000Z' };
    await conflicted('edit-copy-match', changes, { ...copy, format: 'Paperback', ownedFrom: null, version: 2 },
      { ...copy, ...changes, version: 2 }, changedCopyMatches);
  });

  test('remove retries a lost response with the intent key', async () => {
    const removed = { ...copy, removed: true, version: 2 };
    await lost('remove-copy', copy.version, removed, (_api, _version, key) => _api.removeCopy(copy.id, 1, key));
  });

  test('remove reports a conflict when the copy is still on the shelf', async () => {
    await conflicted('remove-copy-match', copy.version, copy, { ...copy, removed: true, version: 2 },
      current => removedCopyMatches(current));
  });

  test('open loan retries a lost response with the intent key', async () => {
    await lost('open-loan', loanDraft, loan, (api, choice, key) => api.openLoan(choice, key));
  });

  test('open loan reports a conflict when the start differs', async () => {
    await conflicted('open-loan-match', loanDraft, { ...loan, startedAt: '2026-08-01T00:00:00.000Z' }, loan,
      openedLoanMatches);
  });

  test('extend retries a lost response with the intent key', async () => {
    const extended = { ...loan, dueAt: '2026-11-01T23:59:59.999Z', version: 3 };
    await lost('extend-loan', extended.dueAt, extended, (api, dueAt, key) => api.extendLoan(loan.id, 2, dueAt, key));
  });

  test('extend reports a conflict when the due date differs', async () => {
    const dueAt = '2026-11-01T23:59:59.999Z';
    await conflicted('extend-loan-match', dueAt, loan, { ...loan, dueAt, version: 3 },
      (current, choice) => extendedLoanMatches(current, choice));
  });

  test('return retries a lost response with the intent key', async () => {
    const returned = { ...loan, returnedAt: '2026-10-02T00:00:00.000Z', version: 3, state: 'returned' as const };
    await lost('return-loan', loan.version, returned, (api, _version, key) => api.returnLoan(loan.id, 2, key));
  });

  test('return reports a conflict when the loan is still out', async () => {
    const returned = { ...loan, returnedAt: '2026-10-02T00:00:00.000Z', version: 3, state: 'returned' as const };
    await conflicted('return-loan-match', loan.version, loan, returned, current => returnedLoanMatches(current));
  });
});
