import { expect, test } from 'bun:test';
import { readQuestionManagementSource } from '../src/ratings/question-management/native';

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
