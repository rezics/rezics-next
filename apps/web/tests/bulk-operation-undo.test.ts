import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { BulkOperationUndo, undoOperand, bulkOperationUndoHref } from '../src/library/bulk-operation-undo';
import { prepareNativeBulkUndo } from '../src/library/bulk-operation-undo-native';
import type { BulkOperation } from '../src/library/bulk-operation-recovery-native';
import type { LibraryRestoreInput } from '../src/library/entries-read';

const id = '12345678-1234-4234-8234-123456789abc';
const operation: BulkOperation = {
  id,
  route: 1,
  action: 'remove_from_library',
  state: null,
  collectionId: null,
  selectionKind: 'explicit',
  phase: 'completed',
  selectionComplete: true,
  occurrencesComplete: true,
  cancelRequested: false,
  counts: {
    scannedCandidates: 2,
    selectedSubjects: 2,
    scannedOccurrences: 0,
    capturedOccurrences: 0,
    targets: 2,
    applied: 2,
    pending: 0,
    no_effect: 0,
    reconciling: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
  },
  summary: null,
  admittedAt: '2026-11-03T00:00:00Z',
  targetBoundAt: null,
  expiresAt: '2099-11-04T00:00:00Z',
  resultsExpireAt: '2099-11-05T00:00:00Z',
  finishedAt: '2026-11-03T01:00:00Z',
  reason: null,
};
const outcome: import('../src/library/bulk-operation-undo-evidence').BulkUndoOutcome = {
  ordinal: '0',
  subjectId: 'book-one',
  memberId: null,
  resultingMemberId: null,
  state: 'applied',
  reason: null,
  deletion: { deletionId: id, revision: 12, restoreUntil: '2099-11-04T00:00:00Z' },
};
const ready = {
  state: 'ready' as const,
  operation,
  page: { outcomes: [outcome, { ...outcome, ordinal: '1', subjectId: 'book-two' }], next: null },
};

test('reopened Undo uses only disclosed personal removal evidence and its original deadline', () => {
  expect(bulkOperationUndoHref('zh-Hant', id)).toBe(`/zh-Hant/library/operations/${id}/undo`);
  expect(undoOperand(operation, outcome)?.subjectId).toBe('book-one');
  for (const row of [
    { ...outcome, deletion: null },
    { ...outcome, state: 'no_effect' as const },
    { ...outcome, memberId: 'occurrence' },
    { ...outcome, deletion: { ...outcome.deletion!, restoreUntil: 'invalid' } },
  ])
    expect(undoOperand(operation, row)).toBeUndefined();
  expect(undoOperand({ ...operation, action: 'remove_from_collection' }, outcome)).toBeUndefined();
  expect(undoOperand(operation, outcome, Date.parse(outcome.deletion!.restoreUntil))).toBeUndefined();
});

test('GET captures nothing; each chosen restore retains its own sender, full headers and command across read recovery', async () => {
  let csrf = 'original';
  let admitted = true;
  let prepares = 0;
  const calls: { data: LibraryRestoreInput; headers: Headers }[] = [];
  let sender = async (input: { data: LibraryRestoreInput; headers: Headers }) => {
    calls.push(input);
    return { ok: false as const, reason: 'unavailable' as const };
  };
  const model = new BulkOperationUndo(
    { id, viewer: 'alice' },
    {
      current: () => true,
      capture: () => () => true,
      captureRestore: () => () => admitted,
      csrf: () => csrf,
      restore: () => admitted,
      headers: () => new Headers({ 'X-CSRF-Token': csrf, 'X-Original': csrf }),
    },
    {
      read: async () => ready,
      prepare: async (target) => {
        prepares++;
        return {
          state: 'ready',
          undo: {
            subjectId: target.subjectId,
            deletionId: id,
            revision: 12,
            idempotencyKey: crypto.randomUUID(),
            credential: 'encrypted_original',
            restoreUntil: outcome.deletion!.restoreUntil,
          },
        };
      },
      sender: () => sender,
    },
    () => {},
  );
  await model.read();
  expect(prepares).toBe(0);
  admitted = false;
  await model.restore('0');
  expect(prepares).toBe(0);
  admitted = true;
  await model.restore('0');
  csrf = 'replacement';
  sender = async () => {
    throw new Error('replacement sender must not run');
  };
  await model.read();
  await model.restore('0', true);
  expect(prepares).toBe(1);
  expect(calls[1]!.data).toBe(calls[0]!.data);
  expect([...calls[1]!.headers]).toEqual([...calls[0]!.headers]);
  expect(calls[1]!.headers.get('X-CSRF-Token')).toBe('original');
  sender = async (input) => {
    calls.push(input);
    return { ok: false, reason: 'unavailable' };
  };
  await model.restore('1');
  expect(prepares).toBe(2);
  expect(calls[2]!.data.idempotencyKey).not.toBe(calls[0]!.data.idempotencyKey);
  expect(calls[2]!.headers.get('X-CSRF-Token')).toBe('replacement');
});

test('first preparation reauthorizes the exact target and seals credentials before ordinary restore dispatch', async () => {
  const csrf = 'a'.repeat(22);
  let bearer = 'original';
  const env = {
    SITE_ORIGINS: 'https://site.test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (value: string) => value,
      get: () => ({
        credential: async () => ({ status: 'active', subject: 'alice', accessToken: bearer, csrfToken: csrf }),
      }),
    },
  } as unknown as import('../src/session/client').SessionEnv;
  const requests: Request[] = [];
  let admitted = ['personal_library', 'library_entry.restore'];
  let row = outcome;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      return Response.json(
        request.url.endsWith('/exposure')
          ? { admitted }
          : request.url.includes('/outcomes')
            ? { outcomes: [row], next: null }
            : { operation },
      );
    }) as typeof fetch,
  });
  const request = () =>
    new Request('https://site.test/action', {
      method: 'POST',
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin: 'https://site.test',
        'X-CSRF-Token': csrf,
      },
    });
  const target = { id, viewer: 'alice', ordinal: '0', subjectId: 'book-one', csrf };
  const prepared = await prepareNativeBulkUndo(client, request(), env, target);
  expect(prepared.state).toBe('ready');
  if (prepared.state !== 'ready') throw new Error('missing prepared command');
  const { originalEntryRestoreCredential } = await import('../src/library/entry-restore-credential');
  const { prepareSession } = await import('../src/session/request');
  bearer = 'replacement';
  const recovered = request();
  await prepareSession(recovered, env);
  expect(await originalEntryRestoreCredential(recovered, env, prepared.undo.credential)).toBe('Bearer original');
  expect(prepared.undo.restoreUntil).toBe(outcome.deletion!.restoreUntil);
  admitted = ['personal_library'];
  expect((await prepareNativeBulkUndo(client, request(), env, target)).state).toBe('forbidden');
  admitted.push('library_entry.restore');
  row = { ...outcome, subjectId: 'another-subject' };
  expect((await prepareNativeBulkUndo(client, request(), env, target)).state).toBe('invalid');
  row = { ...outcome, deletion: { ...outcome.deletion!, restoreUntil: '2000-01-01T00:00:00Z' } };
  expect((await prepareNativeBulkUndo(client, request(), env, target)).state).toBe('expired');
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

test.each(['occupied', 'stale', 'expired'] as const)(
  'native %s finishes only the chosen target without replacement deletion or automatic restoration',
  async (reason) => {
    let sends = 0;
    let prepares = 0;
    const model = new BulkOperationUndo(
      { id, viewer: 'alice' },
      {
        current: () => true,
        capture: () => () => true,
        captureRestore: () => () => true,
        restore: () => true,
        csrf: () => 'csrf',
        headers: () => new Headers({ 'X-CSRF-Token': 'csrf' }),
      },
      {
        read: async () => ready,
        prepare: async (target) => {
          prepares++;
          return {
            state: 'ready',
            undo: {
              subjectId: target.subjectId,
              deletionId: id,
              revision: 12,
              restoreUntil: outcome.deletion!.restoreUntil,
              idempotencyKey: crypto.randomUUID(),
            },
          };
        },
        sender: () => async () => {
          sends++;
          return { ok: false, reason };
        },
      },
      () => {},
    );
    await model.read();
    await model.restore('0');
    await model.read();
    await model.restore('0');
    await model.restore('0', true);
    expect([prepares, sends]).toEqual([1, 1]);
    expect(model.attempts.get('0')?.result).toEqual({ ok: false, reason });
    expect(model.attempts.has('1')).toBe(false);
  },
);
