import { expect, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import { nativeContinueSource, type NativeContinuePage } from '../src/library/continue-adapter';
import { continueFailure } from '../src/library/continue-source';

test('Continue accepts genuine native empty and forwards the opaque cursor unchanged', async () => {
  const calls: Request[] = [];
  const cursor = 'opaque+/cursor==';
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({ subjects: [], next: null });
    }) as typeof fetch,
  });

  expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6, cursor })).toEqual({
    state: 'loaded',
    entries: [],
    next: null,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('GET');
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/libraryContinue');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['view', 'FULL'],
    ['cursor', cursor],
  ]);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner');
});

const fullRow: NativeContinuePage['subjects'][number] = {
  subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  state: 'unknown-state',
  lastActivityAt: '2026-10-31T00:00:00.123456Z',
  activeProgressSession: null,
  subject: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    type: 'schema:Book',
    types: ['schema:Book', 'schema:CreativeWork'],
    label: null,
    creativeWork: true,
    cover: null,
  },
};

test('FULL presentation withholding, missing headers and unknown wire fields never discard IDs into empty success', async () => {
  const { subject: summary, ...withoutHeader } = fullRow;
  for (const row of [
    withoutHeader,
    { ...fullRow, subject: null },
    { ...fullRow, subject: { ...summary, id: '0192f3a0-6c1e-7b2a-9d4e-000000000002' } },
    { ...fullRow, subject: { ...summary, label: 'Untrusted loose label' } },
    { ...fullRow, subject: { ...summary, privatePin: 'must not render' } },
    { ...fullRow, subject: { ...summary, cover: { url: 'https://private.example.test/cover' } } },
    { ...fullRow, privatePin: 'must not render' },
  ]) {
    let reads = 0;
    const client = createKernelClient('https://kernel.example.test', {
      async fetch() {
        reads += 1;
        return Response.json({ subjects: [fullRow, row], next: 'signed-next' });
      },
    });
    expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6 })).toEqual({ state: 'unavailable' });
    expect(reads).toBe(1);
  }
});

test('FULL cover obligations use the native closed vocabulary', async () => {
  const cover = {
    media: fullRow.subjectId,
    width: 100,
    height: 150,
    placeholder: { thumbhash: '', color: '#000000' },
    variants: [{ format: 'webp', width: 100 }],
    focalPoint: null,
    credit: {
      rightsHolder: 'Publisher',
      via: { name: 'Source', url: 'https://example.test' },
      license: 'CC BY-SA',
      obligations: ['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'],
    },
  };
  for (const [obligations, state] of [
    [cover.credit.obligations, 'loaded'],
    [['unknown'], 'unavailable'],
  ] as const) {
    const client = createKernelClient('https://kernel.example.test', {
      async fetch() {
        return Response.json({
          subjects: [
            {
              ...fullRow,
              subject: {
                ...fullRow.subject,
                cover: {
                  ...cover,
                  credit: { ...cover.credit, obligations },
                },
              },
            },
          ],
          next: null,
        });
      },
    });
    expect((await nativeContinueSource(client, 'Bearer owner', { limit: 6 })).state).toBe(state);
  }
});

test('one FULL request retains client language/session context, no-store and cancellation without inventing labels', async () => {
  const calls: Request[] = [];
  const signal = new AbortController();
  let fetchSignal: AbortSignal | null | undefined;
  const client = createKernelClient('https://kernel.example.test', {
    headers: { 'accept-language': 'fr, en;q=0.9' },
    session: 'prior-session',
    async fetch(input, init) {
      fetchSignal = init?.signal;
      calls.push(new Request(input, init));
      return Response.json({ subjects: [fullRow], next: null } satisfies NativeContinuePage, {
        headers: { [SESSION_HEADER]: 'current-session', 'cache-control': 'private, no-store' },
      });
    },
  });
  for (const session of ['prior-session', 'current-session']) {
    const result = await nativeContinueSource(client, 'Bearer owner', { limit: 6 }, signal.signal);
    expect(result.state).toBe('loaded');
    if (result.state !== 'loaded') throw new Error('FULL presentation did not load');
    expect(result.entries).toEqual([
      { subjectId: fullRow.subjectId, label: '', summary: fullRow.subject, progress: null },
    ]);
    const request = calls.at(-1)!;
    expect(request.headers.get(SESSION_HEADER)).toBe(session);
    expect(request.headers.get('authorization')).toBe('Bearer owner');
    expect(request.headers.get('accept-language')).toBe('fr, en;q=0.9');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(fetchSignal).toBe(signal.signal);
  }
  expect(calls).toHaveLength(2);
  signal.abort();
  expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6 }, signal.signal)).toEqual({
    state: 'unavailable',
  });
  expect(calls).toHaveLength(2);
});

test('Continue keeps native preparation, credential, cursor and readiness failures distinct', async () => {
  for (const status of [202, 401, 403, 409, 503]) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({}, { status, headers: { 'retry-after': '2' } });
      }) as typeof fetch,
    });

    expect(await nativeContinueSource(client, 'Bearer owner', { limit: 6 })).toEqual(continueFailure(status, '2'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner');
  }

  const transport = createKernelClient('https://kernel.example.test', {
    async fetch() {
      throw new Error('transport unavailable');
    },
  });
  expect(await nativeContinueSource(transport, 'Bearer owner', { limit: 6 })).toEqual({
    state: 'unavailable',
    status: 503,
  });
});

test('native and recognized wrapped platform closure share the closed result and one bounded FULL read', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ code: 'platform_closed' }, { status: 403 });
    }) as typeof fetch,
  });

  const native = await nativeContinueSource(client, 'Bearer owner', { limit: 6 });
  const wrapped = await nativeContinueSource(withPlatformClosedRecognition(client), 'Bearer owner', { limit: 6 });
  expect(native).toEqual({ state: 'closed' });
  expect(wrapped).toEqual(native);
  expect(calls).toHaveLength(2);
  for (const request of calls) {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/v1/libraryContinue');
    expect([...new URL(request.url).searchParams]).toEqual([
      ['limit', '6'],
      ['view', 'FULL'],
    ]);
    expect(request.headers.get('authorization')).toBe('Bearer owner');
    expect(request.cache).toBe('no-store');
  }
});
