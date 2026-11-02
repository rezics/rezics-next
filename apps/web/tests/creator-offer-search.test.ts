import { expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { creatorEditionSearch } = await import('../src/checkout/creator-offers');

const editionId = '019a2100-0000-7000-8000-000000000001';
const anotherEdition = '019a2100-0000-7000-8000-000000000002';

test('Content publication next links identify the exact offer body edition without supplying sale authority', () => {
  const publishedLink = new URL(`https://site.test/en/creator/offers/new?editionId=${editionId}`);
  expect(creatorEditionSearch(Object.fromEntries(publishedLink.searchParams))).toEqual({ contentEditionId: editionId });
  expect(creatorEditionSearch({ contentEditionId: editionId })).toEqual({ contentEditionId: editionId });
  expect(creatorEditionSearch({ editionId, contentEditionId: editionId, canSell: true })).toEqual({
    contentEditionId: editionId,
  });
  expect(creatorEditionSearch({})).toEqual({});
  expect(creatorEditionSearch({ editionId: '', contentEditionId: '' })).toEqual({});
});

test('conflicting or malformed edition locators cannot silently select another published target', () => {
  expect(creatorEditionSearch({ editionId, contentEditionId: anotherEdition })).toEqual({
    addressIssue: { requested: `editionId = ${JSON.stringify(editionId)}\ncontentEditionId = ${JSON.stringify(anotherEdition)}` },
  });
  for (const invalid of [null, 123, ['not-a-single-edition'], 'published', ` ${editionId}`]) {
    expect(creatorEditionSearch({ editionId: invalid }).addressIssue).toBeDefined();
    expect(creatorEditionSearch({ editionId, contentEditionId: invalid }).addressIssue).toBeDefined();
  }
});
