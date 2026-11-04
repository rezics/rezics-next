import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContentEditionState } from '../src/content-editions/edition-model';
import { ContentEditionReader } from '../src/content-editions/edition-view';
import { m } from '../src/paraglide/messages.js';

const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
const body = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fixed reader text.' }] }] },
};
const published = {
  state: 'published',
  metadata: {
    editionId,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: subjectId,
    creatorAccountId: creatorId,
    revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-SA-4.0',
  },
  body,
  subject: { id: subjectId, label: 'Reading the quiet ending' },
  creator: { id: creatorId, name: 'Mina Chen' },
  media: { kind: 'ready', images: [] },
} as unknown as ContentEditionState;

const render = (page: ContentEditionState, returnOrigin?: { kind: 'order' | 'entitlement'; href: string }) =>
  renderToStaticMarkup(createElement(ContentEditionReader, { editionId, page, returnOrigin }));

test('published, refused, withdrawn, mismatched and unavailable editions keep the same admitted purchase return', () => {
  const href = '/en/entitlements/entitlement-0456?ordersCursor=orders%2F%2B%3F%3D&entitlementsCursor=benefits%2F%2B%3F%3D';
  const states: ContentEditionState[] = [
    published,
    { state: 'refused', status: 403 },
    { state: 'withdrawn', status: 410 },
    { state: 'version-mismatch', status: 502 },
    { state: 'unavailable', status: 503, reason: 'dependency' },
  ];
  for (const page of states) {
    const markup = render(page, { kind: 'entitlement', href });
    expect(markup).toContain(`href="${href.replaceAll('&', '&amp;')}"`);
    expect(markup).toContain(m.content_edition_return_entitlement());
    expect(markup).toContain(m.content_edition_from_entitlement());
    expect(markup).toContain(m.content_edition_identifier());
    expect(markup).toContain(editionId);
  }
  expect(render(published, { kind: 'order', href: '/en/orders/order-0123' })).toContain(
    m.content_edition_return_order(),
  );
});

test('missing reader origin offers only a current inventory restart and reveals no old receipt coordinates', () => {
  const markup = render({ state: 'version-mismatch', status: 502 });
  expect(markup).toContain('href="/en/orders"');
  expect(markup).toContain(m.content_edition_purchases());
  expect(markup).not.toContain(m.content_edition_return_order());
  expect(markup).not.toContain(m.content_edition_return_entitlement());
  expect(markup).not.toContain('order-0123');
  expect(markup).not.toContain('entitlement-0456');
  expect(markup).not.toContain('ordersCursor');
});
