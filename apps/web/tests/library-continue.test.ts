import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import recording from '../src/kernel/recorded/library-continue-progress-sessions.json';
import { nativeContinueSource } from '../src/library/continue-adapter';
import { progressView } from '../src/library/progress-label';

type NativePage = NonNullable<Awaited<ReturnType<KernelClient['libraryContinue']['get']>>['data']>;

/** Retained presentation inputs projected onto the actual generated FULL DTO; this is no native readiness proof. */
const subjects: NativePage['subjects'] = recording.progressSessions.map((session) => {
  const { mode, state } = session;
  if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units')
    throw new Error('Unknown recorded progress mode');
  if (state !== 'active') throw new Error('Continue requires an active recorded session');
  return {
    subjectId: session.subjectId,
    state: null,
    lastActivityAt: session.startedAt,
    subject: session.subject,
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

test('Continue uses one actual native FULL libraryContinue response with embedded currently authorized subjects and preserved cursor status and progress meaning', async () => {
  const calls: Request[] = [];
  const next = 'opaque+/next==';
  const page: NativePage = { subjects, next };
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/libraryContinue') return Response.json(page);
      throw new Error(`Unexpected Continue request: ${request.method} ${path}`);
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
  expect(result.entries.map((entry) => entry.summary)).toEqual(subjects.map((subject) => subject.subject));
  expect(result.entries.map((entry) => entry.progress?.sessionId)).toEqual(
    recording.progressSessions.map((session) => session.id),
  );
  const sparse = result.entries.find((entry) => entry.progress?.mode === 'completed_units')!.progress!;
  expect(sparse.completedUnitCount).toBe(5);
  expect(progressView(sparse, 'en')).toEqual({ text: '5', percent: null });
  const cursor = result.entries.find((entry) => entry.progress?.mode === 'cursor_position')!.progress!;
  expect(progressView(cursor, 'en')).toEqual({ text: 'Part 2, chapter 14', percent: null });
  // BASIC progress has no accepted unit labels/dimension; even a unit named percent grants no such meaning.
  expect(result.entries.every((entry) => entry.progress?.unitLabel === undefined)).toBe(true);
  expect(result.entries.every((entry) => entry.progress?.dimension === undefined)).toBe(true);
  expect(result.entries.every((entry) => entry.stateLabel === undefined)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('GET');
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/libraryContinue');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['view', 'FULL'],
  ]);
  for (const request of calls) expect(request.headers.get('authorization')).toBe('Bearer owner');
});

test('FULL keeps accepted decimal text, native original session references and opaque positions without repinning meaning', async () => {
  const active = subjects[0]!.activeProgressSession!;
  const page: NativePage = {
    subjects: [
      {
        ...subjects[0]!,
        state: 'unknown-active-state',
        activeProgressSession: {
          ...active,
          subjectId: subjects[1]!.subjectId,
          versionSubjectId: subjects[2]!.subjectId,
          mode: 'scalar_amount',
          amount: '999999999999.123456',
          total: null,
        },
      },
      {
        ...subjects[1]!,
        activeProgressSession: {
          ...active,
          mode: 'cursor_position',
          amount: null,
          total: '100',
          position: null,
          locator: 'opaque+/locator==',
        },
      },
    ],
    next: null,
  };
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    async fetch() {
      reads += 1;
      return Response.json(page);
    },
  });
  const result = await nativeContinueSource(client, 'Bearer owner', { limit: 6 });
  if (result.state !== 'loaded') throw new Error('FULL progress did not load');
  expect(result.entries[0]!.progress).toMatchObject({
    sessionId: active.id,
    amount: '999999999999.123456',
    total: null,
  });
  expect(progressView(result.entries[0]!.progress, 'en')).toEqual({
    text: '999,999,999,999.123456',
    percent: null,
  });
  expect(progressView(result.entries[1]!.progress, 'en')).toEqual({ text: 'opaque+/locator==', percent: null });
  for (const entry of result.entries) {
    expect(entry.stateLabel).toBeUndefined();
    expect(entry.progress).not.toHaveProperty('versionSubjectId');
    expect(entry.progress).not.toHaveProperty('structure');
    expect(entry.progress).not.toHaveProperty('privatePin');
  }
  expect(reads).toBe(1);
});
