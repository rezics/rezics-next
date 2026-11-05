import { afterAll, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { publicCacheGrowthSample, publicCacheSamples } from './support/public-cache-samples.ts';
import {
  closePublicRenderFixture,
  publicRenderSite,
  publicRenderState,
  signedInCookie,
} from './support/public-render-fixture.ts';

const timeout = 300_000;
const routesDirectory = join(import.meta.dir, '../src/routes');

afterAll(closePublicRenderFixture);

async function routeFiles(directory = routesDirectory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await routeFiles(path)));
    else if (entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

function routePattern(source: string): string | undefined {
  return /createFileRoute\('([^']+)'\)/u.exec(source)?.[1];
}

async function publicCacheRouteList(): Promise<string[]> {
  const routes: string[] = [];
  for (const file of await routeFiles()) {
    const source = await Bun.file(file).text();
    const path = routePattern(source);
    if (path && /staticData\s*:\s*\{[^}]*publicCache\s*:\s*true/u.test(source)) routes.push(path);
  }
  return routes.sort();
}

test('only public page routes opt into publicCache', async () => {
  const expected = new Set([
    '/',
    '/search',
    '/realms/$id',
    '/spaces/$address',
    '/boards/$id',
    '/threads/$id_/$slug',
    '/subjects/$id_/$slug',
    '/subjects/$id_/$slug_/$view',
    '/subjects/$id_/$slug_/relations',
    '/@{$handle}',
    '/@{$handle}_/$view',
    '/collections/$id',
  ]);
  const publicRoutes = new Set(await publicCacheRouteList());

  expect(publicRoutes).toEqual(expected);
  expect(new Set(Object.keys(publicCacheSamples))).toEqual(expected);
  for (const path of [
    '/library/',
    '/settings',
    '/checkout',
    '/offers/$id',
    '/orders/$id',
    '/curate/presentation',
    '/collections/new',
    '/boards/$id_/new',
    '/threads/$id_/new',
  ]) {
    expect(publicRoutes.has(path), `${path} must remain outside publicCache`).toBe(false);
  }
});

test(
  'every publicCache route renders the same recorded HTML for anonymous and signed-in readers',
  async () => {
    const publicRoutes = await publicCacheRouteList();
    for (const path of publicRoutes) {
      expect(publicCacheSamples[path], `${path} needs a recorded render sample`).toBeDefined();
    }

    const origin = await publicRenderSite();
    const cookie = await signedInCookie(origin);
    for (const route of publicRoutes) {
      const path = publicCacheSamples[route]!;
      const html: string[] = [];
      publicRenderState.sessionReads = 0;
      publicRenderState.credentialReads = 0;
      publicRenderState.sessionQueries = 0;
      publicRenderState.authRequests = 0;

      for (const signedIn of [false, true]) {
        const response = await fetch(`${origin}${path}`, {
          headers: signedIn
            ? { cookie: `${cookie.name}=${cookie.value}; rezics_theme=dark; rezics_nav=collapsed` }
            : {},
        });
        expect(
          response.status,
          `${signedIn ? 'signed-in' : 'anonymous'} ${path}: ${await response.clone().text()}`,
        ).toBe(200);
        const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)![1]!;
        const body = (await response.text()).replaceAll(nonce, 'NONCE');
        expect(body).not.toContain('name="csrf-token"');
        html.push(body);
      }

      expect(publicRenderState.sessionReads, `${path} must not read session state`).toBe(0);
      expect(publicRenderState.credentialReads, `${path} must not read credentials`).toBe(0);
      expect(publicRenderState.sessionQueries, `${path} must not query session identity`).toBe(0);
      expect(publicRenderState.authRequests, `${path} must not contact Auth`).toBe(0);
      expect(html[1]).toBe(html[0]);
    }
  },
  timeout,
);

test(
  'a second anonymous GET of the recorded thread within the TTL makes no kernel request',
  async () => {
    const origin = await publicRenderSite();
    const before = publicRenderState.kernelRequests;
    const first = await fetch(`${origin}${publicCacheGrowthSample}`);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const afterFirst = publicRenderState.kernelRequests;
    expect(afterFirst).toBeGreaterThan(before);

    const second = await fetch(`${origin}${publicCacheGrowthSample}`);
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(publicRenderState.kernelRequests).toBe(afterFirst);
  },
  timeout,
);
