import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import recording from '../src/kernel/recorded/library-continue-progress-sessions.json';
import { nativeContinueSource } from '../src/library/continue-adapter';

type NativePage = NonNullable<Awaited<ReturnType<KernelClient['libraryContinue']['get']>>['data']>;

/** Only BASIC fields from retained records; embedded recording headers are not native Continue fields. */
const subjects: NativePage['subjects'] = recording.progressSessions.map((session) => {
  const { mode, state } = session;
  if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units')
    throw new Error('Unknown recorded progress mode');
  if (state !== 'active') throw new Error('Continue requires an active recorded session');
  return {
    subjectId: session.subjectId,
    state: null,
    lastActivityAt: session.startedAt,
    activeProgressSession: {
      id: session.id,
      subjectId: session.subjectId,
      versionSubjectId: session.versionSubjectId,
      mode,
      unit: session.unit,
      total: session.total,
      amount: session.amount,
      locator: session.locator,
      position: session.position,
      completedUnitCount: session.completedUnitCount,
      state,
      revision: session.revision,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    },
  };
});

test('Continue uses the actual mounted bounded native libraryContinue page and one current header batch instead of permanent missing binding', async () => {
  const calls: Request[] = [];
  const next = 'opaque+/next==';
  const page: NativePage = { subjects, next };
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/libraryContinue') return Response.json(page);
      if (request.method === 'POST' && path === '/v1/pages:read') {
        // The mounted page API accepts one target, not the old fake's { reads } batch. Do not make that
        // nonexistent transport succeed in acceptance. This is the unresolved binding prerequisite.
        const body = await request.json();
        if ('reads' in body)
          return Response.json(
            { code: 'invalid_request', errors: [{ pointer: '/reads', code: 'unknown_field' }] },
            { status: 400 },
          );
      }
      throw new Error(`No mounted batched subject-header read: ${request.method} ${path}`);
    }) as typeof fetch,
  });

  const result = await nativeContinueSource(client, 'Bearer owner', { limit: 6 });
  expect(result.state).toBe('loaded');
  if (result.state !== 'loaded') throw new Error('Continue did not load');
  expect(result.next).toBe(next);
  expect(result.entries.map((entry) => entry.subjectId)).toEqual(subjects.map((subject) => subject.subjectId));
  expect(result.entries.map((entry) => entry.label)).toEqual(
    recording.progressSessions.map((session) => session.subject.label.value),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]!.method).toBe('GET');
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/libraryContinue');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([['limit', '6']]);
  for (const request of calls) expect(request.headers.get('authorization')).toBe('Bearer owner');
});
