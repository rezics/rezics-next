import { expect, test } from 'bun:test';
import { appCallback, safeReturnPath, signInPath } from '../features/auth/paths.ts';
import { sameOriginWrite } from '../features/api/origins.ts';
import { safeReturnPath as accountsReturnPath } from '../../accounts/features/api/oauth-query.ts';
import { authQuery } from '../../accounts/features/auth/auth-query.ts';

test('SR-4: Accounts and web reject controls before URL parsing and return canonical same-origin paths', () => {
  const unsafe = [
    'https://evil.test/',
    '//evil.test',
    '/\\evil.test',
    '/%5cevil.test',
    '/%5C/evil.test',
    '/.//evil.test',
    // ast-grep-ignore: web-links-use-address -- Deliberately malformed inbound address verifies unsafe input rejection.
    '/a/..//evil.test',
    '/%2e//evil.test',
  ];
  for (let code = 0; code <= 0x9f; code++) {
    if (code > 0x1f && code < 0x7f) continue;
    const control = String.fromCharCode(code);
    unsafe.push(
      `/${control}/evil.test`,
      `/ok?x=${control}`,
      `/ok#${control}`,
      `/${encodeURIComponent(control)}/evil.test`,
    );
  }
  for (const value of unsafe) {
    expect(accountsReturnPath(value)).toBe('/');
    expect(safeReturnPath(value)).toBe('/studio');
    const query = new URLSearchParams({ next: value });
    expect(authQuery(new URLSearchParams(query.toString())).next).toBe('/');
    const webNext = new URL(signInPath(value), 'https://web.test').searchParams.get('next');
    expect(new URL(safeReturnPath(webNext), 'https://web.test').origin).toBe('https://web.test');
  }
  for (const [input, canonical] of [
    ['/works/../studio?tab=profile#name', '/studio?tab=profile#name'],
    ['/作品?q=hello world', '/%E4%BD%9C%E5%93%81?q=hello%20world'],
    ['/a%20b', '/a%20b'],
    ['/search?q=%E4%BD%A0%E5%A5%BD', '/search?q=%E4%BD%A0%E5%A5%BD'],
  ]) {
    expect(accountsReturnPath(input)).toBe(canonical!);
    expect(safeReturnPath(input)).toBe(canonical!);
    expect(new URL(canonical!, 'https://web.test').origin).toBe('https://web.test');
  }
});

test('IAM01: web return paths remain same-origin through OAuth redirect', () => {
  expect(safeReturnPath('/works/6b92?view=main')).toBe('/works/6b92?view=main');
  for (const value of [
    'https://other.test/',
    '//other.test',
    '/\\other.test',
    '/go\r\nLocation: x',
  ]) {
    expect(safeReturnPath(value)).toBe('/studio');
  }
  expect(appCallback('https://web.rezics.test/auth/start?next=/studio')).toBe(
    'https://web.rezics.test/auth/callback',
  );
  expect(signInPath('/works/6b92?view=main')).toBe(
    '/auth/start?next=%2Fworks%2F6b92%3Fview%3Dmain',
  );
  expect(signInPath('//other.test')).toBe('/auth/start?next=%2Fstudio');
});

test('IAM01: browser writes cannot use a foreign origin at the BFF boundary', () => {
  expect(
    sameOriginWrite(
      new Request('https://web.rezics.test/api/main/v1/works', {
        method: 'POST',
        headers: { origin: 'https://web.rezics.test' },
      }),
    ),
  ).toBe(true);
  expect(
    sameOriginWrite(
      new Request('https://web.rezics.test/api/main/v1/works', {
        method: 'POST',
        headers: { origin: 'https://other.test' },
      }),
    ),
  ).toBe(false);
});
