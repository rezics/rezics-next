import { expect, test } from 'bun:test';
import { appCallback, safeReturnPath } from '../features/auth/paths.ts';
import { sameOriginWrite } from '../features/api/origins.ts';

test('IAM01: web return paths remain same-origin through OAuth redirect', () => {
  expect(safeReturnPath('/works/6b92?view=main')).toBe('/works/6b92?view=main');
  for (const value of ['https://other.test/', '//other.test', '/\\other.test', '/go\r\nLocation: x']) {
    expect(safeReturnPath(value)).toBe('/studio');
  }
  expect(appCallback('https://web.rezics.test/auth/start?next=/studio'))
    .toBe('https://web.rezics.test/auth/callback');
});

test('IAM01: browser writes cannot use a foreign origin at the BFF boundary', () => {
  expect(sameOriginWrite(new Request('https://web.rezics.test/api/main/v1/works', {
    method: 'POST', headers: { origin: 'https://web.rezics.test' },
  }))).toBe(true);
  expect(sameOriginWrite(new Request('https://web.rezics.test/api/main/v1/works', {
    method: 'POST', headers: { origin: 'https://other.test' },
  }))).toBe(false);
});
