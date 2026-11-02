import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { creatorEditionSearch, creatorOffersSearch } from '../src/checkout/creator-offer-address';
import { CreatorOfferAddressPage, CreatorOfferRequested } from '../src/checkout/creator-offer-address-page';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
afterAll(() => mock.restore());
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale;
overwriteGetLocale(() => 'en');
afterAll(() => overwriteGetLocale(originalLocale));
const edition = '019a2100-0000-7000-8000-000000000001';
const other = '019a2100-0000-7000-8000-000000000002';
const render = (props: Parameters<typeof CreatorOfferAddressPage>[0]) =>
  renderToStaticMarkup(createElement(CreatorOfferAddressPage, props));

test('repeated selectors never pick an edition or page, while valid aliases and opaque positions retain exact identity', () => {
  for (const aliases of [{ editionId: [edition, edition] }, { contentEditionId: [edition, other] }, { editionId: edition, contentEditionId: [edition] }]) {
    const search = creatorEditionSearch(aliases);
    expect(search.contentEditionId).toBeUndefined();
    expect(search.addressIssue?.requested).toContain(edition);
  }
  expect(creatorEditionSearch({ editionId: edition.toUpperCase() })).toEqual({ contentEditionId: edition.toUpperCase() });
  expect(creatorEditionSearch({ editionId: edition, contentEditionId: edition })).toEqual({ contentEditionId: edition });
  expect(creatorOffersSearch({ cursor: ['signed', 'signed'] }).addressIssue?.requested).toContain('["signed","signed"]');
  expect(creatorOffersSearch({ cursor: 'signed+/=%2F' })).toEqual({ cursor: 'signed+/=%2F' });
});

test('served malformed addresses skip private loaders and expose deliberate localized GET recovery', async () => {
  const { Route: list } = await import('../src/routes/creator/offers/index');
  const { Route: editor } = await import('../src/routes/creator/offers/new');
  const transport = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected read or command'));
  try {
    const listSearch = creatorOffersSearch({ cursor: ['a', 'b'] });
    const editionSearch = creatorEditionSearch({ editionId: edition, contentEditionId: other });
    for (const [route, search, kind] of [[list, listSearch, 'list'], [editor, editionSearch, 'editor']] as const) {
      const loader = route.options.loader as (context: unknown) => unknown;
      expect(await loader({ deps: search })).toBeNull();
      const html = render({ kind, locale: 'ja', issue: search.addressIssue });
      expect(html).toContain('role="alert"');
      if (kind === 'list') {
        expect(html).toContain('href="/ja/creator/offers"');
        expect(html).not.toContain('<form');
      } else {
        expect(html).toContain(edition);
        expect(html).toContain(other);
        expect(html).toContain('action="/ja/creator/offers/new" method="get"');
        expect(html).toContain('name="contentEditionId"');
        expect(html).toContain('required=""');
        expect(html).not.toContain('value=');
        expect(html).not.toContain('idempotencyKey');
      }
    }
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

test('pending selectors are visible and escaped; a valid denied edition remains a read outcome', async () => {
  const { loadCreatorEditor } = await import('../src/checkout/creator-offers');
  const search = creatorEditionSearch({ editionId: edition });
  expect(search.addressIssue).toBeUndefined();
  expect(await loadCreatorEditor({ readMetadata: async () => ({ state: 'refused' }) } as never, {} as never, 'Bearer current', search.contentEditionId)).toEqual({ kind: 'denied' });
  for (const kind of ['editor', 'list'] as const) {
    const html = render({ kind, locale: 'en', requested: edition });
    expect(html).toContain(edition);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<form');
  }
  expect(renderToStaticMarkup(createElement(CreatorOfferRequested, { requested: '<script>bad</script>' }))).not.toContain('<script>');
});
