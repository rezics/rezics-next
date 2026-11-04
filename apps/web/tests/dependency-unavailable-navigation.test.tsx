import { expect, test } from 'bun:test';
import { createElement, type ComponentType, type ReactElement } from 'react';
import { adaptUnavailableDocument, documentFailureIntent } from '../src/shell/dependency-recovery/document';
import { applyDependencyErrorComponents } from '../src/shell/dependency-recovery/route-error';
import { ClosedErrorPage } from '../src/shell/closed';
import { routeFailure } from '../src/shell/error-state';
import { SessionUnavailableError } from '../src/session/unavailable';

const documentHeaders = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

const options = {
  fallbackLocale: () => 'en' as const,
  stylesheet: () => '/assets/site.css',
  nonce: () => 'test-nonce',
  issuer: 'https://issuer.example',
};

function unavailable(status = 503, headers?: HeadersInit) {
  return Response.json(
    {
      type: 'https://rezics.com/problems/dependency_unavailable',
      title: 'Private issuer detail',
      detail: 'issuer-secret and raw response text',
      status,
      code: 'dependency_unavailable',
    },
    { status, headers: { 'content-type': 'application/problem+json', ...Object.fromEntries(new Headers(headers)) } },
  );
}

test('sign-in discovery failure becomes a localized document with one safe retry and return', async () => {
  const request = new Request(
    `https://site.example/auth/sign-in?return_to=${encodeURIComponent('/ja/library?tab=private&token=url-secret')}`,
    { headers: documentHeaders },
  );
  const response = await adaptUnavailableDocument(request, unavailable(502, { 'retry-after': '2' }), options);

  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('content-language')).toBe('ja');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('retry-after')).toBe('2');
  expect(response.headers.get('content-security-policy')).toContain("'nonce-test-nonce'");
  const html = await response.text();
  expect(html).toContain('<html lang="ja"');
  expect(html).toContain('サービスは一時的に利用できません');
  expect(html).toContain('data-dependency-retry');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain('hidden=""');
  expect(html).toContain('/auth/sign-in?return_to=%2Fja%2Flibrary');
  expect(html).toContain('href="/ja/library"');
  expect(html).not.toContain('url-secret');
  expect(html).not.toContain('Private issuer detail');
  expect(html).not.toContain('issuer-secret');

  const headRequest = new Request('https://site.example/auth/sign-in', {
    method: 'HEAD',
    headers: documentHeaders,
  });
  const head = await adaptUnavailableDocument(headRequest, unavailable(), options);
  expect(head.status).toBe(503);
  expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await head.text()).toBe('');
});

test('a consumed callback offers a fresh sign-in and never replays callback material', async () => {
  const request = new Request('https://site.example/auth/callback?code=single-use-code&state=one-use-state', {
    headers: {
      ...documentHeaders,
      cookie: 'rezics_login_return=/zh-Hant/library?token=cookie-secret',
    },
  });
  const source = unavailable(503);
  source.headers.append('set-cookie', 'rezics_login=; Max-Age=0; Path=/; HttpOnly');
  const response = await adaptUnavailableDocument(request, source, options);
  const html = await response.text();

  expect(response.status).toBe(503);
  expect(response.headers.get('content-language')).toBe('zh-Hant');
  expect(response.headers.get('set-cookie')).toContain('rezics_login=');
  expect(html).toContain('服務暫時無法使用');
  expect(html).toContain('/auth/sign-in?return_to=%2Fzh-Hant%2Flibrary');
  expect(html).toContain('href="/zh-Hant/library"');
  expect(html).not.toContain('/auth/callback');
  expect(html).not.toContain('single-use-code');
  expect(html).not.toContain('one-use-state');
  expect(html).not.toContain('cookie-secret');
  expect(html).not.toContain('raw response text');
});

test('document form failure preserves uncertain command intent without replay; machine calls keep JSON', async () => {
  const request = new Request('https://site.example/checkout', {
    method: 'POST',
    headers: {
      ...documentHeaders,
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://site.example/en/checkout?order=private-snapshot',
    },
    body: 'credential=private-command-payload',
  });
  const response = await adaptUnavailableDocument(request, unavailable(), options);
  const html = await response.text();

  expect(response.status).toBe(503);
  expect(html).toContain('We could not confirm whether your request finished.');
  expect(html).toContain('href="/en/checkout"');
  expect(html).not.toContain('data-dependency-retry');
  expect(html).not.toContain('private-snapshot');
  expect(html).not.toContain('private-command-payload');
  expect(html).not.toContain('issuer-secret');

  const fetchRequest = new Request('https://site.example/checkout', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: 'command=keep-machine-contract',
  });
  const machine = unavailable();
  expect(documentFailureIntent(fetchRequest)).toBeUndefined();
  expect(await adaptUnavailableDocument(fetchRequest, machine, options)).toBe(machine);

  const media = new Request('https://site.example/media/subject-cover', { headers: documentHeaders });
  expect(documentFailureIntent(media)).toBeUndefined();
});

test('unsafe return destinations and third-party referrers fall back to localized Home', async () => {
  for (const returnTo of [
    '//outside.example/path',
    '/\\\\outside.example/path',
    'https://outside.example/path',
    '/auth/sign-in',
  ]) {
    const request = new Request(`https://site.example/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
      headers: documentHeaders,
    });
    const response = await adaptUnavailableDocument(request, unavailable(), options);
    const html = await response.text();
    expect(html).toContain('href="/en"');
    expect(html).not.toContain('outside.example');
    expect(html).not.toContain('return_to=%2Fauth');
  }

  const command = new Request('https://site.example/checkout', {
    method: 'POST',
    headers: {
      ...documentHeaders,
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://outside.example/en/checkout?private=1',
    },
    body: 'command=uncertain',
  });
  const html = await (await adaptUnavailableDocument(command, unavailable(), options)).text();
  expect(html).toContain('href="/en"');
  expect(html).not.toContain('outside.example');
});

test('typed private dependency errors use the shared route boundary and retain status', () => {
  const fallback = (() => createElement('p', null, 'feature fallback')) as ComponentType<{ error: unknown }>;
  const route = {
    options: { errorComponent: fallback as unknown },
    children: { nested: { options: { errorComponent: fallback as unknown }, children: {} } },
  };
  applyDependencyErrorComponents(route);
  const render = route.options.errorComponent as ComponentType<{ error: unknown }>;
  const dependencyPage = render({ error: { status: 502, code: 'dependency_unavailable' } }) as ReactElement;
  const featurePage = render({ error: new Error('reader bug') }) as ReactElement;
  const nestedPage = (route.children.nested.options.errorComponent as ComponentType<{ error: unknown }>)({
    error: new SessionUnavailableError(),
  }) as ReactElement;

  expect(dependencyPage.type).toBe(ClosedErrorPage);
  expect(nestedPage.type).toBe(ClosedErrorPage);
  expect(featurePage.type).toBe(fallback);
  expect(routeFailure([{ status: 'error', error: new SessionUnavailableError() }])).toMatchObject({
    status: 503,
    closed: false,
    missing: false,
    unavailable: true,
  });
});

test('restored sign-in redirects pass through without being turned into an outage document', async () => {
  const request = new Request('https://site.example/auth/sign-in?return_to=%2Fja%2Flibrary', {
    headers: documentHeaders,
  });
  const restored = new Response(null, {
    status: 302,
    headers: { location: 'https://issuer.example/authorize?state=private-auth-state' },
  });
  expect(await adaptUnavailableDocument(request, restored, options)).toBe(restored);
});
