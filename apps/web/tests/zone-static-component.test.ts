import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { UI_LOCALES, type CompositionDocument } from '@rezics/composition';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import { staticZoneHomeFake, staticZoneOwnerFake } from '../src/zones/static-fakes';
import type { RoutePageData } from '../src/features/pages/route';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { RoutePage } = await import('../src/features/pages/route');
const { readZonePageForRoute } = await import('../src/zones/zone-read');
const { ZoneShell, ZonePageSurface, ZoneReadBoundary } = await import('../src/zones/zone-shell');

const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Untitled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};

function fakeClient() {
  const requests: Request[] = [];
  const local = createFakeKernelFetch(fixtures);
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return local(request);
    }) as typeof fetch,
  });
  return { client, requests };
}

test('static Zone documents render through the common renderer with localized, keyboard reachable navigation', async () => {
  for (const locale of UI_LOCALES) {
    for (const route of ['', 'guide']) {
      const { client, requests } = fakeClient();
      const outcome = await readZonePageForRoute(client, { id: staticZoneHomeFake.zone.id, locale, target: { route } });
      expect(outcome.kind).toBe('page');
      if (outcome.kind !== 'page') throw new Error('Expected a configured static page');
      const { zone, document } = outcome.page;
      const html = renderToStaticMarkup(
        createElement(ZoneShell, {
          zone,
          locale,
          route,
          children: createElement(ZonePageSurface, {
            zone,
            document: document as CompositionDocument,
            children: (merged) =>
              createElement(RoutePage, {
                page: { ...outcome.page, route, document: merged } as RoutePageData,
                locale,
                heading: zone.labels[locale]!,
                messages,
                renderJsonLd: false,
              }),
          }),
        }),
      );
      expect(html).toContain(staticZoneHomeFake.zone.labels[locale]);
      expect(html).toContain('data-zone-shell');
      expect(html).toContain('data-zone-page');
      expect(html).toContain(`href="/${locale}/zones/${zone.id}${route ? '/guide' : ''}" aria-current="page"`);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(route ? 'data-density="comfortable"' : 'data-density="compact"');
      expect(html).toContain(route ? 'data-radius="md"' : 'data-radius="sm"');
      if (!route) expect(html).toContain(`href="/${locale}/subjects/`);
      expect(html).not.toMatch(/<style|<input|saved scope|mount collection|empty results|complete results/i);
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url).pathname).toBe(`/v1/zones/${zone.id}:readPage`);
      expect(await requests[0]!.json()).toEqual({ target: { route }, languages: [locale] });
    }
  }
});

test('private, unknown and source targets stay concealed at the fake route-loader boundary', async () => {
  const { client } = fakeClient();
  for (const id of [staticZoneOwnerFake.zone.id, '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5eff']) {
    expect(await readZonePageForRoute(client, { id, locale: 'en', target: { route: '' } })).toEqual({
      kind: 'missing',
    });
  }
  expect(
    await readZonePageForRoute(client, {
      id: staticZoneHomeFake.zone.id,
      locale: 'en',
      target: { route: 'not-configured' },
    }),
  ).toEqual({ kind: 'missing' });
  expect(
    await readZonePageForRoute(client, {
      id: staticZoneHomeFake.zone.id,
      locale: 'en',
      target: { subject: fixtures.subjects[0]!.id },
    }),
  ).toEqual({ kind: 'missing' });
  const owner = await readZonePageForRoute(
    client,
    { id: staticZoneOwnerFake.zone.id, locale: 'en', target: { route: '' } },
    { authorization: 'Bearer fake-zone-owner' },
  );
  expect(owner.kind).toBe('page');
  expect(
    await readZonePageForRoute(client, { id: staticZoneOwnerFake.zone.id, locale: 'en', target: { route: '' } }),
  ).toEqual({ kind: 'missing' });
});

test('missing and unavailable boundaries render no previous static page or false empty-result claim', () => {
  for (const initial of [{ kind: 'missing' }, { kind: 'unavailable', retryAfter: '1' }] as const) {
    const html = renderToStaticMarkup(
      createElement(ZoneReadBoundary, {
        initial,
        request: { id: staticZoneHomeFake.zone.id, locale: 'en', target: { route: '' } },
        children: () => createElement('p', null, 'PREVIOUS-AUTHORIZED-CONTENT'),
      }),
    );
    expect(html).not.toContain('PREVIOUS-AUTHORIZED-CONTENT');
    expect(html).not.toContain('data-zone-shell');
    expect(html).not.toMatch(/empty results|complete results|Preparing this Zone page/i);
  }
});
