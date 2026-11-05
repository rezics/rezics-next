import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import sessions from '../src/kernel/recorded/library-continue-progress-sessions.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { CONTINUE_LIMIT, homeContinueQuery, loadContinue } = await import('../src/library/continue-read');

function request(signedIn = true) {
  return new Request('https://site.example.test/en/library', {
    ...(signedIn ? { headers: { authorization: 'Bearer owner-token' } } : {}),
  });
}

function kernel(response: () => Response) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    async fetch(input, init) {
      const incoming = new Request(input, init);
      calls.push(incoming);
      const url = new URL(incoming.url);
      if (incoming.method === 'GET' && url.pathname === '/v1/libraryContinue') return response();
      if (incoming.method === 'POST' && url.pathname === '/v1/pages:read') {
        return Response.json({
          reads: Object.fromEntries(
            sessions.progressSessions.map((session) => [
              `subject:${session.subjectId}`,
              { status: 200, body: { subject: session.subject } },
            ]),
          ),
        });
      }
      throw new Error(`Unexpected Continue request: ${incoming.method} ${url.pathname}`);
    },
  });
  return { client, calls };
}

test('Continue preserves session-only and non-active-state session support with one bounded batch', async () => {
  const selected = sessions.progressSessions.slice(0, 2);
  const { client, calls } = kernel(() =>
    Response.json({
      subjects: selected.map((session, index) => ({
        subjectId: session.subjectId,
        state: index === 0 ? null : 'completed',
        lastActivityAt: session.startedAt,
        activeProgressSession: session,
      })),
      next: null,
    }),
  );
  const entries = await loadContinue(client, request(), {});
  expect(entries.map((entry) => entry.subjectId)).toEqual(selected.map((session) => session.subjectId));
  expect(entries.map((entry) => entry.progress?.sessionId)).toEqual(selected.map((session) => session.id));
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['GET', '/v1/libraryContinue'],
    ['POST', '/v1/pages:read'],
  ]);
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([['limit', String(CONTINUE_LIMIT)]]);
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer owner-token')).toBe(true);
  expect(await calls[1]!.json()).toMatchObject({
    reads: Object.fromEntries(
      selected.map((session) => [`subject:${session.subjectId}`, { kind: 'subject', id: session.subjectId }]),
    ),
  });
});

for (const status of [401, 403, 404, 503]) {
  test(`Continue HTTP ${status} remains a failure instead of a genuine empty Library`, async () => {
    const { client, calls } = kernel(() => Response.json({ code: 'dependency_unavailable' }, { status }));
    const outcome = await loadContinue(client, request(), {}).then(
      (entries) => ({ kind: 'resolved', entries }),
      () => ({ kind: 'rejected' }),
    );
    expect(outcome).not.toEqual({ kind: 'resolved', entries: [] });
    expect(calls).toHaveLength(1);
  });
}

test('Continue preparation remains distinct from exhausted input and starts no further reads', async () => {
  const { client, calls } = kernel(() =>
    Response.json(
      { preparing: true },
      { status: 202, headers: { 'cache-control': 'private, no-store', 'retry-after': '2' } },
    ),
  );
  const outcome = await loadContinue(client, request(), {}).then(
    (entries) => ({ kind: 'resolved', entries }),
    () => ({ kind: 'rejected' }),
  );
  expect(outcome).not.toEqual({ kind: 'resolved', entries: [] });
  expect(calls).toHaveLength(1);
});

test('only a successful exhausted Continue page produces an empty list', async () => {
  const { client, calls } = kernel(() => Response.json({ subjects: [], next: null }));
  expect(await loadContinue(client, request(), {})).toEqual([]);
  expect(calls).toHaveLength(1);
});

test('signed-out Home does not fetch personal data and its query cannot run during SSR', async () => {
  const { client, calls } = kernel(() => {
    throw new Error('Signed-out Home must not read Continue');
  });
  expect(await loadContinue(client, request(false), {})).toEqual([]);
  expect(calls).toEqual([]);
  const query = homeContinueQuery('en', () => loadContinue(client, request(false), {}));
  expect(query.enabled).toBe(false);
  expect(query.staleTime).toBe(0);
});
