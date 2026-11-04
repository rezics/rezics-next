import { expect, test } from 'bun:test';
import { reporterHistoryPage } from '../src/moderation/reporter-history/model';
import { loadReporterHistory } from '../src/moderation/reporter-history/read';

const id = '11111111-1111-8111-8111-123411111111';
const targetId = '22222222-2222-7222-8222-234522222222';
const entry = {
  id, target: { kind: 'thread', id: targetId }, revisionId: null,
  reason: 'spam', evidence: 'My evidence', createdAt: '2026-11-03T10:00:00.000000Z',
  outcome: null, resolvedAt: null, targetSummary: { state: 'unavailable' },
  viewer: { ownsReport: true }, actions: {
    open: { method: 'GET', href: `/v1/reports/${id}` },
    follow: { method: 'GET', href: `/v1/reports/${id}` }, target: null,
  },
};
const page = { state: 'ready', entries: [entry], selectedReportId: id, nextCursor: 'opaque-next',
  retry: { cursor: 'original' }, viewer: { kind: 'reporter' } };

test('exact selection and concealed targets remain independent from sparse continuation', () => {
  expect(reporterHistoryPage(page, { cursor: 'original', reportId: id })).toEqual(page);
  expect(reporterHistoryPage({ ...page, entries: [], selectedReportId: null }, { cursor: 'original', reportId: id }).nextCursor).toBe('opaque-next');
  expect(reporterHistoryPage({ ...page, state: 'preparing', entries: [], selectedReportId: null, nextCursor: null }, { cursor: 'original' }).state).toBe('preparing');
  for (const invalid of [
    { ...page, retry: { cursor: 'advanced' } },
    { ...page, entries: [entry, entry] },
    { ...page, viewer: { kind: 'moderator' } },
    { ...page, entries: [{ ...entry, moderatorNotes: 'private' }] },
    { ...page, entries: [{ ...entry, actions: { ...entry.actions, target: { method: 'GET', href: 'https://evil.test' } } }] },
    { ...page, selectedReportId: targetId },
  ]) expect(() => reporterHistoryPage(invalid, { cursor: 'original', reportId: id })).toThrow();
});

test('the local consumer seam sends one own-endpoint read with exact opaque operands and native provenance', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(page), { headers: { 'rezics-session-token': 'opaque-anchor' } });
  }) as typeof fetch;
  const result = await loadReporterHistory('https://kernel.test', 'Bearer private', { cursor: 'original', reportId: id }, send);
  expect(result.state).toBe('loaded');
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe('/v1/reports/me');
  expect([...url.searchParams]).toEqual([['cursor', 'original'], ['reportId', id]]);
  expect(calls[0]!.init).toMatchObject({ cache: 'no-store', headers: { authorization: 'Bearer private' } });
  expect(JSON.stringify(result)).not.toContain('opaque-anchor');
  expect((await loadReporterHistory('https://kernel.test', 'Bearer private', {}, (async () => new Response('{}', { status: 403 })) as typeof fetch)).state).toBe('denied');
  expect((await loadReporterHistory('https://kernel.test', 'Bearer private', {}, (async () => new Response(JSON.stringify({ code: 'invalid_cursor' }), { status: 400 })) as typeof fetch)).state).toBe('expired');
});
