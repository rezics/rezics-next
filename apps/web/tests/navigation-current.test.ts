import { expect, test } from 'bun:test';
import { navigationPathMatches } from '../src/shell/navigation';

test('navigation prefix matching respects localized path segment boundaries', () => {
  expect(navigationPathMatches({ locale: 'en', pathname: '/en/library/shelf' }, '/library', 'prefix')).toBe(true);
  expect(navigationPathMatches({ locale: 'ja', pathname: '/ja/collections/new' }, '/collections', 'prefix')).toBe(true);
  expect(navigationPathMatches({ locale: 'en', pathname: '/en/library-old' }, '/library', 'prefix')).toBe(false);
  expect(navigationPathMatches({ locale: 'en', pathname: '/en/inbox-archive' }, '/inbox', 'prefix')).toBe(false);
});
