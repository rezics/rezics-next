import { expect, test } from 'bun:test';
import { reporterHistoryPage } from '../src/moderation/reporter-history/model';
import { loadReporterHistory } from '../src/moderation/reporter-history/read';

const id = '11111111-1111-8111-8111-123411111111';
const targetId = '22222222-2222-7222-8222-234522222222';
const entry = {
  id,
  target: { kind: 'thread', id: targetId },
  revisionId: null,
  reason: 'spam',
  evidence: 'My evidence',
  createdAt: '2026-11-03T10:00:00.000000Z',
  outcome: null,
  resolvedAt: null,
  targetSummary: { state: 'unavailable' },
  viewer: { ownsReport: true },
  actions: {
    open: { method: 'GET', href: `/v1/reports/${id}` },
    follow: { method: 'GET', href: `/v1/reports/${id}` },
    target: null,
  },
};
const page = {
  state: 'ready',
  entries: [entry],
  selectedReportId: id,
  nextCursor: 'opaque-next',
  retry: { cursor: 'original' },
  viewer: { kind: 'reporter' },
};

test('exact selection and concealed targets remain independent from sparse continuation', () => {
  expect(reporterHistoryPage(page, { cursor: 'original', reportId: id })).toEqual(page);
  expect(
    reporterHistoryPage({ ...page, entries: [], selectedReportId: null }, { cursor: 'original', reportId: id })
      .nextCursor,
  ).toBe('opaque-next');
  expect(
    reporterHistoryPage(
      { ...page, state: 'preparing', entries: [], selectedReportId: null, nextCursor: null },
      { cursor: 'original' },
    ).state,
  ).toBe('preparing');
  for (const invalid of [
    { ...page, retry: { cursor: 'advanced' } },
    { ...page, entries: [entry, entry] },
    { ...page, viewer: { kind: 'moderator' } },
    { ...page, entries: [{ ...entry, moderatorNotes: 'private' }] },
    {
      ...page,
      entries: [{ ...entry, actions: { ...entry.actions, target: { method: 'GET', href: 'https://evil.test' } } }],
    },
    { ...page, selectedReportId: targetId },
  ])
    expect(() => reporterHistoryPage(invalid, { cursor: 'original', reportId: id })).toThrow();
});

test('the generated own-history callable preserves exact operands, no-store reads and opaque native provenance', async () => {
  const calls: Array<{ query: unknown; fetch?: unknown }> = [];
  const success = {
    data: page,
    error: null,
    response: new Response(null, { headers: { 'rezics-session-token': 'opaque-anchor' } }),
    status: 200,
  };
  const ownHistoryClient = (result: unknown) => {
    const reports = Object.assign(() => undefined, {
      me: {
        get: async (input: { query: unknown; fetch?: unknown }) => {
          calls.push(input);
          return result;
        },
      },
    });
    return { reports } as unknown as Parameters<typeof loadReporterHistory>[0];
  };
  const result = await loadReporterHistory(ownHistoryClient(success), { cursor: 'original', reportId: id });
  expect(result.state).toBe('loaded');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query).toEqual({ cursor: 'original', reportId: id });
  expect(calls[0]!.fetch).toMatchObject({ cache: 'no-store' });
  expect(JSON.stringify(result)).not.toContain('opaque-anchor');
  const denied = ownHistoryClient({ data: undefined, error: { value: {} }, response: new Response(null), status: 403 });
  expect((await loadReporterHistory(denied, {})).state).toBe('denied');
  const expired = ownHistoryClient({
    data: undefined,
    error: { value: { code: 'invalid_cursor' } },
    response: new Response(null),
    status: 400,
  });
  expect((await loadReporterHistory(expired, {})).state).toBe('expired');
});
