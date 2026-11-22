import type { Instance } from '@rezics/launcher-contract';
import { expect, test } from 'bun:test';
import { createRezicsLibraryReader } from '../src/rezics-library.ts';

const catalog = 'https://catalog.example.invalid';
const subjectId = '018943aa-abcd-4abc-9abc-0123456789ab';

test('keeps the authorized typed shelf and local matches when only full metadata is unavailable', async () => {
  const local: Instance = { id: 'local-instance', kind: 'visual-novel', name: 'Local title', subjectId };
  const requests: { url: URL; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url.searchParams.get('view') === 'FULL') {
      return Response.json({ code: 'semantic_not_ready' }, { status: 503 });
    }
    return Response.json({ libraryEntries: [{ subjectId }], next: 'next-page' });
  }) as typeof fetch;
  const read = createRezicsLibraryReader(
    catalog,
    async () => [local],
    () => 'reader.fixture',
    'en',
    fetcher,
  );

  const result = await read({ kind: 'visual-novels', cursor: 'page', installedOnly: true });
  expect(result).toEqual({
    status: 'ready',
    entries: [{ subjectId, title: null, installations: [local] }],
    next: 'next-page',
    metadataUnavailable: true,
  });
  expect(
    requests.map(({ url, authorization }) => ({
      path: url.pathname,
      authorization,
      query: Object.fromEntries(url.searchParams),
    })),
  ).toEqual(
    ['FULL', 'BASIC'].map((view) => ({
      path: '/v1/libraryEntries',
      authorization: 'Bearer reader.fixture',
      query: { type: 'wd:Q689445', view, orderBy: 'lastActivity', direction: 'desc', limit: '24', cursor: 'page' },
    })),
  );
});

test('keeps the online page when local annotations fail and requires them for Installed', async () => {
  const fetcher = (async (input: string | URL) => {
    expect(new URL(input).pathname).toBe('/v1/libraryEntries');
    return Response.json({
      libraryEntries: [{ subjectId, subject: { id: subjectId, label: { value: 'Online title' } } }],
      next: 'next-page',
    });
  }) as typeof fetch;
  const read = createRezicsLibraryReader(
    catalog,
    async () => {
      throw new Error('Profile unavailable');
    },
    () => 'reader.fixture',
    'en',
    fetcher,
  );

  expect(await read({ kind: 'visual-novels' })).toEqual({
    status: 'ready',
    entries: [{ subjectId, title: 'Online title', installations: [] }],
    next: 'next-page',
    installationsUnavailable: true,
  });
  expect(await read({ kind: 'visual-novels', installedOnly: true })).toEqual({ status: 'installations-unavailable' });
});

test.each([
  { httpStatus: 403, code: 'forbidden', result: 'denied' },
  { httpStatus: 503, code: 'temporarily_unavailable', result: 'unavailable' },
])('keeps $code without reading the basic shelf or local profile', async ({ httpStatus, code, result }) => {
  const views: (string | null)[] = [];
  const fetcher = (async (input: string | URL) => {
    views.push(new URL(input).searchParams.get('view'));
    return Response.json({ code }, { status: httpStatus });
  }) as typeof fetch;
  let localReads = 0;
  const read = createRezicsLibraryReader(
    catalog,
    async () => {
      localReads++;
      return [];
    },
    () => 'reader.fixture',
    'en',
    fetcher,
  );

  expect(await read({ kind: 'video-games' })).toEqual({ status: result });
  expect(views).toEqual(['FULL']);
  expect(localReads).toEqual(0);
});
