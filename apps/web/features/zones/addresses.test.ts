import { expect, test } from 'bun:test';
import { installZoneAddresses, zoneLocalizedHref, zoneSiteHref } from '@rezics/zone-sdk';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref, spaceHref } from '../address/path.ts';
import { installHostZoneAddresses } from './addresses.ts';

test('official packages build paths through the host address rules', () => {
  const book = resourceHref('/w/', 'book');
  installZoneAddresses({
    site: (segment) => `site:${segment}`,
    localized: (path, locale) => `${locale}:${path}`,
  });
  expect(zoneSiteHref('visual-novels')).toBe('site:visual-novels');
  expect(zoneLocalizedHref(book, 'ja')).toBe(`ja:${book}`);

  installHostZoneAddresses();
  expect(zoneSiteHref('visual-novels')).toBe(spaceHref('visual-novels', 'site'));
  expect(zoneSiteHref('light-novels')).toBe(spaceHref('light-novels', 'site'));
  expect(zoneLocalizedHref(book, 'zh-Hans')).toBe(localizedPath(book, 'zh-Hans'));
  expect(zoneLocalizedHref(localizedPath(book, 'en'), 'ja')).toBe(localizedPath(book, 'ja'));
  expect(zoneLocalizedHref(book, 'not-a-locale')).toBe(localizedPath(book, 'en'));
});
