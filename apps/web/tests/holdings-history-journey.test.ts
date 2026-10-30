import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadCopiesPage, removeCopy, restoreCopy } from '../src/library/copies-read';
import { loadProgressSession } from '../src/library/progress-reads';
import { progressView } from '../src/library/progress-label';
import { deletePublishedLog, loadPublishedLog, restorePublishedLog } from '../src/library/logs-read';
import { deletionEvidence } from '../src/library/copies-receipt';

const copyId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const logId = '0192f3a0-6c1e-7b2a-9d4e-000000000030';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000040';
const deletionId = '0192f3a0-6c1e-7b2a-9d4e-000000000050';
const key = '10203040-5060-4070-8090-102030405060';
const request = () =>
  new Request('https://site.example.test/en/library/progress', {
    method: 'POST',
    headers: { authorization: 'Bearer current-credential' },
  });
const copy = {
  id: copyId,
  subjectId,
  kind: 'old-kind',
  status: 'old-status',
  revision: 3,
  location: 'Shelf',
  source: null,
  acquiredOn: null,
  disposedOn: null,
  note: 'Original holding',
  subject: null,
};
const progress = {
  id: sessionId,
  subjectId,
  versionSubjectId: null,
  mode: 'completed_units',
  unit: 'old-unit',
  total: null,
  amount: null,
  locator: null,
  position: null,
  completedUnitCount: 3,
  state: 'active',
  revision: 2,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  subject: null,
};
const log = {
  id: logId,
  accountId: 'owner',
  subjectId,
  sessionState: 'completed',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-02-01T00:00:00Z',
  note: 'Only this public note',
  publishedAt: '2026-03-01T00:00:00Z',
  subject: null,
  account: null,
};

function transport(answer: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = new Request(input, init);
        calls.push(call.clone());
        expect(call.headers.get('authorization')).toBe('Bearer current-credential');
        return answer(call);
      },
      { preconnect() {} },
    ),
  });
  return { client, calls };
}

test('holdings keep native stale-delete guards and restore the actual deletion episode without recreating a copy', async () => {
  let stale = true;
  const { client, calls } = transport(async (call) => {
    const url = new URL(call.url);
    if (call.method === 'GET') {
      expect(url.pathname).toBe('/v1/copies');
      expect(url.searchParams.get('view')).toBe('FULL');
      expect(url.searchParams.get('limit')).toBe('100');
      return Response.json({ copies: [copy], next: null });
    }
    expect(call.headers.get('idempotency-key')).toBe(key);
    if (call.method === 'DELETE') {
      expect(url.searchParams.get('revision')).toBe('3');
      if (stale) return Response.json({ code: 'conflict' }, { status: 409 });
      return new Response(null, {
        status: 204,
        headers: {
          'Library-Copy-Deletion-Id': deletionId,
          'Library-Copy-Deletion-Revision': '4',
        },
      });
    }
    expect(url.pathname).toBe(`/v1/copies/${copyId}:restore`);
    expect(await call.json()).toEqual({ deletionId, revision: 4 });
    return Response.json({ copy: { ...copy, revision: 5 } });
  });
  const page = await loadCopiesPage(client, request(), {}, {});
  expect(page.copies[0]).toMatchObject({ kind: 'old-kind', status: 'old-status', subject: null });
  expect(page.copies[0]).not.toHaveProperty('subjectId');
  expect(page.copies[0]).not.toHaveProperty('kindLabel');
  expect(await removeCopy(client, request(), {}, { id: copyId, revision: 3, idempotencyKey: key })).toEqual({
    ok: false,
    reason: 'conflict',
  });
  stale = false;
  const removed = await removeCopy(client, request(), {}, { id: copyId, revision: 3, idempotencyKey: key });
  expect(removed).toEqual({ ok: true, undo: { deletionId, revision: 4 } });
  if (!removed.ok || !removed.undo) throw new Error('Native deletion evidence missing');
  const restored = await restoreCopy(client, request(), {}, { id: copyId, ...removed.undo, idempotencyKey: key });
  expect(restored).toMatchObject({
    ok: true,
    copy: { id: copyId, kind: 'old-kind', status: 'old-status', revision: 5 },
  });
  expect(calls).toHaveLength(4);
  expect(deletionEvidence(new Headers(), 'Copy')).toBeUndefined();
  expect(
    deletionEvidence(
      new Headers({ 'Library-Copy-Deletion-Id': deletionId, 'Library-Copy-Deletion-Revision': '0' }),
      'Copy',
    ),
  ).toBeUndefined();
});

test('historical sessions retain sparse units, exact decimals and cursor meaning in three bounded authorized reads', async () => {
  const { client, calls } = transport((call) => {
    const url = new URL(call.url);
    expect(url.searchParams.get('view')).toBe('FULL');
    if (url.pathname.endsWith('/changes')) {
      expect(url.searchParams.get('limit')).toBe('100');
      return Response.json({
        changes: [{ id: 'change-1', revision: 2, intent: { add: ['1', '3', '7'] }, createdAt: '2026-01-02T00:00:00Z' }],
        next: 'next-history',
      });
    }
    if (url.pathname.endsWith('/completedUnits')) {
      expect(url.searchParams.get('limit')).toBe('100');
      return Response.json({ completedUnits: ['1', '3', '7'], next: null });
    }
    return Response.json({ progressSession: progress });
  });
  const page = await loadProgressSession(client, request(), {}, { id: sessionId });
  if (!page.signedIn) throw new Error('Expected the authorized session');
  expect(page.session.units).toEqual(['1', '3', '7']);
  expect(page.session.changes[0]?.add).toEqual(['1', '3', '7']);
  expect(page.session.changesNext).toBe('next-history');
  expect(page.session.total).toBeNull();
  expect(page.session.unit).toBe('old-unit');
  expect(page.session).not.toHaveProperty('unitLabel');
  expect(page.session).not.toHaveProperty('pin');
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => !call.url.includes('/definitions') && !call.url.includes('/subjects'))).toBe(true);
  const exact = progressView(
    { ...page.session, mode: 'scalar_amount', amount: '999999999999.123456', total: null },
    'en',
  );
  expect(exact).toEqual({ text: '999,999,999,999.123456', percent: null });
  expect(
    progressView({ ...page.session, mode: 'cursor_position', locator: 'Part 2, Chapter 9', position: null }, 'en'),
  ).toEqual({ text: 'Part 2, Chapter 9', percent: null });
});

test('published log Undo uses owner evidence, preserves the original snapshot, and refuses expired or erased records', async () => {
  let refusal: 'published_log_restore_expired' | 'not_found' | undefined;
  const { client, calls } = transport(async (call) => {
    const url = new URL(call.url);
    if (call.method === 'GET') {
      if (url.pathname === '/v1/publishedLogs') return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(
        {
          publishedLog: {
            ...log,
            sessionId,
            units: ['private'],
            changes: ['private'],
            pin: { releaseDigest: 'private' },
          },
        },
        {
          headers: { 'Library-Published-Log-Revision': '3' },
        },
      );
    }
    if (call.method === 'DELETE') {
      expect(url.searchParams.get('revision')).toBe('3');
      return Response.json(
        { publishedLog: log },
        {
          headers: {
            'Library-Published-Log-Deletion-Id': deletionId,
            'Library-Published-Log-Deletion-Revision': '4',
          },
        },
      );
    }
    expect(url.pathname).toBe(`/v1/publishedLogs/${logId}:restore`);
    expect(await call.json()).toEqual({ deletionId, revision: 4 });
    return refusal
      ? Response.json({ code: refusal }, { status: refusal === 'not_found' ? 404 : 409 })
      : Response.json({ publishedLog: log }, { headers: { 'Library-Published-Log-Revision': '5' } });
  });
  const publicView = await loadPublishedLog(client, request(), {}, { id: logId });
  expect(publicView.log).toEqual({
    id: logId,
    sessionState: log.sessionState,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    note: log.note,
    publishedAt: log.publishedAt,
    subject: null,
    account: null,
  });
  expect(publicView).not.toHaveProperty('revision');
  const removed = await deletePublishedLog(client, request(), {}, { id: logId, revision: 3, idempotencyKey: key });
  expect(removed).toEqual({ ok: true, id: logId, undo: { deletionId, revision: 4 } });
  const restore = { id: logId, deletionId, revision: 4, idempotencyKey: key };
  expect(await restorePublishedLog(client, request(), {}, restore)).toEqual({ ok: true, id: logId, revision: 5 });
  refusal = 'published_log_restore_expired';
  expect(await restorePublishedLog(client, request(), {}, restore)).toEqual({ ok: false, reason: 'conflict' });
  refusal = 'not_found';
  expect(await restorePublishedLog(client, request(), {}, restore)).toEqual({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(5);
  expect(calls.some((call) => call.url.includes('/progressSessions'))).toBe(false);
});
