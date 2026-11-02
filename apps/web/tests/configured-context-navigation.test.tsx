import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SelectedContext } from '@rezics/composition';
import { ContextNavigation } from '../src/features/pages/context-navigation';
import { setLocale } from '../src/paraglide/runtime.js';

test('population switching preserves the Subject view and fragment without stale context or continuation', () => {
  setLocale('en', { reload: false });
  const realm = '00000000-0000-8000-8000-000000000043',
    href = '/en/subjects/subject/title/editions?realm=stale&context=old&node=editions&cursor=old#items';
  const links = (context: SelectedContext) =>
    [
      ...renderToStaticMarkup(h(ContextNavigation, { context, realm, href, locale: 'en' })).matchAll(/href="([^"]+)"/g),
    ].map(([, value]) => value!.replaceAll('&amp;', '&'));
  expect(links({ id: 'old-context', population: { kind: 'realm', id: realm, title: 'Reading Realm' } })).toEqual([
    `/en/realms/${realm}`,
    '/en/subjects/subject/title/editions#items',
  ]);
  expect(links({ id: 'global-context', population: { kind: 'global' } })).toEqual([
    '/en/subjects/subject/title/editions#items',
    `/en/subjects/subject/title/editions?realm=${realm}#items`,
  ]);
});
