import { afterEach, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch, createRecordedKernelFetch } from '../src/kernel/fake';
import { setContinueStorySize } from '../src/kernel/fake/library-continue';
import sessions from '../src/kernel/recorded/library-continue-progress-sessions.json';
import { nativeContinueSource } from '../src/library/continue-adapter';

afterEach(() => setContinueStorySize(6));

// Presentation fixtures only: these exercise the fake-to-generated-caller seam, not native Source readiness.
for (const [mode, makeFetch] of [
  ['story', () => createRecordedKernelFetch({})],
  ['fixture', () => createFakeKernelFetch({ subjects: [] })],
] as const) {
  test(`${mode} Continue preserves closed BASIC rows and adds only supplied FULL summaries`, async () => {
    setContinueStorySize(3);
    const fetch = makeFetch();
    const read = (query: string) => fetch(`https://kernel.example.test/v1/libraryContinue${query}`);
    const basicResponse = await read('');
    expect(basicResponse.headers.get('cache-control')).toBe('private, no-store');
    const basic = await basicResponse.json();
    expect(await (await read('?view=BASIC')).json()).toEqual(basic);
    const full = await (await read('?view=FULL')).json();
    expect(full.subjects.map(({ subject, ...row }: Record<string, unknown>) => row)).toEqual(basic.subjects);
    expect(basic.subjects).toHaveLength(3);
    for (const row of basic.subjects) {
      expect(Object.keys(row).sort()).toEqual(['activeProgressSession', 'lastActivityAt', 'state', 'subjectId']);
      if (row.activeProgressSession) expect(row.activeProgressSession).not.toHaveProperty('subject');
    }
    expect(full.subjects.map((row: { subjectId: string; subject: unknown }) => row.subject)).toEqual(
      basic.subjects.map(
        (row: { subjectId: string }) =>
          sessions.progressSessions.find((session) => session.subject.id === row.subjectId)?.subject ?? null,
      ),
    );
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return fetch(input, init);
      }) as typeof fetch,
    });
    const result = await nativeContinueSource(client, 'Bearer owner', { limit: 6 });
    expect(result.state).toBe('loaded');
    if (result.state !== 'loaded') throw new Error('Supplied FULL summaries did not reach the adapter');
    expect(result.entries.map((entry) => entry.summary)).toEqual(
      full.subjects.map((row: { subject: unknown }) => row.subject),
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('view')).toBe('FULL');
    setContinueStorySize(6);
    const missing = await (await read('?view=FULL')).json();
    expect(missing.subjects[3].subject).toBeNull();
    expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6 })).toEqual({ state: 'unavailable' });
  });

  test(`${mode} Continue rejects obsolete selectors and keeps unrecorded scope and pagination unavailable`, async () => {
    const fetch = makeFetch();
    for (const query of [
      'view=COMPACT',
      'view=',
      'accountId=other',
      'kind=schema:Book',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=word',
      'spaceId=bad',
      'spaceId=bad&spaceId=bad',
    ]) {
      const response = await fetch(`https://kernel.example.test/v1/libraryContinue?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    }
    for (const [query, code] of [
      ['cursor=unrecorded', 'invalid_cursor'],
      ['spaceId=01a17ff1-0000-7000-8000-000000000001', 'dependency_unavailable'],
      ['limit=1', 'dependency_unavailable'],
    ]) {
      const response = await fetch(`https://kernel.example.test/v1/libraryContinue?${query}`);
      expect(response.status).toBe(code === 'invalid_cursor' ? 400 : 503);
      expect(await response.json()).toMatchObject({ code });
    }
  });
}
