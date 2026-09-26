import { expect, test } from 'bun:test';
import { fetchGoProxyCapture, goModH1, GoProxyCaptureInvalid,
  GoProxyCaptureUnavailable } from
  '../../../services/main/src/modules/package/go-proxy-capture.ts';

const request = { profile: 'go-module-proxy-capture-v1' as const,
  path: 'golang.org/x/sync', version: 'v0.1.0' };
const bodies = new Map([
  ['list', 'v0.1.0\nv0.2.0-beta\n'],
  ['v0.1.0.info', '{"Version":"v0.1.0","Time":"2022-10-01T00:00:00Z"}'],
  ['v0.1.0.mod', 'module golang.org/x/sync\n\ngo 1.17\n'],
]);

test('PKG05/PKG20: fixed Go proxy capture checks path, bounds and response identity', async () => {
  const urls: string[] = [];
  const fetcher = (async (value: RequestInfo | URL, init?: RequestInit) => {
    const url = String(value);
    urls.push(url);
    expect(init?.redirect).toBe('manual');
    const name = url.split('/').at(-1)!;
    return new Response(bodies.get(name), { status: 200 });
  }) as typeof fetch;
  const bytes = await fetchGoProxyCapture(request, fetcher);
  expect(urls).toEqual([
    'https://proxy.golang.org/golang.org/x/sync/@v/list',
    'https://proxy.golang.org/golang.org/x/sync/@v/v0.1.0.info',
    'https://proxy.golang.org/golang.org/x/sync/@v/v0.1.0.mod',
  ]);
  expect(bytes.mod.toString()).toBe(bodies.get('v0.1.0.mod'));
  expect(goModH1(Buffer.alloc(0)))
    .toBe('h1:G7mAYYxgmS0lVkHyy2hEOLQCFB0DlQFTMLWggykrydY=');
  expect(goModH1(Buffer.from('module golang.org/x/sync\n')))
    .toBe('h1:RxMgew5VJxzue5/jJTE5uejpjVlOe/izrB70Jof72aM=');
  expect(goModH1(bytes.mod)).toMatch(/^h1:[A-Za-z0-9+/]{43}=$/);
  await expect(fetchGoProxyCapture({ ...request, path: 'example.com/../private' }, fetcher))
    .rejects.toThrow(GoProxyCaptureInvalid);
  const beforePseudo = urls.length;
  await expect(fetchGoProxyCapture({ ...request,
    version: 'v0.0.0-20260925010101-abcdef123456' }, fetcher))
    .rejects.toThrow(GoProxyCaptureInvalid);
  expect(urls.length).toBe(beforePseudo);
  await expect(fetchGoProxyCapture(request, (async () => new Response('',
    { status: 302, headers: { location: 'https://other.test/' } })) as typeof fetch))
    .rejects.toThrow(GoProxyCaptureUnavailable);
  await expect(fetchGoProxyCapture(request, (async () => new Response('x',
    { status: 200, headers: { 'content-length': '131073' } })) as typeof fetch))
    .rejects.toThrow(GoProxyCaptureUnavailable);
  await expect(fetchGoProxyCapture(request, (async (value: RequestInfo | URL) => {
    const name = String(value).split('/').at(-1)!;
    return new Response(name === 'v0.1.0.info'
      ? '{"Version":"v0.2.0","Time":"2022-10-01T00:00:00Z"}'
      : bodies.get(name));
  }) as typeof fetch)).rejects.toThrow(GoProxyCaptureUnavailable);
});
