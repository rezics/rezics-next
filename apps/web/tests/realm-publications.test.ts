import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { BOARD_ROW_LIMIT, COVER_ROW_LIMIT, loadRealmShelfPage, loadSpacePage } from '../src/community/space';
import { changePublication, type PublicationChange } from '../src/community/publication-controls';
import { loadSubjectPage } from '../src/features/pages/subject';
import { validatePageRealm } from '../src/features/pages/view-cursor';

const id = (value: number) => `01a1a000-0000-7000-8000-${String(value).padStart(12, '0')}`;
const realmId = id(2);
const subjectId = id(40);
const request = () => new Request('https://site.example/en/spaces/atlas');
function clientFor(handle: (request: Request) => Promise<Response> | Response) {
  return createKernelClient('https://kernel.example', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  });
}
function problem(status: number, code: string) {
  return Response.json(
    {
      code,
      status,
      title: code,
      type: `https://rezics.com/problems/${code}`,
      retryable: false,
      effect_status: 'not_applicable',
      request_id: crypto.randomUUID(),
    },
    { status },
  );
}

test('later boards and publications keep separate bounded native continuations, including empty windows and current read failures', async () => {
  const calls: URL[] = [];
  let failure = 0;
  const client = clientFor((request) => {
    const url = new URL(request.url);
    calls.push(url);
    expect(request.headers.has('authorization')).toBe(false);
    if (url.pathname === '/v1/spaceAddresses/atlas') return Response.json({ spaceId: id(1) });
    if (url.pathname === `/v1/spaces/${id(1)}`)
      return Response.json({ space: { spaceId: id(1), realmId, title: 'Atlas', summary: '' } });
    if (url.pathname === `/v1/realms/${realmId}`)
      return Response.json({ realm: { realmId, visibility: 'public', title: 'Atlas' } });
    if (url.pathname === `/v1/subjects/${subjectId}`)
      return Response.json({
        subject: { id: subjectId, type: 'schema:Book', labels: { en: 'Later book' } },
        summary: { types: ['schema:Book'], label: { value: 'Later book', language: 'en' }, cover: null },
      });
    const boards = url.pathname.endsWith('/boards');
    expect(url.searchParams.get('limit')).toBe(String(boards ? BOARD_ROW_LIMIT : COVER_ROW_LIMIT));
    const cursor = url.searchParams.get('cursor');
    if (failure) return problem(failure, failure === 409 ? 'stale_cursor' : 'not_found');
    if (!cursor) return Response.json({ items: [], next: boards ? 'board-window' : 'publication-window' });
    expect(cursor).toBe(boards ? 'board-window' : 'publication-window');
    return Response.json({
      items: boards
        ? [
            {
              id: id(30),
              title: 'Later board',
              purpose: 'discussion',
              visibility: 'published',
              availability: 'available',
            },
          ]
        : [{ subjectId, publicationId: id(50), verdict: 'adopt' }],
      next: null,
    });
  });
  const home = await loadSpacePage(client, request(), {}, { address: 'atlas' }, 'anonymous');
  expect(home.realm?.boardNext).toBe('board-window');
  expect(home.realm?.publicationNext).toBe('publication-window');
  expect(home.realm?.credentialMode).toBe('anonymous');
  const read = { realmId, credentialMode: 'anonymous' as const };
  const boards = await loadRealmShelfPage(
    client,
    request(),
    {},
    { ...read, list: 'boards', cursor: home.realm?.boardNext ?? undefined },
  );
  const publications = await loadRealmShelfPage(
    client,
    request(),
    {},
    { ...read, list: 'publications', cursor: home.realm?.publicationNext ?? undefined },
  );
  expect(boards).toMatchObject({ kind: 'page', items: [{ title: 'Later board' }], next: null });
  expect(publications).toMatchObject({
    kind: 'page',
    items: [{ id: subjectId, publicationId: id(50), label: 'Later book' }],
    next: null,
  });
  // No head lookup, Context override or additional per-card request is introduced.
  expect(calls.filter((url) => url.pathname.startsWith('/v1/subjects/'))).toHaveLength(1);
  expect(calls.some((url) => url.searchParams.has('context') || url.searchParams.has('realm'))).toBe(false);
  for (const [status, kind] of [
    [404, 'denied'],
    [503, 'unavailable'],
    [409, 'stale'],
  ] as const) {
    failure = status;
    expect(
      await loadRealmShelfPage(client, request(), {}, { ...read, list: 'publications', cursor: 'publication-window' }),
    ).toEqual({ kind });
  }
});

test('publishing, withdrawing and rejecting address the same subject shelf with CAS, stable retries and current authority failures', async () => {
  const writes: { path: string; head: string | null; key: string | null; body: string }[] = [];
  let currentHead = id(50);
  let status = 201;
  let lostReply = false;
  const client = clientFor(async (request) => {
    const url = new URL(request.url);
    expect(request.headers.get('authorization')).toBe('Bearer curator');
    if (request.method === 'GET') {
      expect(url.pathname).toBe(`/v1/realms/${realmId}/publications/${subjectId}`);
      return Response.json({ publication: { subjectId, publicationId: currentHead, verdict: 'adopt' } });
    }
    writes.push({
      path: url.pathname,
      head: request.headers.get('if-match'),
      key: request.headers.get('idempotency-key'),
      body: await request.text(),
    });
    if (lostReply) {
      lostReply = false;
      throw new Error('Reply lost after commit');
    }
    if (status >= 400) return problem(status, status === 412 ? 'precondition_failed' : 'forbidden');
    currentHead = id(Number(currentHead.slice(-12)) + 1);
    return Response.json({ publication: { subjectId, publicationId: currentHead } }, { status });
  });
  const publish: PublicationChange = { realmId, subjectId, action: 'publish', idempotencyKey: id(60) };
  expect(await changePublication(client, 'Bearer curator', publish)).toEqual({ kind: 'saved', head: id(51) });
  expect(writes[0]).toEqual({
    path: `/v1/realms/${realmId}/publications`,
    head: null,
    key: JSON.stringify(id(60)),
    body: JSON.stringify({ subjectId }),
  });
  const withdraw: PublicationChange = { ...publish, action: 'withdraw', expectedHead: id(51), idempotencyKey: id(61) };
  status = 200;
  expect(await changePublication(client, 'Bearer curator', withdraw)).toEqual({ kind: 'saved', head: id(52) });
  expect(writes.at(-1)).toMatchObject({
    path: `/v1/realms/${realmId}/publications/${subjectId}:withdraw`,
    head: JSON.stringify(id(51)),
  });
  status = 412;
  expect(await changePublication(client, 'Bearer curator', withdraw)).toEqual({
    kind: 'conflict',
    currentHead: null,
  });
  status = 200;
  expect(
    await changePublication(client, 'Bearer curator', {
      ...withdraw,
      action: 'reject',
      expectedHead: id(52),
      idempotencyKey: id(62),
    }),
  ).toEqual({ kind: 'saved', head: id(53) });
  lostReply = true;
  expect(await changePublication(client, 'Bearer curator', withdraw)).toEqual({ kind: 'unavailable' });
  await changePublication(client, 'Bearer curator', withdraw);
  expect(writes.at(-1)).toEqual(writes.at(-2));
  // A previously successful request remains subject to the command's current denial, even on replay.
  for (const denied of [401, 403, 404]) {
    status = denied;
    expect(await changePublication(client, 'Bearer curator', publish)).toEqual({ kind: 'denied' });
  }
  const before = writes.length;
  expect(await changePublication(client, null, publish)).toEqual({ kind: 'denied' });
  expect(await changePublication(client, 'Bearer curator', { ...publish, action: 'withdraw' })).toEqual({
    kind: 'invalid',
  });
  expect(writes.length).toBe(before);
  expect(writes.every((write) => write.path.startsWith(`/v1/realms/${realmId}/publications`))).toBe(true);
});

test('the existing subject reader carries Realm selection and current authorization into native denial without a Global rescue or body', async () => {
  const calls: { path: string; authorization: string | null; body: unknown }[] = [];
  const kernel = clientFor(async (request) => {
    calls.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    });
    return problem(404, 'not_found');
  });
  const selector = validatePageRealm(
    new URL(`https://site.example/ja/subjects/${subjectId}/book?realm=${realmId}`).searchParams.get('realm'),
  );
  expect(
    await loadSubjectPage(kernel, subjectId, undefined, 'ja', {
      realm: selector,
      authorization: 'Bearer current-reader',
    }),
  ).toEqual({ kind: 'missing' });
  expect(calls).toEqual([
    {
      path: '/v1/pages:read',
      authorization: 'Bearer current-reader',
      body: { target: { subject: subjectId, realm: realmId }, languages: ['ja'] },
    },
  ]);
});
