import { expect, test } from 'bun:test';
import {
  createQuestionManagementClient,
  readQuestionManagementSource,
} from '../src/ratings/question-management/native';
import { captureQuestionManagementIntent } from '../src/ratings/question-management/intent';
import type { QuestionManagementRead, QuestionManagementVisit } from '../src/ratings/question-management/types';

const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const activeId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702101';
const retiredId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702102';
const question = {
  id: retiredId,
  realmId,
  meaning: 'Judge translation accuracy independently of the original work’s enjoyment.',
  canonicalLabel: 'Translation accuracy',
  label: 'Translation clarity',
  labelRevision: 2,
  revision: 1,
  grain: 'release' as const,
  scale: { min: 0, max: 20, displayStep: 2 },
  lifecycle: { state: 'retired' as const, revision: 2 },
};
const page = {
  viewer: { accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702002' },
  realmId,
  directory: {
    ratingQuestions: [
      {
        ...question,
        id: activeId,
        label: 'Translation accuracy',
        labelRevision: 1,
        lifecycle: { state: 'active' as const, revision: 1 },
      },
    ],
    next: null,
  },
  actions: { create: null },
  selected: {
    question,
    readback: `/v1/rating-questions/${retiredId}`,
    history: `/v1/rating-questions/${retiredId}/labels`,
    actions: {
      caption: { method: 'PUT' as const, href: `/v1/rating-questions/${retiredId}/label`, expectedLabelRevision: 2 },
      lifecycle: {
        method: 'POST' as const,
        href: `/v1/rating-questions/${retiredId}/$restore`,
        expectedLifecycleRevision: 2,
      },
    },
  },
};

test('the local source seam reads the paired frontier and admits a closed retired selection', async () => {
  let requestUrl: URL | undefined;
  let requestHeaders: Headers | undefined;
  const result = await readQuestionManagementSource({
    origin: 'https://kernel.test',
    authorization: 'Bearer server-held',
    address: { realmId, selectedQuestionId: retiredId, cursor: 'frontier-token' },
    locale: 'fr',
    fetcher: (async (input, init) => {
      requestUrl = new URL(String(input));
      requestHeaders = new Headers(init?.headers);
      return Response.json(page, { headers: { 'cache-control': 'private, no-store' } });
    }) as typeof fetch,
  });

  expect(result).toEqual({ state: 'ready', page });
  expect(requestUrl?.pathname).toBe(`/v1/realms/${realmId}/rating-questions/management`);
  expect(requestUrl?.searchParams.get('selectedQuestionId')).toBe(retiredId);
  expect(requestUrl?.searchParams.get('cursor')).toBe('frontier-token');
  expect(requestHeaders?.get('authorization')).toBe('Bearer server-held');
  expect(requestHeaders?.get('accept-language')).toContain('fr');
});

test('unknown fields, a mismatched selection and oversized response bodies stay unavailable', async () => {
  const read = (body: unknown) =>
    readQuestionManagementSource({
      origin: 'https://kernel.test',
      authorization: 'Bearer server-held',
      address: { realmId, selectedQuestionId: retiredId, cursor: null },
      locale: 'en',
      fetcher: (async () => Response.json(body)) as typeof fetch,
    });

  expect(await read({ ...page, privateRows: [] })).toEqual({ state: 'unavailable' });
  expect(await read({ ...page, selected: { ...page.selected, question: { ...question, id: activeId } } })).toEqual({
    state: 'unavailable',
  });
  expect(
    await readQuestionManagementSource({
      origin: 'https://kernel.test',
      authorization: 'Bearer server-held',
      address: { realmId, selectedQuestionId: retiredId, cursor: null },
      locale: 'en',
      fetcher: (async () => new Response('x'.repeat(1_048_577))) as typeof fetch,
    }),
  ).toEqual({ state: 'unavailable' });
});

const viewer = page.viewer.accountId;
const csrfToken = 'csrf-original';
const credentialEpisode = 'ab'.repeat(32);
const csrfEpisode = 'cd'.repeat(32);
const visit: QuestionManagementVisit = {
  realmId,
  selectedQuestionId: retiredId,
  cursor: null,
  locale: 'en',
  viewer,
  credentialEpisode,
  csrfEpisode,
  state: 'preparing',
};
const selectedRead: Extract<QuestionManagementRead, { state: 'ready' }> = {
  ...visit,
  state: 'ready',
  page,
};

function clientHarness(reply: (request: Request, call: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return reply(request, requests.length);
  }) as typeof fetch;
  return {
    requests,
    client: createQuestionManagementClient({
      origin: 'https://kernel.test',
      authorization: 'Bearer server-held',
      accountId: viewer,
      csrfToken,
      credentialEpisode,
      csrfEpisode,
      locale: 'en',
      fetcher,
    }),
  };
}

test('history keeps its exact selected definition, bounds continuation and preserves deleted author with null time', async () => {
  const harness = clientHarness((request) => {
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe(`/v1/rating-questions/${retiredId}/labels`);
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('cursor')).toBe('original opaque cursor');
    return Response.json({
      labels: [
        {
          questionId: retiredId,
          labelRevision: 1,
          label: 'Translation accuracy',
          at: null,
          author: { id: viewer, kind: 'actor', state: 'deleted' },
        },
      ],
      next: 'next cursor',
    });
  });
  const client = await harness.client;
  const history = await client.history(retiredId, 'original opaque cursor');
  expect(history).toEqual({
    state: 'ready',
    questionId: retiredId,
    cursor: 'original opaque cursor',
    page: {
      labels: [
        {
          questionId: retiredId,
          labelRevision: 1,
          label: 'Translation accuracy',
          at: null,
          author: { id: viewer, kind: 'actor', state: 'deleted' },
        },
      ],
      next: 'next cursor',
    },
  });
  expect(await client.history(retiredId, 'x'.repeat(4097))).toMatchObject({ state: 'stale-cursor' });
  expect(harness.requests).toHaveLength(1);
});

test('creation acknowledgment selects the exact created id and a lost acknowledgment retries the original input', async () => {
  const newId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702103';
  const body = {
    meaning: 'Judge adaptation fidelity independently of the original work.',
    label: 'Adaptation fidelity',
    grain: 'work' as const,
    scale: { min: 0, max: 20, displayStep: 2 },
  };
  const createPage = { ...page, selected: null, actions: { create: { method: 'POST' as const, href: `/v1/realms/${realmId}/rating-questions` } } };
  const createRead: Extract<QuestionManagementRead, { state: 'ready' }> = {
    ...selectedRead,
    selectedQuestionId: null,
    page: createPage,
  };
  const createVisit = { ...visit, selectedQuestionId: null };
  const intent = await captureQuestionManagementIntent({
    action: 'create',
    read: createRead,
    visit: createVisit,
    locale: 'en',
    csrfToken,
    body,
  });
  let acknowledged = false;
  const harness = clientHarness((request, call) => {
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/v1/realms/${realmId}/rating-questions`);
    expect(request.headers.get('authorization')).toBe('Bearer server-held');
    expect(request.headers.get('x-csrf-token')).toBe(csrfToken);
    expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(intent.key));
    if (call === 1) throw new Error('acknowledgment lost');
    acknowledged = true;
    return Response.json(
      {
        id: newId,
        realmId,
        meaning: body.meaning,
        canonicalLabel: body.label,
        label: body.label,
        labelRevision: 1,
        revision: 1,
        grain: body.grain,
        scale: body.scale,
        lifecycle: { state: 'active', revision: 1 },
      },
      { status: 201 },
    );
  });
  const client = await harness.client;
  expect(await client.execute(intent)).toEqual({ kind: 'uncertain' });
  expect(acknowledged).toBe(false);
  expect(await client.execute(intent)).toEqual({ kind: 'acknowledged', questionId: newId });
  expect(harness.requests).toHaveLength(2);
  expect(await harness.requests[0]!.clone().text()).toBe(intent.serializedBody);
  expect(await harness.requests[1]!.clone().text()).toBe(intent.serializedBody);
  expect([...harness.requests[0]!.headers]).toEqual([...harness.requests[1]!.headers]);
  expect(harness.requests[0]!.url).toBe(harness.requests[1]!.url);
});

test('a different credential episode cannot send a retained original intent', async () => {
  const intent = await captureQuestionManagementIntent({
    action: 'restore',
    read: selectedRead,
    visit,
    locale: 'en',
    csrfToken,
    body: { expectedLifecycleRevision: 2 },
  });
  const harness = clientHarness(() => Response.json({ questionId: retiredId, lifecycle: { state: 'active', revision: 3 } }));
  const replacement = await createQuestionManagementClient({
    origin: 'https://kernel.test',
    authorization: 'Bearer replacement',
    accountId: viewer,
    csrfToken,
    credentialEpisode: 'ef'.repeat(32),
    csrfEpisode,
    locale: 'en',
    fetcher: (async (...args) => {
      const request = new Request(args[0], args[1]);
      harness.requests.push(request);
      return Response.json({ questionId: retiredId, lifecycle: { state: 'active', revision: 3 } });
    }) as typeof fetch,
  });
  expect(await replacement.execute(intent)).toEqual({ kind: 'stale' });
  expect(harness.requests).toHaveLength(0);
});
